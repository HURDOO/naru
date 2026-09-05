import { describe, expect, it } from "vitest";
import type {
  DurableSessionOperationRequest,
  DurableSessionOperationResponse,
} from "@naru/contracts/durable-session/v0";
import { createSessionState, reduceDurableSession } from "@naru/domain/durable-session";
import { HostCommandPolicy } from "../src/command-policy.js";
import { HostOperationError } from "../src/host-error.js";
import type { HostLogRecord, HostLogger } from "../src/logging.js";
import {
  MemoryMetadataRepository,
  type MetadataRepository,
  type StoredSession,
} from "../src/metadata.js";
import { SessionService, type HostIds } from "../src/session-service.js";
import {
  createHostFixture,
  execCommand,
  FakeClock,
  FakeIds,
  FakeRuntimePort,
  ownerCaller,
  profileCommand,
  TEST_IDS,
} from "./support.js";

const REQUEST_IDS = {
  create: "30000000-0000-4000-8000-000000000001",
  createRetry: "30000000-0000-4000-8000-000000000002",
  get: "30000000-0000-4000-8000-000000000003",
  stop: "30000000-0000-4000-8000-000000000004",
  start: "30000000-0000-4000-8000-000000000005",
  forget: "30000000-0000-4000-8000-000000000006",
  list: "30000000-0000-4000-8000-000000000007",
  idempotencyCreate: "40000000-0000-4000-8000-000000000001",
  idempotencyStop: "40000000-0000-4000-8000-000000000002",
  idempotencyStart: "40000000-0000-4000-8000-000000000003",
} as const;

describe("DurableSession Host SessionService", () => {
  it("owns lifecycle, runtime identity, terminal state, stop, restart and forget", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);

    const created = await context.service.execute(caller, createRequest());
    const running = requireSessionResult(created, "createSession");
    expect(running).toMatchObject({
      sessionId: TEST_IDS.session1,
      runtimeId: TEST_IDS.runtime1,
      lifecycle: "running",
      sessionRevision: 1,
      nextSequence: 0,
    });
    expect(context.runtime.records).toHaveLength(1);

    context.runtime.data(TEST_IDS.runtime1, "zero-attachment-output\r\n");
    const snapshot = await context.service.terminalSnapshot(TEST_IDS.session1);
    expect(snapshot.sequence).toBe(1);
    expect(snapshot.serializedState).toContain("zero-attachment-output");

    const staleStop = await context.service.execute(caller, {
      version: 0,
      requestId: REQUEST_IDS.stop,
      operation: "stopSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 0,
      expectedRuntimeId: TEST_IDS.runtime1,
      idempotencyKey: REQUEST_IDS.idempotencyStop,
    });
    expect(staleStop).toMatchObject({ ok: false, error: { code: "SESSION_REVISION_STALE" } });

    const stoppingResponse = await context.service.execute(caller, {
      version: 0,
      requestId: REQUEST_IDS.stop,
      operation: "stopSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 1,
      expectedRuntimeId: TEST_IDS.runtime1,
      idempotencyKey: "40000000-0000-4000-8000-000000000004",
    });
    expect(requireSessionResult(stoppingResponse, "stopSession")).toMatchObject({
      lifecycle: "stopping",
      sessionRevision: 2,
    });

    const stopped = requireSessionResult(
      await context.service.execute(caller, getRequest(TEST_IDS.session1)),
      "getSession",
    );
    expect(stopped).toMatchObject({ lifecycle: "stopped", sessionRevision: 3, runtimeId: null });

    const restartedResponse = await context.service.execute(caller, {
      version: 0,
      requestId: REQUEST_IDS.start,
      operation: "startSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 3,
      idempotencyKey: REQUEST_IDS.idempotencyStart,
    });
    expect(requireSessionResult(restartedResponse, "startSession")).toMatchObject({
      lifecycle: "running",
      sessionRevision: 5,
      runtimeId: TEST_IDS.runtime2,
      nextSequence: 0,
    });

    await context.service.execute(caller, {
      version: 0,
      requestId: "30000000-0000-4000-8000-000000000008",
      operation: "stopSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 5,
      expectedRuntimeId: TEST_IDS.runtime2,
      idempotencyKey: "40000000-0000-4000-8000-000000000008",
    });
    const stoppedAgain = requireSessionResult(
      await context.service.execute(caller, getRequest(TEST_IDS.session1)),
      "getSession",
    );
    const forgotten = await context.service.execute(caller, {
      version: 0,
      requestId: REQUEST_IDS.forget,
      operation: "forgetSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: stoppedAgain.sessionRevision,
    });
    expect(forgotten).toMatchObject({ ok: true, result: { forgotten: true } });
    expect(context.service.sessionCount).toBe(0);
    await context.service.shutdown();
  });

  it("deduplicates create by caller-bound key and rejects key reuse with different input", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const first = await context.service.execute(caller, createRequest());
    const retry = await context.service.execute(caller, {
      ...createRequest(),
      requestId: REQUEST_IDS.createRetry,
    });

    expect(requireSessionResult(retry, "createSession").sessionId).toBe(
      requireSessionResult(first, "createSession").sessionId,
    );
    expect(context.runtime.records).toHaveLength(1);

    const original = profileCommand();
    const changed = { ...original, terminal: { ...original.terminal, cols: 81 } };
    const reused = await context.service.execute(caller, {
      ...createRequest(),
      requestId: "30000000-0000-4000-8000-000000000009",
      command: changed,
    });
    expect(reused).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });
    await context.service.shutdown();
  });

  it("bounds the idempotency cache by evicting the oldest completed entry", async () => {
    const context = serviceFixture(undefined, 1);
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    await context.service.execute(caller, createRequest());
    await context.service.execute(caller, {
      ...createRequest(),
      requestId: REQUEST_IDS.createRetry,
      idempotencyKey: "40000000-0000-4000-8000-000000000020",
    });
    const replayAfterEviction = await context.service.execute(caller, {
      ...createRequest(),
      requestId: "30000000-0000-4000-8000-000000000020",
    });

    expect(requireSessionResult(replayAfterEviction, "createSession").sessionId).toBe(
      TEST_IDS.session3,
    );
    expect(context.runtime.records).toHaveLength(3);
    await context.service.shutdown();
  });

  it("recovers live metadata as stopped and refuses a recovered arbitrary exec restart", async () => {
    const fixture = createHostFixture();
    const metadata = new MemoryMetadataRepository();
    metadata.save({
      state: runningState(execCommand("RECOVERY_SECRET_ARG")),
      restartability: "runtime-only",
    });
    const runtime = new FakeRuntimePort();
    const clock = new FakeClock();
    const service = new SessionService({
      metadata,
      runtime,
      commandPolicy: new HostCommandPolicy(fixture.config, {}),
      sessionLimit: 10,
      idempotencyTtlMs: 30_000,
      clock,
      ids: idsStartingAtRuntime2(),
    });
    await service.initialize();
    const caller = ownerCaller(clock.value);
    const recovered = requireSessionResult(
      await service.execute(caller, getRequest(TEST_IDS.session1)),
      "getSession",
    );
    expect(recovered).toMatchObject({
      lifecycle: "stopped",
      sessionRevision: 2,
      runtimeId: null,
      nextSequence: 0,
    });

    const stale = await service.execute(caller, {
      version: 0,
      requestId: "30000000-0000-4000-8000-000000000010",
      operation: "startSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 1,
      idempotencyKey: "40000000-0000-4000-8000-000000000010",
    });
    expect(stale).toMatchObject({ ok: false, error: { code: "SESSION_REVISION_STALE" } });

    const denied = await service.execute(caller, {
      version: 0,
      requestId: REQUEST_IDS.start,
      operation: "startSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 2,
      idempotencyKey: REQUEST_IDS.idempotencyStart,
    });
    expect(denied).toMatchObject({ ok: false, error: { code: "COMMAND_POLICY_DENIED" } });
    expect(runtime.records).toHaveLength(0);
    await service.shutdown();
  });

  it("re-resolves and starts a recovered safe profile with a new runtime ID", async () => {
    const fixture = createHostFixture();
    const metadata = new MemoryMetadataRepository();
    metadata.save({
      state: runningState(profileCommand()),
      restartability: "profile-reference",
    });
    const runtime = new FakeRuntimePort();
    const clock = new FakeClock();
    const service = new SessionService({
      metadata,
      runtime,
      commandPolicy: new HostCommandPolicy(fixture.config, {}),
      sessionLimit: 10,
      idempotencyTtlMs: 30_000,
      clock,
      ids: idsStartingAtRuntime2(),
    });
    await service.initialize();
    const caller = ownerCaller(clock.value);
    const started = await service.execute(caller, {
      version: 0,
      requestId: REQUEST_IDS.start,
      operation: "startSession",
      sessionId: TEST_IDS.session1,
      expectedSessionRevision: 2,
      idempotencyKey: REQUEST_IDS.idempotencyStart,
    });
    expect(requireSessionResult(started, "startSession")).toMatchObject({
      lifecycle: "running",
      runtimeId: TEST_IDS.runtime2,
      sessionRevision: 4,
    });
    await service.shutdown();
  });

  it("returns a redacted diagnostic on spawn failure without logging command data", async () => {
    const logger = new MemoryLogger();
    const context = serviceFixture(logger);
    context.runtime.failNextSpawn = true;
    await context.service.initialize();
    const secret = "SPAWN_FAILURE_SECRET_ARG";
    const response = await context.service.execute(ownerCaller(context.clock.value), {
      ...createRequest(),
      command: execCommand(secret),
    });

    expect(response).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", diagnosticId: TEST_IDS.diagnostic1 },
    });
    expect(JSON.stringify(response)).not.toContain(secret);
    expect(JSON.stringify(logger.records)).not.toContain(secret);
    const failed = requireSessionResult(
      await context.service.execute(
        ownerCaller(context.clock.value),
        getRequest(TEST_IDS.session1),
      ),
      "getSession",
    );
    expect(failed.lifecycle).toBe("failed");
    await context.service.shutdown();
  });

  it("stops accepting operations when durable metadata cannot be written", async () => {
    const fixture = createHostFixture();
    const metadata = new ToggleMetadataRepository();
    const runtime = new FakeRuntimePort();
    const clock = new FakeClock();
    const logger = new MemoryLogger();
    const service = new SessionService({
      metadata,
      runtime,
      commandPolicy: new HostCommandPolicy(fixture.config, {}),
      sessionLimit: 10,
      idempotencyTtlMs: 30_000,
      clock,
      ids: new FakeIds(),
      logger,
    });
    await service.initialize();
    metadata.failSave = true;

    const response = await service.execute(ownerCaller(clock.value), createRequest());
    expect(response).toMatchObject({
      ok: false,
      error: { code: "INTERNAL_ERROR", diagnosticId: TEST_IDS.diagnostic1 },
    });
    expect(runtime.records).toHaveLength(0);
    expect(service.ready).toBe(false);
    expect(logger.records).toContainEqual(
      expect.objectContaining({
        event: "metadata.failed",
        code: "INTERNAL_ERROR",
        diagnosticId: TEST_IDS.diagnostic1,
      }),
    );

    metadata.failSave = false;
    await service.shutdown();
  });

  it("records a failed Session if command policy changes between validation and spawn", async () => {
    const context = serviceFixture();
    const originalResolve = context.commandPolicy.resolve.bind(context.commandPolicy);
    let resolutions = 0;
    context.commandPolicy.resolve = (command) => {
      resolutions += 1;
      if (resolutions === 2) {
        throw new HostOperationError("COMMAND_POLICY_DENIED", "Fixture policy changed.");
      }
      return originalResolve(command);
    };
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);

    const response = await context.service.execute(caller, createRequest());
    expect(response).toMatchObject({ ok: false, error: { code: "COMMAND_POLICY_DENIED" } });
    expect(context.runtime.records).toHaveLength(0);
    expect(
      requireSessionResult(
        await context.service.execute(caller, getRequest(TEST_IDS.session1)),
        "getSession",
      ),
    ).toMatchObject({ lifecycle: "failed", runtimeId: null, sessionRevision: 1 });
    await context.service.shutdown();
  });

  it("bounds pending PTY output and fails only the overflowing runtime", async () => {
    const logger = new MemoryLogger();
    const context = serviceFixture(logger);
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    await context.service.execute(caller, createRequest());
    const outputLimit = context.fixture.config.resourcePolicies[0]?.outputRingCharacters;
    if (outputLimit === undefined) throw new Error("Fixture resource policy is missing.");

    context.runtime.data(TEST_IDS.runtime1, "x".repeat(outputLimit + 1));
    const failed = requireSessionResult(
      await context.service.execute(caller, getRequest(TEST_IDS.session1)),
      "getSession",
    );

    expect(failed).toMatchObject({ lifecycle: "failed", runtimeId: null, sessionRevision: 2 });
    expect(context.runtime.records[0]?.kills).toHaveLength(1);
    expect(context.metadata.loadAll()[0]?.state.lastRuntime?.reason).toBe("runtime-failed");
    expect(logger.records).toContainEqual(
      expect.objectContaining({ event: "runtime.output-failed", sessionId: TEST_IDS.session1 }),
    );
    await context.service.shutdown();
  });

  it("filters list results by caller Session scope", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const owner = ownerCaller(context.clock.value);
    await context.service.execute(owner, createRequest());
    await context.service.execute(owner, {
      ...createRequest(),
      requestId: REQUEST_IDS.createRetry,
      idempotencyKey: "40000000-0000-4000-8000-000000000099",
    });
    const observer = {
      ...owner,
      capabilities: ["session:observe" as const],
      sessionScope: { kind: "ids" as const, ids: [TEST_IDS.session2] },
    };
    const listed = await context.service.execute(observer, {
      version: 0,
      requestId: REQUEST_IDS.list,
      operation: "listSessions",
      limit: 100,
    });
    expect(listed).toMatchObject({
      ok: true,
      result: { operation: "listSessions", sessions: [{ sessionId: TEST_IDS.session2 }] },
    });
    await context.service.shutdown();
  });

  it("enforces the Session bound and opens T07 attachments after the G3 seam", async () => {
    const fixture = createHostFixture();
    const clock = new FakeClock();
    const runtime = new FakeRuntimePort();
    const service = new SessionService({
      metadata: new MemoryMetadataRepository(),
      runtime,
      commandPolicy: new HostCommandPolicy(fixture.config, {}),
      sessionLimit: 1,
      idempotencyTtlMs: 30_000,
      clock,
      ids: new FakeIds(),
    });
    await service.initialize();
    const caller = ownerCaller(clock.value);
    await service.execute(caller, createRequest());
    const limited = await service.execute(caller, {
      ...createRequest(),
      requestId: REQUEST_IDS.createRetry,
      idempotencyKey: "40000000-0000-4000-8000-000000000098",
    });
    expect(limited).toMatchObject({ ok: false, error: { code: "SESSION_LIMIT_REACHED" } });

    const opened = await service.execute(caller, {
      version: 0,
      requestId: "30000000-0000-4000-8000-000000000098",
      operation: "openAttachment",
      sessionId: TEST_IDS.session1,
    });
    expect(opened).toMatchObject({
      ok: true,
      result: {
        operation: "openAttachment",
        attachment: { attachmentId: TEST_IDS.attachment1, role: "observer" },
      },
    });
    await service.shutdown();
  });
});

function serviceFixture(logger?: HostLogger, idempotencyLimit?: number) {
  const fixture = createHostFixture();
  const clock = new FakeClock();
  const runtime = new FakeRuntimePort();
  const metadata = new MemoryMetadataRepository();
  const commandPolicy = new HostCommandPolicy(fixture.config, {});
  const service = new SessionService({
    metadata,
    runtime,
    commandPolicy,
    sessionLimit: fixture.config.sessionLimit,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    ...(idempotencyLimit === undefined ? {} : { idempotencyLimit }),
    clock,
    ids: new FakeIds(),
    ...(logger === undefined ? {} : { logger }),
  });
  return { fixture, clock, runtime, metadata, commandPolicy, service };
}

function createRequest(): Extract<DurableSessionOperationRequest, { operation: "createSession" }> {
  return {
    version: 0,
    requestId: REQUEST_IDS.create,
    operation: "createSession",
    idempotencyKey: REQUEST_IDS.idempotencyCreate,
    command: profileCommand(),
  };
}

function getRequest(
  sessionId: typeof TEST_IDS.session1,
): Extract<DurableSessionOperationRequest, { operation: "getSession" }> {
  return { version: 0, requestId: REQUEST_IDS.get, operation: "getSession", sessionId };
}

function requireSessionResult(
  response: DurableSessionOperationResponse,
  operation: "createSession" | "getSession" | "startSession" | "stopSession",
) {
  if (!response.ok || response.result.operation !== operation || !("session" in response.result)) {
    throw new Error(`Expected ${operation} Session result.`);
  }
  return response.result.session;
}

function runningState(command: ReturnType<typeof profileCommand | typeof execCommand>) {
  const initial = createSessionState({
    sessionId: TEST_IDS.session1,
    runtimeId: TEST_IDS.runtime1,
    command,
    nowMs: 100,
  });
  const running = reduceDurableSession(initial, {
    type: "spawnSucceeded",
    expectedSessionRevision: 0,
    expectedRuntimeId: TEST_IDS.runtime1,
    nowMs: 101,
  });
  if (!running.ok) throw new Error("Fixture runtime did not start.");
  return running.state;
}

function idsStartingAtRuntime2(): HostIds {
  const fallback = new FakeIds();
  return {
    sessionId: () => TEST_IDS.session2,
    runtimeId: () => TEST_IDS.runtime2,
    attachmentId: () => fallback.attachmentId(),
    controlRequestId: () => fallback.controlRequestId(),
    controlOfferId: () => fallback.controlOfferId(),
    eventId: () => fallback.eventId(),
    diagnosticId: () => TEST_IDS.diagnostic1,
  };
}

class MemoryLogger implements HostLogger {
  readonly records: HostLogRecord[] = [];

  write(record: HostLogRecord): void {
    this.records.push(record);
  }
}

class ToggleMetadataRepository implements MetadataRepository {
  readonly #memory = new MemoryMetadataRepository();
  failSave = false;

  loadAll(): readonly StoredSession[] {
    return this.#memory.loadAll();
  }

  save(session: StoredSession): void {
    if (this.failSave) throw new Error("fixture metadata failure");
    this.#memory.save(session);
  }

  delete(sessionId: string): void {
    this.#memory.delete(sessionId);
  }

  ping(): boolean {
    return this.#memory.ping();
  }

  close(): void {
    this.#memory.close();
  }
}
