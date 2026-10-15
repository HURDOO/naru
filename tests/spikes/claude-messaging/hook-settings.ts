import { resolve } from "node:path";
import { nodeCommand } from "./spike-env.js";

const TOOL_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
]);
const AUDITED_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PostToolUseFailure",
  "PermissionRequest",
  "Notification",
  "SubagentStart",
  "SubagentStop",
  "Stop",
  "SessionEnd",
];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export interface HookSettingsOptions {
  readonly role: string;
  readonly runDirectory: string;
  readonly inbound?: "accept" | "hold" | "refuse" | undefined;
  /** RegExp source; SendMessage targets that do not match are denied by the hook. */
  readonly sendAllow?: string;
  readonly sendPolicy?: "in-session-only";
  /** Block `UserPromptSubmit` prompts that arrive as cross-session messages. */
  readonly blockInbound?: boolean;
}

/** `--settings` payload: audit hook on every lifecycle event plus the optional inbound control. */
export function spikeSettings(options: HookSettingsOptions): Record<string, unknown> {
  const environment: Record<string, string> = {
    NARU_SPIKE_ROLE: options.role,
    NARU_SPIKE_HOOK_LOG: resolve(options.runDirectory, "hooks.jsonl"),
    NARU_SPIKE_HOOK_STATE: resolve(options.runDirectory, `${options.role}.hook-state.json`),
  };
  if (options.sendAllow !== undefined) environment.NARU_SPIKE_SEND_ALLOW = options.sendAllow;
  if (options.sendPolicy !== undefined) environment.NARU_SPIKE_SEND_POLICY = options.sendPolicy;
  if (options.blockInbound === true) environment.NARU_SPIKE_BLOCK_INBOUND = "1";
  const prefix = Object.entries(environment)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ");
  const command = `${prefix} ${nodeCommand("audit-hook.mjs")}`;
  const hooks = Object.fromEntries(
    AUDITED_EVENTS.map((event) => [
      event,
      [
        {
          ...(TOOL_EVENTS.has(event) ? { matcher: "*" } : {}),
          hooks: [{ type: "command", command }],
        },
      ],
    ]),
  );
  return {
    ...(options.inbound === undefined ? {} : { crossSessionInbound: options.inbound }),
    hooks,
  };
}
