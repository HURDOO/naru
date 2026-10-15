import { z } from "zod";

/**
 * Private channel between a runtime runner (Host-owned, may outlive Naru) and Naru. Newline-
 * delimited JSON over an owner-only UDS. The runner authenticates with a launch token that only
 * the runner process holds (never the agent's tools). Events carry identities and outcomes, never
 * conversation text (AP-D002); history is fetched on request and not stored.
 */
export const RUNTIME_CHANNEL_VERSION = 1 as const;
export const NARU_RUNTIME_SOCKET_ENV = "NARU_RUNTIME_SOCKET";
export const NARU_RUNTIME_TOKEN_ENV = "NARU_RUNTIME_TOKEN";

const Id = z.string().min(1).max(200);

export const RuntimeEventSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("conversation-ready"), runtimeSessionRef: Id }),
  z.strictObject({ type: z.literal("turn-started"), turnId: Id.nullable() }),
  z.strictObject({
    type: z.literal("turn-ended"),
    turnId: Id.nullable(),
    outcome: z.enum(["completed", "interrupted", "failed"]),
  }),
  z.strictObject({
    type: z.literal("user-prompt"),
    source: z.literal("tui"),
    text: z.string().max(64_000),
    /** Lets Naru record a redelivered prompt once (idempotency key). */
    promptId: z.string().uuid().optional(),
  }),
  z.strictObject({
    type: z.literal("approval-requested"),
    requestId: Id,
    kind: z.enum(["command", "file", "tool", "permission", "question"]),
    /** What is asked (tool and command or path), shown to the person; never stored (AP-D017). */
    summary: z.string().max(300).optional(),
  }),
  z.strictObject({ type: z.literal("approval-resolved"), requestId: Id }),
  z.strictObject({
    type: z.literal("child-started"),
    childRef: Id,
    parentRef: z.string().max(200),
  }),
  z.strictObject({ type: z.literal("child-ended"), childRef: Id }),
  z.strictObject({ type: z.literal("exited"), reason: z.enum(["stopped", "crashed"]) }),
]);

export const RunnerMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("hello"),
    version: z.literal(RUNTIME_CHANNEL_VERSION),
    token: z.string().min(32).max(128),
    started: z.boolean(),
    runtimeSessionRef: Id.nullable(),
    busy: z.boolean(),
    pendingApprovals: z.array(Id).max(64),
  }),
  z.strictObject({
    type: z.literal("event"),
    seq: z.number().int().positive(),
    event: RuntimeEventSchema,
  }),
  z.strictObject({
    type: z.literal("history"),
    requestId: Id,
    items: z.array(z.unknown()).max(200),
    nextCursor: z.string().max(1_024).nullable(),
  }),
  z.strictObject({ type: z.literal("error"), requestId: Id.nullable(), code: z.string().max(80) }),
]);
export type RunnerMessage = z.infer<typeof RunnerMessageSchema>;

export const RunnerPlanSchema = z.strictObject({
  executable: z.string().min(1).max(4_096),
  sdkEntry: z.string().min(1).max(4_096),
  cwd: z.string().min(1).max(4_096),
  model: z.string().min(1).max(200),
  resumeRef: Id.nullable(),
  nativeName: z.string().min(1).max(64),
  settings: z.record(z.string(), z.unknown()),
  mcpServers: z.record(z.string(), z.unknown()),
  instructions: z.string().max(64_000),
  permissionMode: z.enum(["default", "acceptEdits", "plan"]),
  environment: z.record(z.string(), z.string()),
});
export type RunnerPlan = z.infer<typeof RunnerPlanSchema>;

/**
 * A managed Codex session's plan (AP-T13). The Codex relay in the Pane is its runner: it starts or
 * resumes the conversation thread with Naru's MCP server and the role guidance, then attaches the
 * real TUI to it.
 */
export const CodexRunnerPlanSchema = z.strictObject({
  runtime: z.literal("codex"),
  resumeRef: Id.nullable(),
  model: z.string().min(1).max(200),
  mcpServers: z.record(z.string().regex(/^[a-z_]{1,40}$/), z.unknown()),
  instructions: z.string().max(64_000),
});
export type CodexRunnerPlan = z.infer<typeof CodexRunnerPlanSchema>;
export type AnyRunnerPlan = RunnerPlan | CodexRunnerPlan;
export const AnyRunnerPlanSchema = z.union([RunnerPlanSchema, CodexRunnerPlanSchema]);

export const NaruMessageSchema = z.discriminatedUnion("type", [
  z.strictObject({
    type: z.literal("plan"),
    plan: AnyRunnerPlanSchema,
    ackedSeq: z.number().int().min(0),
  }),
  z.strictObject({ type: z.literal("ack"), seq: z.number().int().min(0) }),
  z.strictObject({ type: z.literal("send"), text: z.string().min(1).max(64_000) }),
  z.strictObject({ type: z.literal("interrupt") }),
  z.strictObject({
    type: z.literal("approval"),
    requestId: Id,
    decision: z.enum(["approve", "deny"]),
  }),
  z.strictObject({
    type: z.literal("history"),
    requestId: Id,
    cursor: z.string().max(1_024).nullable(),
  }),
  z.strictObject({ type: z.literal("stop") }),
  z.strictObject({ type: z.literal("rejected"), code: z.string().max(80) }),
  /** Live runtimes (Codex) gate their own TUI by Naru's current conversation writer. */
  z.strictObject({
    type: z.literal("writer"),
    writer: z.enum(["orchestrator", "gui", "tui", "none"]),
    generation: z.number().int().positive(),
  }),
]);
export type NaruMessage = z.infer<typeof NaruMessageSchema>;

export const MAX_CHANNEL_LINE_BYTES = 1024 * 1024;

/** Splits a byte stream into bounded JSON lines; oversize lines end the connection. */
export function lineReader(onLine: (line: string) => void, onOverflow: () => void) {
  let buffered = "";
  return (chunk: Buffer | string): void => {
    buffered += chunk.toString();
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline === -1) break;
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim() !== "") onLine(line);
    }
    if (Buffer.byteLength(buffered) > MAX_CHANNEL_LINE_BYTES) {
      buffered = "";
      onOverflow();
    }
  };
}
