import type {
  CreateWorkspaceViewPaneRequest,
  CreateWorkspaceViewRequest,
  LayoutNode,
  Pane,
  Workspace,
  WorkspaceView,
} from "@naru/contracts";
import { isPaneCollapsed, resizeSplit, setPaneCollapsed, visiblePaneIds } from "@naru/domain";
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiFailure, type NaruApi } from "./api";
import { mergePaneRuntimeSnapshot, mergeWorkspaceRuntimeSnapshot } from "./pane-runtime";

const SAVE_DEBOUNCE_MS = 300;

interface PendingWorkspaceSave {
  projectId: string;
  layout: LayoutNode | null;
  activePaneId: string | null;
}

interface PendingViewSave {
  projectId: string;
  view: WorkspaceView;
}

interface WorkspaceController {
  workspace: Workspace | null;
  loading: boolean;
  issue: WorkspaceIssue | null;
  accept: (workspace: Workspace) => void;
  activate: (paneId: string) => void;
  collapse: (paneId: string) => void;
  clear: () => void;
  current: () => Workspace | null;
  flush: () => Promise<boolean>;
  load: (projectId: string | null) => Promise<boolean>;
  resize: (splitId: string, ratio: number) => void;
  updatePane: (pane: Pane) => void;
  /** Reloads quietly unless a change of this device is still waiting to be saved. */
  refresh: () => Promise<void>;
  /** Changes a workspace here at once and saves it after a short pause (AP-D031). */
  changeView: (viewId: string, change: (view: WorkspaceView) => WorkspaceView) => void;
  createView: (input: CreateWorkspaceViewRequest) => Promise<WorkspaceView | null>;
  deleteView: (viewId: string) => Promise<boolean>;
  createViewPane: (
    viewId: string,
    input: Omit<CreateWorkspaceViewPaneRequest, "viewVersion">,
  ) => Promise<Workspace | null>;
  renamePane: (paneId: string, customTitle: string | null) => Promise<boolean>;
}

export interface WorkspaceIssue {
  code: string;
  message: string;
  requestId?: string;
}

export function useWorkspace(
  api: NaruApi,
  onNotice: (message: string | null) => void,
  writable: boolean,
): WorkspaceController {
  const [workspace, setWorkspace] = useState<Workspace | null>(null);
  const [loading, setLoading] = useState(false);
  const [issue, setIssue] = useState<WorkspaceIssue | null>(null);
  const workspaceRef = useRef<Workspace | null>(null);
  const versionsRef = useRef(new Map<string, number>());
  const loadGenerationRef = useRef(0);
  const pendingRef = useRef<PendingWorkspaceSave | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlightRef = useRef<Promise<boolean> | null>(null);
  const writableRef = useRef(writable);
  writableRef.current = writable;
  const pendingViewsRef = useRef(new Map<string, PendingViewSave>());
  const viewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const viewFlightRef = useRef<Promise<boolean> | null>(null);

  const accept = useCallback((next: Workspace): void => {
    const merged = withPendingViews(
      mergeWorkspaceRuntimeSnapshot(workspaceRef.current, next),
      pendingViewsRef.current,
    );
    workspaceRef.current = merged;
    versionsRef.current.set(merged.projectId, merged.version);
    setWorkspace(merged);
    setIssue(null);
  }, []);

  const restoreAfterFailure = useCallback(
    async (pending: PendingWorkspaceSave, error: unknown): Promise<void> => {
      const conflict = error instanceof ApiFailure && error.code === "LAYOUT_CONFLICT";
      let restored = false;
      try {
        const latest = await api.workspace(pending.projectId);
        versionsRef.current.set(latest.projectId, latest.version);
        if (workspaceRef.current?.projectId === latest.projectId) accept(latest);
        restored = true;
      } catch {
        // The valid server state remains intact even if it cannot currently be reloaded.
      }
      onNotice(
        conflict
          ? "다른 변경이 먼저 저장되어 최신 레이아웃을 다시 불러왔습니다. 방금 변경을 다시 시도해 주세요."
          : restored
            ? "레이아웃을 저장하지 못해 이전 저장 상태를 다시 불러왔습니다. 잠시 후 다시 시도해 주세요."
            : "레이아웃을 저장하지 못했습니다. 서버의 이전 상태는 유지됩니다. 연결을 확인한 뒤 다시 시도해 주세요.",
      );
    },
    [accept, api, onNotice],
  );

  const flushViews = useCallback(async (): Promise<boolean> => {
    if (viewTimerRef.current !== null) {
      clearTimeout(viewTimerRef.current);
      viewTimerRef.current = null;
    }
    if (!writableRef.current) {
      pendingViewsRef.current.clear();
      return true;
    }
    for (;;) {
      const active = viewFlightRef.current;
      if (active) {
        if (!(await active)) return false;
        continue;
      }
      const [next] = pendingViewsRef.current.values();
      if (next === undefined) return true;
      pendingViewsRef.current.delete(next.view.id);
      const request = (async (): Promise<boolean> => {
        try {
          const saved = await api.saveWorkspaceView(next.projectId, next.view.id, {
            version: next.view.version,
            name: next.view.name,
            layout: next.view.layout,
            activePaneId: next.view.activePaneId,
          });
          // Later local changes to this workspace now build on the saved version.
          const savedView = saved.views?.find((view) => view.id === next.view.id);
          const later = pendingViewsRef.current.get(next.view.id);
          if (later !== undefined && savedView !== undefined) {
            later.view = { ...later.view, version: savedView.version };
          }
          if (workspaceRef.current?.projectId === saved.projectId) accept(saved);
          return true;
        } catch (error) {
          pendingViewsRef.current.clear();
          const conflict = error instanceof ApiFailure && error.code === "LAYOUT_CONFLICT";
          try {
            const latest = await api.workspace(next.projectId);
            if (workspaceRef.current?.projectId === latest.projectId) accept(latest);
          } catch {
            // The server keeps its last valid state even if it cannot be reloaded now.
          }
          onNotice(
            conflict
              ? "다른 변경이 먼저 저장되어 최신 작업공간을 다시 불러왔습니다. 방금 변경을 다시 해 주세요."
              : "작업공간을 저장하지 못해 이전 저장 상태를 다시 불러왔습니다. 잠시 후 다시 시도해 주세요.",
          );
          return false;
        }
      })();
      viewFlightRef.current = request;
      const succeeded = await request;
      if (viewFlightRef.current === request) viewFlightRef.current = null;
      if (!succeeded) return false;
    }
  }, [accept, api, onNotice]);

  const flush = useCallback(async (): Promise<boolean> => {
    if (!(await flushViews())) return false;
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (!writableRef.current) {
      pendingRef.current = null;
      return true;
    }

    for (;;) {
      const activeRequest = inFlightRef.current;
      if (activeRequest) {
        if (!(await activeRequest)) return false;
        continue;
      }

      const pending = pendingRef.current;
      if (!pending) return true;
      pendingRef.current = null;
      const request = (async (): Promise<boolean> => {
        const version = versionsRef.current.get(pending.projectId);
        if (version === undefined) return false;
        try {
          const saved = await api.saveWorkspace(pending.projectId, {
            version,
            layout: pending.layout,
            activePaneId: pending.activePaneId,
          });
          versionsRef.current.set(saved.projectId, saved.version);
          const current = workspaceRef.current;
          if (current?.projectId === saved.projectId) {
            const hasNewerLocalChange = pendingRef.current?.projectId === saved.projectId;
            accept(
              hasNewerLocalChange
                ? {
                    ...saved,
                    layout: current.layout,
                    activePaneId: current.activePaneId,
                  }
                : saved,
            );
          }
          return true;
        } catch (error) {
          pendingRef.current = null;
          await restoreAfterFailure(pending, error);
          return false;
        }
      })();
      inFlightRef.current = request;
      const succeeded = await request;
      if (inFlightRef.current === request) inFlightRef.current = null;
      if (!succeeded) return false;
    }
  }, [accept, api, flushViews, restoreAfterFailure]);

  const scheduleSave = useCallback(
    (next: Workspace): void => {
      if (!writableRef.current) return;
      pendingRef.current = {
        projectId: next.projectId,
        layout: next.layout,
        activePaneId: next.activePaneId,
      };
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        timerRef.current = null;
        void flush();
      }, SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  const updateLocal = useCallback(
    (layout: LayoutNode | null, activePaneId: string | null, persist = true): void => {
      const current = workspaceRef.current;
      if (!current) return;
      const next = { ...current, layout, activePaneId };
      workspaceRef.current = next;
      setWorkspace(next);
      if (persist) scheduleSave(next);
    },
    [scheduleSave],
  );

  const activate = useCallback(
    (paneId: string): void => {
      const current = workspaceRef.current;
      if (!current) return;
      if (!current.panes.some((pane) => pane.id === paneId)) return;
      const layout =
        current.layout && isPaneCollapsed(current.layout, paneId)
          ? setPaneCollapsed(current.layout, paneId, false)
          : current.layout;
      if (current.activePaneId === paneId && layout === current.layout) return;
      updateLocal(layout, paneId, writableRef.current);
    },
    [updateLocal],
  );

  const collapse = useCallback(
    (paneId: string): void => {
      if (!writableRef.current) return;
      const current = workspaceRef.current;
      if (!current?.layout) return;
      try {
        const layout = setPaneCollapsed(current.layout, paneId, true);
        const nextActivePaneId =
          current.activePaneId === paneId
            ? (visiblePaneIds(layout)[0] ?? current.activePaneId)
            : current.activePaneId;
        updateLocal(layout, nextActivePaneId);
      } catch {
        onNotice("마지막으로 보이는 Pane은 접을 수 없습니다.");
      }
    },
    [onNotice, updateLocal],
  );

  const resize = useCallback(
    (splitId: string, ratio: number): void => {
      if (!writableRef.current) return;
      const current = workspaceRef.current;
      if (!current?.layout || !Number.isFinite(ratio)) return;
      try {
        const layout = resizeSplit(current.layout, splitId, ratio);
        updateLocal(layout, current.activePaneId);
      } catch {
        onNotice("분할 크기를 저장하지 못했습니다. 작업공간을 다시 열고 시도해 주세요.");
      }
    },
    [onNotice, updateLocal],
  );

  const updatePane = useCallback((pane: Pane): void => {
    const current = workspaceRef.current;
    if (!current || current.projectId !== pane.projectId) return;
    const currentPane = current.panes.find((candidate) => candidate.id === pane.id);
    if (!currentPane) return;
    const nextPane = mergePaneRuntimeSnapshot(currentPane, pane);
    const next = {
      ...current,
      panes: current.panes.map((candidate) => (candidate.id === pane.id ? nextPane : candidate)),
    };
    workspaceRef.current = next;
    setWorkspace(next);
  }, []);

  const current = useCallback((): Workspace | null => workspaceRef.current, []);

  const changeView = useCallback(
    (viewId: string, change: (view: WorkspaceView) => WorkspaceView): void => {
      const currentWorkspace = workspaceRef.current;
      const view = currentWorkspace?.views?.find((candidate) => candidate.id === viewId);
      if (!currentWorkspace || !view) return;
      const changed = change(view);
      if (changed === view) return;
      const next = {
        ...currentWorkspace,
        views: currentWorkspace.views!.map((candidate) =>
          candidate.id === viewId ? changed : candidate,
        ),
      };
      workspaceRef.current = next;
      setWorkspace(next);
      if (!writableRef.current) return;
      pendingViewsRef.current.set(viewId, { projectId: next.projectId, view: changed });
      if (viewTimerRef.current !== null) clearTimeout(viewTimerRef.current);
      viewTimerRef.current = setTimeout(() => {
        viewTimerRef.current = null;
        void flushViews();
      }, SAVE_DEBOUNCE_MS);
    },
    [flushViews],
  );

  /** Runs one immediate change after pending saves, then shows the server's whole workspace. */
  const mutate = useCallback(
    async (
      run: (projectId: string) => Promise<Workspace>,
      failure: string,
    ): Promise<Workspace | null> => {
      if (!writableRef.current || !(await flush())) return null;
      const projectId = workspaceRef.current?.projectId;
      if (projectId === undefined) return null;
      try {
        const next = await run(projectId);
        if (workspaceRef.current?.projectId === next.projectId) accept(next);
        return next;
      } catch (error) {
        try {
          const latest = await api.workspace(projectId);
          if (workspaceRef.current?.projectId === latest.projectId) accept(latest);
        } catch {
          // Keep what is shown; the next refresh brings the server state.
        }
        onNotice(error instanceof ApiFailure ? error.message : failure);
        return null;
      }
    },
    [accept, api, flush, onNotice],
  );

  const createView = useCallback(
    async (input: CreateWorkspaceViewRequest): Promise<WorkspaceView | null> => {
      const before = new Set(workspaceRef.current?.views?.map((view) => view.id) ?? []);
      const next = await mutate(
        (projectId) => api.createWorkspaceView(projectId, input),
        "작업공간을 만들지 못했습니다.",
      );
      return next?.views?.find((view) => !before.has(view.id)) ?? null;
    },
    [api, mutate],
  );

  const deleteView = useCallback(
    async (viewId: string): Promise<boolean> =>
      (await mutate((projectId) => {
        const view = workspaceRef.current?.views?.find((candidate) => candidate.id === viewId);
        if (view === undefined)
          throw new ApiFailure("작업공간을 찾을 수 없습니다.", "WORKSPACE_VIEW_MISSING", 404);
        return api.deleteWorkspaceView(projectId, viewId, view.version);
      }, "작업공간을 지우지 못했습니다.")) !== null,
    [api, mutate],
  );

  const createViewPane = useCallback(
    (
      viewId: string,
      input: Omit<CreateWorkspaceViewPaneRequest, "viewVersion">,
    ): Promise<Workspace | null> =>
      mutate((projectId) => {
        const view = workspaceRef.current?.views?.find((candidate) => candidate.id === viewId);
        if (view === undefined)
          throw new ApiFailure("작업공간을 찾을 수 없습니다.", "WORKSPACE_VIEW_MISSING", 404);
        return api.createWorkspaceViewPane(projectId, viewId, {
          ...input,
          viewVersion: view.version,
        });
      }, "새 Pane을 만들지 못했습니다."),
    [api, mutate],
  );

  const renamePane = useCallback(
    async (paneId: string, customTitle: string | null): Promise<boolean> => {
      if (!writableRef.current) return false;
      try {
        const pane = await api.renamePane(paneId, customTitle);
        const currentWorkspace = workspaceRef.current;
        if (currentWorkspace?.projectId === pane.projectId) {
          const next = {
            ...currentWorkspace,
            panes: currentWorkspace.panes.map((candidate) =>
              candidate.id === pane.id
                ? { ...candidate, customTitle: pane.customTitle ?? null }
                : candidate,
            ),
          };
          workspaceRef.current = next;
          setWorkspace(next);
        }
        return true;
      } catch (error) {
        onNotice(error instanceof ApiFailure ? error.message : "이름을 바꾸지 못했습니다.");
        return false;
      }
    },
    [api, onNotice],
  );

  const refresh = useCallback(async (): Promise<void> => {
    const projectId = workspaceRef.current?.projectId;
    if (projectId === undefined) return;
    const busy = (): boolean =>
      pendingRef.current !== null ||
      inFlightRef.current !== null ||
      pendingViewsRef.current.size > 0 ||
      viewFlightRef.current !== null;
    if (busy()) return;
    const generation = loadGenerationRef.current;
    try {
      const next = await api.workspace(projectId);
      if (generation !== loadGenerationRef.current || busy()) return;
      if (workspaceRef.current?.projectId === next.projectId) accept(next);
    } catch {
      // A missed refresh is retried on the next tick; errors show on real actions.
    }
  }, [accept, api]);

  const load = useCallback(
    async (projectId: string | null): Promise<boolean> => {
      const generation = ++loadGenerationRef.current;
      if (!projectId) {
        workspaceRef.current = null;
        setWorkspace(null);
        setLoading(false);
        return true;
      }
      setLoading(true);
      setIssue(null);
      try {
        const next = await api.workspace(projectId);
        if (generation !== loadGenerationRef.current) return false;
        accept(next);
        return true;
      } catch (error) {
        if (generation === loadGenerationRef.current) setIssue(issueFrom(error));
        return false;
      } finally {
        if (generation === loadGenerationRef.current) setLoading(false);
      }
    },
    [accept, api],
  );

  const clear = useCallback((): void => {
    loadGenerationRef.current += 1;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    if (viewTimerRef.current !== null) clearTimeout(viewTimerRef.current);
    viewTimerRef.current = null;
    pendingViewsRef.current.clear();
    workspaceRef.current = null;
    setLoading(false);
    setWorkspace(null);
    setIssue(null);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      if (viewTimerRef.current !== null) clearTimeout(viewTimerRef.current);
    },
    [],
  );

  useEffect(() => {
    if (writable) return;
    if (timerRef.current !== null) clearTimeout(timerRef.current);
    timerRef.current = null;
    pendingRef.current = null;
    if (viewTimerRef.current !== null) clearTimeout(viewTimerRef.current);
    viewTimerRef.current = null;
    pendingViewsRef.current.clear();
  }, [writable]);

  return {
    workspace,
    loading,
    issue,
    accept,
    activate,
    collapse,
    clear,
    current,
    flush,
    load,
    resize,
    updatePane,
    refresh,
    changeView,
    createView,
    deleteView,
    createViewPane,
    renamePane,
  };
}

/** Keeps this device's unsaved workspace changes over a server snapshot. */
function withPendingViews(
  workspace: Workspace,
  pending: ReadonlyMap<string, PendingViewSave>,
): Workspace {
  if (pending.size === 0 || workspace.views === undefined) return workspace;
  return {
    ...workspace,
    views: workspace.views.map((view) => {
      const local = pending.get(view.id);
      return local === undefined || local.projectId !== workspace.projectId
        ? view
        : { ...local.view, version: view.version };
    }),
  };
}

function issueFrom(error: unknown): WorkspaceIssue {
  if (error instanceof ApiFailure) {
    return {
      code: error.code,
      message: error.message,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return {
    code: "INTERNAL_ERROR",
    message: "작업공간을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.",
  };
}
