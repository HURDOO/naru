import { z } from "zod";
import {
  AttachmentIdSchema,
  BoundedIdentifierSchema,
  BoundedTerminalDataSchema,
  ControlOfferIdSchema,
  ControlRequestIdSchema,
  ControllerGenerationSchema,
  DURABLE_SESSION_LIMITS,
  DurableSessionProtocolVersionSchema,
  EventIdSchema,
  JsonValueSchema,
  RedactedReasonCodeSchema,
  RuntimeIdSchema,
  SessionIdSchema,
  SessionLifecycleSchema,
  SessionRevisionSchema,
  TerminalSequenceSchema,
  TerminalSizeSchema,
  UnixTimeMillisecondsSchema,
} from "./common.js";

export const ControlRequestViewSchema = z.strictObject({
  controlRequestId: ControlRequestIdSchema,
  requesterAttachmentId: AttachmentIdSchema,
  controllerGeneration: ControllerGenerationSchema,
  expiresAtMs: UnixTimeMillisecondsSchema,
});
export type ControlRequestView = z.infer<typeof ControlRequestViewSchema>;

export const ControlOfferViewSchema = z.strictObject({
  controlOfferId: ControlOfferIdSchema,
  controlRequestId: ControlRequestIdSchema,
  requesterAttachmentId: AttachmentIdSchema,
  controllerAttachmentId: AttachmentIdSchema,
  controllerGeneration: ControllerGenerationSchema,
  expiresAtMs: UnixTimeMillisecondsSchema,
});
export type ControlOfferView = z.infer<typeof ControlOfferViewSchema>;

export const ControlRequestResolutionSchema = z.enum([
  "approved",
  "rejected",
  "expired",
  "controller-changed",
  "requester-closed",
]);
export type ControlRequestResolution = z.infer<typeof ControlRequestResolutionSchema>;

const EventBaseShape = {
  version: DurableSessionProtocolVersionSchema,
  eventId: EventIdSchema,
  sessionId: SessionIdSchema,
  occurredAtMs: UnixTimeMillisecondsSchema,
} as const;

export const SessionChangedEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("session.changed"),
  sessionRevision: SessionRevisionSchema,
  lifecycle: SessionLifecycleSchema,
  runtimeId: RuntimeIdSchema.nullable(),
});

export const TerminalSnapshotEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("terminal.snapshot"),
  runtimeId: RuntimeIdSchema,
  sequence: TerminalSequenceSchema,
  terminal: TerminalSizeSchema,
  serializedState: z.string().max(DURABLE_SESSION_LIMITS.terminalStateCharacters),
});

export const TerminalOutputEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("terminal.output"),
  runtimeId: RuntimeIdSchema,
  sequence: TerminalSequenceSchema,
  data: BoundedTerminalDataSchema,
});

export const TerminalExitedEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("terminal.exited"),
  runtimeId: RuntimeIdSchema,
  sessionRevision: SessionRevisionSchema,
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nonnegative().nullable(),
});

export const AttachmentResyncRequiredEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("attachment.resync-required"),
  attachmentId: AttachmentIdSchema,
  runtimeId: RuntimeIdSchema,
  afterSequence: TerminalSequenceSchema,
  reason: z.enum(["queue-overflow", "cursor-expired", "runtime-changed"]),
});

export const ControlRequestedEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("control.requested"),
  controllerGeneration: ControllerGenerationSchema,
  request: ControlRequestViewSchema,
});

export const ControlOfferedEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("control.offered"),
  controllerGeneration: ControllerGenerationSchema,
  offer: ControlOfferViewSchema,
});

export const ControlRequestResolvedEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("control.request-resolved"),
  controllerGeneration: ControllerGenerationSchema,
  controlRequestId: ControlRequestIdSchema,
  resolution: ControlRequestResolutionSchema,
});

export const ControlAvailableEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("control.available"),
  controllerGeneration: ControllerGenerationSchema,
});

export const ControlChangedEventSchema = z.strictObject({
  ...EventBaseShape,
  type: z.literal("control.changed"),
  controllerGeneration: ControllerGenerationSchema,
  previousControllerAttachmentId: AttachmentIdSchema.nullable(),
  controllerAttachmentId: AttachmentIdSchema.nullable(),
  terminal: TerminalSizeSchema,
  reason: z.enum(["acquired", "transferred", "preempted", "released", "expired", "closed"]),
});

export const IntegrationEventSchema = z
  .strictObject({
    ...EventBaseShape,
    type: z.literal("integration.event"),
    runtimeId: RuntimeIdSchema.nullable(),
    integrationKind: BoundedIdentifierSchema,
    eventKind: BoundedIdentifierSchema,
    payload: z.record(z.string().min(1).max(128), JsonValueSchema),
  })
  .superRefine((value, context) => {
    const encoded = JSON.stringify(value.payload);
    if (
      new TextEncoder().encode(encoded).byteLength > DURABLE_SESSION_LIMITS.integrationConfigBytes
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message: "Integration event payload is too large.",
      });
    }
  });

export const DurableSessionEventSchema = z.discriminatedUnion("type", [
  SessionChangedEventSchema,
  TerminalSnapshotEventSchema,
  TerminalOutputEventSchema,
  TerminalExitedEventSchema,
  AttachmentResyncRequiredEventSchema,
  ControlRequestedEventSchema,
  ControlOfferedEventSchema,
  ControlRequestResolvedEventSchema,
  ControlAvailableEventSchema,
  ControlChangedEventSchema,
  IntegrationEventSchema,
]);
export type DurableSessionEvent = z.infer<typeof DurableSessionEventSchema>;

export const DurableSessionJournalEventSchema = z.discriminatedUnion("type", [
  SessionChangedEventSchema,
  TerminalExitedEventSchema,
  ControlRequestedEventSchema,
  ControlOfferedEventSchema,
  ControlRequestResolvedEventSchema,
  ControlAvailableEventSchema,
  ControlChangedEventSchema,
  IntegrationEventSchema,
]);
export type DurableSessionJournalEvent = z.infer<typeof DurableSessionJournalEventSchema>;

export const RedactedStopSummarySchema = z.strictObject({
  runtimeId: RuntimeIdSchema,
  reason: RedactedReasonCodeSchema,
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nonnegative().nullable(),
});
export type RedactedStopSummary = z.infer<typeof RedactedStopSummarySchema>;
