import { execFileSync } from "node:child_process";
import {
  callAgentSocket,
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "./agent-platform/agent-socket.js";
import { NARU_AGENT_HOOK_MODE_ENV } from "./agent-hook-cli-env.js";

/**
 * Claude Code hook for Naru-managed sessions (AP-D015, AP-D002-2). It carries no authority of its
 * own: every decision is made by Naru from this session's capability.
 *
 * - PreToolUse(SendMessage): a native cross-session message needs Naru's authorization (managed
 *   recipient, in scope, not held by a person); failure denies (fail closed). Subagent messaging
 *   (`recipient_kind: "agent"`) stays inside the session and is not routed.
 * - UserPromptSubmit: an arriving cross-session message passes only if it matches an authorized
 *   record from the recorded sender process; otherwise it is blocked. In TUI mode a person's own
 *   prompt is recorded verbatim; a recording failure never blocks the person.
 */
const socketPath = process.env[NARU_AGENT_SOCKET_ENV];
const capability = process.env[NARU_AGENT_CAPABILITY_ENV];
const mode = process.env[NARU_AGENT_HOOK_MODE_ENV] === "tui" ? "tui" : "runner";

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
let payload: Record<string, unknown> = {};
try {
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    payload = parsed as Record<string, unknown>;
  }
} catch {
  payload = {};
}

async function ask(tool: string, args: Record<string, unknown>): Promise<string | null> {
  if (socketPath === undefined || capability === undefined) return "Naru binding is missing.";
  try {
    const reply = await callAgentSocket(socketPath, {
      version: 1,
      capability,
      tool,
      arguments: args,
    });
    return reply.ok ? null : `${reply.code}: ${reply.message}`;
  } catch {
    return "Naru is unavailable.";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The hook runs under Claude's shell; the Claude process is one of these ancestors. */
function ancestorPids(): number[] {
  const pids = [process.ppid];
  try {
    const parent = Number(
      execFileSync("/bin/ps", ["-o", "ppid=", "-p", String(process.ppid)], {
        encoding: "utf8",
      }).trim(),
    );
    if (Number.isSafeInteger(parent) && parent > 1) pids.push(parent);
  } catch {
    // The direct parent alone is still checked.
  }
  return pids;
}

const event = payload.hook_event_name;
if (event === "PreToolUse" && payload.tool_name === "SendMessage") {
  const input =
    payload.tool_input !== null && typeof payload.tool_input === "object"
      ? (payload.tool_input as Record<string, unknown>)
      : {};
  if (input.recipient_kind !== "agent") {
    const denied = await ask("hook.native_message.authorize", {
      tool_use_id: typeof payload.tool_use_id === "string" ? payload.tool_use_id : "unknown",
      to: text(input.to) || text(input.recipient),
      message: text(input.message) || text(input.content),
      sender_pids: ancestorPids(),
    });
    if (denied !== null) {
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: `Naru: ${denied}`,
          },
        }),
      );
    }
  }
} else if (event === "UserPromptSubmit" && typeof payload.prompt === "string") {
  if (payload.prompt.trimStart().startsWith("<cross-session-message")) {
    const blocked = await ask("hook.native_message.deliver", { prompt: payload.prompt });
    if (blocked !== null) {
      process.stdout.write(JSON.stringify({ decision: "block", reason: `Naru: ${blocked}` }));
    }
  } else if (mode === "tui" && payload.prompt.trim() !== "") {
    await ask("hook.tui_prompt", {
      prompt_id: typeof payload.prompt_id === "string" ? payload.prompt_id : String(Date.now()),
      prompt: payload.prompt,
    });
  }
}
