import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AgentApprovalResponseRequestSchema,
  AgentEventsQuerySchema,
  AgentHistoryPageSchema,
  AgentHistoryQuerySchema,
  AgentInterruptRequestSchema,
  AgentTurnRequestSchema,
  ApproveIntentContractRequestSchema,
  CreateHumanInstructionRequestSchema,
  CreateManagedAgentRequestSchema,
  IdempotentRequestSchema,
  ResolveHandoffRequestSchema,
  SetAgentHoldRequestSchema,
  SetProcessHoldRequestSchema,
  type Actor,
  type AgentRuntimeState,
  type AgentSession,
  type SharedProcess,
} from "@naru/contracts/naru-agent/v1";
import type { HistoryPage } from "../agent-runtime/adapter.js";
import { SupervisorError } from "../agent-runtime/supervisor.js";
import type { WriterKind } from "../agent-runtime/writer-gate.js";
import { AgentPlatformError, type AgentPlatformCore } from "./core.js";

const HUMAN: Actor = { kind: "human" };
const IdParamsSchema = z.strictObject({ id: z.string().uuid() });
const ProjectQuerySchema = z.strictObject({ projectId: z.string().uuid().optional() });
const ApprovalParamsSchema = z.strictObject({
  id: z.string().uuid(),
  requestId: z.string().min(1).max(200),
});
const EmptyBodySchema = z.strictObject({}).optional();

/** The managed agent runtime (ManagedAgentSupervisor) as the browser routes use it. */
export interface AgentRuntimeControl {
  launch(agentSessionId: string, options?: { readonly hostProjectId?: string }): Promise<void>;
  stop(agentSessionId: string): void;
  runtimeState(agentSessionId: string): AgentRuntimeState;
  assertWriter(
    agentSessionId: string,
    writer: WriterKind,
    generation: number,
    kind: "turn" | "interrupt" | "approval-response",
  ): void;
  sendTurn(agentSessionId: string, text: string, writer: WriterKind, generation: number): void;
  interrupt(agentSessionId: string, writer: WriterKind, generation: number): void;
  respondApproval(
    agentSessionId: string,
    requestId: string,
    decision: "approve" | "deny",
    writer: WriterKind,
    generation: number,
  ): void;
  readHistory(agentSessionId: string, cursor: string | null): Promise<HistoryPage>;
  switchWriter(agentSessionId: string, to: WriterKind, interrupt: boolean): Promise<unknown>;
}

/** Shared processes (SharedProcessRuntime) as the browser routes use them. */
export interface SharedProcessControl {
  setHold(
    context: { readonly actor: Actor; readonly idempotencyKey: string },
    processId: string,
    held: boolean,
    reason: "takeover" | "release",
  ): Promise<SharedProcess>;
  stop(actor: Actor, processId: string): Promise<SharedProcess>;
}

export interface AgentRouteGuards {
  /** Gateway or app session; required for every read. */
  readonly requireSession: (request: FastifyRequest) => void;
  /** Origin and CSRF checks for mutations. */
  readonly requireUnsafeRequest: (request: FastifyRequest) => void;
  /** The human device lease (AP-D005 first layer); agents never pass through these routes. */
  readonly requireSurfaceController: (request: FastifyRequest) => void;
}

/** Browser routes for the user (human actor). Agents use the MCP socket instead. */
export function registerAgentPlatformRoutes(
  app: FastifyInstance,
  core: AgentPlatformCore,
  guards: AgentRouteGuards,
  runtime?: AgentRuntimeControl,
  processes?: SharedProcessControl,
  noteHumanInput?: (target: { readonly agentSessionId: string }) => void,
): void {
  const mutate = (request: FastifyRequest): void => {
    guards.requireUnsafeRequest(request);
    guards.requireSurfaceController(request);
  };

  app.get("/api/agent/overview", (request) => {
    guards.requireSession(request);
    return core.getOverview(HUMAN);
  });

  app.get("/api/agent/projects/:id", (request) => {
    guards.requireSession(request);
    const { id } = IdParamsSchema.parse(request.params);
    return {
      ...core.getProjectState(HUMAN, id),
      agents: core.listAgentSessions(HUMAN, id),
      instructions: core.getApplicableInstructions(HUMAN, { projectId: id }),
      processes: core.listSharedProcesses(HUMAN, id),
    };
  });

  app.get("/api/agent/handoffs", (request) => {
    guards.requireSession(request);
    const { projectId } = ProjectQuerySchema.parse(request.query);
    return core.listOpenHandoffs(HUMAN, projectId ?? null);
  });

  app.get("/api/agent/events", (request) => {
    guards.requireSession(request);
    const query = AgentEventsQuerySchema.parse(request.query);
    return core.readEvents(HUMAN, {
      afterSeq: query.after,
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.limit === undefined ? {} : { limit: query.limit }),
    });
  });

  app.get("/api/agent/tasks/:id/merge-gate", (request) => {
    guards.requireSession(request);
    const { id } = IdParamsSchema.parse(request.params);
    return core.mergeGate(HUMAN, id);
  });

  app.post("/api/agent/instructions", (request, reply) => {
    mutate(request);
    const input = CreateHumanInstructionRequestSchema.parse(request.body);
    const instruction = core.createHumanInstruction(
      { actor: HUMAN, idempotencyKey: input.idempotencyKey },
      {
        scope: input.scope,
        verbatim: input.verbatim,
        ...(input.supersedesId === undefined ? {} : { supersedesId: input.supersedesId }),
      },
    );
    return reply.code(201).send(instruction);
  });

  app.post("/api/agent/instructions/:id/forget", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const { idempotencyKey } = IdempotentRequestSchema.parse(request.body);
    return core.forgetInstruction({ actor: HUMAN, idempotencyKey }, { instructionId: id });
  });

  app.post("/api/agent/handoffs/:id/resolve", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const input = ResolveHandoffRequestSchema.parse(request.body);
    return core.resolveHandoff(
      { actor: HUMAN, idempotencyKey: input.idempotencyKey },
      {
        handoffId: id,
        decision: input.decision,
        ...(input.chosenOption === undefined ? {} : { chosenOption: input.chosenOption }),
      },
    );
  });

  app.post("/api/agent/handoffs/:id/cancel", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const { idempotencyKey } = IdempotentRequestSchema.parse(request.body);
    return core.cancelHandoff({ actor: HUMAN, idempotencyKey }, { handoffId: id });
  });

  app.post("/api/agent/intent-contracts/:id/approve", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const input = ApproveIntentContractRequestSchema.parse(request.body);
    return core.approveIntentContract(
      { actor: HUMAN, idempotencyKey: input.idempotencyKey },
      {
        intentContractId: id,
        ...(input.handoffId === undefined ? {} : { handoffId: input.handoffId }),
      },
    );
  });

  /**
   * "직접 개입" (AP-D005): the hold blocks orchestrator writes in Core first, then the conversation
   * writer moves to the person (Chat live, TUI by stop-resume). Release reverses the order so
   * orchestrators are woken only once they can write again.
   */
  app.post("/api/agent/agents/:id/hold", async (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const input = SetAgentHoldRequestSchema.parse(request.body);
    const context = { actor: HUMAN, idempotencyKey: input.idempotencyKey };
    const managed = runtime !== undefined && isManaged(core.getAgentSession(HUMAN, id));
    if (input.held) {
      const held = core.setHumanHold(context, { agentSessionId: id, held: true, reason: "takeover" });
      if (!managed) return held;
      const to: WriterKind = input.surface === "tui" ? "tui" : "gui";
      await runtimeCall(() => runtime.switchWriter(id, to, input.interrupt ?? false));
      return core.getAgentSession(HUMAN, id);
    }
    if (managed) await runtimeCall(() => runtime.switchWriter(id, "orchestrator", false));
    return core.setHumanHold(context, { agentSessionId: id, held: false, reason: "release" });
  });

  if (processes !== undefined) {
    /** "직접 개입" in a shared process terminal (A09); return wakes the agent with an event. */
    app.post("/api/agent/processes/:id/hold", async (request) => {
      mutate(request);
      const { id } = IdParamsSchema.parse(request.params);
      const input = SetProcessHoldRequestSchema.parse(request.body);
      return processes.setHold(
        { actor: HUMAN, idempotencyKey: input.idempotencyKey },
        id,
        input.held,
        input.held ? "takeover" : "release",
      );
    });

    app.post("/api/agent/processes/:id/stop", async (request) => {
      mutate(request);
      const { id } = IdParamsSchema.parse(request.params);
      EmptyBodySchema.parse(request.body);
      return processes.stop(HUMAN, id);
    });
  }

  if (runtime === undefined) return;

  app.post("/api/agent/agents", async (request, reply) => {
    mutate(request);
    const input = CreateManagedAgentRequestSchema.parse(request.body);
    const replay = core.commandRecorded(HUMAN, input.idempotencyKey);
    const main = input.role === "main-orchestrator";
    const agent = core.registerAgentSession(
      { actor: HUMAN, idempotencyKey: input.idempotencyKey },
      {
        projectId: main ? null : input.projectId,
        role: input.role,
        runtime: input.runtime,
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    );
    if (!replay) {
      await runtimeCall(() =>
        runtime.launch(agent.id, main ? { hostProjectId: input.hostProjectId } : {}),
      );
    }
    return reply.code(201).send(core.getAgentSession(HUMAN, agent.id));
  });

  app.post("/api/agent/agents/:id/launch", async (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    EmptyBodySchema.parse(request.body);
    const agent = core.getAgentSession(HUMAN, id);
    if ((agent.runtime !== "claude" && agent.runtime !== "codex") || agent.native) {
      throw new AgentPlatformError("AGENT_RUNTIME_UNAVAILABLE", "This agent has no Naru runtime.");
    }
    await runtimeCall(() => runtime.launch(id));
    return runtimeCall(() => runtime.runtimeState(id));
  });

  app.post("/api/agent/agents/:id/stop", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    EmptyBodySchema.parse(request.body);
    core.getAgentSession(HUMAN, id);
    runtimeCall(() => runtime.stop(id));
    return runtimeCall(() => runtime.runtimeState(id));
  });

  app.get("/api/agent/agents/:id/runtime", (request) => {
    guards.requireSession(request);
    const { id } = IdParamsSchema.parse(request.params);
    core.getAgentSession(HUMAN, id);
    return runtimeCall(() => runtime.runtimeState(id));
  });

  app.get("/api/agent/agents/:id/history", async (request) => {
    guards.requireSession(request);
    const { id } = IdParamsSchema.parse(request.params);
    const { cursor } = AgentHistoryQuerySchema.parse(request.query);
    core.getAgentSession(HUMAN, id);
    const page = await runtimeCall(() => runtime.readHistory(id, cursor ?? null));
    return AgentHistoryPageSchema.parse(page);
  });

  /** A person writing to the conversation they hold; recorded verbatim as their instruction. */
  app.post("/api/agent/agents/:id/turns", (request, reply) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const input = AgentTurnRequestSchema.parse(request.body);
    const agent = core.getAgentSession(HUMAN, id);
    if (core.commandRecorded(HUMAN, input.idempotencyKey)) {
      return reply.code(202).send(runtimeCall(() => runtime.runtimeState(id)));
    }
    runtimeCall(() => runtime.assertWriter(id, "gui", input.generation, "turn"));
    core.createHumanInstruction(
      { actor: HUMAN, idempotencyKey: input.idempotencyKey },
      {
        scope: { kind: "agent", projectId: agent.projectId, agentSessionId: id },
        verbatim: input.text,
      },
    );
    runtimeCall(() => runtime.sendTurn(id, input.text, "gui", input.generation));
    noteHumanInput?.({ agentSessionId: id });
    return reply.code(202).send(runtimeCall(() => runtime.runtimeState(id)));
  });

  app.post("/api/agent/agents/:id/interrupt", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const { generation } = AgentInterruptRequestSchema.parse(request.body);
    core.getAgentSession(HUMAN, id);
    runtimeCall(() => runtime.interrupt(id, "gui", generation));
    return runtimeCall(() => runtime.runtimeState(id));
  });

  app.post("/api/agent/agents/:id/approvals/:requestId", (request) => {
    mutate(request);
    const { id, requestId } = ApprovalParamsSchema.parse(request.params);
    const input = AgentApprovalResponseRequestSchema.parse(request.body);
    core.getAgentSession(HUMAN, id);
    runtimeCall(() =>
      runtime.respondApproval(id, requestId, input.decision, "gui", input.generation),
    );
    return runtimeCall(() => runtime.runtimeState(id));
  });
}

/** Launched by Naru in a Pane; other sessions only carry the Core hold. */
function isManaged(agent: AgentSession): boolean {
  return (
    (agent.runtime === "claude" || agent.runtime === "codex") &&
    !agent.native &&
    agent.paneId !== null
  );
}

/** Runtime refusals become the agent error contract the browser already understands. */
function runtimeCall<T>(call: () => T): T {
  try {
    const result = call();
    if (result instanceof Promise) {
      return result.catch((error: unknown) => {
        throw translateRuntimeError(error);
      }) as T;
    }
    return result;
  } catch (error) {
    throw translateRuntimeError(error);
  }
}

function translateRuntimeError(error: unknown): unknown {
  if (!(error instanceof SupervisorError)) return error;
  switch (error.code) {
    case "WRITER_REQUIRED":
      return new AgentPlatformError("AGENT_WRITER_REQUIRED", "Another writer owns this conversation.");
    case "APPROVAL_UNKNOWN":
      return new AgentPlatformError("AGENT_INVALID_STATE", "The approval is no longer pending.");
    case "RUNTIME_NOT_CONNECTED":
    case "HISTORY_TIMEOUT":
      return new AgentPlatformError("AGENT_RUNTIME_UNAVAILABLE", "The agent runtime is unavailable.");
  }
}
