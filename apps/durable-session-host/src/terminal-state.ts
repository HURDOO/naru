import { createRequire } from "node:module";
import type { SerializeAddon as SerializeAddonInstance } from "@xterm/addon-serialize";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as HeadlessTerminalInstance,
} from "@xterm/headless";
import {
  DURABLE_SESSION_LIMITS,
  type RuntimeId,
  type SessionId,
  type TerminalSize,
} from "@naru/contracts/durable-session/v0";
import { HostOperationError } from "./host-error.js";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
  Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => HeadlessTerminalInstance;
};
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: new () => SerializeAddonInstance;
};

export interface TerminalOutputFrame {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly data: string;
}

export interface TerminalStateSnapshot {
  readonly runtimeId: RuntimeId;
  readonly sequence: number;
  readonly terminal: TerminalSize;
  readonly serializedState: string;
}

export class BoundedTerminalState {
  readonly #terminal: HeadlessTerminalInstance;
  readonly #serializer: SerializeAddonInstance;
  readonly #frames: TerminalOutputFrame[] = [];
  readonly #scrollbackRows: number;
  readonly #outputRingCharacters: number;
  #frameCharacters = 0;
  #sequence = 0;
  #barrier: Promise<void> = Promise.resolve();
  #disposed = false;

  constructor(
    readonly sessionId: SessionId,
    readonly runtimeId: RuntimeId,
    terminal: TerminalSize,
    options: { readonly scrollbackRows: number; readonly outputRingCharacters: number },
  ) {
    this.#scrollbackRows = options.scrollbackRows;
    this.#outputRingCharacters = options.outputRingCharacters;
    this.#terminal = new HeadlessTerminal({
      cols: terminal.cols,
      rows: terminal.rows,
      scrollback: options.scrollbackRows,
      allowProposedApi: true,
    });
    this.#serializer = new SerializeAddon();
    this.#terminal.loadAddon(this.#serializer);
  }

  get sequence(): number {
    return this.#sequence;
  }

  recordOutput(data: string, sequence: number): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Terminal state is disposed."));
    const write = this.#barrier.then(async () => {
      if (sequence !== this.#sequence + 1) {
        throw new Error("Terminal output sequence is not contiguous.");
      }
      await writeTerminal(this.#terminal, data);
      this.#sequence = sequence;
      const frame = { runtimeId: this.runtimeId, sequence, data };
      this.#frames.push(frame);
      this.#frameCharacters += data.length;
      while (this.#frameCharacters > this.#outputRingCharacters && this.#frames.length > 1) {
        const removed = this.#frames.shift();
        if (removed !== undefined) this.#frameCharacters -= removed.data.length;
      }
    });
    this.#barrier = write;
    return write;
  }

  resize(terminal: TerminalSize): Promise<void> {
    if (this.#disposed) return Promise.reject(new Error("Terminal state is disposed."));
    const resize = this.#barrier.then(() => this.#terminal.resize(terminal.cols, terminal.rows));
    this.#barrier = resize;
    return resize;
  }

  async snapshot(): Promise<TerminalStateSnapshot> {
    await this.#barrier;
    let serializedState = this.#serializer.serialize({ scrollback: this.#scrollbackRows });
    if (serializedState.length > DURABLE_SESSION_LIMITS.terminalStateCharacters) {
      serializedState = this.#serializer.serialize({ scrollback: 0 });
    }
    if (serializedState.length > DURABLE_SESSION_LIMITS.terminalStateCharacters) {
      throw new HostOperationError(
        "SESSION_STATE_INVALID",
        "Canonical terminal state exceeds the configured snapshot bound.",
      );
    }
    return {
      runtimeId: this.runtimeId,
      sequence: this.#sequence,
      terminal: { cols: this.#terminal.cols, rows: this.#terminal.rows },
      serializedState,
    };
  }

  async readAfter(sequence: number): Promise<readonly TerminalOutputFrame[] | null> {
    await this.#barrier;
    const first = this.#frames[0]?.sequence;
    if (first !== undefined && sequence < first - 1) return null;
    return this.#frames.filter((frame) => frame.sequence > sequence);
  }

  async drain(): Promise<void> {
    await this.#barrier;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#frames.length = 0;
    this.#frameCharacters = 0;
    this.#terminal.dispose();
  }
}

function writeTerminal(terminal: HeadlessTerminalInstance, data: string): Promise<void> {
  return new Promise((resolvePromise) => terminal.write(data, resolvePromise));
}
