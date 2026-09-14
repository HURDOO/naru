import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, realpath, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { NaruCodexIntegrationPort } from "./port.js";
import { CodexIntegrationRequestSchema, type CodexIntegrationReply } from "./protocol.js";

const SOCKET_FILENAME = "codex-integration.sock";
const SOCKET_PATH_MAX_BYTES = 100;
const MAX_MESSAGE_BYTES = 32 * 1024;
const CONNECTION_TIMEOUT_MS = 3_000;

interface SocketIdentity {
  readonly device: number;
  readonly inode: number;
}

export class CodexIntegrationServer {
  readonly #runtimeDirectory: string;
  readonly #socketPath: string;
  readonly #requiresCanonicalRuntimeDirectory: boolean;
  readonly #connections = new Set<Socket>();
  #server: Server | null = null;
  #socketIdentity: SocketIdentity | null = null;

  constructor(
    dataDirectory: string,
    private readonly integration: NaruCodexIntegrationPort,
    options: { readonly socketPath?: string } = {},
  ) {
    if (options.socketPath !== undefined) {
      if (!isAbsolute(options.socketPath) || resolve(options.socketPath) !== options.socketPath) {
        throw new Error("Configured Codex integration socket path must be exact and absolute.");
      }
      this.#runtimeDirectory = dirname(options.socketPath);
      this.#socketPath = options.socketPath;
      this.#requiresCanonicalRuntimeDirectory = true;
    } else {
      const dataRuntimeDirectory = join(dataDirectory, "runtime");
      const dataSocketPath = join(dataRuntimeDirectory, SOCKET_FILENAME);
      this.#runtimeDirectory =
        Buffer.byteLength(dataSocketPath) <= SOCKET_PATH_MAX_BYTES
          ? dataRuntimeDirectory
          : shortRuntimeDirectory(dataDirectory);
      this.#socketPath = join(this.#runtimeDirectory, SOCKET_FILENAME);
      this.#requiresCanonicalRuntimeDirectory = false;
    }
    if (Buffer.byteLength(this.#socketPath) > SOCKET_PATH_MAX_BYTES) {
      throw new Error("Naru data directory is too long for the Codex integration socket.");
    }
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    if (!this.#requiresCanonicalRuntimeDirectory) {
      await mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    }
    await requirePrivateRuntimeDirectory(
      this.#runtimeDirectory,
      this.#requiresCanonicalRuntimeDirectory,
    );
    await removeStaleSocket(this.#socketPath);
    const server = createServer((socket) => this.#acceptConnection(socket));
    await listenOnSocket(server, this.#socketPath);
    try {
      await chmod(this.#socketPath, 0o600);
      const metadata = await lstat(this.#socketPath);
      if (!metadata.isSocket() || (metadata.mode & 0o777) !== 0o600) {
        throw new Error("Codex integration socket is not private.");
      }
      this.#socketIdentity = { device: metadata.dev, inode: metadata.ino };
      this.#server = server;
    } catch (error) {
      await closeServer(server);
      await unlinkOwnedSocket(this.#socketPath);
      throw error;
    }
  }

  async close(): Promise<void> {
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
    const finish = (reply: CodexIntegrationReply): void => {
      if (completed) return;
      completed = true;
      socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.on("data", (chunk: Buffer) => {
      if (completed) return;
      if (buffered.length + chunk.length > MAX_MESSAGE_BYTES) {
        finish({ version: 1, ok: false, code: "INVALID" });
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      if (
        buffered
          .subarray(newline + 1)
          .toString("utf8")
          .trim() !== ""
      ) {
        finish({ version: 1, ok: false, code: "INVALID" });
        return;
      }
      finish(this.#handle(buffered.subarray(0, newline).toString("utf8")));
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("close", () => this.#connections.delete(socket));
  }

  #handle(serialized: string): CodexIntegrationReply {
    let input: unknown;
    try {
      input = JSON.parse(serialized) as unknown;
    } catch {
      return { version: 1, ok: false, code: "INVALID" };
    }
    const parsed = CodexIntegrationRequestSchema.safeParse(input);
    if (!parsed.success) return { version: 1, ok: false, code: "INVALID" };
    try {
      if (parsed.data.type === "launch") {
        const plan = this.integration.launch(parsed.data.bootstrap);
        return {
          version: 1,
          ok: true,
          type: "launch",
          plan: { executable: plan.executable, args: [...plan.args] },
        };
      }
      if (parsed.data.type === "interaction") {
        return this.integration.acceptInteraction(parsed.data.bootstrap, parsed.data.snapshot)
          ? { version: 1, ok: true, type: "interaction" }
          : { version: 1, ok: false, code: "DENIED" };
      }
      return this.integration.acceptHook(parsed.data.bootstrap, parsed.data.event)
        ? { version: 1, ok: true, type: "hook" }
        : { version: 1, ok: false, code: "DENIED" };
    } catch {
      return { version: 1, ok: false, code: "DENIED" };
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
  return join(temporaryRoot, `naru-codex-integration-${identifier}`);
}

async function requirePrivateRuntimeDirectory(
  path: string,
  requireCanonical: boolean,
): Promise<void> {
  const metadata = await lstat(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Codex integration runtime path must be a regular directory.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Codex integration runtime directory must be owned by the service user.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Codex integration runtime directory must be private.");
  }
  if (requireCanonical && (await realpath(path)) !== path) {
    throw new Error("Configured Codex integration runtime path must not contain symbolic links.");
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
    throw new Error("Refusing to replace a non-socket Codex integration path.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("Refusing to replace a Codex integration socket owned by another user.");
  }
  if (await isAcceptingConnections(path)) {
    throw new Error("Another Naru Codex integration server is already running.");
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

function isNodeError(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
