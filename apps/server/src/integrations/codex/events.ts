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

const InteractionRequestIdSchema = z.union([z.string().min(1).max(128), z.number().int().safe()]);

/** Redacted, latest-only state from the Host-owned TUI/app-server relay. */
export const CodexInteractionSnapshotSchema = z
  .strictObject({
    streamId: z.string().uuid(),
    sequence: z.number().int().safe().nonnegative(),
    cwd: z.string().min(1).max(4_096),
    sessionId: CodexSessionIdSchema.nullable(),
    identity: z.enum(["unbound", "bound", "cleared"]),
    turnId: z.string().min(1).max(128).nullable(),
    phase: z.enum(["idle", "running", "completed", "canceled", "failed"]),
    pending: z
      .array(
        z.strictObject({
          requestId: InteractionRequestIdSchema,
          turnId: z.string().min(1).max(128).nullable(),
          kind: z.enum(["command", "file-change", "permissions", "user-input", "mcp-elicitation"]),
        }),
      )
      .max(64),
  })
  .refine(
    (snapshot) =>
      (snapshot.sessionId !== null && snapshot.identity === "bound") ||
      (snapshot.sessionId === null &&
        snapshot.identity !== "bound" &&
        snapshot.turnId === null &&
        snapshot.phase === "idle" &&
        snapshot.pending.length === 0),
    "An unbound Codex session cannot have an active turn or pending request.",
  );
export type CodexInteractionSnapshot = z.infer<typeof CodexInteractionSnapshotSchema>;

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
    source: HookSourceSchema.or(z.enum(["status", "exit-hint", "relay"])),
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
