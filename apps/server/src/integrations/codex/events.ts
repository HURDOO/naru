import { CodexSessionIdSchema, PaneActivityStateSchema } from "@naru/contracts";
import { z } from "zod";

const HookSourceSchema = z.enum(["startup", "resume", "clear"]);
export type CodexSessionHookSource = z.infer<typeof HookSourceSchema>;

const HookCommonSchema = {
  sessionId: CodexSessionIdSchema,
  cwd: z.string().min(1).max(4_096),
};

export const CodexHookEventSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("session-start"),
    ...HookCommonSchema,
    source: HookSourceSchema,
  }),
  z.strictObject({
    type: z.literal("turn-start"),
    ...HookCommonSchema,
    turnId: z.string().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal("interaction-required"),
    ...HookCommonSchema,
    turnId: z.string().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal("turn-running"),
    ...HookCommonSchema,
    turnId: z.string().min(1).max(128),
  }),
  z.strictObject({
    type: z.literal("turn-completed"),
    ...HookCommonSchema,
    turnId: z.string().min(1).max(128),
  }),
]);
export type CodexHookEvent = z.infer<typeof CodexHookEventSchema>;

const IntegrationEventBase = {
  version: z.literal(1),
  integrationKind: z.literal("codex"),
  paneId: z.string().uuid(),
  hostSessionId: z.string().uuid(),
  runtimeId: z.string().uuid(),
  occurredAtMs: z.number().int().nonnegative(),
} as const;

export const CodexIntegrationEventV1Schema = z.discriminatedUnion("eventKind", [
  z.strictObject({
    ...IntegrationEventBase,
    eventKind: z.literal("runtime.bound"),
  }),
  z.strictObject({
    ...IntegrationEventBase,
    eventKind: z.literal("launch.requested"),
    profileId: z.enum(["codex-main", "codex-quick"]),
    recovery: z.enum(["new", "semantic-resume"]),
  }),
  z.strictObject({
    ...IntegrationEventBase,
    eventKind: z.literal("session.identified"),
    codexSessionId: CodexSessionIdSchema,
    source: HookSourceSchema.or(z.literal("status")).or(z.literal("exit-hint")),
    resumable: z.boolean(),
  }),
  z.strictObject({
    ...IntegrationEventBase,
    eventKind: z.literal("session.cleared"),
    source: z.literal("transition"),
  }),
  z.strictObject({
    ...IntegrationEventBase,
    eventKind: z.literal("activity.changed"),
    state: PaneActivityStateSchema,
  }),
]);

export type CodexIntegrationEventV1 = z.infer<typeof CodexIntegrationEventV1Schema>;
