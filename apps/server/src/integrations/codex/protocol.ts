import { z } from "zod";
import { ClaudeActivityEventSchema } from "../../claude-activity-events.js";
import { CodexHookEventSchema, CodexInteractionSnapshotSchema } from "./events.js";

const BootstrapSchema = z
  .string()
  .min(64)
  .max(16 * 1024);

export const CodexIntegrationRequestSchema = z.discriminatedUnion("type", [
  z.strictObject({
    version: z.literal(1),
    type: z.literal("launch"),
    bootstrap: BootstrapSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("hook"),
    bootstrap: BootstrapSchema,
    event: CodexHookEventSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("interaction"),
    bootstrap: BootstrapSchema,
    snapshot: CodexInteractionSnapshotSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("claude-launch"),
    bootstrap: BootstrapSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    type: z.literal("claude-hook"),
    bootstrap: BootstrapSchema,
    event: ClaudeActivityEventSchema,
  }),
]);
export type CodexIntegrationRequest = z.infer<typeof CodexIntegrationRequestSchema>;

const LaunchPlanSchema = z.strictObject({
  executable: z.string().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(256),
});
/** Only the managed agent runner channel may be added to a launched process (AP-T14). */
export const LaunchEnvironmentSchema = z.strictObject({
  NARU_RUNTIME_SOCKET: z.string().min(1).max(4_096),
  NARU_RUNTIME_TOKEN: z.string().min(32).max(128),
});
/** Additive: older launchers ignore `environment`; only managed agent Panes get it. */
const ClaudeLaunchPlanSchema = LaunchPlanSchema.extend({
  environment: LaunchEnvironmentSchema.optional(),
});

export const CodexIntegrationReplySchema = z.union([
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(true),
    type: z.literal("launch"),
    plan: ClaudeLaunchPlanSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(true),
    type: z.literal("hook"),
  }),
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(true),
    type: z.literal("interaction"),
  }),
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(true),
    type: z.literal("claude-launch"),
    plan: ClaudeLaunchPlanSchema,
  }),
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(true),
    type: z.literal("claude-hook"),
  }),
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(false),
    code: z.enum(["INVALID", "DENIED", "UNAVAILABLE"]),
  }),
]);
export type CodexIntegrationReply = z.infer<typeof CodexIntegrationReplySchema>;

export const NARU_CODEX_INTEGRATION_SOCKET_ENV = "NARU_CODEX_INTEGRATION_SOCKET" as const;
