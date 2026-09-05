import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import type { SerializeAddon as SerializeAddonInstance } from "@xterm/addon-serialize";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as HeadlessTerminalInstance,
} from "@xterm/headless";
import type { IDisposable, IPty } from "node-pty";
import {
  MAX_TERMINAL_SCROLLBACK_ROWS,
  TERMINAL_RESTORE_PROTOCOL,
  type PaneActivityState,
  type ServerWsFrame,
  type TerminalRestoreProtocol,
} from "@naru/contracts";
import type { NaruRepository, PaneActivityChange, PaneContext } from "./database.js";
import type {
  CodexHookEvent,
  CodexSessionHookBridge,
  CodexSessionHookRegistration,
} from "./codex-session-hook.js";
import { AppError } from "./errors.js";
import { CodexRuntimeSemantics } from "./integrations/codex/semantics.js";
import type {
  SessionAttachmentOptions,
  SessionCodexIdentityChange,
  SessionCodexIdentityListener,
} from "./session-facade.js";
import {
  LaunchProfileRegistry,
  type PaneLaunchCommand,
  type PaneLaunchResolver,
} from "./launch-profiles.js";

const DEFAULT_COLUMNS = 100;
const DEFAULT_ROWS = 30;
const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
  Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => HeadlessTerminalInstance;
};
const { SerializeAddon } = require("@xterm/addon-serialize") as {
  SerializeAddon: new () => SerializeAddonInstance;
};
const nodePty = require("node-pty") as {
  spawn(file: string, args: string[], options: PtySpawnOptions): IPty;
};

export interface PtyProcess {
  readonly pid: number;
  onData(listener: (data: string) => void): IDisposable;
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): IDisposable;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
}

export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: Record<string, string>;
}

export type PtyFactory = (file: string, args: string[], options: PtySpawnOptions) => PtyProcess;

type FrameListener = (frame: ServerWsFrame) => void;
export type RuntimePaneActivityChange = PaneActivityChange;
type ActivityListener = (change: RuntimePaneActivityChange) => void;

interface Runtime {
  readonly paneId: string;
  readonly runtimeId: string;
  readonly process: PtyProcess;
  readonly terminal: HeadlessTerminalInstance;
  readonly serializer: SerializeAddonInstance;
  readonly codexSemantics: CodexRuntimeSemantics | null;
  readonly codexSessionHookRegistration: CodexSessionHookRegistration | null;
  readonly listeners: Set<FrameListener>;
  readonly exitPromise: Promise<void>;
  resolveExit: () => void;
  sequence: number;
  writeBarrier: Promise<void>;
  viewportBottomOffset: number;
  terminationCause: "none" | "server-stop";
  disposed: boolean;
}

export class PtySupervisor {
  readonly #runtimes = new Map<string, Runtime>();
  readonly #activityListeners = new Set<ActivityListener>();
  readonly #codexIdentityListeners = new Set<SessionCodexIdentityListener>();

  constructor(
    private readonly repository: NaruRepository,
    private readonly factory: PtyFactory = realPtyFactory,
    private readonly launchProfiles: PaneLaunchResolver = new LaunchProfileRegistry(),
    private readonly codexSessionHooks?: CodexSessionHookBridge,
  ) {}

  readiness(): boolean {
    return true;
  }

  count(): number {
    return this.#runtimes.size;
  }

  isRunning(paneId: string): boolean {
    return this.#runtimes.has(paneId);
  }

  onActivity(listener: ActivityListener): () => void {
    this.#activityListeners.add(listener);
    return () => this.#activityListeners.delete(listener);
  }

  onCodexIdentity(listener: SessionCodexIdentityListener): () => void {
    this.#codexIdentityListeners.add(listener);
    return () => this.#codexIdentityListeners.delete(listener);
  }

  acknowledgeCompleted(paneId: string, eventId: string): void {
    const change = this.repository.acknowledgeCompletedActivity(paneId, eventId);
    if (change) this.#emitActivity(change);
  }

  start(paneId: string, columns = DEFAULT_COLUMNS, rows = DEFAULT_ROWS): void {
    if (this.#runtimes.has(paneId)) return;
    const context = this.#requirePane(paneId);
    if (context.pane.kind !== "terminal" && context.pane.kind !== "codex") {
      throw new AppError("REQUEST_INVALID", 400, "읽기 전용 Pane은 PTY를 시작하지 않습니다.");
    }
    const runtimeId = randomUUID();
    this.#emitActivity(this.repository.beginPaneRuntime(paneId, runtimeId));
    let activeRuntime: Runtime | null = null;
    const pendingCodexEvents: CodexHookEvent[] = [];
    let launchCommand: PaneLaunchCommand;
    let codexSessionHookRegistration: CodexSessionHookRegistration | null = null;
    try {
      launchCommand = this.launchProfiles.resolve(context);
      if (context.pane.kind === "codex" && this.codexSessionHooks !== undefined) {
        codexSessionHookRegistration = this.codexSessionHooks.register({
          paneId,
          runtimeId,
          cwd: context.projectPath,
          onEvent: (event) => {
            if (activeRuntime === null) {
              pendingCodexEvents.push(event);
              return;
            }
            if (activeRuntime.disposed) return;
            activeRuntime.codexSemantics?.acceptHook(event);
          },
        });
        launchCommand = {
          ...launchCommand,
          environment: {
            ...launchCommand.environment,
            ...codexSessionHookRegistration.environment,
          },
        };
      }
    } catch (error) {
      codexSessionHookRegistration?.dispose();
      const normalized = normalizeLaunchError(error, context.pane.kind);
      this.repository.setPaneStatusForRuntime(paneId, runtimeId, "error", null, normalized.code);
      this.#transitionActivity(paneId, "failed", runtimeId);
      throw normalized;
    }

    const terminal = new HeadlessTerminal({
      cols: columns,
      rows,
      scrollback: MAX_TERMINAL_SCROLLBACK_ROWS,
      allowProposedApi: true,
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);

    let process: PtyProcess;
    try {
      process = this.factory(launchCommand.file, launchCommand.args, {
        name: "xterm-256color",
        cols: columns,
        rows,
        cwd: context.projectPath,
        env: launchCommand.environment,
      });
    } catch {
      codexSessionHookRegistration?.dispose();
      terminal.dispose();
      this.repository.setPaneStatusForRuntime(paneId, runtimeId, "error", null, "PTY_SPAWN_FAILED");
      this.#transitionActivity(paneId, "failed", runtimeId);
      throw new AppError(
        "PTY_SPAWN_FAILED",
        500,
        context.pane.kind === "codex"
          ? "Codex CLI 프로세스를 시작하지 못했습니다."
          : "터미널 프로세스를 시작하지 못했습니다.",
      );
    }

    let resolveExit = (): void => undefined;
    const exitPromise = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });
    const runtime: Runtime = {
      paneId,
      runtimeId,
      process,
      terminal,
      serializer,
      codexSemantics:
        context.pane.kind === "codex"
          ? new CodexRuntimeSemantics({
              repository: this.repository,
              paneId,
              runtimeId,
              emitActivity: (change) => this.#emitActivity(change),
              onSession: ({ sessionId, resumable }) =>
                this.#emitCodexIdentityForRuntime(paneId, runtimeId, sessionId, resumable),
            })
          : null,
      codexSessionHookRegistration,
      listeners: new Set(),
      exitPromise,
      resolveExit,
      sequence: 0,
      writeBarrier: Promise.resolve(),
      viewportBottomOffset: 0,
      terminationCause: "none",
      disposed: false,
    };
    activeRuntime = runtime;
    this.#runtimes.set(paneId, runtime);
    for (const event of pendingCodexEvents) runtime.codexSemantics?.acceptHook(event);
    if (runtime.codexSemantics !== null && runtime.codexSemantics.sessionId !== null) {
      this.#emitCodexIdentity({
        paneId,
        runtimeId,
        sessionId: runtime.codexSemantics.sessionId,
        resumable: runtime.codexSemantics.sessionResumable,
        updatedAt: this.#requirePane(paneId).pane.updatedAt,
      });
    }

    process.onData((data) => {
      runtime.writeBarrier = runtime.writeBarrier
        .then(() => {
          const previousBaseY = runtime.terminal.buffer.normal.baseY;
          return writeTerminal(runtime.terminal, data).then(() => {
            preserveViewportAnchor(runtime, previousBaseY);
          });
        })
        .then(() => {
          if (runtime.disposed) return;
          runtime.codexSemantics?.observeOutput(data, () =>
            runtime.serializer.serialize({ scrollback: 0 }),
          );
          runtime.sequence += 1;
          this.#emit(runtime, {
            type: "terminal.output",
            paneId,
            sequence: runtime.sequence,
            data,
          });
        });
    });
    process.onExit((event) => {
      void runtime.writeBarrier.finally(() => {
        if (runtime.disposed) return;
        if (this.#runtimes.get(paneId) === runtime) this.#runtimes.delete(paneId);
        const serverStopped = runtime.terminationCause === "server-stop";
        const currentRuntime = this.repository.setPaneStatusForRuntime(
          paneId,
          runtime.runtimeId,
          serverStopped ? "stopped" : "exited",
          serverStopped ? null : event.exitCode,
          null,
          new Date().toISOString(),
        );
        if (currentRuntime) {
          if (runtime.codexSemantics !== null) {
            runtime.codexSemantics.observeExit(event.exitCode);
          } else if (serverStopped) {
            this.#transitionActivity(paneId, "server-stopped", runtime.runtimeId);
          } else if (event.exitCode !== 0) {
            this.#transitionActivity(paneId, "failed", runtime.runtimeId);
          }
        }
        this.#emit(runtime, {
          type: "terminal.exit",
          paneId,
          exitCode: event.exitCode,
          ...(event.signal === undefined ? {} : { signal: event.signal }),
          ...(runtime.codexSemantics === null
            ? {}
            : {
                codexSessionId: runtime.codexSemantics.sessionId,
                codexSessionResumable: runtime.codexSemantics.sessionResumable,
              }),
        });
        runtime.disposed = true;
        runtime.codexSessionHookRegistration?.dispose();
        runtime.listeners.clear();
        runtime.terminal.dispose();
        runtime.resolveExit();
      });
    });
  }

  async attach(
    paneId: string,
    columns: number,
    rows: number,
    listener: FrameListener,
    restoreProtocol?: TerminalRestoreProtocol,
    restoreId?: string,
    options?: SessionAttachmentOptions,
  ): Promise<() => void> {
    const runtime = this.#runtimes.get(paneId);
    if (!runtime) {
      throw new AppError("PTY_NOT_RUNNING", 409, "실행 중인 Pane이 아닙니다.");
    }

    if (options?.control !== "observer") this.resize(paneId, columns, rows);
    let snapshotSent = false;
    const queuedFrames: ServerWsFrame[] = [];
    const guardedListener: FrameListener = (frame) => {
      if (snapshotSent) listener(frame);
      else queuedFrames.push(frame);
    };
    runtime.listeners.add(guardedListener);

    if (restoreProtocol === TERMINAL_RESTORE_PROTOCOL && restoreId !== undefined) {
      const snapshot = await captureStagedSnapshot(runtime, (preview) => {
        listener({
          type: "pane.restore.preview",
          paneId,
          sequence: preview.sequence,
          serializedState: preview.serializedState,
          runtimeId: runtime.runtimeId,
          restoreId,
          bottomOffset: preview.bottomOffset,
          previewBottomOffset: preview.previewBottomOffset,
          cols: preview.cols,
          rows: preview.rows,
        });
      });
      if (runtime.disposed) {
        runtime.listeners.delete(guardedListener);
        throw new AppError("PTY_NOT_RUNNING", 409, "Pane 프로세스가 종료되었습니다.");
      }
      listener({
        type: "pane.restore.full",
        paneId,
        sequence: snapshot.sequence,
        serializedState: snapshot.serializedState,
        runtimeId: runtime.runtimeId,
        restoreId,
        bottomOffset: snapshot.bottomOffset,
        cols: snapshot.cols,
        rows: snapshot.rows,
      });
      for (const frame of queuedFrames) {
        if (frame.type !== "terminal.output" || frame.sequence > snapshot.sequence) listener(frame);
      }
      snapshotSent = true;
      return () => runtime.listeners.delete(guardedListener);
    }

    const snapshot = await captureSnapshot(runtime);
    if (runtime.disposed) {
      runtime.listeners.delete(guardedListener);
      throw new AppError("PTY_NOT_RUNNING", 409, "Pane 프로세스가 종료되었습니다.");
    }

    listener({
      type: "pane.snapshot",
      paneId,
      sequence: snapshot.sequence,
      serializedState: snapshot.serializedState,
      runtimeId: runtime.runtimeId,
      cols: snapshot.cols,
      rows: snapshot.rows,
    });
    for (const frame of queuedFrames) {
      if (frame.type !== "terminal.output" || frame.sequence > snapshot.sequence) listener(frame);
    }
    snapshotSent = true;

    return () => runtime.listeners.delete(guardedListener);
  }

  write(paneId: string, data: string): void {
    const runtime = this.#runtime(paneId);
    runtime.codexSemantics?.observeInput(data);
    runtime.process.write(data);
  }

  resize(paneId: string, columns: number, rows: number): void {
    const runtime = this.#runtime(paneId);
    const previousBaseY = runtime.terminal.buffer.normal.baseY;
    runtime.terminal.resize(columns, rows);
    preserveViewportAnchor(runtime, previousBaseY);
    runtime.process.resize(columns, rows);
  }

  updateViewport(paneId: string, runtimeId: string, bottomOffset: number): void {
    const runtime = this.#runtimes.get(paneId);
    if (!runtime || runtime.runtimeId !== runtimeId || runtime.disposed) return;
    runtime.viewportBottomOffset =
      runtime.terminal.buffer.active.type === "alternate"
        ? 0
        : clampBottomOffset(bottomOffset, runtime.terminal.buffer.normal.baseY);
  }

  setControlDesired(paneId: string, desired: boolean, columns: number, rows: number): void {
    if (desired) this.resize(paneId, columns, rows);
  }

  preemptControl(paneId: string, columns: number, rows: number): void {
    this.resize(paneId, columns, rows);
  }

  approveControl(): never {
    throw new AppError("REQUEST_INVALID", 409, "Legacy terminal에는 control 요청이 없습니다.");
  }

  rejectControl(): never {
    throw new AppError("REQUEST_INVALID", 409, "Legacy terminal에는 control 요청이 없습니다.");
  }

  releaseControl(): void {
    // The instance-wide Naru surface owns the legacy controller state.
  }

  restart(paneId: string): void {
    if (this.#runtimes.has(paneId)) {
      throw new AppError("REQUEST_INVALID", 409, "실행 중인 Pane은 재시작할 수 없습니다.");
    }
    const context = this.#requirePane(paneId);
    const clearedIdentity =
      context.pane.kind === "codex" &&
      context.pane.codexSessionId !== null &&
      !context.pane.codexSessionResumable;
    if (clearedIdentity) {
      this.repository.setCodexSession(paneId, null, false);
      this.#emitStoredCodexIdentity(paneId);
    }
    this.start(paneId);
  }

  startNewCodex(paneId: string): void {
    if (this.#runtimes.has(paneId)) {
      throw new AppError(
        "REQUEST_INVALID",
        409,
        "실행 중인 Codex Pane에서는 새 세션을 시작할 수 없습니다.",
      );
    }
    const context = this.#requirePane(paneId);
    if (context.pane.kind !== "codex") {
      throw new AppError("REQUEST_INVALID", 400, "Codex Pane에서만 새 세션을 시작할 수 있습니다.");
    }
    this.repository.setCodexSession(paneId, null, false);
    this.#emitStoredCodexIdentity(paneId);
    this.start(paneId);
  }

  stop(paneId: string): void {
    const runtime = this.#runtimes.get(paneId);
    if (!runtime) return;
    this.#markServerStopped(runtime);
    runtime.process.kill("SIGHUP");
  }

  remove(paneId: string): void {
    this.stop(paneId);
  }

  async shutdown(): Promise<void> {
    const runtimes = [...this.#runtimes.values()];
    for (const runtime of runtimes) {
      try {
        this.#markServerStopped(runtime);
        runtime.process.kill("SIGHUP");
      } catch {
        this.#dispose(runtime);
      }
    }
    await Promise.all(
      runtimes.map(async (runtime) => {
        await Promise.race([
          runtime.exitPromise,
          new Promise<void>((resolve) => {
            setTimeout(resolve, 2_000).unref();
          }),
        ]);
        if (!runtime.disposed) {
          try {
            runtime.process.kill("SIGKILL");
          } catch {
            // The child already exited between the timeout and this signal.
          }
          this.#dispose(runtime);
        }
      }),
    );
    await this.codexSessionHooks?.close();
    this.#activityListeners.clear();
    this.#codexIdentityListeners.clear();
  }

  #requirePane(paneId: string): PaneContext {
    const context = this.repository.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    return context;
  }

  #runtime(paneId: string): Runtime {
    const runtime = this.#runtimes.get(paneId);
    if (!runtime) throw new AppError("PTY_NOT_RUNNING", 409, "실행 중인 Pane이 아닙니다.");
    return runtime;
  }

  #emit(runtime: Runtime, frame: ServerWsFrame): void {
    for (const listener of runtime.listeners) listener(frame);
  }

  #transitionActivity(
    paneId: string,
    state: PaneActivityState,
    runtimeId = this.#runtimes.get(paneId)?.runtimeId ?? null,
  ): void {
    if (!this.repository.getPaneContext(paneId)) return;
    const change =
      runtimeId === null
        ? this.repository.setPaneActivity(paneId, state)
        : this.repository.setPaneActivityForRuntime(paneId, runtimeId, state);
    if (change) this.#emitActivity(change);
  }

  #emitActivity(change: PaneActivityChange): void {
    for (const listener of this.#activityListeners) listener(change);
  }

  #emitCodexIdentity(change: SessionCodexIdentityChange): void {
    for (const listener of this.#codexIdentityListeners) listener(change);
  }

  #emitCodexIdentityForRuntime(
    paneId: string,
    runtimeId: string,
    sessionId: string | null,
    resumable: boolean,
  ): void {
    const pane = this.repository.getPaneContext(paneId)?.pane;
    if (pane?.activity.runtimeId !== runtimeId) return;
    this.#emitCodexIdentity({ paneId, runtimeId, sessionId, resumable, updatedAt: pane.updatedAt });
  }

  #emitStoredCodexIdentity(paneId: string): void {
    const pane = this.repository.getPaneContext(paneId)?.pane;
    if (pane?.kind !== "codex" || pane.activity.runtimeId === null) return;
    this.#emitCodexIdentity({
      paneId,
      runtimeId: pane.activity.runtimeId,
      sessionId: pane.codexSessionId,
      resumable: pane.codexSessionResumable,
      updatedAt: pane.updatedAt,
    });
  }

  #markServerStopped(runtime: Runtime): void {
    if (runtime.terminationCause === "server-stop") return;
    runtime.terminationCause = "server-stop";
    runtime.codexSemantics?.markStopping();
    if (!this.repository.getPaneContext(runtime.paneId)) return;
    this.repository.setPaneStatusForRuntime(
      runtime.paneId,
      runtime.runtimeId,
      "stopped",
      null,
      null,
      new Date().toISOString(),
    );
    this.#transitionActivity(runtime.paneId, "server-stopped", runtime.runtimeId);
  }

  #dispose(runtime: Runtime): void {
    if (runtime.disposed) return;
    runtime.disposed = true;
    if (this.#runtimes.get(runtime.paneId) === runtime) this.#runtimes.delete(runtime.paneId);
    runtime.codexSessionHookRegistration?.dispose();
    runtime.listeners.clear();
    runtime.terminal.dispose();
    runtime.resolveExit();
  }
}

function realPtyFactory(file: string, args: string[], options: PtySpawnOptions): IPty {
  ensurePtyHelperExecutable();
  return nodePty.spawn(file, args, options);
}

let ptyHelperChecked = false;

function ensurePtyHelperExecutable(): void {
  if (ptyHelperChecked || process.platform === "win32") return;
  const packageRoot = dirname(require.resolve("node-pty/package.json"));
  const candidates = [
    join(packageRoot, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
    join(packageRoot, "build", "Release", "spawn-helper"),
  ];
  const helper = candidates.find((candidate) => existsSync(candidate));
  if (!helper) throw new Error("node-pty spawn-helper was not installed.");
  const mode = statSync(helper).mode;
  if ((mode & 0o100) === 0) chmodSync(helper, mode | 0o100);
  ptyHelperChecked = true;
}

function normalizeLaunchError(error: unknown, kind: "terminal" | "codex"): AppError {
  if (error instanceof AppError) return error;
  return new AppError(
    "PTY_SPAWN_FAILED",
    500,
    kind === "codex" ? "Codex CLI 실행 준비에 실패했습니다." : "터미널 실행 준비에 실패했습니다.",
  );
}

function writeTerminal(terminal: HeadlessTerminalInstance, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function captureSnapshot(runtime: Runtime): Promise<{
  sequence: number;
  serializedState: string;
  cols: number;
  rows: number;
}> {
  const snapshot = runtime.writeBarrier.then(() => ({
    sequence: runtime.sequence,
    serializedState: runtime.serializer.serialize({
      scrollback: MAX_TERMINAL_SCROLLBACK_ROWS,
    }),
    cols: runtime.terminal.cols,
    rows: runtime.terminal.rows,
  }));
  runtime.writeBarrier = snapshot.then(() => undefined);
  return snapshot;
}

interface StagedSnapshotPart {
  sequence: number;
  serializedState: string;
  bottomOffset: number;
  cols: number;
  rows: number;
}

function captureStagedSnapshot(
  runtime: Runtime,
  previewReady: (preview: StagedSnapshotPart & { previewBottomOffset: number }) => void,
): Promise<StagedSnapshotPart> {
  const snapshot = runtime.writeBarrier.then(() => {
    const cols = runtime.terminal.cols;
    const rows = runtime.terminal.rows;
    const normal = runtime.terminal.buffer.normal;
    const bottomOffset =
      runtime.terminal.buffer.active.type === "alternate"
        ? 0
        : clampBottomOffset(runtime.viewportBottomOffset, normal.baseY);
    const currentState = runtime.serializer.serialize({ scrollback: 0 });
    let previewState = currentState;
    let previewBottomOffset = 0;

    if (bottomOffset > 0 && runtime.terminal.buffer.active.type === "normal") {
      const start = Math.max(0, normal.baseY - bottomOffset);
      const end = Math.min(normal.length - 1, start + rows - 1);
      const visibleHistory = runtime.serializer.serialize({
        range: { start, end },
        excludeAltBuffer: true,
        excludeModes: true,
      });
      previewState = `${visibleHistory}\u001b[${rows};1H${"\r\n".repeat(rows)}\u001b[2J\u001b[H${currentState}`;
      previewBottomOffset = rows;
    }

    const common = {
      sequence: runtime.sequence,
      bottomOffset,
      cols,
      rows,
    };
    previewReady({
      ...common,
      serializedState: previewState,
      previewBottomOffset,
    });
    return {
      ...common,
      serializedState: runtime.serializer.serialize({
        scrollback: MAX_TERMINAL_SCROLLBACK_ROWS,
      }),
    };
  });
  runtime.writeBarrier = snapshot.then(() => undefined);
  return snapshot;
}

function preserveViewportAnchor(runtime: Runtime, previousBaseY: number): void {
  if (runtime.viewportBottomOffset === 0) return;
  const nextBaseY = runtime.terminal.buffer.normal.baseY;
  runtime.viewportBottomOffset = clampBottomOffset(
    runtime.viewportBottomOffset + nextBaseY - previousBaseY,
    nextBaseY,
  );
}

function clampBottomOffset(bottomOffset: number, baseY: number): number {
  return Math.min(MAX_TERMINAL_SCROLLBACK_ROWS, Math.max(0, Math.min(bottomOffset, baseY)));
}
