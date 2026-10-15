#!/usr/bin/env node
/* global process, Buffer */
// Spike hook: appends every hook payload to an owner-only log outside the repository and applies a
// SendMessage target policy. It never prints payload content to stdout except a decision object.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf8");
let input;
try {
  input = JSON.parse(raw);
} catch {
  input = { unparsed: true };
}

const role = process.env.NARU_SPIKE_ROLE ?? "unknown";
const logPath = process.env.NARU_SPIKE_HOOK_LOG;
const statePath = process.env.NARU_SPIKE_HOOK_STATE;
if (logPath) {
  appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), role, input })}\n`, {
    mode: 0o600,
  });
}

function readState() {
  if (!statePath || !existsSync(statePath)) return { subagents: [] };
  return JSON.parse(readFileSync(statePath, "utf8"));
}

if (input.hook_event_name === "SubagentStart" && statePath) {
  const state = readState();
  for (const key of ["agent_id", "agent_type", "agent_name"]) {
    if (typeof input[key] === "string") state.subagents.push(input[key]);
  }
  writeFileSync(statePath, JSON.stringify(state), { mode: 0o600 });
}

function deny(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
  process.exit(0);
}

if (
  input.hook_event_name === "UserPromptSubmit" &&
  process.env.NARU_SPIKE_BLOCK_INBOUND === "1" &&
  String(input.prompt ?? "").startsWith("<cross-session-message")
) {
  process.stdout.write(
    JSON.stringify({
      decision: "block",
      reason: "naru-spike policy: cross-session prompt blocked",
    }),
  );
  process.exit(0);
}

if (input.hook_event_name === "PreToolUse" && input.tool_name === "SendMessage") {
  const target = String(input.tool_input?.to ?? "");
  const allow = process.env.NARU_SPIKE_SEND_ALLOW;
  if (allow && !new RegExp(allow, "u").test(target)) {
    deny(`naru-spike policy: target "${target}" is not an allowed spike session`);
  }
  if (process.env.NARU_SPIKE_SEND_POLICY === "in-session-only") {
    const known = new Set(readState().subagents);
    if (!known.has(target)) deny(`naru-spike policy: cross-session target "${target}" denied`);
  }
}
process.exit(0);
