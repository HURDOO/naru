import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { cleanEnvironment, requireClaudeExecutable } from "./spike-env.js";

export type StreamEvent = Record<string, unknown> & { type?: string; subtype?: string };

export interface ClaudeSpikeOptions {
  readonly name: string;
  readonly runDirectory: string;
  readonly settings: Record<string, unknown>;
  readonly mcpConfig?: Record<string, unknown>;
  readonly model?: string;
  readonly permissionMode?: string;
  readonly extraArgs?: readonly string[];
  readonly environment?: Record<string, string>;
}

/** Long-running `claude -p` worker driven over stream-json stdin/stdout. Raw output goes to the run log. */
export class ClaudeSpikeProcess {
  readonly events: StreamEvent[] = [];
  readonly workspace: string;
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #log: WriteStream;
  readonly #waiters = new Set<() => void>();
  #exited = false;

  constructor(readonly options: ClaudeSpikeOptions) {
    this.workspace = resolve(options.runDirectory, "workspace", options.name);
    mkdirSync(this.workspace, { recursive: true, mode: 0o700 });
    const args = [
      "-p",
      "--input-format",
      "stream-json",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-hook-events",
      "--name",
      options.name,
      "--model",
      options.model ?? "sonnet",
      "--permission-mode",
      options.permissionMode ?? "acceptEdits",
      "--settings",
      JSON.stringify(options.settings),
    ];
    if (options.mcpConfig !== undefined) {
      args.push("--mcp-config", JSON.stringify(options.mcpConfig), "--strict-mcp-config");
    }
    args.push(...(options.extraArgs ?? []));
    this.#log = createWriteStream(resolve(options.runDirectory, `${options.name}.stdout.jsonl`), {
      mode: 0o600,
    });
    const stderr = createWriteStream(resolve(options.runDirectory, `${options.name}.stderr.log`), {
      mode: 0o600,
    });
    this.#child = spawn(requireClaudeExecutable(), args, {
      cwd: this.workspace,
      env: cleanEnvironment(options.environment),
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#child.stderr.pipe(stderr);
    createInterface({ input: this.#child.stdout }).on("line", (line) => {
      this.#log.write(`${line}\n`);
      try {
        this.events.push(JSON.parse(line) as StreamEvent);
      } catch {
        this.events.push({ type: "unparsed" });
      }
      this.#notify();
    });
    this.#child.on("exit", () => {
      this.#exited = true;
      this.#notify();
    });
  }

  get pid(): number | undefined {
    return this.#child.pid;
  }

  send(text: string): void {
    const frame = { type: "user", message: { role: "user", content: text } };
    this.#child.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  results(): StreamEvent[] {
    return this.events.filter((event) => event.type === "result");
  }

  async waitFor(
    predicate: (events: readonly StreamEvent[]) => boolean,
    timeoutMs: number,
    label: string,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (!predicate(this.events)) {
      if (this.#exited || Date.now() > deadline) {
        process.stderr.write(`[spike] wait timed out: ${this.options.name} ${label}\n`);
        return false;
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(() => {
          this.#waiters.delete(wake);
          resolveWait();
        }, 500);
        const wake = (): void => {
          clearTimeout(timer);
          this.#waiters.delete(wake);
          resolveWait();
        };
        this.#waiters.add(wake);
      });
    }
    return true;
  }

  async waitForResults(count: number, timeoutMs: number): Promise<boolean> {
    return this.waitFor(
      (events) => events.filter((e) => e.type === "result").length >= count,
      timeoutMs,
      `results>=${count}`,
    );
  }

  async close(): Promise<void> {
    if (this.#exited) return;
    this.#child.stdin.end();
    const exited = await this.waitFor(() => this.#exited, 10_000, "exit");
    if (!exited) this.#child.kill("SIGTERM");
    this.#log.end();
  }

  #notify(): void {
    for (const wake of [...this.#waiters]) wake();
  }
}

/** Extract tool_use blocks (name + input) from assistant events. */
export function toolUses(
  events: readonly StreamEvent[],
): Array<{ name: string; input: unknown; id: string }> {
  const uses: Array<{ name: string; input: unknown; id: string }> = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === "tool_use") {
        uses.push({ name: String(block.name), input: block.input, id: String(block.id) });
      }
    }
  }
  return uses;
}

/** tool_result blocks keyed by tool_use_id, flattened to text. */
export function toolResults(events: readonly StreamEvent[]): Map<string, string> {
  const results = new Map<string, string>();
  for (const event of events) {
    if (event.type !== "user") continue;
    const content = (event.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type !== "tool_result") continue;
      const body = block.content;
      const text = Array.isArray(body)
        ? (body as Array<Record<string, unknown>>)
            .map((part) => (typeof part.text === "string" ? part.text : ""))
            .join("")
        : typeof body === "string"
          ? body
          : JSON.stringify(body ?? "");
      results.set(String(block.tool_use_id), text);
    }
  }
  return results;
}
