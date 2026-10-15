import type { AgentEvent, AgentEventType, AgentSession } from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore } from "./core.js";

/**
 * Event-driven orchestrator turns (SOURCE_SPEC §5, ARCHITECTURE §3). Naru decides only *when* an
 * orchestrator is woken and with which event references; what to do is the LLM's judgement.
 *
 * Guarantees: one in-flight turn per orchestrator, no wakeups from the orchestrator's own actions,
 * nothing delivered while a human holds it (AP-D005), bounded frequency, and at-least-once delivery
 * driven by a persisted cursor so a Naru restart neither loses nor double-commits a batch.
 */
export interface WakeupBatch {
  readonly orchestrator: AgentSession;
  readonly events: readonly AgentEvent[];
  readonly fromSeq: number;
  readonly toSeq: number;
}

export interface OrchestratorInvoker {
  /** Resolves once the runtime accepted the turn; completion is reported via turnCompleted(). */
  deliver(batch: WakeupBatch): Promise<void>;
}

export interface WakeupOptions {
  readonly maxBatchEvents?: number;
  readonly minIntervalMs?: number;
  readonly maxTurnsPerHour?: number;
  readonly turnTimeoutMs?: number;
  readonly now?: () => number;
  readonly setTimer?: (callback: () => void, delayMs: number) => { cancel(): void };
}

export type WakeupState =
  | { readonly kind: "idle" }
  | { readonly kind: "in-flight"; readonly toSeq: number; readonly since: number }
  | { readonly kind: "held" }
  | { readonly kind: "throttled"; readonly until: number };

/** Event types that reach the global main orchestrator; projects stay with their own orchestrator. */
const MAIN_ORCHESTRATOR_EVENTS: ReadonlySet<AgentEventType> = new Set([
  "instruction.created",
  "handoff.requested",
  "handoff.resolved",
  "intent_contract.approved",
  "agent_session.hold_released",
]);

export class OrchestratorWakeups {
  readonly #core: AgentPlatformCore;
  readonly #invoker: OrchestratorInvoker;
  readonly #maxBatchEvents: number;
  readonly #minIntervalMs: number;
  readonly #maxTurnsPerHour: number;
  readonly #turnTimeoutMs: number;
  readonly #now: () => number;
  readonly #setTimer: NonNullable<WakeupOptions["setTimer"]>;
  readonly #orchestrators = new Map<
    string,
    {
      inFlight: { toSeq: number; since: number } | null;
      deliveries: number[];
      timer: { cancel(): void } | null;
      dirty: boolean;
    }
  >();
  readonly #unsubscribe: () => void;

  constructor(core: AgentPlatformCore, invoker: OrchestratorInvoker, options: WakeupOptions = {}) {
    this.#core = core;
    this.#invoker = invoker;
    this.#maxBatchEvents = options.maxBatchEvents ?? 50;
    this.#minIntervalMs = options.minIntervalMs ?? 5_000;
    this.#maxTurnsPerHour = options.maxTurnsPerHour ?? 60;
    this.#turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60_000;
    this.#now = options.now ?? Date.now;
    this.#setTimer =
      options.setTimer ??
      ((callback, delayMs) => {
        const handle = setTimeout(callback, delayMs);
        handle.unref();
        return { cancel: () => clearTimeout(handle) };
      });
    this.#unsubscribe = core.subscribe(() => {
      for (const id of this.#orchestrators.keys()) this.#kick(id);
    });
  }

  /** Starts tracking an orchestrator; pending events since its persisted cursor are delivered. */
  register(agentSessionId: string): void {
    if (this.#orchestrators.has(agentSessionId)) return;
    this.#orchestrators.set(agentSessionId, {
      inFlight: null,
      deliveries: [],
      timer: null,
      dirty: true,
    });
    this.#kick(agentSessionId);
  }

  unregister(agentSessionId: string): void {
    this.#orchestrators.get(agentSessionId)?.timer?.cancel();
    this.#orchestrators.delete(agentSessionId);
  }

  close(): void {
    this.#unsubscribe();
    for (const id of [...this.#orchestrators.keys()]) this.unregister(id);
  }

  /** The runtime adapter reports that the delivered turn ended (Stop hook, turn/completed, idle). */
  turnCompleted(agentSessionId: string): void {
    const entry = this.#orchestrators.get(agentSessionId);
    if (entry?.inFlight == null) return;
    this.#core.advanceCursor(consumerId(agentSessionId), entry.inFlight.toSeq);
    entry.inFlight = null;
    this.#kick(agentSessionId);
  }

  state(agentSessionId: string): WakeupState {
    const entry = this.#orchestrators.get(agentSessionId);
    if (entry === undefined) return { kind: "idle" };
    if (entry.inFlight !== null) return { kind: "in-flight", ...entry.inFlight };
    const session = this.#session(agentSessionId);
    if (session?.humanHoldSince != null) return { kind: "held" };
    const until = this.#throttledUntil(entry.deliveries);
    return until > this.#now() ? { kind: "throttled", until } : { kind: "idle" };
  }

  #kick(agentSessionId: string): void {
    const entry = this.#orchestrators.get(agentSessionId);
    if (entry === undefined) return;
    entry.dirty = true;
    if (entry.timer !== null) return;
    void this.#tryDeliver(agentSessionId);
  }

  async #tryDeliver(agentSessionId: string): Promise<void> {
    const entry = this.#orchestrators.get(agentSessionId);
    if (entry === undefined || !entry.dirty) return;
    const now = this.#now();
    if (entry.inFlight !== null) {
      // A turn that never reported completion is released so the orchestrator is not stuck forever;
      // its batch is redelivered from the unchanged cursor.
      if (now - entry.inFlight.since < this.#turnTimeoutMs) return;
      entry.inFlight = null;
    }
    const session = this.#session(agentSessionId);
    if (session === null || session.status === "stopped" || session.status === "failed") return;
    if (session.humanHoldSince !== null) return; // accumulate; the release event kicks us again

    const until = this.#throttledUntil(entry.deliveries);
    if (until > now) {
      entry.timer = this.#setTimer(() => {
        entry.timer = null;
        void this.#tryDeliver(agentSessionId);
      }, until - now);
      return;
    }

    entry.dirty = false;
    const consumer = consumerId(agentSessionId);
    const afterSeq = this.#core.getCursor(consumer);
    const scanned = this.#core.readEvents(
      { kind: "system" },
      {
        afterSeq,
        ...(session.projectId === null ? {} : { projectId: session.projectId }),
        limit: this.#maxBatchEvents,
      },
    );
    const events = scanned.filter((event) => relevantTo(session, event));
    const toSeq = scanned.at(-1)?.seq ?? afterSeq;
    if (events.length === 0) {
      // Only self-caused or irrelevant events: skip them without spending a turn.
      if (toSeq > afterSeq) this.#core.advanceCursor(consumer, toSeq);
      if (scanned.length === this.#maxBatchEvents) {
        entry.dirty = true;
        await this.#tryDeliver(agentSessionId);
      }
      return;
    }
    entry.inFlight = { toSeq, since: now };
    entry.deliveries = [...entry.deliveries.filter((at) => now - at < 3_600_000), now];
    try {
      await this.#invoker.deliver({ orchestrator: session, events, fromSeq: afterSeq, toSeq });
    } catch {
      // Not accepted: keep the cursor so the same batch is retried after the interval.
      entry.inFlight = null;
      entry.dirty = true;
      entry.timer = this.#setTimer(() => {
        entry.timer = null;
        void this.#tryDeliver(agentSessionId);
      }, this.#minIntervalMs);
    }
  }

  #throttledUntil(deliveries: readonly number[]): number {
    const now = this.#now();
    const recent = deliveries.filter((at) => now - at < 3_600_000);
    const last = recent.at(-1);
    let until = last === undefined ? 0 : last + this.#minIntervalMs;
    if (recent.length >= this.#maxTurnsPerHour) until = Math.max(until, recent[0]! + 3_600_000);
    return until;
  }

  #session(agentSessionId: string): AgentSession | null {
    try {
      return this.#core.getAgentSession({ kind: "system" }, agentSessionId);
    } catch {
      return null;
    }
  }
}

export function consumerId(agentSessionId: string): string {
  return `orchestrator:${agentSessionId}`;
}

function relevantTo(orchestrator: AgentSession, event: AgentEvent): boolean {
  if (event.actor.kind === "agent" && event.actor.agentSessionId === orchestrator.id) return false;
  if (orchestrator.role !== "main-orchestrator") return true;
  // The main orchestrator summarises across projects; it is not woken by every project detail.
  switch (event.type) {
    case "instruction.created":
      return event.projectId === null;
    case "agent_session.hold_released":
      return event.subjectId === orchestrator.id;
    default:
      return MAIN_ORCHESTRATOR_EVENTS.has(event.type);
  }
}
