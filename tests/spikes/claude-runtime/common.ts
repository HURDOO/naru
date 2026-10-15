import { spawn } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/**
 * Shared helpers for the Claude runtime spikes. Raw model output, prompts and terminal screens are
 * written only under NARU_SPIKE_LOG_DIR (outside the repository). stdout carries redacted results.
 */

export function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required.`);
  return value;
}

export const claudeExecutable = (): string => requiredEnv("NARU_SPIKE_CLAUDE");
export const logDirectory = (): string => requiredEnv("NARU_SPIKE_LOG_DIR");
export const workspaceDirectory = (): string => requiredEnv("NARU_SPIKE_WORKSPACE");

/** A minimal child environment without the parent Claude Code, Naru or Codex session variables. */
export function spikeEnvironment(extra: Record<string, string> = {}): Record<string, string> {
  const environment: Record<string, string> = {
    HOME: requiredEnv("HOME"),
    USER: requiredEnv("USER"),
    LOGNAME: requiredEnv("USER"),
    PATH: `${dirname(claudeExecutable())}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    LANG: "en_US.UTF-8",
    SHELL: "/bin/zsh",
    TERM: "xterm-256color",
  };
  const temporary = process.env.TMPDIR;
  if (temporary !== undefined) environment.TMPDIR = temporary;
  return { ...environment, ...extra };
}

export interface StreamEvent {
  readonly receivedAtMs: number;
  readonly value: Record<string, unknown>;
}

export interface PrintRun {
  readonly events: StreamEvent[];
  readonly exitCode: number | null;
  readonly sessionId: string | undefined;
  readonly result: Record<string, unknown> | undefined;
}

export interface PrintOptions {
  readonly label: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly environment?: Record<string, string>;
  /** stream-json input lines written after spawn; the process stdin closes after the last line. */
  readonly input?: readonly { readonly afterMs: number; readonly line: string }[];
  /** Keeps stdin open until this predicate sees an event, then closes it. */
  readonly closeInputWhen?: (event: Record<string, unknown>) => boolean;
  /** Called for every parsed event; can write further stream-json lines while stdin is open. */
  readonly onEvent?: (event: Record<string, unknown>, control: PrintControl) => void;
  readonly timeoutMs?: number;
}

export interface PrintControl {
  readonly pid: number | undefined;
  readonly elapsedMs: number;
  write(line: string): void;
}

/** Runs `claude -p --output-format stream-json --verbose` and records every line with its arrival time. */
export async function runPrint(options: PrintOptions): Promise<PrintRun> {
  mkdirSync(logDirectory(), { recursive: true, mode: 0o700 });
  const rawPath = join(logDirectory(), `${options.label}.jsonl`);
  writeFileSync(rawPath, "", { mode: 0o600 });
  const started = Date.now();
  const child = spawn(
    claudeExecutable(),
    ["-p", "--output-format", "stream-json", "--verbose", "--strict-mcp-config", ...options.args],
    {
      cwd: options.cwd ?? workspaceDirectory(),
      env: options.environment ?? spikeEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const events: StreamEvent[] = [];
  let buffer = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (line === "") continue;
      appendFileSync(rawPath, `${line}\n`);
      try {
        const value = JSON.parse(line) as Record<string, unknown>;
        events.push({ receivedAtMs: Date.now() - started, value });
        options.onEvent?.(value, {
          pid: child.pid,
          elapsedMs: Date.now() - started,
          write: (next) => {
            if (!child.stdin.writableEnded) child.stdin.write(`${next}\n`);
          },
        });
        if (options.closeInputWhen?.(value) === true && !child.stdin.writableEnded)
          child.stdin.end();
      } catch {
        // Non-JSON lines stay in the raw log only.
      }
    }
  });
  const input = options.input ?? [];
  void (async () => {
    for (const item of input) {
      const wait = item.afterMs - (Date.now() - started);
      if (wait > 0) await delay(wait);
      if (!child.stdin.writableEnded) child.stdin.write(`${item.line}\n`);
    }
    if (options.closeInputWhen === undefined && !child.stdin.writableEnded) child.stdin.end();
  })();
  const timeout = setTimeout(() => child.kill("SIGTERM"), options.timeoutMs ?? 600_000);
  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", (code) => resolve(code));
  });
  clearTimeout(timeout);
  if (stderr !== "")
    writeFileSync(join(logDirectory(), `${options.label}.stderr`), stderr, { mode: 0o600 });
  const init = events.find(
    (event) => event.value.type === "system" && event.value.subtype === "init",
  );
  const result = events.find((event) => event.value.type === "result")?.value;
  const sessionId = typeof init?.value.session_id === "string" ? init.value.session_id : undefined;
  return { events, exitCode, sessionId, result };
}

export function resultText(run: PrintRun): string {
  return typeof run.result?.result === "string" ? run.result.result : "";
}

/** Event shape without content: type, subtype, parent link and arrival time. */
export function eventShape(event: StreamEvent): string {
  const value = event.value;
  const parent = value.parent_tool_use_id;
  const subtype = typeof value.subtype === "string" ? `/${value.subtype}` : "";
  const hook = typeof value.hook_event_name === "string" ? ` hook=${value.hook_event_name}` : "";
  const parentText = typeof parent === "string" ? " child" : "";
  return `${event.receivedAtMs}ms ${String(value.type)}${subtype}${hook}${parentText}`;
}

export function userMessageLine(text: string): string {
  return JSON.stringify({
    type: "user",
    message: { role: "user", content: [{ type: "text", text }] },
  });
}

interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): void;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  kill(signal?: string): void;
}

interface HeadlessTerminal {
  write(data: string): void;
  onData(listener: (data: string) => void): void;
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(index: number): { translateToString(trim?: boolean): string } | undefined;
    };
  };
}

const serverRequire = createRequire(new URL("../../../apps/server/package.json", import.meta.url));
ensurePtyHelperExecutable();
const nodePty = serverRequire("node-pty") as {
  spawn(
    file: string,
    args: string[],
    options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> },
  ): PtyProcess;
};
const { Terminal } = serverRequire("@xterm/headless") as {
  Terminal: new (options: {
    cols: number;
    rows: number;
    allowProposedApi: boolean;
  }) => HeadlessTerminal;
};

/** Same guard as the server PTY supervisor: offline installs can leave spawn-helper non-executable. */
function ensurePtyHelperExecutable(): void {
  const packageRoot = dirname(serverRequire.resolve("node-pty/package.json"));
  for (const candidate of [
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(packageRoot, "build", "Release", "spawn-helper"),
  ]) {
    if (!existsSync(candidate)) continue;
    const mode = statSync(candidate).mode;
    if ((mode & 0o100) === 0) chmodSync(candidate, mode | 0o100);
    return;
  }
}

export class SpikePty {
  readonly #pty: PtyProcess;
  readonly #terminal: HeadlessTerminal;
  readonly #rawPath: string;
  #exited: { exitCode: number } | undefined;

  constructor(
    label: string,
    file: string,
    args: string[],
    cwd: string,
    environment: Record<string, string>,
  ) {
    mkdirSync(logDirectory(), { recursive: true, mode: 0o700 });
    this.#rawPath = join(logDirectory(), `${label}.pty.log`);
    writeFileSync(this.#rawPath, "", { mode: 0o600 });
    this.#terminal = new Terminal({ cols: 120, rows: 40, allowProposedApi: true });
    this.#pty = nodePty.spawn(file, args, {
      name: "xterm-256color",
      cols: 120,
      rows: 40,
      cwd,
      env: environment,
    });
    this.#pty.onData((data) => {
      this.#terminal.write(data);
      appendFileSync(this.#rawPath, data);
    });
    // Answer terminal queries (device attributes, cursor position) like a real terminal would.
    if (process.env.NARU_SPIKE_PTY_ANSWER_QUERIES !== "0") {
      this.#terminal.onData((data) => {
        if (this.#exited === undefined) this.#pty.write(data);
      });
    }
    this.#pty.onExit((event) => {
      this.#exited = { exitCode: event.exitCode };
    });
  }

  get pid(): number {
    return this.#pty.pid;
  }

  get exited(): { exitCode: number } | undefined {
    return this.#exited;
  }

  screen(): string {
    const lines: string[] = [];
    const active = this.#terminal.buffer.active;
    for (let index = 0; index < active.length; index += 1) {
      lines.push(active.getLine(index)?.translateToString(true) ?? "");
    }
    return lines.join("\n");
  }

  write(data: string): void {
    this.#pty.write(data);
  }

  /** Types text, then submits with a separate carriage return so the TUI sees a paste then Enter. */
  async submit(text: string): Promise<void> {
    this.#pty.write(text);
    await delay(400);
    this.#pty.write("\r");
  }

  /**
   * Accepts the folder trust dialog for the spike scratch workspace only. The default option is
   * "No, exit", so the explicit "Yes" option is selected first. Returns whether the dialog was shown.
   */
  async acceptWorkspaceTrust(timeoutMs = 30_000): Promise<boolean> {
    const shown = await this.waitFor(
      /Yes, I trust this folder|for shortcuts|auto mode|❯ Try/,
      timeoutMs,
    );
    if (!shown || !/Yes, I trust this folder/.test(this.screen())) return false;
    // Keys sent before the TUI finishes its terminal capability probes are dropped.
    await delay(3_000);
    this.#pty.write("\u001b[B");
    await delay(1_000);
    this.#pty.write("\r");
    await delay(2_000);
    return true;
  }

  /** Waits until the prompt input is idle and accepting keys. */
  async waitForPrompt(timeoutMs = 60_000): Promise<boolean> {
    const ready = await this.waitFor(
      /for shortcuts|auto mode|❯ Try|accept edits|plan mode/,
      timeoutMs,
    );
    await delay(2_000);
    return ready;
  }

  async waitFor(pattern: RegExp, timeoutMs = 120_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(this.screen())) return true;
      if (this.#exited !== undefined) return pattern.test(this.screen());
      await delay(250);
    }
    return false;
  }

  async waitForExit(timeoutMs = 30_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (this.#exited !== undefined) return true;
      await delay(200);
    }
    return false;
  }

  saveScreen(label: string): void {
    writeFileSync(join(logDirectory(), `${label}.screen.txt`), this.screen(), { mode: 0o600 });
  }

  kill(): void {
    if (this.#exited === undefined) this.#pty.kill("SIGTERM");
  }
}

export function report(item: string, values: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify({ item, ...values })}\n`);
}
