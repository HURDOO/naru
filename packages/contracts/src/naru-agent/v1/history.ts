import { z } from "zod";
import { AgentHistoryPageSchema, AgentHistoryQuerySchema } from "./index.js";

/**
 * Reading an agent's conversation newest first (AP-D045). Naru re-reads it from the runtime and
 * does not store it (AP-D002). This module stays apart from the v1 index and extends its history
 * schemas: code the Host runs imports the index, and its bundled form (what the index exports to
 * other chunks included) must not change, or an upgrade restarts the Host.
 *
 * - `cursor` (or nothing): forward from there (or from the start), as `AgentHistoryQuerySchema`.
 * - `latest`: the newest page.
 * - `before`: the page that ends where a page read newest first starts (its `previousCursor`).
 */
export const AgentHistoryReadSchema = AgentHistoryQuerySchema.extend({
  before: z.string().min(1).max(1_024).optional(),
  /** "1": the newest page, as the events read (`AgentEventsQuerySchema`). */
  latest: z.literal("1").optional(),
}).refine(
  (read) =>
    [read.cursor, read.before, read.latest].filter((value) => value !== undefined).length <= 1,
  { message: "Use one of cursor, before and latest." },
);
export type AgentHistoryRead = z.infer<typeof AgentHistoryReadSchema>;

export const AgentHistoryWindowSchema = AgentHistoryPageSchema.extend({
  /** Reads this page again forward, with what was added after it; null is the start. */
  cursor: z.string().max(1_024).nullable(),
  /**
   * `before` for the page before this one. Null when this page starts the conversation, and for a
   * forward read: a runner an earlier Naru or Host started answers `latest` with its first page.
   * Opaque: Claude's offsets and Codex's own cursors (AP-D046) both travel in it.
   */
  previousCursor: z.string().max(1_024).nullable(),
});
export type AgentHistoryWindow = z.infer<typeof AgentHistoryWindowSchema>;
