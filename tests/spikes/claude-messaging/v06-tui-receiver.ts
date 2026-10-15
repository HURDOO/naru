// V06 (TUI): an interactive Claude Code TUI in a PTY receives a cross-session message from a spike
// `claude -p` sender. Checks that the receiver's UserPromptSubmit hook observes the message, which is
// the path Naru's existing Claude Pane hooks would use. Terminal output is not stored, only hook logs.
import { createRequire } from "node:module";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { IPty } from "node-pty";
import { ClaudeSpikeProcess, toolResults, toolUses } from "./claude-process.js";
import { spikeSettings } from "./hook-settings.js";
import { cleanEnvironment, REPO_ROOT, requireClaudeExecutable, runDirectory } from "./spike-env.js";

const nodePty = createRequire(resolve(REPO_ROOT, "apps/durable-session-host/package.json"))(
  "node-pty",
) as { spawn: (file: string, args: string[], options: Record<string, unknown>) => IPty };

const run = runDirectory("v06-tui");
const name = "naru-spike-t1";
const workspace = resolve(run, "workspace", name);
const hookLog = resolve(run, "hooks.jsonl");
let screen = "";

mkdirSync(workspace, { recursive: true, mode: 0o700 });
const tui = nodePty.spawn(
  requireClaudeExecutable(),
  [
    "--name",
    name,
    "--model",
    "sonnet",
    "--settings",
    JSON.stringify(
      spikeSettings({ role: name, runDirectory: run, inbound: "accept", sendAllow: "^$" }),
    ),
  ],
  { name: "xterm-256color", cols: 120, rows: 40, cwd: workspace, env: cleanEnvironment() },
);
tui.onData((data) => {
  screen = (screen + data).slice(-20_000);
});

async function until(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  }
  return true;
}

function hookEvents(): Array<{ role: string; input: Record<string, unknown> }> {
  if (!existsSync(hookLog)) return [];
  return readFileSync(hookLog, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { role: string; input: Record<string, unknown> });
}

const summary: Record<string, unknown> = { run };
let sender: ClaudeSpikeProcess | undefined;
try {
  // Accept the workspace trust dialog if it appears; SessionStart marks a ready TUI.
  await until(() => /trust/i.test(screen) || hookEvents().some((e) => e.role === name), 30_000);
  if (/trust/i.test(screen)) {
    // The dialog defaults to "No, exit": move to "Yes, I trust this folder" first.
    tui.write("\u001b[B");
    await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    tui.write("\r");
  }
  summary.tuiStarted = await until(
    () => hookEvents().some((e) => e.role === name && e.input.hook_event_name === "SessionStart"),
    30_000,
  );
  await new Promise((resolveWait) => setTimeout(resolveWait, 3_000));

  sender = new ClaudeSpikeProcess({
    name: "naru-spike-s4",
    runDirectory: run,
    settings: spikeSettings({ role: "naru-spike-s4", runDirectory: run, sendAllow: `^${name}$` }),
  });
  sender.send(
    `[naru-spike] Automated experiment. Call SendMessage once to \`${name}\` with the text 'SPIKE-TUI-PING reply with ACK only'. Do not message anything else. Report the tool result verbatim.`,
  );
  await sender.waitForResults(1, 180_000);
  summary.tuiPromptHook = await until(
    () =>
      hookEvents().some(
        (e) =>
          e.role === name &&
          e.input.hook_event_name === "UserPromptSubmit" &&
          String(e.input.prompt).includes("SPIKE-TUI-PING"),
      ),
    90_000,
  );
  summary.tuiStopAfterMessage = await until(
    () =>
      hookEvents().filter((e) => e.role === name && e.input.hook_event_name === "Stop").length >= 1,
    90_000,
  );
  const prompt = hookEvents().find(
    (e) => e.role === name && e.input.hook_event_name === "UserPromptSubmit",
  )?.input.prompt;
  summary.promptPrefix =
    typeof prompt === "string" ? prompt.split("\n")[0]?.replace(/uds:[^"]+/, "uds:<socket>") : null;
  summary.senderTools = toolUses(sender.events).map((use) => ({
    name: use.name,
    result:
      use.name === "ListAgents"
        ? "<redacted>"
        : toolResults(sender!.events).get(use.id)?.slice(0, 200),
  }));
} finally {
  await sender?.close();
  tui.write("\u0003");
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  tui.write("\u0003");
  await new Promise((resolveWait) => setTimeout(resolveWait, 1_500));
  tui.kill();
  writeFileSync(resolve(run, "summary.json"), JSON.stringify(summary, null, 2), { mode: 0o600 });
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}
