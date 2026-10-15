import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentRuntimeSchema,
  AgentTaskStatusSchema,
  ArtifactKindSchema,
  HandoffKindSchema,
  NARU_AGENT_LIMITS,
  ReviewKindSchema,
  ReviewVerdictSchema,
  type Actor,
  type InstructionScope,
} from "@naru/contracts/naru-agent/v1";
import { AgentPlatformError, type AgentPlatformCore } from "./core.js";

/**
 * Agent-facing tools (AP-D004 L1). The same zod schema validates socket input and produces the MCP
 * `inputSchema`. The acting agent always comes from the capability, never from arguments.
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  run(core: AgentPlatformCore, actor: Actor, input: unknown): unknown;
}

const Id = z.string().uuid();
const Text = (max: number = NARU_AGENT_LIMITS.freeTextCharacters) =>
  z.string().trim().min(1).max(max);
const List = z
  .array(z.string().trim().min(1).max(NARU_AGENT_LIMITS.listItemCharacters))
  .max(NARU_AGENT_LIMITS.listItems);
const IdempotencyKey = Id.optional().describe(
  "Reuse the same UUID when retrying this exact call so Naru applies it once.",
);

function readTool<S extends z.ZodObject>(
  name: string,
  description: string,
  input: S,
  run: (core: AgentPlatformCore, actor: Actor, input: z.infer<S>) => unknown,
): AgentTool {
  return {
    name,
    description,
    input,
    run: (core, actor, raw) => run(core, actor, input.parse(raw)),
  };
}

function writeTool<S extends z.ZodObject>(
  name: string,
  description: string,
  shape: S,
  run: (
    core: AgentPlatformCore,
    context: { actor: Actor; idempotencyKey: string },
    input: z.infer<S>,
  ) => unknown,
): AgentTool {
  const input = shape.extend({ idempotency_key: IdempotencyKey }).strict();
  return {
    name,
    description,
    input,
    run: (core, actor, raw) => {
      const parsed = input.parse(raw) as z.infer<S> & { idempotency_key?: string };
      return run(core, { actor, idempotencyKey: parsed.idempotency_key ?? randomUUID() }, parsed);
    },
  };
}

const HandoffFields = {
  project_id: Id.nullable().describe("Project the question belongs to; null only for global work."),
  reason: Text().describe("Why a human is needed now."),
  blocking_task_ids: z.array(Id).max(NARU_AGENT_LIMITS.listItems),
  independent_work_to_continue: List.describe("Work that continues while waiting."),
  options: z
    .array(z.strictObject({ label: Text(NARU_AGENT_LIMITS.titleCharacters), description: Text() }))
    .max(8),
  recommendation: Text(),
  risks: List,
  prepared_environment: List.describe("Ready-to-use servers, URLs or steps for the human."),
  resume_condition: Text(),
};

function handoffPayload(input: {
  reason: string;
  blocking_task_ids: string[];
  independent_work_to_continue: string[];
  options: { label: string; description: string }[];
  recommendation: string;
  risks: string[];
  prepared_environment: string[];
  resume_condition: string;
}) {
  return {
    reason: input.reason,
    blockingTaskIds: input.blocking_task_ids,
    independentWorkToContinue: input.independent_work_to_continue,
    options: input.options,
    recommendation: input.recommendation,
    risks: input.risks,
    preparedEnvironment: input.prepared_environment,
    resumeCondition: input.resume_condition,
  };
}

function ownProject(core: AgentPlatformCore, actor: Actor, projectId: string | undefined): string {
  if (projectId !== undefined) return projectId;
  if (actor.kind === "agent") {
    const session = core.getAgentSession(actor, actor.agentSessionId);
    if (session.projectId !== null) return session.projectId;
  }
  throw new AgentPlatformError("AGENT_SCOPE_DENIED", "project_id is required for this agent.");
}

export const AGENT_TOOLS: readonly AgentTool[] = [
  readTool(
    "get_project_state",
    "Read the approved intent contract, active plan, tasks and open handoffs of a project.",
    z.strictObject({ project_id: Id.optional() }),
    (core, actor, input) => core.getProjectState(actor, ownProject(core, actor, input.project_id)),
  ),
  readTool(
    "get_applicable_user_instructions",
    "Read the verbatim user instructions in force for you (global, project, task and your own). " +
      "The latest user instruction wins over agent reinterpretations.",
    z.strictObject({ project_id: Id.optional(), task_id: Id.optional() }),
    (core, actor, input) =>
      core.getApplicableInstructions(actor, {
        projectId:
          input.project_id ?? (actor.kind === "agent" ? ownProjectOrNull(core, actor) : null),
        ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
        ...(actor.kind === "agent" ? { agentSessionId: actor.agentSessionId } : {}),
      }),
  ),
  writeTool(
    "delegate",
    "Send a delegation message. It must cite the original user instruction it serves. Fails with " +
      "AGENT_HELD_BY_HUMAN while a human works directly with the target agent.",
    z.strictObject({
      scope_kind: z.enum(["project", "task", "agent"]),
      project_id: Id,
      task_id: Id.optional(),
      agent_session_id: Id.optional(),
      verbatim: Text(NARU_AGENT_LIMITS.instructionCharacters),
      origin_user_instruction_id: Id,
    }),
    (core, context, input) => {
      let scope: InstructionScope;
      if (input.scope_kind === "task") {
        if (input.task_id === undefined) throw invalid("task_id");
        scope = { kind: "task", projectId: input.project_id, taskId: input.task_id };
      } else if (input.scope_kind === "agent") {
        if (input.agent_session_id === undefined) throw invalid("agent_session_id");
        scope = {
          kind: "agent",
          projectId: input.project_id,
          agentSessionId: input.agent_session_id,
        };
      } else {
        scope = { kind: "project", projectId: input.project_id };
      }
      return core.delegate(context, {
        scope,
        verbatim: input.verbatim,
        originUserInstructionId: input.origin_user_instruction_id,
      });
    },
  ),
  writeTool(
    "propose_intent_contract",
    "Propose the project's intent contract for user approval.",
    z.strictObject({
      project_id: Id,
      principles: List,
      allowed_choices: List,
      require_approval_if: List,
      forbidden: List,
      source_instruction_id: Id,
    }),
    (core, context, input) =>
      core.proposeIntentContract(context, {
        projectId: input.project_id,
        body: {
          principles: input.principles,
          allowedChoices: input.allowed_choices,
          requireApprovalIf: input.require_approval_if,
          forbidden: input.forbidden,
        },
        sourceInstructionId: input.source_instruction_id,
      }),
  ),
  writeTool(
    "create_plan",
    "Record a new plan version for a project.",
    z.strictObject({ project_id: Id, summary: Text(), activate: z.boolean() }),
    (core, context, input) =>
      core.createPlan(context, {
        projectId: input.project_id,
        summary: input.summary,
        activate: input.activate,
      }),
  ),
  writeTool(
    "create_task",
    "Create a task. origin_instruction_id must be the user instruction this task serves.",
    z.strictObject({
      project_id: Id,
      plan_id: Id.optional(),
      title: Text(NARU_AGENT_LIMITS.titleCharacters),
      purpose: z.string().max(NARU_AGENT_LIMITS.freeTextCharacters),
      completion_criteria: List,
      priority: z.number().int().min(0).max(1_000).optional(),
      assignee_agent_session_id: Id.optional(),
      origin_instruction_id: Id,
      depends_on: z.array(Id).max(NARU_AGENT_LIMITS.listItems).optional(),
    }),
    (core, context, input) =>
      core.createTask(context, {
        projectId: input.project_id,
        ...(input.plan_id === undefined ? {} : { planId: input.plan_id }),
        title: input.title,
        purpose: input.purpose,
        completionCriteria: input.completion_criteria,
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.assignee_agent_session_id === undefined
          ? {}
          : { assigneeAgentSessionId: input.assignee_agent_session_id }),
        originInstructionId: input.origin_instruction_id,
        ...(input.depends_on === undefined ? {} : { dependsOn: input.depends_on }),
      }),
  ),
  writeTool(
    "update_task",
    "Update a task at its current revision. Workers may only move their own task to running, " +
      "blocked or review.",
    z.strictObject({
      task_id: Id,
      expected_revision: z.number().int().positive(),
      status: AgentTaskStatusSchema.optional(),
      priority: z.number().int().min(0).max(1_000).optional(),
      assignee_agent_session_id: Id.nullable().optional(),
      depends_on: z.array(Id).max(NARU_AGENT_LIMITS.listItems).optional(),
    }),
    (core, context, input) =>
      core.updateTask(context, {
        taskId: input.task_id,
        expectedRevision: input.expected_revision,
        ...(input.status === undefined ? {} : { status: input.status }),
        ...(input.priority === undefined ? {} : { priority: input.priority }),
        ...(input.assignee_agent_session_id === undefined
          ? {}
          : { assigneeAgentSessionId: input.assignee_agent_session_id }),
        ...(input.depends_on === undefined ? {} : { dependsOn: input.depends_on }),
      }),
  ),
  writeTool(
    "start_run",
    "Record the start of a task attempt.",
    z.strictObject({
      task_id: Id,
      agent_session_id: Id.optional(),
      runtime: AgentRuntimeSchema,
      model: z.string().max(200).optional(),
    }),
    (core, context, input) =>
      core.startRun(context, {
        taskId: input.task_id,
        ...(input.agent_session_id === undefined ? {} : { agentSessionId: input.agent_session_id }),
        runtime: input.runtime,
        ...(input.model === undefined ? {} : { model: input.model }),
      }),
  ),
  writeTool(
    "report_progress",
    "Report a short progress summary for your run. Never include secrets.",
    z.strictObject({ run_id: Id, summary: Text() }),
    (core, context, input) =>
      core.reportProgress(context, { runId: input.run_id, summary: input.summary }),
  ),
  writeTool(
    "finish_run",
    "Finish your run with its real outcome.",
    z.strictObject({
      run_id: Id,
      status: z.enum(["succeeded", "failed", "cancelled"]),
      error_class: z.string().max(80).optional(),
      summary: Text().optional(),
    }),
    (core, context, input) =>
      core.finishRun(context, {
        runId: input.run_id,
        status: input.status,
        ...(input.error_class === undefined ? {} : { errorClass: input.error_class }),
        ...(input.summary === undefined ? {} : { summary: input.summary }),
      }),
  ),
  writeTool(
    "request_human_handoff",
    "Ask the human for a decision, manual test, terminal control or approval. Prepare the " +
      "recommendation, options, risks and environment first, and keep doing independent work. " +
      "Use terminal_control when a password or other secret prompt appears; never type secrets.",
    z.strictObject({ kind: HandoffKindSchema, ...HandoffFields }),
    (core, context, input) =>
      core.requestHandoff(context, {
        projectId: input.project_id,
        kind: input.kind,
        payload: handoffPayload(input),
      }),
  ),
  writeTool(
    "propose_design_change",
    "Report a deviation from the approved design or user intent (replacement UI, unofficial API, " +
      "reduced requirement). Related work waits for approval; independent work continues.",
    z.strictObject(HandoffFields),
    (core, context, input) =>
      core.requestHandoff(context, {
        projectId: input.project_id,
        kind: "design-deviation",
        payload: handoffPayload(input),
      }),
  ),
  writeTool(
    "cancel_handoff",
    "Withdraw a handoff you requested that is no longer needed.",
    z.strictObject({ handoff_id: Id }),
    (core, context, input) => core.cancelHandoff(context, { handoffId: input.handoff_id }),
  ),
  readTool(
    "get_handoff_status",
    "Read a handoff and, once resolved, the human decision.",
    z.strictObject({ handoff_id: Id }),
    (core, actor, input) => core.getHandoff(actor, input.handoff_id),
  ),
  writeTool(
    "submit_review",
    "Submit a correctness or intent review. Judge intent against the original user instructions " +
      "and approved contract, not only the worker's summary.",
    z.strictObject({
      task_id: Id,
      run_id: Id.optional(),
      kind: ReviewKindSchema,
      verdict: ReviewVerdictSchema,
      findings: Text(),
    }),
    (core, context, input) =>
      core.submitReview(context, {
        taskId: input.task_id,
        ...(input.run_id === undefined ? {} : { runId: input.run_id }),
        kind: input.kind,
        verdict: input.verdict,
        findings: input.findings,
      }),
  ),
  readTool(
    "get_merge_gate",
    "Check whether a task may be integrated: latest correctness and intent reviews must pass and no " +
      "open handoff may block it.",
    z.strictObject({ task_id: Id }),
    (core, actor, input) => core.mergeGate(actor, input.task_id),
  ),
  writeTool(
    "publish_artifact",
    "Record a commit, branch, file, test result, document, URL or report reference for a task.",
    z.strictObject({
      task_id: Id,
      run_id: Id.optional(),
      kind: ArtifactKindSchema,
      reference: Text(NARU_AGENT_LIMITS.referenceCharacters),
      summary: Text().optional(),
      exit_code: z.number().int().optional(),
    }),
    (core, context, input) =>
      core.publishArtifact(context, {
        taskId: input.task_id,
        ...(input.run_id === undefined ? {} : { runId: input.run_id }),
        kind: input.kind,
        reference: input.reference,
        ...(input.summary === undefined ? {} : { summary: input.summary }),
        ...(input.exit_code === undefined ? {} : { exitCode: input.exit_code }),
      }),
  ),
  readTool(
    "read_events",
    "Read Naru events after a sequence number in your scope. Events carry references only.",
    z.strictObject({
      after_seq: z.number().int().min(0),
      limit: z.number().int().min(1).max(NARU_AGENT_LIMITS.eventReadLimit).optional(),
    }),
    (core, actor, input) =>
      core.readEvents(actor, {
        afterSeq: input.after_seq,
        ...(input.limit === undefined ? {} : { limit: input.limit }),
      }),
  ),
];

function ownProjectOrNull(
  core: AgentPlatformCore,
  actor: Actor & { kind: "agent" },
): string | null {
  return core.getAgentSession(actor, actor.agentSessionId).projectId;
}

function invalid(field: string): AgentPlatformError {
  return new AgentPlatformError("AGENT_INVALID_REFERENCE", `${field} is required for this scope.`);
}

/** MCP `tools/list` entries derived from the same schemas. */
export function mcpToolDefinitions(): {
  name: string;
  description: string;
  inputSchema: unknown;
}[] {
  return AGENT_TOOLS.map((tool) => {
    const schema = z.toJSONSchema(tool.input) as Record<string, unknown>;
    delete schema.$schema;
    return { name: tool.name, description: tool.description, inputSchema: schema };
  });
}
