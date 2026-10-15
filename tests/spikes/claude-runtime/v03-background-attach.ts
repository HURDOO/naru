import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpikePty,
  claudeExecutable,
  report,
  spikeEnvironment,
  workspaceDirectory,
} from "./common.js";
import { ISOLATED_SETTING_SOURCES } from "./hooks.js";

/**
 * V03 background sessions: `claude --bg` runs the TUI inside a Claude-owned daemon PTY. This checks
 * live attach from two terminals, whether input is arbitrated between them, detach survival and what
 * `--bg --resume` does for a session that is still running. Only sessions created here are stopped.
 */
interface AgentRow {
  readonly id?: string;
  readonly sessionId?: string;
  readonly name?: string;
  readonly kind?: string;
  readonly status?: string;
  readonly state?: string;
  readonly pid?: number;
}

const name = `naru-spike-bg-${Date.now().toString(36)}`;

function cli(args: readonly string[]): { status: number | null; stdout: string } {
  const result = spawnSync(claudeExecutable(), args, {
    cwd: workspaceDirectory(),
    env: spikeEnvironment(),
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: result.status, stdout: `${result.stdout}${result.stderr}` };
}

function agents(): AgentRow[] {
  const result = cli(["agents", "--json", "--all"]);
  try {
    return JSON.parse(result.stdout) as AgentRow[];
  } catch {
    return [];
  }
}

const started = cli([
  "--bg",
  ...ISOLATED_SETTING_SOURCES,
  "--model",
  "sonnet",
  "-n",
  name,
  "[naru-spike] Without using any tools, write the integers from 1 to 1500, one per line, and nothing else.",
]);
const shortId = /backgrounded · ([0-9a-f]{8})/.exec(started.stdout)?.[1];
if (shortId === undefined) throw new Error("Background session id was not printed.");
await delay(4_000);
const row = agents().find((entry) => entry.name === name);

const first = new SpikePty(
  "v03-bg-attach-a",
  claudeExecutable(),
  ["attach", shortId],
  workspaceDirectory(),
  spikeEnvironment(),
);
const second = new SpikePty(
  "v03-bg-attach-b",
  claudeExecutable(),
  ["attach", shortId],
  workspaceDirectory(),
  spikeEnvironment(),
);
await delay(5_000);
const firstEarly = first.screen();
const secondEarly = second.screen();
const busyEarly = agents().find((entry) => entry.name === name)?.status;
await delay(6_000);
const firstLater = first.screen();
const secondLater = second.screen();
const sameRenderLater = firstLater === secondLater;
const finished = await first.waitFor(/\b1500\b/, 300_000);
await delay(3_000);

// Input arbitration: type into A without submitting, look for the draft in B.
const marker = `draftmark${Date.now().toString(36)}`;
first.write(marker);
await delay(2_000);
const draftVisibleInSecond = second.screen().includes(marker);
for (let index = 0; index < marker.length; index += 1) first.write("\u007f");
await delay(1_000);

// Submit from B and look for the reply in A.
const replyMarker = `REPLYB${Date.now().toString(36).toUpperCase()}`;
await second.submit(`[naru-spike] Reply only with ${replyMarker}.`);
const replySeenInFirst = await first.waitFor(
  new RegExp(`${replyMarker}[\\s\\S]*${replyMarker}`),
  120_000,
);
first.saveScreen("v03-bg-attach-a");
second.saveScreen("v03-bg-attach-b");

// Detach both terminals; the background session should survive.
first.kill();
second.kill();
await delay(3_000);
const afterDetach = agents().find((entry) => entry.name === name);

// `--bg --resume` while the original is still alive.
const resumeWhileRunning = cli([
  "--bg",
  ...ISOLATED_SETTING_SOURCES,
  "--model",
  "sonnet",
  "--resume",
  row?.sessionId ?? "",
  "[naru-spike] Reply only OK.",
]);
const copyId = /backgrounded · ([0-9a-f]{8})/.exec(resumeWhileRunning.stdout)?.[1];
const resumeMessage = resumeWhileRunning.stdout
  .split("\n")
  .filter((line) => !/^\s*claude (agents|attach|logs|stop)/.test(line))
  .join(" ")
  .replaceAll(/[0-9a-f]{8}-[0-9a-f-]{27}/g, "<session>")
  .slice(0, 300);
await delay(5_000);
const copyRow = agents().find((entry) => entry.id === copyId);

report("V03.background", {
  shortIdPrinted: true,
  listedAsBackground: row?.kind === "background",
  busyWhileObserved: busyEarly,
  liveInFirst: firstLater !== firstEarly,
  liveInSecond: secondLater !== secondEarly,
  sameRenderLater,
  finished,
  draftVisibleInSecond,
  replySeenInFirst,
  survivesDetach: afterDetach?.pid !== undefined,
  stateAfterDetach: afterDetach?.state,
  statusAfterDetach: afterDetach?.status,
  resumeWhileRunningExit: resumeWhileRunning.status,
  resumeWhileRunningCreatedCopy: copyId !== undefined && copyId !== shortId,
  copySessionIdDiffers: copyRow?.sessionId !== undefined && copyRow.sessionId !== row?.sessionId,
  resumeMessage,
});

for (const id of [copyId, shortId]) {
  if (id === undefined) continue;
  cli(["stop", id]);
  cli(["rm", id]);
}
report("V03.background-cleanup", {
  remaining: agents().filter((entry) => entry.name === name || entry.id === copyId).length,
});
