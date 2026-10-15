import { z } from "zod";

/**
 * Naru Agent Platform v1 contract. See docs/agent-platform-v0/ARCHITECTURE.md §2 and DECISIONS
 * AP-D002 (what is stored verbatim) and AP-D005 (writer layers).
 */
export const NARU_AGENT_CONTRACT_VERSION = 1 as const;

export const NARU_AGENT_LIMITS = {
  instructionCharacters: 32_000,
  freeTextCharacters: 8_000,
  titleCharacters: 200,
  listItems: 64,
  listItemCharacters: 1_000,
  referenceCharacters: 1_024,
  eventReadLimit: 500,
} as const;

const Id = z.string().uuid();
export const AgentIdSchema = Id;
export const IdempotencyKeySchema = z.string().uuid();

const Title = z.string().trim().min(1).max(NARU_AGENT_LIMITS.titleCharacters);
const FreeText = z.string().max(NARU_AGENT_LIMITS.freeTextCharacters);
const TextList = z
  .array(z.string().trim().min(1).max(NARU_AGENT_LIMITS.listItemCharacters))
  .max(NARU_AGENT_LIMITS.listItems);
const Reference = z.string().trim().min(1).max(NARU_AGENT_LIMITS.referenceCharacters);
const Timestamp = z.string().datetime();

export const ActorKindSchema = z.enum(["human", "agent", "system"]);
export const ActorSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("human") }),
  z.strictObject({ kind: z.literal("agent"), agentSessionId: Id }),
  z.strictObject({ kind: z.literal("system") }),
]);
export type Actor = z.infer<typeof ActorSchema>;

export const AgentRoleSchema = z.enum([
  "main-orchestrator",
  "project-orchestrator",
  "worker",
  "reviewer",
  "specialist",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

export const AgentRuntimeSchema = z.enum(["codex", "claude", "opencode"]);
export type AgentRuntime = z.infer<typeof AgentRuntimeSchema>;

/** Only levels proven for the installed runtime may be recorded (INV-03, V04/V05). */
export const ObservationLevelSchema = z.enum(["none", "lifecycle", "transcript", "pty"]);
export const ConversationWriterSchema = z.enum(["none", "gui", "tui", "orchestrator"]);
export const AgentSessionStatusSchema = z.enum([
  "starting",
  "active",
  "idle",
  "stopped",
  "failed",
  "unknown",
]);

export const InstructionScopeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("global") }),
  z.strictObject({ kind: z.literal("project"), projectId: Id }),
  z.strictObject({ kind: z.literal("task"), projectId: Id, taskId: Id }),
  z.strictObject({ kind: z.literal("agent"), projectId: Id.nullable(), agentSessionId: Id }),
]);
export type InstructionScope = z.infer<typeof InstructionScopeSchema>;

/** Where a verbatim instruction entered Naru (AP-D002). */
export const InstructionChannelSchema = z.enum(["naru-ui", "tui", "mcp"]);

export const InstructionSchema = z.strictObject({
  id: Id,
  scope: InstructionScopeSchema,
  author: ActorSchema,
  channel: InstructionChannelSchema,
  /** Root human instruction; required for agent-authored delegations, null for human roots. */
  originUserInstructionId: Id.nullable(),
  supersedesId: Id.nullable(),
  /** Null after the user explicitly forgot this instruction (tombstone keeps references valid). */
  verbatim: z.string().max(NARU_AGENT_LIMITS.instructionCharacters).nullable(),
  forgottenAt: Timestamp.nullable(),
  createdAt: Timestamp,
});
export type Instruction = z.infer<typeof InstructionSchema>;

export const IntentContractBodySchema = z.strictObject({
  principles: TextList,
  allowedChoices: TextList,
  requireApprovalIf: TextList,
  forbidden: TextList,
});
export const IntentContractStatusSchema = z.enum(["proposed", "approved", "superseded"]);
export const IntentContractSchema = z.strictObject({
  id: Id,
  projectId: Id,
  version: z.number().int().positive(),
  status: IntentContractStatusSchema,
  body: IntentContractBodySchema,
  sourceInstructionId: Id,
  approvedByHandoffId: Id.nullable(),
  createdAt: Timestamp,
});
export type IntentContract = z.infer<typeof IntentContractSchema>;

export const PlanStatusSchema = z.enum(["draft", "active", "superseded"]);
export const PlanSchema = z.strictObject({
  id: Id,
  projectId: Id,
  version: z.number().int().positive(),
  status: PlanStatusSchema,
  ownerAgentSessionId: Id.nullable(),
  summary: FreeText,
  intentContractId: Id.nullable(),
  createdAt: Timestamp,
});
export type Plan = z.infer<typeof PlanSchema>;

export const AgentTaskStatusSchema = z.enum([
  "pending",
  "ready",
  "running",
  "blocked",
  "review",
  "done",
  "failed",
  "cancelled",
]);
export type AgentTaskStatus = z.infer<typeof AgentTaskStatusSchema>;

export const AgentTaskSchema = z.strictObject({
  id: Id,
  projectId: Id,
  planId: Id.nullable(),
  title: Title,
  purpose: FreeText,
  completionCriteria: TextList,
  status: AgentTaskStatusSchema,
  priority: z.number().int().min(0).max(1_000),
  assigneeAgentSessionId: Id.nullable(),
  originInstructionId: Id,
  intentContractId: Id.nullable(),
  dependsOn: z.array(Id).max(NARU_AGENT_LIMITS.listItems),
  revision: z.number().int().positive(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AgentTask = z.infer<typeof AgentTaskSchema>;

export const RunStatusSchema = z.enum([
  "starting",
  "running",
  "succeeded",
  "failed",
  "cancelled",
  "unknown",
]);
export const RunSchema = z.strictObject({
  id: Id,
  taskId: Id,
  agentSessionId: Id.nullable(),
  runtime: AgentRuntimeSchema,
  model: z.string().max(200).nullable(),
  status: RunStatusSchema,
  attempt: z.number().int().positive(),
  errorClass: z.string().max(80).nullable(),
  summary: FreeText.nullable(),
  startedAt: Timestamp,
  finishedAt: Timestamp.nullable(),
});
export type Run = z.infer<typeof RunSchema>;

export const AgentSessionSchema = z.strictObject({
  id: Id,
  projectId: Id.nullable(),
  role: AgentRoleSchema,
  runtime: AgentRuntimeSchema,
  /** Runtime-owned conversation identity (Codex thread, Claude session, OpenCode session). */
  runtimeSessionRef: Reference.nullable(),
  parentAgentSessionId: Id.nullable(),
  native: z.boolean(),
  observation: ObservationLevelSchema,
  conversationWriter: ConversationWriterSchema,
  humanHoldSince: Timestamp.nullable(),
  status: AgentSessionStatusSchema,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type AgentSession = z.infer<typeof AgentSessionSchema>;

export const HandoffKindSchema = z.enum([
  "design-deviation",
  "product-decision",
  "manual-test",
  "terminal-control",
  "security-or-external",
]);
export const HandoffOptionSchema = z.strictObject({
  label: Title,
  description: FreeText,
});
/** SOURCE_SPEC §9.2: a handoff must carry a prepared question, never a bare "what now?". */
export const HandoffPayloadSchema = z.strictObject({
  reason: z.string().trim().min(1).max(NARU_AGENT_LIMITS.freeTextCharacters),
  blockingTaskIds: z.array(Id).max(NARU_AGENT_LIMITS.listItems),
  independentWorkToContinue: TextList,
  options: z.array(HandoffOptionSchema).max(8),
  recommendation: z.string().trim().min(1).max(NARU_AGENT_LIMITS.freeTextCharacters),
  risks: TextList,
  preparedEnvironment: TextList,
  resumeCondition: z.string().trim().min(1).max(NARU_AGENT_LIMITS.freeTextCharacters),
});
export type HandoffPayload = z.infer<typeof HandoffPayloadSchema>;
export const HandoffStatusSchema = z.enum(["open", "resolved", "cancelled"]);
export const HandoffResolutionSchema = z.strictObject({
  decision: z.string().trim().min(1).max(NARU_AGENT_LIMITS.instructionCharacters),
  chosenOption: Title.nullable(),
});
export const HandoffSchema = z.strictObject({
  id: Id,
  projectId: Id.nullable(),
  kind: HandoffKindSchema,
  status: HandoffStatusSchema,
  requestedBy: ActorSchema,
  payload: HandoffPayloadSchema,
  resolution: HandoffResolutionSchema.nullable(),
  createdAt: Timestamp,
  resolvedAt: Timestamp.nullable(),
});
export type Handoff = z.infer<typeof HandoffSchema>;

export const ReviewKindSchema = z.enum(["correctness", "intent"]);
export const ReviewVerdictSchema = z.enum(["pass", "needs-changes", "fail"]);
export const ReviewSchema = z.strictObject({
  id: Id,
  taskId: Id,
  runId: Id.nullable(),
  reviewerAgentSessionId: Id.nullable(),
  kind: ReviewKindSchema,
  verdict: ReviewVerdictSchema,
  findings: FreeText,
  createdAt: Timestamp,
});
export type Review = z.infer<typeof ReviewSchema>;

export const ArtifactKindSchema = z.enum([
  "commit",
  "branch",
  "file",
  "test-result",
  "document",
  "url",
  "report",
]);
export const ArtifactSchema = z.strictObject({
  id: Id,
  taskId: Id,
  runId: Id.nullable(),
  kind: ArtifactKindSchema,
  reference: Reference,
  summary: FreeText.nullable(),
  exitCode: z.number().int().nullable(),
  createdAt: Timestamp,
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const AgentEventTypeSchema = z.enum([
  "instruction.created",
  "instruction.forgotten",
  "intent_contract.proposed",
  "intent_contract.approved",
  "plan.created",
  "task.created",
  "task.updated",
  "run.started",
  "run.progress",
  "run.finished",
  "agent_session.registered",
  "agent_session.updated",
  "agent_session.hold_started",
  "agent_session.hold_released",
  "handoff.requested",
  "handoff.resolved",
  "handoff.cancelled",
  "review.submitted",
  "artifact.published",
]);
export type AgentEventType = z.infer<typeof AgentEventTypeSchema>;

const EventDataValue = z.union([z.string().max(200), z.number(), z.boolean(), z.null()]);
/** Events carry references and enums only; content stays in its domain row (AP-D002). */
export const AgentEventSchema = z.strictObject({
  seq: z.number().int().positive(),
  id: Id,
  type: AgentEventTypeSchema,
  projectId: Id.nullable(),
  actor: ActorSchema,
  subjectId: Id,
  correlationId: Id.nullable(),
  data: z.record(z.string().max(64), EventDataValue),
  createdAt: Timestamp,
});
export type AgentEvent = z.infer<typeof AgentEventSchema>;

export const AgentPlatformErrorCodeSchema = z.enum([
  "AGENT_NOT_FOUND",
  "AGENT_SCOPE_DENIED",
  "AGENT_ROLE_DENIED",
  "AGENT_HELD_BY_HUMAN",
  "AGENT_REVISION_STALE",
  "AGENT_IDEMPOTENCY_CONFLICT",
  "AGENT_INVALID_REFERENCE",
  "AGENT_INVALID_STATE",
  "AGENT_DEPENDENCY_CYCLE",
]);
export type AgentPlatformErrorCode = z.infer<typeof AgentPlatformErrorCodeSchema>;

export const AgentCommandNameSchema = z.enum([
  "state.read",
  "instruction.delegate",
  "intent_contract.propose",
  "plan.create",
  "task.create",
  "task.update",
  "task.update_own_status",
  "run.start",
  "run.finish",
  "run.report_progress",
  "agent_session.register",
  "handoff.request",
  "handoff.cancel",
  "review.submit",
  "artifact.publish",
]);
export type AgentCommandName = z.infer<typeof AgentCommandNameSchema>;

/**
 * Initial per-role command policy for agent actors (ARCHITECTURE §4). Human-only commands such as
 * approving an intent contract, resolving a handoff, forgetting an instruction or holding an agent
 * are not grantable to agents at all.
 */
export const AGENT_ROLE_COMMANDS: Readonly<Record<AgentRole, readonly AgentCommandName[]>> = {
  "main-orchestrator": [
    "state.read",
    "instruction.delegate",
    "agent_session.register",
    "handoff.request",
    "handoff.cancel",
  ],
  "project-orchestrator": [
    "state.read",
    "instruction.delegate",
    "intent_contract.propose",
    "plan.create",
    "task.create",
    "task.update",
    "run.start",
    "run.finish",
    "run.report_progress",
    "agent_session.register",
    "handoff.request",
    "handoff.cancel",
    "artifact.publish",
  ],
  worker: [
    "state.read",
    "task.update_own_status",
    "run.finish",
    "run.report_progress",
    "handoff.request",
    "handoff.cancel",
    "artifact.publish",
  ],
  reviewer: ["state.read", "review.submit", "handoff.request", "handoff.cancel"],
  specialist: [
    "state.read",
    "run.report_progress",
    "handoff.request",
    "handoff.cancel",
    "artifact.publish",
  ],
};

/** Statuses a worker may set on a task assigned to it; completion goes through review. */
export const WORKER_TASK_STATUSES = ["running", "blocked", "review"] as const;
