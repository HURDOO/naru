import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NARU_APP_BASE_PATH_META_NAME, naruAppScopePath } from "@naru/contracts/naru-app/v1";
import type { ServerOptions } from "node:https";
import cookie from "@fastify/cookie";
import fastifyStatic from "@fastify/static";
import websocket from "@fastify/websocket";
import {
  AcknowledgePaneActivityRequestSchema,
  ApiErrorSchema,
  type ClientWsFrame,
  ClientWsFrameSchema,
  ConnectDiscoveredProjectTargetRequestSchema,
  CreatePaneRequestSchema,
  CreateProjectRequestSchema,
  CreatePushSubscriptionRequestSchema,
  DeletePaneRequestSchema,
  DocumentRelativePathSchema,
  ProjectRelativePathSchema,
  FinishPasskeyAuthenticationRequestSchema,
  FinishPasskeyRegistrationRequestSchema,
  type FileAssistantMerge,
  LoginRequestSchema,
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
  SaveFileDraftRequestSchema,
  SaveProjectFileRequestSchema,
  SaveWorkspaceRequestSchema,
  PushProjectSummarySchema,
  TERMINAL_RESTORE_PROTOCOL,
  type SessionResponse,
  UpdateProjectRequestSchema,
  UpdatePasskeyRequestSchema,
  UpdatePushConfigurationRequestSchema,
  UpdatePushSubscriptionRequestSchema,
  UpdatePaneViewStateRequestSchema,
} from "@naru/contracts";
import type { Project } from "@naru/contracts";
import Fastify, { LogController, type FastifyInstance, type FastifyRequest } from "fastify";
import { z, ZodError } from "zod";
import { normalizeClientIp, type AppConfig, type AppManagedConfig } from "./config.js";
import {
  decodeClipboardImageChunk,
  MacClipboardImageWriter,
  validateClipboardPng,
  type ClipboardImageWriter,
} from "./clipboard-image.js";
import { ClientPresenceRegistry } from "./client-presence.js";
import type { NaruRepository } from "./database.js";
import { AppError } from "./errors.js";
import { FileDraftRegistry } from "./file-drafts.js";
import { GatewayRequestAuthenticator, type GatewayRequestIdentity } from "./gateway-auth.js";
import { GitMetadataAdapter } from "./git-metadata.js";
import { LeaseManager, type LeaseOwner } from "./lease.js";
import { AgentPlatformError, type AgentPlatformCore } from "./agent-platform/core.js";
import { registerAgentPlatformRoutes } from "./agent-platform/http-routes.js";
import { Observability, safeErrorFields } from "./observability.js";
import type { ProjectPathPolicy } from "./path-policy.js";
import { ProjectCatalogService } from "./project-catalog.js";
import { ProjectDocumentReader } from "./project-documents.js";
import { isSensitivePath, MAX_PROJECT_FILE_BYTES, ProjectFileService } from "./project-files.js";
import { PasskeyManager, type PasskeyService } from "./passkeys.js";
import { verifyPassword } from "./password.js";
import type { NaruSessionFacade } from "./session-facade.js";
import { WebPushNotificationService, type PushNotificationService } from "./push-notifications.js";
import { configurationReadiness, readinessStatus } from "./readiness.js";
import { LoginRateLimiter, type Session, SessionStore } from "./sessions.js";
import { sendFrame, type SocketLike } from "./transport.js";
import { TlsCertificateManager, type TlsCertificateService } from "./tls-certificate.js";

const CSRF_HEADER = "x-csrf-token";
const IdParamsSchema = z.object({ id: z.string().uuid() });
const DocumentQuerySchema = z.object({ path: DocumentRelativePathSchema });
const DirectoryQuerySchema = z.object({ path: ProjectRelativePathSchema.default("") });
const ProjectFileQuerySchema = z.object({
  path: DocumentRelativePathSchema,
  allowSensitive: z
    .enum(["true", "false"])
    .default("false")
    .transform((value) => value === "true"),
});

type ActiveSocket =
  | {
      readonly socket: SocketLike;
      readonly authMode: "app-managed";
      readonly sessionToken: string;
    }
  | {
      readonly socket: SocketLike;
      readonly authMode: "gateway-managed";
      readonly subject: string;
    };

type ClipboardImageFrame = Extract<
  ClientWsFrame,
  {
    type: "clipboard.image.begin" | "clipboard.image.chunk" | "clipboard.image.commit";
  }
>;

interface IncomingClipboardImage {
  readonly requestId: string;
  readonly paneId: string;
  readonly byteLength: number;
  readonly chunks: Uint8Array[];
  readonly timeout: ReturnType<typeof setTimeout>;
  receivedBytes: number;
}

interface AttachedPane {
  readonly attachmentKey: string;
  readonly detach: () => void;
  cols: number;
  rows: number;
}

export interface AppDependencies {
  repository: NaruRepository;
  pathPolicy: ProjectPathPolicy;
  supervisor: NaruSessionFacade;
  sessions?: SessionStore;
  loginRateLimiter?: LoginRateLimiter;
  leaseManager?: LeaseManager;
  observability?: Observability;
  clipboardImageWriter?: ClipboardImageWriter;
  tlsCertificateManager?: TlsCertificateService;
  passkeys?: PasskeyService;
  pushNotifications?: PushNotificationService;
  clientPresence?: ClientPresenceRegistry;
  documents?: ProjectDocumentReader;
  files?: ProjectFileService;
  fileDrafts?: FileDraftRegistry;
  projectCatalog?: ProjectCatalogService;
  /** Agent Platform routes are registered only when the core is supplied (AP-T11, opt-in). */
  agentPlatform?: AgentPlatformCore;
}

export async function buildApp(
  config: AppConfig,
  dependencies: AppDependencies,
): Promise<FastifyInstance> {
  if (config.tls === undefined && dependencies.tlsCertificateManager !== undefined) {
    throw new Error("A TLS certificate manager requires TLS configuration.");
  }
  const tlsCertificateManager =
    config.tls === undefined
      ? undefined
      : (dependencies.tlsCertificateManager ?? new TlsCertificateManager(config.tls));
  const tlsOptions = tlsCertificateManager?.loadInitial();
  const app = createFastifyServer(config, tlsOptions);
  const appManaged =
    config.authMode === "app-managed"
      ? {
          config,
          sessions: dependencies.sessions ?? new SessionStore(config.sessionSecret),
          rateLimiter: dependencies.loginRateLimiter ?? new LoginRateLimiter(),
          passkeys: dependencies.passkeys ?? new PasskeyManager(dependencies.repository),
        }
      : undefined;
  const gatewayAuthenticator =
    config.authMode === "gateway-managed"
      ? new GatewayRequestAuthenticator(config.gatewayAuth)
      : undefined;
  const sessions = appManaged?.sessions;
  const requireSession = (
    request: FastifyRequest,
    _sessionStore?: SessionStore,
  ): Session | GatewayRequestIdentity => {
    void _sessionStore;
    if (appManaged !== undefined) {
      return requireSessionForCookie(
        request,
        appManaged.sessions,
        appManaged.config.sessionCookieName,
      );
    }
    if (gatewayAuthenticator === undefined) throw new Error("Missing Gateway authenticator.");
    return gatewayAuthenticator.authenticate(request);
  };
  const requireSessionToken = (request: FastifyRequest): string => {
    if (appManaged === undefined) throw new AppError("REQUEST_INVALID", 404, "경로가 없습니다.");
    return requireSessionTokenForCookie(request, appManaged.config.sessionCookieName);
  };
  const requireUnsafeRequest = (
    request: FastifyRequest,
    _config?: AppConfig,
    _sessionStore?: SessionStore,
  ): Session | GatewayRequestIdentity => {
    void _config;
    void _sessionStore;
    if (appManaged !== undefined) {
      return requireAppManagedUnsafeRequest(request, appManaged.config, appManaged.sessions);
    }
    requireAllowedOrigin(request, config);
    if (gatewayAuthenticator === undefined) throw new Error("Missing Gateway authenticator.");
    return gatewayAuthenticator.authenticate(request);
  };
  const documents = dependencies.documents ?? new ProjectDocumentReader();
  const files = dependencies.files ?? new ProjectFileService();
  const fileDrafts = dependencies.fileDrafts ?? new FileDraftRegistry();
  const projectCatalog =
    dependencies.projectCatalog ??
    new ProjectCatalogService(
      dependencies.repository,
      new GitMetadataAdapter(dependencies.pathPolicy),
    );
  const leases = dependencies.leaseManager ?? new LeaseManager();
  const legacySessionRuntime = config.sessionRuntime?.owner !== "durable-host";
  const legacyTerminalSizes = new Map<string, { cols: number; rows: number }>();
  const clientPresence = dependencies.clientPresence ?? new ClientPresenceRegistry();
  const clipboardImageWriter = dependencies.clipboardImageWriter ?? new MacClipboardImageWriter();
  let clipboardWriteBarrier: Promise<void> = Promise.resolve();
  let clipboardWriteBusy = false;
  const enqueueClipboardWrite = <T>(task: () => Promise<T>): Promise<T> => {
    const result = clipboardWriteBarrier.then(task);
    clipboardWriteBarrier = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };
  const sockets = new Set<ActiveSocket>();
  const observability =
    dependencies.observability ??
    new Observability((entry) => {
      const { level, ...fields } = entry;
      app.log[level](fields, entry.event);
    });
  const pushNotifications =
    dependencies.pushNotifications ??
    new WebPushNotificationService(
      dependencies.repository,
      config.push,
      undefined,
      (level, event, fields) => observability.event(level, event, { ...fields }),
      (inactivityDelayMinutes) => clientPresence.hasRecentlyActiveClient(inactivityDelayMinutes),
    );
  const unsubscribeActivity = dependencies.supervisor.onActivity((change) => {
    for (const active of sockets) {
      sendFrame(active.socket, {
        type: "activity.changed",
        eventId: change.eventId,
        projectId: change.projectId,
        paneId: change.paneId,
        activity: change.activity,
        projectActivity: change.projectActivity,
      });
    }
    pushNotifications.handleActivity(change);
  });
  const unsubscribeCodexIdentity = dependencies.supervisor.onCodexIdentity((change) => {
    for (const active of sockets) {
      sendFrame(active.socket, {
        type: "codex.session.changed",
        paneId: change.paneId,
        runtimeId: change.runtimeId,
        updatedAt: change.updatedAt,
        session:
          change.sessionId === null
            ? { id: null, resumable: false }
            : { id: change.sessionId, resumable: change.resumable },
      });
    }
  });
  tlsCertificateManager?.setEventSink(({ level, event, fields }) => {
    observability.event(level, event, { ...fields });
  });
  const requestStartedAt = new WeakMap<FastifyRequest, number>();
  const configuration = configurationReadiness(config);
  const sessionCookieOptions = {
    httpOnly: true,
    sameSite: "strict" as const,
    secure: config.secureCookie,
    path: "/",
  };

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 128 * 1024 } });

  app.addHook("onRequest", async (request) => {
    requestStartedAt.set(request, performance.now());
    requireAllowedClientIp(request, config);
    await Promise.resolve();
  });

  app.addHook("onResponse", async (request, reply) => {
    observability.event("info", "http.request.completed", {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      statusCode: reply.statusCode,
      durationMs: Math.max(0, Math.round(performance.now() - (requestStartedAt.get(request) ?? 0))),
    });
    await Promise.resolve();
  });

  app.addHook("onSend", async (_request, reply, payload) => {
    reply
      .header("X-Content-Type-Options", "nosniff")
      .header("X-Frame-Options", "DENY")
      .header("Referrer-Policy", "no-referrer")
      .header(
        "Permissions-Policy",
        "camera=(), microphone=(), geolocation=(), publickey-credentials-create=(self), publickey-credentials-get=(self)",
      )
      .header(
        "Content-Security-Policy",
        "default-src 'self'; base-uri 'none'; frame-ancestors 'none'; object-src 'none'; img-src 'self' data:; font-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:",
      );
    await Promise.resolve();
    return payload;
  });

  app.setErrorHandler((error, request, reply) => {
    const appError = normalizeError(error);
    observability.increment("httpErrors");
    observability.event(appError.statusCode >= 500 ? "error" : "warn", "http.request.failed", {
      requestId: request.id,
      method: request.method,
      route: request.routeOptions.url,
      errorCode: appError.code,
      statusCode: appError.statusCode,
      ...safeErrorFields(error),
    });
    const payload = ApiErrorSchema.parse({
      code: appError.code,
      message: appError.message,
      requestId: request.id,
    });
    void reply.code(appError.statusCode).send(payload);
  });

  app.get("/healthz", () => ({ status: "ok" }));
  app.get("/readyz", async (_request, reply) => {
    const tlsCertificate = tlsCertificateManager?.status();
    const checks = {
      configuration,
      database: dependencies.repository.isReady() ? ("ok" as const) : ("failed" as const),
      sessionRuntime: (await dependencies.supervisor.readiness())
        ? ("ok" as const)
        : ("failed" as const),
      ...(tlsCertificate === undefined ? {} : { tls: tlsCertificate.status }),
    };
    const status = readinessStatus(checks);
    const payload = {
      status,
      checks,
      ...(tlsCertificate === undefined ? {} : { tlsCertificate }),
      metrics: observability.metrics({
        activePtys: dependencies.supervisor.count(),
        activeSessions: sessions?.count() ?? 0,
        activeWebSockets: sockets.size,
      }),
    };
    if (status === "not_ready") {
      observability.event("warn", "service.readiness.failed", { checks });
    }
    return reply.code(status === "ready" ? 200 : 503).send(payload);
  });

  if (appManaged !== undefined) {
    const { config, sessions, rateLimiter, passkeys } = appManaged;

    app.post("/api/auth/login", async (request, reply) => {
      requireAllowedOrigin(request, config);
      const input = LoginRequestSchema.parse(request.body);
      const ipKey = `ip:${request.ip}`;
      if (!rateLimiter.canAttempt(ipKey) || !rateLimiter.canAttempt("global")) {
        observability.increment("loginRateLimited");
        observability.event("warn", "auth.login.rate_limited", { requestId: request.id });
        throw new AppError(
          "AUTH_RATE_LIMITED",
          429,
          "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        );
      }

      if (!(await verifyPassword(input.password, config.passwordHash))) {
        rateLimiter.recordFailure(ipKey);
        rateLimiter.recordFailure("global");
        observability.increment("loginFailures");
        observability.event("warn", "auth.login.failed", { requestId: request.id });
        throw new AppError("AUTH_INVALID", 401, "비밀번호를 확인해 주세요.");
      }

      rateLimiter.clear(ipKey);
      rateLimiter.clear("global");
      const session = sessions.create();
      observability.increment("loginSuccesses");
      observability.event("info", "auth.login.succeeded", { requestId: request.id });
      reply.setCookie(config.sessionCookieName, session.token, {
        ...sessionCookieOptions,
        maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
      });
      return sessionResponse(session, config.projectRoots);
    });

    app.post("/api/auth/passkey/options", async (request) => {
      const origin = requireAllowedOrigin(request, config);
      const ipKey = `ip:${request.ip}`;
      requireLoginAttemptAllowed(rateLimiter, ipKey, observability, request.id);
      return passkeys.beginAuthentication(ipKey, origin);
    });

    app.post("/api/auth/passkey/verify", async (request, reply) => {
      const origin = requireAllowedOrigin(request, config);
      const input = FinishPasskeyAuthenticationRequestSchema.parse(request.body);
      const ipKey = `ip:${request.ip}`;
      requireLoginAttemptAllowed(rateLimiter, ipKey, observability, request.id);
      try {
        await passkeys.finishAuthentication(ipKey, origin, input);
      } catch (error) {
        rateLimiter.recordFailure(ipKey);
        rateLimiter.recordFailure("global");
        observability.increment("loginFailures");
        observability.event("warn", "auth.passkey.failed", { requestId: request.id });
        throw error;
      }
      rateLimiter.clear(ipKey);
      rateLimiter.clear("global");
      const session = sessions.create();
      observability.increment("loginSuccesses");
      observability.event("info", "auth.passkey.succeeded", { requestId: request.id });
      reply.setCookie(config.sessionCookieName, session.token, {
        ...sessionCookieOptions,
        maxAge: Math.floor((session.expiresAt - Date.now()) / 1000),
      });
      return sessionResponse(session, config.projectRoots);
    });

    app.post("/api/auth/logout", (request, reply) => {
      requireUnsafeRequest(request, config, sessions);
      const token = request.cookies[config.sessionCookieName];
      sessions.delete(token);
      for (const active of sockets) {
        if (active.authMode === "app-managed" && active.sessionToken === token) {
          sendFrame(active.socket, { type: "lease.revoked", reason: "logout" });
          active.socket.close(4003, "Logged out");
        }
      }
      reply.clearCookie(config.sessionCookieName, sessionCookieOptions);
      return reply.code(204).send();
    });

    app.get("/api/passkeys", (request) => {
      requireSession(request, sessions);
      return passkeys.list();
    });

    app.post("/api/passkeys/registration/options", async (request) => {
      const origin = requireAllowedOrigin(request, config);
      requireUnsafeRequest(request, config, sessions);
      return passkeys.beginRegistration(requireSessionToken(request), origin);
    });

    app.post("/api/passkeys/registration/verify", async (request, reply) => {
      const origin = requireAllowedOrigin(request, config);
      requireUnsafeRequest(request, config, sessions);
      const input = FinishPasskeyRegistrationRequestSchema.parse(request.body);
      const passkey = await passkeys.finishRegistration(
        requireSessionToken(request),
        origin,
        input,
      );
      observability.event("info", "auth.passkey.registered", { requestId: request.id });
      return reply.code(201).send(passkey);
    });

    app.patch("/api/passkeys/:id", (request) => {
      requireUnsafeRequest(request, config, sessions);
      const { id } = IdParamsSchema.parse(request.params);
      const { name } = UpdatePasskeyRequestSchema.parse(request.body);
      return passkeys.rename(id, name);
    });

    app.delete("/api/passkeys/:id", (request, reply) => {
      requireUnsafeRequest(request, config, sessions);
      const { id } = IdParamsSchema.parse(request.params);
      if (!passkeys.delete(id)) {
        throw new AppError("PASSKEY_MISSING", 404, "패스키를 찾을 수 없습니다.");
      }
      observability.event("info", "auth.passkey.deleted", { requestId: request.id });
      return reply.code(204).send();
    });
  }

  app.get("/api/session", (request) => {
    const identity = requireSession(request, sessions);
    return "mode" in identity
      ? gatewaySessionResponse(config.projectRoots)
      : sessionResponse(identity, config.projectRoots);
  });

  app.get("/api/push/config", (request) => {
    requireSession(request, sessions);
    return pushNotifications.configuration();
  });

  app.get("/api/push/projects/:id/summary", (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const project = dependencies.repository.getProject(id);
    if (!project) throw new AppError("PROJECT_MISSING", 404, "프로젝트를 찾을 수 없습니다.");
    const counts = {
      interactionRequired: 0,
      failed: 0,
      completed: 0,
    };
    for (const pane of dependencies.repository.getWorkspace(id).panes) {
      if (pane.activity.state === "interaction-required") counts.interactionRequired += 1;
      else if (pane.activity.state === "failed") counts.failed += 1;
      else if (pane.activity.state === "completed") counts.completed += 1;
    }
    return PushProjectSummarySchema.parse({
      projectId: id,
      projectName: project.name,
      state: project.activity.state,
      counts,
      suppressNotification: clientPresence.hasRecentlyActiveClient(
        pushNotifications.configuration().inactivityDelayMinutes,
      ),
    });
  });

  app.patch("/api/push/config", (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { inactivityDelayMinutes } = UpdatePushConfigurationRequestSchema.parse(request.body);
    return pushNotifications.updateConfiguration(inactivityDelayMinutes);
  });

  app.get("/api/push/subscriptions", (request) => {
    requireSession(request, sessions);
    return pushNotifications.list();
  });

  app.post("/api/push/subscriptions", (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    const input = CreatePushSubscriptionRequestSchema.parse(request.body);
    const subscription = pushNotifications.subscribe(input);
    observability.event("info", "push.subscription.registered", {
      requestId: request.id,
      subscriptionId: subscription.id,
    });
    return reply.code(201).send(subscription);
  });

  app.patch("/api/push/subscriptions/:id", (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const { name } = UpdatePushSubscriptionRequestSchema.parse(request.body);
    return pushNotifications.rename(id, name);
  });

  app.delete("/api/push/subscriptions/:id", (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    if (!pushNotifications.delete(id)) {
      throw new AppError("PUSH_SUBSCRIPTION_MISSING", 404, "알림 기기를 찾을 수 없습니다.");
    }
    observability.event("info", "push.subscription.deleted", {
      requestId: request.id,
      subscriptionId: id,
    });
    return reply.code(204).send();
  });

  if (dependencies.agentPlatform !== undefined) {
    registerAgentPlatformRoutes(app, dependencies.agentPlatform, {
      requireSession: (request) => {
        requireSession(request, sessions);
      },
      requireUnsafeRequest: (request) => {
        requireUnsafeRequest(request, config, sessions);
      },
      requireSurfaceController: (request) => requireSurfaceController(request, leases),
    });
  }

  app.get("/api/projects", (request) => {
    requireSession(request, sessions);
    return dependencies.repository.listProjects();
  });

  app.get("/api/project-groups", async (request) => {
    requireSession(request, sessions);
    return projectCatalog.list();
  });

  app.post("/api/project-groups/refresh", async (request) => {
    requireUnsafeRequest(request, config, sessions);
    return projectCatalog.refresh();
  });

  app.patch("/api/project-groups/:id", (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const input = UpdateProjectRequestSchema.parse(request.body);
    dependencies.repository.updateProjectGroupName(id, input.name);
    return projectCatalog.list();
  });

  app.post("/api/project-groups/:id/targets", async (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const { path } = ConnectDiscoveredProjectTargetRequestSchema.parse(request.body);
    const validated = await dependencies.pathPolicy.validate(path);
    const project = await projectCatalog.connect(id, validated.realPath);
    const workspace = dependencies.repository.getWorkspace(project.id);
    for (const pane of workspace.panes) {
      if (pane.kind === "codex" || pane.kind === "claude") {
        await startPaneWithPersistedFailure(dependencies.supervisor, pane.id, observability);
      }
    }
    return reply.code(201).send(project);
  });

  app.post("/api/projects", async (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const input = CreateProjectRequestSchema.parse(request.body);
    const validated = await dependencies.pathPolicy.validate(input.path);
    const project = await projectCatalog.register(
      validated.realPath,
      input.name ?? validated.defaultName,
    );
    const workspace = dependencies.repository.getWorkspace(project.id);
    for (const pane of workspace.panes) {
      if (pane.kind === "codex" || pane.kind === "claude") {
        await startPaneWithPersistedFailure(dependencies.supervisor, pane.id, observability);
      }
    }
    return reply.code(201).send(project);
  });

  app.patch("/api/projects/:id", (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const input = UpdateProjectRequestSchema.parse(request.body);
    return dependencies.repository.updateProjectName(id, input.name);
  });

  app.delete("/api/projects/:id", async (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const workspace = dependencies.repository.getWorkspace(id);
    for (const pane of workspace.panes) {
      await dependencies.supervisor.remove(pane.id);
      legacyTerminalSizes.delete(pane.id);
    }
    if (!dependencies.repository.deleteProject(id)) {
      throw new AppError("PROJECT_MISSING", 404, "프로젝트를 찾을 수 없습니다.");
    }
    fileDrafts.clearProject(id);
    return reply.code(204).send();
  });

  app.get("/api/projects/:id/workspace", async (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    await requireUsableProject(id, dependencies);
    return dependencies.repository.getWorkspace(id);
  });

  app.get("/api/projects/:id/docs", async (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const project = await requireUsableProject(id, dependencies);
    return documents.docsCatalog(project.path);
  });

  app.get("/api/projects/:id/tasks", async (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const project = await requireUsableProject(id, dependencies);
    return documents.taskCandidates(project.path);
  });

  app.get("/api/projects/:id/document", async (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const { path } = DocumentQuerySchema.parse(request.query);
    const project = await requireUsableProject(id, dependencies);
    return documents.read(project.path, path);
  });

  app.get("/api/projects/:id/files", async (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const { path } = DirectoryQuerySchema.parse(request.query);
    const project = await requireUsableProject(id, dependencies);
    return files.list(project.path, path);
  });

  app.get("/api/projects/:id/file", async (request) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const { path, allowSensitive } = ProjectFileQuerySchema.parse(request.query);
    const project = await requireUsableProject(id, dependencies);
    return files.read(project.path, path, allowSensitive);
  });

  app.put("/api/projects/:id/file", { bodyLimit: MAX_PROJECT_FILE_BYTES * 8 }, async (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const input = SaveProjectFileRequestSchema.parse(request.body);
    const project = await requireUsableProject(id, dependencies);
    return files.save(project.path, input);
  });

  app.put("/api/projects/:id/workspace", (request) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const input = SaveWorkspaceRequestSchema.parse(request.body);
    return dependencies.repository.saveWorkspace(id, input);
  });

  app.post("/api/projects/:id/panes", async (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const project = await requireUsableProject(id, dependencies);
    const input = CreatePaneRequestSchema.parse(request.body);
    if ((input.kind === "docs" || input.kind === "tasks") && input.selectedDocumentPath) {
      if (input.kind === "docs" && !input.selectedDocumentPath.startsWith("docs/")) {
        throw new AppError(
          "DOCS_OUTSIDE_ROOT",
          403,
          "Docs Pane은 docs 폴더의 문서만 열 수 있습니다.",
        );
      }
      const selected = await documents.read(project.path, input.selectedDocumentPath);
      if (input.kind === "tasks" && selected.kind !== "tasks") {
        throw new AppError("DOCS_UNSUPPORTED_TYPE", 415, "Tasks Pane은 TASKS.md만 열 수 있습니다.");
      }
    }
    if (input.kind === "files" && input.selectedDocumentPath) {
      await files.read(project.path, input.selectedDocumentPath, true);
    }
    if (
      input.kind === "claude" &&
      config.sessionRuntime?.owner === "durable-host" &&
      config.claudeExecutable === undefined
    ) {
      throw new AppError(
        "CLAUDE_EXECUTABLE_MISSING",
        503,
        "Claude Code 실행 파일이 Host에 설정되지 않았습니다.",
      );
    }
    const pane = dependencies.repository.createPane(id, input);
    if (pane.kind === "terminal" || pane.kind === "codex" || pane.kind === "claude") {
      await startPaneWithPersistedFailure(dependencies.supervisor, pane.id, observability);
    }
    return reply.code(201).send(dependencies.repository.getWorkspace(id));
  });

  app.post("/api/panes/:id/restart", async (request) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (pane.kind === "files" || pane.kind === "docs" || pane.kind === "tasks") {
      throw new AppError("REQUEST_INVALID", 400, "이 Pane은 재시작할 프로세스가 없습니다.");
    }
    if (
      pane.kind === "claude" &&
      config.sessionRuntime?.owner === "durable-host" &&
      config.claudeExecutable === undefined
    ) {
      throw new AppError(
        "CLAUDE_EXECUTABLE_MISSING",
        503,
        "Claude Code 실행 파일이 Host에 설정되지 않았습니다.",
      );
    }
    await requireUsableProject(pane.projectId, dependencies);
    await dependencies.supervisor.restart(id);
    return dependencies.repository.getPaneContext(id)?.pane;
  });

  app.post("/api/panes/:id/new-codex", async (request) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (pane.kind !== "codex") {
      throw new AppError("REQUEST_INVALID", 400, "Codex Pane에서만 새 세션을 시작할 수 있습니다.");
    }
    await requireUsableProject(pane.projectId, dependencies);
    await dependencies.supervisor.startNewCodex(id);
    return dependencies.repository.getPaneContext(id)?.pane;
  });

  app.post("/api/panes/:id/new-claude", async (request) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (pane.kind !== "claude") {
      throw new AppError("REQUEST_INVALID", 400, "Claude Pane에서만 새 대화를 시작할 수 있습니다.");
    }
    if (config.sessionRuntime?.owner === "durable-host" && config.claudeExecutable === undefined) {
      throw new AppError(
        "CLAUDE_EXECUTABLE_MISSING",
        503,
        "Claude Code 실행 파일이 Host에 설정되지 않았습니다.",
      );
    }
    await requireUsableProject(pane.projectId, dependencies);
    await dependencies.supervisor.startNewClaude(id);
    return dependencies.repository.getPaneContext(id)?.pane;
  });

  app.patch("/api/panes/:id/view-state", async (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const input = UpdatePaneViewStateRequestSchema.parse(request.body);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    const project = await requireUsableProject(pane.projectId, dependencies);
    if (input.selectedDocumentPath) {
      if (pane.kind === "docs" && !input.selectedDocumentPath.startsWith("docs/")) {
        throw new AppError(
          "DOCS_OUTSIDE_ROOT",
          403,
          "Docs Pane은 docs 폴더의 문서만 열 수 있습니다.",
        );
      }
      if (pane.kind === "files") {
        await files.read(project.path, input.selectedDocumentPath, true);
      } else {
        const selected = await documents.read(project.path, input.selectedDocumentPath);
        if (pane.kind === "tasks" && selected.kind !== "tasks") {
          throw new AppError(
            "DOCS_UNSUPPORTED_TYPE",
            415,
            "Tasks Pane은 TASKS.md만 열 수 있습니다.",
          );
        }
      }
    }
    return dependencies.repository.updatePaneViewState(id, input);
  });

  app.get("/api/panes/:id/file-draft", async (request, reply) => {
    requireSession(request, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (pane.kind !== "files") {
      throw new AppError(
        "REQUEST_INVALID",
        400,
        "Files Pane에서만 파일 초안을 사용할 수 있습니다.",
      );
    }
    await requireUsableProject(pane.projectId, dependencies);
    const draft = fileDrafts.get(id, pane.projectId);
    return draft === undefined ? reply.code(204).send() : reply.send(draft);
  });

  app.put(
    "/api/panes/:id/file-draft",
    { bodyLimit: MAX_PROJECT_FILE_BYTES * 8 },
    async (request) => {
      requireUnsafeRequest(request, config, sessions);
      const { id } = IdParamsSchema.parse(request.params);
      const input = SaveFileDraftRequestSchema.parse(request.body);
      const pane = dependencies.repository.getPaneContext(id)?.pane;
      if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
      if (pane.kind !== "files") {
        throw new AppError(
          "REQUEST_INVALID",
          400,
          "Files Pane에서만 파일 초안을 사용할 수 있습니다.",
        );
      }
      const project = await requireUsableProject(pane.projectId, dependencies);
      const previous = fileDrafts.get(id, pane.projectId);
      let base;
      if (
        previous?.path === input.path &&
        previous.baseRevision === input.baseRevision &&
        (!previous.sensitive || input.allowSensitive)
      ) {
        base =
          previous.baseRevision === null
            ? null
            : {
                path: previous.path,
                source: previous.baseSource,
                revision: previous.baseRevision,
                sizeBytes: Buffer.byteLength(previous.baseSource, "utf8"),
                modifiedAt: previous.updatedAt,
                sensitive: previous.sensitive,
              };
      } else {
        base = await files.readForRevision(
          project.path,
          input.path,
          input.baseRevision,
          input.allowSensitive,
        );
      }
      let assistantMerge: FileAssistantMerge | null = null;
      if (input.assistantMerge) {
        const assistantPane = dependencies.repository.getPaneContext(
          input.assistantMerge.paneId,
        )?.pane;
        if (
          !assistantPane ||
          assistantPane.projectId !== pane.projectId ||
          assistantPane.kind !== "codex" ||
          assistantPane.status !== "running"
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            409,
            "같은 프로젝트에서 실행 중인 Codex Pane을 선택해 주세요.",
          );
        }
        if (
          assistantPane.activity.state === "running" ||
          assistantPane.activity.state === "interaction-required" ||
          assistantPane.activity.eventId !== input.assistantMerge.initialActivityEventId
        ) {
          throw new AppError(
            "REQUEST_INVALID",
            409,
            "선택한 Codex Pane의 작업 상태가 바뀌었습니다. 작업이 끝난 뒤 다시 시도해 주세요.",
          );
        }
        const current = await files.readForRevision(
          project.path,
          input.path,
          input.assistantMerge.currentRevision,
          input.allowSensitive,
        );
        if (!current) {
          throw new AppError("FILE_MISSING", 404, "Codex가 병합할 현재 파일을 찾을 수 없습니다.");
        }
        assistantMerge = {
          paneId: assistantPane.id,
          initialActivityEventId: input.assistantMerge.initialActivityEventId,
          current,
          requestedAt: new Date().toISOString(),
        };
      }
      return fileDrafts.store(
        { paneId: id, projectId: pane.projectId },
        input.path,
        base,
        input.draftSource,
        isSensitivePath(input.path),
        assistantMerge,
      );
    },
  );

  app.delete("/api/panes/:id/file-draft", async (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (pane.kind !== "files") {
      throw new AppError(
        "REQUEST_INVALID",
        400,
        "Files Pane에서만 파일 초안을 사용할 수 있습니다.",
      );
    }
    await requireUsableProject(pane.projectId, dependencies);
    fileDrafts.clearPane(id);
    return reply.code(204).send();
  });

  app.post("/api/panes/:id/activity/acknowledge", async (request) => {
    requireUnsafeRequest(request, config, sessions);
    const { id } = IdParamsSchema.parse(request.params);
    const input = AcknowledgePaneActivityRequestSchema.parse(request.body);
    const pane = dependencies.repository.getPaneContext(id)?.pane;
    if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    await requireUsableProject(pane.projectId, dependencies);
    await dependencies.supervisor.acknowledgeCompleted(id, input.eventId);
    return dependencies.repository.getPaneContext(id)?.pane;
  });

  app.delete("/api/panes/:id", async (request, reply) => {
    requireUnsafeRequest(request, config, sessions);
    requireSurfaceController(request, leases);
    const { id } = IdParamsSchema.parse(request.params);
    const input = DeletePaneRequestSchema.parse(request.body);
    dependencies.repository.assertPaneDeletion(id, input.workspaceVersion);
    await dependencies.supervisor.remove(id);
    legacyTerminalSizes.delete(id);
    const workspace = dependencies.repository.deletePane(id, input.workspaceVersion);
    if (!workspace) {
      throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    }
    fileDrafts.clearPane(id);
    return reply.code(200).send(workspace);
  });

  app.get(
    "/api/terminal",
    {
      websocket: true,
      preValidation: async (request) => {
        requireAllowedOrigin(request, config);
        requireSession(request, sessions);
        await Promise.resolve();
      },
    },
    (socket, request) => {
      let activeSocket: ActiveSocket;
      if (config.authMode === "gateway-managed") {
        activeSocket = {
          socket,
          authMode: "gateway-managed",
          subject: config.gatewayAuth.ownerSubject,
        };
      } else {
        const sessionToken = request.cookies[config.sessionCookieName];
        if (!sessionToken) return socket.close(4003, "Authentication required");
        activeSocket = { socket, authMode: "app-managed", sessionToken };
      }
      sockets.add(activeSocket);
      observability.event("info", "websocket.connected", {
        requestId: request.id,
        activeWebSockets: sockets.size,
      });
      const attached = new Map<string, AttachedPane>();
      let incomingClipboardImage: IncomingClipboardImage | undefined;
      const clearIncomingClipboardImage = (): void => {
        if (incomingClipboardImage) clearTimeout(incomingClipboardImage.timeout);
        incomingClipboardImage = undefined;
      };
      const sendCurrentRuntimeProjections = (): void => {
        for (const project of dependencies.repository.listProjects()) {
          for (const pane of dependencies.repository.getWorkspace(project.id).panes) {
            if (pane.kind !== "codex" || pane.activity.runtimeId === null) continue;
            if (pane.activity.eventId !== null) {
              sendFrame(socket, {
                type: "activity.changed",
                eventId: pane.activity.eventId,
                projectId: project.id,
                paneId: pane.id,
                activity: pane.activity,
                projectActivity: project.activity,
              });
            }
            sendFrame(socket, {
              type: "codex.session.changed",
              paneId: pane.id,
              runtimeId: pane.activity.runtimeId,
              updatedAt: pane.updatedAt,
              session:
                pane.codexSessionId === null
                  ? { id: null, resumable: false }
                  : { id: pane.codexSessionId, resumable: pane.codexSessionResumable },
            });
          }
        }
      };
      const owner: LeaseOwner = {
        id: randomUUID(),
        update(state) {
          sendFrame(socket, { type: "surface.state", ...state });
          for (const [paneId, attachment] of attached) {
            const controlProjectionFailed = (error: unknown): void => {
              const normalized = normalizeError(error);
              observability.event("warn", "surface.control_projection.failed", {
                requestId: request.id,
                paneId,
                errorCode: normalized.code,
                statusCode: normalized.statusCode,
              });
              if (normalized.code === "PANE_MISSING" || normalized.code === "PTY_NOT_RUNNING") {
                attachment.detach();
                attached.delete(paneId);
                legacyTerminalSizes.delete(paneId);
              }
            };
            try {
              const controlUpdate = dependencies.supervisor.setControlDesired(
                paneId,
                state.role === "controller",
                attachment.cols,
                attachment.rows,
                attachment.attachmentKey,
              );
              if (legacySessionRuntime && state.role === "controller") {
                legacyTerminalSizes.set(paneId, {
                  cols: attachment.cols,
                  rows: attachment.rows,
                });
              }
              void Promise.resolve(controlUpdate).catch(controlProjectionFailed);
              if (legacySessionRuntime) {
                queueMicrotask(() => {
                  if (!leases.isMember(owner, state.generation)) return;
                  const role = leases.isCurrent(owner, state.generation)
                    ? "controller"
                    : "observer";
                  if (role !== state.role || !attached.has(paneId)) return;
                  sendFrame(socket, {
                    type: "pane.control.state",
                    paneId,
                    role,
                    controllerGeneration: 0,
                    terminal:
                      legacyTerminalSizes.get(paneId) ??
                      ({ cols: attachment.cols, rows: attachment.rows } as const),
                    reason: role === "controller" ? "acquired" : "released",
                  });
                });
              }
            } catch (error) {
              controlProjectionFailed(error);
            }
          }
        },
        revoke(reason) {
          clearIncomingClipboardImage();
          clientPresence.remove(request.id);
          for (const attachment of attached.values()) attachment.detach();
          attached.clear();
          sendFrame(socket, { type: "lease.revoked", reason });
          socket.close(reason === "replaced" ? 4001 : 4003, reason);
        },
      };

      socket.on("message", (raw, isBinary) => {
        void handleSocketMessage(raw, isBinary).catch((error: unknown) => {
          const normalized = normalizeError(error);
          observability.event(normalized.statusCode >= 500 ? "error" : "warn", "websocket.error", {
            requestId: request.id,
            errorCode: normalized.code,
            statusCode: normalized.statusCode,
            ...safeErrorFields(normalized),
          });
          sendProtocolError(socket, normalized, request.id);
        });
      });
      socket.on("close", () => {
        clearIncomingClipboardImage();
        clientPresence.remove(request.id);
        sockets.delete(activeSocket);
        observability.event("info", "websocket.disconnected", {
          requestId: request.id,
          activeWebSockets: sockets.size,
        });
        leases.release(owner);
        for (const attachment of attached.values()) attachment.detach();
        attached.clear();
      });

      async function handleSocketMessage(raw: unknown, isBinary: boolean): Promise<void> {
        if (isBinary)
          throw new AppError("REQUEST_INVALID", 400, "Binary frame은 지원하지 않습니다.");
        if (
          activeSocket.authMode === "app-managed" &&
          appManaged?.sessions.get(activeSocket.sessionToken) === undefined
        ) {
          owner.revoke("expired");
          return;
        }
        const frame = ClientWsFrameSchema.parse(JSON.parse(socketText(raw)) as unknown);

        if (frame.type === "lease.acquire") {
          const granted = leases.acquire(owner, frame.clientId);
          observability.event("info", "lease.acquired", {
            requestId: request.id,
            acquisition: granted.acquisition,
            generation: granted.generation,
            role: granted.state.role,
          });
          sendFrame(socket, {
            type: "lease.granted",
            generation: granted.generation,
            replacedClient: false,
            acquisition: granted.acquisition,
          });
          sendFrame(socket, { type: "surface.state", ...granted.state });
          sendCurrentRuntimeProjections();
          return;
        }
        if (!leases.isMember(owner, frame.leaseGeneration)) {
          throw new AppError("LEASE_REQUIRED", 409, "최신 Naru surface generation이 필요합니다.");
        }
        leases.touch(owner, frame.leaseGeneration);

        switch (frame.type) {
          case "surface.acquire": {
            if (leases.acquireAvailable(owner, frame.leaseGeneration) === undefined) {
              throw new AppError("LEASE_REQUIRED", 409, "사용 가능한 제어 surface가 없습니다.");
            }
            break;
          }
          case "surface.takeover": {
            if (frame.target !== null) {
              const attachment = requireAttachedPane(frame.target.paneId);
              attachment.cols = frame.target.cols;
              attachment.rows = frame.target.rows;
              await dependencies.supervisor.preemptControl(
                frame.target.paneId,
                frame.target.cols,
                frame.target.rows,
                attachment.attachmentKey,
              );
              if (legacySessionRuntime) {
                legacyTerminalSizes.set(frame.target.paneId, {
                  cols: frame.target.cols,
                  rows: frame.target.rows,
                });
              }
            }
            if (leases.takeover(owner, frame.leaseGeneration) === undefined) {
              if (frame.target !== null) {
                const attachment = attached.get(frame.target.paneId);
                if (attachment !== undefined) {
                  await dependencies.supervisor.releaseControl(
                    frame.target.paneId,
                    attachment.attachmentKey,
                  );
                }
              }
              throw new AppError("LEASE_REQUIRED", 409, "제어 surface 상태가 변경되었습니다.");
            }
            observability.increment("websocketTakeovers");
            observability.event("info", "surface.preempted", {
              requestId: request.id,
              paneId: frame.target?.paneId,
            });
            break;
          }
          case "pane.control.preempt": {
            requireSurfaceSocketController(frame.leaseGeneration);
            const attachment = requireAttachedPane(frame.paneId);
            await dependencies.supervisor.preemptControl(
              frame.paneId,
              frame.cols,
              frame.rows,
              attachment.attachmentKey,
            );
            attachment.cols = frame.cols;
            attachment.rows = frame.rows;
            if (legacySessionRuntime) {
              legacyTerminalSizes.set(frame.paneId, { cols: frame.cols, rows: frame.rows });
            }
            break;
          }
          case "pane.control.approve": {
            requireSurfaceSocketController(frame.leaseGeneration);
            const attachment = requireAttachedPane(frame.paneId);
            await dependencies.supervisor.approveControl(
              frame.paneId,
              frame.controlRequestId,
              attachment.attachmentKey,
            );
            break;
          }
          case "pane.control.reject": {
            requireSurfaceSocketController(frame.leaseGeneration);
            const attachment = requireAttachedPane(frame.paneId);
            await dependencies.supervisor.rejectControl(
              frame.paneId,
              frame.controlRequestId,
              attachment.attachmentKey,
            );
            break;
          }
          case "pane.control.release": {
            requireSurfaceSocketController(frame.leaseGeneration);
            const attachment = requireAttachedPane(frame.paneId);
            await dependencies.supervisor.releaseControl(frame.paneId, attachment.attachmentKey);
            break;
          }
          case "pane.attach": {
            attached.get(frame.paneId)?.detach();
            attached.delete(frame.paneId);
            const attachmentKey = `${owner.id}:${frame.paneId}`;
            const wantsControl = leases.isCurrent(owner, frame.leaseGeneration);
            const detach = await dependencies.supervisor.attach(
              frame.paneId,
              frame.cols,
              frame.rows,
              (event) => {
                if (
                  legacySessionRuntime &&
                  (event.type === "pane.snapshot" ||
                    event.type === "pane.restore.preview" ||
                    event.type === "pane.restore.full")
                ) {
                  legacyTerminalSizes.set(frame.paneId, { cols: event.cols, rows: event.rows });
                }
                sendFrame(socket, event);
              },
              frame.restoreProtocol,
              frame.restoreId,
              { attachmentKey, control: wantsControl ? "controller" : "observer" },
            );
            const attachment = {
              attachmentKey,
              detach,
              cols: frame.cols,
              rows: frame.rows,
            };
            attached.set(frame.paneId, attachment);
            const controlsNow = leases.isCurrent(owner, frame.leaseGeneration);
            if (controlsNow !== wantsControl) {
              await dependencies.supervisor.setControlDesired(
                frame.paneId,
                controlsNow,
                frame.cols,
                frame.rows,
                attachmentKey,
              );
            }
            if (legacySessionRuntime) {
              sendFrame(socket, {
                type: "pane.control.state",
                paneId: frame.paneId,
                role: controlsNow ? "controller" : "observer",
                controllerGeneration: 0,
                terminal:
                  legacyTerminalSizes.get(frame.paneId) ??
                  ({ cols: frame.cols, rows: frame.rows } as const),
                reason: "attached",
              });
            }
            break;
          }
          case "pane.detach":
            attached.get(frame.paneId)?.detach();
            attached.delete(frame.paneId);
            break;
          case "terminal.input": {
            requireSurfaceSocketController(frame.leaseGeneration);
            const attachment = requireAttachedPane(frame.paneId);
            clientPresence.noteInteraction(request.id);
            await dependencies.supervisor.write(frame.paneId, frame.data, attachment.attachmentKey);
            break;
          }
          case "terminal.resize": {
            requireSurfaceSocketController(frame.leaseGeneration);
            const attachment = requireAttachedPane(frame.paneId);
            attachment.cols = frame.cols;
            attachment.rows = frame.rows;
            await dependencies.supervisor.resize(
              frame.paneId,
              frame.cols,
              frame.rows,
              attachment.attachmentKey,
            );
            if (legacySessionRuntime) {
              legacyTerminalSizes.set(frame.paneId, { cols: frame.cols, rows: frame.rows });
            }
            break;
          }
          case "terminal.viewport": {
            const attachment = requireAttachedPane(frame.paneId);
            if (leases.isCurrent(owner, frame.leaseGeneration)) {
              await dependencies.supervisor.updateViewport(
                frame.paneId,
                frame.runtimeId,
                frame.bottomOffset,
                attachment.attachmentKey,
              );
            }
            break;
          }
          case "clipboard.image.begin":
          case "clipboard.image.chunk":
          case "clipboard.image.commit": {
            requireSurfaceSocketController(frame.leaseGeneration);
            await handleClipboardImageFrame(frame);
            break;
          }
          case "heartbeat":
            if (frame.presence) clientPresence.observe(request.id, frame.presence);
            sendFrame(socket, { type: "heartbeat.ack", sentAt: frame.sentAt });
            break;
        }
      }

      function requireAttachedPane(paneId: string): AttachedPane {
        const attachment = attached.get(paneId);
        if (attachment === undefined) {
          throw new AppError("LEASE_REQUIRED", 409, "연결된 Pane attachment가 필요합니다.");
        }
        return attachment;
      }

      function requireSurfaceSocketController(generation: number): void {
        if (!leases.isCurrent(owner, generation)) {
          throw new AppError("LEASE_REQUIRED", 409, "현재 Naru control surface가 필요합니다.");
        }
      }

      async function handleClipboardImageFrame(frame: ClipboardImageFrame): Promise<void> {
        try {
          switch (frame.type) {
            case "clipboard.image.begin": {
              if (clipboardWriteBusy) {
                throw new AppError(
                  "REQUEST_INVALID",
                  409,
                  "앞선 이미지를 Codex에 붙여넣는 중입니다.",
                );
              }
              if (incomingClipboardImage) {
                throw new AppError("REQUEST_INVALID", 409, "이미지 붙여넣기가 이미 진행 중입니다.");
              }
              const pane = dependencies.repository.getPaneContext(frame.paneId)?.pane;
              if (!pane) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
              if (pane.kind !== "codex") {
                throw new AppError(
                  "REQUEST_INVALID",
                  400,
                  "이미지는 Codex Pane에만 붙여넣을 수 있습니다.",
                );
              }
              if (!attached.has(frame.paneId)) {
                throw new AppError("LEASE_REQUIRED", 409, "연결된 Codex Pane이 필요합니다.");
              }
              const timeout = setTimeout(() => {
                if (incomingClipboardImage?.requestId !== frame.requestId) return;
                incomingClipboardImage = undefined;
                sendFrame(socket, {
                  type: "clipboard.image.result",
                  requestId: frame.requestId,
                  paneId: frame.paneId,
                  status: "error",
                  code: "REQUEST_INVALID",
                  message: "이미지 붙여넣기 시간이 초과되었습니다.",
                });
              }, 30_000);
              timeout.unref();
              incomingClipboardImage = {
                requestId: frame.requestId,
                paneId: frame.paneId,
                byteLength: frame.byteLength,
                chunks: [],
                timeout,
                receivedBytes: 0,
              };
              break;
            }
            case "clipboard.image.chunk": {
              const transfer = requireIncomingClipboardImage(frame);
              if (frame.offset !== transfer.receivedBytes) {
                throw new AppError("REQUEST_INVALID", 400, "이미지 조각 순서가 올바르지 않습니다.");
              }
              const chunk = decodeClipboardImageChunk(frame.data);
              if (transfer.receivedBytes + chunk.byteLength > transfer.byteLength) {
                throw new AppError(
                  "REQUEST_INVALID",
                  400,
                  "이미지 데이터가 선언한 크기를 초과했습니다.",
                );
              }
              transfer.chunks.push(chunk);
              transfer.receivedBytes += chunk.byteLength;
              break;
            }
            case "clipboard.image.commit": {
              if (clipboardWriteBusy) {
                throw new AppError(
                  "REQUEST_INVALID",
                  409,
                  "앞선 이미지를 Codex에 붙여넣는 중입니다.",
                );
              }
              const transfer = requireIncomingClipboardImage(frame);
              if (transfer.receivedBytes !== transfer.byteLength) {
                throw new AppError(
                  "REQUEST_INVALID",
                  400,
                  "이미지 데이터 크기가 선언과 일치하지 않습니다.",
                );
              }
              clearIncomingClipboardImage();
              const image = Buffer.concat(transfer.chunks, transfer.receivedBytes);
              const dimensions = validateClipboardPng(image);
              clipboardWriteBusy = true;
              try {
                await enqueueClipboardWrite(async () => {
                  if (!leases.isCurrent(owner, frame.leaseGeneration)) {
                    throw new AppError("LEASE_REQUIRED", 409, "현재 제어 lease가 필요합니다.");
                  }
                  const pane = dependencies.repository.getPaneContext(frame.paneId)?.pane;
                  if (!pane || pane.kind !== "codex" || !attached.has(frame.paneId)) {
                    throw new AppError("REQUEST_INVALID", 409, "연결된 Codex Pane이 필요합니다.");
                  }
                  await clipboardImageWriter.writePng(image);
                  if (!leases.isCurrent(owner, frame.leaseGeneration)) {
                    throw new AppError("LEASE_REQUIRED", 409, "현재 제어 lease가 필요합니다.");
                  }
                  await dependencies.supervisor.write(
                    frame.paneId,
                    "\u0016",
                    requireAttachedPane(frame.paneId).attachmentKey,
                  );
                });
              } finally {
                clipboardWriteBusy = false;
              }
              observability.event("info", "clipboard.image.attached", {
                requestId: request.id,
                paneId: frame.paneId,
                byteLength: image.byteLength,
                width: dimensions.width,
                height: dimensions.height,
              });
              sendFrame(socket, {
                type: "clipboard.image.result",
                requestId: frame.requestId,
                paneId: frame.paneId,
                status: "attached",
              });
              break;
            }
          }
        } catch (error) {
          if (incomingClipboardImage?.requestId === frame.requestId) {
            clearIncomingClipboardImage();
          }
          const normalized = normalizeError(error);
          observability.event(
            normalized.statusCode >= 500 ? "error" : "warn",
            "clipboard.image.failed",
            {
              requestId: request.id,
              paneId: frame.paneId,
              errorCode: normalized.code,
              statusCode: normalized.statusCode,
              ...safeErrorFields(error),
            },
          );
          sendFrame(socket, {
            type: "clipboard.image.result",
            requestId: frame.requestId,
            paneId: frame.paneId,
            status: "error",
            code: normalized.code,
            message: normalized.message,
          });
        }
      }

      function requireIncomingClipboardImage(frame: ClipboardImageFrame): IncomingClipboardImage {
        if (
          !incomingClipboardImage ||
          incomingClipboardImage.requestId !== frame.requestId ||
          incomingClipboardImage.paneId !== frame.paneId
        ) {
          throw new AppError("REQUEST_INVALID", 400, "진행 중인 이미지 붙여넣기가 없습니다.");
        }
        return incomingClipboardImage;
      }
    },
  );

  const leaseTimer = setInterval(() => leases.expire(), 5_000);
  leaseTimer.unref();
  app.addHook("onClose", async () => {
    clearInterval(leaseTimer);
    unsubscribeActivity();
    unsubscribeCodexIdentity();
    await pushNotifications.close();
    tlsCertificateManager?.stop();
    leases.shutdown();
    await clipboardWriteBarrier;
    await dependencies.supervisor.shutdown();
    dependencies.repository.close();
  });

  if (config.webDist && existsSync(config.webDist)) {
    assertWebIndexBasePath(config.webDist, config.appBasePath);
    await app.register(fastifyStatic, {
      root: config.webDist,
      wildcard: false,
      setHeaders(response, filePath) {
        if (filePath.endsWith("/sw.js")) {
          response.header("Cache-Control", "no-cache, no-store, must-revalidate");
          response.header("Service-Worker-Allowed", naruAppScopePath(config.appBasePath));
        } else if (filePath.endsWith("/index.html") || filePath.endsWith("/manifest.webmanifest")) {
          response.header("Cache-Control", "no-cache");
        } else if (/\/assets\/[^/]+-[A-Za-z0-9_-]{8,}\.[^/]+$/.test(filePath)) {
          response.header("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    });
    app.setNotFoundHandler((request, reply) => {
      if (
        request.method === "GET" &&
        !request.url.startsWith("/api/") &&
        !isReservedStaticAssetRequest(request.url)
      ) {
        return reply.sendFile("index.html");
      }
      throw new AppError("REQUEST_INVALID", 404, "요청한 경로를 찾을 수 없습니다.");
    });
  }

  tlsCertificateManager?.start(app.server);

  return app;
}

function assertWebIndexBasePath(webDist: string, expectedBasePath: string): void {
  const source = readFileSync(join(webDist, "index.html"), "utf8");
  const pattern = new RegExp(
    `<meta\\s+name=["']${NARU_APP_BASE_PATH_META_NAME}["']\\s+content=["']([^"']*)["']\\s*\\/?>`,
    "g",
  );
  const matches = [...source.matchAll(pattern)];
  if (matches.length === 0 && expectedBasePath === "/") return;
  if (matches.length !== 1 || matches[0]?.[1] !== expectedBasePath) {
    throw new Error("Naru web release app base path metadata does not match configuration.");
  }
}

function isReservedStaticAssetRequest(url: string): boolean {
  const pathname = url.split("?", 1)[0] ?? url;
  return (
    pathname === "/sw.js" ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/favicon.svg" ||
    pathname.startsWith("/assets/") ||
    pathname.startsWith("/fonts/") ||
    pathname.startsWith("/icons/")
  );
}

function createFastifyServer(
  config: AppConfig,
  tlsOptions: ServerOptions | undefined,
): FastifyInstance {
  const options = {
    bodyLimit: 128 * 1024,
    trustProxy: false,
    logController: new LogController({ disableRequestLogging: true }),
    logger:
      config.environment === "test"
        ? false
        : {
            level: "info" as const,
            redact: [
              "req.headers.authorization",
              "req.headers.cookie",
              `req.headers.${CSRF_HEADER}`,
              "req.headers.x-workstation-gateway-assertion",
              "req.headers.x-workstation-gateway-csrf",
              "req.body.password",
              "req.body.response",
              "password",
              "passwordHash",
              "sessionSecret",
              "token",
              "environment",
              "terminalData",
            ],
          },
  };
  if (tlsOptions === undefined) return Fastify(options);

  // Routes and hooks are raw-server agnostic; Fastify infers a node:https Server from this option.
  return Fastify({ ...options, https: tlsOptions });
}

function requireAllowedClientIp(request: FastifyRequest, config: AppConfig): void {
  if (!config.allowedClientIps) return;
  const clientIp = normalizeClientIp(request.ip);
  if (!config.allowedClientIps.has(clientIp)) {
    throw new AppError("ORIGIN_INVALID", 403, "허용되지 않은 클라이언트 IP입니다.");
  }
}

function requireSurfaceController(request: FastifyRequest, leases: LeaseManager): void {
  const connectionId = request.headers[NARU_SURFACE_CONNECTION_HEADER];
  const rawGeneration = request.headers[NARU_SURFACE_GENERATION_HEADER];
  const generation =
    typeof rawGeneration === "string" && /^\d+$/.test(rawGeneration)
      ? Number(rawGeneration)
      : Number.NaN;
  if (
    typeof connectionId !== "string" ||
    !Number.isSafeInteger(generation) ||
    generation <= 0 ||
    !leases.isCurrentConnection(connectionId, generation)
  ) {
    throw new AppError("LEASE_REQUIRED", 409, "현재 Naru control surface의 제어권이 필요합니다.");
  }
}

async function requireUsableProject(
  projectId: string,
  dependencies: Pick<AppDependencies, "repository" | "pathPolicy">,
): Promise<Project> {
  const project = dependencies.repository.getProject(projectId);
  if (!project) throw new AppError("PROJECT_MISSING", 404, "프로젝트를 찾을 수 없습니다.");
  const validated = await dependencies.pathPolicy.validate(project.path);
  if (validated.realPath !== project.path) {
    throw new AppError("PROJECT_MISSING", 404, "등록 후 프로젝트 경로의 대상이 변경되었습니다.");
  }
  return project;
}

async function startPaneWithPersistedFailure(
  supervisor: NaruSessionFacade,
  paneId: string,
  observability: Observability,
): Promise<void> {
  try {
    await supervisor.start(paneId);
  } catch (error) {
    // Expected launch failures are stored on the Pane so project creation remains usable and the
    // browser can show a specific recovery action. Unexpected failures still fail the request.
    if (!(error instanceof AppError)) throw error;
    observability.increment("ptyLaunchFailures");
    observability.event("warn", "pty.launch.failed", {
      paneId,
      errorCode: error.code,
      statusCode: error.statusCode,
    });
  }
}

function socketText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString("utf8");
  if (raw instanceof Uint8Array) return Buffer.from(raw).toString("utf8");
  if (Array.isArray(raw) && raw.every((part) => part instanceof Uint8Array)) {
    return Buffer.concat(raw).toString("utf8");
  }
  throw new AppError("REQUEST_INVALID", 400, "WebSocket frame 형식이 올바르지 않습니다.");
}

function requireAllowedOrigin(request: FastifyRequest, config: AppConfig): string {
  const origin = request.headers.origin;
  if (typeof origin !== "string" || !config.allowedOrigins.has(origin)) {
    throw new AppError("ORIGIN_INVALID", 403, "허용되지 않은 요청 출처입니다.");
  }
  return origin;
}

function requireSessionTokenForCookie(request: FastifyRequest, cookieName: string): string {
  const token = request.cookies[cookieName];
  if (token === undefined) throw new AppError("AUTH_REQUIRED", 401, "로그인이 필요합니다.");
  return token;
}

function requireLoginAttemptAllowed(
  rateLimiter: LoginRateLimiter,
  ipKey: string,
  observability: Observability,
  requestId: string,
): void {
  if (rateLimiter.canAttempt(ipKey) && rateLimiter.canAttempt("global")) return;
  observability.increment("loginRateLimited");
  observability.event("warn", "auth.login.rate_limited", { requestId });
  throw new AppError(
    "AUTH_RATE_LIMITED",
    429,
    "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
  );
}

function requireSessionForCookie(
  request: FastifyRequest,
  sessions: SessionStore,
  cookieName: string,
): Session {
  const session = sessions.get(request.cookies[cookieName]);
  if (!session) throw new AppError("AUTH_REQUIRED", 401, "로그인이 필요합니다.");
  return session;
}

function requireAppManagedUnsafeRequest(
  request: FastifyRequest,
  config: AppManagedConfig,
  sessions: SessionStore,
): Session {
  requireAllowedOrigin(request, config);
  const session = requireSessionForCookie(request, sessions, config.sessionCookieName);
  if (request.headers[CSRF_HEADER] !== session.csrfToken) {
    throw new AppError("CSRF_INVALID", 403, "요청 검증 토큰이 올바르지 않습니다.");
  }
  return session;
}

function sessionResponse(session: Session, projectRoots: readonly string[]): SessionResponse {
  return {
    authenticated: true,
    authMode: "app-managed",
    csrfToken: session.csrfToken,
    expiresAt: new Date(session.expiresAt).toISOString(),
    projectRoots: [...projectRoots],
    capabilities: { terminalRestore: TERMINAL_RESTORE_PROTOCOL },
  };
}

function gatewaySessionResponse(projectRoots: readonly string[]): SessionResponse {
  return {
    authenticated: true,
    authMode: "gateway-managed",
    projectRoots: [...projectRoots],
    capabilities: { terminalRestore: TERMINAL_RESTORE_PROTOCOL },
  };
}

function sendProtocolError(socket: SocketLike, error: unknown, requestId?: string): void {
  const normalized = normalizeError(error);
  sendFrame(socket, {
    type: "protocol.error",
    code: normalized.code,
    message:
      normalized.statusCode >= 500 ? "서버에서 요청을 처리하지 못했습니다." : normalized.message,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function normalizeError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof AgentPlatformError) {
    return new AppError(error.code, AGENT_ERROR_STATUS[error.code], error.message);
  }
  if (error instanceof ZodError || error instanceof SyntaxError) {
    return new AppError("REQUEST_INVALID", 400, "요청 형식이 올바르지 않습니다.");
  }
  if (
    error instanceof Error &&
    "statusCode" in error &&
    typeof error.statusCode === "number" &&
    error.statusCode < 500
  ) {
    return new AppError("REQUEST_INVALID", error.statusCode, "요청을 처리할 수 없습니다.");
  }
  return new AppError("INTERNAL_ERROR", 500, "서버에서 요청을 처리하지 못했습니다.");
}

const AGENT_ERROR_STATUS: Record<AgentPlatformError["code"], number> = {
  AGENT_NOT_FOUND: 404,
  AGENT_SCOPE_DENIED: 403,
  AGENT_ROLE_DENIED: 403,
  AGENT_HELD_BY_HUMAN: 409,
  AGENT_REVISION_STALE: 409,
  AGENT_IDEMPOTENCY_CONFLICT: 409,
  AGENT_INVALID_REFERENCE: 400,
  AGENT_INVALID_STATE: 409,
  AGENT_DEPENDENCY_CYCLE: 400,
};
