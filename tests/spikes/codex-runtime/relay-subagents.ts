/**
 * V04b end-to-end: the production Codex relay (guardian + app-server + `--remote` TUI) runs in a
 * PTY like a Naru Codex Pane. The synthetic model spawns a slow native subagent; the TUI then opens
 * it through `/subagents`. Reports whether the relay survives and what the child view accepts.
 * RELAY_ROOT selects which checkout's relay to load (to compare before/after a fix).
 */
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type * as PtyModule from "node-pty";
import type * as XtermModule from "@xterm/headless";
import { codex, fakeEnvironment, raw, setup, summary, until, workspace } from "./harness.js";

const require = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
const pty = require("node-pty") as typeof PtyModule;
const xterm = require("@xterm/headless") as typeof XtermModule;

const repository = resolve(new URL("../../..", import.meta.url).pathname);
const relayRoot = resolve(process.env.RELAY_ROOT ?? repository);
const tsx = pathToFileURL(resolve(repository, "node_modules/tsx/dist/loader.mjs")).href;
const directory = setup("relay-subagents");
const fixture = await fakeEnvironment(directory);

const guardian = join(directory, "guardian.mjs");
writeFileSync(
  guardian,
  `import { runCodexInteractionGuardianMode } from ${JSON.stringify(pathToFileURL(join(relayRoot, "apps/server/src/codex-interaction-guardian.ts")).href)};\nawait runCodexInteractionGuardianMode();\n`,
);
const host = join(directory, "relay-host.mjs");
writeFileSync(
  host,
  `import { runCodexInteractionRelay } from ${JSON.stringify(pathToFileURL(join(relayRoot, "apps/server/src/codex-interaction-relay.ts")).href)};
const code = await runCodexInteractionRelay({
  executable: process.env.SPIKE_CODEX,
  args: [],
  environment: process.env,
  bootstrap: "x".repeat(64),
  integrationSocketPath: ${JSON.stringify(join(directory, "unused.sock"))},
  cwd: process.cwd(),
  guardianEntry: ${JSON.stringify(guardian)},
  guardianExecArgv: ["--import", ${JSON.stringify(tsx)}],
});
process.exit(code);
`,
);

const terminal = new xterm.Terminal({
  cols: 140,
  rows: 42,
  scrollback: 5_000,
  allowProposedApi: true,
});
let output = "";
let exited: number | null = null;
const child = pty.spawn(process.execPath, ["--import", tsx, host], {
  cwd: workspace,
  env: { ...fixture.env, SPIKE_CODEX: codex },
  cols: 140,
  rows: 42,
  name: "xterm-256color",
});
raw(directory, "owned-pids.jsonl", { kind: "relay-host", pid: child.pid });
child.onExit(({ exitCode }) => {
  exited = exitCode;
});
child.onData((data) => {
  output += data;
  terminal.write(data);
  if (data.includes("\x1b[6n")) child.write("\x1b[1;1R");
  if (data.includes("\x1b[c")) child.write("\x1b[?1;2c");
  if (data.includes("\x1b[>c")) child.write("\x1b[>0;0;0c");
  if (data.includes("\x1b]11;?")) child.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
});
const screen = (): string => {
  const buffer = terminal.buffer.active;
  return Array.from(
    { length: buffer.length },
    (_, index) => buffer.getLine(index)?.translateToString(true) ?? "",
  ).join("\n");
};
const type = async (text: string): Promise<void> => {
  child.write(text);
  await delay(300);
  child.write("\r");
  await delay(500);
};

const results: Record<string, unknown> = { relayRoot: relayRoot === repository ? "this" : "other" };
try {
  await until(() => exited === null && screen().trim().length > 0, "TUI ready", 30_000);
  await delay(2_000);
  raw(directory, "screen-start.txt", screen());
  await type("SPIKE_SPAWN_CHECK SPIKE_CHILD_TUI");
  await until(() => fixture.requests.length >= 2, "child model request", 30_000);
  await delay(1_500);
  raw(directory, "screen-spawned.txt", screen());
  await type("/subagents");
  await delay(2_000);
  raw(directory, "screen-subagents.txt", screen());
  results.afterPickerRelayAlive = exited === null;
  results.pickerListsChild = screen().includes("/root/bounded_child");
  // The picker opens on the current (Main) agent; move to the subagent before selecting it.
  child.write("\x1b[B");
  await delay(500);
  child.write("\r");
  await delay(3_000);
  raw(directory, "screen-child.txt", screen());
  results.afterSelectRelayAlive = exited === null;
  results.relayFailedCode = output.includes("NARU_CODEX_RELAY_FAILED");
  const before = fixture.requests.length;
  await type("SPIKE_CHILD_VIEW_INPUT");
  await delay(4_000);
  raw(directory, "screen-child-input.txt", screen());
  const reached = fixture.requests
    .slice(before)
    .map((request) => JSON.stringify(request))
    .filter((text) => text.includes("SPIKE_CHILD_VIEW_INPUT"));
  results.childViewInputReachedModel = reached.length > 0;
  results.childViewInputCarriesChildTask = reached.some((text) =>
    text.includes("SPIKE_CHILD_HOLD"),
  );
  results.afterInputRelayAlive = exited === null;
  results.childViewSaysInputDisabled = screen().includes("Direct input is disabled");

  // Back to the main agent: clear the draft, reopen the picker and pick Main.
  child.write("\x15");
  await delay(300);
  await type("/subagents");
  await delay(1_500);
  child.write("\x1b[A");
  await delay(500);
  child.write("\r");
  await delay(2_000);
  const beforeMain = fixture.requests.length;
  await type("SPIKE_MAIN_AFTER_CHILD");
  await until(() => fixture.requests.length > beforeMain, "main model request", 20_000).catch(
    () => undefined,
  );
  await delay(1_500);
  raw(directory, "screen-main-again.txt", screen());
  results.mainInputAfterChildReachedModel = fixture.requests
    .slice(beforeMain)
    .some((request) => JSON.stringify(request).includes("SPIKE_MAIN_AFTER_CHILD"));
  results.afterMainRelayAlive = exited === null;
} catch (error) {
  results.error = error instanceof Error ? error.message : "unknown";
  raw(directory, "screen-failure.txt", screen());
} finally {
  results.exitCode = exited;
  summary(directory, results);
  console.log(JSON.stringify(results));
  if (exited === null) {
    child.write("\x03");
    await delay(300);
    child.write("\x03");
    await delay(1_500);
    if (exited === null) child.kill("SIGTERM");
  }
  await fixture.close();
  terminal.dispose();
}
