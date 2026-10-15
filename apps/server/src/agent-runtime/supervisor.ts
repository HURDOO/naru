import { randomUUID } from "node:crypto";
import type { AgentEvent } from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore } from "../agent-platform/core.js";
import type {
  OrchestratorInvoker,
  OrchestratorWakeups,
  WakeupBatch,
} from "../agent-platform/wakeups.js";
import type { HistoryPage } from "./adapter.js";
import type { RunnerMessage, RunnerPlan } from "./channel-protocol.js";
import type { RunnerConnection, RuntimeChannelHandlers } from "./runtime-channel-server.js";
import {
  authorizeWrite,
  initialWriterGate,
  reduceWriterGate,
  type WriterGateState,
  type WriterKind,
} from "./writer-gate.js";

const SYSTEM = { kind: "system" } as const;
const HISTORY_TIMEOUT_MS = 15_000;

export interface RunnerLauncher {
  launch(input: { readonly agentSessionId: string; readonly token: string }): Promise<void>;
}

export class SupervisorError extends Error {
  constructor(
    readonly code:
      "RUNTIME_NOT_CONNECTED" | "WRITER_REQUIRED" | "APPROVAL_UNKNOWN" | "HISTORY_TIMEOUT",
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
  readonly approvals: Map<string, string>;
  readonly history: Map<string, (page: HistoryPage | null) => void>;
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
  readonly #planFor: (agentSessionId: string, resumeRef: string | null) => RunnerPlan;
  readonly #runtimes = new Map<string, ManagedRuntime>();
  readonly #plans = new Map<string, RunnerPlan>();
  #wakeups: OrchestratorWakeups | null = null;

  constructor(options: {
    readonly core: AgentPlatformCore;
    readonly launcher: RunnerLauncher;
    readonly planFor: (agentSessionId: string, resumeRef: string | null) => RunnerPlan;
  }) {
    this.#core = options.core;
    this.#launcher = options.launcher;
    this.#planFor = options.planFor;
  }

  useWakeups(wakeups: OrchestratorWakeups): void {
    this.#wakeups = wakeups;
  }

  async launch(
    agentSessionId: string,
    options: { readonly resumeRef?: string } = {},
  ): Promise<void> {
    const plan = this.#planFor(agentSessionId, options.resumeRef ?? null);
    const token = this.#core.issueRuntimeLaunchToken(SYSTEM, agentSessionId);
    this.#plans.set(agentSessionId, plan);
    this.#runtime(agentSessionId, options.resumeRef ?? null);
    this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "starting" });
    await this.#launcher.launch({ agentSessionId, token });
  }

  writer(agentSessionId: string): { readonly writer: WriterKind; readonly generation: number } {
    const gate = this.#require(agentSessionId).gate;
    return { writer: gate.writer, generation: gate.generation };
  }

  /** Moves the conversation writer (e.g. a person taking over from the orchestrator in Chat). */
  switchWriter(agentSessionId: string, to: WriterKind, interrupt: boolean): WriterGateState {
    const runtime = this.#require(agentSessionId);
    const transition = reduceWriterGate(runtime.gate, { type: "request-switch", to, interrupt });
    if (!transition.ok) throw new SupervisorError("WRITER_REQUIRED", transition.code);
    runtime.gate = transition.state;
    for (const effect of transition.effects) {
      if (effect.type === "interrupt-turn") runtime.connection?.send({ type: "interrupt" });
    }
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

  pendingApprovals(agentSessionId: string): { requestId: string; kind: string }[] {
    return [...(this.#runtimes.get(agentSessionId)?.approvals ?? new Map<string, string>())].map(
      ([requestId, kind]) => ({ requestId, kind }),
    );
  }

  respondApproval(
    agentSessionId: string,
    requestId: string,
    decision: "approve" | "deny",
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
          reject(new SupervisorError("HISTORY_TIMEOUT", "History is unavailable."));
        else resolve(page);
      });
      runtime.connection!.send({ type: "history", requestId, cursor });
    });
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
    if (!hello.started) {
      const plan = this.#plans.get(connection.agentSessionId);
      if (plan === undefined) {
        // Naru restarted before the runner started; it cannot be given a plan safely.
        connection.send({ type: "rejected", code: "RUNTIME_PLAN_UNAVAILABLE" });
        return;
      }
      connection.send({ type: "plan", plan, ackedSeq: runtime.lastSeq });
      return;
    }
    // Reattached after a Naru restart: adopt the runner's live state.
    for (const requestId of hello.pendingApprovals) {
      if (!runtime.approvals.has(requestId)) runtime.approvals.set(requestId, "permission");
    }
    if (hello.busy) runtime.gate = { ...runtime.gate, turnActive: true };
    connection.send({ type: "ack", seq: runtime.lastSeq });
    this.#core.updateAgentRuntimeState(SYSTEM, {
      agentSessionId: connection.agentSessionId,
      ...(hello.runtimeSessionRef === null ? {} : { runtimeSessionRef: hello.runtimeSessionRef }),
      status: hello.busy ? "active" : "idle",
    });
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
    if (runtime?.connection === connection) runtime.connection = null;
  }

  #apply(
    agentSessionId: string,
    runtime: ManagedRuntime,
    event: Extract<RunnerMessage, { type: "event" }>["event"],
  ): void {
    switch (event.type) {
      case "conversation-ready":
        runtime.gate = { ...runtime.gate, runtimeSessionRef: event.runtimeSessionRef };
        this.#core.updateAgentRuntimeState(SYSTEM, {
          agentSessionId,
          runtimeSessionRef: event.runtimeSessionRef,
          status: "active",
        });
        return;
      case "turn-started":
        runtime.gate = this.#reduce(runtime.gate, { type: "turn-started" });
        this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "active" });
        return;
      case "turn-ended":
        runtime.gate = this.#reduce(runtime.gate, { type: "turn-ended" });
        this.#core.updateAgentRuntimeState(SYSTEM, { agentSessionId, status: "idle" });
        this.#wakeups?.turnCompleted(agentSessionId);
        return;
      case "approval-requested":
        runtime.approvals.set(event.requestId, event.kind);
        return;
      case "approval-resolved":
        runtime.approvals.delete(event.requestId);
        return;
      case "exited":
        runtime.connection = null;
        runtime.approvals.clear();
        this.#core.updateAgentRuntimeState(SYSTEM, {
          agentSessionId,
          status: event.reason === "stopped" ? "stopped" : "failed",
        });
        this.#core.endRuntimeLaunch(SYSTEM, agentSessionId);
        this.#plans.delete(agentSessionId);
        return;
      case "child-started":
      case "child-ended":
      case "user-prompt":
        return;
    }
  }

  /** Turn observations only move the gate's turn state (and finish a quiescing switch). */
  #reduce(
    state: WriterGateState,
    command: Parameters<typeof reduceWriterGate>[1],
  ): WriterGateState {
    const transition = reduceWriterGate(state, command);
    return transition.ok ? transition.state : state;
  }

  #runtime(agentSessionId: string, runtimeSessionRef: string | null): ManagedRuntime {
    let runtime = this.#runtimes.get(agentSessionId);
    if (runtime === undefined) {
      runtime = {
        connection: null,
        lastSeq: 0,
        // The gate lives in memory; a human hold persisted in Core survives Naru restarts (AP-D005).
        gate: initialWriterGate(
          "live",
          this.#heldByHuman(agentSessionId) ? "gui" : "orchestrator",
          runtimeSessionRef,
        ),
        approvals: new Map(),
        history: new Map(),
      };
      this.#runtimes.set(agentSessionId, runtime);
    }
    return runtime;
  }

  #heldByHuman(agentSessionId: string): boolean {
    try {
      return this.#core.getAgentSession(SYSTEM, agentSessionId).humanHoldSince !== null;
    } catch {
      return false;
    }
  }

  #require(agentSessionId: string): ManagedRuntime {
    const runtime = this.#runtimes.get(agentSessionId);
    if (runtime === undefined) {
      throw new SupervisorError("RUNTIME_NOT_CONNECTED", "No runtime is managed for this agent.");
    }
    return runtime;
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
    ...lines,
  ].join("\n");
}
