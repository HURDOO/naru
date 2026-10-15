import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpikePty,
  claudeExecutable,
  report,
  spikeEnvironment,
  workspaceDirectory,
} from "./common.js";
import { ISOLATED_SETTING_SOURCES, captureHookSettings, readHookPayloads } from "./hooks.js";

/**
 * V05b exploration: sends one key at a time (NARU_SPIKE_KEYS, comma separated: down, up, enter,
 * esc, tab, sdown) while a long subagent runs, saving the screen after each key, then types a
 * marker. Never sends "←" (account-wide dashboard) or ctrl+x. Cleans up sessions it created.
 */
const KEYS: Record<string, string> = {
  down: "\u001b[B",
  up: "\u001b[A",
  enter: "\r",
  esc: "\u001b",
  tab: "\t",
  sdown: "\u001b[1;2B",
};
const sequence = (process.env.NARU_SPIKE_KEYS ?? "down,down,down").split(",");
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const label = `v05b-explore-${Date.now()}`;
const marker = `PANELMARK${Math.floor(Math.random() * 9000 + 1000)}`;
const startedAt = Date.now();
const hooks = captureHookSettings(label, ["SubagentStart", "SubagentStop", "UserPromptSubmit"]);
const tui = new SpikePty(
  label,
  claudeExecutable(),
  [...ISOLATED_SETTING_SOURCES, "--settings", hooks, "--model", model],
  workspaceDirectory(),
  spikeEnvironment(),
);
const results: Record<string, unknown> = { sequence };
const count = (event: string) =>
  readHookPayloads(label).filter((payload) => payload.hook_event_name === event).length;
try {
  await tui.acceptWorkspaceTrust();
  await tui.waitForPrompt();
  await tui.submit(
    "[naru-spike] Start exactly one general-purpose subagent with this task: 'Run `sleep 40` with " +
      "the Bash tool, then reply CHILD-DONE plus any extra words a person asked you to include.' " +
      "Then wait for it and reply PARENT-DONE.",
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && count("SubagentStart") === 0) await delay(500);
  await delay(5_000);
  tui.saveScreen(`${label}-0`);
  for (const [index, key] of sequence.entries()) {
    tui.write(KEYS[key] ?? "");
    await delay(1_800);
    tui.saveScreen(`${label}-${index + 1}-${key}`);
  }
  await tui.submit(`Also include the word ${marker} in your final reply.`);
  await delay(4_000);
  tui.saveScreen(`${label}-typed`);
  // Claude Code also runs internal subagents (e.g. prompt suggestions); match the task's agent id.
  const childId = readHookPayloads(label).find(
    (payload) =>
      payload.hook_event_name === "SubagentStart" && payload.agent_type === "general-purpose",
  )?.agent_id;
  results.childAgentSeen = typeof childId === "string";
  const stopOf = () =>
    readHookPayloads(label).find(
      (payload) => payload.hook_event_name === "SubagentStop" && payload.agent_id === childId,
    );
  const stopDeadline = Date.now() + 180_000;
  while (Date.now() < stopDeadline && stopOf() === undefined) await delay(1_000);
  const payloads = readHookPayloads(label);
  const stop = stopOf();
  results.childStopped = stop !== undefined;
  results.sessionId = stop?.session_id ?? null;
  results.childId = childId ?? null;
  const reply = typeof stop?.last_assistant_message === "string" ? stop.last_assistant_message : "";
  results.childReplyHasMarker = reply.includes(marker);
  const prompt = payloads.find(
    (payload) =>
      payload.hook_event_name === "UserPromptSubmit" &&
      typeof payload.prompt === "string" &&
      payload.prompt.includes(marker),
  );
  results.markerPromptHook = prompt === undefined ? null : Object.keys(prompt).sort();
  results.markerPromptAgentType = prompt?.agent_type ?? null;
} finally {
  tui.write("\u0003");
  await delay(500);
  tui.write("\u0003");
  await tui.waitForExit(10_000);
  tui.kill();
  const run = (args: string[]) =>
    execFileSync(claudeExecutable(), args, {
      cwd: workspaceDirectory(),
      env: spikeEnvironment(),
      encoding: "utf8",
    });
  const listed = JSON.parse(run(["agents", "--json", "--all"])) as {
    id?: string;
    cwd?: string;
    startedAt?: number;
  }[];
  let cleaned = 0;
  for (const item of listed) {
    if (item.cwd !== workspaceDirectory() || (item.startedAt ?? 0) < startedAt || !item.id)
      continue;
    run(["stop", item.id]);
    run(["rm", item.id]);
    cleaned += 1;
  }
  results.cleaned = cleaned;
  results.label = label;
  report("V05b.explore", results);
}
