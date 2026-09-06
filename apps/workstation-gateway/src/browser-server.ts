import type { ServerOptions } from "node:https";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import {
  WORKSTATION_GATEWAY_CSRF_HEADER,
  isWorkstationGatewayBrowserPath,
  type GatewayBrowserFailureResponseV1,
} from "@naru/contracts/workstation-gateway/v1";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { WebSocket } from "ws";
import { z, ZodError } from "zod";
import type { GatewayAppRegistry } from "./app-registry.js";
import type { GatewayAssertionIssuer } from "./assertion-issuer.js";
import {
  GATEWAY_BROWSER_LIMITS,
  hasReservedIdentityHeader,
  rawHeaderBytes,
  type GatewayAuthenticationRateLimiter,
} from "./browser-security.js";
import type { GatewayManagedAppRegistration, WorkstationGatewayConfig } from "./config.js";
import { isDirectPrivateWorkstationGatewayConfig } from "./config.js";
import { GatewayError, internalGatewayError } from "./gateway-error.js";
import type { GatewayLogger } from "./logging.js";
import type { GatewayPasskeyManager } from "./passkeys.js";
import { sendGatewayPreAuthPage } from "./pre-auth-page.js";
import { proxyGatewayHttp, proxyGatewayWebSocket } from "./proxy.js";
import type { AuthenticatedGatewaySession, GatewaySessionStore } from "./sessions.js";
import type { GatewayWebSocketRegistry } from "./websocket-registry.js";

const Base64UrlSchema = z
  .string()
  .min(1)
  .max(512 * 1_024)
  .regex(/^[A-Za-z0-9_-]+$/);
const ClientExtensionResultsSchema = z.record(z.string(), z.unknown());
const RegistrationResponseSchema = z.strictObject({
  id: Base64UrlSchema,
  rawId: Base64UrlSchema,
  response: z.strictObject({
    clientDataJSON: Base64UrlSchema,
    attestationObject: Base64UrlSchema,
    transports: z.array(z.string().min(1).max(32)).max(16).optional(),
    publicKeyAlgorithm: z.number().int().optional(),
    publicKey: Base64UrlSchema.optional(),
    authenticatorData: Base64UrlSchema.optional(),
  }),
  type: z.literal("public-key"),
  clientExtensionResults: ClientExtensionResultsSchema,
  authenticatorAttachment: z.string().max(64).optional(),
});
const AuthenticationResponseSchema = z.strictObject({
  id: Base64UrlSchema,
  rawId: Base64UrlSchema,
  response: z.strictObject({
    clientDataJSON: Base64UrlSchema,
    authenticatorData: Base64UrlSchema,
    signature: Base64UrlSchema,
    userHandle: Base64UrlSchema.nullable().optional(),
  }),
  type: z.literal("public-key"),
  clientExtensionResults: ClientExtensionResultsSchema,
  authenticatorAttachment: z.string().max(64).optional(),
});
const RegistrationOptionsRequestSchema = z.strictObject({
  code: z.string().min(20).max(256),
});
const RegistrationVerifyRequestSchema = z.strictObject({
  ceremonyId: z.string().uuid(),
  response: RegistrationResponseSchema,
});
const AuthenticationVerifyRequestSchema = z.strictObject({
  ceremonyId: z.string().uuid(),
  response: AuthenticationResponseSchema,
});

interface ProxyAuthorization {
  readonly app: GatewayManagedAppRegistration;
  readonly session: AuthenticatedGatewaySession;
}

export interface GatewayBrowserServerOptions {
  readonly config: WorkstationGatewayConfig;
  readonly registry: GatewayAppRegistry;
  readonly sessions: GatewaySessionStore;
  readonly passkeys: GatewayPasskeyManager;
  readonly issuer: GatewayAssertionIssuer;
  readonly sockets: GatewayWebSocketRegistry;
  readonly logger: GatewayLogger;
  readonly ready: () => boolean;
  readonly authenticationRateLimiter: GatewayAuthenticationRateLimiter;
  readonly nowMs: () => number;
  readonly httpsOptions?: ServerOptions;
}

export async function buildGatewayBrowserServer(
  options: GatewayBrowserServerOptions,
): Promise<FastifyInstance> {
  const server = createGatewayFastifyServer(options);
  server.removeAllContentTypeParsers();
  server.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => {
    done(null, body);
  });
  await server.register(cookie);
  await server.register(websocket, { options: { maxPayload: 4 * 1_024 * 1_024 } });

  server.addHook("onRequest", async (request, reply) => {
    if (isWorkstationGatewayBrowserPath(new URL(request.url, "https://gateway.invalid").pathname)) {
      reply.header("cache-control", "no-store");
    }
    requireRequestEnvelope(request, options.config);
    await Promise.resolve();
  });

  server.setErrorHandler((error, request, reply) => {
    const normalized = normalizeError(error);
    options.logger.write({
      level: normalized.code === "INTERNAL_ERROR" ? "error" : "warn",
      event: "auth.request-denied",
      code: normalized.code,
      ...(normalized.diagnosticId === undefined ? {} : { diagnosticId: normalized.diagnosticId }),
    });
    if (reply.raw.headersSent) {
      reply.raw.destroy();
      return;
    }
    reply.header("cache-control", "no-store");
    const failure: GatewayBrowserFailureResponseV1 = {
      version: 1,
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
        ...(normalized.diagnosticId === undefined ? {} : { diagnosticId: normalized.diagnosticId }),
      },
      requestId: request.id,
    };
    void reply.code(normalized.statusCode).send(failure);
  });

  server.get("/_gateway/healthz", (request) => {
    requireExactHost(request, options.config);
    return { version: 1, status: "ok" };
  });
  server.get("/_gateway/readyz", (request, reply) => {
    requireExactHost(request, options.config);
    const ready = options.ready();
    return reply.code(ready ? 200 : 503).send({
      version: 1,
      status: ready ? "ready" : "not-ready",
      checks: { storage: ready, auth: ready, registry: ready },
    });
  });

  server.get("/_gateway/login", (request, reply) => {
    requireExactBrowserRequest(request, options.config, false);
    const returnTo = gatewayReturnPath(request.raw.url ?? request.url, options);
    const session = options.sessions.authenticate(
      request.cookies[options.config.sessionCookieName],
    );
    if (session !== undefined) return redirect(reply, returnTo);
    return sendGatewayPreAuthPage(reply, returnTo);
  });

  server.post("/_gateway/auth/registration/options", async (request) => {
    requireAuthenticationAttempt(request, options, "registration");
    requireExactBrowserRequest(request, options.config, true);
    const input = RegistrationOptionsRequestSchema.parse(parseJsonBody(request));
    return options.passkeys.beginRegistration(input.code, options.config.browserOrigin);
  });

  server.post("/_gateway/auth/registration/verify", async (request, reply) => {
    requireAuthenticationAttempt(request, options, "registration");
    requireExactBrowserRequest(request, options.config, true);
    const input = RegistrationVerifyRequestSchema.parse(parseJsonBody(request));
    const result = await options.passkeys.finishRegistration(options.config.browserOrigin, {
      ceremonyId: input.ceremonyId,
      response: input.response as RegistrationResponseJSON,
    });
    setSessionCookie(reply, options.config, result.session.token);
    return {
      version: 1,
      ok: true,
      credential: result.credential,
      session: publicSession(result.session, options.config.browserOrigin),
      csrfToken: result.session.csrfToken,
    };
  });

  server.post("/_gateway/auth/authentication/options", async (request) => {
    requireAuthenticationAttempt(request, options, "authentication");
    requireExactBrowserRequest(request, options.config, true);
    requireEmptyJsonBody(request);
    return options.passkeys.beginAuthentication(options.config.browserOrigin);
  });

  server.post("/_gateway/auth/authentication/verify", async (request, reply) => {
    requireAuthenticationAttempt(request, options, "authentication");
    requireExactBrowserRequest(request, options.config, true);
    const input = AuthenticationVerifyRequestSchema.parse(parseJsonBody(request));
    const session = await options.passkeys.finishAuthentication(options.config.browserOrigin, {
      ceremonyId: input.ceremonyId,
      response: input.response as AuthenticationResponseJSON,
    });
    setSessionCookie(reply, options.config, session.token);
    return {
      version: 1,
      ok: true,
      session: publicSession(session, options.config.browserOrigin),
      csrfToken: session.csrfToken,
    };
  });

  server.get("/_gateway/session", (request) => {
    requireExactBrowserRequest(request, options.config, false);
    const session = requireSession(request, options.config, options.sessions);
    const csrfToken = options.sessions.rotateCsrf(session);
    options.sockets.refreshSession(
      session.sessionId,
      Math.min(session.expiresAt, session.idleExpiresAt),
    );
    return {
      version: 1,
      ok: true,
      session: publicSession(session, options.config.browserOrigin),
      csrfToken,
    };
  });

  server.post("/_gateway/logout", (request, reply) => {
    requireExactBrowserRequest(request, options.config, true);
    const session = requireUnsafeSession(request, options.config, options.sessions);
    requireEmptyJsonBody(request);
    const token = request.cookies[options.config.sessionCookieName];
    const revokedSessionId = options.sessions.revoke(token);
    options.sockets.closeSession(revokedSessionId ?? session.sessionId);
    clearSessionCookie(reply, options.config);
    options.logger.write({ level: "info", event: "auth.session-revoked" });
    return reply.code(204).send();
  });

  server.all("/_gateway/*", (request, reply) => {
    requireExactHost(request, options.config);
    reply.header("cache-control", "no-store");
    return reply.code(404).send({
      version: 1,
      ok: false,
      error: { code: "REQUEST_INVALID", message: "Gateway endpoint was not found." },
    });
  });

  const authorizations = new WeakMap<FastifyRequest, ProxyAuthorization>();
  const preValidateProxy = async (
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<void | FastifyReply> => {
    requireExactBrowserRequest(
      request,
      options.config,
      isWebSocketUpgrade(request) || isUnsafeMethod(request.method),
    );
    const pathname = new URL(request.raw.url ?? request.url, options.config.browserOrigin).pathname;
    const app = options.registry.matchManaged(pathname);
    if (app === undefined || !app.enabled) {
      throw new GatewayError("APP_UNAVAILABLE", 404, "Gateway managed app was not found.");
    }
    const token = request.cookies[options.config.sessionCookieName];
    let session: AuthenticatedGatewaySession;
    if (isPreAuthNavigation(request)) {
      const authenticated = options.sessions.authenticate(token);
      if (authenticated === undefined) {
        return redirect(reply, gatewayLoginPath(request.raw.url ?? request.url));
      }
      session = authenticated;
    } else {
      session = isUnsafeMethod(request.method)
        ? requireUnsafeSession(request, options.config, options.sessions)
        : requireSession(request, options.config, options.sessions);
    }
    options.sockets.refreshSession(
      session.sessionId,
      Math.min(session.expiresAt, session.idleExpiresAt),
    );
    authorizations.set(request, { app, session });
    await Promise.resolve();
  };
  const httpHandler = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authorization = requiredAuthorization(authorizations, request);
    const issued = options.issuer.issue(authorization.app, authorization.session);
    options.logger.write({
      level: "info",
      event: "proxy.request-started",
      appId: authorization.app.appId,
    });
    try {
      await proxyGatewayHttp({
        request,
        reply,
        app: authorization.app,
        assertion: issued.assertion,
        sessionCookieName: options.config.sessionCookieName,
      });
    } catch (error) {
      if (error instanceof GatewayError) throw error;
      options.logger.write({
        level: "warn",
        event: "proxy.request-failed",
        appId: authorization.app.appId,
        code: "APP_UNAVAILABLE",
      });
      if (reply.raw.headersSent) {
        reply.raw.destroy();
        return;
      }
      throw new GatewayError("APP_UNAVAILABLE", 502, "Gateway managed app is unavailable.");
    }
  };
  const wsHandler = (socket: WebSocket, request: FastifyRequest): void => {
    const authorization = requiredAuthorization(authorizations, request);
    const issued = options.issuer.issue(authorization.app, authorization.session);
    proxyGatewayWebSocket({
      client: socket,
      request,
      app: authorization.app,
      assertion: issued.assertion,
      session: authorization.session,
      sessionCookieName: options.config.sessionCookieName,
      sockets: options.sockets,
      logger: options.logger,
    });
  };
  for (const url of ["/", "/*"] as const) {
    server.route({
      method: "GET",
      url,
      preValidation: preValidateProxy,
      handler: httpHandler,
      wsHandler,
    });
    server.route({
      method: ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      url,
      preValidation: preValidateProxy,
      handler: httpHandler,
    });
  }
  return server;
}

function createGatewayFastifyServer(options: GatewayBrowserServerOptions): FastifyInstance {
  const serverOptions = {
    logger: false,
    trustProxy: false,
    bodyLimit: options.config.requestBodyBytes,
    requestTimeout: GATEWAY_BROWSER_LIMITS.requestTimeoutMs,
    keepAliveTimeout: GATEWAY_BROWSER_LIMITS.keepAliveTimeoutMs,
    maxRequestsPerSocket: GATEWAY_BROWSER_LIMITS.requestsPerSocket,
    routerOptions: { maxParamLength: 1_024 },
  } as const;
  const server =
    options.httpsOptions === undefined
      ? Fastify(serverOptions)
      : Fastify({ ...serverOptions, https: options.httpsOptions });
  server.server.headersTimeout = GATEWAY_BROWSER_LIMITS.headersTimeoutMs;
  return server;
}

function requireRequestEnvelope(request: FastifyRequest, config: WorkstationGatewayConfig): void {
  if (
    request.raw.rawHeaders.length / 2 > GATEWAY_BROWSER_LIMITS.headerCount ||
    rawHeaderBytes(request.raw.rawHeaders) > GATEWAY_BROWSER_LIMITS.headerBytes
  ) {
    throw new GatewayError("REQUEST_INVALID", 431, "Gateway request headers are too large.");
  }
  requireExactHost(request, config);
  const rawOrigin = request.headers.origin;
  const origin = singleHeader(rawOrigin);
  if (rawOrigin !== undefined && (origin === undefined || origin !== config.browserOrigin)) {
    throw new GatewayError("ORIGIN_DENIED", 403, "Gateway request Origin is not allowed.");
  }
  if (
    isDirectPrivateWorkstationGatewayConfig(config) &&
    hasReservedIdentityHeader(request.headers)
  ) {
    throw new GatewayError("REQUEST_INVALID", 400, "Gateway request headers are invalid.");
  }
}

function requireExactHost(request: FastifyRequest, config: WorkstationGatewayConfig): void {
  const host = singleHeader(request.headers.host);
  if (host !== new URL(config.browserOrigin).host) {
    throw new GatewayError("ORIGIN_DENIED", 403, "Gateway request host is not allowed.");
  }
}

function requireExactBrowserRequest(
  request: FastifyRequest,
  config: WorkstationGatewayConfig,
  originRequired: boolean,
): void {
  requireExactHost(request, config);
  const rawOrigin = request.headers.origin;
  const origin = singleHeader(rawOrigin);
  if (
    (originRequired && origin === undefined) ||
    (rawOrigin !== undefined && (origin === undefined || origin !== config.browserOrigin))
  ) {
    throw new GatewayError("ORIGIN_DENIED", 403, "Gateway request Origin is not allowed.");
  }
}

function requireAuthenticationAttempt(
  request: FastifyRequest,
  options: GatewayBrowserServerOptions,
  kind: "registration" | "authentication",
): void {
  if (options.authenticationRateLimiter.consume(request.socket.remoteAddress, options.nowMs())) {
    return;
  }
  if (kind === "registration") {
    throw new GatewayError(
      "BOOTSTRAP_DENIED",
      429,
      "Gateway bootstrap or recovery intent is invalid.",
    );
  }
  throw new GatewayError("PASSKEY_DENIED", 429, "Gateway passkey ceremony is invalid.");
}

function requireSession(
  request: FastifyRequest,
  config: WorkstationGatewayConfig,
  sessions: GatewaySessionStore,
): AuthenticatedGatewaySession {
  const session = sessions.authenticate(request.cookies[config.sessionCookieName]);
  if (session === undefined) {
    throw new GatewayError("AUTHENTICATION_REQUIRED", 401, "Gateway authentication is required.");
  }
  return session;
}

function requireUnsafeSession(
  request: FastifyRequest,
  config: WorkstationGatewayConfig,
  sessions: GatewaySessionStore,
): AuthenticatedGatewaySession {
  const token = request.cookies[config.sessionCookieName];
  const csrf = singleHeader(request.headers[WORKSTATION_GATEWAY_CSRF_HEADER]);
  if (!sessions.verifyCsrf(token, csrf)) {
    throw new GatewayError("CSRF_DENIED", 403, "Gateway CSRF validation failed.");
  }
  return requireSession(request, config, sessions);
}

function isPreAuthNavigation(request: FastifyRequest): boolean {
  if (request.method !== "GET" || isWebSocketUpgrade(request)) return false;
  const fetchMode = singleHeader(request.headers["sec-fetch-mode"]);
  const acceptsHtml = singleHeader(request.headers.accept)
    ?.split(",")
    .some((value) => value.trim().split(";", 1)[0] === "text/html");
  return fetchMode === "navigate" || acceptsHtml === true;
}

function gatewayLoginPath(rawUrl: string): string {
  const parsed = new URL(rawUrl, "https://gateway.invalid");
  const returnTo = `${parsed.pathname}${parsed.search}`;
  return `/_gateway/login?return=${encodeURIComponent(returnTo)}`;
}

function gatewayReturnPath(rawUrl: string, options: GatewayBrowserServerOptions): string {
  const requested = new URL(rawUrl, options.config.browserOrigin).searchParams.get("return");
  const fallback = options.registry
    .list()
    .find(
      (app): app is GatewayManagedAppRegistration => app.mode === "gateway-managed" && app.enabled,
    )?.routePrefix;
  if (fallback === undefined) {
    throw new GatewayError("APP_UNAVAILABLE", 404, "Gateway managed app was not found.");
  }
  if (
    requested === null ||
    requested.length > 2_048 ||
    !requested.startsWith("/") ||
    requested.startsWith("//")
  ) {
    return fallback;
  }
  const parsed = new URL(requested, options.config.browserOrigin);
  if (
    parsed.origin !== options.config.browserOrigin ||
    parsed.hash !== "" ||
    options.registry.matchManaged(parsed.pathname) === undefined
  ) {
    return fallback;
  }
  return `${parsed.pathname}${parsed.search}`;
}

function redirect(reply: FastifyReply, location: string): FastifyReply {
  return reply.code(303).header("location", location).send();
}

function requiredAuthorization(
  authorizations: WeakMap<FastifyRequest, ProxyAuthorization>,
  request: FastifyRequest,
): ProxyAuthorization {
  const authorization = authorizations.get(request);
  if (authorization === undefined) throw internalGatewayError();
  return authorization;
}

function parseJsonBody(request: FastifyRequest): unknown {
  const contentType = singleHeader(request.headers["content-type"])
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" || !Buffer.isBuffer(request.body)) {
    throw new GatewayError("REQUEST_INVALID", 415, "Content-Type must be application/json.");
  }
  try {
    return JSON.parse(request.body.toString("utf8")) as unknown;
  } catch {
    throw new GatewayError("REQUEST_INVALID", 400, "Gateway request body is invalid JSON.");
  }
}

function requireEmptyJsonBody(request: FastifyRequest): void {
  const parsed = parseJsonBody(request);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 0
  ) {
    throw new GatewayError("REQUEST_INVALID", 400, "Gateway request body must be an empty object.");
  }
}

function setSessionCookie(
  reply: FastifyReply,
  config: WorkstationGatewayConfig,
  token: string,
): void {
  reply.setCookie(config.sessionCookieName, token, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
    maxAge: Math.floor(config.sessionAbsoluteTtlMs / 1_000),
  });
  reply.header("cache-control", "no-store");
}

function clearSessionCookie(reply: FastifyReply, config: WorkstationGatewayConfig): void {
  reply.clearCookie(config.sessionCookieName, {
    secure: true,
    httpOnly: true,
    sameSite: "strict",
    path: "/",
  });
}

function publicSession(session: AuthenticatedGatewaySession, browserOrigin: string): object {
  return {
    subject: session.subject,
    authTime: session.authTime,
    expiresAt: session.expiresAt,
    browserOrigin,
  };
}

function isWebSocketUpgrade(request: FastifyRequest): boolean {
  return singleHeader(request.headers.upgrade)?.toLowerCase() === "websocket";
}

function isUnsafeMethod(method: string): boolean {
  return method !== "GET" && method !== "HEAD";
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function normalizeError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  if (error instanceof ZodError) {
    return new GatewayError("REQUEST_INVALID", 400, "Gateway request body is invalid.");
  }
  if (hasErrorCode(error, "FST_ERR_CTP_BODY_TOO_LARGE")) {
    return new GatewayError("REQUEST_INVALID", 413, "Gateway request body is too large.");
  }
  return internalGatewayError();
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}
