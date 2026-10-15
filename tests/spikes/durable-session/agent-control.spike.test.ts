/**
 * V09: Agent Platform이 기대하는 agent/human 제어권 동작을 격리 Host(SessionService + fake runtime)에서
 * 기록한다. 제품 코드는 바꾸지 않으며 결과는 docs/agent-platform-v0/VALIDATION.md의 근거다.
 */
import { describe, expect, it } from "vitest";
import type {
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionOperationRequest,
  DurableSessionOperationResponse,
  DurableSessionOperationResult,
  SessionId,
} from "../../../packages/contracts/src/durable-session/v0/index.js";
import { DURABLE_SESSION_LIMITS } from "../../../packages/contracts/src/durable-session/v0/index.js";
import { HostCommandPolicy } from "../../../apps/durable-session-host/src/command-policy.js";
import { MemoryMetadataRepository } from "../../../apps/durable-session-host/src/metadata.js";
import { SessionService } from "../../../apps/durable-session-host/src/session-service.js";
import {
  createHostFixture,
  FakeClock,
  FakeIds,
  FakeRuntimePort,
  ownerCaller,
  profileCommand,
  TEST_IDS,
} from "../../../apps/durable-session-host/test/support.js";

const RUNTIME = TEST_IDS.runtime1;

describe("V09 agent and human control over one DurableSession", () => {
  it("lets a scoped agent subject own a Session while a human preempt fences its late input", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const agent = agentCaller(context.clock.value);
    const human = ownerCaller(context.clock.value);

    const sessionId = await createSession(context.service, agent);
    const agentAttachment = await openAttachment(context.service, agent, sessionId, 10);
    await ok(
      context.service.execute(agent, acquire(sessionId, agentAttachment, 0, 11)),
      "acquireControl",
    );
    await ok(
      context.service.execute(agent, input(sessionId, agentAttachment, 1, 12, "agent-command")),
      "sendInput",
    );

    // An agent caller never holds preempt.
    const agentPreempt = await context.service.execute(
      agent,
      preempt(sessionId, agentAttachment, 1, 13),
    );
    expect(code(agentPreempt)).toBe("CAPABILITY_REQUIRED");

    // The human observes without taking control, then explicitly takes over.
    const humanAttachment = await openAttachment(context.service, human, sessionId, 14);
    expect(humanAttachment.role).toBe("observer");
    const taken = await ok(
      context.service.execute(human, preempt(sessionId, humanAttachment, 1, 15)),
      "preemptControl",
    );
    expect(taken.control).toMatchObject({
      controllerAttachmentId: humanAttachment.attachmentId,
      controllerGeneration: 2,
    });

    // Late agent input from the previous generation is rejected and never reaches the PTY.
    const lateAgentInput = await context.service.execute(
      agent,
      input(sessionId, agentAttachment, 1, 16, "late-agent-input"),
    );
    expect(code(lateAgentInput)).toBe("CONTROL_GENERATION_STALE");
    const currentGenerationAgentInput = await context.service.execute(
      agent,
      input(sessionId, agentAttachment, 2, 17, "agent-while-human"),
    );
    expect(code(currentGenerationAgentInput)).toBe("ATTACHMENT_NOT_CONTROLLER");

    // While the human holds control the agent can neither acquire nor jump the queue.
    const agentAcquireWhileHeld = await context.service.execute(
      agent,
      acquire(sessionId, agentAttachment, 2, 18),
    );
    expect(code(agentAcquireWhileHeld)).toBe("CONTROL_HELD");

    await ok(
      context.service.execute(human, input(sessionId, humanAttachment, 2, 19, "human-answer")),
      "sendInput",
    );

    // Explicit human release returns control to the pool; the agent reacquires a new generation.
    const released = await ok(
      context.service.execute(human, release(sessionId, humanAttachment, 2, 20)),
      "releaseControl",
    );
    const afterRelease = released.control.controllerGeneration;
    expect(released.control.controllerAttachmentId).toBeNull();
    await ok(
      context.service.execute(agent, acquire(sessionId, agentAttachment, afterRelease, 21)),
      "acquireControl",
    );
    await ok(
      context.service.execute(
        agent,
        input(sessionId, agentAttachment, afterRelease + 1, 22, "agent-resumes"),
      ),
      "sendInput",
    );

    expect(context.runtime.records[0]?.writes).toEqual([
      "agent-command",
      "human-answer",
      "agent-resumes",
    ]);
    await context.service.shutdown();
  });

  it("binds attachments to their subject so an agent cannot drive a human attachment", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const agent = agentCaller(context.clock.value);
    const human = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, human);
    const humanAttachment = await openAttachment(context.service, human, sessionId, 30);
    await ok(
      context.service.execute(human, acquire(sessionId, humanAttachment, 0, 31)),
      "acquireControl",
    );

    const borrowedInput = await context.service.execute(
      agent,
      input(sessionId, humanAttachment, 1, 32, "borrowed"),
    );
    expect(code(borrowedInput)).toBe("ATTACHMENT_NOT_FOUND");
    const borrowedRelease = await context.service.execute(
      agent,
      release(sessionId, humanAttachment, 1, 33),
    );
    expect(code(borrowedRelease)).toBe("ATTACHMENT_NOT_FOUND");
    const borrowedResume = await context.service.execute(agent, {
      version: 0,
      requestId: uuid(34),
      operation: "resumeAttachment",
      sessionId,
      attachmentId: humanAttachment.attachmentId,
      expectedRuntimeId: RUNTIME,
      expectedControllerGeneration: 1,
      attachmentResumeToken: humanAttachment.attachmentResumeToken,
    });
    expect(code(borrowedResume)).toBe("ATTACHMENT_RESUME_REJECTED");
    expect(context.runtime.records[0]?.writes).toEqual([]);
    await context.service.shutdown();
  });

  it("frees a disconnected human controller after the grace period, so a human hold must live above the Host", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const agent = agentCaller(context.clock.value);
    const human = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, agent);
    const agentAttachment = await openAttachment(context.service, agent, sessionId, 40);
    await ok(
      context.service.execute(agent, acquire(sessionId, agentAttachment, 0, 41)),
      "acquireControl",
    );
    const humanAttachment = await openAttachment(context.service, human, sessionId, 42);
    await context.service.bindStreamAttachment(
      human,
      sessionId,
      humanAttachment.attachmentId,
      "human-stream",
      () => undefined,
    );
    await ok(
      context.service.execute(human, preempt(sessionId, humanAttachment, 1, 43)),
      "preemptControl",
    );

    // The human device disappears (tab closed, phone asleep). Within the grace period the agent is
    // still blocked.
    await context.service.disconnectStreamAttachment(
      human,
      sessionId,
      humanAttachment.attachmentId,
    );
    const duringGrace = await context.service.execute(
      agent,
      acquire(sessionId, agentAttachment, 2, 44),
    );
    expect(code(duringGrace)).toBe("CONTROL_HELD");

    // After the reconnect grace the Host releases control on its own; nothing at the Host level
    // keeps a "human hold". AP-D005 therefore keeps the hold and its timeout in Naru.
    context.clock.value += DURABLE_SESSION_LIMITS.reconnectGraceMs + 1;
    await context.service.expireNow();
    const session = await ok(
      context.service.execute(agent, {
        version: 0,
        requestId: uuid(45),
        operation: "getSession",
        sessionId,
      }),
      "getSession",
    );
    const generation = session.session.controllerGeneration;
    expect(session.session.controllerAttachmentId).toBeNull();
    expect(generation).toBeGreaterThan(2);
    await ok(
      context.service.execute(agent, acquire(sessionId, agentAttachment, generation, 46)),
      "acquireControl",
    );
    await context.service.shutdown();
  });
});

function agentCaller(nowMs: number): DurableSessionCallerContext {
  return {
    appId: "fixture-app",
    subject: "agent:fixture-worker",
    capabilities: [
      "session:observe",
      "control:request",
      "session:create:profile",
      "session:start",
      "session:stop",
      "profile:use",
    ],
    sessionScope: { kind: "all" },
    profileScope: { kind: "ids", ids: ["fixture"] },
    rootScope: { kind: "ids", ids: ["projects"] },
    expiresAtMs: nowMs + 50_000,
  };
}

function serviceFixture() {
  const fixture = createHostFixture();
  const clock = new FakeClock();
  const runtime = new FakeRuntimePort();
  const service = new SessionService({
    metadata: new MemoryMetadataRepository(),
    runtime,
    commandPolicy: new HostCommandPolicy(fixture.config, {}),
    sessionLimit: fixture.config.sessionLimit,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    maxAttachmentsPerSession: fixture.config.maxAttachmentsPerSession,
    attachmentQueueBytes: fixture.config.attachmentQueueBytes,
    eventJournalLimit: fixture.config.eventJournalLimit,
    inputDedupeTtlMs: fixture.config.inputDedupeTtlMs,
    inputDedupeLimit: fixture.config.inputDedupeLimit,
    expirySweepIntervalMs: fixture.config.expirySweepIntervalMs,
    clock,
    ids: new FakeIds(),
  });
  return { clock, runtime, service };
}

async function createSession(
  service: SessionService,
  caller: DurableSessionCallerContext,
): Promise<SessionId> {
  const result = await ok(
    service.execute(caller, {
      version: 0,
      requestId: uuid(1),
      operation: "createSession",
      idempotencyKey: uuid(101),
      command: profileCommand(),
    }),
    "createSession",
  );
  return result.session.sessionId;
}

async function openAttachment(
  service: SessionService,
  caller: DurableSessionCallerContext,
  sessionId: SessionId,
  ordinal: number,
): Promise<AttachmentLease> {
  const result = await ok(
    service.execute(caller, {
      version: 0,
      requestId: uuid(ordinal),
      operation: "openAttachment",
      sessionId,
    }),
    "openAttachment",
  );
  return result.attachment;
}

type Request<T extends DurableSessionOperationRequest["operation"]> = Extract<
  DurableSessionOperationRequest,
  { operation: T }
>;

function acquire(
  sessionId: SessionId,
  attachment: AttachmentLease,
  generation: number,
  ordinal: number,
): Request<"acquireControl"> {
  return {
    version: 0,
    requestId: uuid(ordinal),
    operation: "acquireControl",
    sessionId,
    attachmentId: attachment.attachmentId,
    expectedRuntimeId: RUNTIME,
    expectedControllerGeneration: generation,
    terminal: { cols: 100, rows: 30 },
  };
}

function preempt(
  sessionId: SessionId,
  attachment: AttachmentLease,
  generation: number,
  ordinal: number,
): Request<"preemptControl"> {
  return {
    version: 0,
    requestId: uuid(ordinal),
    operation: "preemptControl",
    sessionId,
    attachmentId: attachment.attachmentId,
    expectedRuntimeId: RUNTIME,
    expectedControllerGeneration: generation,
    terminal: { cols: 100, rows: 30 },
    idempotencyKey: uuid(ordinal + 500),
    reasonCode: "owner-takeover",
  };
}

function release(
  sessionId: SessionId,
  attachment: AttachmentLease,
  generation: number,
  ordinal: number,
): Request<"releaseControl"> {
  return {
    version: 0,
    requestId: uuid(ordinal),
    operation: "releaseControl",
    sessionId,
    attachmentId: attachment.attachmentId,
    expectedControllerGeneration: generation,
  };
}

function input(
  sessionId: SessionId,
  attachment: AttachmentLease,
  generation: number,
  ordinal: number,
  data: string,
): Request<"sendInput"> {
  return {
    version: 0,
    requestId: uuid(ordinal),
    operation: "sendInput",
    sessionId,
    attachmentId: attachment.attachmentId,
    expectedRuntimeId: RUNTIME,
    expectedControllerGeneration: generation,
    inputId: uuid(ordinal + 700),
    data,
  };
}

async function ok<T extends DurableSessionOperationResult["operation"]>(
  promise: Promise<DurableSessionOperationResponse>,
  operation: T,
): Promise<Extract<DurableSessionOperationResult, { operation: T }>> {
  const response = await promise;
  if (!response.ok || response.result.operation !== operation) {
    throw new Error(`Expected successful ${operation}: ${JSON.stringify(response)}`);
  }
  return response.result as Extract<DurableSessionOperationResult, { operation: T }>;
}

function code(response: DurableSessionOperationResponse): string | undefined {
  return response.ok ? undefined : response.error.code;
}

function uuid(ordinal: number): string {
  return `40000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}
