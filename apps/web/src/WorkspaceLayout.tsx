import type { LayoutNode, Pane, PaneKind, SplitDirection, Workspace } from "@naru/contracts";
import { visibleLayout, visiblePaneIds } from "@naru/domain";
import {
  Group,
  Panel,
  Separator,
  type Layout as ResizableLayout,
  type LayoutChangedMeta,
  useGroupRef,
} from "react-resizable-panels";
import { lazy, Suspense, useEffect, useMemo } from "react";
import type { NaruApi } from "./api";
import type { ConnectionSnapshot, TerminalConnection } from "./terminal-connection";
import type { WorkspaceViewMode } from "./workspace-view";
import { ActivityStatus } from "./ActivityStatus";

const TerminalPane = lazy(async () => {
  const module = await import("./TerminalPane");
  return { default: module.TerminalPane };
});

const DocumentPane = lazy(async () => {
  const module = await import("./DocumentPane");
  return { default: module.DocumentPane };
});

const FilesPane = lazy(async () => {
  const module = await import("./FilesPane");
  return { default: module.FilesPane };
});

interface WorkspaceLayoutProps {
  workspace: Workspace;
  api: NaruApi;
  connection: TerminalConnection | null;
  connectionStatus: ConnectionSnapshot;
  screenReaderMode: boolean;
  viewMode: WorkspaceViewMode;
  mutationAllowed: boolean;
  onActivate: (paneId: string) => void;
  onFocus: (paneId: string) => void;
  onCollapse: (paneId: string) => void;
  onClose: (pane: Pane) => Promise<boolean>;
  onResize: (splitId: string, ratio: number) => void;
  onRestart: (pane: Pane) => Promise<void>;
  onStartNewCodex: (pane: Pane) => Promise<void>;
  onSplit: (targetPane: Pane, kind: PaneKind, direction: SplitDirection) => Promise<void>;
  onOpenDocumentInNewPane: (
    targetPane: Pane,
    path: string,
    direction: SplitDirection,
  ) => Promise<void>;
  onOpenFilesInNewPane: (
    targetPane: Pane,
    path: string,
    direction: SplitDirection,
  ) => Promise<void>;
  onOpenStructuredDocument: (
    targetPane: Pane,
    path: string,
    kind: "docs" | "tasks",
    direction: SplitDirection,
  ) => Promise<void>;
  onPaneViewStateChanged: (pane: Pane) => void;
}

interface BranchProps extends WorkspaceLayoutProps {
  node: LayoutNode;
  paneById: ReadonlyMap<string, Pane>;
}

export function WorkspaceLayout(props: WorkspaceLayoutProps): React.JSX.Element | null {
  const paneById = new Map(props.workspace.panes.map((pane) => [pane.id, pane]));
  if (!props.workspace.layout) return null;
  const renderedLayout = visibleLayout(props.workspace.layout);
  const visibleIds = visiblePaneIds(props.workspace.layout);
  if (!renderedLayout) return null;

  if (props.viewMode === "focus") {
    const activePane =
      (visibleIds.includes(props.workspace.activePaneId ?? "")
        ? paneById.get(props.workspace.activePaneId ?? "")
        : undefined) ??
      paneById.get(visibleIds[0] ?? "") ??
      null;
    return activePane ? (
      <div className="focused-workspace" data-testid="focused-workspace">
        <PaneSurface {...props} pane={activePane} />
      </div>
    ) : null;
  }

  return (
    <div className="recursive-workspace" data-testid="recursive-workspace">
      <LayoutBranch {...props} node={renderedLayout} paneById={paneById} />
    </div>
  );
}

function LayoutBranch(props: BranchProps): React.JSX.Element | null {
  if (props.node.type === "pane") {
    const pane = props.paneById.get(props.node.paneId);
    return pane ? <PaneSurface {...props} pane={pane} /> : null;
  }
  return <SplitBranch {...props} node={props.node} />;
}

function SplitBranch(props: BranchProps & { node: Extract<LayoutNode, { type: "split" }> }) {
  const { node } = props;
  const groupRef = useGroupRef();
  const firstId = `${node.id}-first`;
  const secondId = `${node.id}-second`;
  const defaultLayout = useMemo<ResizableLayout>(
    () => ({
      [firstId]: node.ratio * 100,
      [secondId]: (1 - node.ratio) * 100,
    }),
    [firstId, node.ratio, secondId],
  );

  useEffect(() => {
    const current = groupRef.current?.getLayout()[firstId];
    if (current === undefined || Math.abs(current / 100 - node.ratio) < 0.001) return;
    groupRef.current?.setLayout(defaultLayout);
  }, [defaultLayout, firstId, groupRef, node.ratio]);

  const changed = (layout: ResizableLayout, meta: LayoutChangedMeta): void => {
    if (!meta.isUserInteraction || !props.mutationAllowed) return;
    const firstSize = layout[firstId];
    if (firstSize === undefined) return;
    const ratio = Math.round(Math.min(0.9, Math.max(0.1, firstSize / 100)) * 10_000) / 10_000;
    if (Math.abs(ratio - node.ratio) < 0.0001) return;
    props.onResize(node.id, ratio);
  };

  return (
    <Group
      id={node.id}
      groupRef={groupRef}
      orientation={node.direction}
      defaultLayout={defaultLayout}
      onLayoutChanged={changed}
      className={`split-group split-${node.direction}`}
      data-split-id={node.id}
      resizeTargetMinimumSize={{ fine: 12, coarse: 44 }}
    >
      <Panel id={firstId} minSize="10%" className="split-panel">
        <LayoutBranch {...props} node={node.first} />
      </Panel>
      <Separator
        key={props.mutationAllowed ? "controller" : "observer"}
        id={`${node.id}-separator`}
        className="split-separator"
        disabled={!props.mutationAllowed}
        aria-label={node.direction === "horizontal" ? "좌우 Pane 크기 조절" : "상하 Pane 크기 조절"}
      >
        <span aria-hidden="true" />
      </Separator>
      <Panel id={secondId} minSize="10%" className="split-panel">
        <LayoutBranch {...props} node={node.second} />
      </Panel>
    </Group>
  );
}

function PaneSurface(props: WorkspaceLayoutProps & { pane: Pane }): React.JSX.Element {
  const active = props.workspace.activePaneId === props.pane.id;
  const toolbar = (
    <>
      {(props.pane.kind === "codex" ||
        props.pane.kind === "claude" ||
        props.pane.activity.state === "failed") && (
        <ActivityStatus
          state={props.pane.activity.state}
          context={`${props.pane.title} 작업 상태`}
        />
      )}
      <button
        className="pane-collapse"
        type="button"
        onClick={() => props.onCollapse(props.pane.id)}
        disabled={!props.mutationAllowed || visiblePaneIds(props.workspace.layout).length <= 1}
        aria-label={`${props.pane.title} 접기`}
        title="Pane 접기"
      >
        <span aria-hidden="true">―</span>
      </button>
      <PaneSplitMenu pane={props.pane} onSplit={props.onSplit} enabled={props.mutationAllowed} />
    </>
  );
  if (props.pane.kind === "files") {
    return (
      <Suspense fallback={<FilesPaneLoading pane={props.pane} active={active} />}>
        <FilesPane
          key={props.pane.id}
          pane={props.pane}
          panes={props.workspace.panes}
          active={active}
          panelId={panePanelId(props.pane.id)}
          tabPanel={props.workspace.panes.length > 1}
          api={props.api}
          connection={props.connection}
          mutationAllowed={props.mutationAllowed}
          toolbarExtras={toolbar}
          onActivate={() => props.onActivate(props.pane.id)}
          onActivatePane={props.onActivate}
          onFocus={() => props.onFocus(props.pane.id)}
          onClose={() => props.onClose(props.pane)}
          onOpenDocument={(path, kind, direction) =>
            props.onOpenStructuredDocument(props.pane, path, kind, direction)
          }
          onViewStateChange={props.onPaneViewStateChanged}
        />
      </Suspense>
    );
  }
  if (props.pane.kind === "docs" || props.pane.kind === "tasks") {
    return (
      <Suspense fallback={<DocumentPaneLoading pane={props.pane} active={active} />}>
        <DocumentPane
          key={props.pane.id}
          pane={props.pane}
          active={active}
          panelId={panePanelId(props.pane.id)}
          tabPanel={props.workspace.panes.length > 1}
          api={props.api}
          mutationAllowed={props.mutationAllowed}
          toolbarExtras={toolbar}
          onActivate={() => props.onActivate(props.pane.id)}
          onFocus={() => props.onFocus(props.pane.id)}
          onClose={() => props.onClose(props.pane)}
          onOpenInNewPane={(path, direction) =>
            props.onOpenDocumentInNewPane(props.pane, path, direction)
          }
          onEditInFiles={(path, direction) =>
            props.onOpenFilesInNewPane(props.pane, path, direction)
          }
          onViewStateChange={props.onPaneViewStateChanged}
        />
      </Suspense>
    );
  }
  return (
    <Suspense fallback={<TerminalPaneLoading pane={props.pane} active={active} />}>
      <TerminalPane
        key={props.pane.id}
        pane={props.pane}
        active={active}
        panelId={panePanelId(props.pane.id)}
        tabPanel={props.workspace.panes.length > 1}
        connection={props.connection}
        connectionStatus={props.connectionStatus}
        mutationAllowed={props.mutationAllowed}
        screenReaderMode={props.screenReaderMode}
        toolbarExtras={toolbar}
        onActivate={() => props.onActivate(props.pane.id)}
        onFocus={() => props.onFocus(props.pane.id)}
        onRestart={() => props.onRestart(props.pane)}
        onStartNewCodex={() => props.onStartNewCodex(props.pane)}
        onClose={() => props.onClose(props.pane)}
      />
    </Suspense>
  );
}

function FilesPaneLoading({ pane, active }: { pane: Pane; active: boolean }): React.JSX.Element {
  return (
    <section
      className={`pane-surface pane-loading ${active ? "is-active" : ""}`}
      aria-label={`${pane.title} 파일 편집기 불러오는 중`}
      aria-busy="true"
    >
      <span role="status">파일 편집기 불러오는 중…</span>
    </section>
  );
}

function DocumentPaneLoading({ pane, active }: { pane: Pane; active: boolean }): React.JSX.Element {
  return (
    <section
      className={`pane-surface pane-loading ${active ? "is-active" : ""}`}
      aria-label={`${pane.title} 문서 화면 불러오는 중`}
      aria-busy="true"
    >
      <span role="status">문서 화면 불러오는 중…</span>
    </section>
  );
}

function TerminalPaneLoading({ pane, active }: { pane: Pane; active: boolean }): React.JSX.Element {
  return (
    <section
      className={`pane-surface pane-loading ${active ? "is-active" : ""}`}
      aria-label={`${pane.title} 터미널 렌더러 불러오는 중`}
      aria-busy="true"
    >
      <span role="status">터미널 렌더러 불러오는 중…</span>
    </section>
  );
}

function panePanelId(paneId: string): string {
  return `pane-panel-${paneId}`;
}

function PaneSplitMenu({
  pane,
  onSplit,
  enabled,
}: {
  pane: Pane;
  onSplit: (targetPane: Pane, kind: PaneKind, direction: SplitDirection) => Promise<void>;
  enabled: boolean;
}): React.JSX.Element {
  const split = (
    event: React.MouseEvent<HTMLButtonElement>,
    kind: PaneKind,
    direction: SplitDirection,
  ): void => {
    event.currentTarget.closest("details")?.removeAttribute("open");
    void onSplit(pane, kind, direction);
  };

  if (!enabled) {
    return (
      <button
        className="pane-split-disabled"
        type="button"
        disabled
        aria-label={`${pane.title} 분할은 보기 전용 화면에서 사용할 수 없음`}
      >
        ⊞
      </button>
    );
  }

  return (
    <details className="split-menu">
      <summary aria-label={`${pane.title} 분할 메뉴`} title="Pane 분할">
        ⊞
      </summary>
      <div className="split-menu-popover">
        <strong>새 Pane</strong>
        <button type="button" onClick={(event) => split(event, "terminal", "horizontal")}>
          <span aria-hidden="true">▥</span> 오른쪽에 터미널
        </button>
        <button type="button" onClick={(event) => split(event, "terminal", "vertical")}>
          <span aria-hidden="true">▤</span> 아래에 터미널
        </button>
        <button type="button" onClick={(event) => split(event, "codex", "horizontal")}>
          <span aria-hidden="true">▥</span> 오른쪽에 Codex
        </button>
        <button type="button" onClick={(event) => split(event, "codex", "vertical")}>
          <span aria-hidden="true">▤</span> 아래에 Codex
        </button>
        <button type="button" onClick={(event) => split(event, "claude", "horizontal")}>
          <span aria-hidden="true">▥</span> 오른쪽에 Claude Code
        </button>
        <button type="button" onClick={(event) => split(event, "claude", "vertical")}>
          <span aria-hidden="true">▤</span> 아래에 Claude Code
        </button>
        <button type="button" onClick={(event) => split(event, "files", "horizontal")}>
          <span aria-hidden="true">▥</span> 오른쪽에 Files
        </button>
        <button type="button" onClick={(event) => split(event, "files", "vertical")}>
          <span aria-hidden="true">▤</span> 아래에 Files
        </button>
        <button type="button" onClick={(event) => split(event, "docs", "horizontal")}>
          <span aria-hidden="true">▥</span> 오른쪽에 Docs
        </button>
        <button type="button" onClick={(event) => split(event, "docs", "vertical")}>
          <span aria-hidden="true">▤</span> 아래에 Docs
        </button>
        <button type="button" onClick={(event) => split(event, "tasks", "horizontal")}>
          <span aria-hidden="true">▥</span> 오른쪽에 Tasks
        </button>
        <button type="button" onClick={(event) => split(event, "tasks", "vertical")}>
          <span aria-hidden="true">▤</span> 아래에 Tasks
        </button>
      </div>
    </details>
  );
}
