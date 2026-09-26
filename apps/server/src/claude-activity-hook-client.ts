import { createConnection } from "node:net";
import { ClaudeActivityEventSchema, type ClaudeActivityEvent } from "./claude-activity-events.js";

export const CLAUDE_ACTIVITY_HOOK_COMMAND = '"$NARU_CLAUDE_HOOK_RUNNER" "$NARU_CLAUDE_HOOK_ENTRY"';

export const CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS = {
  entry: "NARU_CLAUDE_HOOK_ENTRY",
  paneId: "NARU_CLAUDE_HOOK_PANE_ID",
  runner: "NARU_CLAUDE_HOOK_RUNNER",
  runtimeId: "NARU_CLAUDE_HOOK_RUNTIME_ID",
  socket: "NARU_CLAUDE_HOOK_SOCKET",
  token: "NARU_CLAUDE_HOOK_TOKEN",
} as const;

const MAX_IPC_MESSAGE_BYTES = 16 * 1024;
const MAX_REPLY_BYTES = 1_024;
const SOCKET_TIMEOUT_MS = 3_000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface ClaudeHookEnvironment {
  readonly socketPath: string;
  readonly paneId: string;
  readonly runtimeId: string;
  readonly token: string;
}

export function readClaudeHookEnvironment(
  environment: NodeJS.ProcessEnv,
): ClaudeHookEnvironment | null {
  const socketPath = environment[CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.socket];
  const paneId = environment[CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.paneId];
  const runtimeId = environment[CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.runtimeId];
  const token = environment[CLAUDE_ACTIVITY_HOOK_ENVIRONMENT_KEYS.token];
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

export async function sendClaudeActivityEvent(
  event: ClaudeActivityEvent,
  environment: ClaudeHookEnvironment,
): Promise<boolean> {
  if (!ClaudeActivityEventSchema.safeParse(event).success) return false;
  const payload = `${JSON.stringify({
    version: 3,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
