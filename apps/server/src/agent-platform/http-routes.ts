import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  AgentEventsQuerySchema,
  ApproveIntentContractRequestSchema,
  CreateHumanInstructionRequestSchema,
  IdempotentRequestSchema,
  ResolveHandoffRequestSchema,
  SetAgentHoldRequestSchema,
  type Actor,
} from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore } from "./core.js";

const HUMAN: Actor = { kind: "human" };
const IdParamsSchema = z.strictObject({ id: z.string().uuid() });
const ProjectQuerySchema = z.strictObject({ projectId: z.string().uuid().optional() });

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

  app.post("/api/agent/agents/:id/hold", (request) => {
    mutate(request);
    const { id } = IdParamsSchema.parse(request.params);
    const input = SetAgentHoldRequestSchema.parse(request.body);
    return core.setHumanHold(
      { actor: HUMAN, idempotencyKey: input.idempotencyKey },
      { agentSessionId: id, held: input.held, reason: input.held ? "takeover" : "release" },
    );
  });
}
