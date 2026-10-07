import type { PaneActivityState } from "@naru/contracts";
import type { NaruRepository, PaneActivityChange } from "./database.js";
import type { ClaudeActivityEvent } from "./claude-activity-events.js";

/** A Claude hook is observation only; the repository's current runtime remains authoritative. */
export class ClaudeActivitySemantics {
  readonly #repository: NaruRepository;
  readonly #paneId: string;
  readonly #runtimeId: string;
  readonly #emitActivity: (change: PaneActivityChange) => void;
  #sessionId: string | null = null;
  #activeTurn = false;
  #stopping = false;
  #recoverActiveTurn: boolean;

  constructor(options: {
    repository: NaruRepository;
    paneId: string;
    runtimeId: string;
    emitActivity: (change: PaneActivityChange) => void;
    recoverActiveTurn?: boolean;
  }) {
    this.#repository = options.repository;
    this.#paneId = options.paneId;
    this.#runtimeId = options.runtimeId;
    this.#emitActivity = options.emitActivity;
    this.#recoverActiveTurn = options.recoverActiveTurn ?? false;
    if (this.#recoverActiveTurn) {
      const current = this.#state();
      this.#activeTurn = current === "running" || current === "interaction-required";
    }
  }

  accept(event: ClaudeActivityEvent): void {
    if (this.#stopping) return;
    if (event.type === "session-start") {
      this.#sessionId = event.sessionId;
      this.#activeTurn = false;
      this.#recoverActiveTurn = false;
      this.#transition("idle");
      return;
    }
    if (this.#sessionId === null && this.#recoverActiveTurn) {
      // After an app restart the Host runtime survives, while hook subprocesses do not replay
      // SessionStart. Adopt only the first event from this already-fenced runtime.
      this.#sessionId = event.sessionId;
      this.#recoverActiveTurn = false;
    }
    if (event.sessionId !== this.#sessionId) return;
    switch (event.type) {
      case "turn-start":
        this.#activeTurn = true;
        this.#transition("running");
        return;
      case "interaction-required":
        if (this.#activeTurn) this.#transition("interaction-required");
        return;
      case "turn-running":
        if (this.#activeTurn) this.#transition("running");
        return;
      case "turn-completed":
        if (!this.#activeTurn) return;
        this.#activeTurn = false;
        this.#transition("completed");
        return;
      case "turn-failed":
        if (!this.#activeTurn) return;
        this.#activeTurn = false;
        this.#transition("failed");
        return;
      case "session-end":
        this.#activeTurn = false;
        if (this.#state() === "running" || this.#state() === "interaction-required") {
          this.#transition("idle");
        }
        this.#sessionId = null;
        return;
    }
  }

  observeExit(exitCode: number | null): void {
    if (this.#stopping) return;
    if (this.#activeTurn || exitCode !== 0) this.#transition("failed");
    this.#activeTurn = false;
  }

  markStopping(): void {
    this.#stopping = true;
  }

  cancelStopping(): void {
    this.#stopping = false;
  }

  #state(): PaneActivityState | null {
    return this.#repository.getPaneContext(this.#paneId)?.pane.activity.state ?? null;
  }

  #transition(state: PaneActivityState): void {
    const pane = this.#repository.getPaneContext(this.#paneId)?.pane;
    if (pane?.kind !== "claude") return;
    const change = this.#repository.setPaneActivityForRuntime(this.#paneId, this.#runtimeId, state);
    if (change !== null) this.#emitActivity(change);
  }
}
