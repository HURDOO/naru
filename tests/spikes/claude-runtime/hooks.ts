import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { logDirectory } from "./common.js";

/**
 * Builds a `--settings` JSON string whose command hooks append each raw hook payload to
 * `<log>/<label>.hooks.jsonl`. User settings are excluded separately with `--setting-sources`.
 */
export function captureHookSettings(label: string, events: readonly string[]): string {
  const target = join(logDirectory(), `${label}.hooks.jsonl`);
  const quoted = `'${target.replaceAll("'", "'\\''")}'`;
  const command = `cat >> ${quoted}; printf '\\n' >> ${quoted}`;
  const hooks: Record<string, unknown> = {};
  for (const event of events) {
    hooks[event] = [{ matcher: "*", hooks: [{ type: "command", command }] }];
  }
  return JSON.stringify({ hooks });
}

export function readHookPayloads(label: string): Record<string, unknown>[] {
  const target = join(logDirectory(), `${label}.hooks.jsonl`);
  if (!existsSync(target)) return [];
  return readFileSync(target, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    });
}

/** Field names and value kinds only, never values. */
export function payloadShape(payload: Record<string, unknown>): Record<string, string> {
  const shape: Record<string, string> = {};
  for (const [key, value] of Object.entries(payload)) {
    shape[key] = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  }
  return shape;
}

/** Settings sources that exclude the user's global settings (and its hooks) from spike sessions. */
export const ISOLATED_SETTING_SOURCES = ["--setting-sources", "project,local"] as const;
