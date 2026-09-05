import {
  ApiErrorSchema,
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
  type ErrorCode,
  type CreatePaneRequest,
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
import { isCurrentPwaOriginConsistent } from "./pwa";

type AuthenticationOptions = StartAuthenticationOpts["optionsJSON"];
type RegistrationOptions = StartRegistrationOpts["optionsJSON"];
type AuthenticationResponse = Awaited<ReturnType<typeof startAuthentication>>;
type RegistrationResponse = Awaited<ReturnType<typeof startRegistration>>;

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
      response = await fetch(path, { ...init, headers, credentials: "same-origin" });
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
