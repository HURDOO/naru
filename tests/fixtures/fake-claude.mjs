#!/usr/bin/env node
/* global process */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

if (process.argv[2] === "auth" && process.argv[3] === "status") {
  process.stdout.write('{"loggedIn":true}\n');
  process.exit(0);
}

const settingsIndex = process.argv.indexOf("--settings");
const settings =
  settingsIndex === -1 ? null : JSON.parse(process.argv[settingsIndex + 1] ?? "null");
const sessionId = randomUUID();
const hookInput = (hook_event_name, extra = {}) => ({
  session_id: sessionId,
  cwd: process.cwd(),
  hook_event_name,
  ...extra,
});

async function emitHook(hook_event_name, extra = {}) {
  const command = settings?.hooks?.[hook_event_name]?.[0]?.hooks?.[0]?.command;
  if (typeof command !== "string") return;
  await new Promise((resolve) => {
    const child = spawn("/bin/sh", ["-c", command], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["pipe", "ignore", "ignore"],
    });
    child.once("error", () => resolve());
    child.once("close", () => resolve());
    child.stdin.end(JSON.stringify(hookInput(hook_event_name, extra)));
  });
}

void emitHook("SessionStart", { source: "startup" }).then(() =>
  process.stdout.write("FAKE_CLAUDE_READY\r\n"),
);
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.setEncoding("utf8");
let inputBuffer = "";
process.stdin.on("data", (input) => {
  inputBuffer = `${inputBuffer}${input}`.slice(-64);
  const activityCommands = [
    ["status-start", "UserPromptSubmit", "FAKE_CLAUDE_RUNNING"],
    ["status-need", "PermissionRequest", "FAKE_CLAUDE_NEEDS_PERMISSION"],
    ["status-resume", "PostToolUse", "FAKE_CLAUDE_RESUMED"],
    ["status-done", "Stop", "FAKE_CLAUDE_COMPLETED"],
  ];
  for (const [trigger, event, marker] of activityCommands) {
    if (!inputBuffer.includes(trigger)) continue;
    inputBuffer = "";
    void emitHook(event, {
      prompt: "not forwarded",
      tool_input: { command: "not forwarded" },
    }).then(() => process.stdout.write(`${marker}\r\n`));
    return;
  }
  if (inputBuffer.includes("ping")) {
    process.stdout.write("FAKE_CLAUDE_PONG\r\n");
    inputBuffer = "";
  }
});
process.stdin.resume();
