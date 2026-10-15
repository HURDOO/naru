import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  AgentRuntimeSchema,
  AgentTaskStatusSchema,
  SharedProcessKeepSchema,
  ArtifactKindSchema,
  HandoffKindSchema,
  NARU_AGENT_LIMITS,
  ReviewKindSchema,
  ReviewVerdictSchema,
  type Actor,
  type AgentRuntimeState,
  type AgentSession,
  type Artifact,
  type InstructionScope,
  type SharedProcess,
} from "@naru/contracts/naru-agent/v1";
import { AgentPlatformError, type AgentPlatformCore, type CommandContext } from "./core.js";

/**
 * Runtime-backed operations (AP-D004 L2/L3) that need the Host or a runtime, not only Core. Absent
 * when Naru runs without managed runtimes; the tools then answer AGENT_RUNTIME_UNAVAILABLE.
 */
export interface AgentToolRuntime {
  readonly processes?: {
    start(
      context: CommandContext,
      input: Parameters<AgentPlatformCore["startSharedProcess"]>[1],
    ): Promise<SharedProcess>;
    input(context: CommandContext, processId: string, text: string): Promise<SharedProcess>;
    read(
      actor: Actor,
      processId: string,
      lines: number,
    ): Promise<{ readonly process: SharedProcess; readonly screen: string }>;
    stop(actor: Actor, processId: string): Promise<SharedProcess>;
  };
  readonly agents?: {
    spawn(
      context: CommandContext,
      input: {
        readonly projectId: string;
        readonly role: AgentSession["role"];
        readonly runtime: "claude" | "codex";
      },
    ): Promise<AgentSession>;
    interrupt(actor: Actor, agentSessionId: string): AgentRuntimeState;
  };
  /** Worktrees, view Panes and merge (AP-D004 L5/L6, AP-D016). */
  readonly workspace?: {
    createWorktree(
      context: CommandContext,
      input: { readonly taskId: string; readonly slug: string },
    ): Promise<{ readonly projectId: string; readonly path: string; readonly branch: string }>;
    merge(context: CommandContext, input: { readonly taskId: string }): Promise<Artifact>;
    openPane(
      context: CommandContext,
      input: {
        readonly projectId: string;
        readonly kind: "files" | "docs";
        readonly title: string;
        readonly path?: string;
      },
    ): Promise<{ readonly paneId: string; readonly projectId: string }>;
  };
}

/**
 * Agent-facing tools (AP-D004 L1). The same zod schema validates socket input and produces the MCP
 * `inputSchema`. The acting agent always comes from the capability, never from arguments.
 */
export interface AgentTool {
  readonly name: string;
  readonly description: string;
  readonly input: z.ZodType;
  run(core: AgentPlatformCore, actor: Actor, input: unknown, runtime?: AgentToolRuntime): unknown;
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
  run: (
    core: AgentPlatformCore,
    actor: Actor,
    input: z.infer<S>,
    runtime: AgentToolRuntime | undefined,
  ) => unknown,
): AgentTool {
  return {
    name,
    description,
    input,
    run: (core, actor, raw, runtime) => run(core, actor, input.parse(raw), runtime),
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
    runtime: AgentToolRuntime | undefined,
  ) => unknown,
): AgentTool {
  const input = shape.extend({ idempotency_key: IdempotencyKey }).strict();
  return {
    name,
    description,
    input,
    run: (core, actor, raw, runtime) => {
      const parsed = input.parse(raw) as z.infer<S> & { idempotency_key?: string };
      return run(
        core,
        { actor, idempotencyKey: parsed.idempotency_key ?? randomUUID() },
        parsed,
        runtime,
      );
    },
  };
}

function requireRuntime<K extends keyof AgentToolRuntime>(
  runtime: AgentToolRuntime | undefined,
  key: K,
): NonNullable<AgentToolRuntime[K]> {
  const part = runtime?.[key];
  if (part === undefined) {
    throw new AgentPlatformError(
      "AGENT_RUNTIME_UNAVAILABLE",
      "Naru runs without managed runtimes here.",
    );
  }
  return part;
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
    "list_projects",
    "Main orchestrator only: the user's connected projects with task, handoff and agent counts and " +
      "whether a project orchestrator is running.",
    z.strictObject({}),
    (core, actor) => core.listProjects(actor),
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
  readTool(
    "get_delegated_work",
    "Read the work given to you, your tasks or (project orchestrators) your project, verbatim, by " +
      "orchestrators or the user, and the original user instruction each one serves. Call it when " +
      "Naru wakes you.",
    z.strictObject({}),
    (core, actor) => core.getDelegatedWork(actor),
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
  writeTool(
    "start_process",
    "Run a long-lived or interactive command (dev server, ansible) in a terminal the user can see " +
      "in Naru. Naru records it first; use keep='run' to stop it when your run finishes. Never put " +
      "secrets in the command.",
    z.strictObject({
      project_id: Id.optional(),
      task_id: Id.optional(),
      run_id: Id.optional(),
      purpose: Text(NARU_AGENT_LIMITS.titleCharacters).describe("Short label shown to the user."),
      command: Text().describe("Shell command line, typed into a login shell in the project."),
      ports: z.array(z.number().int().min(1).max(65_535)).max(8).optional(),
      keep: SharedProcessKeepSchema.default("keep"),
    }),
    (core, context, input, runtime) =>
      requireRuntime(runtime, "processes").start(context, {
        projectId: ownProject(core, context.actor, input.project_id),
        ...(input.task_id === undefined ? {} : { taskId: input.task_id }),
        ...(input.run_id === undefined ? {} : { runId: input.run_id }),
        purpose: input.purpose,
        command: input.command,
        ports: input.ports ?? [],
        keep: input.keep,
      }),
  ),
  writeTool(
    "send_process_input",
    "Type into your own process (include \\r to press Enter); recorded verbatim. Fails with " +
      "AGENT_HELD_BY_HUMAN while the user holds it. Never type secrets: when a password or secret " +
      "is asked for, request a terminal-control handoff instead.",
    z.strictObject({ process_id: Id, text: z.string().min(1).max(4_096) }),
    (_core, context, input, runtime) =>
      requireRuntime(runtime, "processes").input(context, input.process_id, input.text),
  ),
  readTool(
    "read_process_screen",
    "Read the process's current screen and recent output as plain text (not stored by Naru).",
    z.strictObject({ process_id: Id, lines: z.number().int().min(1).max(400).optional() }),
    (_core, actor, input, runtime) =>
      requireRuntime(runtime, "processes").read(actor, input.process_id, input.lines ?? 80),
  ),
  readTool(
    "stop_process",
    "Stop a process you started (orchestrators may stop any process of their project).",
    z.strictObject({ process_id: Id }),
    (_core, actor, input, runtime) =>
      requireRuntime(runtime, "processes").stop(actor, input.process_id),
  ),
  readTool(
    "list_processes",
    "List the shared processes of a project with their status, ports and holder.",
    z.strictObject({ project_id: Id.optional() }),
    (core, actor, input) =>
      core.listSharedProcesses(actor, ownProject(core, actor, input.project_id)),
  ),
  writeTool(
    "spawn_agent",
    "Start a new Naru-managed agent session in a project (visible and controllable in Naru). Use it " +
      "for separate, long, shared-write or human-facing work instead of a native subagent; then " +
      "give it work with `delegate`.",
    z.strictObject({
      project_id: Id.optional(),
      role: z.enum(["project-orchestrator", "worker", "reviewer", "specialist"]),
      runtime: z
        .enum(["claude", "codex"])
        .default("claude")
        .describe("Which coding agent runs it; pick what the work and the user ask for."),
    }),
    (core, context, input, runtime) =>
      requireRuntime(runtime, "agents").spawn(context, {
        projectId: ownProject(core, context.actor, input.project_id),
        role: input.role,
        runtime: input.runtime,
      }),
  ),
  readTool(
    "list_agents",
    "List the Naru-managed agents of a project: role, runtime, status, parent and whether a person " +
      "holds them.",
    z.strictObject({ project_id: Id.optional() }),
    (core, actor, input) =>
      core.listAgentSessions(actor, ownProject(core, actor, input.project_id)),
  ),
  readTool(
    "get_task_detail",
    "Read a task with its runs, reviews, artifacts (branches, commits, test results) and merge gate.",
    z.strictObject({ task_id: Id }),
    (core, actor, input) => core.getTaskDetail(actor, input.task_id),
  ),
  readTool(
    "interrupt_agent",
    "Stop the running turn of a worker, reviewer or specialist in your project (orchestrators " +
      "only). Fails while a person holds or writes to it.",
    z.strictObject({ agent_session_id: Id }),
    (_core, actor, input, runtime) =>
      requireRuntime(runtime, "agents").interrupt(actor, input.agent_session_id),
  ),
  writeTool(
    "create_worktree",
    "Create a git worktree and branch for a task next to the project (within Naru's approved " +
      "roots) and connect it as a Naru project the user can open. Work there, publish commits, " +
      "then ask for reviews; merge_task integrates the branch.",
    z.strictObject({
      task_id: Id,
      slug: Text(40).describe("Short name for the branch and folder, e.g. login-screen."),
    }),
    (_core, context, input, runtime) =>
      requireRuntime(runtime, "workspace").createWorktree(context, {
        taskId: input.task_id,
        slug: input.slug,
      }),
  ),
  writeTool(
    "merge_task",
    "Integrate a task's branch into the branch checked out in its project, by fast-forward only, " +
      "once the merge gate is open. Naru never pushes. A diverged branch must be rebased in its " +
      "worktree and reviewed again.",
    z.strictObject({ task_id: Id }),
    (_core, context, input, runtime) =>
      requireRuntime(runtime, "workspace").merge(context, { taskId: input.task_id }),
  ),
  writeTool(
    "open_pane",
    "Open a Files or Docs view for the user in Naru, marked as opened by an agent, e.g. a test " +
      "plan or the file to look at.",
    z.strictObject({
      project_id: Id.optional(),
      kind: z.enum(["files", "docs"]),
      title: Text(NARU_AGENT_LIMITS.titleCharacters),
      path: z
        .string()
        .trim()
        .min(1)
        .max(1_024)
        .optional()
        .describe("Path relative to the project; Docs opens documents under docs/."),
    }),
    (core, context, input, runtime) =>
      requireRuntime(runtime, "workspace").openPane(context, {
        projectId: ownProject(core, context.actor, input.project_id),
        kind: input.kind,
        title: input.title,
        ...(input.path === undefined ? {} : { path: input.path }),
      }),
  ),
];

/**
 * Tools only Naru's own hook bin calls (AP-D015, AP-D002-2). They are not advertised over MCP and
 * the MCP bin refuses names it does not advertise.
 */
export const HOOK_TOOLS: readonly AgentTool[] = [
  {
    name: "hook.native_message.authorize",
    description: "Sender-side check for a native Claude cross-session message.",
    input: z.strictObject({
      tool_use_id: z.string().min(1).max(200),
      to: z.string().min(1).max(200),
      message: z.string().min(1).max(NARU_AGENT_LIMITS.instructionCharacters),
      sender_pids: z.array(z.number().int().positive()).max(8),
    }),
    run: (core, actor, raw) => {
      const input = HOOK_TOOLS[0]!.input.parse(raw) as {
        tool_use_id: string;
        to: string;
        message: string;
        sender_pids: number[];
      };
      return core.authorizeNativeMessage(
        { actor, idempotencyKey: `native:${input.tool_use_id}` },
        { recipientName: input.to, message: input.message, senderPids: input.sender_pids },
      );
    },
  },
  {
    name: "hook.native_message.deliver",
    description: "Receiver-side check for an arriving cross-session message.",
    input: z.strictObject({
      prompt: z
        .string()
        .min(1)
        .max(NARU_AGENT_LIMITS.instructionCharacters * 2),
    }),
    run: (core, actor, raw) =>
      core.deliverNativeMessage(actor, HOOK_TOOLS[1]!.input.parse(raw) as { prompt: string }),
  },
  {
    name: "hook.tui_prompt",
    description: "A prompt a person typed directly into this managed session's TUI.",
    input: z.strictObject({
      prompt_id: z.string().min(1).max(200),
      prompt: z.string().min(1).max(NARU_AGENT_LIMITS.instructionCharacters),
    }),
    run: (core, actor, raw) => {
      const input = HOOK_TOOLS[2]!.input.parse(raw) as { prompt_id: string; prompt: string };
      return core.recordSessionTuiPrompt(
        { actor, idempotencyKey: `tui:${input.prompt_id}` },
        { verbatim: input.prompt },
      );
    },
  },
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
