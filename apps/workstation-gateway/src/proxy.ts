import {
  request as httpRequest,
  type IncomingHttpHeaders,
  type OutgoingHttpHeaders,
  type RequestOptions,
} from "node:http";
import type { FastifyReply, FastifyRequest } from "fastify";
import { WORKSTATION_GATEWAY_ASSERTION_HEADER } from "@naru/contracts/workstation-gateway/v1";
import WebSocket, { type RawData } from "ws";
import { isReservedIdentityHeaderName } from "./browser-security.js";
import type { GatewayManagedAppRegistration } from "./config.js";
import { GatewayError } from "./gateway-error.js";
import type { GatewayLogger } from "./logging.js";
import { assertPrivateUnixSocket } from "./security.js";
import type { AuthenticatedGatewaySession } from "./sessions.js";
import type { GatewayWebSocketRegistry } from "./websocket-registry.js";

export const GATEWAY_ASSERTION_HEADER = WORKSTATION_GATEWAY_ASSERTION_HEADER;

const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

export interface GatewayHttpProxyInput {
  readonly request: FastifyRequest;
  readonly reply: FastifyReply;
  readonly app: GatewayManagedAppRegistration;
  readonly assertion: string;
  readonly sessionCookieName: string;
}

export async function proxyGatewayHttp(input: GatewayHttpProxyInput): Promise<void> {
  const targetPath = upstreamPath(
    input.request.raw.url ?? input.request.url,
    input.app.routePrefix,
  );
  const headers = sanitizedUpstreamHeaders(
    input.request.headers,
    input.sessionCookieName,
    input.assertion,
  );
  const body = requestBody(input.request.body);
  if (body !== undefined) headers["content-length"] = String(body.byteLength);
  else delete headers["content-length"];

  await new Promise<void>((resolvePromise, reject) => {
    const upstream = httpRequest(
      upstreamHttpOptions(input.app, targetPath, input.request.method, headers),
      (response) => {
        input.reply.code(response.statusCode ?? 502);
        const connectionTokens = headerTokens(response.headers.connection);
        for (const [name, value] of Object.entries(response.headers)) {
          const normalizedName = name.toLowerCase();
          if (
            value === undefined ||
            HOP_BY_HOP_HEADERS.has(normalizedName) ||
            connectionTokens.has(normalizedName)
          ) {
            continue;
          }
          if (normalizedName === "set-cookie") {
            const cookies = (Array.isArray(value) ? value : [value]).filter(
              (cookie) => cookieName(cookie) !== input.sessionCookieName,
            );
            if (cookies.length > 0) input.reply.header(name, cookies);
            continue;
          }
          input.reply.header(name, value);
        }
        response.once("error", reject);
        void input.reply.send(response);
        resolvePromise();
      },
    );
    upstream.once("error", reject);
    upstream.setTimeout(30_000, () => upstream.destroy(new Error("Gateway upstream timed out.")));
    if (body !== undefined) upstream.end(body);
    else upstream.end();
  });
}

export interface GatewayWebSocketProxyInput {
  readonly client: WebSocket;
  readonly request: FastifyRequest;
  readonly app: GatewayManagedAppRegistration;
  readonly assertion: string;
  readonly session: AuthenticatedGatewaySession;
  readonly sessionCookieName: string;
  readonly sockets: GatewayWebSocketRegistry;
  readonly logger: GatewayLogger;
}

export function proxyGatewayWebSocket(input: GatewayWebSocketProxyInput): void {
  const targetPath = upstreamPath(
    input.request.raw.url ?? input.request.url,
    input.app.routePrefix,
  );
  const headers = sanitizedUpstreamHeaders(
    input.request.headers,
    input.sessionCookieName,
    input.assertion,
  );
  delete headers["sec-websocket-key"];
  delete headers["sec-websocket-version"];
  delete headers["sec-websocket-extensions"];
  delete headers["sec-websocket-protocol"];
  const upstream = new WebSocket(upstreamWebSocketUrl(input.app, targetPath), {
    headers,
    handshakeTimeout: 10_000,
    maxPayload: 4 * 1_024 * 1_024,
    perMessageDeflate: false,
  });
  const cleanupRegistry = input.sockets.register({
    socket: input.client,
    sessionId: input.session.sessionId,
    appId: input.app.appId,
    deadline: Math.min(input.session.expiresAt, input.session.idleExpiresAt),
  });
  const pending: { data: RawData; binary: boolean }[] = [];
  let pendingBytes = 0;
  const closeBoth = (code: number, reason: string): void => {
    cleanupRegistry();
    if (input.client.readyState < input.client.CLOSING) input.client.close(code, reason);
    if (upstream.readyState < upstream.CLOSING) upstream.close(code, reason);
  };

  input.client.on("message", (data, binary) => {
    if (upstream.readyState === upstream.OPEN) {
      upstream.send(data, { binary });
      return;
    }
    pendingBytes += dataByteLength(data);
    if (pending.length >= 64 || pendingBytes > 1024 * 1024) {
      closeBoth(1009, "Gateway websocket queue exceeded");
      return;
    }
    pending.push({ data, binary });
  });
  upstream.once("open", () => {
    for (const item of pending) upstream.send(item.data, { binary: item.binary });
    pending.length = 0;
    pendingBytes = 0;
  });
  upstream.on("message", (data, binary) => {
    if (input.client.readyState === input.client.OPEN) input.client.send(data, { binary });
  });
  input.client.once("close", (code, reason) => {
    cleanupRegistry();
    if (upstream.readyState < upstream.CLOSING) {
      upstream.close(normalizeWebSocketCloseCode(code), boundedReason(reason));
    }
  });
  upstream.once("close", (code, reason) => {
    cleanupRegistry();
    if (input.client.readyState < input.client.CLOSING) {
      input.client.close(normalizeWebSocketCloseCode(code), boundedReason(reason));
    }
    input.logger.write({
      level: "info",
      event: "proxy.websocket-closed",
      appId: input.app.appId,
    });
  });
  upstream.once("error", () => {
    input.logger.write({
      level: "warn",
      event: "proxy.request-failed",
      appId: input.app.appId,
      code: "APP_UNAVAILABLE",
    });
    closeBoth(1011, "Gateway upstream unavailable");
  });
}

export function sanitizedUpstreamHeaders(
  source: IncomingHttpHeaders,
  sessionCookieName: string,
  assertion: string,
): OutgoingHttpHeaders {
  const headers: OutgoingHttpHeaders = {};
  const connectionTokens = headerTokens(source.connection);
  for (const [originalName, value] of Object.entries(source)) {
    const name = originalName.toLowerCase();
    if (
      value === undefined ||
      name === "host" ||
      HOP_BY_HOP_HEADERS.has(name) ||
      connectionTokens.has(name) ||
      isReservedIdentityHeaderName(name)
    ) {
      continue;
    }
    if (name === "cookie") {
      const sanitized = sanitizedCookieHeader(value, sessionCookieName);
      if (sanitized !== undefined) headers.cookie = sanitized;
      continue;
    }
    headers[name] = value;
  }
  headers[GATEWAY_ASSERTION_HEADER] = assertion;
  return headers;
}

function upstreamHttpOptions(
  app: GatewayManagedAppRegistration,
  path: string,
  method: string,
  headers: OutgoingHttpHeaders,
): RequestOptions {
  if (app.upstream.kind === "uds") {
    assertPrivateUnixSocket(app.upstream.socketPath);
    return { socketPath: app.upstream.socketPath, path, method, headers };
  }
  const origin = new URL(app.upstream.origin);
  return { hostname: origin.hostname, port: origin.port, path, method, headers };
}

function upstreamWebSocketUrl(app: GatewayManagedAppRegistration, path: string): string {
  if (app.upstream.kind === "uds") {
    assertPrivateUnixSocket(app.upstream.socketPath);
    return `ws+unix:${app.upstream.socketPath}:${path}`;
  }
  const target = new URL(path, app.upstream.origin);
  target.protocol = "ws:";
  return target.href;
}

function upstreamPath(rawUrl: string, routePrefix: string): string {
  const parsed = new URL(rawUrl, "http://gateway.invalid");
  if (routePrefix === "/") return `${parsed.pathname}${parsed.search}`;
  const stripped = parsed.pathname.slice(routePrefix.length);
  return `${stripped === "" ? "/" : stripped}${parsed.search}`;
}

function requestBody(value: unknown): Buffer | undefined {
  if (value === undefined || value === null) return undefined;
  if (Buffer.isBuffer(value)) return value;
  throw new GatewayError("REQUEST_INVALID", 400, "Gateway proxy body must be bytes.");
}

function sanitizedCookieHeader(
  value: string | readonly string[],
  sessionCookieName: string,
): string | undefined {
  const combined = typeof value === "string" ? value : [...value].join("; ");
  const kept = combined
    .split(";")
    .map((cookie) => cookie.trim())
    .filter((cookie) => cookie.length > 0 && cookie.split("=", 1)[0] !== sessionCookieName);
  return kept.length === 0 ? undefined : kept.join("; ");
}

function cookieName(setCookie: string): string {
  return setCookie.split(";", 1)[0]?.split("=", 1)[0]?.trim() ?? "";
}

function headerTokens(value: string | undefined): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((token) => token.trim().toLowerCase())
      .filter(Boolean),
  );
}

function dataByteLength(data: RawData): number {
  if (Array.isArray(data)) return data.reduce((total, item) => total + item.byteLength, 0);
  return data.byteLength;
}

function boundedReason(reason: Buffer): string {
  return reason.subarray(0, 120).toString("utf8");
}

export function normalizeWebSocketCloseCode(code: number): number {
  const protocolCode = code >= 1_000 && code <= 1_014;
  const reservedCode = code === 1_004 || code === 1_005 || code === 1_006;
  return (protocolCode && !reservedCode) || (code >= 3_000 && code <= 4_999) ? code : 1_011;
}
