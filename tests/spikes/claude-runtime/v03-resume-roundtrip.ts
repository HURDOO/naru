import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  SpikePty,
  claudeExecutable,
  report,
  resultText,
  runPrint,
  spikeEnvironment,
  workspaceDirectory,
} from "./common.js";
import { ISOLATED_SETTING_SOURCES, captureHookSettings, readHookPayloads } from "./hooks.js";

/**
 * V03: print (SDK-equivalent stream-json) turn -> TUI `--resume` turn -> print `--resume` turn.
 * Codewords are random per run; recall is checked through a transformation (reversed, lowercase)
 * so the TUI's own rendering of resumed history cannot satisfy the check.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const sessionId = randomUUID();
const first = `ALPHA${randomBytes(3).toString("hex").toUpperCase()}`;
const second = `BETA${randomBytes(3).toString("hex").toUpperCase()}`;
const reversed = (value: string): string => [...value.toLowerCase()].reverse().join("");
const hookEvents = ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];

const printOne = await runPrint({
  label: "v03-roundtrip-1-print",
  args: [
    "--model",
    model,
    "--session-id",
    sessionId,
    ...ISOLATED_SETTING_SOURCES,
    "--settings",
    captureHookSettings("v03-roundtrip-1-print", hookEvents),
    `[naru-spike] Remember the codeword ${first}. Reply only with OK.`,
  ],
});
report("V03.print-1", {
  exitCode: printOne.exitCode,
  sessionIdMatchesRequested: printOne.sessionId === sessionId,
});

const tui = new SpikePty(
  "v03-roundtrip-2-tui",
  claudeExecutable(),
  [
    "--model",
    model,
    "--resume",
    sessionId,
    ...ISOLATED_SETTING_SOURCES,
    "--settings",
    captureHookSettings("v03-roundtrip-2-tui", hookEvents),
  ],
  workspaceDirectory(),
  spikeEnvironment(),
);
const trustDialog = await tui.acceptWorkspaceTrust(60_000);
const ready = await tui.waitForPrompt();
const historyVisible = await tui.waitFor(new RegExp(first), 20_000);
tui.saveScreen("v03-roundtrip-2-tui-before");
await tui.submit(
  `[naru-spike] Write the first codeword reversed in lowercase, then remember the second codeword ${second}.`,
);
const recalledInTui = await tui.waitFor(new RegExp(reversed(first)), 180_000);
await delay(3_000);
tui.saveScreen("v03-roundtrip-2-tui-after");
await tui.submit("/exit");
const tuiExited = await tui.waitForExit(30_000);
if (!tuiExited) tui.kill();
const tuiHooks = readHookPayloads("v03-roundtrip-2-tui");
const tuiSessionIds = [...new Set(tuiHooks.map((payload) => payload.session_id))];
report("V03.tui-resume", {
  trustDialog,
  ready,
  historyVisibleOnResume: historyVisible,
  recalledFirstCodeword: recalledInTui,
  exited: tuiExited,
  hookSessionIdsSameAsOriginal: tuiSessionIds.length === 1 && tuiSessionIds[0] === sessionId,
  hookSessionIdCount: tuiSessionIds.length,
  sessionStartSources: tuiHooks
    .filter((payload) => payload.hook_event_name === "SessionStart")
    .map((payload) => payload.source),
});

const printThree = await runPrint({
  label: "v03-roundtrip-3-print",
  args: [
    "--model",
    model,
    "--resume",
    sessionId,
    ...ISOLATED_SETTING_SOURCES,
    `[naru-spike] Reply with both codewords reversed in lowercase, separated by a space.`,
  ],
});
const text = resultText(printThree).toLowerCase();
report("V03.print-3-resume", {
  exitCode: printThree.exitCode,
  sameSessionId: printThree.sessionId === sessionId,
  recalledFirst: text.includes(reversed(first)),
  recalledSecondFromTui: text.includes(reversed(second)),
});
