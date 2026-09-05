import { createRequire } from "node:module";
import type { RuntimeId, SessionId, TerminalSize } from "@naru/contracts/durable-session/v0";
import type { IDisposable, IPty } from "node-pty";

const require = createRequire(import.meta.url);

export interface ResolvedLaunchCommand {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly terminal: TerminalSize & { readonly term?: string };
  readonly resourcePolicyId: string;
  readonly scrollbackRows: number;
  readonly outputRingCharacters: number;
  readonly stopTimeoutMs: number;
}

export interface RuntimeExit {
  readonly exitCode: number;
  readonly signal: number | null;
}

export interface RuntimeCallbacks {
  readonly onData: (data: string) => void;
  readonly onExit: (event: RuntimeExit) => void;
}

export interface RuntimeSpawnRequest {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
  readonly launch: ResolvedLaunchCommand;
}

export interface RuntimeHandle {
  readonly sessionId: SessionId;
  readonly runtimeId: RuntimeId;
  readonly pid: number;
  readonly exited: Promise<RuntimeExit>;
  write(data: string): void;
  resize(terminal: TerminalSize): void;
  kill(signal?: string): void;
}

export interface RuntimePort {
  spawn(request: RuntimeSpawnRequest, callbacks: RuntimeCallbacks): RuntimeHandle;
}

export class NodePtyRuntimePort implements RuntimePort {
  spawn(request: RuntimeSpawnRequest, callbacks: RuntimeCallbacks): RuntimeHandle {
    const nodePty = require("node-pty") as {
      spawn(
        file: string,
        args: string[],
        options: {
          name: string;
          cols: number;
          rows: number;
          cwd: string;
          env: Record<string, string>;
        },
      ): IPty;
    };
    const process = nodePty.spawn(request.launch.executable, [...request.launch.args], {
      name: request.launch.terminal.term ?? "xterm-256color",
      cols: request.launch.terminal.cols,
      rows: request.launch.terminal.rows,
      cwd: request.launch.cwd,
      env: { ...request.launch.environment },
    });
    let resolveExit = (event: RuntimeExit): void => {
      void event;
    };
    const exited = new Promise<RuntimeExit>((resolvePromise) => {
      resolveExit = resolvePromise;
    });
    const dataSubscription: IDisposable = process.onData((data) => callbacks.onData(data));
    const exitSubscription: IDisposable = process.onExit((event) => {
      const normalized = { exitCode: event.exitCode, signal: event.signal ?? null };
      dataSubscription?.dispose();
      exitSubscription?.dispose();
      callbacks.onExit(normalized);
      resolveExit(normalized);
    });

    return {
      sessionId: request.sessionId,
      runtimeId: request.runtimeId,
      pid: process.pid,
      exited,
      write: (data) => process.write(data),
      resize: (terminal) => process.resize(terminal.cols, terminal.rows),
      kill: (signal) => process.kill(signal),
    };
  }
}
