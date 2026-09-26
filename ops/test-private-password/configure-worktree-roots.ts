/** Add only the two owner-owned sibling worktree directories to the isolated test server. */
import { randomUUID } from "node:crypto";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readPrivateJson } from "../workstation/distribution/security.js";
import { approvedSiblingWorktreeRoots, assertOwnerOnlyTestRoot, parseSettings } from "./server.js";

function main(): void {
  const root = process.argv[2];
  if (root === undefined || process.argv.length !== 3) throw new Error("Expected one test root.");
  assertOwnerOnlyTestRoot(root);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Owner identity is unavailable.");
  const settingsPath = join(root, "settings.json");
  const settings = parseSettings(readPrivateJson(settingsPath, uid));
  if (settings.exactProjectRoot === undefined) {
    throw new Error("The exact test project must be configured first.");
  }
  const worktreeRoots = approvedSiblingWorktreeRoots(settings.exactProjectRoot, uid);
  const pending = join(root, `settings.pending.${randomUUID()}.json`);
  writeFileSync(pending, JSON.stringify({ ...settings, worktreeRoots }), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(pending, settingsPath);
  process.stdout.write("Two sibling worktree roots added to isolated test settings.\n");
}

try {
  main();
} catch {
  process.stderr.write("Isolated worktree root update failed; production was not changed.\n");
  process.exitCode = 1;
}
