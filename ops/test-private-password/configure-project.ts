/** Narrow, atomic update of the isolated server's Claude executable and exact project root. */
import { randomUUID } from "node:crypto";
import { accessSync, constants, lstatSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { inspectExecutable, readPrivateJson } from "../workstation/distribution/security.js";
import { assertOwnerOnlyTestRoot, parseSettings } from "./server.js";

function latestClaudeExecutable(): string {
  for (const directory of (process.env.PATH ?? "").split(":")) {
    if (!directory) continue;
    const candidate = join(directory, "claude");
    try {
      const canonical = realpathSync(candidate);
      inspectExecutable(canonical);
      return canonical;
    } catch {
      continue;
    }
  }
  throw new Error("Claude Code executable is unavailable.");
}

function exactOwnerProject(path: string, uid: number): string {
  if (!isAbsolute(path) || realpathSync(path) !== path) {
    throw new Error("Project path must be an absolute canonical path.");
  }
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.uid !== uid) {
    throw new Error("Project must be an owner directory.");
  }
  accessSync(path, constants.R_OK | constants.X_OK);
  return path;
}

function main(): void {
  const [root, project] = process.argv.slice(2);
  if (root === undefined || project === undefined || process.argv.length !== 4) {
    throw new Error("Expected test root and project.");
  }
  assertOwnerOnlyTestRoot(root);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("Owner identity is unavailable.");
  const settingsPath = join(root, "settings.json");
  const settings = parseSettings(readPrivateJson(settingsPath, uid));
  const exactProjectRoot = exactOwnerProject(project, uid);
  if (settings.exactProjectRoot !== undefined && settings.exactProjectRoot !== exactProjectRoot) {
    throw new Error("A different exact test project is already configured.");
  }
  const nextSettings = {
    ...settings,
    claudeExecutable: latestClaudeExecutable(),
    exactProjectRoot,
  };
  const pending = join(root, `settings.pending.${randomUUID()}.json`);
  writeFileSync(pending, JSON.stringify(nextSettings), { mode: 0o600, flag: "wx" });
  renameSync(pending, settingsPath);
  process.stdout.write("Isolated Claude test settings updated.\n");
}

try {
  main();
} catch {
  process.stderr.write(
    "Isolated Claude test settings update failed; production was not changed.\n",
  );
  process.exitCode = 1;
}
