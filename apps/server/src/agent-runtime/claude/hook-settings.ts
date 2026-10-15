import {
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../../agent-platform/agent-socket.js";
import { NARU_AGENT_HOOK_MODE_ENV } from "../../agent-hook-cli-env.js";

/**
 * `--settings` for a Naru-managed Claude session (AP-D015). The capability goes into the hook
 * command itself, never into the Claude process environment its Bash tool can read. Inbound native
 * messages are accepted so they wake the session; the hook decides which ones may pass. Naru's own
 * MCP tools need no person's approval: Core already decides role, scope and holds (AP-D017).
 */
export function naruClaudeHookSettings(options: {
  readonly runner: string;
  readonly runnerArgs: readonly string[];
  readonly entry: string;
  readonly socketPath: string;
  readonly capability: string;
  readonly mode: "runner" | "tui";
}): Record<string, unknown> {
  const command = [
    `${NARU_AGENT_SOCKET_ENV}=${shellQuote(options.socketPath)}`,
    `${NARU_AGENT_CAPABILITY_ENV}=${shellQuote(options.capability)}`,
    `${NARU_AGENT_HOOK_MODE_ENV}=${options.mode}`,
    shellQuote(options.runner),
    ...options.runnerArgs.map(shellQuote),
    shellQuote(options.entry),
  ].join(" ");
  const handler = { type: "command", command, timeout: 10 };
  return {
    crossSessionInbound: "accept",
    permissions: { allow: ["mcp__naru"] },
    hooks: {
      PreToolUse: [{ matcher: "SendMessage", hooks: [handler] }],
      UserPromptSubmit: [{ hooks: [handler] }],
    },
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
