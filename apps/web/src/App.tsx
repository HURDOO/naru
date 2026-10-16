import type {
  ConnectedProjectTarget,
  CreatePaneRequest,
  LayoutNode,
  Pane,
  PaneKind,
  Passkey,
  NaruPushSubscription,
  Project,
  ProjectActivity,
  ProjectGroup,
  SplitDirection,
} from "@naru/contracts";
import { PUSH_INACTIVITY_DELAY_MINUTES } from "@naru/contracts";
import { isPaneCollapsed } from "@naru/domain";
import {
  browserSupportsWebAuthn,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import {
  type FormEvent,
  type KeyboardEvent,
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { ApiFailure, NaruApi } from "./api";
import { ActivityStatus } from "./ActivityStatus";
import { activityLabel } from "./activity-presentation";
import { passkeyMessageFrom } from "./auth-presentation";
import { applyCodexIdentity, PaneActivityFrameFence } from "./pane-runtime";
import { resolveProjectGroupEntry } from "./project-navigation";
import {
  browserSupportsPushNotifications,
  currentNotificationPermission,
  currentPushSubscriptionFingerprint,
  defaultPushDeviceName,
  enablePushNotifications,
  handoffTargetFromLocation,
  listenForHandoffTargets,
  listenForNotificationTargets,
  notificationTargetFromLocation,
  unsubscribeCurrentPushSubscription,
  type HandoffNotificationTarget,
  type NotificationTarget,
} from "./push-notifications";
import {
  PROJECT_PATH_PLACEHOLDER,
  PROJECT_ROOTS_INSTRUCTION,
  PROJECT_ROOTS_LABEL,
} from "./project-path-hint";
import {
  TerminalConnection,
  type ConnectionSnapshot,
  type PaneControlFrame,
} from "./terminal-connection";
import { useVisualViewportVariables, useWorkspaceView } from "./use-workspace-view";
import { useWorkspace, type WorkspaceIssue } from "./use-workspace";
import { WorkspaceLayout } from "./WorkspaceLayout";
import type { WorkspaceViewMode } from "./workspace-view";

const LAST_PROJECT_KEY = "naru-last-project";
const SCREEN_READER_MODE_KEY = "naru-screen-reader-mode";
const TERMINAL_INPUT_TOOLS_MODE_KEY = "naru-terminal-input-tools-mode";
/** Launch profiles of managed agents' Panes (server `launch-profiles.ts`). */
const AGENT_LAUNCH_PROFILES: ReadonlySet<string> = new Set(["claude-agent", "codex-agent"]);
/** How often the workspace view re-reads what waits for the person on the agent screen. */
const AGENT_WAITING_POLL_MS = 15_000;

/** The agent screens (and their markdown) load only when opened. */
const AgentApp = lazy(async () => {
  const module = await import("./AgentApp");
  return { default: module.AgentApp };
});

type SidebarFocusTarget = "close" | "project-form" | "selected-action";

interface StartupIssue {
  message: string;
  requestId?: string;
}

export default function App(): React.JSX.Element {
  useVisualViewportVariables();
  const workspaceView = useWorkspaceView();
  const api = useMemo(() => new NaruApi(), []);
  const [authState, setAuthState] = useState<"checking" | "signed-out" | "signed-in" | "error">(
    "checking",
  );
  const authStateRef = useRef(authState);
  const authenticationTransitionRef = useRef(0);
  const [signedOutNotice, setSignedOutNotice] = useState<string | null>(null);
  const [startupIssue, setStartupIssue] = useState<StartupIssue | null>(null);
  const [projectGroups, setProjectGroups] = useState<ProjectGroup[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [connection, setConnection] = useState<TerminalConnection | null>(null);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionSnapshot>({
    state: "connecting",
  });
  const mutationAllowed =
    connectionStatus.state === "active" && connectionStatus.surfaceRole === "controller";
  const [controlRequests, setControlRequests] = useState<
    Array<Extract<PaneControlFrame, { type: "pane.control.requested" }>>
  >([]);
  const [submittedControlRequests, setSubmittedControlRequests] = useState<Set<string>>(
    () => new Set(),
  );
  const [notice, setNotice] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [sidebarPreviewOpen, setSidebarPreviewOpen] = useState(false);
  const [sidebarFocusTarget, setSidebarFocusTarget] = useState<SidebarFocusTarget>("close");
  const [screenReaderMode, setScreenReaderMode] = useState(
    () => localStorage.getItem(SCREEN_READER_MODE_KEY) === "true",
  );
  const [terminalInputToolsAlways, setTerminalInputToolsAlways] = useState(
    () => localStorage.getItem(TERMINAL_INPUT_TOOLS_MODE_KEY) === "always",
  );
  const [passkeyDialogOpen, setPasskeyDialogOpen] = useState(false);
  const [pushDialogOpen, setPushDialogOpen] = useState(false);
  const [notificationTarget, setNotificationTarget] = useState<NotificationTarget | null>(() =>
    notificationTargetFromLocation(),
  );
  const [handoffTarget, setHandoffTarget] = useState<HandoffNotificationTarget | null>(() =>
    handoffTargetFromLocation(),
  );
  /** The Inbox item a handoff alert opened; the agent screen starts on it. */
  const [focusedHandoffId, setFocusedHandoffId] = useState<string | null>(null);
  /** The agent whose Pane an input-needed alert named (an approval); the agent screen opens it. */
  const [focusedAgentPaneId, setFocusedAgentPaneId] = useState<string | null>(null);
  const routingHandoffRef = useRef(false);
  const passkeyReturnFocusRef = useRef<HTMLElement | null>(null);
  const pushReturnFocusRef = useRef<HTMLElement | null>(null);
  const routingNotificationRef = useRef(false);
  const acknowledgingActivityRef = useRef(new Set<string>());
  const activityFrameFenceRef = useRef(new PaneActivityFrameFence());
  const projectToggleRef = useRef<HTMLButtonElement>(null);
  const workspaceTitleRef = useRef<HTMLHeadingElement>(null);
  const {
    workspace,
    loading: loadingWorkspace,
    issue: workspaceIssue,
    accept: acceptWorkspace,
    activate: activatePane,
    collapse: collapsePane,
    clear: clearWorkspace,
    current: currentWorkspace,
    flush: flushWorkspace,
    load: loadWorkspace,
    resize: resizePane,
    updatePane,
  } = useWorkspace(api, setNotice, mutationAllowed);

  // Agent Platform screen (AP-T17, AP-D022), shown only when the server serves the agent API.
  const [mainView, setMainView] = useState<"workspace" | "agents">("workspace");
  const [agentsAvailable, setAgentsAvailable] = useState(false);
  /** What waits for the person across projects, for the top bar on either view. */
  const [agentWaiting, setAgentWaiting] = useState(0);
  useEffect(() => {
    if (authState !== "signed-in") return;
    let cancelled = false;
    api.agentOverview().then(
      () => {
        if (!cancelled) setAgentsAvailable(true);
      },
      () => {
        if (!cancelled) setAgentsAvailable(false);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [api, authState]);
  useEffect(() => {
    // The agent screen reports its own count; the workspace view reads it now and then.
    if (authState !== "signed-in" || !agentsAvailable || mainView === "agents") return;
    let cancelled = false;
    const read = () =>
      void api.agentBoard().then(
        (board) => {
          if (cancelled) return;
          const approvals = [
            ...board.projects.flatMap((project) => project.pendingApprovals),
            ...board.globalPendingApprovals,
          ].length;
          const contracts = board.projects.filter(
            (project) => project.pendingIntentContract !== null,
          ).length;
          setAgentWaiting(approvals + board.openHandoffs.length + contracts);
        },
        () => undefined,
      );
    read();
    const timer = window.setInterval(read, AGENT_WAITING_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [agentsAvailable, api, authState, mainView]);
  const rememberProject = useCallback((projectId: string | null): void => {
    setSelectedProjectId(projectId);
    if (projectId) localStorage.setItem(LAST_PROJECT_KEY, projectId);
    else localStorage.removeItem(LAST_PROJECT_KEY);
  }, []);

  const projects = useMemo(() => connectedProjects(projectGroups), [projectGroups]);

  const refreshProjects = useCallback(async (): Promise<Project[]> => {
    const before = activityFrameFenceRef.current.version;
    const next = await api.projectGroups();
    const merged = activityFrameFenceRef.current
      .projectUpdatesAfter(before)
      .reduce(
        (groups, update) => updateProjectGroupActivity(groups, update.projectId, update.activity),
        next,
      );
    setProjectGroups(merged);
    return connectedProjects(merged);
  }, [api]);

  const reconcileProjectGroups = useCallback(async (): Promise<Project[]> => {
    const before = activityFrameFenceRef.current.version;
    const next = await api.refreshProjectGroups();
    const merged = activityFrameFenceRef.current
      .projectUpdatesAfter(before)
      .reduce(
        (groups, update) => updateProjectGroupActivity(groups, update.projectId, update.activity),
        next,
      );
    setProjectGroups(merged);
    return connectedProjects(merged);
  }, [api]);

  const requireAuthentication = useCallback(
    (message = "세션이 만료되었습니다. 다시 로그인해 주세요."): void => {
      authenticationTransitionRef.current += 1;
      api.clearSession();
      setConnection((current) => {
        current?.dispose();
        return null;
      });
      setConnectionStatus({ state: "authentication-required", message });
      setProjectGroups([]);
      activityFrameFenceRef.current.clear();
      setSelectedProjectId(null);
      clearWorkspace();
      setNotice(null);
      setSidebarPreviewOpen(false);
      setPasskeyDialogOpen(false);
      setPushDialogOpen(false);
      setSignedOutNotice(message);
      authStateRef.current = "signed-out";
      setAuthState("signed-out");
    },
    [api, clearWorkspace],
  );

  useEffect(
    () =>
      api.onAuthenticationRequired(() => {
        if (authStateRef.current === "signed-in") requireAuthentication();
      }),
    [api, requireAuthentication],
  );

  const openConnection = useCallback((): void => {
    setControlRequests([]);
    setSubmittedControlRequests(new Set());
    const restoreProtocol = api.terminalRestoreProtocol();
    const nextConnection = new TerminalConnection({
      ...(restoreProtocol === undefined ? {} : { restoreProtocol }),
      checkAuthentication: async () => {
        try {
          await api.session();
          return true;
        } catch (error) {
          if (error instanceof ApiFailure && error.code === "AUTH_REQUIRED") return false;
          throw error;
        }
      },
    });
    nextConnection.onStatus((snapshot) => {
      setConnectionStatus(snapshot);
      api.setControlSurface(
        snapshot.state === "active" &&
          snapshot.surfaceRole === "controller" &&
          snapshot.connectionId !== undefined &&
          snapshot.generation !== undefined
          ? { connectionId: snapshot.connectionId, generation: snapshot.generation }
          : undefined,
      );
      if (snapshot.state === "authentication-required") {
        requireAuthentication(snapshot.message);
      }
    });
    setConnection((current) => {
      current?.dispose();
      return nextConnection;
    });
  }, [api, requireAuthentication]);

  useEffect(() => {
    return () => connection?.dispose();
  }, [connection]);

  useEffect(() => {
    if (!connection) return;
    return connection.onActivity((frame) => {
      const current = currentWorkspace();
      const pane =
        current?.projectId === frame.projectId
          ? (current.panes.find((candidate) => candidate.id === frame.paneId) ?? null)
          : null;
      const accepted = activityFrameFenceRef.current.accept(frame, pane);
      if (accepted === null) return;
      if (accepted.pane !== null) updatePane(accepted.pane);
      const projectActivity = accepted.projectActivity;
      if (projectActivity !== null) {
        setProjectGroups((groups) =>
          updateProjectGroupActivity(groups, frame.projectId, projectActivity),
        );
      }
    });
  }, [connection, currentWorkspace, updatePane]);

  useEffect(() => {
    if (!connection) return;
    return connection.onCodexIdentity((frame) => {
      const current = currentWorkspace();
      const pane = current?.panes.find((candidate) => candidate.id === frame.paneId);
      if (!pane) return;
      const nextPane = applyCodexIdentity(pane, frame);
      if (nextPane) updatePane(nextPane);
    });
  }, [connection, currentWorkspace, updatePane]);

  useEffect(() => {
    if (!connection) return;
    return connection.onPaneControl((frame) => {
      if (frame.type === "pane.control.requested") {
        setControlRequests((current) => [
          ...current.filter((request) => request.controlRequestId !== frame.controlRequestId),
          frame,
        ]);
        return;
      }
      if (frame.type === "pane.control.request-resolved") {
        setControlRequests((current) =>
          current.filter((request) => request.controlRequestId !== frame.controlRequestId),
        );
        setSubmittedControlRequests((current) => {
          const next = new Set(current);
          next.delete(frame.controlRequestId);
          return next;
        });
      }
    });
  }, [connection]);

  const restoreSignedInState = useCallback(async (): Promise<void> => {
    const authenticationTransition = authenticationTransitionRef.current;
    setStartupIssue(null);
    const next = await reconcileProjectGroups();
    if (authenticationTransition !== authenticationTransitionRef.current) return;
    const remembered = localStorage.getItem(LAST_PROJECT_KEY);
    const selected = next.some((project) => project.id === remembered)
      ? remembered
      : (next[0]?.id ?? null);
    rememberProject(selected);
    setSidebarOpen(selected === null);
    setSidebarPreviewOpen(false);
    await loadWorkspace(selected);
    if (authenticationTransition !== authenticationTransitionRef.current) return;
    setSignedOutNotice(null);
    authStateRef.current = "signed-in";
    setAuthState("signed-in");
    openConnection();
  }, [loadWorkspace, openConnection, reconcileProjectGroups, rememberProject]);

  const checkSession = useCallback(async (): Promise<void> => {
    authStateRef.current = "checking";
    setAuthState("checking");
    setStartupIssue(null);
    try {
      await api.session();
      await restoreSignedInState();
    } catch (error) {
      if (error instanceof ApiFailure && error.code === "AUTH_REQUIRED") {
        setSignedOutNotice(null);
        authStateRef.current = "signed-out";
        setAuthState("signed-out");
      } else {
        setStartupIssue(startupIssueFrom(error));
        authStateRef.current = "error";
        setAuthState("error");
      }
    }
  }, [api, restoreSignedInState]);

  useEffect(() => {
    const timer = window.setTimeout(() => void checkSession(), 0);
    return () => window.clearTimeout(timer);
  }, [checkSession]);

  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const selectedProjectContext = findConnectedProjectTarget(projectGroups, selectedProjectId);
  const selectedProjectTitle = selectedProjectContext
    ? projectTitle(selectedProjectContext.group, selectedProjectContext.target)
    : "프로젝트 선택";
  const activeSidebarPreview = workspaceView.hoverProjectNavigation && sidebarPreviewOpen;
  const canChooseWorkspaceView = workspaceView.canChoose && (workspace?.panes.length ?? 0) > 1;

  const signedIn = async (): Promise<void> => {
    try {
      await restoreSignedInState();
      focusSoon(() => workspaceTitleRef.current);
    } catch (error) {
      setStartupIssue(startupIssueFrom(error));
      setAuthState("error");
    }
  };

  const acknowledgeCompletedPanes = useCallback(
    async (panes: readonly Pane[]): Promise<void> => {
      const pending = panes.filter(
        (pane) =>
          pane.activity.state === "completed" &&
          pane.activity.eventId !== null &&
          !acknowledgingActivityRef.current.has(pane.id),
      );
      if (pending.length === 0) return;
      for (const pane of pending) acknowledgingActivityRef.current.add(pane.id);

      const results = await Promise.allSettled(
        pending.map((pane) => api.acknowledgePaneActivity(pane.id, pane.activity.eventId!)),
      );
      let firstError: unknown;
      results.forEach((result, index) => {
        const pane = pending[index];
        if (pane) acknowledgingActivityRef.current.delete(pane.id);
        if (result.status === "fulfilled") updatePane(result.value);
        else firstError ??= result.reason;
      });
      try {
        await refreshProjects();
      } catch (error) {
        firstError ??= error;
      }
      if (firstError !== undefined) setNotice(messageFrom(firstError));
    },
    [api, refreshProjects, updatePane],
  );

  const activateAndAcknowledgePane = useCallback(
    (paneId: string): void => {
      const pane = currentWorkspace()?.panes.find((candidate) => candidate.id === paneId);
      activatePane(paneId);
      if (pane) void acknowledgeCompletedPanes([pane]);
    },
    [acknowledgeCompletedPanes, activatePane, currentWorkspace],
  );

  const openAgentPane = useCallback(
    async (paneId: string, projectId: string | null): Promise<void> => {
      try {
        // A global agent's Pane lives in the workspace it was started from; find which one.
        let target = projectId;
        if (target === null && !currentWorkspace()?.panes.some((pane) => pane.id === paneId)) {
          for (const project of projects) {
            const candidate = await api.workspace(project.id);
            if (candidate.panes.some((pane) => pane.id === paneId)) {
              target = project.id;
              break;
            }
          }
        }
        setMainView("workspace");
        if (target !== null && target !== selectedProjectId) {
          if (!(await flushWorkspace())) return;
          rememberProject(target);
          clearWorkspace();
          await loadWorkspace(target);
        } else if (!currentWorkspace()?.panes.some((pane) => pane.id === paneId)) {
          // An agent's Pane may have joined the workspace after this screen loaded it.
          await loadWorkspace(selectedProjectId);
        }
        if (!currentWorkspace()?.panes.some((pane) => pane.id === paneId)) {
          setNotice("이 에이전트의 화면을 작업공간에서 찾지 못했습니다.");
          return;
        }
        activateAndAcknowledgePane(paneId);
        focusPaneSoon(paneId);
      } catch (error) {
        setNotice(messageFrom(error));
      }
    },
    [
      activateAndAcknowledgePane,
      api,
      clearWorkspace,
      currentWorkspace,
      flushWorkspace,
      loadWorkspace,
      projects,
      rememberProject,
      selectedProjectId,
    ],
  );

  useEffect(() => {
    if (!connection) return;
    return connection.onInput((paneId) => {
      const current = currentWorkspace();
      if (!current || current.activePaneId !== paneId) return;
      const pane = current.panes.find((candidate) => candidate.id === paneId);
      if (pane) void acknowledgeCompletedPanes([pane]);
    });
  }, [acknowledgeCompletedPanes, connection, currentWorkspace]);

  const collapseAndFocusPane = useCallback(
    (paneId: string): void => {
      collapsePane(paneId);
      const nextActivePaneId = currentWorkspace()?.activePaneId;
      if (nextActivePaneId) focusPaneSurfaceSoon(nextActivePaneId);
    },
    [collapsePane, currentWorkspace],
  );

  const signOut = async (): Promise<void> => {
    await flushWorkspace();
    try {
      await api.logout();
    } finally {
      authenticationTransitionRef.current += 1;
      connection?.dispose();
      setConnection(null);
      setSignedOutNotice(null);
      authStateRef.current = "signed-out";
      setAuthState("signed-out");
      setProjectGroups([]);
      activityFrameFenceRef.current.clear();
      clearWorkspace();
      rememberProject(null);
    }
  };

  const createdProject = async (project: Project): Promise<void> => {
    await flushWorkspace();
    await refreshProjects();
    rememberProject(project.id);
    clearWorkspace();
    const loaded = await loadWorkspace(project.id);
    setSidebarOpen(false);
    setSidebarPreviewOpen(false);
    focusWorkspaceResultSoon(loaded, workspaceTitleRef);
  };

  const selectProject = (projectId: string): void => {
    void (async () => {
      const acknowledgeCompletedProject =
        projectId !== selectedProjectId &&
        projects.find((project) => project.id === projectId)?.activity.state === "completed";
      if (!(await flushWorkspace())) return;
      rememberProject(projectId);
      clearWorkspace();
      const loaded = await loadWorkspace(projectId);
      const targetWorkspace = currentWorkspace();
      if (loaded && acknowledgeCompletedProject && targetWorkspace?.projectId === projectId) {
        await acknowledgeCompletedPanes(targetWorkspace.panes);
      }
      setSidebarOpen(false);
      setSidebarPreviewOpen(false);
      focusWorkspaceResultSoon(loaded, workspaceTitleRef);
    })();
  };

  const createPane = async (
    targetPane: Pane | null,
    kind: PaneKind,
    direction: SplitDirection,
    selectedDocumentPath?: string,
  ): Promise<void> => {
    if (!selectedProjectId || !mutationAllowed) return;
    setNotice(null);
    if (!(await flushWorkspace())) return;
    const current = currentWorkspace();
    if (!current || current.projectId !== selectedProjectId) return;
    const targetPaneId = current.layout
      ? (targetPane?.id ?? current.activePaneId ?? current.panes[0]?.id ?? null)
      : null;
    if (current.layout && targetPaneId === null) {
      setNotice("분할할 Pane을 먼저 선택해 주세요.");
      return;
    }
    try {
      const input = createPaneRequest(
        kind,
        current.version,
        targetPaneId,
        direction,
        selectedDocumentPath,
      );
      const next = await api.createPane(selectedProjectId, input);
      acceptWorkspace(next);
      if (next.activePaneId) focusPaneSoon(next.activePaneId);
    } catch (error) {
      const message = messageFrom(error);
      await loadWorkspace(selectedProjectId);
      setNotice(message);
    }
  };

  const restartPane = async (pane: Pane): Promise<void> => {
    if (!mutationAllowed) return;
    setNotice(null);
    if (!(await flushWorkspace())) return;
    try {
      updatePane(await api.restartPane(pane.id));
      await loadWorkspace(selectedProjectId);
      focusPaneSoon(pane.id);
    } catch (error) {
      await loadWorkspace(selectedProjectId);
      setNotice(messageFrom(error));
      throw error;
    }
  };

  const startNewSession = async (pane: Pane): Promise<void> => {
    if (!mutationAllowed) return;
    setNotice(null);
    if (!(await flushWorkspace())) return;
    try {
      updatePane(
        await (pane.kind === "claude" ? api.startNewClaude(pane.id) : api.startNewCodex(pane.id)),
      );
      await loadWorkspace(selectedProjectId);
      focusPaneSoon(pane.id);
    } catch (error) {
      await loadWorkspace(selectedProjectId);
      setNotice(messageFrom(error));
      throw error;
    }
  };

  const closePane = async (pane: Pane): Promise<boolean> => {
    if (!mutationAllowed) return false;
    if (
      pane.status === "running" &&
      !window.confirm("실행 중인 프로세스를 종료하고 Pane을 닫을까요?")
    ) {
      return false;
    }
    if (!(await flushWorkspace())) return false;
    const current = currentWorkspace();
    if (!current || !current.panes.some((candidate) => candidate.id === pane.id)) return false;
    try {
      const next = await api.deletePane(pane.id, current.version);
      acceptWorkspace(next);
      if (next.activePaneId) focusPaneSoon(next.activePaneId);
      else focusSoon(() => workspaceTitleRef.current);
      return true;
    } catch (error) {
      const message = messageFrom(error);
      await loadWorkspace(selectedProjectId);
      setNotice(message);
      return false;
    }
  };

  const closeSidebar = (): void => {
    setSidebarOpen(false);
    setSidebarPreviewOpen(false);
    focusSoon(() =>
      workspaceView.overlayNavigation
        ? projectToggleRef.current
        : document.getElementById("project-sidebar-toggle"),
    );
  };

  const manageSelectedProject = (): void => {
    setSidebarFocusTarget(selectedProjectId ? "selected-action" : "project-form");
    setSidebarPreviewOpen(false);
    setSidebarOpen(true);
    focusSoon(() =>
      selectedProjectId
        ? document.getElementById(projectRemoveButtonId(selectedProjectId))
        : document.getElementById("project-path"),
    );
  };

  const retryWorkspace = (): void => {
    void (async () => {
      const loaded = await loadWorkspace(selectedProjectId);
      focusWorkspaceResultSoon(loaded, workspaceTitleRef);
    })();
  };

  const createTerminalFromActivePane = (): void => {
    const active = workspace?.panes.find((pane) => pane.id === workspace.activePaneId) ?? null;
    void createPane(active, "terminal", "horizontal");
  };

  const openDocumentPane = (kind: "files" | "docs" | "tasks"): void => {
    const current = currentWorkspace();
    const existing = current?.panes.find((pane) => pane.kind === kind);
    if (existing) {
      activatePane(existing.id);
      focusPaneSoon(existing.id);
      return;
    }
    const active = current?.panes.find((pane) => pane.id === current.activePaneId) ?? null;
    void createPane(active, kind, "horizontal");
  };

  const respondToControlRequest = (
    request: Extract<PaneControlFrame, { type: "pane.control.requested" }>,
    response: "approve" | "reject",
  ): void => {
    const sent =
      response === "approve"
        ? connection?.approvePaneControl(request.paneId, request.controlRequestId)
        : connection?.rejectPaneControl(request.paneId, request.controlRequestId);
    if (!sent) {
      setNotice("현재 화면에서 이 제어 요청을 처리할 수 없습니다.");
      return;
    }
    setSubmittedControlRequests((current) => new Set(current).add(request.controlRequestId));
  };

  const toggleScreenReaderMode = (): void => {
    const next = !screenReaderMode;
    setScreenReaderMode(next);
    localStorage.setItem(SCREEN_READER_MODE_KEY, String(next));
  };

  const toggleTerminalInputToolsMode = (): void => {
    const next = !terminalInputToolsAlways;
    setTerminalInputToolsAlways(next);
    localStorage.setItem(TERMINAL_INPUT_TOOLS_MODE_KEY, next ? "always" : "auto");
  };

  const openPasskeyDialog = (): void => {
    if (api.authMode() === "gateway-managed") return;
    passkeyReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPasskeyDialogOpen(true);
  };

  const closePasskeyDialog = (): void => {
    setPasskeyDialogOpen(false);
    focusSoon(() => passkeyReturnFocusRef.current);
  };

  const openPushDialog = (): void => {
    pushReturnFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setPushDialogOpen(true);
  };

  const closePushDialog = (): void => {
    setPushDialogOpen(false);
    focusSoon(() => pushReturnFocusRef.current);
  };

  useEffect(() => listenForNotificationTargets(setNotificationTarget), []);
  useEffect(() => listenForHandoffTargets(setHandoffTarget), []);

  useEffect(() => {
    if (
      authState !== "signed-in" ||
      handoffTarget === null ||
      !agentsAvailable ||
      routingHandoffRef.current
    ) {
      return;
    }
    routingHandoffRef.current = true;
    void (async () => {
      try {
        if (!projects.some((candidate) => candidate.id === handoffTarget.projectId)) {
          setNotice("알림이 가리킨 프로젝트를 더 이상 찾을 수 없습니다.");
          return;
        }
        if (handoffTarget.projectId !== selectedProjectId) {
          if (!(await flushWorkspace())) return;
          rememberProject(handoffTarget.projectId);
          clearWorkspace();
          await loadWorkspace(handoffTarget.projectId);
        }
        setSidebarOpen(false);
        setSidebarPreviewOpen(false);
        setFocusedAgentPaneId(null);
        setFocusedHandoffId(handoffTarget.handoffId);
        setMainView("agents");
      } catch (error) {
        setNotice(messageFrom(error));
      } finally {
        setHandoffTarget(null);
        routingHandoffRef.current = false;
      }
    })();
  }, [
    agentsAvailable,
    authState,
    clearWorkspace,
    flushWorkspace,
    handoffTarget,
    loadWorkspace,
    projects,
    rememberProject,
    selectedProjectId,
  ]);

  useEffect(() => {
    if (
      authState !== "signed-in" ||
      notificationTarget === null ||
      routingNotificationRef.current
    ) {
      return;
    }
    routingNotificationRef.current = true;
    void (async () => {
      try {
        const project = projects.find((candidate) => candidate.id === notificationTarget.projectId);
        if (!project) {
          setNotice("알림이 가리킨 프로젝트를 더 이상 찾을 수 없습니다.");
          return;
        }
        if (notificationTarget.projectId !== selectedProjectId) {
          if (!(await flushWorkspace())) return;
          rememberProject(notificationTarget.projectId);
          clearWorkspace();
          await loadWorkspace(notificationTarget.projectId);
        } else if (currentWorkspace()?.projectId !== notificationTarget.projectId) {
          await loadWorkspace(notificationTarget.projectId);
        }
        const targetWorkspace = currentWorkspace();
        const pane = targetWorkspace?.panes.find(
          (candidate) => candidate.id === notificationTarget.paneId,
        );
        if (!pane) {
          setNotice("알림이 가리킨 Pane을 더 이상 찾을 수 없습니다.");
          return;
        }
        setSidebarOpen(false);
        setSidebarPreviewOpen(false);
        // A managed agent waits for an approval, which is answered on the agent screen. Right
        // after sign-in the agent API may not be known yet, so ask it here.
        const agentScreen =
          AGENT_LAUNCH_PROFILES.has(pane.launchProfile) &&
          (agentsAvailable ||
            (await api.agentOverview().then(
              () => true,
              () => false,
            )));
        if (agentScreen) {
          setAgentsAvailable(true);
          setFocusedHandoffId(null);
          setFocusedAgentPaneId(pane.id);
          setMainView("agents");
          return;
        }
        activatePane(pane.id);
        focusPaneSoon(pane.id);
      } catch (error) {
        setNotice(messageFrom(error));
      } finally {
        setNotificationTarget(null);
        routingNotificationRef.current = false;
      }
    })();
  }, [
    activatePane,
    agentsAvailable,
    api,
    authState,
    clearWorkspace,
    currentWorkspace,
    flushWorkspace,
    loadWorkspace,
    notificationTarget,
    projects,
    rememberProject,
    selectedProjectId,
  ]);

  if (authState === "checking") return <AppLoading />;
  if (authState === "error") {
    return (
      <ServiceUnavailableScreen
        issue={
          startupIssue ?? {
            message: "Naru를 시작하지 못했습니다. 서버 상태를 확인해 주세요.",
          }
        }
        onRetry={() => void checkSession()}
      />
    );
  }
  if (authState === "signed-out") {
    return <LoginScreen api={api} notice={signedOutNotice} onSignedIn={signedIn} />;
  }

  return (
    <div
      className="app-shell"
      data-connection-state={connectionStatus.state}
      data-surface-role={connectionStatus.surfaceRole ?? "none"}
      data-lease-acquisition={connectionStatus.acquisition ?? "none"}
      data-workspace-view={workspaceView.mode}
      data-terminal-input-tools={terminalInputToolsAlways ? "always" : "auto"}
    >
      <header className="topbar">
        <div className="brand-lockup">
          <button
            ref={projectToggleRef}
            className="project-toggle"
            type="button"
            onClick={() => {
              if (sidebarOpen) closeSidebar();
              else {
                setSidebarFocusTarget("close");
                setSidebarOpen(true);
              }
            }}
            aria-label={sidebarOpen ? "프로젝트 메뉴 닫기" : "프로젝트 메뉴 열기"}
            aria-controls="project-sidebar"
            aria-expanded={sidebarOpen}
          >
            ☰
          </button>
          <span className="brand-mark" aria-hidden="true" />
          <span className="brand-name">Naru</span>
          <h1
            ref={workspaceTitleRef}
            className="brand-context"
            tabIndex={-1}
            title={selectedProjectTitle}
          >
            {selectedProjectTitle}
          </h1>
        </div>
        <div className="topbar-actions">
          {agentsAvailable && selectedProject && (
            <MainViewTabs
              className="topbar-view-switch"
              view={mainView}
              waiting={agentWaiting}
              onChange={setMainView}
            />
          )}
          <ConnectionBadge snapshot={connectionStatus} />
          <div className="desktop-topbar-actions">
            {selectedProject && !(agentsAvailable && mainView === "agents") && (
              <div className="topbar-workspace-actions">
                {canChooseWorkspaceView && (
                  <WorkspaceViewControl
                    mode={workspaceView.mode}
                    onChange={workspaceView.setMode}
                  />
                )}
                <button
                  className="primary-button compact"
                  type="button"
                  onClick={createTerminalFromActivePane}
                  disabled={!mutationAllowed}
                >
                  <span aria-hidden="true">＋</span> 새 터미널
                </button>
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => openDocumentPane("files")}
                  disabled={!mutationAllowed}
                >
                  Files
                </button>
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => openDocumentPane("docs")}
                  disabled={!mutationAllowed}
                >
                  Docs
                </button>
                <button
                  className="secondary-button compact"
                  type="button"
                  onClick={() => openDocumentPane("tasks")}
                  disabled={!mutationAllowed}
                >
                  Tasks
                </button>
              </div>
            )}
            <span className="topbar-action-divider" aria-hidden="true" />
            <button
              className="quiet-button terminal-input-tools-button"
              type="button"
              aria-label={`입력 도우미: ${terminalInputToolsAlways ? "항상" : "자동"}`}
              aria-pressed={terminalInputToolsAlways}
              title="터미널 입력 도우미를 화면 감지와 관계없이 항상 표시"
              onClick={toggleTerminalInputToolsMode}
            >
              <span aria-hidden="true">⌨</span> {terminalInputToolsAlways ? "항상" : "자동"}
            </button>
            <button
              className="quiet-button screen-reader-button"
              type="button"
              aria-label="스크린 리더 모드"
              aria-pressed={screenReaderMode}
              title="터미널 스크린 리더 모드"
              onClick={toggleScreenReaderMode}
            >
              스크린 리더
            </button>
            {api.authMode() === "app-managed" && (
              <button className="quiet-button" type="button" onClick={openPasskeyDialog}>
                패스키
              </button>
            )}
            <button className="quiet-button" type="button" onClick={openPushDialog}>
              알림
            </button>
            <button className="quiet-button" type="button" onClick={() => void signOut()}>
              로그아웃
            </button>
          </div>
          <TopbarMenu
            connectionStatus={connectionStatus}
            canCreateTerminal={selectedProject !== null && mutationAllowed}
            canChooseWorkspaceView={canChooseWorkspaceView}
            workspaceViewMode={workspaceView.mode}
            screenReaderMode={screenReaderMode}
            terminalInputToolsAlways={terminalInputToolsAlways}
            canManagePasskeys={api.authMode() === "app-managed"}
            onCreateTerminal={() => {
              setMainView("workspace");
              createTerminalFromActivePane();
            }}
            onOpenFiles={() => {
              setMainView("workspace");
              openDocumentPane("files");
            }}
            onOpenDocs={() => {
              setMainView("workspace");
              openDocumentPane("docs");
            }}
            onOpenTasks={() => {
              setMainView("workspace");
              openDocumentPane("tasks");
            }}
            onWorkspaceViewChange={(mode) => {
              setMainView("workspace");
              workspaceView.setMode(mode);
            }}
            onToggleScreenReaderMode={toggleScreenReaderMode}
            onToggleTerminalInputToolsMode={toggleTerminalInputToolsMode}
            onManagePasskeys={openPasskeyDialog}
            onManagePushNotifications={openPushDialog}
            onSignOut={() => void signOut()}
          />
        </div>
      </header>

      {connectionStatus.state === "active" && connectionStatus.surfaceRole === "observer" && (
        <div className="takeover-banner" role="status" aria-live="polite">
          <span>{connectionStatus.message}</span>
          <button
            type="button"
            onClick={() => connection?.takeControl(workspace?.activePaneId ?? undefined)}
          >
            {connectionStatus.controllerPresent === false
              ? "이 화면에서 제어 시작"
              : "제어권 가져오기"}
          </button>
        </div>
      )}

      {mutationAllowed && controlRequests.length > 0 && (
        <div className="control-request-banner" role="alert" aria-live="assertive">
          {controlRequests.map((request) => {
            const paneTitle = workspace?.panes.find((pane) => pane.id === request.paneId)?.title;
            const submitted = submittedControlRequests.has(request.controlRequestId);
            return (
              <div key={request.controlRequestId}>
                <span>
                  외부 도구가 {paneTitle ?? "터미널"} 제어권을 요청했습니다.
                  {submitted ? " 요청자 응답을 기다리는 중입니다." : ""}
                </span>
                <div>
                  <button
                    type="button"
                    disabled={submitted}
                    onClick={() => respondToControlRequest(request, "approve")}
                  >
                    승인
                  </button>
                  <button
                    type="button"
                    disabled={submitted}
                    onClick={() => respondToControlRequest(request, "reject")}
                  >
                    거절
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(connectionStatus.state === "disconnected" || connectionStatus.state === "revoked") && (
        <div className="takeover-banner" role="alert">
          <span>
            {connectionStatus.message ??
              (connectionStatus.state === "disconnected"
                ? "터미널 연결이 끊겼습니다."
                : "터미널 입력이 중지되었습니다.")}
          </span>
          <button
            type="button"
            onClick={() => {
              connection?.reconnectNow();
            }}
          >
            다시 연결
          </button>
        </div>
      )}

      <div className="app-body">
        <ProjectSidebar
          open={sidebarOpen}
          previewOpen={activeSidebarPreview}
          overlay={workspaceView.overlayNavigation}
          hoverExpand={workspaceView.hoverProjectNavigation}
          api={api}
          groups={projectGroups}
          projectRoots={api.projectRoots()}
          selectedProjectId={selectedProjectId}
          focusTarget={sidebarFocusTarget}
          mutationAllowed={mutationAllowed}
          onSelect={selectProject}
          onCreated={createdProject}
          onChanged={refreshProjects}
          onRefresh={reconcileProjectGroups}
          onDeleted={(projectId) => {
            if (selectedProjectId === projectId) {
              rememberProject(null);
              clearWorkspace();
            }
          }}
          onBeforeDelete={flushWorkspace}
          onError={setNotice}
          onOpen={() => setSidebarOpen(true)}
          onClose={closeSidebar}
          onPreviewOpen={() => setSidebarPreviewOpen(true)}
          onPreviewClose={() => setSidebarPreviewOpen(false)}
        />
        {workspaceView.overlayNavigation && sidebarOpen && (
          <button
            className="sidebar-scrim"
            type="button"
            onClick={closeSidebar}
            aria-label="프로젝트 메뉴 바깥 영역 닫기"
          />
        )}

        <main className="workspace-area">
          {notice && (
            <div className="notice" role="alert">
              <span>{notice}</span>
              <button type="button" onClick={() => setNotice(null)} aria-label="알림 닫기">
                ×
              </button>
            </div>
          )}
          {!selectedProject ? (
            <WorkspaceEmpty
              icon="⌁"
              title="프로젝트를 연결해 주세요"
              description="Mac mini에 있는 프로젝트의 절대 경로를 등록하면 여기서 터미널을 이어 쓸 수 있습니다."
              actionLabel="프로젝트 메뉴 열기"
              onAction={() => {
                setSidebarFocusTarget("project-form");
                setSidebarOpen(true);
              }}
            />
          ) : agentsAvailable && mainView === "agents" ? (
            <>
              <MainViewTabs view={mainView} waiting={agentWaiting} onChange={setMainView} />
              <Suspense
                fallback={
                  <div className="inline-loading">
                    <span /> 에이전트 화면을 여는 중…
                  </div>
                }
              >
                <AgentApp
                  key={`${focusedHandoffId ?? ""}:${focusedAgentPaneId ?? ""}`}
                  api={api}
                  projects={projects}
                  currentProjectId={selectedProject.id}
                  mutationAllowed={mutationAllowed}
                  onOpenPane={(paneId, projectId) => void openAgentPane(paneId, projectId)}
                  initialHandoffId={focusedHandoffId}
                  initialAgentPaneId={focusedAgentPaneId}
                  onWaitingChange={setAgentWaiting}
                />
              </Suspense>
            </>
          ) : (
            <>
              {agentsAvailable && (
                <MainViewTabs view={mainView} waiting={agentWaiting} onChange={setMainView} />
              )}
              {workspace && workspace.panes.length > 1 && (
                <PaneTabs
                  panes={workspace.panes}
                  layout={workspace.layout}
                  activePaneId={workspace.activePaneId}
                  onActivate={activateAndAcknowledgePane}
                />
              )}

              <div className="workspace-content">
                {workspaceIssue ? (
                  <WorkspaceUnavailable
                    issue={workspaceIssue}
                    onRetry={retryWorkspace}
                    onManageProject={manageSelectedProject}
                  />
                ) : loadingWorkspace && !workspace ? (
                  <div className="inline-loading">
                    <span /> 작업공간을 여는 중…
                  </div>
                ) : !workspace?.layout ? (
                  <WorkspaceEmpty
                    icon="›_"
                    title="첫 터미널을 열어 보세요"
                    description="프로젝트 폴더를 현재 위치로 사용하는 로그인 셸이 서버에서 시작됩니다. 브라우저를 닫아도 계속 실행됩니다."
                    actionLabel="터미널 만들기"
                    onAction={() => void createPane(null, "terminal", "horizontal")}
                    actionDisabled={!mutationAllowed}
                  />
                ) : (
                  <WorkspaceLayout
                    workspace={workspace}
                    api={api}
                    connection={connection}
                    connectionStatus={connectionStatus}
                    screenReaderMode={screenReaderMode}
                    viewMode={workspaceView.mode}
                    mutationAllowed={mutationAllowed}
                    onActivate={activateAndAcknowledgePane}
                    onFocus={activateAndAcknowledgePane}
                    onCollapse={collapseAndFocusPane}
                    onResize={resizePane}
                    onRestart={restartPane}
                    onStartNewSession={startNewSession}
                    onAgentExited={() => void loadWorkspace(selectedProjectId)}
                    onClose={closePane}
                    onSplit={(target, kind, direction) => createPane(target, kind, direction)}
                    onOpenDocumentInNewPane={(target, path, direction) =>
                      createPane(target, target.kind, direction, path)
                    }
                    onOpenFilesInNewPane={(target, path, direction) =>
                      createPane(target, "files", direction, path)
                    }
                    onOpenStructuredDocument={(target, path, kind, direction) =>
                      createPane(target, kind, direction, path)
                    }
                    onPaneViewStateChanged={updatePane}
                  />
                )}
              </div>
            </>
          )}
        </main>
      </div>
      {passkeyDialogOpen && api.authMode() === "app-managed" && (
        <PasskeyDialog api={api} onClose={closePasskeyDialog} />
      )}
      {pushDialogOpen && <PushNotificationDialog api={api} onClose={closePushDialog} />}
    </div>
  );
}

function LoginScreen({
  api,
  notice,
  onSignedIn,
}: {
  api: NaruApi;
  notice: string | null;
  onSignedIn: () => Promise<void>;
}): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"password" | "passkey" | null>(null);
  const supportsPasskeys = browserSupportsWebAuthn();
  const [passwordExpanded, setPasswordExpanded] = useState(!supportsPasskeys);
  const passwordInputRef = useRef<HTMLInputElement>(null);

  const showPasswordLogin = (focus: boolean): void => {
    setPasswordExpanded(true);
    if (focus) focusSoon(() => passwordInputRef.current);
  };

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy("password");
    setError(null);
    try {
      await api.login(password);
      await onSignedIn();
    } catch (submitError) {
      setError(messageFrom(submitError));
      focusSoon(() => passwordInputRef.current);
    } finally {
      setBusy(null);
    }
  };

  const loginWithPasskey = async (): Promise<void> => {
    setBusy("passkey");
    setError(null);
    try {
      const { ceremonyId, options } = await api.passkeyAuthenticationOptions();
      const response = await startAuthentication({ optionsJSON: options });
      await api.loginWithPasskey(ceremonyId, response);
      await onSignedIn();
    } catch (passkeyError) {
      setError(passkeyMessageFrom(passkeyError));
      showPasswordLogin(true);
    } finally {
      setBusy(null);
    }
  };

  if (api.authMode() === "gateway-managed") {
    const returnTo = `${window.location.pathname}${window.location.search}`;
    return (
      <main className="login-screen">
        <section className="login-card" aria-labelledby="gateway-login-title">
          <div className="login-brand">
            <span className="brand-mark large" aria-hidden="true" />
            <span>Naru</span>
          </div>
          <div className="login-copy">
            <h1 id="gateway-login-title">Gateway 세션이 종료되었습니다.</h1>
            <p>Workstation Gateway에서 패스키로 다시 인증해 주세요.</p>
          </div>
          {notice && (
            <div className="login-session-notice" role="status">
              {notice}
            </div>
          )}
          <a
            className="primary-button passkey-login-button"
            href={`/_gateway/login?return=${encodeURIComponent(returnTo)}`}
          >
            Gateway로 다시 로그인
          </a>
        </section>
      </main>
    );
  }

  return (
    <main className="login-screen">
      <div className="login-ambient ambient-one" />
      <div className="login-ambient ambient-two" />
      <section className="login-card" aria-labelledby="login-title">
        <div className="login-brand">
          <span className="brand-mark large" aria-hidden="true" />
          <span>Naru</span>
        </div>
        <div className="login-copy">
          <div className="eyebrow">YOUR WORK, IN MOTION</div>
          <h1 id="login-title">
            작업의 흐름을
            <br />
            그대로 이어가세요.
          </h1>
          <p>Mac mini에서 실행 중인 터미널을 어느 화면에서든 안전하게 다시 엽니다.</p>
        </div>
        {notice && (
          <div className="login-session-notice" role="status">
            {notice}
          </div>
        )}
        <button
          className="primary-button passkey-login-button"
          type="button"
          disabled={!supportsPasskeys || busy !== null}
          autoFocus={supportsPasskeys}
          onClick={() => void loginWithPasskey()}
          aria-describedby={error ? "login-error" : undefined}
        >
          <span aria-hidden="true">◇</span>
          {busy === "passkey"
            ? "패스키 확인 중…"
            : supportsPasskeys
              ? "패스키로 로그인"
              : "이 브라우저는 패스키를 지원하지 않습니다"}
        </button>
        {error && (
          <div id="login-error" className="form-error" role="alert">
            {error}
          </div>
        )}
        <button
          className="password-disclosure-toggle"
          type="button"
          aria-expanded={passwordExpanded}
          aria-controls="password-login-panel"
          disabled={busy !== null}
          onClick={() => {
            if (passwordExpanded) setPasswordExpanded(false);
            else showPasswordLogin(true);
          }}
        >
          <span>비밀번호로 로그인</span>
          <span aria-hidden="true">{passwordExpanded ? "▴" : "▾"}</span>
        </button>
        <div id="password-login-panel" hidden={!passwordExpanded}>
          <form onSubmit={(event) => void submit(event)}>
            <label htmlFor="password">Naru 비밀번호</label>
            <div className={`password-field ${error ? "has-error" : ""}`}>
              <span aria-hidden="true">⌁</span>
              <input
                ref={passwordInputRef}
                id="password"
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                autoComplete="current-password"
                autoFocus={!supportsPasskeys}
                required
                placeholder="비밀번호 입력"
                aria-invalid={error !== null}
                aria-describedby={error ? "login-error" : undefined}
              />
            </div>
            <button
              className="secondary-button login-submit"
              type="submit"
              disabled={busy !== null}
            >
              {busy === "password" ? "연결 중…" : "작업공간 열기"}
              <span aria-hidden="true">→</span>
            </button>
          </form>
        </div>
        <div className="login-footnote">
          <span aria-hidden="true">●</span> Private network only
        </div>
      </section>
    </main>
  );
}

function PasskeyDialog({ api, onClose }: { api: NaruApi; onClose: () => void }): React.JSX.Element {
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [name, setName] = useState("내 패스키");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const supportsPasskeys = browserSupportsWebAuthn();

  const refresh = useCallback(async (): Promise<void> => {
    setPasskeys(await api.passkeys());
  }, [api]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void api
        .passkeys()
        .then((loaded) => {
          if (active) setPasskeys(loaded);
        })
        .catch((loadError: unknown) => {
          if (active) setError(messageFrom(loadError));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [api]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const register = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("패스키 이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const { ceremonyId, options } = await api.passkeyRegistrationOptions();
      const response = await startRegistration({ optionsJSON: options });
      await api.registerPasskey(ceremonyId, trimmedName, response);
      await refresh();
      setName("내 패스키");
      setMessage("패스키를 등록했습니다.");
    } catch (registrationError) {
      setError(passkeyMessageFrom(registrationError));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (passkey: Passkey): Promise<void> => {
    const nextName = window.prompt("패스키 이름", passkey.name)?.trim();
    if (!nextName || nextName === passkey.name) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.renamePasskey(passkey.id, nextName);
      await refresh();
      setMessage("패스키 이름을 변경했습니다.");
    } catch (renameError) {
      setError(messageFrom(renameError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (passkey: Passkey): Promise<void> => {
    if (!window.confirm(`${passkey.name} 패스키를 삭제할까요?`)) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.deletePasskey(passkey.id);
      await refresh();
      setMessage("패스키를 삭제했습니다. 비밀번호 로그인은 계속 사용할 수 있습니다.");
    } catch (deleteError) {
      setError(messageFrom(deleteError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="passkey-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="passkey-dialog-title"
        aria-describedby="passkey-dialog-description"
      >
        <header>
          <div>
            <div className="eyebrow">ACCOUNT SECURITY</div>
            <h2 id="passkey-dialog-title">패스키 관리</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="패스키 관리 닫기"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p id="passkey-dialog-description" className="passkey-description">
          기기의 화면 잠금으로 Naru에 로그인합니다. 비밀번호는 복구 수단으로 계속 남습니다.
        </p>

        <div className="passkey-register">
          <label htmlFor="passkey-name">새 패스키 이름</label>
          <div>
            <input
              id="passkey-name"
              value={name}
              maxLength={64}
              disabled={busy || !supportsPasskeys}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <button
              className="primary-button compact"
              type="button"
              disabled={busy || !supportsPasskeys}
              onClick={() => void register()}
            >
              {busy ? "처리 중…" : "등록"}
            </button>
          </div>
          {!supportsPasskeys && (
            <p className="passkey-support-note">이 브라우저에서는 패스키를 등록할 수 없습니다.</p>
          )}
        </div>

        {(error || message) && (
          <div className={error ? "form-error passkey-feedback" : "passkey-feedback"} role="alert">
            {error ?? message}
          </div>
        )}

        <div className="passkey-list" aria-busy={loading}>
          <h3>등록된 패스키</h3>
          {loading ? (
            <p className="passkey-empty">불러오는 중…</p>
          ) : passkeys.length === 0 ? (
            <p className="passkey-empty">아직 등록된 패스키가 없습니다.</p>
          ) : (
            <ul>
              {passkeys.map((passkey) => (
                <li key={passkey.id}>
                  <div>
                    <strong>{passkey.name}</strong>
                    <span>
                      {passkey.backedUp ? "동기화됨" : "이 기기에 저장됨"} · 등록{" "}
                      {formatDate(passkey.createdAt)}
                      {passkey.lastUsedAt ? ` · 최근 사용 ${formatDate(passkey.lastUsedAt)}` : ""}
                    </span>
                  </div>
                  <div className="passkey-actions">
                    <button type="button" disabled={busy} onClick={() => void rename(passkey)}>
                      이름 변경
                    </button>
                    <button
                      className="danger"
                      type="button"
                      disabled={busy}
                      onClick={() => void remove(passkey)}
                    >
                      삭제
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function PushNotificationDialog({
  api,
  onClose,
}: {
  api: NaruApi;
  onClose: () => void;
}): React.JSX.Element {
  const [subscriptions, setSubscriptions] = useState<NaruPushSubscription[]>([]);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [inactivityDelayInput, setInactivityDelayInput] = useState(
    String(PUSH_INACTIVITY_DELAY_MINUTES.default),
  );
  const [savedInactivityDelay, setSavedInactivityDelay] = useState<number>(
    PUSH_INACTIVITY_DELAY_MINUTES.default,
  );
  const [currentFingerprint, setCurrentFingerprint] = useState<string | null>(null);
  const [permission, setPermission] = useState(currentNotificationPermission);
  const [name, setName] = useState(defaultPushDeviceName);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const supported = browserSupportsPushNotifications();

  const refresh = useCallback(async (): Promise<void> => {
    const [configuration, loaded, fingerprint] = await Promise.all([
      api.pushConfiguration(),
      api.pushSubscriptions(),
      currentPushSubscriptionFingerprint(),
    ]);
    setConfigured(configuration.configured);
    setInactivityDelayInput(String(configuration.inactivityDelayMinutes));
    setSavedInactivityDelay(configuration.inactivityDelayMinutes);
    setSubscriptions(loaded);
    setCurrentFingerprint(fingerprint);
    setPermission(currentNotificationPermission());
  }, [api]);

  useEffect(() => {
    let active = true;
    const timer = window.setTimeout(() => {
      void refresh()
        .catch((loadError: unknown) => {
          if (active) setError(messageFrom(loadError));
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 0);
    return () => {
      active = false;
      window.clearTimeout(timer);
    };
  }, [refresh]);

  useEffect(() => {
    const handleKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [
        ...(dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);

  const enable = async (): Promise<void> => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError("알림 기기 이름을 입력해 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await enablePushNotifications(api, trimmedName);
      await refresh();
      setMessage("이 기기의 작업 상태 알림을 켰습니다.");
    } catch (enableError) {
      setPermission(currentNotificationPermission());
      setError(messageFrom(enableError));
    } finally {
      setBusy(false);
    }
  };

  const saveInactivityDelay = async (): Promise<void> => {
    const nextDelay = Number(inactivityDelayInput);
    if (
      !Number.isInteger(nextDelay) ||
      nextDelay < PUSH_INACTIVITY_DELAY_MINUTES.min ||
      nextDelay > PUSH_INACTIVITY_DELAY_MINUTES.max
    ) {
      setError(
        `${PUSH_INACTIVITY_DELAY_MINUTES.min}분에서 ${PUSH_INACTIVITY_DELAY_MINUTES.max}분 사이의 정수를 입력해 주세요.`,
      );
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const configuration = await api.updatePushConfiguration(nextDelay);
      setInactivityDelayInput(String(configuration.inactivityDelayMinutes));
      setSavedInactivityDelay(configuration.inactivityDelayMinutes);
      setMessage("활성 기기 알림 대기 시간을 저장했습니다.");
    } catch (saveError) {
      setError(messageFrom(saveError));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (subscription: NaruPushSubscription): Promise<void> => {
    const nextName = window.prompt("알림 기기 이름", subscription.name)?.trim();
    if (!nextName || nextName === subscription.name) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.renamePushSubscription(subscription.id, nextName);
      await refresh();
      setMessage("알림 기기 이름을 변경했습니다.");
    } catch (renameError) {
      setError(messageFrom(renameError));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (subscription: NaruPushSubscription): Promise<void> => {
    const current = subscription.endpointFingerprint === currentFingerprint;
    if (
      !window.confirm(
        current
          ? `${subscription.name} 알림을 이 브라우저에서도 해지할까요?`
          : `${subscription.name} 기기로 보내는 알림을 중지할까요?`,
      )
    ) {
      return;
    }
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      await api.deletePushSubscription(subscription.id);
      let browserUnsubscribed = true;
      if (current) {
        try {
          await unsubscribeCurrentPushSubscription();
        } catch {
          browserUnsubscribed = false;
        }
      }
      await refresh();
      setMessage(
        current && !browserUnsubscribed
          ? "서버 전송은 중지했습니다. 브라우저 사이트 설정에서 남은 알림 구독을 확인해 주세요."
          : current
            ? "이 기기의 알림을 해지했습니다."
            : "선택한 기기의 알림을 중지했습니다.",
      );
    } catch (deleteError) {
      setError(messageFrom(deleteError));
    } finally {
      setBusy(false);
    }
  };

  const currentRegistered = subscriptions.some(
    (subscription) => subscription.endpointFingerprint === currentFingerprint,
  );
  const canEnable =
    supported && configured === true && permission !== "denied" && !currentRegistered;
  const permissionLabel = {
    unsupported: "미지원",
    default: "아직 요청하지 않음",
    denied: "브라우저에서 차단됨",
    granted: "허용됨",
  }[permission];

  return (
    <div
      className="dialog-backdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialogRef}
        className="passkey-dialog push-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="push-dialog-title"
        aria-describedby="push-dialog-description"
      >
        <header>
          <div>
            <div className="eyebrow">TASK NOTIFICATIONS</div>
            <h2 id="push-dialog-title">알림 관리</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="알림 관리 닫기"
            disabled={busy}
            onClick={onClose}
          >
            ×
          </button>
        </header>
        <p id="push-dialog-description" className="passkey-description">
          Naru를 보고 있지 않을 때 완료·입력 필요·실패만 일반 문구로 알립니다. 프로젝트명, 명령과
          터미널 내용은 알림에 포함하지 않습니다.
        </p>

        <div className="passkey-register push-presence-setting">
          <label htmlFor="push-inactivity-delay">활성 기기 알림 대기</label>
          <div>
            <input
              id="push-inactivity-delay"
              className="push-delay-input"
              type="number"
              inputMode="numeric"
              min={PUSH_INACTIVITY_DELAY_MINUTES.min}
              max={PUSH_INACTIVITY_DELAY_MINUTES.max}
              step={1}
              value={inactivityDelayInput}
              disabled={busy || loading}
              aria-describedby="push-inactivity-delay-help"
              onChange={(event) => setInactivityDelayInput(event.target.value)}
            />
            <span className="push-delay-unit">분</span>
            <button
              className="primary-button compact"
              type="button"
              disabled={busy || loading || Number(inactivityDelayInput) === savedInactivityDelay}
              onClick={() => void saveInactivityDelay()}
            >
              저장
            </button>
          </div>
          <p id="push-inactivity-delay-help" className="passkey-support-note">
            현재 제어 중인 PC·모바일 화면이 보이고 초점이 있을 때, 마지막 입력 후 이 시간이 지나기
            전에는 모든 기기로 새 알림을 보내지 않습니다. 연결 heartbeat가 끊긴 화면은 활성으로 보지
            않습니다.
          </p>
        </div>

        <div className="passkey-register">
          <label htmlFor="push-device-name">이 기기 이름</label>
          <div>
            <input
              id="push-device-name"
              value={name}
              maxLength={64}
              disabled={busy || !canEnable}
              onChange={(event) => setName(event.target.value)}
              autoFocus
            />
            <button
              className="primary-button compact"
              type="button"
              disabled={busy || !canEnable}
              onClick={() => void enable()}
            >
              {busy ? "처리 중…" : currentRegistered ? "이 기기 켜짐" : "이 기기에서 켜기"}
            </button>
          </div>
          <p className="passkey-support-note">
            브라우저 권한: {permissionLabel}
            {configured === false ? " · 서버 Web Push 미설정" : ""}
          </p>
          {permission === "denied" && (
            <p className="passkey-support-note">
              다시 켜려면 브라우저의 Naru 사이트 설정에서 알림을 허용해 주세요.
            </p>
          )}
        </div>

        {(error || message) && (
          <div className={error ? "form-error passkey-feedback" : "passkey-feedback"} role="alert">
            {error ?? message}
          </div>
        )}

        <div className="passkey-list" aria-busy={loading}>
          <h3>등록된 알림 기기</h3>
          {loading ? (
            <p className="passkey-empty">불러오는 중…</p>
          ) : subscriptions.length === 0 ? (
            <p className="passkey-empty">아직 등록된 알림 기기가 없습니다.</p>
          ) : (
            <ul>
              {subscriptions.map((subscription) => {
                const current = subscription.endpointFingerprint === currentFingerprint;
                return (
                  <li key={subscription.id}>
                    <div>
                      <strong>
                        {subscription.name}
                        {current ? " · 현재 기기" : ""}
                      </strong>
                      <span>
                        ID {subscription.endpointFingerprint.slice(0, 12)} · 등록{" "}
                        {formatDate(subscription.createdAt)}
                        {subscription.updatedAt === subscription.createdAt
                          ? ""
                          : ` · 갱신 ${formatDate(subscription.updatedAt)}`}
                      </span>
                    </div>
                    <div className="passkey-actions">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void rename(subscription)}
                      >
                        이름 변경
                      </button>
                      <button
                        className="danger"
                        type="button"
                        disabled={busy}
                        onClick={() => void remove(subscription)}
                      >
                        {current ? "해지" : "삭제"}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

interface ProjectSidebarProps {
  open: boolean;
  previewOpen: boolean;
  overlay: boolean;
  hoverExpand: boolean;
  api: NaruApi;
  groups: ProjectGroup[];
  projectRoots: readonly string[];
  selectedProjectId: string | null;
  focusTarget: SidebarFocusTarget;
  mutationAllowed: boolean;
  onSelect: (id: string) => void;
  onCreated: (project: Project) => Promise<void>;
  onChanged: () => Promise<Project[]>;
  onRefresh: () => Promise<Project[]>;
  onDeleted: (id: string) => void;
  onBeforeDelete: () => Promise<boolean>;
  onError: (message: string | null) => void;
  onOpen: () => void;
  onClose: () => void;
  onPreviewOpen: () => void;
  onPreviewClose: () => void;
}

function ProjectSidebar(props: ProjectSidebarProps): React.JSX.Element {
  const [adding, setAdding] = useState(false);
  const [path, setPath] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const wasOpenRef = useRef(props.open);
  const showForm = adding || props.groups.length === 0;
  const expanded = props.open || (props.hoverExpand && props.previewOpen);
  const toggleLabel = props.overlay
    ? "프로젝트 메뉴 닫기"
    : props.open
      ? "프로젝트 메뉴 접기"
      : "프로젝트 메뉴 펼치기 고정";

  useEffect(() => {
    const justOpened = props.open && !wasOpenRef.current;
    wasOpenRef.current = props.open;
    if (!justOpened || !props.overlay) return;
    focusSoon(() => {
      if (props.focusTarget === "selected-action" && props.selectedProjectId) {
        return document.getElementById(projectRemoveButtonId(props.selectedProjectId));
      }
      if (props.focusTarget === "project-form") return document.getElementById("project-path");
      return closeButtonRef.current;
    });
  }, [props.focusTarget, props.open, props.overlay, props.selectedProjectId]);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!props.mutationAllowed) return;
    setBusy(true);
    props.onError(null);
    try {
      const project = await props.api.createProject(path, name.trim() || undefined);
      setPath("");
      setName("");
      setAdding(false);
      await props.onCreated(project);
    } catch (error) {
      props.onError(messageFrom(error));
    } finally {
      setBusy(false);
    }
  };

  const rename = async (group: ProjectGroup, trigger: HTMLButtonElement): Promise<void> => {
    const nextName = window.prompt("프로젝트 그룹 이름", group.name)?.trim();
    if (nextName && nextName !== group.name) {
      props.onError(null);
      try {
        await props.api.renameProjectGroup(group.id, nextName);
        await props.onChanged();
      } catch (error) {
        props.onError(messageFrom(error));
      }
    }
    focusSoon(() => (trigger.isConnected ? trigger : null));
  };

  const connect = async (
    group: ProjectGroup,
    target: ProjectGroup["targets"][number],
    trigger: HTMLButtonElement,
  ): Promise<void> => {
    if (target.registration !== "discovered" || !props.mutationAllowed) return;
    setBusy(true);
    props.onError(null);
    try {
      const project = await props.api.connectProjectTarget(group.id, target.path);
      await props.onCreated(project);
    } catch (error) {
      props.onError(messageFrom(error));
      focusSoon(() => (trigger.isConnected ? trigger : null));
    } finally {
      setBusy(false);
    }
  };

  const refresh = async (trigger: HTMLButtonElement): Promise<void> => {
    setBusy(true);
    props.onError(null);
    try {
      await props.onRefresh();
    } catch (error) {
      props.onError(messageFrom(error));
    } finally {
      setBusy(false);
      focusSoon(() => (trigger.isConnected ? trigger : null));
    }
  };

  const openProjectForm = (): void => {
    if (!props.mutationAllowed) return;
    if (!props.open) props.onOpen();
    setAdding(true);
  };

  const enterGroup = (group: ProjectGroup): void => {
    const action = resolveProjectGroupEntry(group, props.selectedProjectId, props.open);
    if (action.kind === "none") return;
    if (action.kind === "select-target") {
      props.onSelect(action.projectId);
      return;
    }

    setCollapsedGroups((current) => {
      if (!current.has(group.id)) return current;
      const next = new Set(current);
      next.delete(group.id);
      return next;
    });
    props.onOpen();
    focusSoon(() => document.getElementById(projectTargetButtonId(action.focusProjectId)));
  };

  const toggleGroup = (groupId: string): void => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  };

  const remove = async (project: Project, trigger: HTMLButtonElement): Promise<void> => {
    if (!props.mutationAllowed) return;
    if (
      !window.confirm(
        `${project.name}을 Naru 목록에서 제거할까요? 디스크의 파일은 삭제되지 않습니다.`,
      )
    ) {
      focusSoon(() => (trigger.isConnected ? trigger : null));
      return;
    }
    if (!(await props.onBeforeDelete())) {
      focusSoon(() => (trigger.isConnected ? trigger : null));
      return;
    }
    props.onError(null);
    try {
      await props.api.deleteProject(project.id);
      props.onDeleted(project.id);
      const next = await props.onChanged();
      if (next[0]) props.onSelect(next[0].id);
      else focusSoon(() => document.getElementById("project-path"));
    } catch (error) {
      props.onError(messageFrom(error));
      focusSoon(() => (trigger.isConnected ? trigger : null));
    }
  };

  return (
    <aside
      id="project-sidebar"
      className={`sidebar ${expanded ? "is-open" : ""} ${props.overlay ? "is-overlay" : "is-rail"}`}
      aria-label="프로젝트 메뉴"
      aria-hidden={props.overlay && !props.open}
      data-presentation={props.overlay ? "overlay" : "rail"}
      data-expand-trigger={props.overlay ? "overlay" : props.hoverExpand ? "hover" : "click"}
      data-open-mode={props.open ? "pinned" : props.previewOpen ? "preview" : "closed"}
      onPointerEnter={(event) => {
        if (props.hoverExpand && event.pointerType !== "touch") props.onPreviewOpen();
      }}
      onPointerLeave={(event) => {
        if (props.hoverExpand && !event.currentTarget.contains(document.activeElement)) {
          props.onPreviewClose();
        }
      }}
      onFocusCapture={(event) => {
        if (props.hoverExpand && event.target !== closeButtonRef.current) props.onPreviewOpen();
      }}
      onBlurCapture={(event) => {
        if (props.hoverExpand && !event.currentTarget.contains(event.relatedTarget)) {
          props.onPreviewClose();
        }
      }}
      onKeyDown={(event) => {
        if (expanded && event.key === "Escape") {
          event.preventDefault();
          props.onClose();
        }
      }}
    >
      <div className="sidebar-heading">
        <div>
          <span>PROJECTS</span>
          <span className="count-badge">{props.groups.length}</span>
        </div>
        <button
          ref={closeButtonRef}
          id="project-sidebar-toggle"
          className="sidebar-close"
          type="button"
          onClick={props.open ? props.onClose : props.onOpen}
          aria-label={toggleLabel}
          aria-controls="project-sidebar"
          aria-expanded={expanded}
          title={toggleLabel}
        >
          <span aria-hidden="true">
            {props.overlay ? "×" : props.open ? "‹" : props.previewOpen ? "⌖" : "›"}
          </span>
        </button>
      </div>
      <nav className="project-list" aria-label="프로젝트 그룹과 작업 폴더">
        {props.groups.map((group) => {
          const collapsed = collapsedGroups.has(group.id);
          const groupActive = group.targets.some(
            (target) =>
              target.registration === "connected" && target.projectId === props.selectedProjectId,
          );
          if (group.kind === "standalone" || group.targets.length === 1) {
            const target = group.targets[0];
            if (!target || target.registration !== "connected") return null;
            const project = projectFromTarget(group, target);
            return (
              <div
                key={group.id}
                className={`project-row ${project.id === props.selectedProjectId ? "active" : ""}`}
              >
                <ProjectTargetButton group={group} target={target} onSelect={props.onSelect} />
                <button
                  className="project-more"
                  type="button"
                  onClick={(event) => void rename(group, event.currentTarget)}
                  aria-label={`${group.name} 이름 변경`}
                >
                  ···
                </button>
                <button
                  id={projectRemoveButtonId(project.id)}
                  className="project-remove"
                  type="button"
                  onClick={(event) => void remove(project, event.currentTarget)}
                  aria-label={`${group.name} 제거`}
                  disabled={!props.mutationAllowed}
                >
                  ×
                </button>
              </div>
            );
          }
          return (
            <section className="project-group" data-kind="git" key={group.id}>
              <div className={`project-row project-group-row ${groupActive ? "active" : ""}`}>
                <button
                  className="project-main project-group-main"
                  type="button"
                  onMouseDown={() => enterGroup(group)}
                  onClick={(event) => {
                    if (event.detail === 0) enterGroup(group);
                  }}
                  aria-label={`${group.name} Git 프로젝트, 작업 상태 ${activityLabel(group.activity.state)}`}
                  title={`${group.name} · ${activityLabel(group.activity.state)}`}
                >
                  <span className="project-status-icon">
                    <ActivityStatus
                      state={group.activity.state}
                      interactionRequiredCount={group.activity.interactionRequiredCount}
                      context={`${group.name} 프로젝트 그룹 상태`}
                    />
                  </span>
                  <span className="project-text">
                    <span className="project-title-line">
                      <strong title={group.name}>{group.name}</strong>
                    </span>
                    <small>{projectGroupSummary(group)}</small>
                  </span>
                </button>
                <button
                  className="project-disclosure-button"
                  type="button"
                  onClick={() => toggleGroup(group.id)}
                  aria-expanded={!collapsed}
                  aria-label={`${group.name} 작업 폴더 ${collapsed ? "펼치기" : "접기"}`}
                >
                  <span aria-hidden="true">{collapsed ? "›" : "⌄"}</span>
                </button>
                <button
                  className="project-more"
                  type="button"
                  onClick={(event) => void rename(group, event.currentTarget)}
                  aria-label={`${group.name} 그룹 이름 변경`}
                >
                  ···
                </button>
              </div>
              {!collapsed && (
                <div className="project-target-list">
                  {group.targets.map((target) =>
                    target.registration === "connected" ? (
                      <div
                        key={target.path}
                        className={`project-row project-target-row ${
                          target.projectId === props.selectedProjectId ? "active" : ""
                        }`}
                      >
                        <ProjectTargetButton
                          group={group}
                          target={target}
                          onSelect={props.onSelect}
                          nested
                        />
                        <button
                          id={projectRemoveButtonId(target.projectId)}
                          className="project-remove"
                          type="button"
                          onClick={(event) =>
                            void remove(projectFromTarget(group, target), event.currentTarget)
                          }
                          aria-label={`${projectTitle(group, target)} 제거`}
                          disabled={!props.mutationAllowed}
                        >
                          ×
                        </button>
                      </div>
                    ) : (
                      <div key={target.path} className="project-row project-target-row discovered">
                        <div className="project-main project-discovered-main">
                          <span className="project-status-icon" aria-hidden="true">
                            +
                          </span>
                          <span className="project-text">
                            <span className="project-title-line">
                              <strong title={target.label}>{target.label}</strong>
                              <span className="target-registration">발견됨</span>
                            </span>
                            <small title={target.path}>{target.path}</small>
                          </span>
                        </div>
                        <button
                          className="connect-target-button"
                          type="button"
                          disabled={busy || !props.mutationAllowed}
                          onClick={(event) => void connect(group, target, event.currentTarget)}
                          aria-label={`${target.label}을 Naru에 연결`}
                        >
                          연결
                        </button>
                      </div>
                    ),
                  )}
                </div>
              )}
            </section>
          );
        })}
        {props.groups.length === 0 && (
          <div className="project-list-empty">아직 연결한 프로젝트가 없습니다.</div>
        )}
      </nav>

      {props.open && props.groups.length > 0 && (
        <button
          className="refresh-projects-button"
          type="button"
          disabled={busy}
          onClick={(event) => void refresh(event.currentTarget)}
        >
          <span aria-hidden="true">↻</span> 작업 폴더 새로고침
        </button>
      )}

      {showForm && expanded ? (
        <form className="project-form" onSubmit={(event) => void submit(event)}>
          <div className="project-form-title">
            <strong>프로젝트 연결</strong>
            {props.groups.length > 0 && (
              <button type="button" onClick={() => setAdding(false)} aria-label="폼 닫기">
                ×
              </button>
            )}
          </div>
          <label htmlFor="project-path">서버 절대 경로</label>
          <div id="project-path-guidance" className="project-root-guidance">
            <span>{PROJECT_ROOTS_LABEL}</span>
            <ul>
              {props.projectRoots.map((root) => (
                <li key={root}>
                  <code>{root}</code>
                </li>
              ))}
            </ul>
            <p>{PROJECT_ROOTS_INSTRUCTION}</p>
          </div>
          <input
            id="project-path"
            value={path}
            onChange={(event) => setPath(event.target.value)}
            placeholder={PROJECT_PATH_PLACEHOLDER}
            aria-describedby="project-path-guidance"
            required
            autoFocus
            disabled={!props.mutationAllowed}
          />
          <label htmlFor="project-name">
            표시 이름 <span>선택</span>
          </label>
          <input
            id="project-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="폴더 이름 사용"
            disabled={!props.mutationAllowed}
          />
          <button
            className="primary-button compact"
            type="submit"
            disabled={busy || !props.mutationAllowed}
          >
            {busy ? "확인 중…" : "연결하기"}
          </button>
        </form>
      ) : (
        <button
          className="add-project-button"
          type="button"
          aria-label="프로젝트 연결"
          title={props.open ? undefined : "프로젝트 연결"}
          disabled={!props.mutationAllowed}
          onMouseDown={openProjectForm}
          onClick={openProjectForm}
        >
          <span aria-hidden="true">＋</span>
          <span className="add-project-label">프로젝트 연결</span>
        </button>
      )}
      <div className="sidebar-footer">
        <span className="server-dot" />
        <span className="sidebar-footer-label">Mac mini · Local</span>
      </div>
    </aside>
  );
}

function ProjectTargetButton({
  group,
  target,
  onSelect,
  nested = false,
}: {
  group: ProjectGroup;
  target: ConnectedProjectTarget;
  onSelect: (id: string) => void;
  nested?: boolean;
}): React.JSX.Element {
  const label = nested ? target.label : group.name;
  return (
    <button
      id={projectTargetButtonId(target.projectId)}
      className="project-main"
      type="button"
      onMouseDown={() => onSelect(target.projectId)}
      onClick={(event) => {
        if (event.detail === 0) onSelect(target.projectId);
      }}
      aria-label={`${label}, 작업 상태 ${activityLabel(target.activity.state)}`}
      title={`${label} · ${activityLabel(target.activity.state)}`}
    >
      <span className="project-status-icon">
        <ActivityStatus
          state={target.activity.state}
          interactionRequiredCount={target.activity.interactionRequiredCount}
          context={`${label} 작업 폴더 상태`}
        />
      </span>
      <span className="project-text">
        <span className="project-title-line">
          <strong title={label}>{label}</strong>
          <ActivityStatus
            state={target.activity.state}
            interactionRequiredCount={target.activity.interactionRequiredCount}
            context={`${label} 작업 폴더 상태`}
            showText
            className="project-status-text"
          />
        </span>
        <small title={target.path}>
          {target.availability === "ready"
            ? target.path
            : `${targetAvailabilityLabel(target.availability)} · ${target.path}`}
        </small>
      </span>
    </button>
  );
}

function WorkspaceEmpty({
  icon,
  title,
  description,
  actionLabel,
  onAction,
  actionDisabled = false,
}: {
  icon: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  actionDisabled?: boolean;
}): React.JSX.Element {
  return (
    <section className="workspace-empty">
      <div className="empty-icon" aria-hidden="true">
        {icon}
      </div>
      <h2>{title}</h2>
      <p>{description}</p>
      <button className="primary-button" type="button" onClick={onAction} disabled={actionDisabled}>
        {actionLabel}
        <span aria-hidden="true">→</span>
      </button>
    </section>
  );
}

function WorkspaceUnavailable({
  issue,
  onRetry,
  onManageProject,
}: {
  issue: WorkspaceIssue;
  onRetry: () => void;
  onManageProject: () => void;
}): React.JSX.Element {
  const copy = workspaceIssueCopy(issue);
  return (
    <section
      className="workspace-empty workspace-unavailable"
      aria-labelledby="workspace-unavailable-title"
      aria-describedby="workspace-unavailable-description"
    >
      <div className="empty-icon" aria-hidden="true">
        !
      </div>
      <h2 id="workspace-unavailable-title" tabIndex={-1}>
        {copy.title}
      </h2>
      <p id="workspace-unavailable-description">{copy.description}</p>
      <p className="error-detail">{issue.message}</p>
      {issue.requestId && <RequestId value={issue.requestId} />}
      <div className="empty-actions">
        <button className="primary-button" type="button" onClick={onRetry}>
          다시 시도
        </button>
        <button className="secondary-button" type="button" onClick={onManageProject}>
          프로젝트 관리
        </button>
      </div>
    </section>
  );
}

function ServiceUnavailableScreen({
  issue,
  onRetry,
}: {
  issue: StartupIssue;
  onRetry: () => void;
}): React.JSX.Element {
  return (
    <main className="service-screen">
      <section className="service-card" aria-labelledby="service-unavailable-title">
        <span className="brand-mark large" aria-hidden="true" />
        <div className="eyebrow">CONNECTION REQUIRED</div>
        <h1 id="service-unavailable-title">Naru 서버에 연결할 수 없습니다</h1>
        <p>{issue.message}</p>
        {issue.requestId && <RequestId value={issue.requestId} />}
        <button className="primary-button" type="button" onClick={onRetry} autoFocus>
          다시 시도
        </button>
      </section>
    </main>
  );
}

function RequestId({ value }: { value: string }): React.JSX.Element {
  return (
    <p className="request-id">
      문의용 요청 ID <code>{value}</code>
    </p>
  );
}

function TopbarMenu({
  connectionStatus,
  canCreateTerminal,
  canChooseWorkspaceView,
  workspaceViewMode,
  screenReaderMode,
  terminalInputToolsAlways,
  canManagePasskeys,
  onCreateTerminal,
  onOpenFiles,
  onOpenDocs,
  onOpenTasks,
  onWorkspaceViewChange,
  onToggleScreenReaderMode,
  onToggleTerminalInputToolsMode,
  onManagePasskeys,
  onManagePushNotifications,
  onSignOut,
}: {
  connectionStatus: ConnectionSnapshot;
  canCreateTerminal: boolean;
  canChooseWorkspaceView: boolean;
  workspaceViewMode: WorkspaceViewMode;
  screenReaderMode: boolean;
  terminalInputToolsAlways: boolean;
  canManagePasskeys: boolean;
  onCreateTerminal: () => void;
  onOpenFiles: () => void;
  onOpenDocs: () => void;
  onOpenTasks: () => void;
  onWorkspaceViewChange: (mode: WorkspaceViewMode) => void;
  onToggleScreenReaderMode: () => void;
  onToggleTerminalInputToolsMode: () => void;
  onManagePasskeys: () => void;
  onManagePushNotifications: () => void;
  onSignOut: () => void;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;

    const closeOnOutsidePress = (event: PointerEvent): void => {
      if (event.target instanceof Node && !containerRef.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const closeOnEscape = (event: globalThis.KeyboardEvent): void => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      focusSoon(() => triggerRef.current);
    };

    document.addEventListener("pointerdown", closeOnOutsidePress);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePress);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const runAction = (action: () => void, restoreFocus: boolean): void => {
    setOpen(false);
    action();
    if (restoreFocus) focusSoon(() => triggerRef.current);
  };

  return (
    <div ref={containerRef} className="topbar-menu">
      <button
        ref={triggerRef}
        className="topbar-menu-trigger"
        type="button"
        aria-label={open ? "작업공간 메뉴 닫기" : "작업공간 메뉴 열기"}
        aria-controls="topbar-menu-panel"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span aria-hidden="true">•••</span>
      </button>
      {open && (
        <div
          id="topbar-menu-panel"
          className="topbar-menu-panel"
          role="group"
          aria-label="작업공간 메뉴"
        >
          <div className="topbar-menu-status">
            <span>터미널 상태</span>
            <ConnectionBadge snapshot={connectionStatus} />
          </div>
          {canCreateTerminal && (
            <>
              <button
                className="topbar-menu-action"
                type="button"
                onClick={() => runAction(onCreateTerminal, false)}
              >
                <span aria-hidden="true">＋</span>
                <span>새 터미널</span>
              </button>
              <button
                className="topbar-menu-action"
                type="button"
                onClick={() => runAction(onOpenFiles, false)}
              >
                <span aria-hidden="true">◇</span>
                <span>Files Pane</span>
              </button>
              <button
                className="topbar-menu-action"
                type="button"
                onClick={() => runAction(onOpenDocs, false)}
              >
                <span aria-hidden="true">▤</span>
                <span>Docs Pane</span>
              </button>
              <button
                className="topbar-menu-action"
                type="button"
                onClick={() => runAction(onOpenTasks, false)}
              >
                <span aria-hidden="true">✓</span>
                <span>Tasks Pane</span>
              </button>
            </>
          )}
          {canChooseWorkspaceView && (
            <div className="topbar-menu-section">
              <span className="topbar-menu-label">보기 방식</span>
              <WorkspaceViewControl
                mode={workspaceViewMode}
                onChange={(mode) => runAction(() => onWorkspaceViewChange(mode), true)}
              />
            </div>
          )}
          <div className="topbar-menu-divider" />
          <button
            className="topbar-menu-action"
            type="button"
            aria-label={`입력 도우미: ${terminalInputToolsAlways ? "항상" : "자동"}`}
            aria-pressed={terminalInputToolsAlways}
            onClick={() => runAction(onToggleTerminalInputToolsMode, true)}
          >
            <span aria-hidden="true">⌨</span>
            <span>입력 도우미</span>
            <span className="topbar-menu-action-state">
              {terminalInputToolsAlways ? "항상" : "자동"}
            </span>
          </button>
          <button
            className="topbar-menu-action"
            type="button"
            aria-label="스크린 리더 모드"
            aria-pressed={screenReaderMode}
            onClick={() => runAction(onToggleScreenReaderMode, true)}
          >
            <span aria-hidden="true">◉</span>
            <span>스크린 리더</span>
            <span className="topbar-menu-action-state">{screenReaderMode ? "켜짐" : "꺼짐"}</span>
          </button>
          {canManagePasskeys && (
            <button
              className="topbar-menu-action"
              type="button"
              onClick={() => {
                triggerRef.current?.focus();
                runAction(onManagePasskeys, false);
              }}
            >
              <span aria-hidden="true">◇</span>
              <span>패스키 관리</span>
            </button>
          )}
          <button
            className="topbar-menu-action"
            type="button"
            onClick={() => {
              triggerRef.current?.focus();
              runAction(onManagePushNotifications, false);
            }}
          >
            <span aria-hidden="true">◌</span>
            <span>알림 관리</span>
          </button>
          <button
            className="topbar-menu-action danger"
            type="button"
            onClick={() => runAction(onSignOut, false)}
          >
            <span aria-hidden="true">↗</span>
            <span>로그아웃</span>
          </button>
        </div>
      )}
    </div>
  );
}

function ConnectionBadge({ snapshot }: { snapshot: ConnectionSnapshot }): React.JSX.Element {
  const labels: Record<ConnectionSnapshot["state"], string> = {
    active: "연결됨",
    connecting: "연결 중",
    disconnected: "재연결 중",
    revoked: "보기 전용",
    "authentication-required": "로그인 필요",
  };
  const label =
    snapshot.state === "active" && snapshot.surfaceRole === "observer"
      ? "보기 전용"
      : labels[snapshot.state];
  return (
    <span
      className={`connection-badge connection-${snapshot.state}`}
      title={snapshot.message}
      data-acquisition={snapshot.acquisition ?? "none"}
      role="status"
      aria-live="polite"
      aria-label={`터미널 연결 상태: ${label}`}
    >
      <span aria-hidden="true" />
      {label}
    </span>
  );
}

function PaneTabs({
  panes,
  layout,
  activePaneId,
  onActivate,
}: {
  panes: Pane[];
  layout: LayoutNode | null;
  activePaneId: string | null;
  onActivate: (paneId: string) => void;
}): React.JSX.Element {
  const tabs = useRef(new Map<string, HTMLButtonElement>());
  const visiblePanes = panes.filter((pane) => !isPaneCollapsed(layout, pane.id));
  const collapsedPanes = panes.filter((pane) => isPaneCollapsed(layout, pane.id));

  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number): void => {
    let nextIndex: number | undefined;
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      nextIndex = (index + 1) % visiblePanes.length;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      nextIndex = (index - 1 + visiblePanes.length) % visiblePanes.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = visiblePanes.length - 1;
    }
    if (nextIndex === undefined) return;
    const next = visiblePanes[nextIndex];
    if (!next) return;
    event.preventDefault();
    onActivate(next.id);
    tabs.current.get(next.id)?.focus();
  };

  return (
    <div className="pane-tabs">
      <div className="visible-pane-tabs" role="tablist" aria-label="열린 Pane">
        {visiblePanes.map((pane, index) => {
          const selected = pane.id === activePaneId;
          return (
            <button
              key={pane.id}
              ref={(element) => {
                if (element) tabs.current.set(pane.id, element);
                else tabs.current.delete(pane.id);
              }}
              id={paneTabId(pane.id)}
              type="button"
              role="tab"
              aria-controls={panePanelId(pane.id)}
              aria-selected={selected}
              tabIndex={selected ? 0 : -1}
              className={selected ? "active" : ""}
              onClick={() => onActivate(pane.id)}
              onKeyDown={(event) => move(event, index)}
            >
              <span aria-hidden="true">{paneKindIcon(pane.kind)}</span> {pane.title}
            </button>
          );
        })}
      </div>
      {collapsedPanes.length > 0 && (
        <div className="collapsed-pane-list" aria-label="접은 Pane">
          {collapsedPanes.map((pane) => (
            <button
              key={pane.id}
              type="button"
              className="collapsed-pane-button"
              onClick={() => {
                onActivate(pane.id);
                focusPaneSurfaceSoon(pane.id);
              }}
              aria-label={`${pane.title} 펼치기, 작업 상태 ${activityLabel(pane.activity.state)}`}
              title={`${pane.title} 펼치기`}
            >
              <span aria-hidden="true">＋</span>
              {pane.title}
              {(pane.kind === "codex" ||
                pane.kind === "claude" ||
                pane.activity.state === "failed") && (
                <ActivityStatus state={pane.activity.state} context={`${pane.title} 작업 상태`} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceViewControl({
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

/** Workspace or agents, and how many things wait for the person on the agent screen. */
function MainViewTabs({
  view,
  waiting,
  onChange,
  className = "main-view-tabs",
}: {
  view: "workspace" | "agents";
  waiting: number;
  onChange: (view: "workspace" | "agents") => void;
  className?: string;
}): React.JSX.Element {
  return (
    <div className={className}>
      <div className="main-view-switch" role="group" aria-label="화면">
        <button
          type="button"
          aria-pressed={view === "workspace"}
          onClick={() => onChange("workspace")}
        >
          작업공간
        </button>
        <button type="button" aria-pressed={view === "agents"} onClick={() => onChange("agents")}>
          에이전트
        </button>
      </div>
      {waiting > 0 && (
        <button
          className="agent-waiting-pill"
          type="button"
          aria-label={`나를 기다리는 것 ${waiting}개 보기`}
          onClick={() => onChange("agents")}
        >
          <span aria-hidden="true" />
          나를 기다림 {waiting}
        </button>
      )}
    </div>
  );
}

function paneTabId(paneId: string): string {
  return `pane-tab-${paneId}`;
}

function paneKindIcon(kind: PaneKind): string {
  switch (kind) {
    case "codex":
      return "✦";
    case "claude":
      return "◆";
    case "terminal":
      return ">_";
    case "files":
      return "◇";
    case "docs":
      return "▤";
    case "tasks":
      return "✓";
  }
}

function panePanelId(paneId: string): string {
  return `pane-panel-${paneId}`;
}

function AppLoading(): React.JSX.Element {
  return (
    <main className="app-loading" aria-busy="true" aria-live="polite">
      <span className="brand-mark large" aria-hidden="true" />
      <div className="loading-line">
        <span />
      </div>
      <p>작업공간을 확인하는 중</p>
    </main>
  );
}

function connectedProjects(groups: readonly ProjectGroup[]): Project[] {
  return groups.flatMap((group) =>
    group.targets.flatMap((target) =>
      target.registration === "connected" ? [projectFromTarget(group, target)] : [],
    ),
  );
}

function projectFromTarget(group: ProjectGroup, target: ConnectedProjectTarget): Project {
  return {
    id: target.projectId,
    name: projectTitle(group, target),
    path: target.path,
    activity: target.activity,
    createdAt: target.createdAt,
    updatedAt: target.updatedAt,
  };
}

function projectTitle(group: ProjectGroup, target: ConnectedProjectTarget): string {
  if (group.kind === "standalone" || group.targets.length === 1) return group.name;
  if (target.git === null) return target.label;
  if (target.git.kind === "bare" || target.git.role === "primary") return group.name;
  return `${group.name} · ${target.label}`;
}

function findConnectedProjectTarget(
  groups: readonly ProjectGroup[],
  projectId: string | null,
): { group: ProjectGroup; target: ConnectedProjectTarget } | null {
  if (projectId === null) return null;
  for (const group of groups) {
    const target = group.targets.find(
      (candidate): candidate is ConnectedProjectTarget =>
        candidate.registration === "connected" && candidate.projectId === projectId,
    );
    if (target) return { group, target };
  }
  return null;
}

function updateProjectGroupActivity(
  groups: readonly ProjectGroup[],
  projectId: string,
  activity: ProjectActivity,
): ProjectGroup[] {
  return groups.map((group) => {
    if (
      !group.targets.some(
        (target) => target.registration === "connected" && target.projectId === projectId,
      )
    ) {
      return group;
    }
    const targets = group.targets.map((target) =>
      target.registration === "connected" && target.projectId === projectId
        ? { ...target, activity }
        : target,
    );
    return {
      ...group,
      targets,
      activity: aggregateProjectActivity(
        targets.flatMap((target) => (target.registration === "connected" ? [target.activity] : [])),
      ),
    };
  });
}

function aggregateProjectActivity(activities: readonly ProjectActivity[]): ProjectActivity {
  const state = activities.reduce<ProjectActivity["state"]>(
    (highest, activity) =>
      projectActivityPriority(activity.state) > projectActivityPriority(highest)
        ? activity.state
        : highest,
    "idle",
  );
  const updatedAt =
    activities
      .filter((activity) => activity.state === state && activity.updatedAt !== null)
      .map((activity) => activity.updatedAt!)
      .sort()
      .at(-1) ?? null;
  return {
    state,
    interactionRequiredCount: activities.reduce(
      (count, activity) => count + activity.interactionRequiredCount,
      0,
    ),
    updatedAt,
  };
}

function projectActivityPriority(state: ProjectActivity["state"]): number {
  switch (state) {
    case "interaction-required":
      return 7;
    case "failed":
      return 6;
    case "completed":
      return 5;
    case "server-stopped":
      return 4;
    case "canceled":
      return 3;
    case "running":
      return 2;
    case "idle":
      return 1;
  }
}

function projectGroupSummary(group: ProjectGroup): string {
  const connected = group.targets.filter((target) => target.registration === "connected").length;
  const discovered = group.targets.length - connected;
  return discovered > 0 ? `작업 폴더 ${connected} · 발견 ${discovered}` : `작업 폴더 ${connected}`;
}

function targetAvailabilityLabel(availability: ConnectedProjectTarget["availability"]): string {
  switch (availability) {
    case "ready":
      return "사용 가능";
    case "missing":
      return "폴더 없음";
    case "permission-denied":
      return "권한 필요";
    case "outside-root":
      return "허용 범위 밖";
    case "invalid":
      return "Git 상태 확인 불가";
  }
}

function messageFrom(error: unknown): string {
  if (error instanceof ApiFailure || error instanceof Error) return error.message;
  return "요청을 처리하지 못했습니다.";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("ko-KR", { dateStyle: "medium" }).format(new Date(value));
}

function startupIssueFrom(error: unknown): StartupIssue {
  if (error instanceof ApiFailure) {
    return {
      message:
        error.code === "NETWORK_UNAVAILABLE"
          ? "서버가 실행 중인지와 이 기기의 네트워크 연결을 확인한 뒤 다시 시도해 주세요."
          : `${error.message} 잠시 후 다시 시도해 주세요.`,
      ...(error.requestId === undefined ? {} : { requestId: error.requestId }),
    };
  }
  return {
    message: "서버가 실행 중인지 확인한 뒤 다시 시도해 주세요.",
  };
}

function workspaceIssueCopy(issue: WorkspaceIssue): {
  title: string;
  description: string;
} {
  switch (issue.code) {
    case "PROJECT_MISSING":
      return {
        title: "프로젝트 폴더를 찾을 수 없습니다",
        description:
          "Mac mini에서 폴더를 원래 경로로 복구한 뒤 다시 시도하거나, 더 이상 쓰지 않는 프로젝트를 목록에서 제거해 주세요.",
      };
    case "PROJECT_PERMISSION_DENIED":
      return {
        title: "프로젝트 폴더 권한이 필요합니다",
        description:
          "Mac mini에서 Naru가 폴더를 읽고 탐색할 수 있도록 권한을 복구한 뒤 다시 시도하거나 프로젝트를 제거해 주세요.",
      };
    case "NETWORK_UNAVAILABLE":
      return {
        title: "작업공간 서버에 연결할 수 없습니다",
        description: "서버 상태와 네트워크 연결을 확인한 뒤 다시 시도해 주세요.",
      };
    default:
      return {
        title: "작업공간을 열지 못했습니다",
        description:
          "오류 내용을 확인하고 다시 시도해 주세요. 문제가 계속되면 요청 ID로 서버 로그를 확인할 수 있습니다.",
      };
  }
}

function createPaneRequest(
  kind: PaneKind,
  workspaceVersion: number,
  targetPaneId: string | null,
  direction: SplitDirection,
  selectedDocumentPath?: string,
): CreatePaneRequest {
  const base = { workspaceVersion, targetPaneId, direction };
  switch (kind) {
    case "terminal":
      return { kind, ...base };
    case "codex":
      return { kind, ...base };
    case "claude":
      return { kind, ...base };
    case "files":
      return { kind, ...base, ...(selectedDocumentPath ? { selectedDocumentPath } : {}) };
    case "docs":
      return { kind, ...base, ...(selectedDocumentPath ? { selectedDocumentPath } : {}) };
    case "tasks":
      return { kind, ...base, ...(selectedDocumentPath ? { selectedDocumentPath } : {}) };
  }
}

function focusPaneSoon(paneId: string): void {
  focusSoon(
    () =>
      document.getElementById(paneTabId(paneId)) ?? document.getElementById(panePanelId(paneId)),
  );
}

function focusPaneSurfaceSoon(paneId: string): void {
  focusSoon(() => document.getElementById(panePanelId(paneId)));
}

function focusWorkspaceResultSoon(
  loaded: boolean,
  titleRef: React.RefObject<HTMLHeadingElement | null>,
): void {
  focusSoon(() =>
    loaded ? titleRef.current : document.getElementById("workspace-unavailable-title"),
  );
}

function focusSoon(resolve: () => HTMLElement | null): void {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => resolve()?.focus());
  });
}

function projectRemoveButtonId(projectId: string): string {
  return `project-remove-${projectId}`;
}

function projectTargetButtonId(projectId: string): string {
  return `project-target-${projectId}`;
}
