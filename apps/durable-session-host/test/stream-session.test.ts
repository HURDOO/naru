import { describe, expect, it } from "vitest";
import type { DurableSessionOperationResponse } from "@naru/contracts/durable-session/v0";
import { HostAppRegistry } from "../src/app-registry.js";
import { HostCommandPolicy } from "../src/command-policy.js";
import { MemoryMetadataRepository } from "../src/metadata.js";
import { SessionService } from "../src/session-service.js";
import { HostStreamSession, type HostStreamSink } from "../src/stream-session.js";
import type { DurableSessionStreamServerFrame } from "../src/stream-protocol.js";
import {
  createHostFixture,
  FakeClock,
  FakeIds,
  FakeRuntimePort,
  ownerCaller,
  profileCommand,
  TEST_CREDENTIAL,
  TEST_IDS,
} from "./support.js";

describe("DurableSession Host multiplex stream session", () => {
  it("fixes caller identity and sends operation response before snapshot/live events", async () => {
    const context = streamFixture();
    await context.service.initialize();
    const sink = new MemoryStreamSink();
    const stream = new HostStreamSession({
      appId: "fixture-app",
      credential: TEST_CREDENTIAL,
      appRegistry: context.registry,
      service: context.service,
      clock: context.clock,
      sink,
      streamId: "stream-one",
    });

    await stream.receive({ version: 0, type: "stream.hello", callerContext: context.caller });
    expect(sink.frames).toMatchObject([{ type: "stream.ready" }]);
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(1),
        operation: "createSession",
        idempotencyKey: fixtureUuid(101),
        command: profileCommand(),
      },
    });
    const created = operationResponse(sink.frames.at(-1));
    if (!created.ok || created.result.operation !== "createSession") {
      throw new Error("Expected createSession stream response.");
    }
    const sessionId = created.result.session.sessionId;

    const beforeOpen = sink.frames.length;
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(2), operation: "openAttachment", sessionId },
    });
    expect(sink.frames.slice(beforeOpen)).toMatchObject([
      {
        type: "stream.operation-response",
        response: { ok: true, result: { operation: "openAttachment" } },
      },
      {
        type: "stream.attachment-event",
        attachmentId: TEST_IDS.attachment1,
        event: { type: "terminal.snapshot", sequence: 0 },
      },
    ]);

    context.runtime.data(TEST_IDS.runtime1, "stream-live");
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(3), operation: "getSession", sessionId },
    });
    await stream.receive({
      version: 0,
      type: "stream.heartbeat",
      sessionId,
      attachmentId: TEST_IDS.attachment1,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 0,
      sentAtMs: context.clock.value,
    });
    const terminalOutput = sink.frames.find(
      (frame) => frame.type === "stream.attachment-event" && frame.event.type === "terminal.output",
    );
    expect(terminalOutput).toMatchObject({
      type: "stream.attachment-event",
      attachmentId: TEST_IDS.attachment1,
      event: { type: "terminal.output", sequence: 1 },
    });
    expect(sink.frames.at(-1)).toMatchObject({ type: "stream.heartbeat-ack" });

    const repeatedHello = stream.receive({
      version: 0,
      type: "stream.hello",
      callerContext: { ...context.caller, subject: "swapped-owner" },
    });
    await repeatedHello;
    expect(sink.frames.at(-1)).toMatchObject({
      type: "stream.error",
      error: { code: "REQUEST_INVALID" },
    });
    expect(sink.closes).toEqual([{ code: 1008, reason: "Host stream frame is invalid." }]);
    await stream.close();
    await context.service.shutdown();
  });

  it("disconnects every multiplexed attachment and resumes with a rotated token", async () => {
    const context = streamFixture();
    await context.service.initialize();
    const firstSink = new MemoryStreamSink();
    const firstStream = new HostStreamSession({
      appId: "fixture-app",
      credential: TEST_CREDENTIAL,
      appRegistry: context.registry,
      service: context.service,
      clock: context.clock,
      sink: firstSink,
      streamId: "stream-first",
    });
    await firstStream.receive({
      version: 0,
      type: "stream.hello",
      callerContext: context.caller,
    });
    await firstStream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(10),
        operation: "createSession",
        idempotencyKey: fixtureUuid(110),
        command: profileCommand(),
      },
    });
    const created = operationResponse(firstSink.frames.at(-1));
    if (!created.ok || created.result.operation !== "createSession")
      throw new Error("create failed");
    const sessionId = created.result.session.sessionId;
    await firstStream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(11), operation: "openAttachment", sessionId },
    });
    const firstLease = latestLease(firstSink.frames);
    await firstStream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(12), operation: "openAttachment", sessionId },
    });
    expect(latestLease(firstSink.frames).attachmentId).toBe(TEST_IDS.attachment2);

    await firstStream.close();
    const secondSink = new MemoryStreamSink();
    const secondStream = new HostStreamSession({
      appId: "fixture-app",
      credential: TEST_CREDENTIAL,
      appRegistry: context.registry,
      service: context.service,
      clock: context.clock,
      sink: secondSink,
      streamId: "stream-second",
    });
    await secondStream.receive({
      version: 0,
      type: "stream.hello",
      callerContext: context.caller,
    });
    await secondStream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(13),
        operation: "resumeAttachment",
        sessionId,
        attachmentId: firstLease.attachmentId,
        expectedRuntimeId: firstLease.runtimeId,
        expectedControllerGeneration: firstLease.controllerGeneration,
        attachmentResumeToken: firstLease.attachmentResumeToken,
      },
    });
    const resumed = latestLease(secondSink.frames);
    expect(resumed.attachmentId).toBe(firstLease.attachmentId);
    expect(resumed.attachmentResumeToken).not.toBe(firstLease.attachmentResumeToken);
    expect(secondSink.frames.slice(-2)).toMatchObject([
      { type: "stream.operation-response" },
      { type: "stream.attachment-event", event: { type: "terminal.snapshot" } },
    ]);
    await secondStream.close();
    await context.service.shutdown();
  });

  it("keeps heartbeats responsive while waitForEvents is pending", async () => {
    const context = streamFixture();
    await context.service.initialize();
    const sink = new MemoryStreamSink();
    const stream = new HostStreamSession({
      appId: "fixture-app",
      credential: TEST_CREDENTIAL,
      appRegistry: context.registry,
      service: context.service,
      clock: context.clock,
      sink,
      streamId: "stream-wait",
    });
    await stream.receive({
      version: 0,
      type: "stream.hello",
      callerContext: context.caller,
    });
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(30),
        operation: "createSession",
        idempotencyKey: fixtureUuid(130),
        command: profileCommand(),
      },
    });
    const created = operationResponseFor(sink.frames, fixtureUuid(30));
    if (!created.ok || created.result.operation !== "createSession") {
      throw new Error("Expected createSession stream response.");
    }
    const sessionId = created.result.session.sessionId;
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(31), operation: "readEvents", sessionId, limit: 100 },
    });
    const read = operationResponseFor(sink.frames, fixtureUuid(31));
    if (!read.ok || read.result.operation !== "readEvents" || read.result.cursor === null) {
      throw new Error("Expected readEvents cursor.");
    }
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(32), operation: "openAttachment", sessionId },
    });
    const attachment = latestLease(sink.frames);

    const waitRequestId = fixtureUuid(33);
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(33),
        operation: "waitForEvents",
        sessionId,
        afterEventId: read.result.cursor,
        limit: 100,
        timeoutMs: 5_000,
      },
    });
    await stream.receive({
      version: 0,
      type: "stream.heartbeat",
      sessionId,
      attachmentId: attachment.attachmentId,
      expectedRuntimeId: attachment.runtimeId,
      expectedControllerGeneration: attachment.controllerGeneration,
      sentAtMs: context.clock.value,
    });
    const heartbeatIndex = sink.frames.findIndex((frame) => frame.type === "stream.heartbeat-ack");
    expect(heartbeatIndex).toBeGreaterThan(-1);

    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(34),
        operation: "acquireControl",
        sessionId,
        attachmentId: attachment.attachmentId,
        expectedRuntimeId: attachment.runtimeId,
        expectedControllerGeneration: attachment.controllerGeneration,
        terminal: { cols: 100, rows: 30 },
      },
    });
    await expect
      .poll(() => sink.frames.findIndex((frame) => operationRequestId(frame) === waitRequestId))
      .toBeGreaterThan(-1);
    const waitIndex = sink.frames.findIndex((frame) => operationRequestId(frame) === waitRequestId);
    expect(waitIndex).toBeGreaterThan(heartbeatIndex);
    expect(sink.frames[waitIndex]).toMatchObject({
      type: "stream.operation-response",
      response: { ok: true, result: { operation: "waitForEvents", timedOut: false } },
    });
    await stream.close();
    await context.service.shutdown();
  });

  it("fails closed when the credential-bound hello is invalid", async () => {
    const context = streamFixture();
    await context.service.initialize();
    const sink = new MemoryStreamSink();
    const stream = new HostStreamSession({
      appId: "fixture-app",
      credential: "wrong-credential-value-012345678901234567890",
      appRegistry: context.registry,
      service: context.service,
      clock: context.clock,
      sink,
    });
    await stream.receive({ version: 0, type: "stream.hello", callerContext: context.caller });
    expect(sink.frames).toMatchObject([
      { type: "stream.error", error: { code: "CAPABILITY_REQUIRED" } },
    ]);
    expect(sink.closes).toEqual([{ code: 1008, reason: "Host stream authentication failed." }]);
    await context.service.shutdown();
  });

  it("closes an expired caller before sending further attachment output", async () => {
    const context = streamFixture();
    await context.service.initialize();
    const sink = new MemoryStreamSink();
    const stream = new HostStreamSession({
      appId: "fixture-app",
      credential: TEST_CREDENTIAL,
      appRegistry: context.registry,
      service: context.service,
      clock: context.clock,
      sink,
      streamId: "stream-expiry",
    });
    const expiringCaller = { ...context.caller, expiresAtMs: context.clock.value + 1_000 };
    await stream.receive({
      version: 0,
      type: "stream.hello",
      callerContext: expiringCaller,
    });
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: {
        ...requestBase(20),
        operation: "createSession",
        idempotencyKey: fixtureUuid(120),
        command: profileCommand(),
      },
    });
    const created = operationResponse(sink.frames.at(-1));
    if (!created.ok || created.result.operation !== "createSession") {
      throw new Error("Expected createSession stream response.");
    }
    const sessionId = created.result.session.sessionId;
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(21), operation: "openAttachment", sessionId },
    });

    context.clock.value = expiringCaller.expiresAtMs;
    context.runtime.data(TEST_IDS.runtime1, "must-not-cross-expiry");
    await context.service.execute(ownerCaller(context.clock.value), {
      ...requestBase(22),
      operation: "getSession",
      sessionId,
    });
    await stream.receive({
      version: 0,
      type: "stream.operation",
      request: { ...requestBase(23), operation: "getSession", sessionId },
    });

    expect(
      sink.frames.some(
        (frame) =>
          frame.type === "stream.attachment-event" && frame.event.type === "terminal.output",
      ),
    ).toBe(false);
    expect(sink.frames.at(-1)).toMatchObject({
      type: "stream.error",
      error: { code: "CAPABILITY_REQUIRED" },
    });
    expect(sink.closes).toEqual([{ code: 1008, reason: "Host stream caller expired." }]);
    await stream.close();
    await context.service.shutdown();
  });
});

function streamFixture() {
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
  return {
    fixture,
    clock,
    runtime,
    service,
    registry: new HostAppRegistry(fixture.config.appRegistrations),
    caller: ownerCaller(clock.value),
  };
}

class MemoryStreamSink implements HostStreamSink {
  readonly frames: DurableSessionStreamServerFrame[] = [];
  readonly closes: { readonly code: number; readonly reason: string }[] = [];

  send(frame: DurableSessionStreamServerFrame): Promise<void> {
    this.frames.push(frame);
    return Promise.resolve();
  }

  close(code: number, reason: string): void {
    this.closes.push({ code, reason });
  }
}

function operationResponse(
  frame: DurableSessionStreamServerFrame | undefined,
): DurableSessionOperationResponse {
  if (frame?.type !== "stream.operation-response") {
    throw new Error(`Expected operation response: ${JSON.stringify(frame)}`);
  }
  return frame.response;
}

function operationResponseFor(
  frames: readonly DurableSessionStreamServerFrame[],
  requestId: string,
): DurableSessionOperationResponse {
  const frame = frames.find((candidate) => operationRequestId(candidate) === requestId);
  return operationResponse(frame);
}

function operationRequestId(frame: DurableSessionStreamServerFrame): string | null {
  return frame.type === "stream.operation-response" ? frame.response.requestId : null;
}

function latestLease(frames: readonly DurableSessionStreamServerFrame[]) {
  for (let index = frames.length - 1; index >= 0; index -= 1) {
    const frame = frames[index];
    if (
      frame?.type === "stream.operation-response" &&
      frame.response.ok &&
      (frame.response.result.operation === "openAttachment" ||
        frame.response.result.operation === "resumeAttachment")
    ) {
      return frame.response.result.attachment;
    }
  }
  throw new Error("Expected attachment lease frame.");
}

function requestBase(ordinal: number) {
  return { version: 0 as const, requestId: fixtureUuid(ordinal) };
}

function fixtureUuid(ordinal: number): string {
  return `50000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}
