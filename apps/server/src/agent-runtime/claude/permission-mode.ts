import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Claude permission modes Naru may start an agent in (SDK spelling; the runner plan's set). */
export type ClaudePermissionMode = "default" | "acceptEdits" | "plan" | "auto";

const MODES: ReadonlySet<string> = new Set(["default", "acceptEdits", "plan", "auto"]);

/**
 * The mode the person's own Claude starts in (AP-D024): `permissions.defaultMode` from the
 * project's local, project or the user's settings (in that order), else auto. Naru passes it
 * explicitly because an SDK session or a resumed one does not choose it by itself: left unset,
 * Claude keeps the resumed conversation's previous mode. `bypassPermissions` is never applied by
 * Naru, and `dontAsk` is not one the runner takes yet; both fall back to auto like an unknown value.
 */
export function personPermissionMode(
  projectPath: string,
  home: string = homedir(),
): ClaudePermissionMode {
  for (const file of [
    join(projectPath, ".claude", "settings.local.json"),
    join(projectPath, ".claude", "settings.json"),
    join(home, ".claude", "settings.json"),
  ]) {
    const mode = defaultModeIn(file);
    if (mode === undefined) continue;
    const normalized = mode === "manual" ? "default" : mode;
    return MODES.has(normalized) ? (normalized as ClaudePermissionMode) : "auto";
  }
  return "auto";
}

/** The CLI spells the ask-every-time mode `manual`. */
export function cliPermissionMode(mode: ClaudePermissionMode): string {
  return mode === "default" ? "manual" : mode;
}

function defaultModeIn(file: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined; // absent or unreadable settings do not decide anything
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const permissions = (parsed as { permissions?: unknown }).permissions;
  if (typeof permissions !== "object" || permissions === null) return undefined;
  const mode = (permissions as { defaultMode?: unknown }).defaultMode;
  return typeof mode === "string" ? mode : undefined;
}
