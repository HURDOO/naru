import { describe, expect, it } from "vitest";
import {
  authorizeWrite,
  initialWriterGate,
  reduceWriterGate,
  type WriterCommand,
  type WriterEffect,
  type WriterGateState,
} from "../src/agent-runtime/writer-gate.js";

const REF = "conversation-ref-1";

function run(state: WriterGateState, ...commands: WriterCommand[]) {
  const effects: WriterEffect[] = [];
  let current = state;
  for (const command of commands) {
    const transition = reduceWriterGate(current, command);
    if (!transition.ok) throw new Error(`${command.type} rejected: ${transition.code}`);
    current = transition.state;
    effects.push(...transition.effects);
  }
  return { state: current, effects };
}

describe("conversation writer gate", () => {
  it("moves a live writer only at a turn boundary and fences the previous one", () => {
    const start = run(initialWriterGate("live", "gui", REF), { type: "turn-started" });
    const switching = run(start.state, { type: "request-switch", to: "tui", interrupt: false });
    expect(switching.state).toMatchObject({ phase: "quiescing", writer: "gui" });
    expect(switching.effects).toEqual([]);
    // No new turns mid-switch, but the running turn's approvals stay with the current writer.
    expect(authorizeWrite(switching.state, "gui", 1, "turn")).toBe(false);
    expect(authorizeWrite(switching.state, "gui", 1, "approval-response")).toBe(true);
    expect(authorizeWrite(switching.state, "tui", 1, "turn")).toBe(false);

    const done = run(switching.state, { type: "turn-ended" });
    expect(done.state).toMatchObject({ phase: "active", writer: "tui", generation: 2 });
    expect(done.effects).toEqual([{ type: "writer-changed", writer: "tui", generation: 2 }]);
    expect(authorizeWrite(done.state, "gui", 1, "turn")).toBe(false);
    expect(authorizeWrite(done.state, "tui", 1, "turn")).toBe(false);
    expect(authorizeWrite(done.state, "tui", 2, "turn")).toBe(true);
  });

  it("interrupts only when asked and never kills a turn on its own", () => {
    const busy = run(initialWriterGate("live", "orchestrator", REF), { type: "turn-started" });
    expect(
      run(busy.state, { type: "request-switch", to: "gui", interrupt: false }).effects,
    ).toEqual([]);
    expect(run(busy.state, { type: "request-switch", to: "gui", interrupt: true }).effects).toEqual(
      [{ type: "interrupt-turn" }],
    );
  });

  it("hands over live between writers that share the stop-resume runner", () => {
    const switched = run(initialWriterGate("stop-resume", "orchestrator", REF), {
      type: "request-switch",
      to: "gui",
      interrupt: false,
    });
    expect(switched.state).toMatchObject({ phase: "active", writer: "gui", generation: 2 });
    expect(switched.effects).toEqual([{ type: "writer-changed", writer: "gui", generation: 2 }]);
  });

  it("stops and resumes the same conversation for stop-resume runtimes", () => {
    const switching = run(initialWriterGate("stop-resume", "gui", REF), {
      type: "request-switch",
      to: "tui",
      interrupt: false,
    });
    expect(switching.state.phase).toBe("stopping");
    expect(switching.effects).toEqual([{ type: "stop-backend", writer: "gui" }]);
    expect(authorizeWrite(switching.state, "gui", 1, "turn")).toBe(false);

    const resuming = run(switching.state, { type: "backend-stopped" });
    expect(resuming.effects).toEqual([
      { type: "start-backend", writer: "tui", runtimeSessionRef: REF },
    ]);
    const active = run(resuming.state, { type: "resume-confirmed", runtimeSessionRef: REF });
    expect(active.state).toMatchObject({ phase: "active", writer: "tui", generation: 2 });
  });

  it("rolls back when the target resumes a different or no conversation", () => {
    const resuming = run(
      initialWriterGate("stop-resume", "gui", REF),
      { type: "request-switch", to: "tui", interrupt: false },
      { type: "backend-stopped" },
    );
    const wrong = run(resuming.state, { type: "resume-confirmed", runtimeSessionRef: "other" });
    expect(wrong.state.phase).toBe("rolling-back");
    expect(wrong.effects).toEqual([
      { type: "start-backend", writer: "gui", runtimeSessionRef: REF },
    ]);
    const restored = run(wrong.state, { type: "previous-restored" });
    expect(restored.state).toMatchObject({ phase: "active", writer: "gui", generation: 2 });

    const failed = run(resuming.state, { type: "resume-failed" }, { type: "restore-failed" });
    expect(failed.state.phase).toBe("recovery-required");
    expect(failed.effects.at(-1)).toEqual({ type: "recovery-required" });
    expect(authorizeWrite(failed.state, "gui", 1, "turn")).toBe(false);
    expect(
      reduceWriterGate(failed.state, { type: "request-switch", to: "tui", interrupt: false }),
    ).toMatchObject({ ok: false, code: "RECOVERY_REQUIRED" });
  });

  it("allows cancelling only before the backend stops and rejects overlapping switches", () => {
    const quiescing = run(
      initialWriterGate("stop-resume", "gui", REF),
      { type: "turn-started" },
      { type: "request-switch", to: "tui", interrupt: false },
    );
    expect(
      reduceWriterGate(quiescing.state, {
        type: "request-switch",
        to: "orchestrator",
        interrupt: false,
      }),
    ).toMatchObject({ ok: false, code: "SWITCH_IN_PROGRESS" });
    const cancelled = run(quiescing.state, { type: "cancel-switch" });
    expect(cancelled.state).toMatchObject({ phase: "active", writer: "gui", generation: 1 });

    const stopping = run(quiescing.state, { type: "turn-ended" });
    expect(reduceWriterGate(stopping.state, { type: "cancel-switch" })).toMatchObject({
      ok: false,
      code: "NO_SWITCH",
    });
  });
});
