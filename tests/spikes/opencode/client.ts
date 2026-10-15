import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Minimal OpenCode server client for V12 spikes. Uses only Node fetch so the repository gains no
 * dependency. Raw frames go to OPENCODE_SPIKE_LOG_DIR (outside the repository); callers print only
 * redacted summaries.
 */
export interface SpikeConfig {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly directory: string;
  readonly logDirectory: string;
}

export function spikeConfig(): SpikeConfig {
  const required = (name: string): string => {
    const value = process.env[name];
    if (value === undefined || value === "") throw new Error(`${name} is required.`);
    return value;
  };
  const password = readFileSync(required("OPENCODE_SPIKE_PASSWORD_FILE"), "utf8").trim();
  return {
    baseUrl: required("OPENCODE_SPIKE_URL").replace(/\/$/, ""),
    authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`,
    directory: required("OPENCODE_SPIKE_DIRECTORY"),
    logDirectory: required("OPENCODE_SPIKE_LOG_DIR"),
  };
}

export class SpikeClient {
  constructor(
    readonly config: SpikeConfig,
    readonly name: string,
  ) {}

  async api<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(this.config.baseUrl + path, {
      method,
      headers: {
        authorization: this.config.authorization,
        "x-opencode-directory": this.config.directory,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    this.#log({ kind: "http", method, path, status: response.status });
    if (!response.ok) throw new SpikeHttpError(response.status, method, path, text);
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }

  /** Subscribe to an SSE endpoint. Every frame is logged raw; `onEvent` sees parsed data. */
  subscribe(path: string, onEvent: (event: OpenCodeEvent) => void): EventStream {
    const controller = new AbortController();
    const events: OpenCodeEvent[] = [];
    const ready = new Promise<void>((resolve, reject) => {
      void (async () => {
        try {
          const response = await fetch(this.config.baseUrl + path, {
            headers: {
              authorization: this.config.authorization,
              accept: "text/event-stream",
              "x-opencode-directory": this.config.directory,
            },
            signal: controller.signal,
          });
          if (!response.ok || response.body === null) {
            reject(new SpikeHttpError(response.status, "GET", path, ""));
            return;
          }
          resolve();
          const decoder = new TextDecoder();
          let buffer = "";
          for await (const chunk of response.body) {
            buffer += decoder.decode(chunk, { stream: true });
            let index: number;
            while ((index = buffer.indexOf("\n\n")) >= 0) {
              const frame = buffer.slice(0, index);
              buffer = buffer.slice(index + 2);
              const data = frame
                .split("\n")
                .filter((line) => line.startsWith("data:"))
                .map((line) => line.slice(5).trim())
                .join("\n");
              if (data === "") continue;
              const event = JSON.parse(data) as OpenCodeEvent;
              event.receivedAt = Date.now();
              events.push(event);
              this.#log({ kind: "sse", path, event });
              onEvent(event);
            }
          }
        } catch (error) {
          if (!controller.signal.aborted)
            reject(error instanceof Error ? error : new Error(String(error)));
        }
      })();
    });
    return { ready, events, close: () => controller.abort() };
  }

  #log(record: unknown): void {
    appendFileSync(
      join(this.config.logDirectory, `${this.name}.jsonl`),
      `${JSON.stringify({ t: Date.now(), record })}\n`,
      { mode: 0o600 },
    );
  }
}

export interface OpenCodeEvent {
  type: string;
  properties?: Record<string, unknown>;
  receivedAt?: number;
}

export interface EventStream {
  readonly ready: Promise<void>;
  readonly events: OpenCodeEvent[];
  close(): void;
}

export class SpikeHttpError extends Error {
  constructor(
    readonly status: number,
    method: string,
    path: string,
    readonly body: string,
  ) {
    super(`${method} ${path} -> ${status}`);
  }
}

export async function waitFor<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  label: string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}.`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

export function sessionOf(event: OpenCodeEvent): string | undefined {
  const properties = event.properties ?? {};
  if (typeof properties.sessionID === "string") return properties.sessionID;
  const info = properties.info as { sessionID?: unknown; id?: unknown } | undefined;
  if (typeof info?.sessionID === "string") return info.sessionID;
  const part = properties.part as { sessionID?: unknown } | undefined;
  if (typeof part?.sessionID === "string") return part.sessionID;
  return undefined;
}

/** Event-type histogram per session, safe to print (no message text). */
export function histogram(events: readonly OpenCodeEvent[], sessionId?: string): string {
  const counts = new Map<string, number>();
  for (const event of events) {
    if (sessionId !== undefined && sessionOf(event) !== sessionId) continue;
    counts.set(event.type, (counts.get(event.type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([type, count]) => `${type}=${count}`)
    .join(" ");
}

export const SPIKE_MODEL = {
  providerID: process.env.OPENCODE_SPIKE_PROVIDER ?? "openai",
  modelID: process.env.OPENCODE_SPIKE_MODEL ?? "gpt-5.6-luna-fast",
} as const;

export function report(label: string, value: unknown): void {
  process.stdout.write(`${label}: ${typeof value === "string" ? value : JSON.stringify(value)}\n`);
}
