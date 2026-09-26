import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ClaudeActivityEventSchema, type ClaudeActivityEvent } from "./claude-activity-events.js";
import { CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS } from "./claude-activity-hook-client.js";
import {
  CodexHookEventSchema,
  type CodexHookEvent,
  type CodexSessionHookSource,
} from "./integrations/codex/events.js";

export type { CodexHookEvent, CodexSessionHookSource } from "./integrations/codex/events.js";

const SOCKET_FILENAME = "codex-hook.sock";
const SOCKET_PATH_MAX_BYTES = 100;
const MAX_MESSAGE_BYTES = 16 * 1024;
const CONNECTION_TIMEOUT_MS = 3_000;
const TOKEN_BYTES = 32;

export const CODEX_SESSION_HOOK_COMMAND = '"$NARU_CODEX_HOOK_RUNNER" "$NARU_CODEX_HOOK_ENTRY"';

export const CODEX_SESSION_HOOK_ENVIRONMENT_KEYS = {
  bootstrap: "NARU_CODEX_HOOK_BOOTSTRAP",
  entry: "NARU_CODEX_HOOK_ENTRY",
  paneId: "NARU_CODEX_HOOK_PANE_ID",
  runner: "NARU_CODEX_HOOK_RUNNER",
  runtimeId: "NARU_CODEX_HOOK_RUNTIME_ID",
  socket: "NARU_CODEX_HOOK_SOCKET",
  token: "NARU_CODEX_HOOK_TOKEN",
} as const;

const HookMessageSchema = z
  .object({
    version: z.literal(2),
    paneId: z.string().uuid(),
    runtimeId: z.string().uuid(),
    token: z.string().min(32).max(128),
    event: CodexHookEventSchema,
  })
  .strict();

const ClaudeHookMessageSchema = z.strictObject({
  version: z.literal(3),
  paneId: z.string().uuid(),
  runtimeId: z.string().uuid(),
  token: z.string().min(32).max(128),
  event: ClaudeActivityEventSchema,
});

export interface CodexSessionHookEvent {
  readonly sessionId: string;
  readonly source: CodexSessionHookSource;
}

export interface CodexSessionHookRegistration {
  readonly environment: Readonly<Record<string, string>>;
  dispose(): void;
}

export interface CodexSessionHookBridge {
  register(options: {
    paneId: string;
    runtimeId: string;
    cwd: string;
    onEvent: (event: CodexHookEvent) => void;
  }): CodexSessionHookRegistration;
  registerClaude?(options: {
    paneId: string;
    runtimeId: string;
    cwd: string;
    onEvent: (event: ClaudeActivityEvent) => void;
  }): CodexSessionHookRegistration;
  close(): Promise<void>;
}

interface RegistrationRecord {
  readonly paneId: string;
  readonly runtimeId: string;
  readonly cwd: string;
  readonly token: string;
  readonly onEvent: (event: CodexHookEvent) => void;
}

interface ClaudeRegistrationRecord {
  readonly paneId: string;
  readonly runtimeId: string;
  readonly cwd: string;
  readonly token: string;
  readonly onEvent: (event: ClaudeActivityEvent) => void;
}

interface SocketIdentity {
  readonly device: number;
  readonly inode: number;
}

export interface CodexSessionHookServerOptions {
  readonly dataDirectory: string;
  readonly runner: string;
  readonly entrypoint: string;
  readonly claudeEntrypoint?: string;
}

/**
 * Receives only bounded lifecycle identifiers over a private local socket. Pane and
 * runtime capabilities are short-lived and never written to SQLite or logs.
 */
export class CodexSessionHookServer implements CodexSessionHookBridge {
  readonly #runtimeDirectory: string;
  readonly #socketPath: string;
  readonly #runner: string;
  readonly #entrypoint: string;
  readonly #claudeEntrypoint: string | undefined;
  readonly #registrations = new Map<string, RegistrationRecord>();
  readonly #claudeRegistrations = new Map<string, ClaudeRegistrationRecord>();
  readonly #connections = new Set<Socket>();
  #server: Server | null = null;
  #socketIdentity: SocketIdentity | null = null;

  constructor(options: CodexSessionHookServerOptions) {
    const dataRuntimeDirectory = join(options.dataDirectory, "runtime");
    const dataSocketPath = join(dataRuntimeDirectory, SOCKET_FILENAME);
    this.#runtimeDirectory =
      Buffer.byteLength(dataSocketPath) <= SOCKET_PATH_MAX_BYTES
        ? dataRuntimeDirectory
        : shortRuntimeDirectory(options.dataDirectory);
    this.#socketPath = join(this.#runtimeDirectory, SOCKET_FILENAME);
    this.#runner = options.runner;
    this.#entrypoint = options.entrypoint;
    this.#claudeEntrypoint = options.claudeEntrypoint;
    if (Buffer.byteLength(this.#socketPath) > SOCKET_PATH_MAX_BYTES) {
      throw new Error("Naru data directory is too long for the Codex hook socket.");
    }
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    await mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    await requirePrivateRuntimeDirectory(this.#runtimeDirectory);
    await removeStaleSocket(this.#socketPath);

    const server = createServer((socket) => this.#acceptConnection(socket));
    await listenOnSocket(server, this.#socketPath);
    try {
      await chmod(this.#socketPath, 0o600);
      const metadata = await lstat(this.#socketPath);
      if (!metadata.isSocket() || (metadata.mode & 0o777) !== 0o600) {
        throw new Error("Codex hook socket is not a private Unix socket.");
      }
      this.#socketIdentity = { device: metadata.dev, inode: metadata.ino };
      this.#server = server;
    } catch (error) {
      await closeServer(server);
      await unlinkOwnedSocket(this.#socketPath);
      throw error;
    }
  }

  register(options: {
    paneId: string;
    runtimeId: string;
    cwd: string;
    onEvent: (event: CodexHookEvent) => void;
  }): CodexSessionHookRegistration {
    if (this.#server === null) throw new Error("Codex session hook server is not running.");
    if (this.#registrations.has(options.paneId) || this.#claudeRegistrations.has(options.paneId)) {
      throw new Error("A hook capability already exists for this Pane.");
    }
    const record: RegistrationRecord = {
      ...options,
      token: randomBytes(TOKEN_BYTES).toString("base64url"),
    };
    this.#registrations.set(options.paneId, record);
    let disposed = false;
    return {
      environment: {
        [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.entry]: this.#entrypoint,
        [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.paneId]: record.paneId,
        [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.runner]: this.#runner,
        [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.runtimeId]: record.runtimeId,
        [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.socket]: this.#socketPath,
        [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.token]: record.token,
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.#registrations.get(record.paneId) === record) {
          this.#registrations.delete(record.paneId);
        }
      },
    };
  }

  registerClaude(options: {
    paneId: string;
    runtimeId: string;
    cwd: string;
    onEvent: (event: ClaudeActivityEvent) => void;
  }): CodexSessionHookRegistration {
    if (this.#server === null || this.#claudeEntrypoint === undefined) {
      throw new Error("Claude activity hook server is not configured.");
    }
    if (this.#registrations.has(options.paneId) || this.#claudeRegistrations.has(options.paneId)) {
      throw new Error("A hook capability already exists for this Pane.");
    }
    const record: ClaudeRegistrationRecord = {
      ...options,
      token: randomBytes(TOKEN_BYTES).toString("base64url"),
    };
    this.#claudeRegistrations.set(record.paneId, record);
    let disposed = false;
    return {
      environment: {
        [CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.entry]: this.#claudeEntrypoint,
        [CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.paneId]: record.paneId,
        [CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.runner]: this.#runner,
        [CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.runtimeId]: record.runtimeId,
        [CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.socket]: this.#socketPath,
        [CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.token]: record.token,
      },
      dispose: () => {
        if (disposed) return;
        disposed = true;
        if (this.#claudeRegistrations.get(record.paneId) === record) {
          this.#claudeRegistrations.delete(record.paneId);
        }
      },
    };
  }

  async close(): Promise<void> {
    this.#registrations.clear();
    this.#claudeRegistrations.clear();
    for (const socket of this.#connections) socket.destroy();
    this.#connections.clear();
    const server = this.#server;
    this.#server = null;
    if (server !== null) await closeServer(server);
    await this.#unlinkCurrentSocket();
    this.#socketIdentity = null;
  }

  #acceptConnection(socket: Socket): void {
    this.#connections.add(socket);
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    let buffered = Buffer.alloc(0);
    let completed = false;
    const finish = (ok: boolean): void => {
      if (completed) return;
      completed = true;
      socket.end(`${JSON.stringify({ ok })}\n`);
    };

    socket.on("data", (chunk: Buffer) => {
      if (completed) return;
      if (buffered.length + chunk.length > MAX_MESSAGE_BYTES) {
        finish(false);
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      const trailing = buffered
        .subarray(newline + 1)
        .toString("utf8")
        .trim();
      if (trailing !== "") {
        finish(false);
        return;
      }
      finish(this.#acceptMessage(buffered.subarray(0, newline).toString("utf8")));
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("close", () => this.#connections.delete(socket));
  }

  #acceptMessage(serialized: string): boolean {
    let raw: unknown;
    try {
      raw = JSON.parse(serialized) as unknown;
    } catch {
      return false;
    }
    if (typeof raw === "object" && raw !== null && "version" in raw && raw.version === 3) {
      const parsed = ClaudeHookMessageSchema.safeParse(raw);
      if (!parsed.success) return false;
      const message = parsed.data;
      const registration = this.#claudeRegistrations.get(message.paneId);
      if (
        registration === undefined ||
        registration.runtimeId !== message.runtimeId ||
        registration.cwd !== message.event.cwd ||
        !equalCapability(registration.token, message.token)
      ) {
        return false;
      }
      try {
        registration.onEvent(message.event);
        return true;
      } catch {
        return false;
      }
    }
    const parsed = HookMessageSchema.safeParse(raw);
    if (!parsed.success) return false;
    const message = parsed.data;
    const registration = this.#registrations.get(message.paneId);
    if (
      registration === undefined ||
      registration.runtimeId !== message.runtimeId ||
      registration.cwd !== message.event.cwd ||
      !equalCapability(registration.token, message.token)
    ) {
      return false;
    }
    try {
      registration.onEvent(message.event);
      return true;
    } catch {
      return false;
    }
  }

  async #unlinkCurrentSocket(): Promise<void> {
    if (this.#socketIdentity === null) return;
    try {
      const metadata = await lstat(this.#socketPath);
      if (
        metadata.isSocket() &&
        metadata.dev === this.#socketIdentity.device &&
        metadata.ino === this.#socketIdentity.inode
      ) {
        await unlink(this.#socketPath);
      }
    } catch (error) {
      if (!isNodeError(error, "ENOENT")) throw error;
    }
  }
}

function shortRuntimeDirectory(dataDirectory: string): string {
  const temporaryRoot = process.platform === "darwin" ? "/private/tmp" : tmpdir();
  const identifier = createHash("sha256").update(dataDirectory).digest("hex").slice(0, 16);
  return join(temporaryRoot, `naru-codex-${identifier}`);
}

async function requirePrivateRuntimeDirectory(path: string): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Codex hook runtime path must be a regular directory.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Codex hook runtime directory must be owned by the service user.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Codex hook runtime directory must not be accessible by other users.");
  }
}

async function removeStaleSocket(path: string): Promise<void> {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (isNodeError(error, "ENOENT")) return;
    throw error;
  }
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error("Refusing to replace a non-socket Codex hook runtime path.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Refusing to replace a Codex hook socket owned by another user.");
  }
  if (await isAcceptingConnections(path)) {
    throw new Error("Another Naru Codex hook server is already running.");
  }
  await unlink(path);
}

async function unlinkOwnedSocket(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (
      metadata.isSocket() &&
      (typeof process.getuid !== "function" || metadata.uid === process.getuid())
    ) {
      await unlink(path);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

function listenOnSocket(server: Server, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => reject(error);
    server.once("error", onError);
    server.listen(path, () => {
      server.off("error", onError);
      resolve();
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function isAcceptingConnections(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(path);
    const finish = (result: boolean): void => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(250);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

function equalCapability(expected: string, actual: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const actualBytes = Buffer.from(actual);
  return expectedBytes.length === actualBytes.length && timingSafeEqual(expectedBytes, actualBytes);
}

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
