import type { PaneActivityState } from "@naru/contracts";
import type { NaruRepository, PaneActivityChange } from "../../database.js";
import { CodexSessionTracker } from "../../codex-session-tracker.js";
import type { CodexHookEvent, CodexInteractionSnapshot, CodexSessionHookSource } from "./events.js";

const CODEX_INTERRUPT_EXIT_WINDOW_MS = 2_000;

export type CodexSessionIdentitySource = CodexSessionHookSource | "status" | "exit-hint" | "relay";
export type CodexSessionIdentityChange =
  | {
      readonly sessionId: string;
      readonly resumable: boolean;
      readonly source: CodexSessionIdentitySource;
    }
  | {
      readonly sessionId: null;
      readonly resumable: false;
      readonly source: "transition";
    };

export interface CodexRuntimeSemanticsOptions {
  readonly repository: NaruRepository;
  readonly paneId: string;
  readonly runtimeId: string;
  readonly now?: () => number;
  readonly recoverActiveTurn?: boolean;
  readonly emitActivity: (change: PaneActivityChange) => void;
  readonly onSession?: (event: CodexSessionIdentityChange) => void;
  readonly onActivity?: (state: PaneActivityState) => void;
}

/**
 * Naru-owned Codex semantic state. It never owns a PTY, attachment, control
 * generation, Host lifecycle, or raw terminal persistence.
 */
export class CodexRuntimeSemantics {
  readonly #repository: NaruRepository;
  readonly #paneId: string;
  readonly #runtimeId: string;
  readonly #now: () => number;
  readonly #recoverActiveTurn: boolean;
  readonly #emitActivity: (change: PaneActivityChange) => void;
  readonly #onSession: CodexRuntimeSemanticsOptions["onSession"];
  readonly #onActivity: CodexRuntimeSemanticsOptions["onActivity"];
  readonly #tracker: CodexSessionTracker;
  #sessionId: string | null;
  #sessionResumable: boolean;
  #activeTurnId: string | null = null;
  #lastCompletedTurnId: string | null = null;
  #lastCanceledTurnId: string | null = null;
  #interruptRequestedAt: number | null = null;
  #interactionStreamId: string | null = null;
  #interactionSequence = -1;
  #interactionPending = 0;
  #stopping = false;

  constructor(options: CodexRuntimeSemanticsOptions) {
    this.#repository = options.repository;
    this.#paneId = options.paneId;
    this.#runtimeId = options.runtimeId;
    this.#now = options.now ?? Date.now;
    this.#recoverActiveTurn = options.recoverActiveTurn ?? false;
    this.#emitActivity = options.emitActivity;
    this.#onSession = options.onSession;
    this.#onActivity = options.onActivity;
    this.#tracker = new CodexSessionTracker({ now: this.#now });
    const pane = this.#repository.getPaneContext(this.#paneId)?.pane;
    this.#sessionId = pane?.codexSessionId ?? null;
    this.#sessionResumable = pane?.codexSessionResumable ?? false;
  }

  get sessionId(): string | null {
    return this.#sessionId;
  }

  get sessionResumable(): boolean {
    return this.#sessionResumable;
  }

  observeInput(data: string): void {
    if (this.#interactionStreamId !== null) return;
    const interruptedTurn =
      this.#activeTurnId !== null && isCodexInterruptInput(data) ? this.#activeTurnId : null;
    if (this.#tracker.observeInput(data) && this.#sessionId !== null) {
      if (this.#repository.setCodexSessionForRuntime(this.#paneId, this.#runtimeId, null, false)) {
        this.#sessionId = null;
        this.#sessionResumable = false;
        this.#onSession?.({ sessionId: null, resumable: false, source: "transition" });
      }
    }
    if (interruptedTurn !== null && this.#activeTurnId === interruptedTurn) {
      this.#lastCanceledTurnId = interruptedTurn;
      this.#activeTurnId = null;
      this.#interruptRequestedAt = this.#now();
      this.#transition("canceled");
    }
  }

  observeOutput(data: string, currentScreen?: () => string): void {
    if (this.#interactionStreamId !== null) return;
    const sessionId = this.#tracker.observeOutput(data, currentScreen);
    if (sessionId !== null) this.#setSession(sessionId, false, "status");
  }

  observeExit(exitCode: number | null): void {
    this.#interactionPending = 0;
    const sessionId = this.#interactionStreamId === null ? this.#tracker.observeExit() : null;
    if (sessionId !== null) this.#setSession(sessionId, true, "exit-hint");
    const latest = this.#repository.getPaneContext(this.#paneId)?.pane.activity.state;
    const recentInterrupt =
      latest === "canceled" &&
      this.#lastCanceledTurnId !== null &&
      this.#interruptRequestedAt !== null &&
      this.#now() - this.#interruptRequestedAt <= CODEX_INTERRUPT_EXIT_WINDOW_MS;
    if (this.#stopping) this.#transition("server-stopped");
    else if (
      !recentInterrupt &&
      (exitCode !== 0 || latest === "running" || latest === "interaction-required")
    ) {
      this.#transition("failed");
    }
  }

  acceptHook(event: CodexHookEvent): void {
    if (this.#stopping) return;
    // The relay sees actual app-server requests and resolutions. Hook ordering
    // is insufficient to settle a pending approval or nonblocking question.
    if (this.#interactionStreamId !== null) return;
    if (event.type === "session-start") {
      this.#setSession(event.sessionId, true, event.source);
      this.#activeTurnId = null;
      this.#lastCompletedTurnId = null;
      this.#lastCanceledTurnId = null;
      this.#interruptRequestedAt = null;
      this.#transition("idle");
      return;
    }
    if (event.sessionId !== this.#sessionId) return;
    switch (event.type) {
      case "turn-start":
        if (
          event.turnId === this.#lastCompletedTurnId ||
          event.turnId === this.#lastCanceledTurnId
        ) {
          return;
        }
        this.#activeTurnId = event.turnId;
        this.#interruptRequestedAt = null;
        this.#transition("running");
        return;
      case "interaction-required":
        if (this.#matchesActiveTurn(event.turnId)) this.#transition("interaction-required");
        return;
      case "turn-running":
        if (this.#matchesActiveTurn(event.turnId)) this.#transition("running");
        return;
      case "turn-completed":
        if (!this.#matchesActiveTurn(event.turnId)) return;
        this.#activeTurnId = null;
        this.#lastCompletedTurnId = event.turnId;
        this.#interruptRequestedAt = null;
        this.#transition("completed");
        return;
    }
  }

  acceptInteraction(snapshot: CodexInteractionSnapshot): boolean {
    if (this.#stopping) return false;
    if (this.#interactionStreamId !== null && this.#interactionStreamId !== snapshot.streamId) {
      return false;
    }
    if (snapshot.sequence <= this.#interactionSequence) return true;
    this.#interactionStreamId = snapshot.streamId;
    this.#interactionSequence = snapshot.sequence;
    this.#interactionPending = snapshot.pending.length;

    if (snapshot.identity === "cleared") {
      this.#clearSession();
      this.#activeTurnId = null;
      this.#lastCompletedTurnId = null;
      this.#lastCanceledTurnId = null;
    } else if (snapshot.sessionId !== null) {
      if (snapshot.sessionId !== this.#sessionId) {
        this.#lastCompletedTurnId = null;
        this.#lastCanceledTurnId = null;
      }
      this.#setSession(snapshot.sessionId, true, "relay");
    }

    const phase = snapshot.phase;
    if (phase === "running") {
      this.#activeTurnId = snapshot.turnId;
      this.#interruptRequestedAt = null;
    } else {
      this.#activeTurnId = null;
      if (phase === "completed") this.#lastCompletedTurnId = snapshot.turnId;
      if (phase === "canceled") {
        this.#lastCanceledTurnId = snapshot.turnId;
        this.#interruptRequestedAt = this.#now();
      }
    }
    this.#transition(phase);
    return true;
  }

  markStopping(): void {
    this.#stopping = true;
  }

  cancelStopping(): void {
    this.#stopping = false;
  }

  #matchesActiveTurn(turnId: string): boolean {
    if (this.#activeTurnId === turnId) return true;
    if (
      this.#activeTurnId !== null ||
      this.#lastCompletedTurnId === turnId ||
      this.#lastCanceledTurnId === turnId ||
      !this.#recoverActiveTurn
    ) {
      return false;
    }
    // Naru can restart while the Host runtime continues. A current-runtime,
    // current-session hook reconstructs the in-memory turn fence it lost.
    this.#activeTurnId = turnId;
    return true;
  }

  #setSession(sessionId: string, resumable: boolean, source: CodexSessionIdentitySource): void {
    if (this.#sessionId === sessionId && (this.#sessionResumable || !resumable)) return;
    if (
      !this.#repository.setCodexSessionForRuntime(
        this.#paneId,
        this.#runtimeId,
        sessionId,
        resumable,
      )
    ) {
      return;
    }
    this.#sessionId = sessionId;
    this.#sessionResumable = resumable;
    this.#onSession?.({ sessionId, resumable, source });
  }

  #clearSession(): void {
    if (this.#sessionId === null) return;
    if (!this.#repository.setCodexSessionForRuntime(this.#paneId, this.#runtimeId, null, false)) {
      return;
    }
    this.#sessionId = null;
    this.#sessionResumable = false;
    this.#onSession?.({ sessionId: null, resumable: false, source: "transition" });
  }

  #transition(state: PaneActivityState): void {
    const projected =
      this.#interactionPending > 0 &&
      state !== "failed" &&
      state !== "server-stopped" &&
      state !== "canceled"
        ? "interaction-required"
        : state;
    const change = this.#repository.setPaneActivityForRuntime(
      this.#paneId,
      this.#runtimeId,
      projected,
    );
    if (change === null) return;
    this.#emitActivity(change);
    this.#onActivity?.(projected);
  }
}

function isCodexInterruptInput(data: string): boolean {
  return data === "\u0003" || data === "\u001b";
}
