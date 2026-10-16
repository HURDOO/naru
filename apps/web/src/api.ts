import {
  ApiErrorSchema,
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
  type ErrorCode,
  type CreatePaneRequest,
  type CreateWorkspaceViewPaneRequest,
  type CreateWorkspaceViewRequest,
  type DocumentCatalog,
  type DocumentContent,
  type FileDraft,
  type Pane,
  type PaneViewState,
  type Passkey,
  type NaruPushSubscription,
  type Project,
  type ProjectDirectoryListing,
  type ProjectFileContent,
  type ProjectGroup,
  type PushConfiguration,
  type SaveWorkspaceRequest,
  type SaveWorkspaceViewRequest,
  type SaveFileDraftRequest,
  type SaveProjectFileRequest,
  type SessionResponse,
  type TerminalRestoreProtocol,
  type Workspace,
} from "@naru/contracts";
import {
  GatewayBrowserFailureResponseV1Schema,
  WORKSTATION_GATEWAY_CSRF_HEADER,
} from "@naru/contracts/workstation-gateway/v1";
import type {
  StartAuthenticationOpts,
  StartRegistrationOpts,
  startAuthentication,
  startRegistration,
} from "@simplewebauthn/browser";
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentOverview,
  AgentRuntimeState,
  AgentSession,
  AgentTask,
  AgentTaskDetail,
  Handoff,
  Instruction,
  InstructionScope,
  IntentContract,
  Plan,
  SharedProcess,
} from "@naru/contracts/naru-agent/v1";
import { currentAppPath } from "./app-base-path";
import { isCurrentPwaOriginConsistent } from "./pwa";

type AuthenticationOptions = StartAuthenticationOpts["optionsJSON"];
type RegistrationOptions = StartRegistrationOpts["optionsJSON"];
type AuthenticationResponse = Awaited<ReturnType<typeof startAuthentication>>;
type RegistrationResponse = Awaited<ReturnType<typeof startRegistration>>;

/** One project as the agent screen shows it (`GET /api/agent/projects/:id`). */
export interface AgentProjectView {
  readonly intentContract: IntentContract | null;
  /** A newer proposal the user has not approved yet. */
  readonly pendingIntentContract: IntentContract | null;
  readonly activePlan: Plan | null;
  readonly tasks: AgentTask[];
  readonly openHandoffs: Handoff[];
  readonly agents: AgentSession[];
  readonly instructions: Instruction[];
  readonly processes: SharedProcess[];
  /** What managed agents wait for the person to allow (AP-D017). */
  readonly pendingApprovals: AgentPendingApproval[];
}

export interface AgentPendingApproval {
  readonly agentSessionId: string;
  readonly requestId: string;
  readonly kind: string;
  readonly summary?: string;
  /** The runtime can allow this kind of call for the rest of the session (AP-D023). */
  readonly sessionAllow?: boolean;
}

/** One project on the control room board: the project view without instruction text. */
export interface AgentBoardProject extends Omit<AgentProjectView, "instructions"> {
  readonly projectId: string;
}

/** Every project with agent work in one read (`GET /api/agent/board`, AP-D022). */
export interface AgentBoard {
  readonly projects: AgentBoardProject[];
  readonly globalAgents: AgentSession[];
  /** Open handoffs of every project and the global ones. */
  readonly openHandoffs: Handoff[];
  readonly globalPendingApprovals: AgentPendingApproval[];
  /** Names the person gave agents' Panes, by Pane id (AP-D029); absent from older servers. */
  readonly paneNames?: Readonly<Record<string, string>>;
  /** Cleaned-up agents, to name them in old records (AP-D033); absent from older servers. */
  readonly retiredAgents?: AgentSession[];
}

/** Who asked an agent what, verbatim, and the user instructions those requests serve. */
export interface AgentInstructions {
  readonly instructions: Instruction[];
  readonly origins: Instruction[];
}

function key(): string {
  return globalThis.crypto.randomUUID();
}

export class ApiFailure extends Error {
  constructor(
    message: string,
    readonly code: ErrorCode | "NETWORK_UNAVAILABLE",
    readonly status: number,
    readonly requestId?: string,
  ) {
    super(message);
    this.name = "ApiFailure";
  }
}

export class NaruApi {
  #csrfToken: string | undefined;
  #authMode: SessionResponse["authMode"] | undefined;
  #projectRoots: readonly string[] = [];
  #terminalRestoreProtocol: TerminalRestoreProtocol | undefined;
  #controlSurface: { readonly connectionId: string; readonly generation: number } | undefined;
  readonly #authenticationRequiredListeners = new Set<() => void>();

  onAuthenticationRequired(listener: () => void): () => void {
    this.#authenticationRequiredListeners.add(listener);
    return () => this.#authenticationRequiredListeners.delete(listener);
  }

  setSession(session: SessionResponse): void {
    this.#authMode = session.authMode;
    this.#csrfToken = session.authMode === "app-managed" ? session.csrfToken : undefined;
    this.#projectRoots = [...session.projectRoots];
    this.#terminalRestoreProtocol = session.capabilities?.terminalRestore;
  }

  clearSession(): void {
    this.#csrfToken = undefined;
    this.#projectRoots = [];
    this.#terminalRestoreProtocol = undefined;
    this.#controlSurface = undefined;
  }

  setControlSurface(
    surface: { readonly connectionId: string; readonly generation: number } | undefined,
  ): void {
    this.#controlSurface = surface;
  }

  terminalRestoreProtocol(): TerminalRestoreProtocol | undefined {
    return this.#terminalRestoreProtocol;
  }

  authMode(): SessionResponse["authMode"] | undefined {
    return this.#authMode;
  }

  projectRoots(): readonly string[] {
    return this.#projectRoots;
  }

  async session(): Promise<SessionResponse> {
    const session = await this.#request<SessionResponse>("/api/session");
    this.setSession(session);
    if (session.authMode === "gateway-managed") {
      const gatewaySession = await this.#request<{
        csrfToken: unknown;
        session?: { browserOrigin?: unknown };
      }>("/_gateway/session");
      const gatewayOrigin = gatewaySession.session?.browserOrigin;
      if (
        typeof gatewaySession.csrfToken !== "string" ||
        gatewaySession.csrfToken.length === 0 ||
        typeof gatewayOrigin !== "string"
      ) {
        throw new ApiFailure("Gateway 세션을 확인하지 못했습니다.", "INTERNAL_ERROR", 502);
      }
      if (!isCurrentPwaOriginConsistent(gatewayOrigin)) {
        throw new ApiFailure(
          "Gateway와 현재 Naru PWA Origin 설정이 일치하지 않습니다.",
          "INTERNAL_ERROR",
          502,
        );
      }
      this.#csrfToken = gatewaySession.csrfToken;
    }
    return session;
  }

  async login(password: string): Promise<SessionResponse> {
    const session = await this.#request<SessionResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ password }),
    });
    this.setSession(session);
    return session;
  }

  passkeyAuthenticationOptions(): Promise<{
    ceremonyId: string;
    options: AuthenticationOptions;
  }> {
    return this.#request("/api/auth/passkey/options", { method: "POST" });
  }

  async loginWithPasskey(
    ceremonyId: string,
    response: AuthenticationResponse,
  ): Promise<SessionResponse> {
    const session = await this.#request<SessionResponse>("/api/auth/passkey/verify", {
      method: "POST",
      body: JSON.stringify({ ceremonyId, response }),
    });
    this.setSession(session);
    return session;
  }

  async logout(): Promise<void> {
    if (this.#authMode === "gateway-managed") {
      await this.#request<void>(
        "/_gateway/logout",
        { method: "POST", body: JSON.stringify({}) },
        true,
      );
    } else {
      await this.#request<void>("/api/auth/logout", { method: "POST" }, true);
    }
    this.clearSession();
  }

  passkeys(): Promise<Passkey[]> {
    return this.#request<Passkey[]>("/api/passkeys");
  }

  passkeyRegistrationOptions(): Promise<{
    ceremonyId: string;
    options: RegistrationOptions;
  }> {
    return this.#request("/api/passkeys/registration/options", { method: "POST" }, true);
  }

  registerPasskey(
    ceremonyId: string,
    name: string,
    response: RegistrationResponse,
  ): Promise<Passkey> {
    return this.#request<Passkey>(
      "/api/passkeys/registration/verify",
      { method: "POST", body: JSON.stringify({ ceremonyId, name, response }) },
      true,
    );
  }

  renamePasskey(id: string, name: string): Promise<Passkey> {
    return this.#request<Passkey>(
      `/api/passkeys/${id}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      true,
    );
  }

  deletePasskey(id: string): Promise<void> {
    return this.#request<void>(`/api/passkeys/${id}`, { method: "DELETE" }, true);
  }

  pushConfiguration(): Promise<PushConfiguration> {
    return this.#request<PushConfiguration>("/api/push/config");
  }

  updatePushConfiguration(inactivityDelayMinutes: number): Promise<PushConfiguration> {
    return this.#request<PushConfiguration>(
      "/api/push/config",
      { method: "PATCH", body: JSON.stringify({ inactivityDelayMinutes }) },
      true,
    );
  }

  pushSubscriptions(): Promise<NaruPushSubscription[]> {
    return this.#request<NaruPushSubscription[]>("/api/push/subscriptions");
  }

  registerPushSubscription(input: {
    name: string;
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  }): Promise<NaruPushSubscription> {
    return this.#request<NaruPushSubscription>(
      "/api/push/subscriptions",
      { method: "POST", body: JSON.stringify(input) },
      true,
    );
  }

  renamePushSubscription(id: string, name: string): Promise<NaruPushSubscription> {
    return this.#request<NaruPushSubscription>(
      `/api/push/subscriptions/${id}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      true,
    );
  }

  deletePushSubscription(id: string): Promise<void> {
    return this.#request<void>(`/api/push/subscriptions/${id}`, { method: "DELETE" }, true);
  }

  projects(): Promise<Project[]> {
    return this.#request<Project[]>("/api/projects");
  }

  projectGroups(): Promise<ProjectGroup[]> {
    return this.#request<ProjectGroup[]>("/api/project-groups");
  }

  refreshProjectGroups(): Promise<ProjectGroup[]> {
    return this.#request<ProjectGroup[]>("/api/project-groups/refresh", { method: "POST" }, true);
  }

  renameProjectGroup(groupId: string, name: string): Promise<ProjectGroup[]> {
    return this.#request<ProjectGroup[]>(
      `/api/project-groups/${groupId}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      true,
    );
  }

  connectProjectTarget(groupId: string, path: string): Promise<Project> {
    return this.#request<Project>(
      `/api/project-groups/${groupId}/targets`,
      { method: "POST", body: JSON.stringify({ path }) },
      true,
      true,
    );
  }

  createProject(path: string, name?: string): Promise<Project> {
    return this.#request<Project>(
      "/api/projects",
      {
        method: "POST",
        body: JSON.stringify({ path, ...(name ? { name } : {}) }),
      },
      true,
      true,
    );
  }

  renameProject(projectId: string, name: string): Promise<Project> {
    return this.#request<Project>(
      `/api/projects/${projectId}`,
      { method: "PATCH", body: JSON.stringify({ name }) },
      true,
    );
  }

  deleteProject(projectId: string): Promise<void> {
    return this.#request<void>(`/api/projects/${projectId}`, { method: "DELETE" }, true, true);
  }

  workspace(projectId: string): Promise<Workspace> {
    return this.#request<Workspace>(`/api/projects/${projectId}/workspace`);
  }

  createPane(projectId: string, input: CreatePaneRequest): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/projects/${projectId}/panes`,
      { method: "POST", body: JSON.stringify(input) },
      true,
      true,
    );
  }

  docs(projectId: string): Promise<DocumentCatalog> {
    return this.#request<DocumentCatalog>(`/api/projects/${projectId}/docs`);
  }

  tasks(projectId: string): Promise<DocumentCatalog> {
    return this.#request<DocumentCatalog>(`/api/projects/${projectId}/tasks`);
  }

  document(projectId: string, path: string): Promise<DocumentContent> {
    const query = new URLSearchParams({ path });
    return this.#request<DocumentContent>(`/api/projects/${projectId}/document?${query}`);
  }

  files(projectId: string, path = ""): Promise<ProjectDirectoryListing> {
    const query = new URLSearchParams({ path });
    return this.#request<ProjectDirectoryListing>(`/api/projects/${projectId}/files?${query}`);
  }

  file(projectId: string, path: string, allowSensitive = false): Promise<ProjectFileContent> {
    const query = new URLSearchParams({ path, allowSensitive: String(allowSensitive) });
    return this.#request<ProjectFileContent>(`/api/projects/${projectId}/file?${query}`);
  }

  saveFile(projectId: string, input: SaveProjectFileRequest): Promise<ProjectFileContent> {
    return this.#request<ProjectFileContent>(
      `/api/projects/${projectId}/file`,
      { method: "PUT", body: JSON.stringify(input) },
      true,
    );
  }

  fileDraft(paneId: string): Promise<FileDraft | undefined> {
    return this.#request<FileDraft | undefined>(`/api/panes/${paneId}/file-draft`);
  }

  saveFileDraft(paneId: string, input: SaveFileDraftRequest): Promise<FileDraft> {
    return this.#request<FileDraft>(
      `/api/panes/${paneId}/file-draft`,
      { method: "PUT", body: JSON.stringify(input) },
      true,
    );
  }

  deleteFileDraft(paneId: string): Promise<void> {
    return this.#request<void>(`/api/panes/${paneId}/file-draft`, { method: "DELETE" }, true);
  }

  /** Workspaces the person arranges (AP-D031); each answers with the whole project workspace. */
  createWorkspaceView(projectId: string, input: CreateWorkspaceViewRequest): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/projects/${projectId}/views`,
      { method: "POST", body: JSON.stringify(input) },
      true,
      true,
    );
  }

  saveWorkspaceView(
    projectId: string,
    viewId: string,
    input: SaveWorkspaceViewRequest,
  ): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/projects/${projectId}/views/${viewId}`,
      { method: "PUT", body: JSON.stringify(input) },
      true,
      true,
    );
  }

  deleteWorkspaceView(projectId: string, viewId: string, version: number): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/projects/${projectId}/views/${viewId}`,
      { method: "DELETE", body: JSON.stringify({ version }) },
      true,
      true,
    );
  }

  createWorkspaceViewPane(
    projectId: string,
    viewId: string,
    input: CreateWorkspaceViewPaneRequest,
  ): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/projects/${projectId}/views/${viewId}/panes`,
      { method: "POST", body: JSON.stringify(input) },
      true,
      true,
    );
  }

  /** The person's own name for a Pane (AP-D029); null returns to Naru's name. */
  renamePane(paneId: string, customTitle: string | null): Promise<Pane> {
    return this.#request<Pane>(
      `/api/panes/${paneId}`,
      { method: "PATCH", body: JSON.stringify({ customTitle }) },
      true,
      true,
    );
  }

  saveWorkspace(projectId: string, input: SaveWorkspaceRequest): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/projects/${projectId}/workspace`,
      { method: "PUT", body: JSON.stringify(input) },
      true,
      true,
    );
  }

  restartPane(paneId: string): Promise<Pane> {
    return this.#request<Pane>(`/api/panes/${paneId}/restart`, { method: "POST" }, true, true);
  }

  startNewCodex(paneId: string): Promise<Pane> {
    return this.#request<Pane>(`/api/panes/${paneId}/new-codex`, { method: "POST" }, true, true);
  }

  startNewClaude(paneId: string): Promise<Pane> {
    return this.#request<Pane>(`/api/panes/${paneId}/new-claude`, { method: "POST" }, true, true);
  }

  updatePaneViewState(paneId: string, input: Partial<PaneViewState>): Promise<Pane> {
    return this.#request<Pane>(
      `/api/panes/${paneId}/view-state`,
      { method: "PATCH", body: JSON.stringify(input) },
      true,
    );
  }

  acknowledgePaneActivity(paneId: string, eventId: string): Promise<Pane> {
    return this.#request<Pane>(
      `/api/panes/${paneId}/activity/acknowledge`,
      { method: "POST", body: JSON.stringify({ eventId }) },
      true,
    );
  }

  // Agent Platform (naru-agent/v1). Reads need a session; changes need CSRF and the device lease.

  agentOverview(): Promise<AgentOverview> {
    return this.#request<AgentOverview>("/api/agent/overview");
  }

  agentProject(projectId: string): Promise<AgentProjectView> {
    return this.#request<AgentProjectView>(`/api/agent/projects/${projectId}`);
  }

  agentBoard(): Promise<AgentBoard> {
    return this.#request<AgentBoard>("/api/agent/board");
  }

  agentInstructions(agentSessionId: string): Promise<AgentInstructions> {
    return this.#request<AgentInstructions>(`/api/agent/agents/${agentSessionId}/instructions`);
  }

  agentTask(taskId: string): Promise<AgentTaskDetail> {
    return this.#request<AgentTaskDetail>(`/api/agent/tasks/${taskId}`);
  }

  /**
   * Events after `after`, of one project or (null) of all; `latest` reads the newest page instead of
   * the oldest (first load).
   */
  agentEvents(
    projectId: string | null,
    after: number,
    options: { readonly limit?: number; readonly latest?: boolean } = {},
  ): Promise<AgentEvent[]> {
    const query = new URLSearchParams({ after: String(after) });
    if (projectId !== null) query.set("projectId", projectId);
    if (options.limit !== undefined) query.set("limit", String(options.limit));
    if (options.latest === true) query.set("latest", "1");
    return this.#request<AgentEvent[]>(`/api/agent/events?${query.toString()}`);
  }

  agentRuntime(agentSessionId: string): Promise<AgentRuntimeState> {
    return this.#request<AgentRuntimeState>(`/api/agent/agents/${agentSessionId}/runtime`);
  }

  agentHistory(
    agentSessionId: string,
    cursor: string | null,
  ): Promise<{ items: unknown[]; nextCursor: string | null }> {
    const query = cursor === null ? "" : `?cursor=${encodeURIComponent(cursor)}`;
    return this.#request(`/api/agent/agents/${agentSessionId}/history${query}`);
  }

  createInstruction(scope: InstructionScope, verbatim: string): Promise<Instruction> {
    return this.#agentWrite("/api/agent/instructions", { scope, verbatim, idempotencyKey: key() });
  }

  approveIntentContract(intentContractId: string): Promise<IntentContract> {
    return this.#agentWrite(`/api/agent/intent-contracts/${intentContractId}/approve`, {
      idempotencyKey: key(),
    });
  }

  createManagedAgent(
    input:
      | {
          projectId: string;
          role: "project-orchestrator" | "worker" | "reviewer" | "specialist";
          runtime: "claude" | "codex";
        }
      | { role: "main-orchestrator"; hostProjectId: string; runtime: "claude" | "codex" },
  ): Promise<AgentSession> {
    return this.#agentWrite("/api/agent/agents", { ...input, idempotencyKey: key() });
  }

  launchAgent(agentSessionId: string): Promise<AgentRuntimeState> {
    return this.#agentWrite(`/api/agent/agents/${agentSessionId}/launch`, {});
  }

  stopAgent(agentSessionId: string): Promise<AgentRuntimeState> {
    return this.#agentWrite(`/api/agent/agents/${agentSessionId}/stop`, {});
  }

  /**
   * "직접 개입" (hold) in Chat or the TUI, or hand the agent back. `interrupt` stops a running turn
   * instead of waiting for it to end.
   */
  setAgentHold(
    agentSessionId: string,
    held: boolean,
    surface: "chat" | "tui" = "chat",
    interrupt = false,
  ): Promise<AgentSession> {
    return this.#agentWrite(`/api/agent/agents/${agentSessionId}/hold`, {
      held,
      ...(held ? { surface, ...(interrupt ? { interrupt } : {}) } : {}),
      idempotencyKey: key(),
    });
  }

  sendAgentTurn(agentSessionId: string, text: string, generation: number): Promise<unknown> {
    return this.#agentWrite(`/api/agent/agents/${agentSessionId}/turns`, {
      text,
      generation,
      idempotencyKey: key(),
    });
  }

  interruptAgent(agentSessionId: string, generation: number): Promise<AgentRuntimeState> {
    return this.#agentWrite(`/api/agent/agents/${agentSessionId}/interrupt`, { generation });
  }

  /** The person answers an approval whoever writes the conversation (AP-D017). */
  respondAgentApproval(
    agentSessionId: string,
    requestId: string,
    decision: AgentApprovalDecision,
  ): Promise<AgentRuntimeState> {
    return this.#agentWrite(
      `/api/agent/agents/${agentSessionId}/approvals/${encodeURIComponent(requestId)}`,
      { decision },
    );
  }

  resolveHandoff(
    handoffId: string,
    decision: string,
    chosenOption: string | null,
  ): Promise<Handoff> {
    return this.#agentWrite(`/api/agent/handoffs/${handoffId}/resolve`, {
      decision,
      ...(chosenOption === null ? {} : { chosenOption }),
      idempotencyKey: key(),
    });
  }

  /** Cleans up agents and processes that no longer run (AP-D033); their Panes are removed. */
  cleanupAgents(
    agentSessionIds: readonly string[],
    processIds: readonly string[],
  ): Promise<{ agents: AgentSession[]; processes: SharedProcess[]; panesKept: number }> {
    return this.#agentWrite("/api/agent/cleanup", {
      agentSessionIds,
      processIds,
      idempotencyKey: key(),
    });
  }

  setProcessHold(processId: string, held: boolean): Promise<SharedProcess> {
    return this.#agentWrite(`/api/agent/processes/${processId}/hold`, {
      held,
      idempotencyKey: key(),
    });
  }

  stopProcess(processId: string): Promise<SharedProcess> {
    return this.#agentWrite(`/api/agent/processes/${processId}/stop`, {});
  }

  #agentWrite<T>(path: string, body: unknown): Promise<T> {
    return this.#request<T>(path, { method: "POST", body: JSON.stringify(body) }, true, true);
  }

  deletePane(paneId: string, workspaceVersion: number): Promise<Workspace> {
    return this.#request<Workspace>(
      `/api/panes/${paneId}`,
      { method: "DELETE", body: JSON.stringify({ workspaceVersion }) },
      true,
      true,
    );
  }

  async #request<T>(
    path: string,
    init: RequestInit = {},
    csrf = false,
    controlSurface = false,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body !== undefined) headers.set("Content-Type", "application/json");
    if (csrf) {
      if (!this.#csrfToken) throw new ApiFailure("로그인이 필요합니다.", "AUTH_REQUIRED", 401);
      headers.set(
        this.#authMode === "gateway-managed" ? WORKSTATION_GATEWAY_CSRF_HEADER : "x-csrf-token",
        this.#csrfToken,
      );
    }
    if (controlSurface) {
      if (this.#controlSurface === undefined) {
        throw new ApiFailure("현재 화면의 제어권이 필요합니다.", "LEASE_REQUIRED", 409);
      }
      headers.set(NARU_SURFACE_CONNECTION_HEADER, this.#controlSurface.connectionId);
      headers.set(NARU_SURFACE_GENERATION_HEADER, String(this.#controlSurface.generation));
    }

    let response: Response;
    try {
      const requestPath =
        path === "/_gateway" || path.startsWith("/_gateway/") ? path : currentAppPath(path);
      response = await fetch(requestPath, { ...init, headers, credentials: "same-origin" });
    } catch {
      throw new ApiFailure(
        "Naru 서버에 연결할 수 없습니다. 네트워크와 서버 상태를 확인해 주세요.",
        "NETWORK_UNAVAILABLE",
        0,
      );
    }
    if (!response.ok) {
      const errorBody = await readJson(response);
      const parsed = ApiErrorSchema.safeParse(errorBody);
      if (parsed.success) {
        const failure = new ApiFailure(
          parsed.data.message,
          parsed.data.code,
          response.status,
          parsed.data.requestId,
        );
        if (response.status === 401 && parsed.data.code === "AUTH_REQUIRED") {
          this.#notifyAuthenticationRequired();
        }
        throw failure;
      }
      const gatewayAuthentication = gatewayAuthenticationRequired(errorBody);
      if (response.status === 401 && gatewayAuthentication !== null) {
        this.#authMode = "gateway-managed";
        this.#notifyAuthenticationRequired();
        throw new ApiFailure(
          "로그인이 필요합니다.",
          "AUTH_REQUIRED",
          response.status,
          gatewayAuthentication.requestId,
        );
      }
      if (response.status === 401) this.#notifyAuthenticationRequired();
      throw new ApiFailure("요청을 처리하지 못했습니다.", "INTERNAL_ERROR", response.status);
    }
    if (response.status === 204) return undefined as T;
    return (await response.json()) as T;
  }

  #notifyAuthenticationRequired(): void {
    this.clearSession();
    for (const listener of this.#authenticationRequiredListeners) listener();
  }
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

function gatewayAuthenticationRequired(value: unknown): { readonly requestId: string } | null {
  const parsed = GatewayBrowserFailureResponseV1Schema.safeParse(value);
  return parsed.success && parsed.data.error.code === "AUTHENTICATION_REQUIRED"
    ? { requestId: parsed.data.requestId }
    : null;
}
