import type { AgentPlatformStore } from "../agent-platform/store.js";

export type HoldReturnReason = "disconnect-timeout" | "idle-timeout";

/** How Naru hands a held agent or process back (the same path as an explicit release). */
export interface HoldReturn {
  agent(agentSessionId: string, reason: HoldReturnReason): Promise<void>;
  process(processId: string, reason: HoldReturnReason): Promise<void>;
}

/**
 * Returns a person's hold (AP-D005) when they leave: no controller device connected for
 * `disconnectMs`, or no human input to the held agent or process for `idleMs`. Both values are
 * operating settings decided last (AP-D007). Human input is noted by Pane or subject, never stored.
 */
export class HoldMonitor {
  readonly #store: AgentPlatformStore;
  readonly #humanConnected: () => boolean;
  readonly #release: HoldReturn;
  readonly #idleMs: number;
  readonly #disconnectMs: number;
  readonly #now: () => number;
  readonly #lastInput = new Map<string, number>();
  #disconnectedSince: number | null = null;
  #timer: NodeJS.Timeout | null = null;
  #ticking = false;

  constructor(options: {
    readonly store: AgentPlatformStore;
    readonly humanConnected: () => boolean;
    readonly release: HoldReturn;
    readonly idleMs: number;
    readonly disconnectMs: number;
    readonly now?: () => number;
  }) {
    this.#store = options.store;
    this.#humanConnected = options.humanConnected;
    this.#release = options.release;
    this.#idleMs = options.idleMs;
    this.#disconnectMs = options.disconnectMs;
    this.#now = options.now ?? Date.now;
  }

  start(intervalMs = 15_000): void {
    if (this.#timer !== null) return;
    this.#timer = setInterval(() => void this.tick(), intervalMs);
    this.#timer.unref();
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** A person typed into a Pane (terminal input) or sent a Chat turn to an agent. */
  noteHumanInput(target: { readonly paneId: string } | { readonly agentSessionId: string }): void {
    const now = this.#now();
    if ("agentSessionId" in target) {
      this.#lastInput.set(target.agentSessionId, now);
      return;
    }
    const process = this.#store.findSharedProcessByPane(target.paneId);
    if (process !== null) this.#lastInput.set(process.id, now);
    const agent = this.#store.findAgentSessionByPane(target.paneId);
    if (agent !== null) this.#lastInput.set(agent.id, now);
  }

  async tick(): Promise<void> {
    if (this.#ticking) return;
    this.#ticking = true;
    try {
      const now = this.#now();
      if (this.#humanConnected()) this.#disconnectedSince = null;
      else this.#disconnectedSince ??= now;
      for (const hold of this.#store.listHumanHolds()) {
        const heldAt = Date.parse(hold.heldSince);
        const lastActive = Math.max(heldAt, this.#lastInput.get(hold.id) ?? 0);
        const reason: HoldReturnReason | null =
          this.#disconnectedSince !== null && now - this.#disconnectedSince >= this.#disconnectMs
            ? "disconnect-timeout"
            : now - lastActive >= this.#idleMs
              ? "idle-timeout"
              : null;
        if (reason === null) continue;
        this.#lastInput.delete(hold.id);
        try {
          if (hold.kind === "agent") await this.#release.agent(hold.id, reason);
          else await this.#release.process(hold.id, reason);
        } catch {
          // Retried on the next tick while the hold remains.
        }
      }
    } finally {
      this.#ticking = false;
    }
  }
}
