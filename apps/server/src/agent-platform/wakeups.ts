import type { AgentEvent, AgentEventType, AgentSession } from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore } from "./core.js";

/**
 * Event-driven agent turns (SOURCE_SPEC §5, ARCHITECTURE §3). Naru decides only *when* an agent is
 * woken and with which event references; what to do is the LLM's judgement. Orchestrators follow
 * their scope; working agents only what is addressed to them (`eventConcernsAgent`).
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
  /**
   * Some of these events were sent before and the turn's end was never seen (a restart, or a turn
   * past the timeout; AP-D037): the agent may have acted on them already.
   */
  readonly resent?: boolean;
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
    const events = scanned.filter((event) => relevantTo(session, event, this.#core));
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
    // Delivery stays at-least-once; a batch sent again after a restart says so.
    const sent = this.#core.getCursor(sentId(agentSessionId));
    const resent = events.some((event) => event.seq <= sent);
    try {
      await this.#invoker.deliver({
        orchestrator: session,
        events,
        fromSeq: afterSeq,
        toSeq,
        ...(resent ? { resent } : {}),
      });
      this.#core.advanceCursor(sentId(agentSessionId), toSeq);
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

/** How far events were sent to the agent, whether or not its turn was seen to end. */
function sentId(agentSessionId: string): string {
  return `orchestrator-sent:${agentSessionId}`;
}

/** Runtime liveness states worth a turn; routine active/idle churn is not. */
const NOTABLE_AGENT_STATES = new Set<unknown>(["failed", "unknown", "stopped"]);

/**
 * What a project orchestrator reads on its next turn but is not woken for: progress notes,
 * published artifacts, other agents' registrations and processes starting or ending normally. Each of these used to
 * cost a turn and a chat line ("nothing to act on"); the step that matters follows as its own event
 * (the task moving to review, the run finishing, a process failing).
 */
const INFORMATIONAL_EVENTS: ReadonlySet<AgentEventType> = new Set([
  "run.progress",
  "artifact.published",
  "shared_process.started",
  // The person closing or reopening a job (AP-D036); a reopening's instruction wakes on its own.
  "job.completed",
  "job.reopened",
]);
const NOTABLE_PROCESS_STATES = new Set<unknown>(["failed", "unknown"]);

function retired(core: AgentPlatformCore, agentSessionId: string): boolean {
  try {
    return Boolean(core.getAgentSession({ kind: "system" }, agentSessionId).retiredAt);
  } catch {
    return false;
  }
}

/**
 * Who wakes for what (AP-D037): every agent only for its own scope. A project orchestrator follows
 * its own project, never the person's global goals or another project; the main orchestrator follows
 * what is addressed to it and the project orchestrators it looks after; a working agent only what
 * is addressed to it.
 */
function relevantTo(
  orchestrator: AgentSession,
  event: AgentEvent,
  core: AgentPlatformCore,
): boolean {
  if (event.actor.kind === "agent" && event.actor.agentSessionId === orchestrator.id) return false;
  // A working agent wakes only for what is addressed to it (delegated work, its task, its handoff).
  if (orchestrator.role !== "main-orchestrator" && orchestrator.role !== "project-orchestrator") {
    return core.eventConcernsAgent(event, orchestrator.id);
  }
  // Runtime state reports (system) follow every turn, including the orchestrator's own; waking on
  // them would loop. Only another agent failing, stopping or going silent is worth a turn.
  if (event.type === "agent_session.updated") {
    // The person cleaning an agent up, or bringing it back, is not something to act on; neither is
    // what a cleaned-up agent's runtime reports as it ends.
    if (event.data.retired !== undefined || retired(core, event.subjectId)) return false;
    if (event.subjectId === orchestrator.id || !NOTABLE_AGENT_STATES.has(event.data.status)) {
      return false;
    }
    // Workers are their project orchestrator's; project orchestrators are the main one's.
    return orchestrator.role === "main-orchestrator"
      ? roleOf(core, event.subjectId) === "project-orchestrator"
      : event.projectId === orchestrator.projectId && leads(core, orchestrator);
  }
  if (orchestrator.role === "project-orchestrator") {
    // Its own project only: the person's global goals reach it through the main orchestrator.
    if (event.projectId !== orchestrator.projectId) return false;
    // Its own registration is its first turn: it reads the work waiting for it.
    if (event.type === "agent_session.registered") return event.subjectId === orchestrator.id;
    // A second orchestrator of the project (an older one came back, or the person started one)
    // hears only what is addressed to it; the project's events go to its lead.
    if (!leads(core, orchestrator)) return core.eventConcernsAgent(event, orchestrator.id);
    // Instructions to it or its project; words to another agent are that agent's (it reads them).
    if (event.type === "instruction.created")
      return core.eventConcernsAgent(event, orchestrator.id);
    if (INFORMATIONAL_EVENTS.has(event.type)) return false;
    if (event.type === "shared_process.updated")
      return NOTABLE_PROCESS_STATES.has(event.data.status);
    return true;
  }
  // The main orchestrator: what is addressed to it, not every project detail or question.
  switch (event.type) {
    case "instruction.created":
    case "handoff.resolved":
    case "handoff.cancelled":
      return core.eventConcernsAgent(event, orchestrator.id);
    case "agent_session.hold_released":
      return event.subjectId === orchestrator.id;
    default:
      return false;
  }
}

/** Whether a project orchestrator is the one its project's events go to (AP-D038). */
function leads(core: AgentPlatformCore, orchestrator: AgentSession): boolean {
  if (orchestrator.projectId === null) return true;
  const lead = core.leadProjectOrchestrator(orchestrator.projectId);
  return lead === null || lead.id === orchestrator.id;
}

function roleOf(core: AgentPlatformCore, agentSessionId: string): AgentSession["role"] | null {
  try {
    return core.getAgentSession({ kind: "system" }, agentSessionId).role;
  } catch {
    return null;
  }
}
