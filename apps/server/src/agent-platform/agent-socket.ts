import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { z, ZodError } from "zod";
import {
  closeServer,
  isNodeError,
  listenOnSocket,
  removeStaleSocket,
  requirePrivateRuntimeDirectory,
  unlinkOwnedSocket,
} from "../private-socket.js";
import type { AgentPlatformErrorCode } from "@naru/contracts/naru-agent/v1";
import { AppError } from "../errors.js";
import { AgentPlatformError, type AgentPlatformCore } from "./core.js";
import { AGENT_TOOLS, HOOK_TOOLS, type AgentToolRuntime } from "./tools.js";

/**
 * Owner-only UDS through which the per-session MCP bin reaches AgentPlatformCore (AP-D004). The
 * capability, not any argument, decides the acting agent. No network listener is opened.
 */
export const NARU_AGENT_SOCKET_ENV = "NARU_AGENT_SOCKET";
export const NARU_AGENT_CAPABILITY_ENV = "NARU_AGENT_CAPABILITY";

const LABEL = "Agent Platform";
const SOCKET_FILENAME = "agent.sock";
const SOCKET_PATH_MAX_BYTES = 100;
const MAX_MESSAGE_BYTES = 256 * 1024;
const CONNECTION_TIMEOUT_MS = 10_000;

export const AgentSocketRequestSchema = z.strictObject({
  version: z.literal(1),
  capability: z.string().min(1).max(128),
  tool: z.string().min(1).max(64),
  arguments: z.record(z.string(), z.unknown()),
});
export type AgentSocketRequest = z.infer<typeof AgentSocketRequestSchema>;

export type AgentSocketReply =
  | { readonly version: 1; readonly ok: true; readonly result: unknown }
  | {
      readonly version: 1;
      readonly ok: false;
      readonly code: string;
      readonly message: string;
      readonly fields?: readonly string[];
    };

export class AgentSocketServer {
  readonly #core: AgentPlatformCore;
  #runtime: AgentToolRuntime | undefined;
  #errorSink: ((tool: string, error: unknown) => void) | undefined;
  readonly #runtimeDirectory: string;
  readonly #socketPath: string;
  readonly #connections = new Set<Socket>();
  #server: Server | null = null;
  #socketIdentity: { device: number; inode: number } | null = null;

  constructor(dataDirectory: string, core: AgentPlatformCore, runtime?: AgentToolRuntime) {
    this.#core = core;
    this.#runtime = runtime;
    const preferred = join(dataDirectory, "runtime", SOCKET_FILENAME);
    this.#runtimeDirectory =
      Buffer.byteLength(preferred) <= SOCKET_PATH_MAX_BYTES
        ? join(dataDirectory, "runtime")
        : join(
            "/private/tmp",
            `naru-agent-${createHash("sha256").update(dataDirectory).digest("hex").slice(0, 16)}`,
          );
    this.#socketPath = join(this.#runtimeDirectory, SOCKET_FILENAME);
  }

  /** Runtime-backed tools become available once managed runtimes are wired (startup order). */
  /** Where unexpected tool failures are reported (structured log, error class only). */
  useErrorSink(sink: (tool: string, error: unknown) => void): void {
    this.#errorSink = sink;
  }

  useRuntime(runtime: AgentToolRuntime): void {
    this.#runtime = runtime;
  }

  get socketPath(): string {
    return this.#socketPath;
  }

  async start(): Promise<void> {
    if (this.#server !== null) return;
    await mkdir(this.#runtimeDirectory, { recursive: true, mode: 0o700 });
    await requirePrivateRuntimeDirectory(this.#runtimeDirectory, false, LABEL);
    await removeStaleSocket(this.#socketPath, LABEL);
    const server = createServer((socket) => this.#accept(socket));
    await listenOnSocket(server, this.#socketPath);
    try {
      await chmod(this.#socketPath, 0o600);
      const metadata = await lstat(this.#socketPath);
      if (!metadata.isSocket() || (metadata.mode & 0o777) !== 0o600) {
        throw new Error("Agent Platform socket is not private.");
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
    if (this.#socketIdentity !== null) {
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
    this.#socketIdentity = null;
  }

  /** Validates and executes one request; exposed for transport-free tests. */
  async handle(serialized: string): Promise<AgentSocketReply> {
    let input: unknown;
    try {
      input = JSON.parse(serialized) as unknown;
    } catch {
      return failure("INVALID", "The request is not JSON.");
    }
    const parsed = AgentSocketRequestSchema.safeParse(input);
    if (!parsed.success) return failure("INVALID", "The request envelope is invalid.");
    const actor = this.#core.authenticateAgent(parsed.data.capability);
    if (actor === null) return failure("DENIED", "The agent capability was not accepted.");
    const tool = [...AGENT_TOOLS, ...HOOK_TOOLS].find(
      (candidate) => candidate.name === parsed.data.tool,
    );
    if (tool === undefined) return failure("UNKNOWN_TOOL", "No such Naru tool.");
    try {
      const result: unknown = await tool.run(
        this.#core,
        actor,
        parsed.data.arguments,
        this.#runtime,
      );
      return { version: 1, ok: true, result };
    } catch (error) {
      if (error instanceof AgentPlatformError) return failure(error.code, error.message);
      if (error instanceof ZodError) {
        // Field paths only: argument values may carry user text and are never echoed.
        return {
          version: 1,
          ok: false,
          code: "INVALID",
          message: "The tool arguments are invalid.",
          fields: [...new Set(error.issues.map((issue) => issue.path.join(".") || "(root)"))],
        };
      }
      // Naru's own refusals (Host limits, paths) keep their meaning for the agent.
      if (error instanceof AppError) {
        this.#errorSink?.(tool.name, error);
        return failure(appErrorCode(error.statusCode), error.message);
      }
      // The agent gets a generic answer; operators get the tool and error class (no arguments).
      this.#errorSink?.(tool.name, error);
      return failure("INTERNAL", "Naru could not complete the tool call.");
    }
  }

  #accept(socket: Socket): void {
    this.#connections.add(socket);
    socket.setTimeout(CONNECTION_TIMEOUT_MS);
    let buffered = Buffer.alloc(0);
    let completed = false;
    const finish = (reply: AgentSocketReply): void => {
      if (completed) return;
      completed = true;
      socket.end(`${JSON.stringify(reply)}\n`);
    };
    socket.on("data", (chunk: Buffer) => {
      if (completed) return;
      if (buffered.length + chunk.length > MAX_MESSAGE_BYTES) {
        finish(failure("INVALID", "The request is too large."));
        return;
      }
      buffered = Buffer.concat([buffered, chunk]);
      const newline = buffered.indexOf(0x0a);
      if (newline === -1) return;
      void this.handle(buffered.subarray(0, newline).toString("utf8")).then(finish);
    });
    socket.on("timeout", () => socket.destroy());
    socket.on("error", () => undefined);
    socket.on("close", () => this.#connections.delete(socket));
  }
}

/** Client side used by the MCP bin: one request per connection. */
export function callAgentSocket(
  socketPath: string,
  request: AgentSocketRequest,
  timeoutMs = CONNECTION_TIMEOUT_MS,
): Promise<AgentSocketReply> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let buffered = "";
    socket.setEncoding("utf8");
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      buffered += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffered.trim()) as AgentSocketReply);
      } catch {
        reject(new Error("Naru returned an unreadable reply."));
      }
    });
    socket.on("timeout", () => {
      socket.destroy();
      reject(new Error("Naru did not answer in time."));
    });
    socket.on("error", () => reject(new Error("Naru Agent Platform is unavailable.")));
  });
}

function failure(code: string, message: string): AgentSocketReply {
  return { version: 1, ok: false, code, message };
}

function appErrorCode(statusCode: number): AgentPlatformErrorCode {
  if (statusCode === 403) return "AGENT_SCOPE_DENIED";
  if (statusCode === 404) return "AGENT_NOT_FOUND";
  if (statusCode >= 500) return "AGENT_RUNTIME_UNAVAILABLE";
  return "AGENT_INVALID_STATE";
}
