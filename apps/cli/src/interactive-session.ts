import { randomUUID } from "node:crypto";
import {
  DurableSessionAttachmentHandle,
  DurableSessionClient,
  DurableSessionClientError,
} from "@naru/durable-session-client";
import { UdsWebSocketDurableSessionTransport } from "@naru/durable-session-client/node";
import type { DurableSessionStreamAttachmentEvent } from "@naru/contracts/durable-session/v0";
import type { CliCommand, CliConnectionOptions } from "./arguments.js";
import { callerContextForInteractiveSession } from "./caller-context.js";
import {
  InteractiveTerminalController,
  type InteractiveTerminalIo,
} from "./interactive-terminal.js";
import { CliUsageError } from "./usage-error.js";

const INITIAL_SNAPSHOT_TIMEOUT_MS = 10_000;
const MAX_PENDING_INTERACTIVE_ACTIONS = 1_024;

export interface InteractiveTerminalRuntime extends InteractiveTerminalIo {
  readonly interactive: boolean;
  start(handlers: {
    readonly input: (data: string) => void;
    readonly resize: () => void;
  }): () => void;
}

export interface RunInteractiveSessionOptions {
  readonly command: Extract<CliCommand, { readonly name: "attach" | "control" }>;
  readonly connection: CliConnectionOptions;
  readonly credential: string;
  readonly runtime?: InteractiveTerminalRuntime;
  readonly nowMs?: () => number;
  readonly requestId?: () => string;
  readonly signal?: AbortSignal;
}

export async function runInteractiveSession(options: RunInteractiveSessionOptions): Promise<void> {
  const runtime = options.runtime ?? createProcessInteractiveTerminalRuntime();
  if (!runtime.interactive) {
    throw new CliUsageError("attach/control require an interactive stdin and stdout terminal.");
  }
  if (options.signal?.aborted === true) {
    throw new DurableSessionClientError("REQUEST_ABORTED", "Interactive Session was aborted.");
  }

  const caller = callerContextForInteractiveSession(
    options.connection,
    options.command,
    (options.nowMs ?? Date.now)(),
  );
  const transport = await UdsWebSocketDurableSessionTransport.connect({
    socketPath: options.connection.socketPath,
    appId: options.connection.appId,
    credential: options.credential,
    callerContext: caller,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  const client = new DurableSessionClient({
    transport,
    callerContext: caller,
    requestId: () => (options.requestId ?? randomUUID)(),
  });
  let attachment: DurableSessionAttachmentHandle | null = null;
  let stopRuntime: (() => void) | null = null;
  const pumpController = new AbortController();

  try {
    attachment = await DurableSessionAttachmentHandle.open(client, {
      sessionId: options.command.sessionId,
      clientInstanceId: randomUUID(),
    });
    const terminal = new InteractiveTerminalController(attachment, runtime, {
      preemptEnabled: options.command.name === "control",
    });
    await waitForInitialSnapshot(transport, terminal, attachment.view.attachmentId, options.signal);
    if (options.command.name === "control") await terminal.requestInitialControl();

    const actions = new InteractiveActionQueue();
    const eventSignal =
      options.signal === undefined
        ? pumpController.signal
        : AbortSignal.any([options.signal, pumpController.signal]);
    void pumpEvents(transport, attachment.view.attachmentId, actions, eventSignal);
    stopRuntime = runtime.start({
      input: (data) => actions.push({ type: "input", data }),
      resize: () => actions.push({ type: "resize" }),
    });
    const abort = (): void => actions.push({ type: "stop" });
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      for (;;) {
        const action = await actions.next();
        if (action.type === "stop") break;
        if (action.type === "resize") {
          await terminal.handleResize();
          continue;
        }
        if (action.type === "input") {
          if ((await terminal.handleInput(action.data)) === "closed") break;
          continue;
        }
        await terminal.handleEvent(action.frame.event);
        if (action.frame.event.type === "terminal.exited") break;
      }
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  } finally {
    pumpController.abort();
    stopRuntime?.();
    if (attachment !== null) await attachment.close().catch(() => undefined);
    await transport.close();
  }
}

export function createProcessInteractiveTerminalRuntime(): InteractiveTerminalRuntime {
  return {
    interactive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    writeTerminal: (data) => process.stdout.write(data),
    writeStatus: (message) =>
      process.stderr.write(`\r\n[durable-session] ${singleLine(message)}\r\n`),
    terminalSize: () => ({
      cols: boundedTerminalDimension(process.stdout.columns, 80, 2),
      rows: boundedTerminalDimension(process.stdout.rows, 24, 1),
    }),
    start: ({ input, resize }) => {
      const wasRaw = process.stdin.isRaw;
      const onData = (chunk: Buffer | string): void => {
        input(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : chunk);
      };
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on("data", onData);
      process.stdout.on("resize", resize);
      return () => {
        process.stdin.off("data", onData);
        process.stdout.off("resize", resize);
        process.stdin.setRawMode(wasRaw);
        process.stdin.pause();
      };
    },
  };
}

async function waitForInitialSnapshot(
  transport: UdsWebSocketDurableSessionTransport,
  terminal: InteractiveTerminalController,
  attachmentId: string,
  signal?: AbortSignal,
): Promise<void> {
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), INITIAL_SNAPSHOT_TIMEOUT_MS);
  const combined =
    signal === undefined ? timeout.signal : AbortSignal.any([signal, timeout.signal]);
  try {
    for (;;) {
      let frame: DurableSessionStreamAttachmentEvent;
      try {
        frame = await transport.nextAttachmentEvent({ signal: combined });
      } catch (error) {
        if (timeout.signal.aborted && signal?.aborted !== true) {
          throw new DurableSessionClientError(
            "TRANSPORT_TIMEOUT",
            "DurableSession initial terminal snapshot timed out.",
          );
        }
        throw error;
      }
      if (frame.attachmentId !== attachmentId) continue;
      await terminal.handleEvent(frame.event);
      if (frame.event.type === "terminal.snapshot") return;
      if (frame.event.type === "terminal.exited") {
        throw new DurableSessionClientError(
          "PROTOCOL_RESPONSE_MISMATCH",
          "Terminal exited before an initial snapshot was delivered.",
        );
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

type InteractiveAction =
  | { readonly type: "input"; readonly data: string }
  | { readonly type: "resize" }
  | { readonly type: "event"; readonly frame: DurableSessionStreamAttachmentEvent }
  | { readonly type: "stop" };

class InteractiveActionQueue {
  readonly #values: InteractiveAction[] = [];
  #waiter: {
    readonly resolve: (value: InteractiveAction) => void;
    readonly reject: (error: unknown) => void;
  } | null = null;
  #error: Error | null = null;

  push(value: InteractiveAction): void {
    if (this.#error !== null) return;
    const waiter = this.#waiter;
    if (waiter !== null) {
      this.#waiter = null;
      waiter.resolve(value);
      return;
    }
    if (this.#values.length >= MAX_PENDING_INTERACTIVE_ACTIONS) {
      this.fail(
        new DurableSessionClientError(
          "STREAM_QUEUE_OVERFLOW",
          "Interactive Session action queue overflowed; reconnect and resync.",
        ),
      );
      return;
    }
    this.#values.push(value);
  }

  fail(error: unknown): void {
    if (this.#error !== null) return;
    this.#error =
      error instanceof Error ? error : new Error("Interactive Session event pump failed.");
    const waiter = this.#waiter;
    this.#waiter = null;
    waiter?.reject(this.#error);
  }

  next(): Promise<InteractiveAction> {
    const value = this.#values.shift();
    if (value !== undefined) return Promise.resolve(value);
    if (this.#error !== null) return Promise.reject(this.#error);
    if (this.#waiter !== null) {
      return Promise.reject(
        new DurableSessionClientError(
          "CLIENT_REQUEST_INVALID",
          "Only one interactive action read may be pending.",
        ),
      );
    }
    return new Promise((resolvePromise, rejectPromise) => {
      this.#waiter = { resolve: resolvePromise, reject: rejectPromise };
    });
  }
}

async function pumpEvents(
  transport: UdsWebSocketDurableSessionTransport,
  attachmentId: string,
  actions: InteractiveActionQueue,
  signal: AbortSignal,
): Promise<void> {
  try {
    while (!signal.aborted) {
      const frame = await transport.nextAttachmentEvent({ signal });
      if (frame.attachmentId === attachmentId) actions.push({ type: "event", frame });
    }
  } catch (error) {
    if (!signal.aborted) actions.fail(error);
  }
}

function boundedTerminalDimension(
  value: number | undefined,
  fallback: number,
  minimum: number,
): number {
  return Math.max(minimum, Math.min(1_000, value ?? fallback));
}

function singleLine(value: string): string {
  return value.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500);
}
