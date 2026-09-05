import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { connect } from "node:net";
import { dirname } from "node:path";
import type { Duplex } from "node:stream";
import {
  DURABLE_SESSION_PROTOCOL_VERSION,
  DurableSessionCallerContextSchema,
  DurableSessionOperationRequestSchema,
  type DurableSessionOperationResponse,
} from "@naru/contracts/durable-session/v0";
import { z } from "zod";
import type { HostAppRegistry } from "./app-registry.js";
import { HostOperationError } from "./host-error.js";
import type { HostLogger } from "./logging.js";
import { silentHostLogger } from "./logging.js";
import type { HostClock, SessionService } from "./session-service.js";
import { SystemHostClock } from "./session-service.js";
import { currentUid, ensurePrivateDirectory } from "./security.js";
import { HostStreamSession } from "./stream-session.js";

const require = createRequire(import.meta.url);

const OperationEnvelopeSchema = z.strictObject({
  callerContext: DurableSessionCallerContextSchema,
  request: DurableSessionOperationRequestSchema,
});

export interface HostTransportOptions {
  readonly socketPath: string;
  readonly requestBodyBytes: number;
  readonly maxConcurrentRequests: number;
  readonly maxConcurrentStreams: number;
  readonly appRegistry: HostAppRegistry;
  readonly service: SessionService;
  readonly clock?: HostClock;
  readonly logger?: HostLogger;
}

export class HostTransportServer {
  readonly #socketPath: string;
  readonly #requestBodyBytes: number;
  readonly #maxConcurrentRequests: number;
  readonly #maxConcurrentStreams: number;
  readonly #appRegistry: HostAppRegistry;
  readonly #service: SessionService;
  readonly #clock: HostClock;
  readonly #logger: HostLogger;
  readonly #server: Server;
  readonly #streams = new Set<{
    readonly socket: RawWebSocket;
    readonly session: HostStreamSession;
  }>();
  #webSocketServer: RawWebSocketServer | null = null;
  #listening = false;
  #activeRequests = 0;
  #closing = false;

  constructor(options: HostTransportOptions) {
    this.#socketPath = options.socketPath;
    this.#requestBodyBytes = options.requestBodyBytes;
    this.#maxConcurrentRequests = options.maxConcurrentRequests;
    this.#maxConcurrentStreams = options.maxConcurrentStreams;
    this.#appRegistry = options.appRegistry;
    this.#service = options.service;
    this.#clock = options.clock ?? new SystemHostClock();
    this.#logger = options.logger ?? silentHostLogger;
    this.#server = createServer((request, response) => {
      if (this.#activeRequests >= this.#maxConcurrentRequests) {
        writeTransportError(response, 503, "HOST_BUSY", "Host request limit was reached.");
        return;
      }
      this.#activeRequests += 1;
      void this.#handle(request, response)
        .catch(() => {
          if (!response.headersSent) {
            writeTransportError(response, 500, "INTERNAL_ERROR", "Host transport failed.");
          } else response.destroy();
        })
        .finally(() => {
          this.#activeRequests -= 1;
        });
    });
    this.#server.maxHeadersCount = 32;
    this.#server.requestTimeout = 30_000;
    this.#server.headersTimeout = 10_000;
    this.#server.keepAliveTimeout = 5_000;
    this.#server.on("upgrade", (request, socket, head) => {
      this.#handleUpgrade(request, socket, head);
    });
  }

  async listen(): Promise<void> {
    if (this.#listening) return;
    ensurePrivateDirectory(dirname(this.#socketPath));
    await prepareSocketPath(this.#socketPath);
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.#socketPath, () => {
        this.#server.off("error", onError);
        resolvePromise();
      });
    });
    chmodSync(this.#socketPath, 0o600);
    assertPrivateSocket(this.#socketPath);
    this.#listening = true;
  }

  async close(): Promise<void> {
    if (!this.#listening) return;
    this.#closing = true;
    const streams = [...this.#streams];
    for (const { socket } of streams) {
      socket.close(1001, "DurableSession Host is stopping.");
      socket.terminate();
    }
    await Promise.all(streams.map(({ session }) => session.close()));
    this.#streams.clear();
    this.#webSocketServer?.close();
    const serverClosed = new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    this.#server.closeAllConnections();
    await serverClosed;
    this.#listening = false;
    if (existsSync(this.#socketPath)) {
      assertPrivateSocket(this.#socketPath);
      unlinkSync(this.#socketPath);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");

    if (request.method === "GET" && request.url === "/healthz") {
      writeJson(response, 200, {
        version: 1,
        status: "ok",
        protocolVersion: DURABLE_SESSION_PROTOCOL_VERSION,
      });
      return;
    }
    if (request.method === "GET" && request.url === "/readyz") {
      const ready = this.#service.ready;
      writeJson(response, ready ? 200 : 503, {
        version: 1,
        status: ready ? "ready" : "not-ready",
        checks: { metadata: ready, operations: ready },
      });
      return;
    }
    if (request.method !== "POST" || request.url !== "/v0/operations") {
      writeTransportError(response, 404, "REQUEST_INVALID", "Host endpoint was not found.");
      return;
    }
    if (!isJsonContentType(request.headers["content-type"])) {
      writeTransportError(
        response,
        415,
        "REQUEST_INVALID",
        "Content-Type must be application/json.",
      );
      return;
    }

    let body: unknown;
    try {
      body = JSON.parse(await readRequestBody(request, this.#requestBodyBytes)) as unknown;
    } catch (error) {
      const code = error instanceof BodyTooLargeError ? 413 : 400;
      writeTransportError(
        response,
        code,
        "REQUEST_INVALID",
        code === 413 ? "Host request body is too large." : "Host request body is invalid JSON.",
      );
      return;
    }
    const parsed = OperationEnvelopeSchema.safeParse(body);
    if (!parsed.success) {
      writeTransportError(response, 400, "REQUEST_INVALID", "Host operation envelope is invalid.");
      return;
    }

    const appId = singleHeader(request.headers["x-durable-session-app-id"]);
    const credential = bearerCredential(singleHeader(request.headers.authorization));
    if (appId === null || credential === null) {
      writePublicResponse(
        response,
        failure(
          parsed.data.request.requestId,
          "CAPABILITY_REQUIRED",
          "Host app credential is required.",
        ),
      );
      return;
    }
    try {
      const authenticated = this.#appRegistry.authenticateOperation(
        appId,
        credential,
        parsed.data.callerContext,
        this.#clock.nowMs(),
      );
      try {
        writePublicResponse(
          response,
          await this.#service.execute(authenticated.caller, parsed.data.request, {
            integrationBootstrapKey: authenticated.integrationBootstrapKey,
          }),
        );
      } finally {
        authenticated.integrationBootstrapKey.fill(0);
      }
    } catch (error) {
      const normalized =
        error instanceof HostOperationError
          ? error
          : new HostOperationError("INTERNAL_ERROR", "Host authentication failed.", randomUUID());
      this.#logger.write({
        level: normalized.code === "INTERNAL_ERROR" ? "error" : "warn",
        event: normalized.code === "INTERNAL_ERROR" ? "transport.error" : "request.denied",
        code: normalized.code,
        ...(normalized.diagnosticId === undefined ? {} : { diagnosticId: normalized.diagnosticId }),
      });
      writePublicResponse(
        response,
        failure(
          parsed.data.request.requestId,
          normalized.code,
          normalized.message,
          normalized.diagnosticId,
        ),
      );
    }
  }

  #handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer): void {
    if (
      this.#closing ||
      request.method !== "GET" ||
      request.url !== "/v0/stream" ||
      this.#streams.size >= this.#maxConcurrentStreams
    ) {
      rejectUpgrade(socket, this.#streams.size >= this.#maxConcurrentStreams ? 503 : 404);
      return;
    }
    const appId = singleHeader(request.headers["x-durable-session-app-id"]);
    const credential = bearerCredential(singleHeader(request.headers.authorization));
    if (appId === null || credential === null) {
      rejectUpgrade(socket, 401);
      return;
    }

    let server: RawWebSocketServer;
    try {
      server = this.#webSocketServer ??= createWebSocketServer(this.#requestBodyBytes);
    } catch {
      rejectUpgrade(socket, 503);
      return;
    }
    server.handleUpgrade(request, socket, head, (webSocket) => {
      const session = new HostStreamSession({
        appId,
        credential,
        appRegistry: this.#appRegistry,
        service: this.#service,
        clock: this.#clock,
        sink: {
          send: (frame) => sendWebSocketJson(webSocket, frame),
          close: (code, reason) => webSocket.close(code, reason),
        },
      });
      const connection = { socket: webSocket, session };
      this.#streams.add(connection);
      webSocket.on("message", (data, isBinary) => {
        if (isBinary || data.byteLength > this.#requestBodyBytes) {
          webSocket.close(1009, "Host stream frame is too large or binary.");
          void session.close();
          return;
        }
        let frame: unknown;
        try {
          frame = JSON.parse(data.toString("utf8")) as unknown;
        } catch {
          webSocket.close(1008, "Host stream frame is invalid JSON.");
          void session.close();
          return;
        }
        void session.receive(frame).catch(() => webSocket.close(1011, "Host stream failed."));
      });
      webSocket.on("close", () => {
        this.#streams.delete(connection);
        void session.close();
      });
      webSocket.on("error", () => {
        this.#streams.delete(connection);
        void session.close();
      });
    });
  }
}

interface RawWebSocket {
  send(data: string, callback: (error?: Error | null) => void): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "message", listener: (data: Buffer, isBinary: boolean) => void): void;
  on(event: "close" | "error", listener: () => void): void;
}

interface RawWebSocketServer {
  handleUpgrade(
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    callback: (socket: RawWebSocket) => void,
  ): void;
  close(): void;
}

function createWebSocketServer(maxPayload: number): RawWebSocketServer {
  const module = require("ws") as {
    WebSocketServer: new (options: {
      readonly noServer: true;
      readonly maxPayload: number;
      readonly perMessageDeflate: false;
      readonly clientTracking: false;
    }) => RawWebSocketServer;
  };
  return new module.WebSocketServer({
    noServer: true,
    maxPayload,
    perMessageDeflate: false,
    clientTracking: false,
  });
}

function sendWebSocketJson(socket: RawWebSocket, frame: unknown): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    socket.send(JSON.stringify(frame), (error) => {
      if (error == null) resolvePromise();
      else reject(error);
    });
  });
}

function rejectUpgrade(socket: Duplex, statusCode: 401 | 404 | 503): void {
  const status =
    statusCode === 401
      ? "401 Unauthorized"
      : statusCode === 503
        ? "503 Service Unavailable"
        : "404 Not Found";
  socket.end(
    `HTTP/1.1 ${status}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Length: 0\r\n\r\n`,
  );
}

function failure(
  requestId: string,
  code: HostOperationError["code"],
  message: string,
  diagnosticId?: string,
): DurableSessionOperationResponse {
  return {
    version: 0,
    requestId,
    ok: false,
    error: { code, message, ...(diagnosticId === undefined ? {} : { diagnosticId }) },
  };
}

function writePublicResponse(response: ServerResponse, payload: DurableSessionOperationResponse) {
  writeJson(response, 200, payload);
}

function writeTransportError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  message: string,
): void {
  writeJson(response, statusCode, { version: 1, ok: false, error: { code, message } });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

function isJsonContentType(value: string | undefined): boolean {
  return value?.split(";", 1)[0]?.trim().toLowerCase() === "application/json";
}

function singleHeader(value: string | readonly string[] | undefined): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function bearerCredential(value: string | null): string | null {
  if (value === null) return null;
  const match = /^Bearer ([^\s]{32,1024})$/.exec(value);
  return match?.[1] ?? null;
}

async function readRequestBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw new BodyTooLargeError();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) throw new BodyTooLargeError();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

class BodyTooLargeError extends Error {}

async function prepareSocketPath(path: string): Promise<void> {
  if (!existsSync(path)) return;
  assertPrivateSocket(path);
  if (await socketAcceptsConnections(path)) {
    throw new Error("DurableSession Host socket is already active.");
  }
  unlinkSync(path);
}

function assertPrivateSocket(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error("Host socket path is not a Unix socket.");
  }
  if (metadata.uid !== currentUid()) throw new Error("Host socket has the wrong owner.");
  if ((metadata.mode & 0o077) !== 0) throw new Error("Host socket must be mode 0600 or stricter.");
}

function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise((resolvePromise) => {
    const socket = connect(path);
    socket.once("connect", () => {
      socket.destroy();
      resolvePromise(true);
    });
    socket.once("error", () => resolvePromise(false));
  });
}
