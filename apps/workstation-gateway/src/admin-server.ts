import { existsSync, chmodSync, lstatSync, unlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect } from "node:net";
import { dirname } from "node:path";
import type { GatewayAppRegistry } from "./app-registry.js";
import type { WorkstationGatewayConfig } from "./config.js";
import { GatewayError, internalGatewayError } from "./gateway-error.js";
import type { GatewayVerifierKey } from "./keys.js";
import type { GatewayPasskeyManager } from "./passkeys.js";
import { currentUid, ensurePrivateDirectory } from "./security.js";
import type { GatewaySessionStore } from "./sessions.js";

const ADMIN_BODY_BYTES = 16 * 1_024;

export interface GatewayAdminServerOptions {
  readonly config: WorkstationGatewayConfig;
  readonly registry: GatewayAppRegistry;
  readonly passkeys: GatewayPasskeyManager;
  readonly sessions: GatewaySessionStore;
  readonly verifierKey: GatewayVerifierKey;
  readonly ready: () => boolean;
  readonly onSessionsRevoked: (sessionIds: readonly string[]) => void;
}

export class GatewayAdminServer {
  readonly #server: Server;
  #listening = false;

  constructor(private readonly options: GatewayAdminServerOptions) {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response).catch(() => {
        if (!response.headersSent) writeError(response, internalGatewayError());
        else response.destroy();
      });
    });
    this.#server.maxHeadersCount = 32;
    this.#server.requestTimeout = 15_000;
    this.#server.headersTimeout = 5_000;
    this.#server.keepAliveTimeout = 2_000;
  }

  async listen(): Promise<void> {
    if (this.#listening) return;
    ensurePrivateDirectory(dirname(this.options.config.adminSocketPath));
    await prepareAdminSocketPath(this.options.config.adminSocketPath);
    await new Promise<void>((resolvePromise, reject) => {
      const onError = (error: Error): void => reject(error);
      this.#server.once("error", onError);
      this.#server.listen(this.options.config.adminSocketPath, () => {
        this.#server.off("error", onError);
        resolvePromise();
      });
    });
    chmodSync(this.options.config.adminSocketPath, 0o600);
    assertPrivateSocket(this.options.config.adminSocketPath);
    this.#listening = true;
  }

  async close(): Promise<void> {
    if (!this.#listening) return;
    await new Promise<void>((resolvePromise, reject) => {
      this.#server.close((error) => {
        if (error) reject(error);
        else resolvePromise();
      });
    });
    this.#listening = false;
    if (existsSync(this.options.config.adminSocketPath)) {
      assertPrivateSocket(this.options.config.adminSocketPath);
      unlinkSync(this.options.config.adminSocketPath);
    }
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader("cache-control", "no-store");
    response.setHeader("content-type", "application/json; charset=utf-8");
    try {
      if (request.method === "GET" && request.url === "/healthz") {
        writeJson(response, 200, { version: 1, status: "ok" });
        return;
      }
      if (request.method === "GET" && request.url === "/readyz") {
        const ready = this.options.ready();
        writeJson(response, ready ? 200 : 503, {
          version: 1,
          status: ready ? "ready" : "not-ready",
        });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/apps") {
        writeJson(response, 200, { version: 1, apps: this.options.registry.list() });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/credentials") {
        writeJson(response, 200, {
          version: 1,
          credentials: this.options.passkeys.listCredentials(),
        });
        return;
      }
      if (request.method === "GET" && request.url === "/v1/verifier-keys") {
        writeJson(response, 200, { version: 1, keys: [this.options.verifierKey] });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/auth/bootstrap") {
        await requireEmptyJsonBody(request);
        writeJson(response, 201, {
          version: 1,
          intent: this.options.passkeys.createBootstrapIntent("bootstrap"),
        });
        return;
      }
      if (request.method === "POST" && request.url === "/v1/auth/recover") {
        await requireEmptyJsonBody(request);
        writeJson(response, 201, {
          version: 1,
          intent: this.options.passkeys.createBootstrapIntent("recovery"),
        });
        return;
      }
      const revokeMatch =
        request.method === "POST"
          ? /^\/v1\/credentials\/([0-9a-f]{8}-[0-9a-f-]{27,})\/revoke$/.exec(request.url ?? "")
          : null;
      if (revokeMatch !== null) {
        await requireEmptyJsonBody(request);
        const credentialRecordId = revokeMatch[1];
        if (credentialRecordId === undefined) throw invalidAdminRequest();
        const revocation = this.options.sessions.revokeCredential(credentialRecordId);
        this.options.onSessionsRevoked(revocation.sessionIds);
        writeJson(response, 200, {
          version: 1,
          revoked: revocation.credentialRevoked,
          sessionsClosed: revocation.sessionIds.length,
        });
        return;
      }
      throw new GatewayError("REQUEST_INVALID", 404, "Gateway admin endpoint was not found.");
    } catch (error) {
      writeError(response, error instanceof GatewayError ? error : internalGatewayError());
    }
  }
}

async function requireEmptyJsonBody(request: IncomingMessage): Promise<void> {
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    throw new GatewayError("REQUEST_INVALID", 415, "Content-Type must be application/json.");
  }
  const source = await readRequestBody(request, ADMIN_BODY_BYTES);
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw invalidAdminRequest();
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 0
  ) {
    throw invalidAdminRequest();
  }
}

async function readRequestBody(request: IncomingMessage, limit: number): Promise<string> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > limit) throw invalidAdminRequest();
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) throw invalidAdminRequest();
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function prepareAdminSocketPath(path: string): Promise<void> {
  if (!existsSync(path)) return;
  assertPrivateSocket(path);
  if (await socketAcceptsConnections(path)) {
    throw new Error("Workstation Gateway admin socket is already active.");
  }
  unlinkSync(path);
}

function assertPrivateSocket(path: string): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isSocket()) {
    throw new Error("Gateway admin socket path is not a Unix socket.");
  }
  if (stat.uid !== currentUid() || (stat.mode & 0o177) !== 0) {
    throw new Error("Gateway admin socket has an unsafe owner or mode.");
  }
}

async function socketAcceptsConnections(path: string): Promise<boolean> {
  return new Promise<boolean>((resolvePromise) => {
    const socket = connect(path);
    const finish = (active: boolean): void => {
      socket.removeAllListeners();
      socket.destroy();
      resolvePromise(active);
    };
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.setTimeout(500, () => finish(false));
  });
}

function writeError(response: ServerResponse, error: GatewayError): void {
  writeJson(response, error.statusCode, {
    version: 1,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      ...(error.diagnosticId === undefined ? {} : { diagnosticId: error.diagnosticId }),
    },
  });
}

function writeJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.end(JSON.stringify(payload));
}

function invalidAdminRequest(): GatewayError {
  return new GatewayError("REQUEST_INVALID", 400, "Gateway admin request is invalid.");
}
