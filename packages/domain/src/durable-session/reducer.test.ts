import { describe, expect, it } from "vitest";
import { SessionViewSchema } from "@naru/contracts/durable-session/v0";
import { DurableSessionCore } from "../index.js";
import { assertSessionInvariants, effectsForCreatedSession, toSessionView } from "./model.js";
import { reduceDurableSession } from "./reducer.js";
import {
  applySuccess,
  creatingState,
  runningStateWithAttachments,
  TEST_IDS,
} from "./test-support.js";

describe("DurableSession lifecycle reducer", () => {
  it("exports the Core through a collision-free root namespace", () => {
    expect(DurableSessionCore.reduceDurableSession).toBe(reduceDurableSession);
  });

  it("normalizes command terminal descriptors to the strict public terminal-size shape", () => {
    const state = creatingState();
    expect(state.command.terminal).toMatchObject({ term: "xterm-256color" });
    expect(state.terminal).toEqual({ cols: 120, rows: 40 });
    expect(SessionViewSchema.parse(toSessionView(state)).terminal).toEqual({ cols: 120, rows: 40 });
  });

  it("rejects lifecycle transitions outside the approved state graph without effects", () => {
    const creating = creatingState();
    const invalidStart = reduceDurableSession(creating, {
      type: "start",
      expectedSessionRevision: 0,
      newRuntimeId: TEST_IDS.nextRuntime,
      nowMs: 1,
    });
    expect(invalidStart).toMatchObject({ ok: false, state: creating, effects: [] });

    const invalidForget = reduceDurableSession(creating, {
      type: "forget",
      expectedSessionRevision: 0,
      nowMs: 1,
    });
    expect(invalidForget).toMatchObject({ ok: false, state: creating, effects: [] });

    const running = applySuccess(creating, {
      type: "spawnSucceeded",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 1,
    });
    const duplicateSpawn = reduceDurableSession(running, {
      type: "spawnSucceeded",
      expectedSessionRevision: 1,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 2,
    });
    expect(duplicateSpawn).toMatchObject({ ok: false, state: running, effects: [] });
  });

  it("keeps Session identity while fencing every runtime incarnation by revision and runtime ID", () => {
    const initial = creatingState();
    expect(effectsForCreatedSession(initial).map((effect) => effect.type)).toEqual([
      "persistMetadata",
      "emitEvent",
      "spawn",
    ]);

    const runningResult = reduceDurableSession(initial, {
      type: "spawnSucceeded",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 1,
    });
    expect(runningResult.ok).toBe(true);
    if (!runningResult.ok) return;
    expect(runningResult.state).toMatchObject({
      sessionId: TEST_IDS.session,
      lifecycle: "running",
      sessionRevision: 1,
      runtimeId: TEST_IDS.runtime,
    });

    let sequenced = applySuccess(runningResult.state, {
      type: "recordOutput",
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 2,
    });
    sequenced = applySuccess(sequenced, {
      type: "recordOutput",
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 3,
    });
    expect(sequenced.nextSequence).toBe(2);

    const staleStop = reduceDurableSession(sequenced, {
      type: "stop",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 4,
    });
    expect(staleStop).toMatchObject({ ok: false, state: sequenced, effects: [] });
    if (!staleStop.ok) expect(staleStop.error.code).toBe("SESSION_REVISION_STALE");

    const stopping = applySuccess(sequenced, {
      type: "stop",
      expectedSessionRevision: 1,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 5,
    });
    expect(stopping).toMatchObject({ lifecycle: "stopping", sessionRevision: 2 });

    const stopTransition = reduceDurableSession(sequenced, {
      type: "stop",
      expectedSessionRevision: 1,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 5,
    });
    expect(stopTransition.ok).toBe(true);
    if (stopTransition.ok) {
      expect(stopTransition.effects.map((effect) => effect.type)).toEqual([
        "persistMetadata",
        "emitEvent",
        "kill",
      ]);
    }

    const stopped = applySuccess(stopping, {
      type: "runtimeExited",
      expectedRuntimeId: TEST_IDS.runtime,
      exitCode: 0,
      signal: null,
      nowMs: 6,
    });
    expect(stopped).toMatchObject({ lifecycle: "stopped", sessionRevision: 3, runtimeId: null });

    const restarted = applySuccess(stopped, {
      type: "start",
      expectedSessionRevision: 3,
      newRuntimeId: TEST_IDS.nextRuntime,
      nowMs: 7,
    });
    expect(restarted).toMatchObject({
      sessionId: TEST_IDS.session,
      lifecycle: "creating",
      sessionRevision: 4,
      runtimeId: TEST_IDS.nextRuntime,
      nextSequence: 0,
    });

    const lateOldExit = reduceDurableSession(restarted, {
      type: "runtimeExited",
      expectedRuntimeId: TEST_IDS.runtime,
      exitCode: 0,
      signal: null,
      nowMs: 8,
    });
    expect(lateOldExit).toMatchObject({ ok: false, state: restarted, effects: [] });
    if (!lateOldExit.ok) expect(lateOldExit.error.code).toBe("RUNTIME_STALE");
    assertSessionInvariants(restarted);
  });

  it("records a natural exit separately from an explicit stop", () => {
    const running = applySuccess(creatingState(), {
      type: "spawnSucceeded",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 1,
    });
    const exited = applySuccess(running, {
      type: "runtimeExited",
      expectedRuntimeId: TEST_IDS.runtime,
      exitCode: 7,
      signal: null,
      nowMs: 2,
    });

    expect(exited).toMatchObject({
      lifecycle: "exited",
      runtimeId: null,
      lastRuntime: { runtimeId: TEST_IDS.runtime, reason: "natural-exit", exitCode: 7 },
    });
  });

  it("fails a live runtime when Host terminal-state processing cannot remain authoritative", () => {
    const running = applySuccess(creatingState(), {
      type: "spawnSucceeded",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 1,
    });
    const failed = reduceDurableSession(running, {
      type: "runtimeFailed",
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 2,
    });

    expect(failed.ok).toBe(true);
    if (!failed.ok) return;
    expect(failed.state).toMatchObject({
      lifecycle: "failed",
      sessionRevision: 2,
      runtimeId: null,
      lastRuntime: {
        runtimeId: TEST_IDS.runtime,
        reason: "runtime-failed",
        exitCode: null,
        signal: null,
      },
    });
    expect(failed.effects.map((effect) => effect.type)).toEqual(["persistMetadata", "emitEvent"]);
  });

  it("recovers persisted live metadata as an honest stopped Session", () => {
    const running = applySuccess(creatingState(), {
      type: "spawnSucceeded",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 1,
    });
    const recovered = reduceDurableSession(running, {
      type: "recoverRuntimeLost",
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 2,
    });

    expect(recovered.ok).toBe(true);
    if (!recovered.ok) return;
    expect(recovered.state).toMatchObject({
      lifecycle: "stopped",
      sessionRevision: 2,
      runtimeId: null,
      nextSequence: 0,
      lastRuntime: {
        runtimeId: TEST_IDS.runtime,
        reason: "runtime-lost",
        exitCode: null,
        signal: null,
      },
    });
    expect(recovered.effects.map((effect) => effect.type)).toEqual([
      "persistMetadata",
      "emitEvent",
    ]);
  });

  it("rejects runtime-lost recovery for stale or terminal runtimes without effects", () => {
    const running = applySuccess(creatingState(), {
      type: "spawnSucceeded",
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 1,
    });
    const stale = reduceDurableSession(running, {
      type: "recoverRuntimeLost",
      expectedRuntimeId: TEST_IDS.nextRuntime,
      nowMs: 2,
    });
    expect(stale).toMatchObject({ ok: false, state: running, effects: [] });
    if (!stale.ok) expect(stale.error.code).toBe("RUNTIME_STALE");

    const exited = applySuccess(running, {
      type: "runtimeExited",
      expectedRuntimeId: TEST_IDS.runtime,
      exitCode: 0,
      signal: null,
      nowMs: 2,
    });
    const terminal = reduceDurableSession(exited, {
      type: "recoverRuntimeLost",
      expectedRuntimeId: TEST_IDS.runtime,
      nowMs: 3,
    });
    expect(terminal).toMatchObject({ ok: false, state: exited, effects: [] });
  });
});

describe("DurableSession control reducer", () => {
  it("requires request, controller approval, requester accept, then fences the old generation", () => {
    let state = runningStateWithAttachments();
    let result = reduceDurableSession(state, {
      type: "acquireControl",
      attachmentId: TEST_IDS.controller,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 0,
      terminal: { cols: 100, rows: 30 },
      nowMs: 3,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    state = result.state;
    expect(state).toMatchObject({
      controllerAttachmentId: TEST_IDS.controller,
      controllerGeneration: 1,
      terminal: { cols: 100, rows: 30 },
    });
    expect(result.effects.filter((effect) => effect.type === "resizePty")).toHaveLength(1);

    state = applySuccess(state, {
      type: "requestControl",
      attachmentId: TEST_IDS.requester,
      controlRequestId: TEST_IDS.controlRequest,
      expectedControllerGeneration: 1,
      nowMs: 4,
    });
    state = applySuccess(state, {
      type: "approveControl",
      attachmentId: TEST_IDS.controller,
      controlRequestId: TEST_IDS.controlRequest,
      controlOfferId: TEST_IDS.controlOffer,
      expectedControllerGeneration: 1,
      nowMs: 5,
    });
    expect(state.attachments[TEST_IDS.requester]?.role).toBe("observer");

    result = reduceDurableSession(state, {
      type: "acceptControl",
      attachmentId: TEST_IDS.requester,
      controlOfferId: TEST_IDS.controlOffer,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 1,
      terminal: { cols: 140, rows: 50 },
      nowMs: 6,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    state = result.state;
    expect(state).toMatchObject({
      controllerAttachmentId: TEST_IDS.requester,
      controllerGeneration: 2,
      terminal: { cols: 140, rows: 50 },
      pendingControlRequests: {},
      activeControlOffer: null,
    });
    expect(state.attachments[TEST_IDS.controller]?.role).toBe("observer");
    expect(state.attachments[TEST_IDS.requester]?.role).toBe("controller");
    expect(result.effects.filter((effect) => effect.type === "resizePty")).toHaveLength(1);

    const staleInput = reduceDurableSession(state, {
      type: "sendInput",
      attachmentId: TEST_IDS.controller,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 1,
      inputId: TEST_IDS.input,
      data: "stale input",
      nowMs: 7,
    });
    expect(staleInput).toMatchObject({ ok: false, state, effects: [] });
    if (!staleInput.ok) expect(staleInput.error.code).toBe("CONTROL_GENERATION_STALE");
  });

  it("preempts explicitly, releases without auto-promotion, and rejects stale resize", () => {
    let state = runningStateWithAttachments();
    state = applySuccess(state, {
      type: "openAttachment",
      attachmentId: TEST_IDS.owner,
      nowMs: 3,
    });
    state = applySuccess(state, {
      type: "acquireControl",
      attachmentId: TEST_IDS.controller,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 0,
      terminal: { cols: 100, rows: 30 },
      nowMs: 4,
    });
    state = applySuccess(state, {
      type: "requestControl",
      attachmentId: TEST_IDS.requester,
      controlRequestId: TEST_IDS.controlRequest,
      expectedControllerGeneration: 1,
      nowMs: 5,
    });

    const preemptedResult = reduceDurableSession(state, {
      type: "preemptControl",
      attachmentId: TEST_IDS.owner,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 1,
      terminal: { cols: 90, rows: 25 },
      nowMs: 6,
    });
    expect(preemptedResult.ok).toBe(true);
    if (!preemptedResult.ok) return;
    state = preemptedResult.state;
    expect(state).toMatchObject({
      controllerAttachmentId: TEST_IDS.owner,
      controllerGeneration: 2,
      pendingControlRequests: {},
    });

    const staleResize = reduceDurableSession(state, {
      type: "resizeTerminal",
      attachmentId: TEST_IDS.controller,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 1,
      terminal: { cols: 200, rows: 60 },
      nowMs: 7,
    });
    expect(staleResize).toMatchObject({ ok: false, state, effects: [] });
    if (!staleResize.ok) expect(staleResize.error.code).toBe("CONTROL_GENERATION_STALE");

    state = applySuccess(state, {
      type: "releaseControl",
      attachmentId: TEST_IDS.owner,
      expectedControllerGeneration: 2,
      nowMs: 8,
    });
    expect(state).toMatchObject({ controllerAttachmentId: null, controllerGeneration: 3 });
    expect(
      Object.values(state.attachments).every((attachment) => attachment.role === "observer"),
    ).toBe(true);
  });

  it("keeps control during reconnect grace, then expires it without promoting a requester", () => {
    let state = runningStateWithAttachments(100);
    state = applySuccess(state, {
      type: "acquireControl",
      attachmentId: TEST_IDS.controller,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 0,
      terminal: { cols: 100, rows: 30 },
      nowMs: 101,
    });
    state = applySuccess(state, {
      type: "requestControl",
      attachmentId: TEST_IDS.requester,
      controlRequestId: TEST_IDS.controlRequest,
      expectedControllerGeneration: 1,
      nowMs: 102,
    });
    state = applySuccess(state, {
      type: "disconnectAttachment",
      attachmentId: TEST_IDS.controller,
      nowMs: 103,
    });

    state = applySuccess(state, { type: "expire", nowMs: 10_102 });
    expect(state.controllerAttachmentId).toBe(TEST_IDS.controller);

    state = applySuccess(state, { type: "expire", nowMs: 10_103 });
    expect(state).toMatchObject({
      controllerAttachmentId: null,
      controllerGeneration: 2,
      pendingControlRequests: {},
    });
    expect(state.attachments[TEST_IDS.requester]?.role).toBe("observer");
  });

  it("expires requests and offers without changing the current controller", () => {
    let state = runningStateWithAttachments(100);
    state = applySuccess(state, {
      type: "acquireControl",
      attachmentId: TEST_IDS.controller,
      expectedRuntimeId: TEST_IDS.runtime,
      expectedControllerGeneration: 0,
      terminal: { cols: 100, rows: 30 },
      nowMs: 101,
    });
    state = applySuccess(state, {
      type: "requestControl",
      attachmentId: TEST_IDS.requester,
      controlRequestId: TEST_IDS.controlRequest,
      expectedControllerGeneration: 1,
      nowMs: 102,
    });
    state = applySuccess(state, {
      type: "approveControl",
      attachmentId: TEST_IDS.controller,
      controlRequestId: TEST_IDS.controlRequest,
      controlOfferId: TEST_IDS.controlOffer,
      expectedControllerGeneration: 1,
      nowMs: 103,
    });
    for (const attachmentId of [TEST_IDS.controller, TEST_IDS.requester]) {
      state = applySuccess(state, {
        type: "heartbeat",
        attachmentId,
        expectedRuntimeId: TEST_IDS.runtime,
        expectedControllerGeneration: 1,
        nowMs: 60_102,
      });
    }

    state = applySuccess(state, { type: "expire", nowMs: 60_103 });
    expect(state).toMatchObject({
      controllerAttachmentId: TEST_IDS.controller,
      controllerGeneration: 1,
      pendingControlRequests: {},
      activeControlOffer: null,
    });

    state = applySuccess(state, {
      type: "requestControl",
      attachmentId: TEST_IDS.requester,
      controlRequestId: TEST_IDS.controlRequest,
      expectedControllerGeneration: 1,
      nowMs: 70_000,
    });
    for (const attachmentId of [TEST_IDS.controller, TEST_IDS.requester]) {
      state = applySuccess(state, {
        type: "heartbeat",
        attachmentId,
        expectedRuntimeId: TEST_IDS.runtime,
        expectedControllerGeneration: 1,
        nowMs: 369_999,
      });
    }
    state = applySuccess(state, { type: "expire", nowMs: 370_000 });
    expect(state).toMatchObject({
      controllerAttachmentId: TEST_IDS.controller,
      controllerGeneration: 1,
      pendingControlRequests: {},
      activeControlOffer: null,
    });
  });
});
