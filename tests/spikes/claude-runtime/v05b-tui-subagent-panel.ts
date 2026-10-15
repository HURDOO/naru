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
 * V05b: can a person talk to a *running* native subagent from the interactive TUI's agent panel?
 * The earlier V05 L3 result only covered the stream-json/SDK client path. This drives the real TUI
 * in a PTY: start a long foreground subagent, open it from the panel, type a marker instruction and
 * check (via the official SubagentStop hook) whether the child acted on it.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const label = `v05b-panel-${Date.now()}`;
const marker = `PANELMARK${Math.floor(Math.random() * 9000 + 1000)}`;
const hooks = captureHookSettings(label, [
  "SubagentStart",
  "SubagentStop",
  "UserPromptSubmit",
  "Stop",
]);
const tui = new SpikePty(
  label,
  claudeExecutable(),
  [...ISOLATED_SETTING_SOURCES, "--settings", hooks, "--model", model],
  workspaceDirectory(),
  spikeEnvironment(),
);
const results: Record<string, unknown> = {};
const startedAt = Date.now();

/** Stops and removes only background sessions this run left in the spike workspace. */
function cleanupSpikeSessions(since: number): number {
  const run = (args: string[]) =>
    execFileSync(claudeExecutable(), args, {
      cwd: workspaceDirectory(),
      env: spikeEnvironment(),
      encoding: "utf8",
    });
  const listed = JSON.parse(run(["agents", "--json", "--all"])) as unknown;
  const items = (Array.isArray(listed) ? listed : []) as {
    id?: string;
    cwd?: string;
    startedAt?: number;
  }[];
  let cleaned = 0;
  for (const item of items) {
    if (item.cwd !== workspaceDirectory() || (item.startedAt ?? 0) < since || !item.id) continue;
    run(["stop", item.id]);
    run(["rm", item.id]);
    cleaned += 1;
  }
  return cleaned;
}
const hookCount = (event: string) =>
  readHookPayloads(label).filter((payload) => payload.hook_event_name === event).length;
try {
  await tui.acceptWorkspaceTrust();
  results.promptReady = await tui.waitForPrompt();
  await tui.submit(
    "[naru-spike] Use the Agent/Task tool to start exactly one general-purpose subagent in the " +
      "foreground (not background). Give it exactly this task: 'Run `sleep 50` with the Bash tool. " +
      "After it finishes, reply with CHILD-DONE followed by any extra words a person asked you to " +
      "include while you were running.' Wait for it, then reply PARENT-DONE.",
  );
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline && hookCount("SubagentStart") === 0) await delay(500);
  results.subagentStarted = hookCount("SubagentStart") > 0;
  await delay(4_000);
  tui.saveScreen(`${label}-1-running`);

  // "↓ to manage" opens this session's own Background dialog (Shells, Local agents). Never use
  // "←": it opens the account-wide session dashboard that also lists unrelated sessions.
  tui.write("\u001b[B");
  await delay(1_500);
  tui.write("\r");
  await delay(1_500);
  tui.saveScreen(`${label}-2-background`);
  // Move from the shell row to the agent row, then view the agent.
  for (let step = 0; step < 4 && !/❯\s*⏺\s*Run sleep subagent/.test(tui.screen()); step += 1) {
    tui.write("\u001b[B");
    await delay(700);
  }
  results.agentRowSelected = /❯\s*⏺\s*Run sleep subagent/.test(tui.screen());
  tui.saveScreen(`${label}-3-agent-row`);
  // "f to foreground" brings the selected subagent into the main view.
  tui.write("f");
  await delay(3_000);
  tui.saveScreen(`${label}-3-agent-foreground`);
  await tui.submit(`Also include the word ${marker} in your final reply.`);
  await delay(3_000);
  tui.saveScreen(`${label}-4-typed`);

  const stopDeadline = Date.now() + 120_000;
  while (Date.now() < stopDeadline && hookCount("SubagentStop") === 0) await delay(1_000);
  await tui.waitFor(/PARENT-DONE/, 60_000);
  tui.saveScreen(`${label}-5-final`);
  const payloads = readHookPayloads(label);
  const stop = payloads.find((payload) => payload.hook_event_name === "SubagentStop");
  const childReply =
    typeof stop?.last_assistant_message === "string" ? stop.last_assistant_message : "";
  results.subagentStopped = stop !== undefined;
  results.childReplyHasMarker = childReply.includes(marker);
  results.childReplyHasDone = childReply.includes("CHILD-DONE");
  const prompts = payloads.filter((payload) => payload.hook_event_name === "UserPromptSubmit");
  const markerPrompt = prompts.find(
    (payload) => typeof payload.prompt === "string" && payload.prompt.includes(marker),
  );
  results.markerPromptHookSeen = markerPrompt !== undefined;
  results.markerPromptHookKeys = markerPrompt === undefined ? [] : Object.keys(markerPrompt).sort();
  results.markerPromptAgentId =
    markerPrompt === undefined ? null : typeof markerPrompt.agent_id === "string";
  results.parentScreenHasMarker = tui.screen().includes(marker);
} finally {
  tui.write("\u0003");
  await delay(500);
  tui.write("\u0003");
  await tui.waitForExit(10_000);
  tui.kill();
  results.cleanedSessions = cleanupSpikeSessions(startedAt);
  report("V05b.tui-subagent-panel", results);
}
