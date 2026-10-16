import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  AGENT_ROLE_COMMANDS,
  AgentTaskStatusSchema,
  NARU_AGENT_LIMITS,
  WORKER_TASK_STATUSES,
  type Actor,
  type AgentCommandName,
  type AgentEvent,
  type AgentEventType,
  type AgentOverview,
  type AgentPlatformErrorCode,
  type AgentRole,
  type AgentRuntime,
  type AgentSession,
  type AgentTask,
  type AgentTaskDetail,
  type AgentTaskStatus,
  type AgentWorktree,
  type Artifact,
  type Handoff,
  type HandoffPayload,
  type Instruction,
  type InstructionScope,
  type IntentContract,
  type Plan,
  type Review,
  type Run,
  type SharedProcess,
} from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformStore } from "./store.js";

export class AgentPlatformError extends Error {
  constructor(
    readonly code: AgentPlatformErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "AgentPlatformError";
  }
}

export interface CommandContext {
  /** Derived by the transport (Gateway session or agent capability), never from tool arguments. */
  readonly actor: Actor;
  readonly idempotencyKey: string;
}

export interface AgentPlatformCoreOptions {
  readonly now?: () => Date;
  readonly newId?: () => string;
}

type EventDraft = {
  readonly type: AgentEventType;
  readonly projectId: string | null;
  readonly subjectId: string;
  readonly correlationId?: string | null;
  readonly data?: AgentEvent["data"];
};

/**
 * The single command/query entry point for Web UI, MCP and CLI (ARCHITECTURE §1). It enforces
 * infrastructure policy only: scope, role permissions, human holds, provenance and idempotency.
 * Product judgement stays with the orchestrator LLMs (INV-02).
 */
export class AgentPlatformCore {
  readonly #store: AgentPlatformStore;
  readonly #now: () => Date;
  readonly #newId: () => string;
  readonly #listeners = new Set<(event: AgentEvent) => void>();

  constructor(store: AgentPlatformStore, options: AgentPlatformCoreOptions = {}) {
    this.#store = store;
    this.#now = options.now ?? (() => new Date());
    this.#newId = options.newId ?? randomUUID;
  }

  /** Listeners run after commit; a lost notification is recovered by reading events by cursor. */
  subscribe(listener: (event: AgentEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  // Instructions ---------------------------------------------------------------------------------

  /** A human instruction entered through Naru (Chat, Inbox, Project screen). */
  createHumanInstruction(
    context: CommandContext,
    input: {
      readonly scope: InstructionScope;
      readonly verbatim: string;
      readonly supersedesId?: string;
    },
  ): Instruction {
    this.#requireHuman(context.actor);
    return this.#command(
      context,
      "instruction.create",
      input,
      "instruction",
      (events) => {
        this.#assertScope(input.scope);
        if (input.supersedesId !== undefined) this.#requireSupersedable(input.supersedesId);
        const instruction = this.#instruction({
          scope: input.scope,
          author: { kind: "human" },
          channel: "naru-ui",
          originUserInstructionId: null,
          supersedesId: input.supersedesId ?? null,
          verbatim: input.verbatim,
        });
        events.push(instructionCreated(instruction));
        return instruction.id;
      },
      (id) => this.#requireInstruction(id),
    );
  }

  /**
   * A prompt the user submitted directly in the TUI of a Naru-managed agent session (AP-D002). Only
   * the Naru runtime integration (system actor) may record it; the author is the human.
   */
  recordTuiPrompt(
    context: CommandContext,
    input: { readonly agentSessionId: string; readonly verbatim: string },
  ): Instruction {
    if (context.actor.kind !== "system") {
      throw new AgentPlatformError(
        "AGENT_ROLE_DENIED",
        "Only the runtime integration records TUI prompts.",
      );
    }
    return this.#command(
      context,
      "instruction.tui",
      input,
      "instruction",
      (events) => {
        const session = this.#requireAgentSession(input.agentSessionId);
        const instruction = this.#instruction({
          scope: { kind: "agent", projectId: session.projectId, agentSessionId: session.id },
          author: { kind: "human" },
          channel: "tui",
          originUserInstructionId: null,
          supersedesId: null,
          verbatim: input.verbatim,
        });
        events.push(instructionCreated(instruction));
        return instruction.id;
      },
      (id) => this.#requireInstruction(id),
    );
  }

  /** An agent's delegation message; it must name the human instruction it serves (INV-01). */
  delegate(
    context: CommandContext,
    input: {
      readonly scope: InstructionScope;
      readonly verbatim: string;
      readonly originUserInstructionId: string;
    },
  ): Instruction {
    const agent = this.#authorize(
      context.actor,
      "instruction.delegate",
      scopeProjectId(input.scope),
    );
    return this.#command(
      context,
      "instruction.delegate",
      input,
      "instruction",
      (events) => {
        this.#assertScope(input.scope);
        const origin = this.#requireInstruction(input.originUserInstructionId);
        if (origin.author.kind !== "human") {
          throw new AgentPlatformError(
            "AGENT_INVALID_REFERENCE",
            "A delegation must reference the original human instruction.",
          );
        }
        if (input.scope.kind === "agent")
          this.#assertNotHeld(context.actor, input.scope.agentSessionId);
        const instruction = this.#instruction({
          scope: input.scope,
          author: { kind: "agent", agentSessionId: agent!.id },
          channel: "mcp",
          originUserInstructionId: origin.id,
          supersedesId: null,
          verbatim: input.verbatim,
        });
        events.push(instructionCreated(instruction));
        return instruction.id;
      },
      (id) => this.#requireInstruction(id),
    );
  }

  forgetInstruction(
    context: CommandContext,
    input: { readonly instructionId: string },
  ): Instruction {
    this.#requireHuman(context.actor);
    return this.#command(
      context,
      "instruction.forget",
      input,
      "instruction",
      (events) => {
        const instruction = this.#requireInstruction(input.instructionId);
        if (this.#store.forgetInstruction(instruction.id, this.#timestamp())) {
          events.push({
            type: "instruction.forgotten",
            projectId: scopeProjectId(instruction.scope),
            subjectId: instruction.id,
          });
        }
        return instruction.id;
      },
      (id) => this.#requireInstruction(id),
    );
  }

  /** Human instructions in force for a target; agents may only read inside their own scope. */
  getApplicableInstructions(
    actor: Actor,
    target: {
      readonly projectId: string | null;
      readonly taskId?: string;
      readonly agentSessionId?: string;
    },
  ): Instruction[] {
    this.#authorize(actor, "state.read", target.projectId);
    return this.#store.listApplicableHumanInstructions({
      projectId: target.projectId,
      taskId: target.taskId ?? null,
      agentSessionId: target.agentSessionId ?? null,
    });
  }

  /**
   * The work addressed to the acting agent (delegations to it or its tasks, by orchestrators or the
   * user; for a project orchestrator also to its project) and the original user instruction each
   * one serves, verbatim (AP-D002, A03).
   */
  getDelegatedWork(actor: Actor): {
    readonly instructions: Instruction[];
    readonly origins: Instruction[];
  } {
    if (actor.kind !== "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only an agent has delegated work.");
    }
    const agent = this.#authorize(actor, "state.read", this.#actorProject(actor))!;
    // A project orchestrator owns its project: work sent to the project is addressed to it too.
    const instructions = this.#store.listAddressedInstructions(
      agent.id,
      agent.role === "project-orchestrator" ? agent.projectId : null,
      50,
    );
    return { instructions, origins: this.#origins(instructions) };
  }

  /**
   * What was said to one agent, by anyone, verbatim, for the person's conversation view (AP-D022):
   * the instructions addressed to it as `getDelegatedWork` reads them, for the main orchestrator
   * also the user's global instructions, and the user instruction each delegation serves.
   */
  getAgentInstructions(
    actor: Actor,
    agentSessionId: string,
  ): { readonly instructions: Instruction[]; readonly origins: Instruction[] } {
    this.#requireHuman(actor);
    const agent = this.#requireAgentSession(agentSessionId);
    const addressed = this.#store.listAddressedInstructions(
      agent.id,
      agent.role === "project-orchestrator" ? agent.projectId : null,
      CONVERSATION_INSTRUCTIONS,
    );
    const global =
      agent.role === "main-orchestrator"
        ? this.#store
            .listApplicableHumanInstructions({
              projectId: null,
              taskId: null,
              agentSessionId: null,
            })
            .slice(-CONVERSATION_INSTRUCTIONS)
        : [];
    const instructions = [...addressed, ...global]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(-CONVERSATION_INSTRUCTIONS);
    return { instructions, origins: this.#origins(instructions) };
  }

  #origins(instructions: readonly Instruction[]): Instruction[] {
    const originIds = [
      ...new Set(
        instructions
          .map((instruction) => instruction.originUserInstructionId)
          .filter((id): id is string => id !== null),
      ),
    ];
    return originIds
      .map((id) => this.#store.getInstruction(id))
      .filter((instruction): instruction is Instruction => instruction !== null);
  }

  /**
   * AP-D015 sender side: a managed Claude session is about to send a native cross-session message.
   * Naru allows only managed recipients in scope that no human holds, and records the verbatim
   * message as a delegation tied to the sender's originating user instruction.
   */
  authorizeNativeMessage(
    context: CommandContext,
    input: {
      readonly recipientName: string;
      readonly message: string;
      readonly senderPids: readonly number[];
    },
  ): Instruction {
    const sender = this.#authorize(
      context.actor,
      "message.send",
      this.#actorProject(context.actor),
    );
    if (sender === null) {
      throw new AgentPlatformError(
        "AGENT_ROLE_DENIED",
        "Only managed agents send native messages.",
      );
    }
    return this.#command(
      context,
      "native_message.authorize",
      input,
      "instruction",
      (events) => {
        const recipient = this.#nativeRecipient(input.recipientName);
        if (
          recipient.id === sender.id ||
          !(
            recipient.projectId === sender.projectId ||
            sender.role === "main-orchestrator" ||
            recipient.role === "main-orchestrator"
          )
        ) {
          throw new AgentPlatformError(
            "AGENT_SCOPE_DENIED",
            "The recipient is outside your scope.",
          );
        }
        this.#assertNotHeld(context.actor, recipient.id);
        const origin = this.#originFor(sender);
        const instruction = this.#instruction({
          scope: { kind: "agent", projectId: recipient.projectId, agentSessionId: recipient.id },
          author: { kind: "agent", agentSessionId: sender.id },
          channel: "native-message",
          originUserInstructionId: origin,
          supersedesId: null,
          verbatim: input.message,
        });
        this.#store.insertNativeMessage({
          instructionId: instruction.id,
          senderAgentSessionId: sender.id,
          recipientAgentSessionId: recipient.id,
          bodyDigest: nativeBodyDigest(input.message),
          senderPids: input.senderPids.filter((pid) => Number.isSafeInteger(pid) && pid > 1),
          createdAt: instruction.createdAt,
        });
        events.push(instructionCreated(instruction));
        return instruction.id;
      },
      (id) => this.#requireInstruction(id),
    );
  }

  /**
   * AP-D015 receiver side: a cross-session prompt arrived. It passes only when it matches an
   * authorized record for this recipient from a sender process Naru recorded; otherwise the hook
   * blocks it.
   */
  deliverNativeMessage(actor: Actor, input: { readonly prompt: string }): Instruction {
    const recipient = this.#authorize(actor, "state.read", this.#actorProject(actor));
    if (recipient === null) {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only managed agents receive messages.");
    }
    const parsed = parseCrossSessionPrompt(input.prompt);
    if (parsed === null) {
      throw new AgentPlatformError("AGENT_INVALID_REFERENCE", "Not a cross-session message.");
    }
    const appended: AgentEvent[] = [];
    const instruction = this.#store.transaction(() => {
      const match = this.#store
        .findPendingNativeMessages(recipient.id, nativeBodyDigest(parsed.body))
        .find((pending) => parsed.pid !== null && pending.senderPids.includes(parsed.pid));
      if (match === undefined) {
        throw new AgentPlatformError(
          "AGENT_INVALID_REFERENCE",
          "No authorized Naru record matches.",
        );
      }
      this.#store.markNativeMessageDelivered(match.instructionId, this.#timestamp());
      const delivered = this.#requireInstruction(match.instructionId);
      appended.push(
        this.#store.appendEvent({
          id: this.#newId(),
          type: "instruction.delivered",
          projectId: recipient.projectId,
          actor,
          subjectId: delivered.id,
          correlationId: delivered.originUserInstructionId,
          data: { channel: "native-message", sender: match.senderAgentSessionId },
          createdAt: this.#timestamp(),
        }),
      );
      return delivered;
    });
    this.#emit(appended);
    return instruction;
  }

  /**
   * A prompt a person typed directly into this managed session's TUI (AP-D002-2), reported by the
   * session's own Naru hook. Recorded as the human's instruction to that agent.
   */
  recordSessionTuiPrompt(
    context: CommandContext,
    input: { readonly verbatim: string },
  ): Instruction {
    const session = this.#authorize(context.actor, "state.read", this.#actorProject(context.actor));
    if (session === null) {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only a managed session reports its TUI.");
    }
    return this.#command(
      context,
      "instruction.tui",
      input,
      "instruction",
      (events) => {
        const instruction = this.#instruction({
          scope: { kind: "agent", projectId: session.projectId, agentSessionId: session.id },
          author: { kind: "human" },
          channel: "tui",
          originUserInstructionId: null,
          supersedesId: null,
          verbatim: input.verbatim,
        });
        events.push(instructionCreated(instruction));
        return instruction.id;
      },
      (id) => this.#requireInstruction(id),
    );
  }

  // Intent contracts and plans -------------------------------------------------------------------

  proposeIntentContract(
    context: CommandContext,
    input: {
      readonly projectId: string;
      readonly body: IntentContract["body"];
      readonly sourceInstructionId: string;
    },
  ): IntentContract {
    this.#authorize(context.actor, "intent_contract.propose", input.projectId);
    return this.#command(
      context,
      "intent_contract.propose",
      input,
      "intent_contract",
      (events) => {
        this.#requireProject(input.projectId);
        this.#requireInstruction(input.sourceInstructionId);
        const contract: IntentContract = {
          id: this.#newId(),
          projectId: input.projectId,
          version: this.#store.nextIntentContractVersion(input.projectId),
          status: "proposed",
          body: input.body,
          sourceInstructionId: input.sourceInstructionId,
          approvedByHandoffId: null,
          createdAt: this.#timestamp(),
        };
        this.#store.insertIntentContract(contract);
        events.push({
          type: "intent_contract.proposed",
          projectId: contract.projectId,
          subjectId: contract.id,
          data: { version: contract.version },
        });
        return contract.id;
      },
      (id) => this.#requireIntentContract(id),
    );
  }

  approveIntentContract(
    context: CommandContext,
    input: { readonly intentContractId: string; readonly handoffId?: string },
  ): IntentContract {
    this.#requireHuman(context.actor);
    return this.#command(
      context,
      "intent_contract.approve",
      input,
      "intent_contract",
      (events) => {
        const contract = this.#requireIntentContract(input.intentContractId);
        if (contract.status !== "proposed") {
          throw new AgentPlatformError(
            "AGENT_INVALID_STATE",
            "Only a proposed contract can be approved.",
          );
        }
        this.#store.approveIntentContract(contract.id, contract.projectId, input.handoffId ?? null);
        events.push({
          type: "intent_contract.approved",
          projectId: contract.projectId,
          subjectId: contract.id,
          data: { version: contract.version },
        });
        return contract.id;
      },
      (id) => this.#requireIntentContract(id),
    );
  }

  createPlan(
    context: CommandContext,
    input: { readonly projectId: string; readonly summary: string; readonly activate: boolean },
  ): Plan {
    const agent = this.#authorize(context.actor, "plan.create", input.projectId);
    return this.#command(
      context,
      "plan.create",
      input,
      "plan",
      (events) => {
        this.#requireProject(input.projectId);
        const plan: Plan = {
          id: this.#newId(),
          projectId: input.projectId,
          version: this.#store.nextPlanVersion(input.projectId),
          status: input.activate ? "active" : "draft",
          ownerAgentSessionId: agent?.id ?? null,
          summary: input.summary,
          intentContractId: this.#store.getApprovedIntentContract(input.projectId)?.id ?? null,
          createdAt: this.#timestamp(),
        };
        this.#store.insertPlan(plan);
        events.push({
          type: "plan.created",
          projectId: plan.projectId,
          subjectId: plan.id,
          data: { version: plan.version, status: plan.status },
        });
        return plan.id;
      },
      (id) => this.#requirePlan(id),
    );
  }

  // Tasks ----------------------------------------------------------------------------------------

  createTask(
    context: CommandContext,
    input: {
      readonly projectId: string;
      readonly planId?: string;
      readonly title: string;
      readonly purpose: string;
      readonly completionCriteria: readonly string[];
      readonly priority?: number;
      readonly assigneeAgentSessionId?: string;
      readonly originInstructionId: string;
      readonly dependsOn?: readonly string[];
    },
  ): AgentTask {
    this.#authorize(context.actor, "task.create", input.projectId);
    return this.#command(
      context,
      "task.create",
      input,
      "task",
      (events) => {
        this.#requireProject(input.projectId);
        if (input.planId !== undefined) this.#requirePlanInProject(input.planId, input.projectId);
        this.#requireOriginForProject(input.originInstructionId, input.projectId);
        const dependsOn = [...new Set(input.dependsOn ?? [])];
        for (const dependency of dependsOn) this.#requireTaskInProject(dependency, input.projectId);
        if (input.assigneeAgentSessionId !== undefined) {
          this.#requireAssignable(context.actor, input.assigneeAgentSessionId, input.projectId);
        }
        const now = this.#timestamp();
        const task: AgentTask = {
          id: this.#newId(),
          projectId: input.projectId,
          planId: input.planId ?? null,
          title: input.title,
          purpose: input.purpose,
          completionCriteria: [...input.completionCriteria],
          status: dependsOn.length === 0 ? "ready" : "pending",
          priority: input.priority ?? 500,
          assigneeAgentSessionId: input.assigneeAgentSessionId ?? null,
          originInstructionId: input.originInstructionId,
          intentContractId: this.#store.getApprovedIntentContract(input.projectId)?.id ?? null,
          dependsOn,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        this.#store.insertTask(task);
        events.push({
          type: "task.created",
          projectId: task.projectId,
          subjectId: task.id,
          data: { status: task.status, assignee: task.assigneeAgentSessionId },
        });
        return task.id;
      },
      (id) => this.#requireTask(id),
    );
  }

  updateTask(
    context: CommandContext,
    input: {
      readonly taskId: string;
      readonly expectedRevision: number;
      readonly status?: AgentTaskStatus;
      readonly priority?: number;
      readonly assigneeAgentSessionId?: string | null;
      readonly dependsOn?: readonly string[];
    },
  ): AgentTask {
    const current = this.#requireTask(input.taskId);
    const ownStatusOnly =
      input.priority === undefined &&
      input.assigneeAgentSessionId === undefined &&
      input.dependsOn === undefined;
    const agent = this.#authorizeTaskUpdate(context.actor, current, ownStatusOnly, input.status);
    return this.#command(
      context,
      "task.update",
      input,
      "task",
      (events) => {
        const task = this.#requireTask(input.taskId);
        if (task.revision !== input.expectedRevision) {
          throw new AgentPlatformError("AGENT_REVISION_STALE", "The task changed; read it again.");
        }
        const dependsOn =
          input.dependsOn === undefined ? task.dependsOn : [...new Set(input.dependsOn)];
        if (input.dependsOn !== undefined) {
          for (const dependency of dependsOn)
            this.#requireTaskInProject(dependency, task.projectId);
          if (this.#store.dependencyClosure(dependsOn).has(task.id)) {
            throw new AgentPlatformError(
              "AGENT_DEPENDENCY_CYCLE",
              "Task dependencies would form a cycle.",
            );
          }
        }
        if (input.assigneeAgentSessionId !== undefined && input.assigneeAgentSessionId !== null) {
          this.#requireAssignable(context.actor, input.assigneeAgentSessionId, task.projectId);
        }
        const next: AgentTask = {
          ...task,
          status: input.status ?? task.status,
          priority: input.priority ?? task.priority,
          assigneeAgentSessionId:
            input.assigneeAgentSessionId === undefined
              ? task.assigneeAgentSessionId
              : input.assigneeAgentSessionId,
          dependsOn,
          revision: task.revision + 1,
          updatedAt: this.#timestamp(),
        };
        if (!this.#store.updateTask(next, input.expectedRevision)) {
          throw new AgentPlatformError("AGENT_REVISION_STALE", "The task changed; read it again.");
        }
        events.push({
          type: "task.updated",
          projectId: next.projectId,
          subjectId: next.id,
          data: {
            status: next.status,
            previousStatus: task.status,
            revision: next.revision,
            by: agent?.role ?? context.actor.kind,
          },
        });
        return next.id;
      },
      (id) => this.#requireTask(id),
    );
  }

  listTasks(actor: Actor, projectId: string): AgentTask[] {
    this.#authorize(actor, "state.read", projectId);
    return this.#store.listTasks(projectId);
  }

  // Runs -----------------------------------------------------------------------------------------

  startRun(
    context: CommandContext,
    input: {
      readonly taskId: string;
      readonly agentSessionId?: string;
      readonly runtime: AgentRuntime;
      readonly model?: string;
    },
  ): Run {
    const task = this.#requireTask(input.taskId);
    this.#authorize(context.actor, "run.start", task.projectId);
    return this.#command(
      context,
      "run.start",
      input,
      "run",
      (events) => {
        if (input.agentSessionId !== undefined) {
          this.#requireAgentSessionInProject(input.agentSessionId, task.projectId);
        }
        const run: Run = {
          id: this.#newId(),
          taskId: task.id,
          agentSessionId: input.agentSessionId ?? null,
          runtime: input.runtime,
          model: input.model ?? null,
          status: "starting",
          attempt: this.#store.nextRunAttempt(task.id),
          errorClass: null,
          summary: null,
          startedAt: this.#timestamp(),
          finishedAt: null,
        };
        this.#store.insertRun(run);
        events.push({
          type: "run.started",
          projectId: task.projectId,
          subjectId: run.id,
          correlationId: task.id,
          data: { attempt: run.attempt, runtime: run.runtime },
        });
        return run.id;
      },
      (id) => this.#requireRun(id),
    );
  }

  reportProgress(
    context: CommandContext,
    input: { readonly runId: string; readonly summary: string; readonly status?: "running" },
  ): Run {
    const run = this.#requireRun(input.runId);
    const task = this.#requireTask(run.taskId);
    this.#authorizeRunActor(context.actor, "run.report_progress", task, run);
    return this.#command(
      context,
      "run.report_progress",
      input,
      "run",
      (events) => {
        const current = this.#requireRun(input.runId);
        if (isFinished(current.status)) {
          throw new AgentPlatformError("AGENT_INVALID_STATE", "The run already finished.");
        }
        this.#store.updateRun({ ...current, status: "running", summary: input.summary });
        events.push({
          type: "run.progress",
          projectId: task.projectId,
          subjectId: current.id,
          correlationId: task.id,
        });
        return current.id;
      },
      (id) => this.#requireRun(id),
    );
  }

  finishRun(
    context: CommandContext,
    input: {
      readonly runId: string;
      readonly status: "succeeded" | "failed" | "cancelled";
      readonly errorClass?: string;
      readonly summary?: string;
    },
  ): Run {
    const run = this.#requireRun(input.runId);
    const task = this.#requireTask(run.taskId);
    this.#authorizeRunActor(context.actor, "run.finish", task, run);
    return this.#command(
      context,
      "run.finish",
      input,
      "run",
      (events) => {
        const current = this.#requireRun(input.runId);
        if (isFinished(current.status)) {
          throw new AgentPlatformError("AGENT_INVALID_STATE", "The run already finished.");
        }
        this.#store.updateRun({
          ...current,
          status: input.status,
          errorClass: input.errorClass ?? null,
          summary: input.summary ?? current.summary,
          finishedAt: this.#timestamp(),
        });
        events.push({
          type: "run.finished",
          projectId: task.projectId,
          subjectId: current.id,
          correlationId: task.id,
          data: { status: input.status, errorClass: input.errorClass ?? null },
        });
        return current.id;
      },
      (id) => this.#requireRun(id),
    );
  }

  /**
   * Restart recovery (INV-07, SOURCE_SPEC §12): runs that were live when Naru stopped become
   * `unknown`. Success or failure is never invented; the runtime adapter must confirm it later.
   */
  markInterruptedRunsUnknown(
    context: CommandContext,
    filter: { readonly agentSessionId?: string } = {},
  ): Run[] {
    if (context.actor.kind !== "system") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only Naru recovery marks runs unknown.");
    }
    const changed: Run[] = [];
    const events: AgentEvent[] = [];
    this.#store.transaction(() => {
      for (const run of this.#store.listRunsByStatus(["starting", "running"])) {
        // Recovery is per runtime: a run whose agent came back keeps running (A13).
        if (filter.agentSessionId !== undefined && run.agentSessionId !== filter.agentSessionId) {
          continue;
        }
        const next: Run = { ...run, status: "unknown" };
        this.#store.updateRun(next);
        changed.push(next);
        const task = this.#requireTask(run.taskId);
        events.push(
          this.#store.appendEvent({
            id: this.#newId(),
            type: "run.finished",
            projectId: task.projectId,
            actor: context.actor,
            subjectId: run.id,
            correlationId: task.id,
            data: { status: "unknown", errorClass: null },
            createdAt: this.#timestamp(),
          }),
        );
      }
    });
    this.#emit(events);
    return changed;
  }

  // Agent sessions -------------------------------------------------------------------------------

  registerAgentSession(
    context: CommandContext,
    input: {
      readonly projectId: string | null;
      readonly role: AgentRole;
      readonly runtime: AgentRuntime;
      readonly runtimeSessionRef?: string;
      readonly parentAgentSessionId?: string;
      readonly native: boolean;
      readonly observation: AgentSession["observation"];
      readonly conversationWriter: AgentSession["conversationWriter"];
    },
  ): AgentSession {
    const agent = this.#authorize(context.actor, "agent_session.register", input.projectId);
    if (agent !== null && roleRank(input.role) <= roleRank(agent.role)) {
      throw new AgentPlatformError(
        "AGENT_ROLE_DENIED",
        "An agent may only register sessions below its own role.",
      );
    }
    return this.#command(
      context,
      "agent_session.register",
      input,
      "agent_session",
      (events) => {
        if (input.projectId !== null) this.#requireProject(input.projectId);
        if (input.role !== "main-orchestrator" && input.projectId === null) {
          throw new AgentPlatformError(
            "AGENT_SCOPE_DENIED",
            "Only the main orchestrator is global.",
          );
        }
        if (input.parentAgentSessionId !== undefined) {
          this.#requireAgentSession(input.parentAgentSessionId);
        }
        const now = this.#timestamp();
        const session: AgentSession = {
          id: this.#newId(),
          projectId: input.projectId,
          role: input.role,
          runtime: input.runtime,
          runtimeSessionRef: input.runtimeSessionRef ?? null,
          parentAgentSessionId: input.parentAgentSessionId ?? null,
          native: input.native,
          observation: input.observation,
          conversationWriter: input.conversationWriter,
          humanHoldSince: null,
          status: "starting",
          paneId: null,
          launchMode: "runner",
          createdAt: now,
          updatedAt: now,
        };
        this.#store.insertAgentSession(session);
        events.push({
          type: "agent_session.registered",
          projectId: session.projectId,
          subjectId: session.id,
          data: { role: session.role, runtime: session.runtime, observation: session.observation },
        });
        return session.id;
      },
      (id) => this.#requireAgentSession(id),
    );
  }

  /**
   * Direct human intervention (AP-D005). While held, agent actors cannot delegate to or assign work
   * to this session; the release event wakes the orchestrators so they re-plan from current state.
   */
  setHumanHold(
    context: CommandContext,
    input: {
      readonly agentSessionId: string;
      readonly held: boolean;
      readonly reason: "takeover" | "release" | "disconnect-timeout" | "idle-timeout";
    },
  ): AgentSession {
    if (context.actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only a human or Naru changes a hold.");
    }
    return this.#command(
      context,
      "agent_session.hold",
      input,
      "agent_session",
      (events) => {
        const session = this.#requireAgentSession(input.agentSessionId);
        const now = this.#timestamp();
        if (input.held === (session.humanHoldSince !== null)) return session.id;
        this.#store.updateAgentSession({
          ...session,
          humanHoldSince: input.held ? now : null,
          updatedAt: now,
        });
        events.push({
          type: input.held ? "agent_session.hold_started" : "agent_session.hold_released",
          projectId: session.projectId,
          subjectId: session.id,
          data: {
            reason: input.reason,
            heldSince: session.humanHoldSince,
          },
        });
        return session.id;
      },
      (id) => this.#requireAgentSession(id),
    );
  }

  /**
   * An agent starts a Naru-managed agent session below its own role (AP-D006, K4). The parent link
   * is recorded so the new session shows under its creator in Naru.
   */
  spawnAgentSession(
    context: CommandContext,
    input: {
      readonly projectId: string;
      readonly role: AgentRole;
      readonly runtime?: "claude" | "codex";
    },
  ): AgentSession {
    const agent = this.#authorize(context.actor, "agent.spawn", input.projectId);
    return this.registerAgentSession(context, {
      projectId: input.projectId,
      role: input.role,
      runtime: input.runtime ?? "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
      ...(agent === null ? {} : { parentAgentSessionId: agent.id }),
    });
  }

  // Shared processes (AP-D006, AP-D005) ----------------------------------------------------------

  /**
   * Records a process an agent wants to run before any Host session exists (AP-D006): project,
   * task, run, agent, purpose, the verbatim command and ports. The runtime then creates the Pane.
   */
  startSharedProcess(
    context: CommandContext,
    input: {
      readonly projectId: string;
      readonly taskId?: string;
      readonly runId?: string;
      readonly purpose: string;
      readonly command: string;
      readonly ports: readonly number[];
      readonly keep: SharedProcess["keep"];
    },
  ): SharedProcess {
    const agent = this.#authorize(context.actor, "process.start", input.projectId);
    return this.#command(
      context,
      "process.start",
      input,
      "shared_process",
      (events) => {
        this.#requireProject(input.projectId);
        if (input.taskId !== undefined) this.#requireTaskInProject(input.taskId, input.projectId);
        if (input.runId !== undefined) {
          const run = this.#requireRun(input.runId);
          if (agent !== null && run.agentSessionId !== agent.id) {
            throw new AgentPlatformError("AGENT_SCOPE_DENIED", "The run belongs to another agent.");
          }
        }
        if (input.keep === "run" && input.runId === undefined) {
          throw new AgentPlatformError(
            "AGENT_INVALID_REFERENCE",
            "A process tied to its run needs the run.",
          );
        }
        const now = this.#timestamp();
        const process: SharedProcess = {
          id: this.#newId(),
          projectId: input.projectId,
          taskId: input.taskId ?? null,
          runId: input.runId ?? null,
          agentSessionId: agent?.id ?? null,
          purpose: input.purpose,
          command: input.command,
          ports: [...input.ports],
          keep: input.keep,
          paneId: null,
          humanHoldSince: null,
          status: "starting",
          exitCode: null,
          createdAt: now,
          updatedAt: now,
        };
        this.#store.insertSharedProcess(process);
        events.push({
          type: "shared_process.started",
          projectId: process.projectId,
          subjectId: process.id,
          correlationId: process.runId,
          data: { keep: process.keep, ports: process.ports.join(","), taskId: process.taskId },
        });
        return process.id;
      },
      (id) => this.#requireSharedProcess(id),
    );
  }

  getSharedProcess(actor: Actor, processId: string): SharedProcess {
    const process = this.#requireSharedProcess(processId);
    this.#authorize(actor, "process.read", process.projectId);
    return process;
  }

  listSharedProcesses(actor: Actor, projectId: string): SharedProcess[] {
    this.#authorize(actor, "state.read", projectId);
    return this.#store.listSharedProcesses({ projectId });
  }

  /** Processes to stop when their run ends (keep = "run"). */
  sharedProcessesForRun(actor: Actor, runId: string): SharedProcess[] {
    this.#requireSystemOrHuman(actor);
    return this.#store.listSharedProcesses({ runId });
  }

  /**
   * Agent input to its own process, recorded verbatim (AP-D003). The creating agent is the holder;
   * while a person holds the process the input is refused, not queued (AP-D005).
   */
  recordSharedProcessInput(
    context: CommandContext,
    input: { readonly processId: string; readonly text: string },
  ): { readonly process: SharedProcess; readonly replayed: boolean } {
    // A retried call (same key, e.g. after a Naru restart) must not type the input twice.
    const replayed = this.commandRecorded(context.actor, context.idempotencyKey);
    const process = this.#command(
      context,
      "process.input",
      input,
      "shared_process",
      () => {
        const current = this.#requireSharedProcess(input.processId);
        const agent = this.#authorize(context.actor, "process.input", current.projectId);
        if (agent !== null && current.agentSessionId !== agent.id) {
          throw new AgentPlatformError(
            "AGENT_SCOPE_DENIED",
            "Only the agent that started the process writes to it; ask it or request a handoff.",
          );
        }
        this.#assertProcessWritable(current);
        if (agent !== null) {
          this.#store.insertSharedProcessInput({
            id: this.#newId(),
            processId: current.id,
            agentSessionId: agent.id,
            verbatim: input.text,
            createdAt: this.#timestamp(),
          });
        }
        return current.id;
      },
      (id) => this.#requireSharedProcess(id),
    );
    return { process, replayed };
  }

  /** The creating agent, an orchestrator of the project, or a person may stop a process. */
  authorizeSharedProcessStop(actor: Actor, processId: string): SharedProcess {
    const process = this.#requireSharedProcess(processId);
    const agent = this.#authorize(actor, "process.stop", process.projectId);
    if (
      agent !== null &&
      process.agentSessionId !== agent.id &&
      agent.role !== "project-orchestrator"
    ) {
      throw new AgentPlatformError("AGENT_SCOPE_DENIED", "Another agent's process.");
    }
    return process;
  }

  bindSharedProcessPane(actor: Actor, processId: string, paneId: string): SharedProcess {
    this.#requireSystem(actor);
    const process = this.#requireSharedProcess(processId);
    const next = { ...process, paneId, updatedAt: this.#timestamp() };
    this.#store.updateSharedProcess(next);
    return next;
  }

  updateSharedProcessState(
    actor: Actor,
    input: {
      readonly processId: string;
      readonly status: SharedProcess["status"];
      readonly exitCode?: number | null;
    },
  ): SharedProcess {
    this.#requireSystem(actor);
    const appended: AgentEvent[] = [];
    const updated = this.#store.transaction(() => {
      const process = this.#requireSharedProcess(input.processId);
      const exitCode = input.exitCode === undefined ? process.exitCode : input.exitCode;
      if (process.status === input.status && process.exitCode === exitCode) return process;
      const next: SharedProcess = {
        ...process,
        status: input.status,
        exitCode,
        updatedAt: this.#timestamp(),
      };
      this.#store.updateSharedProcess(next);
      appended.push(
        this.#store.appendEvent({
          id: this.#newId(),
          type: "shared_process.updated",
          projectId: process.projectId,
          actor,
          subjectId: process.id,
          correlationId: process.runId,
          data: { status: next.status, previousStatus: process.status, exitCode },
          createdAt: next.updatedAt,
        }),
      );
      return next;
    });
    this.#emit(appended);
    return updated;
  }

  /**
   * A person takes over a process (AP-D005 "직접 개입") or Naru returns it: explicitly, after the
   * person's device stayed disconnected, or after no human input for a while.
   */
  setSharedProcessHold(
    context: CommandContext,
    input: {
      readonly processId: string;
      readonly held: boolean;
      readonly reason: "takeover" | "release" | "disconnect-timeout" | "idle-timeout";
    },
  ): SharedProcess {
    if (context.actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only a human or Naru changes a hold.");
    }
    return this.#command(
      context,
      "shared_process.hold",
      input,
      "shared_process",
      (events) => {
        const process = this.#requireSharedProcess(input.processId);
        if (input.held === (process.humanHoldSince !== null)) return process.id;
        const now = this.#timestamp();
        this.#store.updateSharedProcess({
          ...process,
          humanHoldSince: input.held ? now : null,
          updatedAt: now,
        });
        events.push({
          type: input.held ? "shared_process.hold_started" : "shared_process.hold_released",
          projectId: process.projectId,
          subjectId: process.id,
          correlationId: process.runId,
          data: {
            reason: input.reason,
            heldSince: process.humanHoldSince,
            agentSessionId: process.agentSessionId,
          },
        });
        return process.id;
      },
      (id) => this.#requireSharedProcess(id),
    );
  }

  /**
   * Mints the bearer capability that binds MCP calls to this agent session (AP-D004, V13). The
   * token is returned once and only its digest is stored. It proves accountability, not isolation:
   * agents run as the same OS user.
   */
  issueAgentCapability(actor: Actor, agentSessionId: string): string {
    if (actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Agents cannot mint capabilities.");
    }
    const token = randomBytes(32).toString("base64url");
    this.#store.transaction(() => {
      this.#requireAgentSession(agentSessionId);
      this.#store.insertCapability(capabilityDigest(token), agentSessionId, this.#timestamp());
    });
    return token;
  }

  /**
   * The runner's channel token (separate from the agent capability so the agent's own tools never
   * hold it). Only its digest is stored, so a runner can re-authenticate after a Naru restart.
   */
  issueRuntimeLaunchToken(actor: Actor, agentSessionId: string): string {
    if (actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Agents cannot launch runtimes.");
    }
    const token = randomBytes(32).toString("base64url");
    this.#store.transaction(() => {
      this.#requireAgentSession(agentSessionId);
      this.#store.replaceRuntimeLaunch(agentSessionId, capabilityDigest(token), this.#timestamp());
    });
    return token;
  }

  authenticateRuntime(token: string): string | null {
    if (!CAPABILITY_PATTERN.test(token)) return null;
    return this.#store.findRuntimeLaunch(capabilityDigest(token));
  }

  endRuntimeLaunch(actor: Actor, agentSessionId: string): void {
    if (actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Agents cannot end runtimes.");
    }
    this.#store.deleteRuntimeLaunch(agentSessionId);
  }

  /**
   * Runtime-reported state (system actor): conversation identity, liveness, which form hosts it
   * and who writes to it. No content.
   */
  updateAgentRuntimeState(
    actor: Actor,
    input: {
      readonly agentSessionId: string;
      readonly runtimeSessionRef?: string;
      readonly status?: AgentSession["status"];
      readonly launchMode?: AgentSession["launchMode"];
      readonly conversationWriter?: AgentSession["conversationWriter"];
    },
  ): AgentSession {
    if (actor.kind !== "system") {
      throw new AgentPlatformError(
        "AGENT_ROLE_DENIED",
        "Only Naru's runtime supervisor reports state.",
      );
    }
    const appended: AgentEvent[] = [];
    const updated = this.#store.transaction(() => {
      const session = this.#requireAgentSession(input.agentSessionId);
      const next: AgentSession = {
        ...session,
        runtimeSessionRef: input.runtimeSessionRef ?? session.runtimeSessionRef,
        status: input.status ?? session.status,
        launchMode: input.launchMode ?? session.launchMode,
        conversationWriter: input.conversationWriter ?? session.conversationWriter,
        updatedAt: this.#timestamp(),
      };
      if (
        next.runtimeSessionRef === session.runtimeSessionRef &&
        next.status === session.status &&
        next.launchMode === session.launchMode &&
        next.conversationWriter === session.conversationWriter
      ) {
        return session;
      }
      this.#store.updateAgentSession(next);
      appended.push(
        this.#store.appendEvent({
          id: this.#newId(),
          type: "agent_session.updated",
          projectId: session.projectId,
          actor,
          subjectId: session.id,
          correlationId: null,
          data: {
            status: next.status,
            previousStatus: session.status,
            launchMode: next.launchMode,
            conversationWriter: next.conversationWriter,
          },
          createdAt: next.updatedAt,
        }),
      );
      return next;
    });
    this.#emit(appended);
    return updated;
  }

  revokeAgentCapabilities(actor: Actor, agentSessionId: string): number {
    if (actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Agents cannot revoke capabilities.");
    }
    return this.#store.revokeCapabilities(agentSessionId, this.#timestamp());
  }

  /** Resolves a presented capability to its agent actor, or null when unknown, revoked or ended. */
  authenticateAgent(token: string): Actor | null {
    if (!CAPABILITY_PATTERN.test(token)) return null;
    // Lookup is by SHA-256 digest of a 256-bit token, so timing reveals nothing useful.
    const agentSessionId = this.#store.findCapabilitySession(capabilityDigest(token));
    if (agentSessionId === null) return null;
    const session = this.#store.getAgentSession(agentSessionId);
    if (session === null || session.status === "stopped" || session.status === "failed") {
      return null;
    }
    return { kind: "agent", agentSessionId };
  }

  getAgentSession(actor: Actor, agentSessionId: string): AgentSession {
    const session = this.#requireAgentSession(agentSessionId);
    this.#authorize(actor, "state.read", session.projectId);
    return session;
  }

  /** A compact project snapshot for orchestrators; content stays referenced, not expanded. */
  getProjectState(
    actor: Actor,
    projectId: string,
  ): {
    readonly intentContract: IntentContract | null;
    readonly activePlan: Plan | null;
    readonly tasks: AgentTask[];
    readonly openHandoffs: Handoff[];
  } {
    this.#authorize(actor, "state.read", projectId);
    this.#requireProject(projectId);
    return {
      intentContract: this.#store.getApprovedIntentContract(projectId),
      activePlan: this.#store.getActivePlan(projectId),
      tasks: this.#store.listTasks(projectId),
      openHandoffs: this.#store.listOpenHandoffs(projectId),
    };
  }

  /** A proposed intent contract still waiting for the user's approval, for the Project view. */
  getPendingIntentContract(actor: Actor, projectId: string): IntentContract | null {
    this.#authorize(actor, "state.read", projectId);
    this.#requireProject(projectId);
    return this.#store.getPendingIntentContract(projectId);
  }

  /** The user's cross-project view (Home); agents never call this. */
  getOverview(actor: Actor): AgentOverview {
    this.#requireHuman(actor);
    const projects = this.#store.listAgentProjectIds().map((projectId) => {
      // Every status is present (0 when empty) so the contract's exhaustive record holds.
      const taskCounts = Object.fromEntries(
        AgentTaskStatusSchema.options.map((status) => [status, 0]),
      ) as Record<AgentTaskStatus, number>;
      for (const task of this.#store.listTasks(projectId)) taskCounts[task.status] += 1;
      const agents = this.#store.listAgentSessions(projectId);
      return {
        projectId,
        taskCounts,
        openHandoffs: this.#store.listOpenHandoffs(projectId).length,
        agents: agents.length,
        heldAgents: agents.filter((agent) => agent.humanHoldSince !== null).length,
      };
    });
    return {
      projects,
      openHandoffs: this.#store.listOpenHandoffs(null),
      globalAgents: this.#store.listAgentSessions(null),
    };
  }

  /**
   * The user's connected projects with their agent work, for the main orchestrator's global view
   * (a project-scoped agent is refused). Names only; paths stay with Naru.
   */
  listProjects(actor: Actor): {
    readonly projectId: string;
    readonly name: string;
    readonly tasks: number;
    readonly openHandoffs: number;
    readonly agents: number;
    readonly hasOrchestrator: boolean;
  }[] {
    this.#authorize(actor, "state.read", null);
    return this.#store.listProjects().map((project) => {
      const agents = this.#store.listAgentSessions(project.id);
      return {
        projectId: project.id,
        name: project.name,
        tasks: this.#store.listTasks(project.id).length,
        openHandoffs: this.#store.listOpenHandoffs(project.id).length,
        agents: agents.length,
        hasOrchestrator: agents.some(
          (agent) =>
            agent.role === "project-orchestrator" &&
            agent.status !== "stopped" &&
            agent.status !== "failed",
        ),
      };
    });
  }

  /** Naru-launched agents Naru still considers alive (restart reconciliation, AP-T10). */
  listLiveManagedAgents(actor: Actor): AgentSession[] {
    this.#requireSystem(actor);
    return this.#store
      .listLiveAgentSessions()
      .filter((agent) => agent.paneId !== null && !agent.native);
  }

  listAgentSessions(actor: Actor, projectId: string | null): AgentSession[] {
    this.#authorize(actor, "state.read", projectId);
    return this.#store.listAgentSessions(projectId);
  }

  getHandoff(actor: Actor, handoffId: string): Handoff {
    const handoff = this.#requireHandoff(handoffId);
    this.#authorize(actor, "state.read", handoff.projectId);
    return handoff;
  }

  // Handoffs -------------------------------------------------------------------------------------

  requestHandoff(
    context: CommandContext,
    input: {
      readonly projectId: string | null;
      readonly kind: Handoff["kind"];
      readonly payload: HandoffPayload;
    },
  ): Handoff {
    this.#authorize(context.actor, "handoff.request", input.projectId);
    return this.#command(
      context,
      "handoff.request",
      input,
      "handoff",
      (events) => {
        if (input.projectId !== null) this.#requireProject(input.projectId);
        for (const taskId of input.payload.blockingTaskIds) {
          if (input.projectId === null) {
            throw new AgentPlatformError("AGENT_SCOPE_DENIED", "Blocking tasks need a project.");
          }
          this.#requireTaskInProject(taskId, input.projectId);
        }
        const handoff: Handoff = {
          id: this.#newId(),
          projectId: input.projectId,
          kind: input.kind,
          status: "open",
          requestedBy: context.actor,
          payload: input.payload,
          resolution: null,
          createdAt: this.#timestamp(),
          resolvedAt: null,
        };
        this.#store.insertHandoff(handoff);
        events.push({
          type: "handoff.requested",
          projectId: handoff.projectId,
          subjectId: handoff.id,
          data: { kind: handoff.kind, blockingTasks: input.payload.blockingTaskIds.length },
        });
        return handoff.id;
      },
      (id) => this.#requireHandoff(id),
    );
  }

  resolveHandoff(
    context: CommandContext,
    input: {
      readonly handoffId: string;
      readonly decision: string;
      readonly chosenOption?: string;
    },
  ): Handoff {
    this.#requireHuman(context.actor);
    return this.#command(
      context,
      "handoff.resolve",
      input,
      "handoff",
      (events) => {
        const handoff = this.#requireHandoff(input.handoffId);
        const resolved: Handoff = {
          ...handoff,
          status: "resolved",
          resolution: { decision: input.decision, chosenOption: input.chosenOption ?? null },
          resolvedAt: this.#timestamp(),
        };
        if (!this.#store.closeHandoff(resolved)) {
          throw new AgentPlatformError("AGENT_INVALID_STATE", "The handoff is no longer open.");
        }
        events.push({
          type: "handoff.resolved",
          projectId: handoff.projectId,
          subjectId: handoff.id,
          data: { kind: handoff.kind, chosenOption: input.chosenOption ?? null },
        });
        return handoff.id;
      },
      (id) => this.#requireHandoff(id),
    );
  }

  cancelHandoff(context: CommandContext, input: { readonly handoffId: string }): Handoff {
    const handoff = this.#requireHandoff(input.handoffId);
    if (context.actor.kind === "agent") {
      this.#authorize(context.actor, "handoff.cancel", handoff.projectId);
      if (
        handoff.requestedBy.kind !== "agent" ||
        handoff.requestedBy.agentSessionId !== context.actor.agentSessionId
      ) {
        throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only the requester may cancel it.");
      }
    }
    return this.#command(
      context,
      "handoff.cancel",
      input,
      "handoff",
      (events) => {
        const current = this.#requireHandoff(input.handoffId);
        const cancelled: Handoff = {
          ...current,
          status: "cancelled",
          resolvedAt: this.#timestamp(),
        };
        if (!this.#store.closeHandoff(cancelled)) {
          throw new AgentPlatformError("AGENT_INVALID_STATE", "The handoff is no longer open.");
        }
        events.push({
          type: "handoff.cancelled",
          projectId: current.projectId,
          subjectId: current.id,
        });
        return current.id;
      },
      (id) => this.#requireHandoff(id),
    );
  }

  listOpenHandoffs(actor: Actor, projectId: string | null): Handoff[] {
    this.#authorize(actor, "state.read", projectId);
    return this.#store.listOpenHandoffs(projectId);
  }

  // Reviews, merge gate, artifacts ---------------------------------------------------------------

  submitReview(
    context: CommandContext,
    input: {
      readonly taskId: string;
      readonly runId?: string;
      readonly kind: Review["kind"];
      readonly verdict: Review["verdict"];
      readonly findings: string;
    },
  ): Review {
    const task = this.#requireTask(input.taskId);
    const agent = this.#authorize(context.actor, "review.submit", task.projectId);
    return this.#command(
      context,
      "review.submit",
      input,
      "review",
      (events) => {
        if (input.runId !== undefined && this.#requireRun(input.runId).taskId !== task.id) {
          throw new AgentPlatformError(
            "AGENT_INVALID_REFERENCE",
            "The run belongs to another task.",
          );
        }
        const review: Review = {
          id: this.#newId(),
          taskId: task.id,
          runId: input.runId ?? null,
          reviewerAgentSessionId: agent?.id ?? null,
          kind: input.kind,
          verdict: input.verdict,
          findings: input.findings,
          createdAt: this.#timestamp(),
        };
        this.#store.insertReview(review);
        events.push({
          type: "review.submitted",
          projectId: task.projectId,
          subjectId: review.id,
          correlationId: task.id,
          data: { kind: review.kind, verdict: review.verdict },
        });
        return review.id;
      },
      (id) => this.#requireReview(id, task.id),
    );
  }

  /**
   * INV-09 / A11: integration needs the latest correctness and intent reviews to pass and no open
   * handoff blocking the task. Passing tests alone never opens the gate.
   */
  mergeGate(actor: Actor, taskId: string): { readonly open: boolean; readonly reasons: string[] } {
    const task = this.#requireTask(taskId);
    this.#authorize(actor, "state.read", task.projectId);
    const reviews = this.#store.listReviews(task.id);
    const reasons: string[] = [];
    for (const kind of ["correctness", "intent"] as const) {
      const latest = reviews.filter((review) => review.kind === kind).at(-1);
      if (latest === undefined) reasons.push(`missing-${kind}-review`);
      else if (latest.verdict !== "pass") reasons.push(`${kind}-review-${latest.verdict}`);
    }
    const blocking = this.#store
      .listOpenHandoffs(task.projectId)
      .filter((handoff) => handoff.payload.blockingTaskIds.includes(task.id));
    for (const handoff of blocking) reasons.push(`open-handoff-${handoff.kind}`);
    return { open: reasons.length === 0, reasons };
  }

  // Workspace and merge (AP-D004 L5/L6, AP-D016) -------------------------------------------------

  /** Checked before Naru creates a worktree for a task; the worktree belongs to its project. */
  authorizeWorktree(actor: Actor, taskId: string): AgentTask {
    const task = this.#requireTask(taskId);
    this.#authorize(actor, "workspace.worktree", task.projectId);
    return task;
  }

  /** The worktree Naru already made for this task and branch (a retried create returns it). */
  findTaskWorktree(taskId: string, branch: string): AgentWorktree | null {
    return this.#store.findTaskWorktree(taskId, branch);
  }

  /**
   * Records a worktree Naru created and connected for a task. Its branch becomes the task's branch
   * artifact, which a later merge integrates.
   */
  recordWorktree(
    context: CommandContext,
    input: { readonly taskId: string; readonly worktreeProjectId: string; readonly branch: string },
  ): AgentWorktree {
    const task = this.authorizeWorktree(context.actor, input.taskId);
    return this.#command(
      context,
      "workspace.worktree",
      input,
      "worktree",
      (events) => {
        this.#requireProject(input.worktreeProjectId);
        const now = this.#timestamp();
        this.#store.insertWorktree({
          projectId: input.worktreeProjectId,
          parentProjectId: task.projectId,
          taskId: task.id,
          branch: input.branch,
          createdByAgentSessionId:
            context.actor.kind === "agent" ? context.actor.agentSessionId : null,
          createdAt: now,
        });
        const artifact: Artifact = {
          id: this.#newId(),
          taskId: task.id,
          runId: null,
          kind: "branch",
          reference: input.branch,
          summary: "Naru worktree",
          exitCode: null,
          createdAt: now,
        };
        this.#store.insertArtifact(artifact);
        events.push({
          type: "artifact.published",
          projectId: task.projectId,
          subjectId: artifact.id,
          correlationId: task.id,
          data: { kind: artifact.kind, exitCode: null },
        });
        return input.worktreeProjectId;
      },
      (id) => this.#requireWorktree(id),
    );
  }

  /**
   * What a merge may integrate: the task's latest branch artifact, and only while the merge gate
   * is open (both reviews pass, no open handoff blocks the task).
   */
  authorizeMerge(
    actor: Actor,
    taskId: string,
  ): { readonly task: AgentTask; readonly branch: string } {
    const task = this.#requireTask(taskId);
    this.#authorize(actor, "task.merge", task.projectId);
    const gate = this.mergeGate(actor, task.id);
    if (!gate.open) {
      throw new AgentPlatformError(
        "AGENT_INVALID_STATE",
        `The merge gate is closed: ${gate.reasons.join(", ")}.`,
      );
    }
    const branch = this.#store
      .listArtifacts(task.id)
      .filter((artifact) => artifact.kind === "branch")
      .at(-1)?.reference;
    if (branch === undefined) {
      throw new AgentPlatformError(
        "AGENT_INVALID_STATE",
        "The task has no branch artifact to merge.",
      );
    }
    return { task, branch };
  }

  /** Records the commit a merge produced as the task's artifact. */
  recordMerge(
    context: CommandContext,
    input: { readonly taskId: string; readonly commit: string; readonly summary: string },
  ): Artifact {
    const task = this.#requireTask(input.taskId);
    this.#authorize(context.actor, "task.merge", task.projectId);
    return this.#command(
      context,
      "task.merge",
      input,
      "artifact",
      (events) => {
        const artifact: Artifact = {
          id: this.#newId(),
          taskId: task.id,
          runId: null,
          kind: "commit",
          reference: input.commit,
          summary: input.summary,
          exitCode: null,
          createdAt: this.#timestamp(),
        };
        this.#store.insertArtifact(artifact);
        events.push({
          type: "artifact.published",
          projectId: task.projectId,
          subjectId: artifact.id,
          correlationId: task.id,
          data: { kind: artifact.kind, exitCode: null },
        });
        return artifact.id;
      },
      (id) => this.#requireArtifact(id, task.id),
    );
  }

  /** An orchestrator may stop a working agent's turn in its project unless a person holds it. */
  authorizeInterrupt(actor: Actor, agentSessionId: string): AgentSession {
    const target = this.#requireAgentSession(agentSessionId);
    this.#authorize(actor, "agent.interrupt", target.projectId);
    if (target.role === "main-orchestrator" || target.role === "project-orchestrator") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Orchestrators are not interrupted.");
    }
    this.#assertNotHeld(actor, target.id);
    return target;
  }

  /** An agent may open a view Pane (files, docs) for the person in its own scope. */
  authorizePaneOpen(actor: Actor, projectId: string): void {
    this.#requireProject(projectId);
    this.#authorize(actor, "pane.open", projectId);
  }

  getTaskDetail(actor: Actor, taskId: string): AgentTaskDetail {
    const task = this.#requireTask(taskId);
    this.#authorize(actor, "state.read", task.projectId);
    return {
      task,
      runs: this.#store.listRuns(task.id),
      reviews: this.#store.listReviews(task.id),
      artifacts: this.#store.listArtifacts(task.id),
      mergeGate: this.mergeGate(actor, task.id),
    };
  }

  publishArtifact(
    context: CommandContext,
    input: {
      readonly taskId: string;
      readonly runId?: string;
      readonly kind: Artifact["kind"];
      readonly reference: string;
      readonly summary?: string;
      readonly exitCode?: number;
    },
  ): Artifact {
    const task = this.#requireTask(input.taskId);
    this.#authorize(context.actor, "artifact.publish", task.projectId);
    return this.#command(
      context,
      "artifact.publish",
      input,
      "artifact",
      (events) => {
        if (input.runId !== undefined && this.#requireRun(input.runId).taskId !== task.id) {
          throw new AgentPlatformError(
            "AGENT_INVALID_REFERENCE",
            "The run belongs to another task.",
          );
        }
        const artifact: Artifact = {
          id: this.#newId(),
          taskId: task.id,
          runId: input.runId ?? null,
          kind: input.kind,
          reference: input.reference,
          summary: input.summary ?? null,
          exitCode: input.exitCode ?? null,
          createdAt: this.#timestamp(),
        };
        this.#store.insertArtifact(artifact);
        events.push({
          type: "artifact.published",
          projectId: task.projectId,
          subjectId: artifact.id,
          correlationId: task.id,
          data: { kind: artifact.kind, exitCode: artifact.exitCode },
        });
        return artifact.id;
      },
      (id) => this.#requireArtifact(id, task.id),
    );
  }

  // Events ---------------------------------------------------------------------------------------

  /**
   * Whether an event is addressed to a working agent (worker, reviewer, specialist): work delegated
   * to it or its tasks, a change to its task, a review of it, its handoff answered, its hold or its
   * process handed back. Naru wakes the agent for these; orchestrators follow their whole scope.
   */
  eventConcernsAgent(event: AgentEvent, agentSessionId: string): boolean {
    const assignedTo = (taskId: string | null) =>
      taskId !== null && this.#store.getTask(taskId)?.assigneeAgentSessionId === agentSessionId;
    switch (event.type) {
      case "instruction.created": {
        const scope = this.#store.getInstruction(event.subjectId)?.scope;
        if (scope?.kind === "agent") return scope.agentSessionId === agentSessionId;
        return scope?.kind === "task" && assignedTo(scope.taskId);
      }
      case "task.created":
      case "task.updated":
        return assignedTo(event.subjectId);
      case "review.submitted":
        return assignedTo(event.correlationId);
      case "handoff.resolved":
      case "handoff.cancelled": {
        const requester = this.#store.getHandoff(event.subjectId)?.requestedBy;
        return requester?.kind === "agent" && requester.agentSessionId === agentSessionId;
      }
      case "agent_session.hold_released":
        return event.subjectId === agentSessionId;
      case "shared_process.hold_released":
        return this.#store.getSharedProcess(event.subjectId)?.agentSessionId === agentSessionId;
      default:
        return false;
    }
  }

  readEvents(
    actor: Actor,
    options: {
      readonly afterSeq: number;
      readonly projectId?: string;
      readonly limit?: number;
      readonly latest?: boolean;
    },
  ): AgentEvent[] {
    const agent = this.#authorize(actor, "state.read", options.projectId ?? null);
    const projectId = options.projectId ?? agent?.projectId ?? undefined;
    return this.#store.readEvents({
      afterSeq: options.afterSeq,
      ...(projectId === undefined ? {} : { projectId }),
      limit: Math.min(options.limit ?? 100, NARU_AGENT_LIMITS.eventReadLimit),
      latest: options.latest === true,
    });
  }

  getCursor(consumerId: string): number {
    return this.#store.getCursor(consumerId);
  }

  advanceCursor(consumerId: string, seq: number): void {
    this.#store.advanceCursor(consumerId, seq);
  }

  // Internals ------------------------------------------------------------------------------------

  /** True when this actor already ran a command under the key (a retried request). */
  commandRecorded(actor: Actor, idempotencyKey: string): boolean {
    const actorKey = actor.kind === "agent" ? `agent:${actor.agentSessionId}` : actor.kind;
    return this.#store.findCommand(actorKey, idempotencyKey) !== null;
  }

  #command<T>(
    context: CommandContext,
    name: string,
    payload: unknown,
    resultType: string,
    work: (events: EventDraft[]) => string,
    read: (id: string) => T,
  ): T {
    const actorKey =
      context.actor.kind === "agent" ? `agent:${context.actor.agentSessionId}` : context.actor.kind;
    const fingerprint = createHash("sha256")
      .update(name)
      .update("\0")
      .update(JSON.stringify(payload))
      .digest("hex");
    const appended: AgentEvent[] = [];
    const resultId = this.#store.transaction(() => {
      const existing = this.#store.findCommand(actorKey, context.idempotencyKey);
      if (existing !== null) {
        if (existing.fingerprint !== fingerprint || existing.resultType !== resultType) {
          throw new AgentPlatformError(
            "AGENT_IDEMPOTENCY_CONFLICT",
            "The idempotency key was already used for a different command.",
          );
        }
        return existing.resultId;
      }
      const drafts: EventDraft[] = [];
      const id = work(drafts);
      const createdAt = this.#timestamp();
      for (const draft of drafts) {
        appended.push(
          this.#store.appendEvent({
            id: this.#newId(),
            type: draft.type,
            projectId: draft.projectId,
            actor: context.actor,
            subjectId: draft.subjectId,
            correlationId: draft.correlationId ?? null,
            data: draft.data ?? {},
            createdAt,
          }),
        );
      }
      this.#store.recordCommand({
        actorKey,
        idempotencyKey: context.idempotencyKey,
        fingerprint,
        resultType,
        resultId: id,
        createdAt,
      });
      return id;
    });
    this.#emit(appended);
    return read(resultId);
  }

  #emit(events: readonly AgentEvent[]): void {
    for (const event of events) {
      for (const listener of this.#listeners) {
        try {
          listener(event);
        } catch {
          // A failing subscriber must not undo a committed command; it can re-read by cursor.
        }
      }
    }
  }

  #instruction(
    input: Omit<Instruction, "id" | "forgottenAt" | "createdAt"> & { verbatim: string },
  ): Instruction {
    if (input.verbatim.trim().length === 0) {
      throw new AgentPlatformError("AGENT_INVALID_REFERENCE", "An instruction needs text.");
    }
    const instruction: Instruction = {
      ...input,
      id: this.#newId(),
      forgottenAt: null,
      createdAt: this.#timestamp(),
    };
    this.#store.insertInstruction(instruction);
    return instruction;
  }

  /** Returns the acting agent session (null for humans and the system). */
  #authorize(
    actor: Actor,
    command: AgentCommandName,
    projectId: string | null,
  ): AgentSession | null {
    if (actor.kind !== "agent") return null;
    const agent = this.#requireAgentSession(actor.agentSessionId);
    if (agent.status === "stopped" || agent.status === "failed") {
      throw new AgentPlatformError("AGENT_SCOPE_DENIED", "The agent session is no longer active.");
    }
    if (!AGENT_ROLE_COMMANDS[agent.role].includes(command)) {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", `Role ${agent.role} cannot ${command}.`);
    }
    // The main orchestrator is global; every other role is confined to its own project.
    if (agent.role !== "main-orchestrator" && !this.#inAgentProject(agent, projectId)) {
      throw new AgentPlatformError(
        "AGENT_SCOPE_DENIED",
        "The target is outside the agent's project.",
      );
    }
    if (
      agent.role === "main-orchestrator" &&
      command !== "state.read" &&
      command !== "instruction.delegate" &&
      command !== "agent_session.register" &&
      command !== "agent.spawn" &&
      command !== "handoff.request" &&
      command !== "handoff.cancel"
    ) {
      throw new AgentPlatformError(
        "AGENT_ROLE_DENIED",
        "The main orchestrator works through projects.",
      );
    }
    return agent;
  }

  /** The agent's project and the worktrees Naru made for it (AP-D016). */
  #inAgentProject(agent: AgentSession, projectId: string | null): boolean {
    if (projectId === agent.projectId) return true;
    return (
      projectId !== null &&
      agent.projectId !== null &&
      this.#store.getWorktree(projectId)?.parentProjectId === agent.projectId
    );
  }

  #authorizeTaskUpdate(
    actor: Actor,
    task: AgentTask,
    ownStatusOnly: boolean,
    status: AgentTaskStatus | undefined,
  ): AgentSession | null {
    if (actor.kind !== "agent") return null;
    const agent = this.#requireAgentSession(actor.agentSessionId);
    if (AGENT_ROLE_COMMANDS[agent.role].includes("task.update")) {
      return this.#authorize(actor, "task.update", task.projectId);
    }
    this.#authorize(actor, "task.update_own_status", task.projectId);
    const allowed: readonly string[] = WORKER_TASK_STATUSES;
    if (
      !ownStatusOnly ||
      task.assigneeAgentSessionId !== agent.id ||
      status === undefined ||
      !allowed.includes(status)
    ) {
      throw new AgentPlatformError(
        "AGENT_ROLE_DENIED",
        "A worker may only move its own task to running, blocked or review.",
      );
    }
    return agent;
  }

  #authorizeRunActor(actor: Actor, command: AgentCommandName, task: AgentTask, run: Run): void {
    const agent = this.#authorize(actor, command, task.projectId);
    if (agent === null || agent.role === "project-orchestrator") return;
    if (run.agentSessionId !== agent.id) {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only the run's own agent may report it.");
    }
  }

  #requireAssignable(actor: Actor, agentSessionId: string, projectId: string): void {
    this.#requireAgentSessionInProject(agentSessionId, projectId);
    this.#assertNotHeld(actor, agentSessionId);
  }

  #assertNotHeld(actor: Actor, agentSessionId: string): void {
    if (actor.kind !== "agent") return;
    if (this.#requireAgentSession(agentSessionId).humanHoldSince !== null) {
      throw new AgentPlatformError(
        "AGENT_HELD_BY_HUMAN",
        "A human is working with this agent; wait for the hold release event.",
      );
    }
  }

  #actorProject(actor: Actor): string | null {
    return actor.kind === "agent"
      ? this.#requireAgentSession(actor.agentSessionId).projectId
      : null;
  }

  #nativeRecipient(name: string): AgentSession {
    const prefix = /^naru-([0-9a-f]{12})$/u.exec(name)?.[1];
    const matches = prefix === undefined ? [] : this.#store.findAgentSessionsByIdPrefix(prefix);
    const recipient = matches.find((session) => nativeSessionName(session.id) === name);
    if (recipient === undefined || matches.length !== 1 || recipient.runtime !== "claude") {
      throw new AgentPlatformError("AGENT_NOT_FOUND", "Not a Naru-managed session.");
    }
    if (recipient.status === "stopped" || recipient.status === "failed") {
      throw new AgentPlatformError("AGENT_INVALID_STATE", "The recipient session has ended.");
    }
    return recipient;
  }

  /** INV-01: the sender's current task, else the latest user instruction in force for it. */
  #originFor(sender: AgentSession): string {
    const task = this.#store.findCurrentTaskForAgent(sender.id);
    if (task !== null) return task.originInstructionId;
    const latest = this.#store
      .listApplicableHumanInstructions({
        projectId: sender.projectId,
        taskId: null,
        agentSessionId: sender.id,
      })
      .at(-1);
    if (latest === undefined) {
      throw new AgentPlatformError(
        "AGENT_INVALID_REFERENCE",
        "No user instruction is in force for this agent; a message needs one to cite.",
      );
    }
    return latest.id;
  }

  #requireSharedProcess(id: string): SharedProcess {
    return this.#store.getSharedProcess(id) ?? throwNotFound("shared process");
  }

  #assertProcessWritable(process: SharedProcess): void {
    if (process.humanHoldSince !== null) {
      throw new AgentPlatformError(
        "AGENT_HELD_BY_HUMAN",
        "A person is using this process; wait for shared_process.hold_released.",
      );
    }
    if (process.status !== "running" && process.status !== "starting") {
      throw new AgentPlatformError("AGENT_INVALID_STATE", "The process is not running.");
    }
  }

  #requireSystem(actor: Actor): void {
    if (actor.kind !== "system") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only Naru's runtime reports this.");
    }
  }

  #requireSystemOrHuman(actor: Actor): void {
    if (actor.kind === "agent") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Agents cannot list this.");
    }
  }

  #requireHuman(actor: Actor): void {
    if (actor.kind !== "human") {
      throw new AgentPlatformError("AGENT_ROLE_DENIED", "Only the user may do this.");
    }
  }

  #assertScope(scope: InstructionScope): void {
    switch (scope.kind) {
      case "global":
        return;
      case "project":
        this.#requireProject(scope.projectId);
        return;
      case "task":
        this.#requireTaskInProject(scope.taskId, scope.projectId);
        return;
      case "agent": {
        const session = this.#requireAgentSession(scope.agentSessionId);
        if (session.projectId !== scope.projectId) {
          throw new AgentPlatformError("AGENT_INVALID_REFERENCE", "Agent scope project mismatch.");
        }
        return;
      }
    }
  }

  #requireSupersedable(instructionId: string): void {
    const previous = this.#requireInstruction(instructionId);
    if (previous.author.kind !== "human") {
      throw new AgentPlatformError("AGENT_INVALID_REFERENCE", "Only human instructions supersede.");
    }
  }

  #requireOriginForProject(instructionId: string, projectId: string): void {
    const instruction = this.#requireInstruction(instructionId);
    const instructionProject = scopeProjectId(instruction.scope);
    if (instructionProject !== null && instructionProject !== projectId) {
      throw new AgentPlatformError(
        "AGENT_INVALID_REFERENCE",
        "The origin instruction belongs to another project.",
      );
    }
  }

  #requireProject(projectId: string): void {
    if (!this.#store.projectExists(projectId)) throw notFound("project");
  }

  #requireInstruction(id: string): Instruction {
    return this.#store.getInstruction(id) ?? throwNotFound("instruction");
  }

  #requireIntentContract(id: string): IntentContract {
    return this.#store.getIntentContract(id) ?? throwNotFound("intent contract");
  }

  #requirePlan(id: string): Plan {
    return this.#store.getPlan(id) ?? throwNotFound("plan");
  }

  #requirePlanInProject(id: string, projectId: string): void {
    if (this.#requirePlan(id).projectId !== projectId) throw notFound("plan");
  }

  #requireTask(id: string): AgentTask {
    return this.#store.getTask(id) ?? throwNotFound("task");
  }

  #requireTaskInProject(id: string, projectId: string): void {
    if (this.#requireTask(id).projectId !== projectId) throw notFound("task");
  }

  #requireRun(id: string): Run {
    return this.#store.getRun(id) ?? throwNotFound("run");
  }

  #requireAgentSession(id: string): AgentSession {
    return this.#store.getAgentSession(id) ?? throwNotFound("agent session");
  }

  #requireAgentSessionInProject(id: string, projectId: string): void {
    if (this.#requireAgentSession(id).projectId !== projectId) throw notFound("agent session");
  }

  #requireHandoff(id: string): Handoff {
    return this.#store.getHandoff(id) ?? throwNotFound("handoff");
  }

  #requireReview(id: string, taskId: string): Review {
    return (
      this.#store.listReviews(taskId).find((review) => review.id === id) ?? throwNotFound("review")
    );
  }

  #requireWorktree(projectId: string): AgentWorktree {
    return this.#store.getWorktree(projectId) ?? throwNotFound("worktree");
  }

  #requireArtifact(id: string, taskId: string): Artifact {
    return (
      this.#store.listArtifacts(taskId).find((artifact) => artifact.id === id) ??
      throwNotFound("artifact")
    );
  }

  #timestamp(): string {
    return this.#now().toISOString();
  }
}

const CAPABILITY_PATTERN = /^[A-Za-z0-9_-]{43}$/;
/** Instructions one conversation view reads: the newest, enough for a long-running agent. */
const CONVERSATION_INSTRUCTIONS = 200;

/** The `--name` Naru gives a managed Claude session; recipients are resolved from it (AP-D015). */
export function nativeSessionName(agentSessionId: string): string {
  return `naru-${agentSessionId.replaceAll("-", "").slice(0, 12)}`;
}

function nativeBodyDigest(text: string): string {
  return createHash("sha256").update(text.replace(/\s+/gu, " ").trim()).digest("hex");
}

/** `<cross-session-message from="uds:…/<pid>.sock" …>body</cross-session-message>` (V06, V06b). */
export function parseCrossSessionPrompt(
  prompt: string,
): { readonly pid: number | null; readonly name: string | null; readonly body: string } | null {
  const match = /^<cross-session-message\s+([^>]*)>([\s\S]*)<\/cross-session-message>\s*$/u.exec(
    prompt.trim(),
  );
  if (match === null) return null;
  const attributes = match[1]!;
  const pid = /\bfrom="uds:[^"]*?(\d+)\.sock"/u.exec(attributes)?.[1];
  const name = /\bfrom-name="([^"]*)"/u.exec(attributes)?.[1];
  return {
    pid: pid === undefined ? null : Number(pid),
    name: name ?? null,
    body: match[2]!.trim(),
  };
}

function capabilityDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function instructionCreated(instruction: Instruction): EventDraft {
  return {
    type: "instruction.created",
    projectId: scopeProjectId(instruction.scope),
    subjectId: instruction.id,
    correlationId: instruction.originUserInstructionId,
    data: {
      scope: instruction.scope.kind,
      author: instruction.author.kind,
      channel: instruction.channel,
      supersedes: instruction.supersedesId,
    },
  };
}

function scopeProjectId(scope: InstructionScope): string | null {
  return scope.kind === "global" ? null : scope.projectId;
}

function isFinished(status: Run["status"]): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

const ROLE_ORDER: readonly AgentRole[] = [
  "main-orchestrator",
  "project-orchestrator",
  "worker",
  "reviewer",
  "specialist",
];

/** Lower rank = higher authority; workers, reviewers and specialists are peers below orchestrators. */
function roleRank(role: AgentRole): number {
  return Math.min(ROLE_ORDER.indexOf(role), 2);
}

function notFound(what: string): AgentPlatformError {
  return new AgentPlatformError("AGENT_NOT_FOUND", `The ${what} was not found.`);
}

function throwNotFound(what: string): never {
  throw notFound(what);
}
