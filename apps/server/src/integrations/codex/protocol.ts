import { z } from "zod";
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
]);
export type CodexIntegrationRequest = z.infer<typeof CodexIntegrationRequestSchema>;

const LaunchPlanSchema = z.strictObject({
  executable: z.string().min(1).max(4_096),
  args: z.array(z.string().max(16_384)).max(256),
});

export const CodexIntegrationReplySchema = z.union([
  z.strictObject({
    version: z.literal(1),
    ok: z.literal(true),
    type: z.literal("launch"),
    plan: LaunchPlanSchema,
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
    ok: z.literal(false),
    code: z.enum(["INVALID", "DENIED", "UNAVAILABLE"]),
  }),
]);
export type CodexIntegrationReply = z.infer<typeof CodexIntegrationReplySchema>;

export const NARU_CODEX_INTEGRATION_SOCKET_ENV = "NARU_CODEX_INTEGRATION_SOCKET" as const;
