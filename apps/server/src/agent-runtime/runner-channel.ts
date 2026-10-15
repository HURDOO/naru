import { createConnection, type Socket } from "node:net";
import type { AgentRuntimeEvent } from "./adapter.js";
import {
  lineReader,
  NaruMessageSchema,
  RUNTIME_CHANNEL_VERSION,
  type NaruMessage,
  type RunnerMessage,
} from "./channel-protocol.js";

/**
 * Runner side of the runtime channel. The runner may outlive Naru: it reconnects with backoff,
 * re-authenticates, and resends events Naru has not acknowledged (bounded), so a Naru restart
 * neither loses a turn result nor needs the runner to restart.
 */
export interface RunnerState {
  readonly started: boolean;
  readonly runtimeSessionRef: string | null;
  readonly busy: boolean;
  readonly pendingApprovals: readonly string[];
}

const MAX_UNACKED_EVENTS = 512;

export class RunnerChannelClient {
  readonly #socketPath: string;
  readonly #token: string;
  readonly #state: () => RunnerState;
  readonly #onMessage: (message: NaruMessage) => void;
  readonly #unacked: { seq: number; event: AgentRuntimeEvent }[] = [];
  #socket: Socket | null = null;
  #ready = false;
  #seq = 0;
  #stopped = false;
  #retryMs = 250;

  constructor(options: {
    readonly socketPath: string;
    readonly token: string;
    readonly state: () => RunnerState;
    readonly onMessage: (message: NaruMessage) => void;
  }) {
    this.#socketPath = options.socketPath;
    this.#token = options.token;
    this.#state = options.state;
    this.#onMessage = options.onMessage;
  }

  start(): void {
    this.#connect();
  }

  emit(event: AgentRuntimeEvent): void {
    this.#seq += 1;
    this.#unacked.push({ seq: this.#seq, event });
    // Oldest first; a long Naru outage keeps the newest outcomes.
    while (this.#unacked.length > MAX_UNACKED_EVENTS) this.#unacked.shift();
    if (this.#ready) this.#write({ type: "event", seq: this.#seq, event });
  }

  send(message: RunnerMessage): void {
    if (this.#ready) this.#write(message);
  }

  /** Resolves once every emitted event was acknowledged, or after the timeout. */
  async drain(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.#unacked.length > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  stop(): void {
    this.#stopped = true;
    this.#socket?.destroy();
  }

  #connect(): void {
    if (this.#stopped) return;
    const socket = createConnection(this.#socketPath);
    this.#socket = socket;
    const read = lineReader(
      (line) => {
        let parsed: NaruMessage;
        try {
          parsed = NaruMessageSchema.parse(JSON.parse(line));
        } catch {
          socket.destroy();
          return;
        }
        this.#receive(parsed);
      },
      () => socket.destroy(),
    );
    socket.on("connect", () => {
      this.#retryMs = 250;
      const state = this.#state();
      this.#write({
        type: "hello",
        version: RUNTIME_CHANNEL_VERSION,
        token: this.#token,
        started: state.started,
        runtimeSessionRef: state.runtimeSessionRef,
        busy: state.busy,
        pendingApprovals: [...state.pendingApprovals],
      });
    });
    socket.on("data", read);
    socket.on("error", () => undefined);
    socket.on("close", () => {
      this.#ready = false;
      this.#socket = null;
      if (this.#stopped) return;
      const delay = this.#retryMs;
      this.#retryMs = Math.min(this.#retryMs * 2, 5_000);
      // Kept referenced: an idle runner waiting for Naru to come back has nothing else alive.
      setTimeout(() => this.#connect(), delay);
    });
  }

  #receive(message: NaruMessage): void {
    if (message.type === "plan" || (message.type === "ack" && !this.#ready)) {
      const acked = message.type === "plan" ? message.ackedSeq : message.seq;
      this.#acknowledge(acked);
      this.#ready = true;
      for (const entry of this.#unacked) {
        this.#write({ type: "event", seq: entry.seq, event: entry.event });
      }
    } else if (message.type === "ack") {
      this.#acknowledge(message.seq);
    }
    if (message.type === "rejected") {
      // A replaced or revoked launch must not keep a conversation running.
      this.#stopped = true;
    }
    this.#onMessage(message);
  }

  #acknowledge(seq: number): void {
    while (this.#unacked.length > 0 && this.#unacked[0]!.seq <= seq) this.#unacked.shift();
  }

  #write(message: RunnerMessage): void {
    this.#socket?.write(`${JSON.stringify(message)}\n`);
  }
}
