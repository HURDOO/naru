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

/**
 * Where a verbatim instruction entered Naru (AP-D002): Naru UI, a person typing in a managed TUI,
 * an agent's MCP delegation, or a native Claude message authorized by the Naru bridge (AP-D015).
 */
export const InstructionChannelSchema = z.enum(["naru-ui", "tui", "mcp", "native-message"]);

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

export const AgentLaunchModeSchema = z.enum(["runner", "tui"]);
export type AgentLaunchMode = z.infer<typeof AgentLaunchModeSchema>;

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
  /** Naru Pane whose Host PTY runs this agent (runner console or TUI); null until launched. */
  paneId: Id.nullable(),
  /** `runner`: Chat through the SDK runner. `tui`: the runtime's own TUI in the Pane (AP-D011). */
  launchMode: AgentLaunchModeSchema,
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
  "instruction.delivered",
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
  "shared_process.started",
  "shared_process.updated",
  "shared_process.hold_started",
  "shared_process.hold_released",
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
  "AGENT_RUNTIME_UNAVAILABLE",
  "AGENT_WRITER_REQUIRED",
]);
export type AgentPlatformErrorCode = z.infer<typeof AgentPlatformErrorCodeSchema>;

export const AgentCommandNameSchema = z.enum([
  "state.read",
  "instruction.delegate",
  "message.send",
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
  "process.start",
  "process.input",
  "process.read",
  "process.stop",
  "agent.spawn",
  "agent.interrupt",
  "pane.open",
  "workspace.worktree",
  "task.merge",
]);
export type AgentCommandName = z.infer<typeof AgentCommandNameSchema>;

/** Shared processes (AP-D006): start in the own project, write and read while not held, stop. */
const PROCESS_COMMANDS = [
  "process.start",
  "process.input",
  "process.read",
  "process.stop",
] as const satisfies readonly AgentCommandName[];

/**
 * Initial per-role command policy for agent actors (ARCHITECTURE §4). Human-only commands such as
 * approving an intent contract, resolving a handoff, forgetting an instruction or holding an agent
 * are not grantable to agents at all.
 */
export const AGENT_ROLE_COMMANDS: Readonly<Record<AgentRole, readonly AgentCommandName[]>> = {
  "main-orchestrator": [
    "state.read",
    "instruction.delegate",
    "message.send",
    "agent_session.register",
    "agent.spawn",
    "handoff.request",
    "handoff.cancel",
  ],
  "project-orchestrator": [
    "state.read",
    "instruction.delegate",
    "message.send",
    "intent_contract.propose",
    "plan.create",
    "task.create",
    "task.update",
    "run.start",
    "run.finish",
    "run.report_progress",
    "agent_session.register",
    "agent.spawn",
    "agent.interrupt",
    "handoff.request",
    "handoff.cancel",
    "artifact.publish",
    "pane.open",
    "workspace.worktree",
    "task.merge",
    ...PROCESS_COMMANDS,
  ],
  worker: [
    "state.read",
    "message.send",
    "task.update_own_status",
    "run.finish",
    "run.report_progress",
    "handoff.request",
    "handoff.cancel",
    "artifact.publish",
    "pane.open",
    ...PROCESS_COMMANDS,
  ],
  reviewer: [
    "state.read",
    "message.send",
    "review.submit",
    "handoff.request",
    "handoff.cancel",
    "process.read",
  ],
  specialist: [
    "state.read",
    "message.send",
    "run.report_progress",
    "handoff.request",
    "handoff.cancel",
    "artifact.publish",
    "pane.open",
    ...PROCESS_COMMANDS,
  ],
};

/**
 * A terminal process an agent started through Naru (AP-D006, SOURCE_SPEC SharedProcess): a dev
 * server or an interactive tool in a DurableSession Pane. Naru records it before the Host session
 * exists. The creating agent holds it; a person may hold it (AP-D005) and it returns afterwards.
 */
export const SharedProcessStatusSchema = z.enum([
  "starting",
  "running",
  "exited",
  "failed",
  "stopped",
  "unknown",
]);
/** `run`: stopped when the starting Run finishes. `keep`: kept until someone stops it (A08). */
export const SharedProcessKeepSchema = z.enum(["run", "keep"]);
export const SharedProcessSchema = z.strictObject({
  id: Id,
  projectId: Id,
  taskId: Id.nullable(),
  runId: Id.nullable(),
  agentSessionId: Id.nullable(),
  purpose: Title,
  /** Agent-written shell command, recorded verbatim (AP-D003). */
  command: z.string().min(1).max(NARU_AGENT_LIMITS.freeTextCharacters),
  ports: z.array(z.number().int().min(1).max(65_535)).max(8),
  keep: SharedProcessKeepSchema,
  paneId: Id.nullable(),
  humanHoldSince: Timestamp.nullable(),
  status: SharedProcessStatusSchema,
  exitCode: z.number().int().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type SharedProcess = z.infer<typeof SharedProcessSchema>;

/** Statuses a worker may set on a task assigned to it; completion goes through review. */
export const WORKER_TASK_STATUSES = ["running", "blocked", "review"] as const;

// Browser API (human actor) -----------------------------------------------------------------------

export const CreateHumanInstructionRequestSchema = z.strictObject({
  scope: InstructionScopeSchema,
  verbatim: z.string().trim().min(1).max(NARU_AGENT_LIMITS.instructionCharacters),
  supersedesId: Id.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type CreateHumanInstructionRequest = z.infer<typeof CreateHumanInstructionRequestSchema>;

export const IdempotentRequestSchema = z.strictObject({ idempotencyKey: IdempotencyKeySchema });

export const ResolveHandoffRequestSchema = z.strictObject({
  decision: z.string().trim().min(1).max(NARU_AGENT_LIMITS.instructionCharacters),
  chosenOption: Title.optional(),
  idempotencyKey: IdempotencyKeySchema,
});
export type ResolveHandoffRequest = z.infer<typeof ResolveHandoffRequestSchema>;

export const ApproveIntentContractRequestSchema = z.strictObject({
  handoffId: Id.optional(),
  idempotencyKey: IdempotencyKeySchema,
});

export const SetAgentHoldRequestSchema = z.strictObject({
  held: z.boolean(),
  idempotencyKey: IdempotencyKeySchema,
  /**
   * Where the person intervenes (AP-D005 "직접 개입"): Naru Chat, or the runtime's own TUI (for
   * Claude the conversation moves by stop-resume). Defaults to Chat. Ignored on release.
   */
  surface: z.enum(["chat", "tui"]).optional(),
  /** Interrupt a running turn instead of waiting for it to end. */
  interrupt: z.boolean().optional(),
});
export type SetAgentHoldRequest = z.infer<typeof SetAgentHoldRequestSchema>;

/**
 * A person starts a Naru-managed agent (its Pane joins a workspace collapsed). Project roles name
 * their project; the global main orchestrator names the project whose workspace hosts its Pane.
 */
export const CreateManagedAgentRequestSchema = z.union([
  z.strictObject({
    projectId: Id,
    role: z.enum(["project-orchestrator", "worker", "reviewer", "specialist"]),
    runtime: z.enum(["claude", "codex"]),
    idempotencyKey: IdempotencyKeySchema,
  }),
  z.strictObject({
    role: z.literal("main-orchestrator"),
    hostProjectId: Id,
    runtime: z.enum(["claude", "codex"]),
    idempotencyKey: IdempotencyKeySchema,
  }),
]);
export type CreateManagedAgentRequest = z.infer<typeof CreateManagedAgentRequestSchema>;

/** A person takes over (or returns) an agent's shared process terminal (AP-D005, A09). */
export const SetProcessHoldRequestSchema = z.strictObject({
  held: z.boolean(),
  idempotencyKey: IdempotencyKeySchema,
});

/** Writer generation the browser last saw; a stale one is fenced (INV-05). */
const WriterGeneration = z.number().int().positive();

export const AgentWriterSchema = z.enum(["orchestrator", "gui", "tui", "none"]);
export const AgentRuntimeStateSchema = z.strictObject({
  agentSessionId: Id,
  connected: z.boolean(),
  writer: AgentWriterSchema,
  generation: WriterGeneration,
  phase: z.enum([
    "active",
    "quiescing",
    "stopping",
    "resuming",
    "rolling-back",
    "recovery-required",
  ]),
  turnActive: z.boolean(),
  launchMode: AgentLaunchModeSchema,
  pendingApprovals: z
    .array(
      z.strictObject({
        requestId: z.string().min(1).max(200),
        kind: z.string().max(40),
        /** What is asked (tool and command or path); from the runtime, never stored (AP-D017). */
        summary: z.string().max(300).optional(),
      }),
    )
    .max(64),
  /** Native subagents running now: observed only (L1/L2, AP-D014), never controlled from Naru. */
  children: z
    .array(z.strictObject({ childRef: z.string().min(1).max(200), startedAt: Timestamp }))
    .max(64),
});
export type AgentRuntimeState = z.infer<typeof AgentRuntimeStateSchema>;

/** A person writing directly to the agent's conversation while holding it (recorded verbatim). */
export const AgentTurnRequestSchema = z.strictObject({
  text: z.string().trim().min(1).max(NARU_AGENT_LIMITS.instructionCharacters),
  generation: WriterGeneration,
  idempotencyKey: IdempotencyKeySchema,
});
export const AgentInterruptRequestSchema = z.strictObject({ generation: WriterGeneration });
/**
 * The person answers an approval (AP-D017). Since 2026-10-15 this works whoever writes the
 * conversation; `generation` is accepted for older clients and ignored.
 */
export const AgentApprovalResponseRequestSchema = z.strictObject({
  decision: z.enum(["approve", "deny"]),
  generation: WriterGeneration.optional(),
});
export const AgentHistoryQuerySchema = z.strictObject({
  cursor: z.string().min(1).max(1_024).optional(),
});
/** Re-read from the runtime's own history API; Naru does not store transcripts (AP-D002). */
export const AgentHistoryPageSchema = z.strictObject({
  items: z.array(z.unknown()).max(200),
  nextCursor: z.string().max(1_024).nullable(),
});

export const AgentEventsQuerySchema = z.strictObject({
  after: z.coerce.number().int().min(0).default(0),
  projectId: Id.optional(),
  limit: z.coerce.number().int().min(1).max(NARU_AGENT_LIMITS.eventReadLimit).optional(),
  /** "1": the newest `limit` events after `after`, still in ascending order (a view's first load). */
  latest: z.literal("1").optional(),
});

export const ProjectAgentSummarySchema = z.strictObject({
  projectId: Id,
  taskCounts: z.record(AgentTaskStatusSchema, z.number().int().min(0)),
  openHandoffs: z.number().int().min(0),
  agents: z.number().int().min(0),
  heldAgents: z.number().int().min(0),
});
export type ProjectAgentSummary = z.infer<typeof ProjectAgentSummarySchema>;

/**
 * A git worktree Naru made for a task (AP-D004 L5, AP-D016). It is connected as its own Naru project
 * so the user sees it; agents of the parent project may work in it.
 */
export const AgentWorktreeSchema = z.strictObject({
  projectId: Id,
  parentProjectId: Id,
  taskId: Id.nullable(),
  branch: z.string().min(1).max(200),
  createdByAgentSessionId: Id.nullable(),
  createdAt: Timestamp,
});
export type AgentWorktree = z.infer<typeof AgentWorktreeSchema>;

/** One task with its runs, reviews, artifacts and merge gate, for the Project graph (AP-T17). */
export const AgentTaskDetailSchema = z.strictObject({
  task: AgentTaskSchema,
  runs: z.array(RunSchema),
  reviews: z.array(ReviewSchema),
  artifacts: z.array(ArtifactSchema),
  mergeGate: z.strictObject({ open: z.boolean(), reasons: z.array(z.string().max(80)) }),
});
export type AgentTaskDetail = z.infer<typeof AgentTaskDetailSchema>;

export const AgentOverviewSchema = z.strictObject({
  projects: z.array(ProjectAgentSummarySchema),
  openHandoffs: z.array(HandoffSchema),
  globalAgents: z.array(AgentSessionSchema),
});
export type AgentOverview = z.infer<typeof AgentOverviewSchema>;

// Runtime capabilities (SOURCE_SPEC §7.3) --------------------------------------------------------

export const NativeSubagentTraceSchema = z.enum([
  "none",
  "lifecycle",
  "transcript",
  "interactive",
  "pty",
]);

/**
 * What the installed runtime version itself was proven to support (docs/agent-platform-v0/
 * VALIDATION.md). Unproven capabilities stay false/none. Whether Naru has enabled a capability
 * (adapter, write gate) is tracked separately; e.g. no runtime has a natively safe GUI/TUI switch.
 */
export const RuntimeCapabilitiesSchema = z.strictObject({
  runtime: AgentRuntimeSchema,
  versions: z.record(z.string().max(64), z.string().max(64)),
  structuredChat: z.boolean(),
  realTui: z.boolean(),
  liveTuiAttach: z.boolean(),
  safeGuiTuiTransition: z.boolean(),
  nativeSubagentTrace: NativeSubagentTraceSchema,
  nativeCrossSessionMessaging: z.boolean(),
  externalApprovalControl: z.boolean(),
  canBridgeToDurableSession: z.boolean(),
  /** Short human-readable limits shown next to the capability in the UI. */
  limits: z.array(z.string().max(300)).max(16),
  evidence: z.array(z.string().max(200)).max(16),
});
export type RuntimeCapabilities = z.infer<typeof RuntimeCapabilitiesSchema>;
