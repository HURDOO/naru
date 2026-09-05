import type { DurableSessionCommand } from "./reducer.js";
import { createSessionState, type DurableSessionState } from "./model.js";
import { reduceDurableSession } from "./reducer.js";

export const TEST_IDS = {
  session: "11111111-1111-4111-8111-111111111111",
  runtime: "22222222-2222-4222-8222-222222222222",
  nextRuntime: "23232323-2323-4232-8232-232323232323",
  controller: "33333333-3333-4333-8333-333333333333",
  requester: "44444444-4444-4444-8444-444444444444",
  owner: "45454545-4545-4454-8454-454545454545",
  controlRequest: "55555555-5555-4555-8555-555555555555",
  controlOffer: "66666666-6666-4666-8666-666666666666",
  input: "99999999-9999-4999-8999-999999999999",
} as const;

export function creatingState(nowMs = 0): DurableSessionState {
  return createSessionState({
    sessionId: TEST_IDS.session,
    runtimeId: TEST_IDS.runtime,
    command: {
      kind: "profile",
      profileId: "fixture-shell",
      cwd: { rootId: "fixture-root", relativePath: "project" },
      terminal: { cols: 120, rows: 40, term: "xterm-256color" },
    },
    nowMs,
  });
}

export function runningState(nowMs = 1): DurableSessionState {
  return applySuccess(creatingState(0), {
    type: "spawnSucceeded",
    expectedSessionRevision: 0,
    expectedRuntimeId: TEST_IDS.runtime,
    nowMs,
  });
}

export function runningStateWithAttachments(nowMs = 2): DurableSessionState {
  let state = runningState(1);
  state = applySuccess(state, {
    type: "openAttachment",
    attachmentId: TEST_IDS.controller,
    nowMs,
  });
  return applySuccess(state, {
    type: "openAttachment",
    attachmentId: TEST_IDS.requester,
    nowMs,
  });
}

export function applySuccess(
  state: DurableSessionState,
  command: DurableSessionCommand,
): DurableSessionState {
  const result = reduceDurableSession(state, command);
  if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`);
  return result.state;
}
