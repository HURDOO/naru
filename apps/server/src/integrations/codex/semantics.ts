import type { PaneActivityState } from "@naru/contracts";
import type { NaruRepository, PaneActivityChange } from "../../database.js";
import { CodexSessionTracker } from "../../codex-session-tracker.js";
import type { CodexHookEvent, CodexSessionHookSource } from "./events.js";

const CODEX_INTERRUPT_EXIT_WINDOW_MS = 2_000;

export type CodexSessionIdentitySource = CodexSessionHookSource | "status" | "exit-hint";
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
    const sessionId = this.#tracker.observeOutput(data, currentScreen);
    if (sessionId !== null) this.#setSession(sessionId, false, "status");
  }

  observeExit(exitCode: number | null): void {
    const sessionId = this.#tracker.observeExit();
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

  #transition(state: PaneActivityState): void {
    const change = this.#repository.setPaneActivityForRuntime(this.#paneId, this.#runtimeId, state);
    if (change === null) return;
    this.#emitActivity(change);
    this.#onActivity?.(state);
  }
}

function isCodexInterruptInput(data: string): boolean {
  return data === "\u0003" || data === "\u001b";
}
