import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { assertSessionInvariants, type DurableSessionState } from "./model.js";
import { reduceDurableSession, type DurableSessionCommand } from "./reducer.js";
import { applySuccess, runningStateWithAttachments, TEST_IDS } from "./test-support.js";

type RaceAction = "preempt" | "stop" | "exit" | "old-input" | "expire";

function controlledState(): DurableSessionState {
  return applySuccess(runningStateWithAttachments(), {
    type: "acquireControl",
    attachmentId: TEST_IDS.controller,
    expectedRuntimeId: TEST_IDS.runtime,
    expectedControllerGeneration: 0,
    terminal: { cols: 100, rows: 30 },
    nowMs: 3,
  });
}

function raceCommand(
  action: RaceAction,
  state: DurableSessionState,
  nowMs: number,
): DurableSessionCommand {
  switch (action) {
    case "preempt":
      return {
        type: "preemptControl",
        attachmentId: TEST_IDS.requester,
        expectedRuntimeId: TEST_IDS.runtime,
        expectedControllerGeneration: 1,
        terminal: { cols: 90, rows: 25 },
        nowMs,
      };
    case "stop":
      return {
        type: "stop",
        expectedSessionRevision: 1,
        expectedRuntimeId: TEST_IDS.runtime,
        nowMs,
      };
    case "exit":
      return {
        type: "runtimeExited",
        expectedRuntimeId: TEST_IDS.runtime,
        exitCode: 0,
        signal: null,
        nowMs,
      };
    case "old-input":
      return {
        type: "sendInput",
        attachmentId: TEST_IDS.controller,
        expectedRuntimeId: TEST_IDS.runtime,
        expectedControllerGeneration: 1,
        inputId: TEST_IDS.input,
        data: "bounded fixture input",
        nowMs,
      };
    case "expire":
      return { type: "expire", nowMs };
  }
}

describe("DurableSession race model", () => {
  it("preserves ordering and controller invariants for every preempt/stop/exit permutation", () => {
    const permutations: readonly (readonly RaceAction[])[] = [
      ["preempt", "stop", "exit"],
      ["preempt", "exit", "stop"],
      ["stop", "preempt", "exit"],
      ["stop", "exit", "preempt"],
      ["exit", "preempt", "stop"],
      ["exit", "stop", "preempt"],
    ];

    for (const actions of permutations) {
      let state = controlledState();
      for (const [index, action] of actions.entries()) {
        const previous = state;
        const result = reduceDurableSession(state, raceCommand(action, state, index + 4));
        if (result.ok) {
          state = result.state;
          expect(state.sessionRevision).toBeGreaterThanOrEqual(previous.sessionRevision);
          expect(state.controllerGeneration).toBeGreaterThanOrEqual(previous.controllerGeneration);
        } else {
          expect(result.state).toBe(previous);
          expect(result.effects).toEqual([]);
        }
        assertSessionInvariants(state);
      }
    }
  });

  it("maintains the pure reducer model across generated race sequences", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom<RaceAction>("preempt", "stop", "exit", "old-input", "expire"), {
          minLength: 1,
          maxLength: 100,
        }),
        (actions) => {
          let state = controlledState();
          for (const [index, action] of actions.entries()) {
            const previous = state;
            const result = reduceDurableSession(state, raceCommand(action, state, index + 4));
            if (result.ok) {
              state = result.state;
              expect(state.sessionRevision).toBeGreaterThanOrEqual(previous.sessionRevision);
              expect(state.controllerGeneration).toBeGreaterThanOrEqual(
                previous.controllerGeneration,
              );
            } else {
              expect(result.state).toBe(previous);
              expect(result.effects).toEqual([]);
            }
            assertSessionInvariants(state);
            expect(
              Object.values(state.attachments).filter(
                (attachment) => attachment.role === "controller",
              ),
            ).toHaveLength(state.controllerAttachmentId === null ? 0 : 1);
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
