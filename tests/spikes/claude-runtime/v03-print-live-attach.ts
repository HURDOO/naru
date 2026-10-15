import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpikePty,
  claudeExecutable,
  report,
  runPrint,
  spikeEnvironment,
  userMessageLine,
  workspaceDirectory,
} from "./common.js";
import { ISOLATED_SETTING_SOURCES } from "./hooks.js";

/**
 * V03: can a terminal TUI live-attach to a running print/SDK session? `claude attach` targets
 * background sessions; this checks whether a print session is listed and attachable while it runs.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
let probe: Record<string, unknown> = {};
let probed = false;
const run = await runPrint({
  label: "v03-print-live-attach",
  args: [
    ...ISOLATED_SETTING_SOURCES,
    "--model",
    model,
    "--input-format",
    "stream-json",
    "-n",
    "naru-spike-print-attach",
  ],
  input: [
    {
      afterMs: 0,
      line: userMessageLine(
        "[naru-spike] Without using tools, write the integers from 1 to 1200, one per line.",
      ),
    },
  ],
  closeInputWhen: (event) => event.type === "result",
  onEvent: (event) => {
    if (probed || event.type !== "assistant") return;
    probed = true;
    const sessionId = String(event.session_id);
    const listed = spawnSync(claudeExecutable(), ["agents", "--json"], {
      cwd: workspaceDirectory(),
      env: spikeEnvironment(),
      encoding: "utf8",
    });
    let rows: { sessionId?: string; kind?: string; status?: string }[] = [];
    try {
      rows = JSON.parse(listed.stdout) as typeof rows;
    } catch {
      rows = [];
    }
    const row = rows.find((entry) => entry.sessionId === sessionId);
    probe = { listed: row !== undefined, kind: row?.kind, status: row?.status, sessionId };
  },
});
const sessionId = typeof probe.sessionId === "string" ? probe.sessionId : "";
const attach = new SpikePty(
  "v03-print-live-attach-tui",
  claudeExecutable(),
  ["attach", sessionId],
  workspaceDirectory(),
  spikeEnvironment(),
);
await delay(6_000);
const screen = attach.screen();
attach.kill();
report("V03.print-live-attach", {
  printExit: run.exitCode,
  listedWhileRunning: probe.listed,
  listedKind: probe.kind,
  listedStatus: probe.status,
  attachExited: attach.exited !== undefined,
  attachScreenSummary: screen
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-3)
    .join(" | ")
    .slice(0, 200),
});
