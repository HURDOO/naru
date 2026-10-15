import { createRequire } from "node:module";
import type {
  ITerminalInitOnlyOptions,
  ITerminalOptions,
  Terminal as HeadlessTerminalInstance,
} from "@xterm/headless";
import type { AgentEvent, SharedProcess } from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore, CommandContext } from "../agent-platform/core.js";
import { AgentPlatformError } from "../agent-platform/core.js";
import type { NaruRepository } from "../database.js";
import type { NaruSessionFacade } from "../session-facade.js";

const require = createRequire(import.meta.url);
const { Terminal: HeadlessTerminal } = require("@xterm/headless") as {
  Terminal: new (options?: ITerminalOptions & ITerminalInitOnlyOptions) => HeadlessTerminalInstance;
};

const SYSTEM = { kind: "system" } as const;
const COLUMNS = 160;
const ROWS = 48;
const SCROLLBACK_ROWS = 2_000;
const MAX_READ_LINES = 400;
/** A person's browser lets go of control before the agent takes it back. */
const REACQUIRE_ATTEMPTS = 20;
const REACQUIRE_INTERVAL_MS = 250;

/**
 * Whether a person's controller device should hold Host control of a Pane right now. Panes run by
 * agents (shared processes, managed agent consoles) are observed until a person takes them over
 * (AP-D005), so merely looking at one never takes control away from its agent.
 */
export interface PaneControlPolicy {
  humanMayControl(paneId: string): boolean;
  onChange(listener: (paneId: string) => void): () => void;
}

export const OPEN_PANE_CONTROL: PaneControlPolicy = {
  humanMayControl: () => true,
  onChange: () => () => undefined,
};

interface Watch {
  readonly paneId: string;
  readonly attachmentKey: string;
  readonly terminal: HeadlessTerminalInstance;
  detach: (() => void) | null;
  stopping: boolean;
}

/**
 * Runs agents' shared processes (AP-D006, A08/A09): records come first in Core, then a terminal Pane
 * joins the workspace collapsed and its Host session runs the agent's command in a login shell. Naru
 * keeps one controller attachment per process for the agent's input and renders its screen for
 * `process.read`; nothing it reads is stored (AP-D002).
 */
export class SharedProcessRuntime implements PaneControlPolicy {
  readonly #core: AgentPlatformCore;
  readonly #repository: NaruRepository;
  readonly #sessions: () => NaruSessionFacade;
  readonly #watches = new Map<string, Watch>();
  readonly #listeners = new Set<(paneId: string) => void>();
  readonly #unsubscribe: () => void;

  constructor(options: {
    readonly core: AgentPlatformCore;
    readonly repository: NaruRepository;
    readonly sessions: () => NaruSessionFacade;
  }) {
    this.#core = options.core;
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#unsubscribe = options.core.subscribe((event) => this.#observe(event));
  }

  // PaneControlPolicy ------------------------------------------------------------------------------

  humanMayControl(paneId: string): boolean {
    const process = this.#repository.agentPlatform.findSharedProcessByPane(paneId);
    if (process !== null) {
      return process.humanHoldSince !== null || !isActive(process);
    }
    const agent = this.#repository.agentPlatform.findAgentSessionByPane(paneId);
    if (agent !== null) return agent.launchMode === "tui" && agent.humanHoldSince !== null;
    return true;
  }

  onChange(listener: (paneId: string) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Tells browsers to re-evaluate control of a Pane (e.g. after an agent hold changed). */
  notifyControlChanged(paneId: string): void {
    for (const listener of this.#listeners) listener(paneId);
  }

  // Agent operations -------------------------------------------------------------------------------

  /** Records the process (AP-D006), then creates its Pane and runs the command. */
  async start(
    context: CommandContext,
    input: Parameters<AgentPlatformCore["startSharedProcess"]>[1],
  ): Promise<SharedProcess> {
    const recorded = this.#core.startSharedProcess(context, input);
    if (recorded.paneId !== null || recorded.status !== "starting") return recorded; // a retry
    const pane = this.#repository.createSharedProcessPane(
      recorded.id,
      `${recorded.purpose} · agent`,
    );
    try {
      await this.#sessions().start(pane.id, COLUMNS, ROWS);
      const watch = await this.#watch(recorded.id, pane.id);
      await this.#sessions().write(pane.id, `${recorded.command}\r`, watch.attachmentKey);
    } catch (error) {
      this.#core.updateSharedProcessState(SYSTEM, { processId: recorded.id, status: "failed" });
      throw error;
    }
    return this.#core.updateSharedProcessState(SYSTEM, {
      processId: recorded.id,
      status: "running",
    });
  }

  /** Agent input to its own process; refused while a person holds it (AP-D005). */
  async input(context: CommandContext, processId: string, text: string): Promise<SharedProcess> {
    const { process, replayed } = this.#core.recordSharedProcessInput(context, { processId, text });
    if (replayed) return process;
    const watch = await this.#requireWatch(process);
    await this.#sessions().setControlDesired(
      watch.paneId,
      true,
      COLUMNS,
      ROWS,
      watch.attachmentKey,
    );
    try {
      await this.#sessions().write(watch.paneId, text, watch.attachmentKey);
    } catch {
      throw new AgentPlatformError(
        "AGENT_HELD_BY_HUMAN",
        "The terminal is controlled by a person right now; request a terminal-control handoff.",
      );
    }
    return process;
  }

  /** The current screen and recent scrollback as plain text, for the agent only (not stored). */
  async read(
    actor: CommandContext["actor"],
    processId: string,
    lines: number,
  ): Promise<{ readonly process: SharedProcess; readonly screen: string }> {
    const process = this.#core.getSharedProcess(actor, processId);
    const watch = this.#watches.get(processId);
    if (watch === undefined) return { process, screen: "" };
    await new Promise<void>((resolve) => watch.terminal.write("", resolve));
    const buffer = watch.terminal.buffer.active;
    const text: string[] = [];
    for (let index = 0; index < buffer.length; index += 1) {
      text.push(buffer.getLine(index)?.translateToString(true) ?? "");
    }
    while (text.length > 0 && text.at(-1) === "") text.pop();
    const count = Math.min(Math.max(lines, 1), MAX_READ_LINES);
    return { process, screen: text.slice(-count).join("\n") };
  }

  async stop(actor: CommandContext["actor"], processId: string): Promise<SharedProcess> {
    const process = this.#core.authorizeSharedProcessStop(actor, processId);
    if (!isActive(process)) return process;
    const watch = this.#watches.get(processId);
    if (watch !== undefined) watch.stopping = true;
    if (process.paneId !== null) {
      await this.#sessions().stop(process.paneId);
    }
    return this.#core.updateSharedProcessState(SYSTEM, { processId, status: "stopped" });
  }

  /**
   * A person takes over or returns a process. On takeover the agent lets go of Host control before
   * the person's browser asks for it; on return the browser lets go and the agent takes it back
   * with a new generation (it should read the screen again before typing).
   */
  async setHold(
    context: CommandContext,
    processId: string,
    held: boolean,
    reason: "takeover" | "release" | "disconnect-timeout" | "idle-timeout",
  ): Promise<SharedProcess> {
    const process = this.#core.setSharedProcessHold(context, { processId, held, reason });
    const watch = this.#watches.get(processId);
    if (held) {
      if (watch !== undefined) {
        try {
          await this.#sessions().releaseControl(watch.paneId, watch.attachmentKey);
        } catch {
          // Not the controller any more; the person's browser can take control either way.
        }
      }
      if (process.paneId !== null) this.notifyControlChanged(process.paneId);
      return process;
    }
    if (process.paneId !== null) this.notifyControlChanged(process.paneId);
    if (watch !== undefined) void this.#reacquire(watch);
    return process;
  }

  /** After a Naru restart: reattach to processes whose Host session survived. */
  async restore(): Promise<void> {
    for (const process of this.#repository.agentPlatform.listActiveSharedProcesses()) {
      if (process.paneId !== null && this.#sessions().isRunning(process.paneId)) {
        await this.#watch(process.id, process.paneId).catch(() => undefined);
      } else {
        this.#core.updateSharedProcessState(SYSTEM, { processId: process.id, status: "unknown" });
      }
    }
  }

  close(): void {
    this.#unsubscribe();
    for (const watch of this.#watches.values()) {
      watch.detach?.();
      watch.terminal.dispose();
    }
    this.#watches.clear();
  }

  // ------------------------------------------------------------------------------------------------

  async #requireWatch(process: SharedProcess): Promise<Watch> {
    const existing = this.#watches.get(process.id);
    if (existing !== undefined) return existing;
    if (process.paneId === null || !this.#sessions().isRunning(process.paneId)) {
      throw new AgentPlatformError("AGENT_INVALID_STATE", "The process is not running.");
    }
    return this.#watch(process.id, process.paneId);
  }

  async #watch(processId: string, paneId: string): Promise<Watch> {
    const existing = this.#watches.get(processId);
    if (existing !== undefined) return existing;
    const watch: Watch = {
      paneId,
      attachmentKey: `agent-process:${processId}`,
      terminal: new HeadlessTerminal({
        cols: COLUMNS,
        rows: ROWS,
        scrollback: SCROLLBACK_ROWS,
        allowProposedApi: true,
      }),
      detach: null,
      stopping: false,
    };
    this.#watches.set(processId, watch);
    try {
      watch.detach = await this.#sessions().attach(
        paneId,
        COLUMNS,
        ROWS,
        (frame) => {
          if (frame.type === "pane.snapshot") {
            watch.terminal.reset();
            watch.terminal.resize(frame.cols, frame.rows);
            watch.terminal.write(frame.serializedState);
          } else if (frame.type === "terminal.output") {
            watch.terminal.write(frame.data);
          } else if (frame.type === "terminal.exit") {
            this.#exited(processId, watch, frame.exitCode);
          }
        },
        undefined,
        undefined,
        { attachmentKey: watch.attachmentKey, control: "controller" },
      );
    } catch (error) {
      this.#watches.delete(processId);
      watch.terminal.dispose();
      throw error;
    }
    return watch;
  }

  #exited(processId: string, watch: Watch, exitCode: number): void {
    if (this.#watches.get(processId) !== watch) return;
    this.#watches.delete(processId);
    watch.detach?.();
    watch.terminal.dispose();
    this.#core.updateSharedProcessState(SYSTEM, {
      processId,
      status: watch.stopping ? "stopped" : exitCode === 0 ? "exited" : "failed",
      exitCode,
    });
    this.notifyControlChanged(watch.paneId);
  }

  async #reacquire(watch: Watch): Promise<void> {
    for (let attempt = 0; attempt < REACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        await this.#sessions().setControlDesired(
          watch.paneId,
          true,
          COLUMNS,
          ROWS,
          watch.attachmentKey,
        );
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, REACQUIRE_INTERVAL_MS));
      }
    }
  }

  /** A run that ends takes its `keep: run` processes with it (A08 policy). */
  #observe(event: AgentEvent): void {
    if (event.type !== "run.finished") return;
    for (const process of this.#core.sharedProcessesForRun(SYSTEM, event.subjectId)) {
      if (process.keep === "run" && isActive(process)) {
        void this.stop(SYSTEM, process.id).catch(() => undefined);
      }
    }
  }
}

function isActive(process: SharedProcess): boolean {
  return process.status === "starting" || process.status === "running";
}
