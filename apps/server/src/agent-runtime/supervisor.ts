import { randomUUID } from "node:crypto";
import type {
  Actor,
  AgentApprovalDecision,
  AgentEvent,
  AgentRuntimeState,
  AgentSession,
} from "@naru/contracts/naru-agent/v1";
import {
  AgentPlatformError,
  type AgentPlatformCore,
  type CommandContext,
} from "../agent-platform/core.js";
import type {
  OrchestratorInvoker,
  OrchestratorWakeups,
  WakeupBatch,
} from "../agent-platform/wakeups.js";
import type { AgentHistoryWindow } from "@naru/contracts/naru-agent/v1/history";
import type { HistoryPage } from "./adapter.js";
import {
  NARU_RUNTIME_SOCKET_ENV,
  NARU_RUNTIME_TOKEN_ENV,
  type AnyRunnerPlan,
  type RunnerMessage,
} from "./channel-protocol.js";
import { historyBefore, LATEST_HISTORY, type HistoryRead } from "./history-window.js";
import type { RunnerConnection, RuntimeChannelHandlers } from "./runtime-channel-server.js";
import {
  authorizeWrite,
  initialWriterGate,
  reduceWriterGate,
  writerBackend,
  type WriterCommand,
  type WriterEffect,
  type WriterGateState,
  type WriterKind,
} from "./writer-gate.js";

const SYSTEM = { kind: "system" } as const;
const HISTORY_TIMEOUT_MS = 15_000;
/** Longer than the runner's longest reconnect backoff (5 s). */
const DISCONNECT_GRACE_MS = 15_000;
/** An agent Naru started again on its own is not started again before this (AP-D034). */
const RELAUNCH_COOLDOWN_MS = 10 * 60_000;
/** How long a switched-to form may take to report the resumed conversation. */
const RESUME_TIMEOUT_MS = 60_000;

/**
 * Hosts an agent's runtime process, e.g. in its Host PTY Pane. The agent's recorded launch mode
 * decides which form (`runner` or `tui`) a launch starts.
 */
export interface RunnerLauncher {
  /** `hostProjectId` places a global agent's Pane (the main orchestrator) in a workspace. */
  launch(agentSessionId: string, options?: { readonly hostProjectId?: string }): Promise<void>;
  /** Ends the hosting process and resolves once it has exited. */
  stop(agentSessionId: string): Promise<void>;
  /**
   * TUI form: resolves with the conversation the freshly started TUI reported (SessionStart), or
   * null when it exits or stays silent past the timeout.
   */
  awaitTuiSession?(agentSessionId: string, timeoutMs: number): Promise<string | null>;
}

/** The private channel values a runner process needs; the token is single-use per launch. */
export interface RunnerEnvironment {
  readonly [NARU_RUNTIME_SOCKET_ENV]: string;
  readonly [NARU_RUNTIME_TOKEN_ENV]: string;
}

export class SupervisorError extends Error {
  constructor(
    readonly code:
      | "RUNTIME_NOT_CONNECTED"
      | "WRITER_REQUIRED"
      | "APPROVAL_UNKNOWN"
      | "HISTORY_TIMEOUT"
      | "HISTORY_REFUSED",
    message: string,
  ) {
    super(message);
    this.name = "SupervisorError";
  }
}

interface ManagedRuntime {
  connection: RunnerConnection | null;
  lastSeq: number;
  gate: WriterGateState;
  /** requestId → kind and, when the runtime gave one, what is asked (AP-D017). */
  readonly approvals: Map<
    string,
    { readonly kind: string; readonly summary?: string; readonly sessionAllow?: boolean }
  >;
  /** Native subagents by runtime ref → start time (observation only). */
  readonly children: Map<string, string>;
  readonly history: Map<string, (page: HistoryPage | null) => void>;
  disconnectTimer: NodeJS.Timeout | null;
  resumeTimer: NodeJS.Timeout | null;
  /** Resolved when a writer switch settles (active or recovery-required). */
  readonly switchWaiters: (() => void)[];
  /** When the running turn began, and the tool call it makes now (AP-D034); memory only. */
  turnStartedAt: string | null;
  /**
   * This Naru process sent the runner its plan. A runner an earlier Naru started runs that Naru's
   * code and is started again on this one once it is idle (AP-D042).
   */
  startedHere: boolean;
  activity: {
    readonly tool: string;
    readonly target: string | null;
    readonly since: string;
  } | null;
}

/**
 * Naru's side of managed agent runtimes (AP-T14): authenticates runners, applies the writer gate
 * (INV-05) before any turn, interrupt or approval reaches a runtime, mirrors runtime state into
 * AgentPlatformCore, and turns orchestrator wakeups into turns. It decides nothing about the work
 * itself (INV-02).
 */
export class ManagedAgentSupervisor implements RuntimeChannelHandlers, OrchestratorInvoker {
  readonly #core: AgentPlatformCore;
  readonly #launcher: RunnerLauncher;
  readonly #channelSocketPath: string;
  readonly #planFor: (agent: AgentSession) => AnyRunnerPlan;
  readonly #runtimes = new Map<string, ManagedRuntime>();
  #wakeups: OrchestratorWakeups | null = null;
  #startupTimer: NodeJS.Timeout | null = null;
  readonly #disconnectGraceMs: number;
  readonly #attention: ((agentSessionId: string, required: boolean) => void) | undefined;
  readonly #autoRelaunch: boolean;
  readonly #relaunchedAt = new Map<string, number>();
  readonly #unsubscribeCore: () => void;

  constructor(options: {
    readonly core: AgentPlatformCore;
    readonly launcher: RunnerLauncher;
    /** Where runners reach Naru (`RuntimeChannelServer.socketPath`). */
    readonly channelSocketPath: string;
    /** Built when a fresh runner asks for it, so it always resumes the recorded conversation. */
    readonly planFor: (agent: AgentSession) => AnyRunnerPlan;
    /** How long a vanished runtime may take to come back before it is `unknown`. */
    readonly disconnectGraceMs?: number;
    /** Shows that an agent waits for the person's approval, and that it stopped waiting. */
    readonly attention?: (agentSessionId: string, required: boolean) => void;
    /**
     * Starts agents again that went down on their own (AP-D034): after a restart, and when another
     * agent hands work to one that is not running. A person's stop is never undone.
     */
    readonly autoRelaunch?: boolean;
  }) {
    this.#disconnectGraceMs = options.disconnectGraceMs ?? DISCONNECT_GRACE_MS;
    this.#attention = options.attention;
    this.#autoRelaunch = options.autoRelaunch ?? false;
    this.#core = options.core;
    this.#launcher = options.launcher;
    this.#channelSocketPath = options.channelSocketPath;
    this.#planFor = options.planFor;
    this.#unsubscribeCore = this.#autoRelaunch
      ? options.core.subscribe((event) => {
          // An agent's delegation to an agent that is down would wait unseen; start the recipient.
          if (event.type !== "instruction.created" || event.actor.kind !== "agent") return;
          for (const agent of this.#core.instructionRecipients(SYSTEM, event.subjectId)) {
            this.#relaunchIfDown(agent);
          }
        })
      : () => undefined;
  }

  useWakeups(wakeups: OrchestratorWakeups): void {
    this.#wakeups = wakeups;
  }

  /** An agent's `spawn_agent` (or a person): record the session, then start it once. */
  async spawn(
    context: CommandContext,
    input: {
      readonly projectId: string;
      readonly role: AgentSession["role"];
      readonly runtime?: "claude" | "codex";
    },
  ): Promise<AgentSession> {
    const replayed = this.#core.commandRecorded(context.actor, context.idempotencyKey);
    const agent = this.#core.spawnAgentSession(context, input);
    if (!replayed) await this.launch(agent.id);
    return this.#core.getAgentSession(SYSTEM, agent.id);
  }

  async launch(
    agentSessionId: string,
    options: { readonly hostProjectId?: string } = {},
  ): Promise<void> {
    const agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
    this.#runtime(agentSessionId, agent.runtimeSessionRef);
    this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "starting" });
    try {
      await this.#launcher.launch(agentSessionId, options);
    } catch (error) {
      // A launch that never started is a failure the orchestrator hears about, not a silent wait.
      this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "failed" });
      throw error;
    }
  }

  /**
   * Issued when the hosting process actually starts. A new token replaces the previous launch's,
   * so a stale runner (an older PTY generation) can no longer reconnect.
   */
  runnerEnvironment(agentSessionId: string): RunnerEnvironment {
    return {
      [NARU_RUNTIME_SOCKET_ENV]: this.#channelSocketPath,
      [NARU_RUNTIME_TOKEN_ENV]: this.#core.issueRuntimeLaunchToken(SYSTEM, agentSessionId),
    };
  }

  /** What the browser shows and fences against: writer, generation, form and pending approvals. */
  runtimeState(agentSessionId: string): AgentRuntimeState {
    const runtime = this.#require(agentSessionId);
    const agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
    return {
      agentSessionId,
      connected: runtime.connection !== null,
      writer: runtime.gate.writer,
      generation: runtime.gate.generation,
      phase: runtime.gate.phase,
      turnActive: runtime.gate.turnActive,
      launchMode: agent.launchMode,
      pendingApprovals: this.pendingApprovals(agentSessionId),
      children: [...runtime.children].map(([childRef, startedAt]) => ({ childRef, startedAt })),
      turnStartedAt: runtime.gate.turnActive ? runtime.turnStartedAt : null,
      activity: runtime.gate.turnActive ? runtime.activity : null,
    };
  }

  /** Throws unless `writer` at `generation` may perform `kind` on a connected runner now. */
  assertWriter(
    agentSessionId: string,
    writer: WriterKind,
    generation: number,
    kind: "turn" | "interrupt" | "approval-response",
  ): void {
    const runtime = this.#connected(agentSessionId);
    if (!authorizeWrite(runtime.gate, writer, generation, kind)) {
      throw new SupervisorError("WRITER_REQUIRED", "Another writer owns this conversation.");
    }
  }

  writer(agentSessionId: string): { readonly writer: WriterKind; readonly generation: number } {
    const gate = this.#require(agentSessionId).gate;
    return { writer: gate.writer, generation: gate.generation };
  }

  /**
   * Moves the conversation writer, e.g. a person taking over in Chat (live) or opening the TUI
   * (the runner stops and the same conversation resumes in the TUI; failure rolls back). Resolves
   * with the settled gate once the switch has finished, after a running turn if not interrupted.
   */
  async switchWriter(
    agentSessionId: string,
    to: WriterKind,
    interrupt: boolean,
  ): Promise<WriterGateState> {
    const runtime = this.#require(agentSessionId);
    const settled = new Promise<void>((resolve) => runtime.switchWaiters.push(resolve));
    if (!this.#transition(agentSessionId, runtime, { type: "request-switch", to, interrupt })) {
      runtime.switchWaiters.pop();
      throw new SupervisorError("WRITER_REQUIRED", "A writer switch is already in progress.");
    }
    await settled;
    return runtime.gate;
  }

  sendTurn(agentSessionId: string, text: string, writer: WriterKind, generation: number): void {
    const runtime = this.#connected(agentSessionId);
    if (!authorizeWrite(runtime.gate, writer, generation, "turn")) {
      throw new SupervisorError("WRITER_REQUIRED", "Another writer owns this conversation.");
    }
    runtime.connection!.send({ type: "send", text });
  }

  interrupt(agentSessionId: string, writer: WriterKind, generation: number): void {
    const runtime = this.#connected(agentSessionId);
    if (!authorizeWrite(runtime.gate, writer, generation, "interrupt")) {
      throw new SupervisorError("WRITER_REQUIRED", "Another writer owns this conversation.");
    }
    runtime.connection!.send({ type: "interrupt" });
  }

  /**
   * An orchestrator stops a working agent's turn (AP-D004 L3). Core checks role, scope and human
   * hold; the conversation must still be the orchestrator's, so a person writing is never cut off.
   */
  interruptByAgent(actor: Actor, agentSessionId: string): AgentRuntimeState {
    this.#core.authorizeInterrupt(actor, agentSessionId);
    const { writer, generation } = this.writer(agentSessionId);
    try {
      this.interrupt(agentSessionId, "orchestrator", generation);
    } catch (error) {
      if (!(error instanceof SupervisorError)) throw error;
      throw new AgentPlatformError(
        writer === "orchestrator" && error.code === "RUNTIME_NOT_CONNECTED"
          ? "AGENT_RUNTIME_UNAVAILABLE"
          : "AGENT_WRITER_REQUIRED",
        writer === "orchestrator" ? error.message : "A person is writing to this agent.",
      );
    }
    return this.runtimeState(agentSessionId);
  }

  pendingApprovals(
    agentSessionId: string,
  ): { requestId: string; kind: string; summary?: string; sessionAllow?: boolean }[] {
    const approvals = this.#runtimes.get(agentSessionId)?.approvals;
    if (approvals === undefined) return [];
    return [...approvals].map(([requestId, approval]) => ({
      requestId,
      kind: approval.kind,
      ...(approval.summary === undefined ? {} : { summary: approval.summary }),
      ...(approval.sessionAllow === true ? { sessionAllow: true } : {}),
    }));
  }

  respondApproval(
    agentSessionId: string,
    requestId: string,
    decision: AgentApprovalDecision,
    writer: WriterKind,
    generation: number,
  ): void {
    const runtime = this.#connected(agentSessionId);
    if (!authorizeWrite(runtime.gate, writer, generation, "approval-response")) {
      throw new SupervisorError("WRITER_REQUIRED", "Another writer owns this conversation.");
    }
    if (!runtime.approvals.has(requestId)) {
      throw new SupervisorError("APPROVAL_UNKNOWN", "The approval is no longer pending.");
    }
    runtime.connection!.send({ type: "approval", requestId, decision });
  }

  /**
   * The person answers a pending approval from Naru (AP-D017) whoever writes the conversation: an
   * orchestrator cannot answer approvals, so without this an autonomous agent would wait forever.
   * The runtime ignores a second answer (a person in the TUI may have answered first).
   */
  respondApprovalAsPerson(
    agentSessionId: string,
    requestId: string,
    decision: AgentApprovalDecision,
  ): void {
    const runtime = this.#connected(agentSessionId);
    if (!runtime.approvals.has(requestId)) {
      throw new SupervisorError("APPROVAL_UNKNOWN", "The approval is no longer pending.");
    }
    runtime.connection!.send({ type: "approval", requestId, decision });
  }

  readHistory(agentSessionId: string, cursor: string | null): Promise<HistoryPage> {
    const runtime = this.#connected(agentSessionId);
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.history.delete(requestId);
        reject(new SupervisorError("HISTORY_TIMEOUT", "The runtime did not answer."));
      }, HISTORY_TIMEOUT_MS);
      runtime.history.set(requestId, (page) => {
        clearTimeout(timer);
        if (page === null)
          reject(new SupervisorError("HISTORY_REFUSED", "History is unavailable."));
        else resolve(page);
      });
      runtime.connection!.send({ type: "history", requestId, cursor });
    });
  }

  /**
   * A page of the conversation as the person reads it (AP-D045): forward, the newest page, or the
   * page before one read newest first. A runtime that reads only forward (Codex, or a Claude runner
   * an earlier Naru started) answers `latest` with its first page, and the person's view reads on.
   */
  async readHistoryWindow(agentSessionId: string, read: HistoryRead): Promise<AgentHistoryWindow> {
    const claude = this.#core.getAgentSession(SYSTEM, agentSessionId).runtime === "claude";
    if (read.kind !== "forward" && claude) {
      try {
        const page = await this.readHistory(
          agentSessionId,
          read.kind === "latest" ? LATEST_HISTORY : historyBefore(read.cursor),
        );
        const start = page.nextCursor;
        return {
          items: [...page.items],
          cursor: start,
          nextCursor: null,
          previousCursor: start === null || start === "0" ? null : start,
        };
      } catch (error) {
        const refused = error instanceof SupervisorError && error.code === "HISTORY_REFUSED";
        if (read.kind === "before" || !refused) throw error;
      }
    } else if (read.kind === "before") {
      throw new SupervisorError("HISTORY_REFUSED", "This runtime reads history forward only.");
    }
    const cursor = read.kind === "forward" ? read.cursor : null;
    const page = await this.readHistory(agentSessionId, cursor);
    return { items: [...page.items], cursor, nextCursor: page.nextCursor, previousCursor: null };
  }

  stop(agentSessionId: string): void {
    this.#runtimes.get(agentSessionId)?.connection?.send({ type: "stop" });
  }

  /** OrchestratorInvoker: a wakeup becomes one turn written by the orchestrator. */
  deliver(batch: WakeupBatch): Promise<void> {
    const { writer, generation } = this.writer(batch.orchestrator.id);
    if (writer !== "orchestrator") {
      return Promise.reject(
        new SupervisorError("WRITER_REQUIRED", "A person owns this conversation."),
      );
    }
    this.sendTurn(batch.orchestrator.id, wakeupText(batch), writer, generation);
    return Promise.resolve();
  }

  // RuntimeChannelHandlers -------------------------------------------------------------------------

  authenticate(token: string): string | null {
    return this.#core.authenticateRuntime(token);
  }

  connected(connection: RunnerConnection, hello: Extract<RunnerMessage, { type: "hello" }>): void {
    const runtime = this.#runtime(connection.agentSessionId, hello.runtimeSessionRef);
    runtime.connection = connection;
    if (runtime.disconnectTimer !== null) clearTimeout(runtime.disconnectTimer);
    runtime.disconnectTimer = null;
    if (!hello.started) {
      // A fresh runner process numbers its events from 1 and has nothing in flight.
      runtime.startedHere = true;
      runtime.lastSeq = 0;
      runtime.approvals.clear();
      runtime.children.clear();
      runtime.gate = { ...runtime.gate, turnActive: false };
      this.#showAttention(connection.agentSessionId, runtime);
      let plan: AnyRunnerPlan;
      try {
        plan = this.#planFor(this.#core.getAgentSession(SYSTEM, connection.agentSessionId));
      } catch {
        connection.send({ type: "rejected", code: "RUNTIME_PLAN_UNAVAILABLE" });
        return;
      }
      connection.send({ type: "plan", plan, ackedSeq: runtime.lastSeq });
      this.#announceWriter(runtime);
      return;
    }
    // Reattached after a Naru restart: adopt the runner's live state.
    for (const requestId of hello.pendingApprovals) {
      if (!runtime.approvals.has(requestId)) {
        runtime.approvals.set(requestId, { kind: "permission" });
      }
    }
    this.#showAttention(connection.agentSessionId, runtime);
    if (hello.busy) runtime.gate = { ...runtime.gate, turnActive: true };
    connection.send({ type: "ack", seq: runtime.lastSeq });
    // A live runtime (Codex) fences its own TUI by the writer Naru remembers.
    this.#announceWriter(runtime);
    this.#core.updateAgentRuntimeState(SYSTEM, {
      agentSessionId: connection.agentSessionId,
      ...(hello.runtimeSessionRef === null ? {} : { runtimeSessionRef: hello.runtimeSessionRef }),
      status: hello.busy ? "active" : "idle",
    });
    // Before wakeups: a turn they send now would be cut by the restart; mid-restart they retry.
    this.#refreshIfInherited(connection.agentSessionId, runtime);
    this.#trackWakeups(connection.agentSessionId);
  }

  message(connection: RunnerConnection, message: RunnerMessage): void {
    const runtime = this.#require(connection.agentSessionId);
    if (message.type === "history") {
      runtime.history.get(message.requestId)?.({
        items: message.items,
        nextCursor: message.nextCursor,
      });
      runtime.history.delete(message.requestId);
      return;
    }
    if (message.type === "error") {
      if (message.requestId !== null) {
        runtime.history.get(message.requestId)?.(null);
        runtime.history.delete(message.requestId);
      }
      return;
    }
    if (message.type !== "event") return;
    if (message.seq <= runtime.lastSeq) {
      connection.send({ type: "ack", seq: runtime.lastSeq });
      return;
    }
    runtime.lastSeq = message.seq;
    connection.send({ type: "ack", seq: message.seq });
    this.#apply(connection.agentSessionId, runtime, message.event);
  }

  disconnected(connection: RunnerConnection): void {
    const runtime = this.#runtimes.get(connection.agentSessionId);
    if (runtime?.connection !== connection) return;
    runtime.connection = null;
    // A switch stops the runner on purpose; its outcome is decided by the switch itself.
    if (runtime.gate.phase !== "active") return;
    // A live runner reconnects within its backoff; one that does not has died without saying so.
    runtime.disconnectTimer = setTimeout(() => {
      runtime.disconnectTimer = null;
      if (runtime.connection !== null) return;
      this.#markUnknown(connection.agentSessionId, runtime);
    }, this.#disconnectGraceMs);
    runtime.disconnectTimer.unref();
  }

  /**
   * After a Naru restart (AP-T10): an agent that Naru believes alive but whose runtime has not
   * reached Naru within the grace period is `unknown`, and so are its unfinished runs. A runner that
   * comes back reports its own state instead. Claude's TUI form has no channel; its live Pane counts.
   */
  reconcileAfterStart(isPaneRunning: (paneId: string) => boolean): void {
    const timer = setTimeout(() => {
      for (const agent of this.#core.listLiveManagedAgents(SYSTEM)) {
        const runtime = this.#runtimes.get(agent.id);
        if (runtime?.connection != null) continue;
        // Between runners in a switch or restart (AP-D042): that change decides the outcome.
        if (runtime !== undefined && runtime.gate.phase !== "active") continue;
        if (agent.launchMode === "tui" && agent.runtime === "claude" && agent.paneId !== null) {
          if (isPaneRunning(agent.paneId)) continue;
        }
        this.#markUnknown(agent.id, runtime ?? this.#runtime(agent.id, agent.runtimeSessionRef));
        // It was running when Naru or its Host went down: bring it back (AP-D034).
        this.#relaunchIfDown(this.#core.getAgentSession(SYSTEM, agent.id));
      }
    }, this.#disconnectGraceMs);
    timer.unref();
    this.#startupTimer = timer;
  }

  #markUnknown(agentSessionId: string, runtime: ManagedRuntime): void {
    runtime.approvals.clear();
    runtime.children.clear();
    runtime.gate = { ...runtime.gate, turnActive: false };
    this.#showAttention(agentSessionId, runtime);
    this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "unknown" });
    this.#core.markInterruptedRunsUnknown(
      { actor: SYSTEM, idempotencyKey: randomUUID() },
      { agentSessionId },
    );
  }

  /**
   * Launches an agent that is down on its own (unknown or failed), at most once per cooldown so a
   * runtime that dies right away does not loop. Held, stopped and cleaned-up agents stay as they are.
   */
  #relaunchIfDown(agent: AgentSession): void {
    if (!this.#autoRelaunch || agent.retiredAt || agent.humanHoldSince !== null) return;
    if (agent.status !== "unknown" && agent.status !== "failed") return;
    const now = Date.now();
    if (now - (this.#relaunchedAt.get(agent.id) ?? 0) < RELAUNCH_COOLDOWN_MS) return;
    this.#relaunchedAt.set(agent.id, now);
    void this.launch(agent.id).catch(() => undefined); // a failed launch marks the agent failed
  }

  /**
   * A runner an earlier Naru process started (it reattached after a Naru restart, e.g. an upgrade)
   * still runs that Naru's code and guidance. Between turns, while the orchestrator writes and
   * nothing waits on a person, it starts again on this Naru and resumes the same conversation
   * (AP-D042). Returns whether the restart began.
   */
  #refreshIfInherited(agentSessionId: string, runtime: ManagedRuntime): boolean {
    if (!this.#autoRelaunch || runtime.startedHere || runtime.connection === null) return false;
    if (runtime.gate.writer !== "orchestrator" || runtime.approvals.size > 0) return false;
    const agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
    if (agent.retiredAt || agent.humanHoldSince !== null || agent.launchMode !== "runner") {
      return false;
    }
    return this.#transition(agentSessionId, runtime, { type: "request-restart" });
  }

  /** Releases timers when this Naru process shuts down; runners keep running. */
  close(): void {
    this.#unsubscribeCore();
    if (this.#startupTimer !== null) clearTimeout(this.#startupTimer);
    this.#startupTimer = null;
    for (const runtime of this.#runtimes.values()) {
      if (runtime.disconnectTimer !== null) clearTimeout(runtime.disconnectTimer);
      if (runtime.resumeTimer !== null) clearTimeout(runtime.resumeTimer);
      runtime.disconnectTimer = null;
      runtime.resumeTimer = null;
    }
  }

  #apply(
    agentSessionId: string,
    runtime: ManagedRuntime,
    event: Extract<RunnerMessage, { type: "event" }>["event"],
  ): void {
    switch (event.type) {
      case "conversation-ready":
        if (runtime.gate.phase === "resuming" || runtime.gate.phase === "rolling-back") {
          // The switched-to (or restored) runner reports which conversation it resumed.
          this.#confirmResume(agentSessionId, runtime, event.runtimeSessionRef);
          return;
        }
        runtime.gate = { ...runtime.gate, runtimeSessionRef: event.runtimeSessionRef };
        // Ready, not working: a turn in flight reports itself with `turn-started`.
        this.#core.updateAgentRuntimeState(SYSTEM, {
          agentSessionId,
          runtimeSessionRef: event.runtimeSessionRef,
          status: runtime.gate.turnActive ? "active" : "idle",
        });
        this.#trackWakeups(agentSessionId);
        return;
      case "tool-activity":
        runtime.activity = {
          tool: event.tool,
          target: event.target,
          since: new Date().toISOString(),
        };
        return;
      case "turn-started":
        runtime.turnStartedAt = new Date().toISOString();
        runtime.activity = null;
        this.#transition(agentSessionId, runtime, { type: "turn-started" });
        this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "active" });
        return;
      case "turn-ended":
        runtime.turnStartedAt = null;
        runtime.activity = null;
        this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "idle" });
        // May finish a quiescing switch, which then stops this runner.
        this.#transition(agentSessionId, runtime, { type: "turn-ended" });
        if (this.#refreshIfInherited(agentSessionId, runtime) || runtime.gate.phase === "active") {
          this.#wakeups?.turnCompleted(agentSessionId);
        }
        return;
      case "approval-requested":
        runtime.approvals.set(event.requestId, {
          kind: event.kind,
          ...(event.summary === undefined ? {} : { summary: event.summary }),
          ...(event.sessionAllow === true ? { sessionAllow: true } : {}),
        });
        this.#showAttention(agentSessionId, runtime);
        return;
      case "approval-resolved":
        runtime.approvals.delete(event.requestId);
        this.#showAttention(agentSessionId, runtime);
        return;
      case "exited":
        runtime.connection = null;
        runtime.approvals.clear();
        runtime.children.clear();
        this.#showAttention(agentSessionId, runtime);
        this.#core.endRuntimeLaunch(SYSTEM, agentSessionId);
        // Stopped for a writer switch: the conversation continues in the other form.
        if (runtime.gate.phase !== "active") return;
        this.#wakeups?.unregister(agentSessionId);
        this.#core.updateAgentRuntimeState(SYSTEM, {
          agentSessionId,
          status: event.reason === "stopped" ? "stopped" : "failed",
        });
        return;
      case "child-started":
        if (runtime.children.size < 64)
          runtime.children.set(event.childRef, new Date().toISOString());
        return;
      case "child-ended":
        runtime.children.delete(event.childRef);
        return;
      case "user-prompt":
        // A person typed into the runtime's own TUI: their instruction, recorded verbatim (AP-D002).
        this.#core.recordTuiPrompt(
          { actor: SYSTEM, idempotencyKey: event.promptId ?? randomUUID() },
          { agentSessionId, verbatim: event.text },
        );
        return;
    }
  }

  /**
   * A pending approval shows on the agent's Pane as the existing input-needed state, which also
   * alerts the person's devices; answering it clears both (AP-D017).
   */
  #showAttention(agentSessionId: string, runtime: ManagedRuntime): void {
    try {
      this.#attention?.(agentSessionId, runtime.approvals.size > 0);
    } catch {
      // Display only: the approval itself stays pending in the Agent Panel and Inbox.
    }
  }

  /** Applies one gate command and runs its effects. Returns false when the gate rejected it. */
  #transition(agentSessionId: string, runtime: ManagedRuntime, command: WriterCommand): boolean {
    const transition = reduceWriterGate(runtime.gate, command);
    if (!transition.ok) return false;
    runtime.gate = transition.state;
    for (const effect of transition.effects) this.#effect(agentSessionId, runtime, effect);
    if (runtime.gate.phase === "active" || runtime.gate.phase === "recovery-required") {
      for (const resolve of runtime.switchWaiters.splice(0)) resolve();
    }
    return true;
  }

  #effect(agentSessionId: string, runtime: ManagedRuntime, effect: WriterEffect): void {
    switch (effect.type) {
      case "interrupt-turn":
        runtime.connection?.send({ type: "interrupt" });
        return;
      case "stop-backend":
        void this.#stopBackend(agentSessionId, runtime);
        return;
      case "start-backend":
        void this.#startBackend(agentSessionId, runtime, effect.writer);
        return;
      case "writer-changed":
        this.#announceWriter(runtime);
        this.#core.updateAgentRuntimeState(SYSTEM, {
          agentSessionId,
          conversationWriter: effect.writer,
          launchMode: writerBackend(effect.writer),
          status: "idle",
        });
        return;
      case "recovery-required":
        this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "failed" });
        return;
    }
  }

  async #stopBackend(agentSessionId: string, runtime: ManagedRuntime): Promise<void> {
    this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "starting" });
    try {
      await this.#launcher.stop(agentSessionId);
    } catch {
      // Already gone, or the Host refused: the start that follows decides the outcome.
    }
    this.#transition(agentSessionId, runtime, { type: "backend-stopped" });
  }

  /** Starts the form serving `writer` (the switch target, or the previous one on rollback). */
  async #startBackend(
    agentSessionId: string,
    runtime: ManagedRuntime,
    writer: WriterKind,
  ): Promise<void> {
    const mode = writerBackend(writer);
    try {
      // A failed resume may have left the other form running in the same Pane.
      await this.#launcher.stop(agentSessionId);
      this.#core.updateAgentRuntimeState(SYSTEM, {
        agentSessionId,
        launchMode: mode,
        status: "starting",
      });
      await this.#launcher.launch(agentSessionId);
    } catch {
      this.#confirmResume(agentSessionId, runtime, null);
      return;
    }
    if (mode === "tui") {
      const reported =
        (await this.#launcher.awaitTuiSession?.(agentSessionId, RESUME_TIMEOUT_MS)) ?? null;
      this.#confirmResume(agentSessionId, runtime, reported);
      return;
    }
    // The runner confirms through `conversation-ready`; give up if it never does.
    runtime.resumeTimer = setTimeout(
      () => this.#confirmResume(agentSessionId, runtime, null),
      RESUME_TIMEOUT_MS,
    );
    runtime.resumeTimer.unref();
  }

  #confirmResume(agentSessionId: string, runtime: ManagedRuntime, reported: string | null): void {
    if (runtime.resumeTimer !== null) clearTimeout(runtime.resumeTimer);
    runtime.resumeTimer = null;
    const expected = runtime.gate.runtimeSessionRef;
    if (runtime.gate.phase === "resuming") {
      this.#transition(
        agentSessionId,
        runtime,
        reported === null
          ? { type: "resume-failed" }
          : { type: "resume-confirmed", runtimeSessionRef: reported },
      );
    } else if (runtime.gate.phase === "rolling-back") {
      const restored = reported !== null && (expected === null || reported === expected);
      this.#transition(
        agentSessionId,
        runtime,
        restored ? { type: "previous-restored" } : { type: "restore-failed" },
      );
    }
  }

  #runtime(agentSessionId: string, runtimeSessionRef: string | null): ManagedRuntime {
    let runtime = this.#runtimes.get(agentSessionId);
    if (runtime === undefined) {
      runtime = {
        connection: null,
        lastSeq: 0,
        // The gate lives in memory; the form and human hold persisted in Core survive Naru
        // restarts (AP-D005). Claude's runner and TUI are separate processes (AP-D011).
        gate: initialWriterGate(
          this.#strategy(agentSessionId),
          this.#initialWriter(agentSessionId),
          runtimeSessionRef,
        ),
        approvals: new Map(),
        children: new Map(),
        history: new Map(),
        disconnectTimer: null,
        resumeTimer: null,
        switchWaiters: [],
        turnStartedAt: null,
        startedHere: false,
        activity: null,
      };
      this.#runtimes.set(agentSessionId, runtime);
    }
    return runtime;
  }

  #announceWriter(runtime: ManagedRuntime): void {
    runtime.connection?.send({
      type: "writer",
      writer: runtime.gate.writer,
      generation: runtime.gate.generation,
    });
  }

  /**
   * Managed agents are woken by Naru events once their conversation is reachable (AP-T16):
   * orchestrators by their scope, working agents by what is addressed to them.
   */
  #trackWakeups(agentSessionId: string): void {
    this.#wakeups?.register(agentSessionId);
  }

  /** Codex shares one thread between Chat and the TUI (live); Claude's forms are separate processes. */
  #strategy(agentSessionId: string): "live" | "stop-resume" {
    try {
      return this.#core.getAgentSession(SYSTEM, agentSessionId).runtime === "codex"
        ? "live"
        : "stop-resume";
    } catch {
      return "stop-resume";
    }
  }

  #initialWriter(agentSessionId: string): WriterKind {
    try {
      const agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
      if (agent.launchMode === "tui") return "tui";
      return agent.humanHoldSince === null ? "orchestrator" : "gui";
    } catch {
      return "orchestrator";
    }
  }

  /**
   * The agent's runtime record. After a Naru restart it is rebuilt from Core for an agent that has
   * a Pane (its runner reconnects, or its TUI is still running in the Host).
   */
  #require(agentSessionId: string): ManagedRuntime {
    const runtime = this.#runtimes.get(agentSessionId);
    if (runtime !== undefined) return runtime;
    let agent: AgentSession | null;
    try {
      agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
    } catch {
      agent = null;
    }
    if ((agent?.runtime !== "claude" && agent?.runtime !== "codex") || agent.paneId === null) {
      throw new SupervisorError("RUNTIME_NOT_CONNECTED", "No runtime is managed for this agent.");
    }
    return this.#runtime(agentSessionId, agent.runtimeSessionRef);
  }

  #connected(agentSessionId: string): ManagedRuntime {
    const runtime = this.#require(agentSessionId);
    if (runtime.connection === null) {
      throw new SupervisorError("RUNTIME_NOT_CONNECTED", "The runtime is not connected.");
    }
    return runtime;
  }
}

/** The wakeup turn carries event references only; the orchestrator reads content through tools. */
export function wakeupText(batch: WakeupBatch): string {
  const lines = batch.events.map((event: AgentEvent) => {
    const data = Object.entries(event.data)
      .map(([key, value]) => `${key}=${String(value)}`)
      .join(" ");
    return `- #${event.seq} ${event.type} subject=${event.subjectId} actor=${event.actor.kind}${data === "" ? "" : ` ${data}`}`;
  });
  return [
    "[Naru] New events since your last turn. Read details with the naru tools before acting;",
    "the latest user instruction wins over earlier plans.",
    ...(batch.resent === true
      ? [
          "Naru did not see your last turn end (a restart or a very long turn), so some of these were",
          "sent before: check the current state and do not repeat what you already did.",
        ]
      : []),
    ...lines,
  ].join("\n");
}
