import {
  createServer,
  request as httpRequest,
  type IncomingMessage,
  type OutgoingHttpHeaders,
  type ServerResponse,
} from "node:http";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join, extname, isAbsolute } from "node:path";
import { WORKSTATION_GATEWAY_ASSERTION_HEADER } from "@naru/contracts/workstation-gateway/v1";
import { verifyGatewayAssertion, InMemoryGatewayReplayStore } from "@naru/gateway-verifier";
import WebSocket, { WebSocketServer } from "ws";
import type { KeyObject } from "node:crypto";
import { isContained, type OpenCodeGatewayConfig } from "./config.js";

const TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".wasm": "application/wasm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
};
const HOP_HEADERS = new Set([
  "connection",
  "upgrade",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "proxy-authorization",
  "proxy-authenticate",
]);

export interface OpenCodeGatewayOptions {
  readonly config: OpenCodeGatewayConfig;
  readonly keys: ReadonlyMap<string, KeyObject>;
  readonly password: string;
}

export function createOpenCodeGateway(options: OpenCodeGatewayOptions) {
  const { config } = options;
  const replayStore = new InMemoryGatewayReplayStore();
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 4 * 1024 * 1024,
    perMessageDeflate: false,
  });
  const authenticate = (request: IncomingMessage): void => {
    if (request.headers.origin !== undefined && request.headers.origin !== config.browserOrigin)
      throw new HttpFailure(403, "ORIGIN_DENIED");
    const assertion = request.headers[WORKSTATION_GATEWAY_ASSERTION_HEADER];
    if (typeof assertion !== "string") throw new HttpFailure(401, "AUTH_REQUIRED");
    try {
      const result = verifyGatewayAssertion(assertion, {
        expectedIssuer: config.issuer,
        expectedAudience: config.audience,
        expectedOrigin: config.browserOrigin,
        resolveKey: (id) => options.keys.get(id),
        replayStore,
      });
      if (result.principal.sub !== config.ownerSubject) throw new Error("Owner mismatch.");
    } catch {
      throw new HttpFailure(401, "AUTH_REQUIRED");
    }
  };
  const headers = (request: IncomingMessage): OutgoingHttpHeaders => {
    const out: OutgoingHttpHeaders = {};
    const connection = new Set(
      (request.headers.connection ?? "").split(",").map((item) => item.trim().toLowerCase()),
    );
    for (const [name, value] of Object.entries(request.headers)) {
      if (
        HOP_HEADERS.has(name) ||
        connection.has(name) ||
        name === "host" ||
        name === "cookie" ||
        name === "authorization" ||
        name.startsWith("x-workstation-") ||
        name.startsWith("x-forwarded-") ||
        name === "forwarded"
      )
        continue;
      out[name] = value;
    }
    out.authorization = `Basic ${Buffer.from(`opencode:${options.password}`).toString("base64")}`;
    if (request.headers.origin !== undefined) out.origin = config.browserOrigin;
    return out;
  };
  const server = createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      const failure =
        error instanceof HttpFailure ? error : new HttpFailure(502, "APP_UNAVAILABLE");
      if (response.headersSent) {
        response.destroy();
        return;
      }
      response.writeHead(failure.status, {
        "content-type": "application/json",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ error: { code: failure.code } }));
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.on("upgrade", (request, socket, head) => {
    void (async () => {
      authenticate(request);
      const url = apiURL(request, config);
      await requireAllowedDirectory(request, url, config);
      const upstreamHeaders = headers(request);
      for (const name of [
        "sec-websocket-key",
        "sec-websocket-version",
        "sec-websocket-protocol",
        "sec-websocket-extensions",
      ])
        delete upstreamHeaders[name];
      sockets.handleUpgrade(request, socket, head, (client) => {
        const upstreamURL = new URL(url);
        upstreamURL.protocol = "ws:";
        const upstream = new WebSocket(upstreamURL, {
          headers: upstreamHeaders,
          handshakeTimeout: 10_000,
          maxPayload: 4 * 1024 * 1024,
          perMessageDeflate: false,
        });
        const pending: { data: Buffer; binary: boolean }[] = [];
        let bytes = 0;
        const close = (code: number): void => {
          for (const connection of [client, upstream])
            if (connection.readyState < WebSocket.CLOSING) connection.close(code);
        };
        client.on("message", (data, binary) => {
          const buffer = Array.isArray(data)
            ? Buffer.concat(data)
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : data;
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(buffer, { binary });
            return;
          }
          bytes += buffer.length;
          if (pending.length >= 64 || bytes > 1024 * 1024) {
            close(1009);
            return;
          }
          pending.push({ data: buffer, binary });
        });
        upstream.once("open", () => {
          for (const item of pending) upstream.send(item.data, { binary: item.binary });
          pending.length = 0;
        });
        upstream.on("message", (data, binary) => {
          if (client.readyState === WebSocket.OPEN) client.send(data, { binary });
        });
        client.once("close", () => close(1000));
        upstream.once("close", () => close(1000));
        client.once("error", () => close(1011));
        upstream.once("error", () => close(1011));
      });
    })().catch((error: unknown) => {
      const status = error instanceof HttpFailure ? error.status : 502;
      socket.end(`HTTP/1.1 ${status} Denied\r\nConnection: close\r\n\r\n`);
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const parsed = new URL(request.url ?? "/", "http://adapter.invalid");
    if (parsed.pathname === "/_adapter/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end('{"healthy":true}');
      return;
    }
    authenticate(request);
    if (parsed.pathname === "/api/_naru/project-roots" && request.method === "GET") {
      for (const root of config.allowedProjectRoots) await requireDirectory(root, config);
      await requireDirectory(config.defaultDirectory, config);
      response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(
        JSON.stringify({
          version: 1,
          defaultDirectory: config.defaultDirectory,
          roots: config.allowedProjectRoots,
        }),
      );
      return;
    }
    if (parsed.pathname === "/api" || parsed.pathname.startsWith("/api/")) {
      const url = apiURL(request, config);
      await requireAllowedDirectory(request, url, config);
      const body = await readBody(request);
      if (body.length > 0 && request.headers["content-type"]?.includes("application/json")) {
        let value: unknown;
        try {
          value = JSON.parse(body.toString("utf8")) as unknown;
        } catch {
          throw new HttpFailure(400, "REQUEST_INVALID");
        }
        if (
          typeof value === "object" &&
          value !== null &&
          "directory" in value &&
          typeof value.directory === "string"
        )
          await requireDirectory(value.directory, config);
        if (
          typeof value === "object" &&
          value !== null &&
          "location" in value &&
          typeof value.location === "object" &&
          value.location !== null &&
          "directory" in value.location &&
          typeof value.location.directory === "string"
        )
          await requireDirectory(value.location.directory, config);
      }
      const upstreamHeaders = headers(request);
      delete upstreamHeaders["content-length"];
      if (body.length > 0) upstreamHeaders["content-length"] = String(body.length);
      await new Promise<void>((resolve, reject) => {
        const upstream = httpRequest(
          url,
          { method: request.method, headers: upstreamHeaders },
          (result) => {
            response.statusCode = result.statusCode ?? 502;
            for (const [name, value] of Object.entries(result.headers)) {
              if (
                value !== undefined &&
                !HOP_HEADERS.has(name) &&
                name !== "set-cookie" &&
                name !== "access-control-allow-origin" &&
                name !== "www-authenticate"
              )
                response.setHeader(name, value);
            }
            result.once("error", reject);
            result.once("end", resolve);
            result.pipe(response);
          },
        );
        upstream.once("error", reject);
        request.once("aborted", () => upstream.destroy());
        response.once("close", () => upstream.destroy());
        upstream.end(body);
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD")
      throw new HttpFailure(405, "METHOD_DENIED");
    let pathname: string;
    try {
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      throw new HttpFailure(400, "PATH_DENIED");
    }
    if (pathname.includes("\0") || pathname.includes("\\") || pathname.split("/").includes(".."))
      throw new HttpFailure(400, "PATH_DENIED");
    let filename = join(config.uiRoot, pathname);
    let metadata;
    try {
      filename = await realpath(filename);
      metadata = await stat(filename);
    } catch {
      if (pathname.startsWith("/assets/") || extname(pathname))
        throw new HttpFailure(404, "NOT_FOUND");
      filename = join(config.uiRoot, "index.html");
      metadata = await stat(filename);
    }
    if (metadata.isDirectory()) {
      filename = join(config.uiRoot, "index.html");
      metadata = await stat(filename);
    }
    if (!isContained(config.uiRoot, await realpath(filename)) || !metadata.isFile())
      throw new HttpFailure(403, "PATH_DENIED");
    response.writeHead(200, {
      "content-type": TYPES[extname(filename)] ?? "application/octet-stream",
      "content-length": String(metadata.size),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    if (request.method === "HEAD") response.end();
    else createReadStream(filename).pipe(response);
  }
  return {
    server,
    async close(): Promise<void> {
      for (const socket of sockets.clients) socket.terminate();
      sockets.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function apiURL(request: IncomingMessage, config: OpenCodeGatewayConfig): URL {
  const url = new URL(request.url ?? "/", "http://adapter.invalid");
  if (!url.pathname.startsWith("/api/")) throw new HttpFailure(404, "NOT_FOUND");
  const upstream = new URL(`http://127.0.0.1:${config.upstreamPort}`);
  upstream.pathname = url.pathname.slice(4);
  upstream.search = url.search;
  if (upstream.searchParams.has("auth_token")) throw new HttpFailure(400, "AUTH_TOKEN_DENIED");
  return upstream;
}

async function requireAllowedDirectory(
  request: IncomingMessage,
  url: URL,
  config: OpenCodeGatewayConfig,
): Promise<void> {
  const header = request.headers["x-opencode-directory"];
  let headerDirectory: string | null = null;
  try {
    if (typeof header === "string") headerDirectory = decodeURIComponent(header);
  } catch {
    throw new HttpFailure(403, "PROJECT_DENIED");
  }
  const candidates = [
    ...url.searchParams.getAll("directory"),
    ...url.searchParams.getAll("location[directory]"),
    headerDirectory,
  ].filter((value): value is string => value !== null);
  for (const candidate of candidates) {
    await requireDirectory(candidate, config);
  }
  for (const path of url.searchParams.getAll("path")) {
    if (path.includes("\0")) throw new HttpFailure(403, "PROJECT_DENIED");
    await requireDirectory(
      isAbsolute(path) ? path : join(candidates[0] ?? config.defaultDirectory, path),
      config,
    );
  }
}

async function requireDirectory(candidate: string, config: OpenCodeGatewayConfig): Promise<void> {
  if (!isAbsolute(candidate) || candidate.includes("\0"))
    throw new HttpFailure(403, "PROJECT_DENIED");
  let actual: string;
  try {
    actual = await realpath(candidate);
  } catch {
    throw new HttpFailure(403, "PROJECT_DENIED");
  }
  if (!config.allowedProjectRoots.some((root) => isContained(root, actual)))
    throw new HttpFailure(403, "PROJECT_DENIED");
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const value of request) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value as Uint8Array);
    bytes += chunk.length;
    if (bytes > 4 * 1024 * 1024) throw new HttpFailure(413, "REQUEST_TOO_LARGE");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

class HttpFailure extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}
