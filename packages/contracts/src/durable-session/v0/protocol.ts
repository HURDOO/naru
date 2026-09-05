import { z } from "zod";
import {
  AppIdSchema,
  AttachmentIdSchema,
  AttachmentRoleSchema,
  BoundedTerminalDataSchema,
  CommandSpecV0Schema,
  ControlOfferIdSchema,
  ControlRequestIdSchema,
  ControllerGenerationSchema,
  DURABLE_SESSION_LIMITS,
  DurableSessionErrorSchema,
  DurableSessionProtocolVersionSchema,
  IdempotencyKeySchema,
  InputIdSchema,
  ProtocolRequestIdSchema,
  RedactedReasonCodeSchema,
  RuntimeIdSchema,
  SensitiveOpaqueTokenSchema,
  SessionIdSchema,
  SessionRevisionSchema,
  SessionViewSchema,
  SubjectIdSchema,
  TerminalSequenceSchema,
  TerminalSizeSchema,
  UnixTimeMillisecondsSchema,
} from "./common.js";
import {
  ControlOfferViewSchema,
  ControlRequestResolutionSchema,
  ControlRequestViewSchema,
  DurableSessionJournalEventSchema,
} from "./events.js";

const RequestBaseShape = {
  version: DurableSessionProtocolVersionSchema,
  requestId: ProtocolRequestIdSchema,
} as const;

const SessionAttachmentShape = {
  sessionId: SessionIdSchema,
  attachmentId: AttachmentIdSchema,
} as const;

const CurrentControllerShape = {
  ...SessionAttachmentShape,
  expectedRuntimeId: RuntimeIdSchema,
  expectedControllerGeneration: ControllerGenerationSchema,
} as const;

export const CreateSessionRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("createSession"),
  idempotencyKey: IdempotencyKeySchema,
  command: CommandSpecV0Schema,
});

export const ListSessionsRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("listSessions"),
  cursor: z.string().min(1).max(256).optional(),
  limit: z.number().int().min(1).max(1_000).default(100),
});

export const GetSessionRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("getSession"),
  sessionId: SessionIdSchema,
});

export const StartSessionRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("startSession"),
  sessionId: SessionIdSchema,
  expectedSessionRevision: SessionRevisionSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const StopSessionRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("stopSession"),
  sessionId: SessionIdSchema,
  expectedSessionRevision: SessionRevisionSchema,
  expectedRuntimeId: RuntimeIdSchema,
  idempotencyKey: IdempotencyKeySchema,
});

export const ForgetSessionRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("forgetSession"),
  sessionId: SessionIdSchema,
  expectedSessionRevision: SessionRevisionSchema,
});

export const OpenAttachmentRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("openAttachment"),
  sessionId: SessionIdSchema,
  clientInstanceId: z.string().uuid().optional(),
});

export const ResumeAttachmentRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("resumeAttachment"),
  ...SessionAttachmentShape,
  expectedRuntimeId: RuntimeIdSchema,
  expectedControllerGeneration: ControllerGenerationSchema,
  attachmentResumeToken: SensitiveOpaqueTokenSchema,
});

export const CloseAttachmentRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("closeAttachment"),
  ...SessionAttachmentShape,
});

export const RequestSnapshotRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("requestSnapshot"),
  ...SessionAttachmentShape,
  expectedRuntimeId: RuntimeIdSchema,
});

export const ResyncAttachmentRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("resyncAttachment"),
  ...SessionAttachmentShape,
  expectedRuntimeId: RuntimeIdSchema,
  afterSequence: TerminalSequenceSchema,
});

export const AcquireControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("acquireControl"),
  ...CurrentControllerShape,
  terminal: TerminalSizeSchema,
});

export const RequestControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("requestControl"),
  ...SessionAttachmentShape,
  expectedControllerGeneration: ControllerGenerationSchema,
});

export const ApproveControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("approveControl"),
  ...SessionAttachmentShape,
  controlRequestId: ControlRequestIdSchema,
  expectedControllerGeneration: ControllerGenerationSchema,
});

export const RejectControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("rejectControl"),
  ...SessionAttachmentShape,
  controlRequestId: ControlRequestIdSchema,
  expectedControllerGeneration: ControllerGenerationSchema,
});

export const AcceptControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("acceptControl"),
  ...CurrentControllerShape,
  controlOfferId: ControlOfferIdSchema,
  idempotencyKey: IdempotencyKeySchema,
  terminal: TerminalSizeSchema,
});

export const PreemptControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("preemptControl"),
  ...CurrentControllerShape,
  idempotencyKey: IdempotencyKeySchema,
  terminal: TerminalSizeSchema,
  reasonCode: RedactedReasonCodeSchema,
});

export const ReleaseControlRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("releaseControl"),
  ...SessionAttachmentShape,
  expectedControllerGeneration: ControllerGenerationSchema,
});

export const SendInputRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("sendInput"),
  ...CurrentControllerShape,
  inputId: InputIdSchema,
  data: BoundedTerminalDataSchema,
});

export const ResizeTerminalRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("resizeTerminal"),
  ...CurrentControllerShape,
  terminal: TerminalSizeSchema,
});

export const ReadEventsRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("readEvents"),
  sessionId: SessionIdSchema.optional(),
  afterEventId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(DURABLE_SESSION_LIMITS.eventReadLimit).default(100),
});

export const WaitForEventsRequestSchema = z.strictObject({
  ...RequestBaseShape,
  operation: z.literal("waitForEvents"),
  sessionId: SessionIdSchema.optional(),
  afterEventId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(DURABLE_SESSION_LIMITS.eventReadLimit).default(100),
  timeoutMs: z.number().int().min(1).max(DURABLE_SESSION_LIMITS.requestTimeoutMs),
});

export const DurableSessionOperationRequestSchema = z.discriminatedUnion("operation", [
  CreateSessionRequestSchema,
  ListSessionsRequestSchema,
  GetSessionRequestSchema,
  StartSessionRequestSchema,
  StopSessionRequestSchema,
  ForgetSessionRequestSchema,
  OpenAttachmentRequestSchema,
  ResumeAttachmentRequestSchema,
  CloseAttachmentRequestSchema,
  RequestSnapshotRequestSchema,
  ResyncAttachmentRequestSchema,
  AcquireControlRequestSchema,
  RequestControlRequestSchema,
  ApproveControlRequestSchema,
  RejectControlRequestSchema,
  AcceptControlRequestSchema,
  PreemptControlRequestSchema,
  ReleaseControlRequestSchema,
  SendInputRequestSchema,
  ResizeTerminalRequestSchema,
  ReadEventsRequestSchema,
  WaitForEventsRequestSchema,
]);
export type DurableSessionOperationRequest = z.infer<typeof DurableSessionOperationRequestSchema>;

export const AttachmentLeaseSchema = z.strictObject({
  sessionId: SessionIdSchema,
  attachmentId: AttachmentIdSchema,
  runtimeId: RuntimeIdSchema,
  role: AttachmentRoleSchema,
  controllerGeneration: ControllerGenerationSchema,
  attachmentResumeToken: SensitiveOpaqueTokenSchema,
  resumeExpiresAtMs: UnixTimeMillisecondsSchema,
  appId: AppIdSchema,
  subject: SubjectIdSchema,
});
export type AttachmentLease = z.infer<typeof AttachmentLeaseSchema>;

export const TerminalSnapshotSchema = z.strictObject({
  sessionId: SessionIdSchema,
  attachmentId: AttachmentIdSchema,
  runtimeId: RuntimeIdSchema,
  sequence: TerminalSequenceSchema,
  terminal: TerminalSizeSchema,
  serializedState: z.string().max(DURABLE_SESSION_LIMITS.terminalStateCharacters),
});
export type TerminalSnapshot = z.infer<typeof TerminalSnapshotSchema>;

export const ControlViewSchema = z.strictObject({
  sessionId: SessionIdSchema,
  runtimeId: RuntimeIdSchema,
  controllerAttachmentId: AttachmentIdSchema.nullable(),
  controllerGeneration: ControllerGenerationSchema,
  terminal: TerminalSizeSchema,
});
export type ControlView = z.infer<typeof ControlViewSchema>;

const SessionResultSchemas = [
  z.strictObject({ operation: z.literal("createSession"), session: SessionViewSchema }),
  z.strictObject({ operation: z.literal("getSession"), session: SessionViewSchema }),
  z.strictObject({ operation: z.literal("startSession"), session: SessionViewSchema }),
  z.strictObject({ operation: z.literal("stopSession"), session: SessionViewSchema }),
] as const;

const ControlResultSchemas = [
  z.strictObject({ operation: z.literal("acquireControl"), control: ControlViewSchema }),
  z.strictObject({ operation: z.literal("acceptControl"), control: ControlViewSchema }),
  z.strictObject({ operation: z.literal("preemptControl"), control: ControlViewSchema }),
  z.strictObject({ operation: z.literal("releaseControl"), control: ControlViewSchema }),
] as const;

export const DurableSessionOperationResultSchema = z.discriminatedUnion("operation", [
  ...SessionResultSchemas,
  z.strictObject({
    operation: z.literal("listSessions"),
    sessions: z.array(SessionViewSchema).max(1_000),
    nextCursor: z.string().min(1).max(256).nullable(),
  }),
  z.strictObject({ operation: z.literal("forgetSession"), forgotten: z.literal(true) }),
  z.strictObject({ operation: z.literal("openAttachment"), attachment: AttachmentLeaseSchema }),
  z.strictObject({ operation: z.literal("resumeAttachment"), attachment: AttachmentLeaseSchema }),
  z.strictObject({ operation: z.literal("closeAttachment"), closed: z.literal(true) }),
  z.strictObject({ operation: z.literal("requestSnapshot"), snapshot: TerminalSnapshotSchema }),
  z.strictObject({ operation: z.literal("resyncAttachment"), snapshot: TerminalSnapshotSchema }),
  ...ControlResultSchemas,
  z.strictObject({ operation: z.literal("requestControl"), request: ControlRequestViewSchema }),
  z.strictObject({ operation: z.literal("approveControl"), offer: ControlOfferViewSchema }),
  z.strictObject({
    operation: z.literal("rejectControl"),
    controlRequestId: ControlRequestIdSchema,
    resolution: ControlRequestResolutionSchema,
  }),
  z.strictObject({
    operation: z.literal("sendInput"),
    runtimeId: RuntimeIdSchema,
    controllerGeneration: ControllerGenerationSchema,
    inputId: InputIdSchema,
    accepted: z.literal(true),
  }),
  z.strictObject({
    operation: z.literal("resizeTerminal"),
    runtimeId: RuntimeIdSchema,
    controllerGeneration: ControllerGenerationSchema,
    terminal: TerminalSizeSchema,
  }),
  z.strictObject({
    operation: z.literal("readEvents"),
    events: z.array(DurableSessionJournalEventSchema).max(DURABLE_SESSION_LIMITS.eventReadLimit),
    cursor: z.string().min(1).max(256).nullable(),
  }),
  z.strictObject({
    operation: z.literal("waitForEvents"),
    events: z.array(DurableSessionJournalEventSchema).max(DURABLE_SESSION_LIMITS.eventReadLimit),
    cursor: z.string().min(1).max(256).nullable(),
    timedOut: z.boolean(),
  }),
]);
export type DurableSessionOperationResult = z.infer<typeof DurableSessionOperationResultSchema>;

export const DurableSessionSuccessResponseSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  requestId: ProtocolRequestIdSchema,
  ok: z.literal(true),
  result: DurableSessionOperationResultSchema,
});

export const DurableSessionFailureResponseSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  requestId: ProtocolRequestIdSchema,
  ok: z.literal(false),
  error: DurableSessionErrorSchema,
});

export const DurableSessionOperationResponseSchema = z.discriminatedUnion("ok", [
  DurableSessionSuccessResponseSchema,
  DurableSessionFailureResponseSchema,
]);
export type DurableSessionOperationResponse = z.infer<typeof DurableSessionOperationResponseSchema>;

export const AttachmentResumeBindingSchema = z.strictObject({
  sessionId: SessionIdSchema,
  attachmentId: AttachmentIdSchema,
  appId: AppIdSchema,
  subject: SubjectIdSchema,
  runtimeId: RuntimeIdSchema,
  expiresAtMs: UnixTimeMillisecondsSchema,
});
export type AttachmentResumeBinding = z.infer<typeof AttachmentResumeBindingSchema>;

export const PublicOperationNameSchema = z.enum([
  "createSession",
  "listSessions",
  "getSession",
  "startSession",
  "stopSession",
  "forgetSession",
  "openAttachment",
  "resumeAttachment",
  "closeAttachment",
  "requestSnapshot",
  "resyncAttachment",
  "acquireControl",
  "requestControl",
  "approveControl",
  "rejectControl",
  "acceptControl",
  "preemptControl",
  "releaseControl",
  "sendInput",
  "resizeTerminal",
  "readEvents",
  "waitForEvents",
]);
