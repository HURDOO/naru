import { createConnection } from "node:net";
import {
  CODEX_SESSION_HOOK_ENVIRONMENT_KEYS,
  type CodexHookEvent,
  type CodexSessionHookSource,
} from "./codex-session-hook.js";
import { requestCodexIntegration } from "./integrations/codex/client.js";

export const MAX_CODEX_HOOK_INPUT_BYTES = 8 * 1024 * 1024;
const MAX_IPC_MESSAGE_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 1_024;
const SOCKET_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SOURCES = new Set<CodexSessionHookSource>(["startup", "resume", "clear"]);

export interface CodexSessionStartInput {
  readonly sessionId: string;
  readonly cwd: string;
  readonly source: CodexSessionHookSource;
}

export interface LegacyCodexSessionHookClientEnvironment {
  readonly socketPath: string;
  readonly paneId: string;
  readonly runtimeId: string;
  readonly token: string;
}

export interface DurableCodexSessionHookClientEnvironment {
  readonly socketPath: string;
  readonly bootstrap: string;
}

export type CodexSessionHookClientEnvironment =
  LegacyCodexSessionHookClientEnvironment | DurableCodexSessionHookClientEnvironment;

export function parseCodexHookInput(serialized: string): CodexHookEvent | null {
  if (Buffer.byteLength(serialized) > MAX_CODEX_HOOK_INPUT_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const sessionId = value.session_id;
  const cwd = value.cwd;
  if (
    typeof sessionId !== "string" ||
    !UUID_PATTERN.test(sessionId) ||
    typeof cwd !== "string" ||
    cwd.length === 0 ||
    Buffer.byteLength(cwd) > 4_096
  ) {
    return null;
  }

  if (value.hook_event_name === "SessionStart") {
    const source = value.source;
    if (typeof source !== "string" || !isHookSource(source)) return null;
    return { type: "session-start", sessionId, cwd, source };
  }

  const turnId = value.turn_id;
  if (typeof turnId !== "string" || turnId.length === 0 || turnId.length > 128) return null;
  switch (value.hook_event_name) {
    case "UserPromptSubmit":
      return { type: "turn-start", sessionId, cwd, turnId };
    case "PermissionRequest":
      return { type: "interaction-required", sessionId, cwd, turnId };
    case "PostToolUse":
      return { type: "turn-running", sessionId, cwd, turnId };
    case "Stop":
      return { type: "turn-completed", sessionId, cwd, turnId };
    default:
      return null;
  }
}

export function parseCodexSessionStartInput(serialized: string): CodexSessionStartInput | null {
  const event = parseCodexHookInput(serialized);
  return event?.type === "session-start"
    ? { sessionId: event.sessionId, cwd: event.cwd, source: event.source }
    : null;
}

export function readCodexSessionHookEnvironment(
  environment: NodeJS.ProcessEnv,
): CodexSessionHookClientEnvironment | null {
  const socketPath = environment[CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.socket];
  const paneId = environment[CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.paneId];
  const runtimeId = environment[CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.runtimeId];
  const token = environment[CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.token];
  const bootstrap = environment[CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.bootstrap];
  if (
    socketPath &&
    Buffer.byteLength(socketPath) <= 100 &&
    bootstrap &&
    bootstrap.length >= 64 &&
    bootstrap.length <= 16 * 1024
  ) {
    return { socketPath, bootstrap };
  }
  if (
    !socketPath ||
    Buffer.byteLength(socketPath) > 100 ||
    !paneId ||
    !UUID_PATTERN.test(paneId) ||
    !runtimeId ||
    !UUID_PATTERN.test(runtimeId) ||
    !token ||
    token.length < 32 ||
    token.length > 128
  ) {
    return null;
  }
  return { socketPath, paneId, runtimeId, token };
}

export async function sendCodexHookEvent(
  event: CodexHookEvent,
  environment: CodexSessionHookClientEnvironment,
): Promise<boolean> {
  if ("bootstrap" in environment) {
    const reply = await requestCodexIntegration(environment.socketPath, {
      version: 1,
      type: "hook",
      bootstrap: environment.bootstrap,
      event,
    });
    return reply?.ok === true && reply.type === "hook";
  }
  const payload = `${JSON.stringify({
    version: 2,
    paneId: environment.paneId,
    runtimeId: environment.runtimeId,
    token: environment.token,
    event,
  })}\n`;
  if (Buffer.byteLength(payload) > MAX_IPC_MESSAGE_BYTES) return false;

  return new Promise((resolve) => {
    const socket = createConnection(environment.socketPath);
    let reply = Buffer.alloc(0);
    let completed = false;
    const finish = (ok: boolean): void => {
      if (completed) return;
      completed = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(SOCKET_TIMEOUT_MS);
    socket.once("connect", () => socket.write(payload));
    socket.on("data", (chunk: Buffer) => {
      if (reply.length + chunk.length > MAX_REPLY_BYTES) {
        finish(false);
        return;
      }
      reply = Buffer.concat([reply, chunk]);
      const newline = reply.indexOf(0x0a);
      if (newline === -1) return;
      try {
        const parsed = JSON.parse(reply.subarray(0, newline).toString("utf8")) as unknown;
        finish(isRecord(parsed) && parsed.ok === true);
      } catch {
        finish(false);
      }
    });
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.once("end", () => finish(false));
  });
}

export function sendCodexSessionStart(
  input: CodexSessionStartInput,
  environment: CodexSessionHookClientEnvironment,
): Promise<boolean> {
  return sendCodexHookEvent({ type: "session-start", ...input }, environment);
}

function isHookSource(value: string): value is CodexSessionHookSource {
  return ALLOWED_SOURCES.has(value as CodexSessionHookSource);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
