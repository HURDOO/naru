#!/usr/bin/env node
/* global process, setInterval */

import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);

if (args.includes("doctor")) {
  process.stdout.write(
    JSON.stringify({
      schemaVersion: 1,
      overallStatus: "ok",
      checks: {
        installation: { status: "ok" },
        "auth.credentials": { status: "ok" },
        "config.load": { status: "ok" },
      },
    }),
  );
  process.exit(0);
}

const argumentAfter = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};
const model = argumentAfter("--model") ?? "missing-model";
const reasoning = argumentAfter("--config") ?? "missing-reasoning";
const resumeIndex = args.indexOf("resume");
const resumedSessionId = resumeIndex >= 0 ? args[resumeIndex + 1] : undefined;
const sessionId = model.includes("luna")
  ? "22222222-2222-4222-8222-222222222222"
  : "11111111-1111-4111-8111-111111111111";
const invokeHook = (hookEventName, turnId, additionalInput = {}) => {
  const runner = process.env.NARU_CODEX_HOOK_RUNNER;
  const entrypoint = process.env.NARU_CODEX_HOOK_ENTRY;
  if (!runner || !entrypoint) return true;
  const result = spawnSync(runner, [entrypoint], {
    env: process.env,
    input: JSON.stringify({
      session_id: sessionId,
      cwd: process.cwd(),
      hook_event_name: hookEventName,
      source:
        hookEventName === "SessionStart" ? (resumedSessionId ? "resume" : "startup") : undefined,
      turn_id: turnId,
      ...additionalInput,
    }),
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.status !== 0) {
    const safeFailureCode = result.stderr?.match(/NARU_CODEX_HOOK_[A-Z_]+/)?.[0];
    process.stdout.write(
      `FAKE_CODEX_HOOK_FAILED ${hookEventName}${safeFailureCode ? ` ${safeFailureCode}` : ""}\r\n`,
    );
  }
  return result.status === 0;
};

invokeHook("SessionStart");
process.stdout.write(
  `FAKE_CODEX_READY model=${model} ${reasoning} cwd=${process.cwd()} resume=${resumedSessionId ?? "none"}\r\n`,
);
if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
  process.stdin.setRawMode(true);
}
process.stdin.resume();
process.stdin.setEncoding("utf8");
let commandBuffer = "";
let completedTurnSequence = 0;
let activeInterruptTurnId = null;
process.stdin.on("data", (data) => {
  if ((data === "\u0003" || data === "\u001b") && activeInterruptTurnId !== null) {
    process.stdout.write(`FAKE_CODEX_INTERRUPTED ${activeInterruptTurnId}\r\n`);
    activeInterruptTurnId = null;
    commandBuffer = "";
    return;
  }
  if (data === "\u0003") {
    process.stdout.write(`To continue this session, run codex resume ${sessionId}\r\n`);
    process.exit(130);
  }
  const shiftEnterSequence = "\u001b[13;2u";
  if (data.includes(shiftEnterSequence)) {
    commandBuffer = `${commandBuffer}${data.replaceAll(shiftEnterSequence, "\n")}`.slice(-256);
    process.stdout.write("FAKE_CODEX_SHIFT_ENTER\r\n");
    return;
  }
  process.stdout.write(`FAKE_CODEX_INPUT ${data.replace(/[\r\n]+/g, " ")}\r\n`);
  commandBuffer = `${commandBuffer}${data}`.slice(-256);
  if (/[\r\n]/.test(data)) {
    const submittedCommand = commandBuffer.trim();
    if (submittedCommand === "/status") {
      process.stdout.write(`\u001b[2mSession ID:\u001b[0m ${sessionId}\r\n`);
    }
    if (submittedCommand === "/naru-e2e-complete") {
      completedTurnSequence += 1;
      const turnId = `naru-e2e-completed-turn-${completedTurnSequence}`;
      const started = invokeHook("UserPromptSubmit", turnId);
      const toolFinished =
        started &&
        invokeHook("PostToolUse", turnId, {
          tool_name: "shell",
          tool_input: { command: "fake large-output regression" },
          tool_response: { output: "x".repeat(64 * 1024) },
        });
      if (toolFinished) invokeHook("Stop", turnId);
    }
    if (submittedCommand === "/naru-e2e-interrupt") {
      completedTurnSequence += 1;
      const turnId = `naru-e2e-interrupted-turn-${completedTurnSequence}`;
      if (invokeHook("UserPromptSubmit", turnId)) activeInterruptTurnId = turnId;
    }
    process.stdout.write(`FAKE_CODEX_SUBMIT ${JSON.stringify(submittedCommand)}\r\n`);
    commandBuffer = "";
  }
});
process.on("SIGHUP", () => {
  process.stdout.write(`To continue this session, run codex resume ${sessionId}\r\n`);
  process.exit(0);
});
setInterval(() => undefined, 60_000);
