import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpikePty,
  claudeExecutable,
  report,
  resultText,
  requiredEnv,
  runPrint,
  spikeEnvironment,
  userMessageLine,
  workspaceDirectory,
} from "./common.js";
import { ISOLATED_SETTING_SOURCES, captureHookSettings, readHookPayloads } from "./hooks.js";

/**
 * V07: Agent Teams (experimental). Print mode is expected to run named agents as ordinary
 * subagents; the interactive TUI is expected to spawn in-process teammates. Team runtime files are
 * only listed (names, member count), never edited.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const teamsEnv = { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" };
const teamsRoot = join(requiredEnv("HOME"), ".claude", "teams");
const hookEvents = [
  "SessionStart",
  "SubagentStart",
  "SubagentStop",
  "TeammateIdle",
  "TaskCreated",
  "TaskCompleted",
];
const spawnPrompt =
  "[naru-spike] Create an agent team. Spawn exactly one teammate named scout (general-purpose). " +
  "Tell scout to run `ls` in the current directory and send you the file count. When scout reports, " +
  "reply with SCOUT-DONE and the count, then ask scout to shut down.";

function teamSnapshot(sessionId: string | undefined): Record<string, unknown> {
  if (sessionId === undefined) return { team: "unknown-session" };
  const name = `session-${sessionId.slice(0, 8)}`;
  const configPath = join(teamsRoot, name, "config.json");
  if (!existsSync(configPath))
    return { teamDirectory: existsSync(join(teamsRoot, name)), configExists: false };
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      members?: { name?: string; agentType?: string }[];
    };
    const inboxes = join(teamsRoot, name, "inboxes");
    return {
      teamDirectory: true,
      configExists: true,
      memberCount: config.members?.length ?? 0,
      memberNames: (config.members ?? []).map((member) => member.name),
      memberTypes: (config.members ?? []).map((member) => member.agentType),
      inboxFiles: existsSync(inboxes) ? readdirSync(inboxes).length : 0,
      configKeys: Object.keys(config).sort(),
    };
  } catch {
    return { teamDirectory: true, configExists: true, parseable: false };
  }
}

function claudeProcessCount(): number {
  const rows = execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" }).split("\n");
  return rows.filter((row) => row.trim().endsWith("claude.exe")).length;
}

// Print mode with teams enabled.
let printTeam: Record<string, unknown> = {};
const printed = await runPrint({
  label: "v07-teams-print",
  args: [
    ...ISOLATED_SETTING_SOURCES,
    "--model",
    model,
    "--input-format",
    "stream-json",
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(ls *) Bash(ls)",
    "--settings",
    captureHookSettings("v07-teams-print", hookEvents),
  ],
  environment: spikeEnvironment(teamsEnv),
  input: [{ afterMs: 0, line: userMessageLine(spawnPrompt) }],
  closeInputWhen: (event) => event.type === "result",
  onEvent: (event) => {
    if (event.type === "system" && event.subtype === "task_started")
      printTeam = teamSnapshot(String(event.session_id));
  },
});
const printTasks = printed.events
  .filter((event) => event.value.subtype === "task_started")
  .map((event) => `${String(event.value.task_type)}:${String(event.value.subagent_type)}`);
report("V07.print", {
  exitCode: printed.exitCode,
  tasksStarted: printTasks,
  teamDuringRun: printTeam,
  teammateIdleHooks: readHookPayloads("v07-teams-print").filter(
    (payload) => payload.hook_event_name === "TeammateIdle",
  ).length,
  resultMentionsScoutDone: resultText(printed).includes("SCOUT-DONE"),
});

// Interactive TUI with teams enabled.
const before = claudeProcessCount();
const tui = new SpikePty(
  "v07-teams-tui",
  claudeExecutable(),
  [
    ...ISOLATED_SETTING_SOURCES,
    "--model",
    model,
    "--permission-mode",
    "acceptEdits",
    "--allowedTools",
    "Bash(ls *)",
    "Bash(ls)",
    "--settings",
    captureHookSettings("v07-teams-tui", hookEvents),
  ],
  workspaceDirectory(),
  spikeEnvironment(teamsEnv),
);
await tui.acceptWorkspaceTrust();
const ready = await tui.waitForPrompt();
await tui.submit(spawnPrompt);
const scoutVisible = await tui.waitFor(/scout/i, 120_000);
await delay(4_000);
const sessionStart = readHookPayloads("v07-teams-tui").find(
  (payload) => payload.hook_event_name === "SessionStart",
);
const sessionId =
  typeof sessionStart?.session_id === "string" ? sessionStart.session_id : undefined;
const teamWhileRunning = teamSnapshot(sessionId);
const processesWhileRunning = claudeProcessCount() - before;
tui.saveScreen("v07-teams-tui-running");
const done = await tui.waitFor(/SCOUT-DONE/, 240_000);
await delay(3_000);
tui.saveScreen("v07-teams-tui-done");
const hooks = readHookPayloads("v07-teams-tui");
await tui.submit("/exit");
if (!(await tui.waitForExit())) tui.kill();
await delay(2_000);
report("V07.tui", {
  ready,
  scoutVisible,
  done,
  teamWhileRunning,
  extraClaudeProcessesWhileRunning: processesWhileRunning,
  hookCounts: Object.fromEntries(
    hookEvents.map((name) => [
      name,
      hooks.filter((payload) => payload.hook_event_name === name).length,
    ]),
  ),
  teamDirectoryAfterExit:
    sessionId === undefined
      ? null
      : existsSync(join(teamsRoot, `session-${sessionId.slice(0, 8)}`)),
});
process.stdout.write(`${JSON.stringify({ item: "V07.tui-session", sessionId })}\n`);
