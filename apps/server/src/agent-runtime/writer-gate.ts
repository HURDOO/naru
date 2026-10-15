/**
 * Single conversation writer per agent session (INV-05, AP-D005 third layer, SOURCE_SPEC §7.2).
 *
 * No runtime arbitrates concurrent writers (V01, V03, V12), so Naru owns this gate. It is a pure
 * reducer: commands and runtime observations produce a new state plus effects for the adapter to
 * run. Display mode is not writer ownership; only this gate decides who may start a turn.
 *
 * Strategies:
 * - `live`: GUI and TUI share one backend (Codex app-server relay, OpenCode serve+attach). A switch
 *   waits for the turn to end (or interrupts it on request) and then moves the writer.
 * - `stop-resume`: separate processes (Claude SDK runner vs TUI). A switch between them also stops
 *   the current backend and resumes the same conversation in the target; failure rolls back.
 *   Orchestrator and GUI share the runner, so a switch between those two is handed over live.
 */
export type WriterKind = "orchestrator" | "gui" | "tui" | "none";
export type SwitchStrategy = "live" | "stop-resume";

export type WriterPhase =
  "active" | "quiescing" | "stopping" | "resuming" | "rolling-back" | "recovery-required";

export interface WriterGateState {
  readonly strategy: SwitchStrategy;
  readonly writer: WriterKind;
  /** Increments on every ownership change; stale writers are fenced by it. */
  readonly generation: number;
  readonly phase: WriterPhase;
  readonly target: WriterKind | null;
  readonly turnActive: boolean;
  readonly runtimeSessionRef: string | null;
}

export type WriteKind = "turn" | "approval-response" | "interrupt";

export type WriterCommand =
  | { readonly type: "request-switch"; readonly to: WriterKind; readonly interrupt: boolean }
  | { readonly type: "cancel-switch" }
  | { readonly type: "turn-started" }
  | { readonly type: "turn-ended" }
  | { readonly type: "backend-stopped" }
  | { readonly type: "resume-confirmed"; readonly runtimeSessionRef: string }
  | { readonly type: "resume-failed" }
  | { readonly type: "previous-restored" }
  | { readonly type: "restore-failed" };

export type WriterEffect =
  | { readonly type: "interrupt-turn" }
  | { readonly type: "stop-backend"; readonly writer: WriterKind }
  | {
      readonly type: "start-backend";
      readonly writer: WriterKind;
      readonly runtimeSessionRef: string | null;
    }
  | { readonly type: "writer-changed"; readonly writer: WriterKind; readonly generation: number }
  | { readonly type: "recovery-required" };

export type WriterTransition =
  | {
      readonly ok: true;
      readonly state: WriterGateState;
      readonly effects: readonly WriterEffect[];
    }
  | { readonly ok: false; readonly code: WriterRejection; readonly state: WriterGateState };

export type WriterRejection =
  "SWITCH_IN_PROGRESS" | "NO_SWITCH" | "UNEXPECTED_OBSERVATION" | "RECOVERY_REQUIRED";

export function initialWriterGate(
  strategy: SwitchStrategy,
  writer: WriterKind,
  runtimeSessionRef: string | null,
): WriterGateState {
  return {
    strategy,
    writer,
    generation: 1,
    phase: "active",
    target: null,
    turnActive: false,
    runtimeSessionRef,
  };
}

/**
 * May `writer` at `generation` perform `kind` now? Approval responses and interrupts for the turn in
 * flight stay with the current writer while a switch quiesces; new turns never start mid-switch.
 */
export function authorizeWrite(
  state: WriterGateState,
  writer: WriterKind,
  generation: number,
  kind: WriteKind,
): boolean {
  if (writer === "none" || writer !== state.writer || generation !== state.generation) return false;
  if (state.phase === "active") return true;
  return state.phase === "quiescing" && kind !== "turn";
}

export function reduceWriterGate(state: WriterGateState, command: WriterCommand): WriterTransition {
  if (state.phase === "recovery-required" && command.type !== "previous-restored") {
    return reject("RECOVERY_REQUIRED", state);
  }
  switch (command.type) {
    case "request-switch": {
      if (state.phase !== "active") return reject("SWITCH_IN_PROGRESS", state);
      if (command.to === state.writer) return accept(state, []);
      const quiescing: WriterGateState = { ...state, phase: "quiescing", target: command.to };
      if (!state.turnActive) return afterQuiesced(quiescing);
      return accept(quiescing, command.interrupt ? [{ type: "interrupt-turn" }] : []);
    }
    case "cancel-switch":
      // Only before anything irreversible: once the backend is stopping, finish or roll back.
      if (state.phase !== "quiescing") return reject("NO_SWITCH", state);
      return accept({ ...state, phase: "active", target: null }, []);
    case "turn-started":
      return accept({ ...state, turnActive: true }, []);
    case "turn-ended": {
      const ended = { ...state, turnActive: false };
      return state.phase === "quiescing" ? afterQuiesced(ended) : accept(ended, []);
    }
    case "backend-stopped":
      if (state.phase !== "stopping") return reject("UNEXPECTED_OBSERVATION", state);
      return accept({ ...state, phase: "resuming" }, [
        {
          type: "start-backend",
          writer: state.target!,
          runtimeSessionRef: state.runtimeSessionRef,
        },
      ]);
    case "resume-confirmed": {
      if (state.phase !== "resuming") return reject("UNEXPECTED_OBSERVATION", state);
      // A different conversation ID is not a resume of this one; treat it as a failure.
      if (
        state.runtimeSessionRef !== null &&
        command.runtimeSessionRef !== state.runtimeSessionRef
      ) {
        return rollBack(state);
      }
      return handOver({ ...state, runtimeSessionRef: command.runtimeSessionRef });
    }
    case "resume-failed":
      if (state.phase !== "resuming") return reject("UNEXPECTED_OBSERVATION", state);
      return rollBack(state);
    case "previous-restored":
      if (state.phase !== "rolling-back" && state.phase !== "recovery-required") {
        return reject("UNEXPECTED_OBSERVATION", state);
      }
      // The previous writer keeps ownership; a new generation fences anything from the attempt.
      return accept({ ...state, phase: "active", target: null, generation: state.generation + 1 }, [
        { type: "writer-changed", writer: state.writer, generation: state.generation + 1 },
      ]);
    case "restore-failed":
      if (state.phase !== "rolling-back") return reject("UNEXPECTED_OBSERVATION", state);
      return accept({ ...state, phase: "recovery-required" }, [{ type: "recovery-required" }]);
  }
}

function afterQuiesced(state: WriterGateState): WriterTransition {
  if (state.strategy === "live" || sameBackend(state.writer, state.target!)) {
    return handOver(state);
  }
  return accept({ ...state, phase: "stopping" }, [{ type: "stop-backend", writer: state.writer }]);
}

/** Which process serves a writer under `stop-resume`: the TUI, or the runner for everyone else. */
export function writerBackend(writer: WriterKind): "tui" | "runner" {
  return writer === "tui" ? "tui" : "runner";
}

function sameBackend(left: WriterKind, right: WriterKind): boolean {
  return writerBackend(left) === writerBackend(right);
}

function handOver(state: WriterGateState): WriterTransition {
  const writer = state.target!;
  const generation = state.generation + 1;
  return accept({ ...state, writer, generation, phase: "active", target: null }, [
    { type: "writer-changed", writer, generation },
  ]);
}

function rollBack(state: WriterGateState): WriterTransition {
  return accept({ ...state, phase: "rolling-back" }, [
    { type: "start-backend", writer: state.writer, runtimeSessionRef: state.runtimeSessionRef },
  ]);
}

function accept(state: WriterGateState, effects: readonly WriterEffect[]): WriterTransition {
  return { ok: true, state, effects };
}

function reject(code: WriterRejection, state: WriterGateState): WriterTransition {
  return { ok: false, code, state };
}
