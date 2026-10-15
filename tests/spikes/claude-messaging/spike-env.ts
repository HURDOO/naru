import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

export const SPIKE_DIR = here;
export const REPO_ROOT = resolve(here, "../../..");

/** Raw transcripts stay outside the repository (default: sibling `experiments/` of the worktrees dir). */
export const LOG_ROOT = resolve(
  process.env.NARU_SPIKE_LOG_DIR ??
    resolve(REPO_ROOT, "../../experiments/naru-agent-spikes/claude-messaging"),
);

export function requireClaudeExecutable(): string {
  const executable = process.env.NARU_SPIKE_CLAUDE;
  if (executable === undefined || executable === "") {
    throw new Error("Set NARU_SPIKE_CLAUDE to the canonical Claude Code executable.");
  }
  return executable;
}

export function runDirectory(experiment: string): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const directory = resolve(LOG_ROOT, "runs", `${experiment}-${stamp}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return directory;
}

/**
 * Child env built from scratch. Inherited CLAUDE_* variables would point spike sessions (and
 * their hooks/Bash) at the parent session's inbox socket, so none are passed through.
 */
export function cleanEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const keep = ["HOME", "USER", "LOGNAME", "LANG", "TMPDIR", "SHELL"];
  const environment: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TERM: "xterm-256color",
  };
  for (const key of keep) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return { ...environment, ...extra };
}

export function nodeCommand(script: string): string {
  return `${JSON.stringify(process.execPath)} ${JSON.stringify(resolve(SPIKE_DIR, script))}`;
}
