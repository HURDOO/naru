import { DURABLE_SESSION_PROTOCOL_VERSION } from "./common.js";

export const DURABLE_SESSION_V0_TEST_IDS = {
  session: "11111111-1111-4111-8111-111111111111",
  runtime: "22222222-2222-4222-8222-222222222222",
  controller: "33333333-3333-4333-8333-333333333333",
  requester: "44444444-4444-4444-8444-444444444444",
  controlRequest: "55555555-5555-4555-8555-555555555555",
  controlOffer: "66666666-6666-4666-8666-666666666666",
  request: "77777777-7777-4777-8777-777777777777",
  event: "88888888-8888-4888-8888-888888888888",
  input: "99999999-9999-4999-8999-999999999999",
  idempotency: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
} as const;

const ids = DURABLE_SESSION_V0_TEST_IDS;
const base = { version: DURABLE_SESSION_PROTOCOL_VERSION, requestId: ids.request } as const;
const attachment = { sessionId: ids.session, attachmentId: ids.requester } as const;
const currentController = {
  ...attachment,
  expectedRuntimeId: ids.runtime,
  expectedControllerGeneration: 3,
} as const;

export const DURABLE_SESSION_V0_OPERATION_TEST_VECTORS = [
  {
    ...base,
    operation: "createSession",
    idempotencyKey: ids.idempotency,
    command: {
      kind: "profile",
      profileId: "fixture-shell",
      cwd: { rootId: "fixture-root", relativePath: "project" },
      terminal: { cols: 120, rows: 40, term: "xterm-256color" },
    },
  },
  { ...base, operation: "listSessions", limit: 100 },
  { ...base, operation: "getSession", sessionId: ids.session },
  {
    ...base,
    operation: "startSession",
    sessionId: ids.session,
    expectedSessionRevision: 2,
    idempotencyKey: ids.idempotency,
  },
  {
    ...base,
    operation: "stopSession",
    sessionId: ids.session,
    expectedSessionRevision: 3,
    expectedRuntimeId: ids.runtime,
    idempotencyKey: ids.idempotency,
  },
  {
    ...base,
    operation: "forgetSession",
    sessionId: ids.session,
    expectedSessionRevision: 4,
  },
  { ...base, operation: "openAttachment", sessionId: ids.session },
  {
    ...base,
    operation: "resumeAttachment",
    ...attachment,
    expectedRuntimeId: ids.runtime,
    expectedControllerGeneration: 3,
    attachmentResumeToken: "fixture-only-resume-token-value-0000000000000000",
  },
  { ...base, operation: "closeAttachment", ...attachment },
  {
    ...base,
    operation: "requestSnapshot",
    ...attachment,
    expectedRuntimeId: ids.runtime,
  },
  {
    ...base,
    operation: "resyncAttachment",
    ...attachment,
    expectedRuntimeId: ids.runtime,
    afterSequence: 12,
  },
  { ...base, operation: "acquireControl", ...currentController, terminal: { cols: 100, rows: 30 } },
  {
    ...base,
    operation: "requestControl",
    ...attachment,
    expectedControllerGeneration: 3,
  },
  {
    ...base,
    operation: "approveControl",
    sessionId: ids.session,
    attachmentId: ids.controller,
    controlRequestId: ids.controlRequest,
    expectedControllerGeneration: 3,
  },
  {
    ...base,
    operation: "rejectControl",
    sessionId: ids.session,
    attachmentId: ids.controller,
    controlRequestId: ids.controlRequest,
    expectedControllerGeneration: 3,
  },
  {
    ...base,
    operation: "acceptControl",
    ...currentController,
    controlOfferId: ids.controlOffer,
    idempotencyKey: ids.idempotency,
    terminal: { cols: 100, rows: 30 },
  },
  {
    ...base,
    operation: "preemptControl",
    ...currentController,
    idempotencyKey: ids.idempotency,
    terminal: { cols: 100, rows: 30 },
    reasonCode: "owner-takeover",
  },
  {
    ...base,
    operation: "releaseControl",
    sessionId: ids.session,
    attachmentId: ids.controller,
    expectedControllerGeneration: 3,
  },
  {
    ...base,
    operation: "sendInput",
    sessionId: ids.session,
    attachmentId: ids.controller,
    expectedRuntimeId: ids.runtime,
    expectedControllerGeneration: 3,
    inputId: ids.input,
    data: "fixture input",
  },
  {
    ...base,
    operation: "resizeTerminal",
    sessionId: ids.session,
    attachmentId: ids.controller,
    expectedRuntimeId: ids.runtime,
    expectedControllerGeneration: 3,
    terminal: { cols: 140, rows: 50 },
  },
  { ...base, operation: "readEvents", afterEventId: ids.event, limit: 100 },
  { ...base, operation: "waitForEvents", afterEventId: ids.event, limit: 100, timeoutMs: 5_000 },
] as const;

export const DURABLE_SESSION_V0_EVENT_TEST_VECTORS = [
  {
    version: DURABLE_SESSION_PROTOCOL_VERSION,
    eventId: ids.event,
    sessionId: ids.session,
    occurredAtMs: 1_780_000_000_000,
    type: "session.changed",
    sessionRevision: 3,
    lifecycle: "running",
    runtimeId: ids.runtime,
  },
  {
    version: DURABLE_SESSION_PROTOCOL_VERSION,
    eventId: ids.event,
    sessionId: ids.session,
    occurredAtMs: 1_780_000_000_000,
    type: "control.changed",
    controllerGeneration: 4,
    previousControllerAttachmentId: ids.controller,
    controllerAttachmentId: ids.requester,
    terminal: { cols: 100, rows: 30 },
    reason: "transferred",
  },
] as const;

export const DURABLE_SESSION_V0_REDACTION_MARKERS = {
  forbiddenSecret: "fixture-secret-must-never-appear",
  forbiddenTranscript: "fixture-terminal-transcript-must-never-appear",
} as const;
