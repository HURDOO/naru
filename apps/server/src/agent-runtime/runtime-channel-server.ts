import { createHash } from "node:crypto";
import { chmod, lstat, mkdir } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  closeServer,
  listenOnSocket,
  removeStaleSocket,
  requirePrivateRuntimeDirectory,
  unlinkOwnedSocket,
} from "../private-socket.js";
import {
  lineReader,
  RunnerMessageSchema,
  type NaruMessage,
  type RunnerMessage,
} from "./channel-protocol.js";

const LABEL = "Agent runtime channel";
const SOCKET_FILENAME = "agent-runtime.sock";
const SOCKET_PATH_MAX_BYTES = 100;
const HELLO_TIMEOUT_MS = 5_000;

export interface RunnerConnection {
  readonly agentSessionId: string;
  send(message: NaruMessage): void;
  close(): void;
}

export interface RuntimeChannelHandlers {
  /** Returns the agent session for a launch token, or null to reject the runner. */
  authenticate(token: string): string | null;
  connected(connection: RunnerConnection, hello: Extract<RunnerMessage, { type: "hello" }>): void;
  message(connection: RunnerConnection, message: RunnerMessage): void;
  disconnected(connection: RunnerConnection): void;
}

/** Owner-only UDS where Host-owned runners reach Naru. No network listener. */
export class RuntimeChannelServer {
  readonly #handlers: RuntimeChannelHandlers;
  readonly #directory: string;
  readonly #socketPath: string;
  readonly #sockets = new Set<Socket>();
  readonly #current = new Map<string, Socket>();
  #server: Server | null = null;

  constructor(dataDirectory: string, handlers: RuntimeChannelHandlers) {
    this.#handlers = handlers;
    const preferred = join(dataDirectory, "runtime", SOCKET_FILENAME);
    this.#directory =
      Buffer.byteLength(preferred) <= SOCKET_PATH_MAX_BYTES
        ? join(dataDirectory, "runtime")
        : join(
            "/private/tmp",
            `naru-runtime-${createHash("sha256").update(dataDirectory).digest("hex").slice(0, 16)}`,
          );
    this.#socketPath = join(this.#directory, SOCKET_FILENAME);
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    await mkdir(this.#directory, { recursive: true, mode: 0o700 });
    await requirePrivateRuntimeDirectory(this.#directory, false, LABEL);
    await removeStaleSocket(this.#socketPath, LABEL);
    const server = createServer((socket) => this.#accept(socket));
    await listenOnSocket(server, this.#socketPath);
    await chmod(this.#socketPath, 0o600);
    const metadata = await lstat(this.#socketPath);
    if (!metadata.isSocket() || (metadata.mode & 0o777) !== 0o600) {
      await closeServer(server);
      throw new Error("Agent runtime channel socket is not private.");
    }
    this.#server = server;
  }

  async close(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    this.#sockets.clear();
    this.#current.clear();
    const server = this.#server;
    this.#server = null;
    if (server !== null) await closeServer(server);
    await unlinkOwnedSocket(this.#socketPath);
  }

  #accept(socket: Socket): void {
    this.#sockets.add(socket);
    let connection: RunnerConnection | null = null;
    const helloTimer = setTimeout(() => socket.destroy(), HELLO_TIMEOUT_MS);
    const write = (message: NaruMessage) => {
      if (!socket.destroyed) socket.write(`${JSON.stringify(message)}\n`);
    };
    const read = lineReader(
      (line) => {
        let message: RunnerMessage;
        try {
          message = RunnerMessageSchema.parse(JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
        if (connection === null) {
          if (message.type !== "hello") {
            socket.destroy();
            return;
          }
          clearTimeout(helloTimer);
          const agentSessionId = this.#handlers.authenticate(message.token);
          if (agentSessionId === null) {
            write({ type: "rejected", code: "RUNTIME_TOKEN_REJECTED" });
            socket.end();
            return;
          }
          // A newer connection for the same agent replaces the stale one.
          this.#current.get(agentSessionId)?.destroy();
          this.#current.set(agentSessionId, socket);
          connection = {
            agentSessionId,
            send: write,
            close: () => socket.end(),
          };
          this.#handlers.connected(connection, message);
          return;
        }
        this.#handlers.message(connection, message);
      },
      () => socket.destroy(),
    );
    socket.on("data", read);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      clearTimeout(helloTimer);
      this.#sockets.delete(socket);
      if (connection !== null && this.#current.get(connection.agentSessionId) === socket) {
        this.#current.delete(connection.agentSessionId);
        this.#handlers.disconnected(connection);
      }
    });
  }
}
