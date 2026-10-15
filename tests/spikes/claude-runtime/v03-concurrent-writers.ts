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
import { ISOLATED_SETTING_SOURCES } from "./hooks.js";

/**
 * V03 concurrency: what happens when two writers continue one Claude session.
 * Case A: two `-p --resume` turns start at the same time.
 * Case B: an idle TUI holds the resumed session while a `-p --resume` turn lands, then the TUI
 * sends its own turn. Recall is checked through reversed lowercase codewords.
 */
const model = process.env.NARU_SPIKE_MODEL ?? "sonnet";
const code = (prefix: string): string => `${prefix}${randomBytes(3).toString("hex").toUpperCase()}`;
const reversed = (value: string): string => [...value.toLowerCase()].reverse().join("");
const base = [...ISOLATED_SETTING_SOURCES, "--model", model];

async function seed(label: string, sessionId: string, codeword: string): Promise<void> {
  await runPrint({
    label,
    args: [
      ...base,
      "--session-id",
      sessionId,
      `[naru-spike] Remember codeword ${codeword}. Reply only OK.`,
    ],
  });
}

async function recall(
  label: string,
  sessionId: string,
  codewords: readonly string[],
): Promise<Record<string, boolean>> {
  const run = await runPrint({
    label,
    args: [
      ...base,
      "--resume",
      sessionId,
      "[naru-spike] List every codeword you were asked to remember, each reversed in lowercase, space separated.",
    ],
  });
  const text = resultText(run).toLowerCase();
  return Object.fromEntries(
    codewords.map((codeword, index) => [`codeword${index}`, text.includes(reversed(codeword))]),
  );
}

// Case A: concurrent print resumes.
const sessionA = randomUUID();
const a0 = code("ZERO");
const a1 = code("LEFT");
const a2 = code("RIGHT");
await seed("v03-concurrent-a-seed", sessionA, a0);
const [left, right] = await Promise.all([
  runPrint({
    label: "v03-concurrent-a-left",
    args: [...base, "--resume", sessionA, `[naru-spike] Remember codeword ${a1}. Reply only OK.`],
  }),
  runPrint({
    label: "v03-concurrent-a-right",
    args: [...base, "--resume", sessionA, `[naru-spike] Remember codeword ${a2}. Reply only OK.`],
  }),
]);
report("V03.concurrent-print", {
  leftExit: left.exitCode,
  rightExit: right.exitCode,
  leftSameSession: left.sessionId === sessionA,
  rightSameSession: right.sessionId === sessionA,
  leftError: left.result?.is_error,
  rightError: right.result?.is_error,
  recallAfter: await recall("v03-concurrent-a-recall", sessionA, [a0, a1, a2]),
});

// Case B: idle TUI + print turn, then TUI turn.
const sessionB = randomUUID();
const b0 = code("BASE");
const bPrint = code("PRINT");
const bTui = code("TUI");
await seed("v03-concurrent-b-seed", sessionB, b0);
const tui = new SpikePty(
  "v03-concurrent-b-tui",
  claudeExecutable(),
  [...base, "--resume", sessionB],
  workspaceDirectory(),
  spikeEnvironment(),
);
await tui.acceptWorkspaceTrust();
const tuiReady = await tui.waitForPrompt();
const printWhileTuiOpen = await runPrint({
  label: "v03-concurrent-b-print",
  args: [...base, "--resume", sessionB, `[naru-spike] Remember codeword ${bPrint}. Reply only OK.`],
});
await delay(5_000);
const tuiShowsPrintTurnLive = tui.screen().includes(bPrint);
await tui.submit(
  `[naru-spike] Remember codeword ${bTui}. Then list every codeword you know, each reversed in lowercase.`,
);
const tuiAnswered = await tui.waitFor(new RegExp(reversed(bTui)), 180_000);
await delay(2_000);
const tuiKnowsPrintTurn = tui.screen().includes(reversed(bPrint));
tui.saveScreen("v03-concurrent-b-tui");
await tui.submit("/exit");
if (!(await tui.waitForExit())) tui.kill();
report("V03.tui-plus-print", {
  tuiReady,
  printExit: printWhileTuiOpen.exitCode,
  printSameSession: printWhileTuiOpen.sessionId === sessionB,
  tuiShowsPrintTurnLive,
  tuiAnswered,
  tuiKnowsPrintTurn,
  recallAfter: await recall("v03-concurrent-b-recall", sessionB, [b0, bPrint, bTui]),
});
