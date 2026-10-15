#!/usr/bin/env node
/* global process, Buffer, setTimeout, clearTimeout */
// V06b hook: routes native cross-session messaging through a Naru bridge. The sender's
// PreToolUse(SendMessage) must be authorized (and is recorded); the receiver's UserPromptSubmit
// must match an authorized record. Any bridge failure denies/blocks (fail closed). Only spike
// sessions are ever valid targets: a hard name guard runs before the bridge is consulted.
import { appendFileSync } from "node:fs";
import { createConnection } from "node:net";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
let input;
try {
  input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
} catch {
  input = {};
}
const socket = process.env.NARU_BRIDGE_SOCKET ?? "";
const capability = process.env.NARU_BRIDGE_CAPABILITY ?? "";
const log = process.env.NARU_BRIDGE_HOOK_LOG;
if (log) {
  appendFileSync(
    log,
    `${JSON.stringify({ at: Date.now(), event: input.hook_event_name, tool: input.tool_name })}\n`,
    { mode: 0o600 },
  );
}

function ask(request) {
  return new Promise((resolve) => {
    const connection = createConnection(socket);
    let reply = "";
    const timer = setTimeout(() => {
      connection.destroy();
      resolve({ allow: false, reason: "naru bridge timeout" });
    }, 5_000);
    connection.on("connect", () => connection.write(`${JSON.stringify(request)}\n`));
    connection.on("data", (data) => (reply += data.toString("utf8")));
    connection.on("end", () => {
      clearTimeout(timer);
      try {
        resolve(JSON.parse(reply));
      } catch {
        resolve({ allow: false, reason: "naru bridge unreadable reply" });
      }
    });
    connection.on("error", () => {
      clearTimeout(timer);
      resolve({ allow: false, reason: "naru bridge unavailable" });
    });
  });
}

if (input.hook_event_name === "PreToolUse" && input.tool_name === "SendMessage") {
  const tool = input.tool_input ?? {};
  const to = String(tool.to ?? tool.recipient ?? "");
  const message = String(tool.message ?? tool.content ?? "");
  const guard = /^naru-spike-bridge-[a-z]$/u.test(to) || tool.recipient_kind === "agent";
  const decision = guard
    ? tool.recipient_kind === "agent"
      ? { allow: true }
      : await ask({ type: "authorize", capability, to, message })
    : { allow: false, reason: `spike guard: "${to}" is not a spike session` };
  if (!decision.allow) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: decision.reason ?? "denied by Naru",
        },
      }),
    );
  }
  process.exit(0);
}

if (
  input.hook_event_name === "UserPromptSubmit" &&
  String(input.prompt ?? "").startsWith("<cross-session-message")
) {
  const decision = await ask({ type: "deliver", capability, prompt: String(input.prompt) });
  if (!decision.allow) {
    process.stdout.write(
      JSON.stringify({ decision: "block", reason: decision.reason ?? "unverified message" }),
    );
  }
  process.exit(0);
}
process.exit(0);
