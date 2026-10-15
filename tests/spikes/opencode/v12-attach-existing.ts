import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { report, spikeConfig } from "./client.js";
import { startPty } from "./pty.js";

/**
 * Attach the official TUI to an existing (e.g. child) session and check that a marker from its
 * history is rendered. With [typedMarker], also submit a prompt from the TUI asking for that marker.
 * Usage: v12-attach-existing.ts <sessionId> <marker> [typedMarker]
 */
const [sessionId, marker, typedMarker] = process.argv.slice(2);
if (sessionId === undefined || marker === undefined)
  throw new Error("sessionId and marker required");
const config = spikeConfig();
const tui = startPty(
  process.env.OPENCODE_SPIKE_EXECUTABLE ?? join(homedir(), ".opencode/bin/opencode"),
  ["attach", config.baseUrl, "--session", sessionId],
  {
    cwd: config.directory,
    env: {
      HOME: homedir(),
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      TERM: "xterm-256color",
      LANG: "en_US.UTF-8",
      OPENCODE_SERVER_PASSWORD: readFileSync(
        process.env.OPENCODE_SPIKE_PASSWORD_FILE!,
        "utf8",
      ).trim(),
    },
  },
);
try {
  const rendered = await tui
    .waitForScreen((screen) => screen.includes(marker), 60_000, marker)
    .then(() => true)
    .catch(() => false);
  writeFileSync(join(config.logDirectory, `attach-existing-${sessionId}.txt`), tui.screen(), {
    mode: 0o600,
  });
  report("attachRendersHistory", rendered);
  if (typedMarker !== undefined) {
    tui.type(`[naru-spike] Reply with exactly ${typedMarker}. No tools.`);
    await new Promise((resolve) => setTimeout(resolve, 500));
    tui.type("\r");
    const replied = await tui
      .waitForScreen(
        (screen) => screen.split(typedMarker).length > 2,
        180_000,
        `${typedMarker} reply`,
      )
      .then(() => true)
      .catch(() => false);
    report("tuiPromptAnswered", replied);
  }
} finally {
  tui.close();
}
