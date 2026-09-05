import { z } from "zod";
import {
  AttachmentIdSchema,
  ControllerGenerationSchema,
  DURABLE_SESSION_LIMITS,
  DurableSessionCallerContextSchema,
  DurableSessionErrorSchema,
  DurableSessionProtocolVersionSchema,
  RuntimeIdSchema,
  SessionIdSchema,
  UnixTimeMillisecondsSchema,
} from "./common.js";
import { DurableSessionEventSchema } from "./events.js";
import {
  DurableSessionOperationRequestSchema,
  DurableSessionOperationResponseSchema,
} from "./protocol.js";

export const DurableSessionStreamHelloSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.hello"),
  callerContext: DurableSessionCallerContextSchema,
});

export const DurableSessionStreamOperationSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.operation"),
  request: DurableSessionOperationRequestSchema,
});

export const DurableSessionStreamHeartbeatSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.heartbeat"),
  sessionId: SessionIdSchema,
  attachmentId: AttachmentIdSchema,
  expectedRuntimeId: RuntimeIdSchema,
  expectedControllerGeneration: ControllerGenerationSchema,
  sentAtMs: UnixTimeMillisecondsSchema,
});

export const DurableSessionStreamClientFrameSchema = z.discriminatedUnion("type", [
  DurableSessionStreamHelloSchema,
  DurableSessionStreamOperationSchema,
  DurableSessionStreamHeartbeatSchema,
]);
export type DurableSessionStreamClientFrame = z.infer<typeof DurableSessionStreamClientFrameSchema>;

export const DurableSessionStreamReadySchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.ready"),
  heartbeatIntervalMs: z.literal(DURABLE_SESSION_LIMITS.heartbeatIntervalMs),
  staleAfterMs: z.literal(DURABLE_SESSION_LIMITS.staleAfterMs),
  reconnectGraceMs: z.literal(DURABLE_SESSION_LIMITS.reconnectGraceMs),
});

export const DurableSessionStreamOperationResponseSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.operation-response"),
  response: DurableSessionOperationResponseSchema,
});

export const DurableSessionStreamAttachmentEventSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.attachment-event"),
  attachmentId: AttachmentIdSchema,
  event: DurableSessionEventSchema,
});
export type DurableSessionStreamAttachmentEvent = z.infer<
  typeof DurableSessionStreamAttachmentEventSchema
>;

export const DurableSessionStreamHeartbeatAckSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.heartbeat-ack"),
  sessionId: SessionIdSchema,
  attachmentId: AttachmentIdSchema,
  receivedAtMs: UnixTimeMillisecondsSchema,
  controllerGeneration: ControllerGenerationSchema,
});

export const DurableSessionStreamErrorSchema = z.strictObject({
  version: DurableSessionProtocolVersionSchema,
  type: z.literal("stream.error"),
  error: DurableSessionErrorSchema,
});

export const DurableSessionStreamServerFrameSchema = z.discriminatedUnion("type", [
  DurableSessionStreamReadySchema,
  DurableSessionStreamOperationResponseSchema,
  DurableSessionStreamAttachmentEventSchema,
  DurableSessionStreamHeartbeatAckSchema,
  DurableSessionStreamErrorSchema,
]);
export type DurableSessionStreamServerFrame = z.infer<typeof DurableSessionStreamServerFrameSchema>;
