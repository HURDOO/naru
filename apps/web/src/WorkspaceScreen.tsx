import type {
  Pane,
  PaneKind,
  SplitDirection,
  Workspace,
  WorkspaceView,
  WorkspaceViewSlotNode,
} from "@naru/contracts";
import {
  insertIntoView,
  removePaneFromView,
  removeSlotFromView,
  fillViewSlot,
  resizeViewSplit,
  viewContainsPane,
  viewPaneIds,
  viewPaneNode,
  viewSlots,
  type ViewTarget,
} from "@naru/domain";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ActivityStatus } from "./ActivityStatus";
import { activityLabel } from "./activity-presentation";
import type { NaruApi } from "./api";
import type { ConnectionSnapshot, TerminalConnection } from "./terminal-connection";
import type { WorkspaceViewMode } from "./workspace-view";
import {
  activeViewPaneId,
  addPaneToView,
  nextViewName,
  ownerLabel,
  ownerOf,
  paneDisplayName,
  slotTitle,
  viewThumbnail,
  paneOwners,
  workspaceViews,
  type PaneOwner,
} from "./workspace-model";
import type { WorkspaceSelection } from "./workspace-selection";
import type { AgentBoard } from "./api";
import { WorkspaceLayout } from "./WorkspaceLayout";
import { PANE_DRAG_TYPE, startPaneDrag } from "./pane-drag";
import "./workspace-screen.css";

/**
 * The workspace screen of Figma v3 (AP-D027..D031): one vertical list of workspaces and single
 * Panes, the open workspace or Pane, and editing a workspace by placing existing Panes.
 */

export interface WorkspaceViewActions {
  readonly changeView: (viewId: string, change: (view: WorkspaceView) => WorkspaceView) => void;
  readonly createView: (input: {
    name: string;
    layout: WorkspaceView["layout"];
    activePaneId: string | null;
  }) => Promise<WorkspaceView | null>;
  readonly deleteView: (viewId: string) => Promise<boolean>;
  readonly createViewPane: (viewId: string, input: NewViewPane) => Promise<Workspace | null>;
  readonly renamePane: (paneId: string, customTitle: string | null) => Promise<boolean>;
}

export type NewViewPane = {
  kind: PaneKind;
  launchProfile?: string;
  selectedDocumentPath?: string;
  placement:
    | { type: "split"; targetPaneId: string; direction: SplitDirection }
    | { type: "slot"; slotId: string }
    | { type: "root" };
};

interface WorkspaceScreenProps {
  readonly workspace: Workspace;
  readonly projectTitle: string;
  /** Agents and their Panes, to show who writes each Pane; null hides owner marks. */
  readonly board: AgentBoard | null;
  readonly projectName: (projectId: string | null) => string;
  readonly selection: WorkspaceSelection | null;
  readonly onSelect: (selection: WorkspaceSelection) => void;
  readonly actions: WorkspaceViewActions;
  readonly mutationAllowed: boolean;
  /** Phones show the list or the open workspace, one at a time (V3-M2, M3). */
  readonly phone: boolean;
  /** Opened from the top menu on a phone: show the list first (V3-M2). */
  readonly startWithList?: boolean;
  /** Tablet widths keep the list in a drawer so Panes get the whole width. */
  readonly drawer?: boolean;
  readonly viewMode: WorkspaceViewMode;
  readonly canChooseViewMode: boolean;
  readonly onViewModeChange: (mode: WorkspaceViewMode) => void;
  readonly onOpenProjects: () => void;
  /** A Pane got focus: acknowledge what it finished. */
  readonly onPaneActivated: (paneId: string) => void;
  readonly onTakeOver: (owner: PaneOwner) => void;
  readonly onRelease: (owner: PaneOwner) => void;
  /** A new Pane beside a Pane open on its own; it opens on its own too. */
  readonly onCreateBesidePane: (
    pane: Pane,
    kind: PaneKind,
    direction: SplitDirection,
    selectedDocumentPath?: string,
  ) => Promise<void>;
  readonly api: NaruApi;
  readonly connection: TerminalConnection | null;
  readonly connectionStatus: ConnectionSnapshot;
  readonly screenReaderMode: boolean;
  readonly onClose: (pane: Pane) => Promise<boolean>;
  readonly onRestart: (pane: Pane) => Promise<void>;
  readonly onStartNewSession: (pane: Pane) => Promise<void>;
  readonly onAgentExited: () => void;
  readonly onPaneViewStateChanged: (pane: Pane) => void;
}

const NEW_PANES: readonly { kind: PaneKind; label: string; launchProfile?: string }[] = [
  { kind: "terminal", label: "터미널" },
  { kind: "claude", label: "Claude Code", launchProfile: "claude-code" },
  { kind: "codex", label: "Codex", launchProfile: "codex-main" },
  { kind: "files", label: "Files" },
  { kind: "docs", label: "Docs" },
  { kind: "tasks", label: "Tasks" },
];

export function WorkspaceScreen(props: WorkspaceScreenProps): React.JSX.Element {
  const { workspace, selection, board, projectName } = props;
  const owners = useMemo(
    () => (board === null ? null : paneOwners(board, projectName)),
    [board, projectName],
  );
  const views = workspaceViews(workspace);
  const view =
    selection?.type === "view"
      ? views.find((candidate) => candidate.id === selection.id)
      : undefined;
  const openPane =
    selection?.type === "pane"
      ? workspace.panes.find((candidate) => candidate.id === selection.id)
      : undefined;
  const [editingId, setEditingId] = useState<string | null>(null);
  const editing = view !== undefined && editingId === view.id;
  const [dragging, setDragging] = useState(false);
  const [listOpen, setListOpen] = useState(selection === null || props.startWithList === true);
  const [renaming, setRenaming] = useState<Pane | null>(null);

  const ownerFor = (pane: Pane): PaneOwner => ownerOf(owners ?? new Map(), pane.id);
  const nameOf = (pane: Pane): string => paneDisplayName(pane, ownerFor(pane));

  const select = (next: WorkspaceSelection): void => {
    props.onSelect(next);
    if (next.type !== "view" || next.id !== editingId) setEditingId(null);
    setListOpen(false);
    setDrawerOpen(false);
  };
  const drawer = props.drawer === true && !props.phone;
  const [drawerOpen, setDrawerOpen] = useState(selection === null);

  const addView = async (): Promise<void> => {
    const created = await props.actions.createView({
      name: nextViewName(views),
      layout: openPane === undefined ? null : viewPaneNode(openPane.id),
      activePaneId: openPane?.id ?? null,
    });
    if (created === null) return;
    select({ type: "view", id: created.id });
    setEditingId(created.id);
    // Editing places Panes from the list, so a drawer stays open.
    if (drawer) setDrawerOpen(true);
  };

  const placeInView = (target: WorkspaceView, paneId: string): void => {
    props.actions.changeView(target.id, (current) => addPaneToView(current, paneId));
  };

  const showList = drawer ? drawerOpen : !props.phone || listOpen || selection === null;
  const showStage = !props.phone || !showList;
  const openList = (): void => (drawer ? setDrawerOpen((open) => !open) : setListOpen(true));

  return (
    <div className="ws-screen" data-editing={editing} data-phone={props.phone} data-drawer={drawer}>
      {drawer && drawerOpen && (
        <button
          type="button"
          className="ws-drawer-scrim"
          aria-label="작업공간 목록 닫기"
          onClick={() => setDrawerOpen(false)}
        />
      )}
      {showList && (
        <WorkspaceList
          {...props}
          owners={owners}
          views={views}
          view={view}
          openPane={openPane}
          editing={editing}
          nameOf={nameOf}
          ownerFor={ownerFor}
          onSelect={select}
          onAddView={() => void addView()}
          onPlace={(paneId) => view !== undefined && placeInView(view, paneId)}
          onRemoveFromView={(paneId) =>
            view !== undefined &&
            props.actions.changeView(view.id, (current) => withoutPane(current, paneId))
          }
          onDragChange={setDragging}
          onRename={setRenaming}
        />
      )}
      {showStage && (
        <section className="ws-stage" aria-label="열린 작업공간">
          {view !== undefined ? (
            <ViewStage
              {...props}
              owners={owners}
              view={view}
              editing={editing}
              dragging={dragging}
              nameOf={nameOf}
              ownerFor={ownerFor}
              onBack={openList}
              onEdit={(on) => {
                setEditingId(on ? view.id : null);
                if (drawer) setDrawerOpen(on);
              }}
              onDeleted={() => {
                setEditingId(null);
                const rest = views.filter((candidate) => candidate.id !== view.id);
                const next = rest[0];
                if (next !== undefined) props.onSelect({ type: "view", id: next.id });
                else setListOpen(true);
              }}
              onRename={setRenaming}
            />
          ) : openPane !== undefined ? (
            <PaneStage
              {...props}
              owners={owners}
              pane={openPane}
              views={views}
              nameOf={nameOf}
              ownerFor={ownerFor}
              onBack={openList}
              onPlace={(target) => {
                placeInView(target, openPane.id);
                select({ type: "view", id: target.id });
              }}
              onRename={setRenaming}
            />
          ) : (
            <div className="ws-empty">
              <strong>작업공간이나 Pane을 골라 주세요</strong>
              <span>왼쪽 목록에서 고르거나 작업공간을 새로 만들 수 있습니다.</span>
            </div>
          )}
        </section>
      )}
      {renaming !== null && (
        <RenameDialog
          pane={renaming}
          name={nameOf(renaming)}
          onClose={() => setRenaming(null)}
          onSave={async (customTitle) => {
            if (await props.actions.renamePane(renaming.id, customTitle)) setRenaming(null);
          }}
        />
      )}
    </div>
  );
}

function withoutPane(view: WorkspaceView, paneId: string): WorkspaceView {
  const layout = removePaneFromView(view.layout, paneId);
  return {
    ...view,
    layout,
    activePaneId:
      view.activePaneId === paneId ? (viewPaneIds(layout)[0] ?? null) : view.activePaneId,
  };
}

// The vertical list (V3-C, V3-D, V3-M2) ----------------------------------------------------------

function WorkspaceList(
  props: WorkspaceScreenProps & {
    readonly owners: ReadonlyMap<string, PaneOwner> | null;
    readonly views: readonly WorkspaceView[];
    readonly view: WorkspaceView | undefined;
    readonly openPane: Pane | undefined;
    readonly editing: boolean;
    readonly nameOf: (pane: Pane) => string;
    readonly ownerFor: (pane: Pane) => PaneOwner;
    readonly onAddView: () => void;
    readonly onPlace: (paneId: string) => void;
    readonly onRemoveFromView: (paneId: string) => void;
    readonly onDragChange: (dragging: boolean) => void;
    readonly onRename: (pane: Pane) => void;
  },
): React.JSX.Element {
  const { views, view, editing } = props;
  return (
    <nav
      className={props.drawer === true && !props.phone ? "ws-list ws-list-drawer" : "ws-list"}
      aria-label="작업공간과 Pane"
    >
      <button
        className="ws-list-project"
        type="button"
        onClick={props.onOpenProjects}
        aria-label={`프로젝트 ${props.projectTitle}, 프로젝트 바꾸기`}
      >
        <span className="ws-project-dot" aria-hidden="true" />
        <strong>{props.projectTitle}</strong>
        <Glyph name="chevronDown" />
        <span className="ws-list-project-hint">프로젝트</span>
      </button>
      <ul className="ws-list-views" aria-label="작업공간">
        {views.map((candidate) => {
          const current = view?.id === candidate.id;
          const count = viewPaneIds(candidate.layout).length;
          return (
            <li key={candidate.id}>
              <button
                type="button"
                className="ws-list-view"
                aria-current={current ? "true" : undefined}
                onClick={() => props.onSelect({ type: "view", id: candidate.id })}
              >
                <Thumbnail view={candidate} active={current} />
                <span className="ws-list-name">{candidate.name}</span>
                {current && editing ? (
                  <Glyph name="pen" className="ws-accent" />
                ) : (
                  <span className="ws-list-count" aria-label={`Pane ${count}개`}>
                    {count}
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
      <button
        type="button"
        className="ws-list-add"
        onClick={props.onAddView}
        disabled={!props.mutationAllowed}
      >
        <Glyph name="plus" /> 작업공간 추가
      </button>
      <hr className="ws-list-divider" />
      <ul className="ws-list-panes" aria-label="개별 Pane">
        {props.workspace.panes.map((pane) => {
          const owner = props.ownerFor(pane);
          const inView = view !== undefined && viewContainsPane(view.layout, pane.id);
          const current = props.openPane?.id === pane.id;
          return (
            <li
              key={pane.id}
              className="ws-list-pane-row"
              draggable={editing && props.mutationAllowed && !inView}
              onDragStart={(event) => {
                startPaneDrag(event, pane.id);
                props.onDragChange(true);
              }}
              onDragEnd={() => props.onDragChange(false)}
            >
              <button
                type="button"
                className="ws-list-pane"
                aria-current={current ? "true" : undefined}
                onClick={() => props.onSelect({ type: "pane", id: pane.id })}
              >
                {editing && <Glyph name="grip" className="ws-faint" />}
                <PaneGlyph kind={pane.kind} />
                <span className="ws-list-pane-text">
                  <span className="ws-list-name">{props.nameOf(pane)}</span>
                  <span className="ws-list-sub">
                    {editing && inView
                      ? "이 작업공간에 있음"
                      : paneSubtitle(pane, owner, props.owners !== null)}
                  </span>
                </span>
                {!editing && <OwnerMark owner={props.owners === null ? null : owner} pane={pane} />}
              </button>
              {editing ? (
                inView ? (
                  <button
                    type="button"
                    className="ws-icon-button ws-in-view"
                    onClick={() => props.onRemoveFromView(pane.id)}
                    aria-label={`${props.nameOf(pane)} 이 작업공간에서 빼기`}
                    title="이 작업공간에서 빼기"
                  >
                    <Glyph name="check" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="ws-icon-button"
                    onClick={() => props.onPlace(pane.id)}
                    aria-label={`${props.nameOf(pane)} 이 작업공간에 넣기`}
                    title="이 작업공간에 넣기 (끌어서 원하는 자리에 놓을 수도 있습니다)"
                  >
                    <Glyph name="plus" />
                  </button>
                )
              ) : (
                <PaneMenu
                  pane={pane}
                  name={props.nameOf(pane)}
                  owner={props.owners === null ? null : owner}
                  enabled={props.mutationAllowed}
                  inView={inView}
                  viewName={view?.name ?? null}
                  onRename={() => props.onRename(pane)}
                  onTakeOver={() => props.onTakeOver(owner)}
                  onRelease={() => props.onRelease(owner)}
                  onPlace={view === undefined ? undefined : () => props.onPlace(pane.id)}
                  onRemoveFromView={
                    view === undefined ? undefined : () => props.onRemoveFromView(pane.id)
                  }
                  onClose={() => void props.onClose(pane)}
                />
              )}
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function paneSubtitle(pane: Pane, owner: PaneOwner, withOwners: boolean): string {
  const status =
    pane.kind === "files" || pane.kind === "docs" || pane.kind === "tasks"
      ? kindName(pane.kind)
      : pane.status === "running"
        ? activityLabel(pane.activity.state)
        : pane.status === "error"
          ? "오류"
          : pane.status === "exited"
            ? "끝남"
            : "멈춤";
  if (!withOwners) return status;
  if (owner.kind === "mine") return `나 · ${status}`;
  return owner.held ? "나 · 끼어든 중" : `에이전트 · ${status}`;
}

function kindName(kind: PaneKind): string {
  switch (kind) {
    case "claude":
      return "Claude Code";
    case "codex":
      return "Codex";
    case "terminal":
      return "터미널";
    case "files":
      return "파일";
    case "docs":
      return "문서";
    case "tasks":
      return "작업 목록";
  }
}

function OwnerMark({ owner, pane }: { owner: PaneOwner | null; pane: Pane }): React.JSX.Element {
  if (owner === null || owner.kind === "mine" || owner.held) {
    return pane.kind === "codex" || pane.kind === "claude" || pane.activity.state === "failed" ? (
      <ActivityStatus state={pane.activity.state} context={`${pane.title} 작업 상태`} />
    ) : owner === null ? (
      <span />
    ) : (
      <Glyph name="hand" className="ws-accent" label={ownerLabel(owner)} />
    );
  }
  return (
    <span
      className="ws-owner-dot"
      role="img"
      aria-label={ownerLabel(owner)}
      title={ownerLabel(owner)}
    />
  );
}

function Thumbnail({ view, active }: { view: WorkspaceView; active: boolean }): React.JSX.Element {
  const cells = viewThumbnail(view.layout);
  return (
    <svg
      className="ws-thumb"
      data-active={active}
      width="26"
      height="20"
      viewBox="0 0 26 20"
      aria-hidden="true"
    >
      {cells.length === 0 ? (
        <rect x="0.5" y="0.5" width="25" height="19" rx="2" className="ws-thumb-empty" />
      ) : (
        cells.map((cell, index) => (
          <rect
            key={index}
            x={cell.x * 26 + 0.5}
            y={cell.y * 20 + 0.5}
            width={Math.max(1, cell.width * 26 - 1)}
            height={Math.max(1, cell.height * 20 - 1)}
            rx="1.5"
            className={cell.empty ? "ws-thumb-empty" : "ws-thumb-cell"}
          />
        ))
      )}
    </svg>
  );
}

// An open workspace (V3-C), editing it (V3-D) and phones (V3-M3) -------------------------------

function ViewStage(
  props: WorkspaceScreenProps & {
    readonly owners: ReadonlyMap<string, PaneOwner> | null;
    readonly view: WorkspaceView;
    readonly editing: boolean;
    readonly dragging: boolean;
    readonly nameOf: (pane: Pane) => string;
    readonly ownerFor: (pane: Pane) => PaneOwner;
    readonly onBack: () => void;
    readonly onEdit: (editing: boolean) => void;
    readonly onDeleted: () => void;
    readonly onRename: (pane: Pane) => void;
  },
): React.JSX.Element {
  const { view, actions, editing } = props;
  const panes = props.workspace.panes;
  const shown = viewPaneIds(view.layout)
    .map((paneId) => panes.find((pane) => pane.id === paneId))
    .filter((pane): pane is Pane => pane !== undefined);
  const active = activeViewPaneId(view);
  const activate = (paneId: string): void => {
    if (view.activePaneId !== paneId) {
      actions.changeView(view.id, (current) => ({ ...current, activePaneId: paneId }));
    }
    props.onPaneActivated(paneId);
  };
  const create = (input: NewViewPane): void => void actions.createViewPane(view.id, input);
  const beside = (
    target: Pane,
    kind: PaneKind,
    direction: SplitDirection,
    path?: string,
  ): Promise<void> => {
    create({
      kind,
      ...(path === undefined ? {} : { selectedDocumentPath: path }),
      placement: { type: "split", targetPaneId: target.id, direction },
    });
    return Promise.resolve();
  };
  const drop = (target: ViewTarget, paneId: string, direction: SplitDirection): void => {
    actions.changeView(view.id, (current) => {
      try {
        const layout =
          target.type === "slot"
            ? fillViewSlot(current.layout!, target.slotId, paneId)
            : insertIntoView(current.layout, viewPaneNode(paneId), target, direction);
        return { ...current, layout, activePaneId: paneId };
      } catch {
        return current;
      }
    });
  };
  const focus = props.viewMode === "focus";
  // In focus mode the chips also reach empty places, so a missing Pane can be started (V3-M3).
  const places = viewPlaces(view.layout);
  const [focusedSlotId, setFocusedSlotId] = useState<string | null>(null);
  const focusedSlot =
    (focus || props.phone) && !editing
      ? viewSlots(view.layout).find((slot) => slot.id === focusedSlotId)
      : undefined;
  const startSlot = (slot: WorkspaceViewSlotNode): void =>
    create({
      kind: slot.pane.kind,
      launchProfile: slot.pane.launchProfile,
      placement: { type: "slot", slotId: slot.id },
    });

  return (
    <>
      <header className="ws-stage-header">
        {(props.phone || props.drawer === true) && (
          <button
            type="button"
            className="ws-icon-button"
            onClick={props.onBack}
            aria-label="작업공간 목록"
          >
            <Glyph name={props.phone ? "chevronLeft" : "list"} />
          </button>
        )}
        {editing ? (
          <ViewNameInput
            view={view}
            onSave={(name) => actions.changeView(view.id, (current) => ({ ...current, name }))}
          />
        ) : (
          <div className="ws-stage-title">
            <Thumbnail view={view} active />
            <h2>{view.name}</h2>
            <span className="ws-stage-sub">
              {editing
                ? "작업공간 편집"
                : shown.length === 0
                  ? "비어 있음"
                  : shown.map((pane) => props.nameOf(pane)).join(" · ")}
            </span>
          </div>
        )}
        <div className="ws-stage-actions">
          {editing ? (
            <>
              <DeleteViewButton
                onDelete={async () => (await actions.deleteView(view.id)) && props.onDeleted()}
              />
              <button
                type="button"
                className="ws-button primary"
                onClick={() => props.onEdit(false)}
              >
                <Glyph name="check" /> 완료
              </button>
            </>
          ) : (
            <>
              {props.canChooseViewMode && (
                <ViewModeToggle mode={props.viewMode} onChange={props.onViewModeChange} />
              )}
              <AddPaneMenu
                enabled={props.mutationAllowed}
                existing={panes.filter((pane) => !viewContainsPane(view.layout, pane.id))}
                nameOf={props.nameOf}
                onNew={(kind, launchProfile) =>
                  create({
                    kind,
                    ...(launchProfile === undefined ? {} : { launchProfile }),
                    placement:
                      view.layout === null
                        ? { type: "root" }
                        : active === null
                          ? { type: "slot", slotId: firstSlotId(view.layout)! }
                          : { type: "split", targetPaneId: active, direction: "horizontal" },
                  })
                }
                onExisting={(pane) =>
                  actions.changeView(view.id, (current) => addPaneToView(current, pane.id))
                }
              />
              <button
                type="button"
                className="ws-button"
                onClick={() => props.onEdit(true)}
                disabled={!props.mutationAllowed}
              >
                <Glyph name="pen" /> 편집
              </button>
            </>
          )}
        </div>
      </header>
      {(focus || props.phone) && places.length > 1 && !editing && (
        <div className="ws-chips" role="group" aria-label={`${view.name}의 Pane`}>
          {places.map((place) => {
            if (place.type === "slot") {
              return (
                <button
                  key={place.slot.id}
                  type="button"
                  className="ws-chip-slot"
                  aria-pressed={focusedSlot?.id === place.slot.id}
                  onClick={() => setFocusedSlotId(place.slot.id)}
                >
                  <PaneGlyph kind={place.slot.pane.kind} /> {slotTitle(place.slot.pane)}
                </button>
              );
            }
            const pane = panes.find((candidate) => candidate.id === place.paneId);
            if (pane === undefined) return null;
            return (
              <button
                key={pane.id}
                type="button"
                aria-pressed={focusedSlot === undefined && pane.id === active}
                onClick={() => {
                  setFocusedSlotId(null);
                  activate(pane.id);
                }}
              >
                <PaneGlyph kind={pane.kind} /> {props.nameOf(pane)}
              </button>
            );
          })}
        </div>
      )}
      <div className="workspace-content ws-stage-body">
        {focusedSlot !== undefined ? (
          <div className="focused-workspace">
            <SlotSurface
              slot={focusedSlot}
              enabled={props.mutationAllowed}
              editing={false}
              onStart={() => {
                setFocusedSlotId(null);
                startSlot(focusedSlot);
              }}
              onRemove={() => undefined}
            />
          </div>
        ) : view.layout === null ? (
          <EmptyView
            editing={editing}
            dragging={props.dragging}
            onDrop={(paneId) =>
              actions.changeView(view.id, (current) => ({
                ...current,
                layout: viewPaneNode(paneId),
                activePaneId: paneId,
              }))
            }
          />
        ) : (
          <WorkspaceLayout
            layout={view.layout}
            panes={panes}
            activePaneId={active}
            tabPanels={false}
            cells
            collapse={{
              label: "작업공간에서 빼기",
              title: "이 작업공간에서 빼기 (Pane은 계속 실행)",
              enabled: true,
            }}
            paneTitle={props.nameOf}
            paneExtras={(pane) => (
              <PaneHeaderExtras
                pane={pane}
                name={props.nameOf(pane)}
                owner={props.owners === null ? null : props.ownerFor(pane)}
                enabled={props.mutationAllowed}
                inView
                viewName={view.name}
                onRename={() => props.onRename(pane)}
                onTakeOver={() => props.onTakeOver(props.ownerFor(pane))}
                onRelease={() => props.onRelease(props.ownerFor(pane))}
                onRemoveFromView={() =>
                  actions.changeView(view.id, (current) => withoutPane(current, pane.id))
                }
                onClose={() => void props.onClose(pane)}
              />
            )}
            renderSlot={(slot) => (
              <SlotSurface
                slot={slot}
                enabled={props.mutationAllowed}
                editing={editing}
                onStart={() => startSlot(slot)}
                onRemove={() =>
                  actions.changeView(view.id, (current) => ({
                    ...current,
                    layout: removeSlotFromView(current.layout, slot.id),
                  }))
                }
              />
            )}
            drop={editing && props.dragging ? { onDrop: drop } : null}
            api={props.api}
            connection={props.connection}
            connectionStatus={props.connectionStatus}
            screenReaderMode={props.screenReaderMode}
            viewMode={editing ? "multi" : props.viewMode}
            mutationAllowed={props.mutationAllowed}
            onActivate={activate}
            onFocus={activate}
            onCollapse={(paneId) =>
              actions.changeView(view.id, (current) => withoutPane(current, paneId))
            }
            onResize={(splitId, ratio) =>
              actions.changeView(view.id, (current) =>
                current.layout === null
                  ? current
                  : { ...current, layout: resizeViewSplit(current.layout, splitId, ratio) },
              )
            }
            onRestart={props.onRestart}
            onStartNewSession={props.onStartNewSession}
            onAgentExited={props.onAgentExited}
            onClose={props.onClose}
            onSplit={(target, kind, direction) => beside(target, kind, direction)}
            onOpenDocumentInNewPane={(target, path, direction) =>
              beside(target, target.kind, direction, path)
            }
            onOpenFilesInNewPane={(target, path, direction) =>
              beside(target, "files", direction, path)
            }
            onOpenStructuredDocument={(target, path, kind, direction) =>
              beside(target, kind, direction, path)
            }
            onPaneViewStateChanged={props.onPaneViewStateChanged}
          />
        )}
      </div>
      {editing && (
        <p className="ws-edit-note" role="note">
          <Glyph name="info" /> 목록의 Pane을 끌어 원하는 자리에 놓거나 ＋로 넣습니다. 작업공간에서
          빼도 Pane은 꺼지지 않습니다. 같은 Pane을 여러 작업공간에 둘 수 있고, Pane을 끄는 것은 Pane
          메뉴의 "Pane 끄기"에서만 합니다.
        </p>
      )}
    </>
  );
}

type ViewPlace = { type: "pane"; paneId: string } | { type: "slot"; slot: WorkspaceViewSlotNode };

/** Panes and empty places in reading order. */
function viewPlaces(layout: WorkspaceView["layout"]): ViewPlace[] {
  if (layout === null) return [];
  if (layout.type === "pane") return [{ type: "pane", paneId: layout.paneId }];
  if (layout.type === "slot") return [{ type: "slot", slot: layout }];
  return [...viewPlaces(layout.first), ...viewPlaces(layout.second)];
}

function firstSlotId(layout: WorkspaceView["layout"]): string | null {
  if (layout === null) return null;
  if (layout.type === "slot") return layout.id;
  if (layout.type === "pane") return null;
  return firstSlotId(layout.first) ?? firstSlotId(layout.second);
}

function PaneStage(
  props: WorkspaceScreenProps & {
    readonly owners: ReadonlyMap<string, PaneOwner> | null;
    readonly pane: Pane;
    readonly views: readonly WorkspaceView[];
    readonly nameOf: (pane: Pane) => string;
    readonly ownerFor: (pane: Pane) => PaneOwner;
    readonly onBack: () => void;
    readonly onPlace: (view: WorkspaceView) => void;
    readonly onRename: (pane: Pane) => void;
  },
): React.JSX.Element {
  const { pane } = props;
  const owner = props.ownerFor(pane);
  const layout = useMemo(() => viewPaneNode(pane.id), [pane.id]);
  return (
    <>
      <header className="ws-stage-header">
        {(props.phone || props.drawer === true) && (
          <button
            type="button"
            className="ws-icon-button"
            onClick={props.onBack}
            aria-label="작업공간 목록"
          >
            <Glyph name={props.phone ? "chevronLeft" : "list"} />
          </button>
        )}
        <div className="ws-stage-title">
          <PaneGlyph kind={pane.kind} />
          <h2>{props.nameOf(pane)}</h2>
          <span className="ws-stage-sub">Pane 하나만 보는 중</span>
        </div>
        <div className="ws-stage-actions">
          <PlaceInViewMenu
            enabled={props.mutationAllowed}
            views={props.views.filter((view) => !viewContainsPane(view.layout, pane.id))}
            onPlace={props.onPlace}
          />
        </div>
      </header>
      <div className="workspace-content ws-stage-body">
        <WorkspaceLayout
          layout={layout}
          panes={props.workspace.panes}
          activePaneId={pane.id}
          tabPanels={false}
          collapse={{
            label: "접기",
            title: "Pane 하나만 볼 때는 접을 수 없습니다",
            enabled: false,
          }}
          paneTitle={props.nameOf}
          splitEnabled={false}
          paneExtras={() => (
            <PaneHeaderExtras
              pane={pane}
              name={props.nameOf(pane)}
              owner={props.owners === null ? null : owner}
              enabled={props.mutationAllowed}
              inView={false}
              viewName={null}
              onRename={() => props.onRename(pane)}
              onTakeOver={() => props.onTakeOver(owner)}
              onRelease={() => props.onRelease(owner)}
              onClose={() => void props.onClose(pane)}
            />
          )}
          api={props.api}
          connection={props.connection}
          connectionStatus={props.connectionStatus}
          screenReaderMode={props.screenReaderMode}
          viewMode="focus"
          mutationAllowed={props.mutationAllowed}
          onActivate={props.onPaneActivated}
          onFocus={props.onPaneActivated}
          onCollapse={() => undefined}
          onResize={() => undefined}
          onRestart={props.onRestart}
          onStartNewSession={props.onStartNewSession}
          onAgentExited={props.onAgentExited}
          onClose={props.onClose}
          onSplit={(target, kind, direction) => props.onCreateBesidePane(target, kind, direction)}
          onOpenDocumentInNewPane={(target, path, direction) =>
            props.onCreateBesidePane(target, target.kind, direction, path)
          }
          onOpenFilesInNewPane={(target, path, direction) =>
            props.onCreateBesidePane(target, "files", direction, path)
          }
          onOpenStructuredDocument={(target, path, kind, direction) =>
            props.onCreateBesidePane(target, kind, direction, path)
          }
          onPaneViewStateChanged={props.onPaneViewStateChanged}
        />
      </div>
    </>
  );
}

function EmptyView({
  editing,
  dragging,
  onDrop,
}: {
  editing: boolean;
  dragging: boolean;
  onDrop: (paneId: string) => void;
}): React.JSX.Element {
  return (
    <div
      className="ws-empty"
      data-drop={editing && dragging}
      onDragOver={(event) => {
        if (!editing) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        const paneId = event.dataTransfer.getData(PANE_DRAG_TYPE);
        if (!editing || !paneId) return;
        event.preventDefault();
        onDrop(paneId);
      }}
    >
      <strong>{editing ? "여기에 놓기" : "이 작업공간은 비어 있습니다"}</strong>
      <span>
        {editing
          ? "목록의 Pane을 끌어 오거나 ＋를 눌러 넣습니다."
          : "Pane 넣기로 새 Pane을 만들거나 이미 있는 Pane을 넣어 보세요."}
      </span>
    </div>
  );
}

function SlotSurface({
  slot,
  enabled,
  editing,
  onStart,
  onRemove,
}: {
  slot: WorkspaceViewSlotNode;
  enabled: boolean;
  editing: boolean;
  onStart: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  const title = slotTitle(slot.pane);
  return (
    <section className="ws-slot" aria-label={`${title} 자리`}>
      <PaneGlyph kind={slot.pane.kind} />
      <strong>{title} 자리</strong>
      <span>이 프로젝트에 아직 없습니다. 시작하면 여기에 놓입니다.</span>
      <div className="ws-slot-actions">
        <button type="button" className="ws-button" onClick={onStart} disabled={!enabled}>
          <Glyph name="plus" /> {title} 시작
        </button>
        {editing && (
          <button type="button" className="ws-button quiet" onClick={onRemove} disabled={!enabled}>
            자리 빼기
          </button>
        )}
      </div>
    </section>
  );
}

function ViewNameInput({
  view,
  onSave,
}: {
  view: WorkspaceView;
  onSave: (name: string) => void;
}): React.JSX.Element {
  const [value, setValue] = useState(view.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const commit = (): void => {
    const name = value.trim().slice(0, 60);
    if (name.length === 0) {
      setValue(view.name);
      return;
    }
    if (name !== view.name) onSave(name);
  };
  return (
    <label className="ws-name-input">
      <span className="sr-only">작업공간 이름</span>
      <input
        ref={input}
        value={value}
        maxLength={60}
        onChange={(event) => setValue(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            commit();
            event.currentTarget.blur();
          } else if (event.key === "Escape") {
            setValue(view.name);
          }
        }}
      />
      <span className="ws-stage-sub">작업공간 편집</span>
    </label>
  );
}

function DeleteViewButton({ onDelete }: { onDelete: () => void }): React.JSX.Element {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const timer = window.setTimeout(() => setArmed(false), 4_000);
    return () => window.clearTimeout(timer);
  }, [armed]);
  return (
    <button
      type="button"
      className={armed ? "ws-button danger" : "ws-button"}
      onClick={() => (armed ? onDelete() : setArmed(true))}
    >
      <Glyph name="trash" /> {armed ? "한 번 더 누르면 삭제" : "작업공간 삭제"}
    </button>
  );
}

function ViewModeToggle({
  mode,
  onChange,
}: {
  mode: WorkspaceViewMode;
  onChange: (mode: WorkspaceViewMode) => void;
}): React.JSX.Element {
  return (
    <div className="view-mode-control" role="group" aria-label="Pane 보기 방식">
      <button type="button" aria-pressed={mode === "focus"} onClick={() => onChange("focus")}>
        집중 보기
      </button>
      <button type="button" aria-pressed={mode === "multi"} onClick={() => onChange("multi")}>
        분할 보기
      </button>
    </div>
  );
}

// Menus -------------------------------------------------------------------------------------------

function Popover({
  label,
  summary,
  className = "",
  enabled = true,
  children,
}: {
  label: string;
  summary: ReactNode;
  className?: string;
  enabled?: boolean;
  children: ReactNode;
}): React.JSX.Element {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const element = details.current;
    if (element === null) return;
    const outside = (event: MouseEvent): void => {
      if (element.open && !element.contains(event.target as Node)) element.open = false;
    };
    const escape = (event: KeyboardEvent): void => {
      if (event.key === "Escape" && element.open) {
        element.open = false;
        element.querySelector("summary")?.focus();
      }
    };
    document.addEventListener("mousedown", outside);
    element.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", outside);
      element.removeEventListener("keydown", escape);
    };
  }, [enabled]);
  if (!enabled) {
    return (
      <button
        type="button"
        className={`ws-popover-disabled ${className}`}
        disabled
        aria-label={label}
      >
        {summary}
      </button>
    );
  }
  return (
    <details ref={details} className={`ws-popover ${className}`}>
      <summary aria-label={label} title={label}>
        {summary}
      </summary>
      <div
        className="ws-popover-panel"
        role="menu"
        onClick={(event) => {
          // A chosen item closes the menu; its own handler does the work.
          if ((event.target as HTMLElement).closest('[role="menuitem"]')) {
            event.currentTarget.closest("details")?.removeAttribute("open");
          }
        }}
      >
        {children}
      </div>
    </details>
  );
}

function AddPaneMenu({
  enabled,
  existing,
  nameOf,
  onNew,
  onExisting,
}: {
  enabled: boolean;
  existing: readonly Pane[];
  nameOf: (pane: Pane) => string;
  onNew: (kind: PaneKind, launchProfile?: string) => void;
  onExisting: (pane: Pane) => void;
}): React.JSX.Element {
  return (
    <Popover
      label="Pane 넣기"
      className="ws-add-pane"
      enabled={enabled}
      summary={
        <span className="ws-button">
          <Glyph name="plus" /> Pane 넣기
        </span>
      }
    >
      <strong>새 Pane</strong>
      {NEW_PANES.map((item) => (
        <button
          key={item.kind}
          type="button"
          role="menuitem"
          onClick={() => onNew(item.kind, item.launchProfile)}
        >
          <PaneGlyph kind={item.kind} /> {item.label}
        </button>
      ))}
      {existing.length > 0 && <strong>이미 있는 Pane</strong>}
      {existing.map((pane) => (
        <button key={pane.id} type="button" role="menuitem" onClick={() => onExisting(pane)}>
          <PaneGlyph kind={pane.kind} /> {nameOf(pane)}
        </button>
      ))}
    </Popover>
  );
}

function PlaceInViewMenu({
  enabled,
  views,
  onPlace,
}: {
  enabled: boolean;
  views: readonly WorkspaceView[];
  onPlace: (view: WorkspaceView) => void;
}): React.JSX.Element | null {
  if (views.length === 0) return null;
  return (
    <Popover
      label="작업공간에 넣기"
      enabled={enabled}
      summary={
        <span className="ws-button">
          <Glyph name="plus" /> 작업공간에 넣기
        </span>
      }
    >
      {views.map((view) => (
        <button key={view.id} type="button" role="menuitem" onClick={() => onPlace(view)}>
          <Thumbnail view={view} active={false} /> {view.name}
        </button>
      ))}
    </Popover>
  );
}

interface PaneActionsProps {
  readonly pane: Pane;
  readonly name: string;
  readonly owner: PaneOwner | null;
  readonly enabled: boolean;
  readonly inView: boolean;
  readonly viewName: string | null;
  readonly onRename: () => void;
  readonly onTakeOver: () => void;
  readonly onRelease: () => void;
  readonly onPlace?: (() => void) | undefined;
  readonly onRemoveFromView?: (() => void) | undefined;
  readonly onClose: () => void;
}

/** Owner, take over or release, and the Pane menu in a Pane's header (V3-H). */
function PaneHeaderExtras(props: PaneActionsProps): React.JSX.Element {
  const { owner } = props;
  return (
    <span className="ws-pane-extras">
      {owner !== null && (
        <span
          className={`ws-owner-chip ${owner.kind === "mine" || owner.held ? "mine" : "agent"}`}
          title={ownerLabel(owner)}
        >
          {owner.kind === "mine" || owner.held ? (
            <Glyph name="hand" />
          ) : (
            <span className="ws-owner-dot" aria-hidden="true" />
          )}
          <span className="ws-owner-text">{ownerLabel(owner)}</span>
        </span>
      )}
      {owner !== null && owner.kind !== "mine" && (
        <button
          type="button"
          className={owner.held ? "ws-button primary ws-hold" : "ws-button ws-hold"}
          disabled={!props.enabled}
          onClick={owner.held ? props.onRelease : props.onTakeOver}
          title={
            owner.held
              ? "에이전트에게 돌려주고 오케스트레이터에게 알립니다"
              : "에이전트의 지금 차례를 멈추고 내가 이 Pane을 잡습니다"
          }
        >
          <Glyph name={owner.held ? "release" : "hand"} /> {owner.held ? "놓기" : "끼어들기"}
        </button>
      )}
      <PaneMenu {...props} />
    </span>
  );
}

function PaneMenu(props: PaneActionsProps): React.JSX.Element {
  const { owner } = props;
  return (
    <Popover
      label={`${props.name} 메뉴`}
      className="ws-pane-menu"
      enabled={props.enabled}
      summary={<Glyph name="more" />}
    >
      {(() => {
        const item = (label: string, run: () => void, danger = false, icon: GlyphName = "pen") => (
          <button
            key={label}
            type="button"
            role="menuitem"
            className={danger ? "danger" : undefined}
            onClick={run}
          >
            <Glyph name={icon} /> {label}
          </button>
        );
        return [
          item("이름 바꾸기", props.onRename),
          owner !== null && owner.kind !== "mine" && owner.held
            ? item("놓기", props.onRelease, false, "release")
            : null,
          owner !== null && owner.kind !== "mine" && !owner.held
            ? item("끼어들기", props.onTakeOver, false, "hand")
            : null,
          props.inView && props.onRemoveFromView !== undefined
            ? item(
                `${props.viewName ?? "작업공간"}에서 빼기`,
                props.onRemoveFromView,
                false,
                "minus",
              )
            : null,
          !props.inView && props.onPlace !== undefined && props.viewName !== null
            ? item(`${props.viewName}에 넣기`, props.onPlace, false, "plus")
            : null,
          item("Pane 끄기", props.onClose, true, "power"),
        ];
      })()}
    </Popover>
  );
}

function RenameDialog({
  pane,
  name,
  onClose,
  onSave,
}: {
  pane: Pane;
  name: string;
  onClose: () => void;
  onSave: (customTitle: string | null) => Promise<void>;
}): React.JSX.Element {
  const [value, setValue] = useState(name);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const returnFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
    const previous = returnFocus.current;
    return () => previous?.focus();
  }, []);
  const save = async (customTitle: string | null): Promise<void> => {
    setSaving(true);
    try {
      await onSave(customTitle);
    } finally {
      setSaving(false);
    }
  };
  return (
    <div
      className="ws-dialog-scrim"
      onMouseDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <form
        className="ws-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="Pane 이름 바꾸기"
        onSubmit={(event) => {
          event.preventDefault();
          const trimmed = value.trim();
          void save(trimmed.length === 0 ? null : trimmed.slice(0, 120));
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <h2>Pane 이름 바꾸기</h2>
        <label>
          <span>새 이름</span>
          <input
            ref={input}
            value={value}
            maxLength={120}
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p>
          바꾼 이름은 목록, 관제실, 흐름에 같이 보입니다. 에이전트의 기록과 Naru가 붙인 이름(
          {pane.title})은 그대로입니다.
        </p>
        <div className="ws-dialog-actions">
          {pane.customTitle ? (
            <button
              type="button"
              className="ws-button quiet"
              disabled={saving}
              onClick={() => void save(null)}
            >
              원래 이름으로
            </button>
          ) : (
            <span />
          )}
          <button type="button" className="ws-button" onClick={onClose}>
            취소
          </button>
          <button type="submit" className="ws-button primary" disabled={saving}>
            저장
          </button>
        </div>
      </form>
    </div>
  );
}

// Small pieces ------------------------------------------------------------------------------------

const GLYPHS = {
  plus: "M5 12h14M12 5v14",
  minus: "M5 12h14",
  check: "M20 6 9 17l-5-5",
  chevronDown: "m6 9 6 6 6-6",
  chevronLeft: "m15 18-6-6 6-6",
  pen: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
  trash: "M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2",
  power: "M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0",
  hand: "M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15",
  release: "M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11",
  info: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 16v-4M12 8h.01",
  list: "M4 6h16M4 12h16M4 18h16",
} as const;

type GlyphName = keyof typeof GLYPHS;

function Glyph({
  name,
  className,
  label,
}: {
  name: GlyphName;
  className?: string;
  label?: string;
}): React.JSX.Element {
  return (
    <svg
      className={className === undefined ? "ws-glyph" : `ws-glyph ${className}`}
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={name === "more" || name === "grip" ? 3 : 2}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? "true" : undefined}
      focusable="false"
    >
      {label !== undefined && <title>{label}</title>}
      <path d={GLYPHS[name]} />
    </svg>
  );
}

function PaneGlyph({ kind }: { kind: PaneKind }): React.JSX.Element {
  const [glyph, className] =
    kind === "claude"
      ? ["◆", "claude"]
      : kind === "codex"
        ? ["✦", "codex"]
        : kind === "terminal"
          ? [">_", "terminal"]
          : kind === "files"
            ? ["◇", "files"]
            : kind === "docs"
              ? ["▤", "docs"]
              : ["✓", "tasks"];
  return (
    <span className={`ws-pane-glyph ${className}`} aria-hidden="true">
      {glyph}
    </span>
  );
}
