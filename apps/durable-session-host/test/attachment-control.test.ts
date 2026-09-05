import { describe, expect, it } from "vitest";
import type {
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionEvent,
  DurableSessionOperationRequest,
  DurableSessionOperationResponse,
  DurableSessionOperationResult,
  SessionId,
} from "@naru/contracts/durable-session/v0";
import { HostCommandPolicy } from "../src/command-policy.js";
import { MemoryMetadataRepository } from "../src/metadata.js";
import { SessionService } from "../src/session-service.js";
import {
  createHostFixture,
  FakeClock,
  FakeIds,
  FakeRuntimePort,
  ownerCaller,
  profileCommand,
  TEST_IDS,
} from "./support.js";

describe("DurableSession Host attachment and control orchestration", () => {
  it("orders snapshot/live output and keeps observer geometry non-authoritative", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);

    context.runtime.data(TEST_IDS.runtime1, "before-attach");
    await flush(context.service, caller, sessionId);
    const controller = await openAttachment(context.service, caller, sessionId, 10);
    await context.service.bindStreamAttachment(
      caller,
      sessionId,
      controller.attachmentId,
      "controller-stream",
      () => undefined,
    );
    const initial = await takeAll(context.service, controller.attachmentId, "controller-stream");
    expect(initial).toMatchObject([{ type: "terminal.snapshot", sequence: 1 }]);

    context.runtime.data(TEST_IDS.runtime1, "live-a");
    context.runtime.data(TEST_IDS.runtime1, "live-b");
    await flush(context.service, caller, sessionId);
    expect(
      (await takeAll(context.service, controller.attachmentId, "controller-stream"))
        .filter((event) => event.type === "terminal.output")
        .map((event) => ("sequence" in event ? event.sequence : -1)),
    ).toEqual([2, 3]);

    for (let index = 0; index < 256; index += 1) {
      context.runtime.data(TEST_IDS.runtime1, `rapid-${index};`);
    }
    await flush(context.service, caller, sessionId);
    const rapidSequences = (
      await takeAll(context.service, controller.attachmentId, "controller-stream")
    )
      .filter((event) => event.type === "terminal.output")
      .map((event) => event.sequence);
    expect(rapidSequences).toEqual(Array.from({ length: 256 }, (_, index) => index + 4));

    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(20),
        operation: "acquireControl",
        sessionId,
        attachmentId: controller.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 100, rows: 30 },
      }),
      "acquireControl",
    );
    const observer = await openAttachment(context.service, caller, sessionId, 21);
    const deniedResize = await context.service.execute(caller, {
      ...requestBase(22),
      operation: "resizeTerminal",
      sessionId,
      attachmentId: observer.attachmentId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 1,
      terminal: { cols: 40, rows: 10 },
    });
    expect(deniedResize).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_NOT_CONTROLLER" },
    });
    expect(context.runtime.records[0]?.resizes).toEqual([{ cols: 100, rows: 30 }]);

    const snapshot = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(23),
        operation: "requestSnapshot",
        sessionId,
        attachmentId: observer.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
      }),
      "requestSnapshot",
    );
    expect(snapshot.snapshot).toMatchObject({ sequence: 259, terminal: { cols: 100, rows: 30 } });
    await context.service.shutdown();
  });

  it("transfers and preempts once while fencing stale input, resize and duplicate input IDs", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const first = await openAttachment(context.service, caller, sessionId, 30);
    const second = await openAttachment(context.service, caller, sessionId, 31);

    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(32),
        operation: "acquireControl",
        sessionId,
        attachmentId: first.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 100, rows: 30 },
      }),
      "acquireControl",
    );
    const requested = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(33),
        operation: "requestControl",
        sessionId,
        attachmentId: second.attachmentId,
        expectedControllerGeneration: 1,
      }),
      "requestControl",
    );
    const approved = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(34),
        operation: "approveControl",
        sessionId,
        attachmentId: first.attachmentId,
        controlRequestId: requested.request.controlRequestId,
        expectedControllerGeneration: 1,
      }),
      "approveControl",
    );
    const accepted = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(35),
        operation: "acceptControl",
        sessionId,
        attachmentId: second.attachmentId,
        controlOfferId: approved.offer.controlOfferId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 1,
        terminal: { cols: 120, rows: 40 },
        idempotencyKey: fixtureUuid(135),
      }),
      "acceptControl",
    );
    expect(accepted.control).toMatchObject({
      controllerAttachmentId: second.attachmentId,
      controllerGeneration: 2,
    });
    expect(context.runtime.records[0]?.resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 },
    ]);

    const staleInput = await context.service.execute(caller, {
      ...requestBase(36),
      operation: "sendInput",
      sessionId,
      attachmentId: first.attachmentId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 1,
      inputId: fixtureUuid(236),
      data: "stale",
    });
    expect(staleInput).toMatchObject({
      ok: false,
      error: { code: "CONTROL_GENERATION_STALE" },
    });

    const inputRequest = {
      ...requestBase(37),
      operation: "sendInput" as const,
      sessionId,
      attachmentId: second.attachmentId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 2,
      inputId: fixtureUuid(237),
      data: "accepted-once",
    };
    await expectSuccess(context.service.execute(caller, inputRequest), "sendInput");
    await expectSuccess(
      context.service.execute(caller, { ...inputRequest, requestId: fixtureUuid(38) }),
      "sendInput",
    );
    expect(context.runtime.records[0]?.writes).toEqual(["accepted-once"]);
    const conflictingInput = await context.service.execute(caller, {
      ...inputRequest,
      requestId: fixtureUuid(39),
      data: "different",
    });
    expect(conflictingInput).toMatchObject({ ok: false, error: { code: "REQUEST_INVALID" } });

    const preempted = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(40),
        operation: "preemptControl",
        sessionId,
        attachmentId: first.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 2,
        terminal: { cols: 90, rows: 20 },
        idempotencyKey: fixtureUuid(140),
        reasonCode: "owner-takeover",
      }),
      "preemptControl",
    );
    expect(preempted.control.controllerGeneration).toBe(3);
    expect(context.runtime.records[0]?.resizes).toEqual([
      { cols: 100, rows: 30 },
      { cols: 120, rows: 40 },
      { cols: 90, rows: 20 },
    ]);
    await expectSuccess(
      context.service.execute(caller, {
        ...inputRequest,
        requestId: fixtureUuid(240),
        attachmentId: first.attachmentId,
        expectedControllerGeneration: 3,
      }),
      "sendInput",
    );
    expect(context.runtime.records[0]?.writes).toEqual(["accepted-once", "accepted-once"]);
    const staleResize = await context.service.execute(caller, {
      ...requestBase(41),
      operation: "resizeTerminal",
      sessionId,
      attachmentId: second.attachmentId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 2,
      terminal: { cols: 10, rows: 5 },
    });
    expect(staleResize).toMatchObject({
      ok: false,
      error: { code: "CONTROL_GENERATION_STALE" },
    });
    await context.service.shutdown();
  });

  it("requires current observe scope before binding an attachment stream", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const attachment = await openAttachment(context.service, caller, sessionId, 45);
    const narrowedCaller = {
      ...caller,
      sessionScope: { kind: "ids" as const, ids: [TEST_IDS.session2] },
    };

    await expect(
      context.service.bindStreamAttachment(
        narrowedCaller,
        sessionId,
        attachment.attachmentId,
        "scope-bypass",
        () => undefined,
      ),
    ).rejects.toMatchObject({ code: "CAPABILITY_REQUIRED" });
    await context.service.shutdown();
  });

  it("rotates resume tokens and rejects replay, wrong binding, stale generation and expiry", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const first = await openAttachment(context.service, caller, sessionId, 50);
    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(51),
        operation: "acquireControl",
        sessionId,
        attachmentId: first.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 100, rows: 30 },
      }),
      "acquireControl",
    );

    const unsubscribe = await context.service.bindStreamAttachment(
      caller,
      sessionId,
      first.attachmentId,
      "resume-stream",
      () => undefined,
    );
    unsubscribe();
    await context.service.disconnectStreamAttachment(caller, sessionId, first.attachmentId);
    const wrongRuntime = await context.service.execute(caller, {
      ...resumeRequest(sessionId, first, first.attachmentResumeToken, 1, 501),
      expectedRuntimeId: TEST_IDS.runtime2,
    });
    expect(wrongRuntime).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_RESUME_REJECTED" },
    });
    const wrongApp = await context.service.execute(
      { ...caller, appId: "another-app" },
      resumeRequest(sessionId, first, first.attachmentResumeToken, 1, 502),
    );
    expect(wrongApp).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_RESUME_REJECTED" },
    });
    const resumed = await expectSuccess(
      context.service.execute(
        caller,
        resumeRequest(sessionId, first, first.attachmentResumeToken, 1, 52),
      ),
      "resumeAttachment",
    );
    expect(resumed.attachment).toMatchObject({
      attachmentId: first.attachmentId,
      role: "controller",
    });
    expect(resumed.attachment.attachmentResumeToken).not.toBe(first.attachmentResumeToken);

    const replay = await context.service.execute(
      caller,
      resumeRequest(sessionId, first, first.attachmentResumeToken, 1, 53),
    );
    expect(replay).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_RESUME_REJECTED" },
    });
    const wrongSubject = await context.service.execute(
      { ...caller, subject: "another-owner" },
      resumeRequest(sessionId, resumed.attachment, resumed.attachment.attachmentResumeToken, 1, 54),
    );
    expect(wrongSubject).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_RESUME_REJECTED" },
    });

    const second = await openAttachment(context.service, caller, sessionId, 55);
    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(56),
        operation: "preemptControl",
        sessionId,
        attachmentId: second.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 1,
        terminal: { cols: 80, rows: 24 },
        idempotencyKey: fixtureUuid(156),
        reasonCode: "owner-takeover",
      }),
      "preemptControl",
    );
    await context.service.disconnectStreamAttachment(caller, sessionId, first.attachmentId);
    const staleGeneration = await context.service.execute(
      caller,
      resumeRequest(sessionId, resumed.attachment, resumed.attachment.attachmentResumeToken, 1, 57),
    );
    expect(staleGeneration).toMatchObject({
      ok: false,
      error: { code: "CONTROL_GENERATION_STALE" },
    });
    const observerResume = await expectSuccess(
      context.service.execute(
        caller,
        resumeRequest(
          sessionId,
          resumed.attachment,
          resumed.attachment.attachmentResumeToken,
          2,
          58,
        ),
      ),
      "resumeAttachment",
    );
    expect(observerResume.attachment.role).toBe("observer");

    await context.service.disconnectStreamAttachment(caller, sessionId, first.attachmentId);
    context.clock.value += 10_001;
    await context.service.expireNow();
    const expired = await context.service.execute(
      caller,
      resumeRequest(
        sessionId,
        observerResume.attachment,
        observerResume.attachment.attachmentResumeToken,
        2,
        59,
      ),
    );
    expect(expired).toMatchObject({
      ok: false,
      error: { code: "ATTACHMENT_RESUME_REJECTED" },
    });
    await context.service.shutdown();
  });

  it("keeps event waits non-blocking and excludes raw terminal output from the journal", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const initial = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(60),
        operation: "readEvents",
        sessionId,
        limit: 100,
      }),
      "readEvents",
    );
    expect(initial.events.map((event) => event.type)).toEqual([
      "session.changed",
      "session.changed",
    ]);
    const attachment = await openAttachment(context.service, caller, sessionId, 61);
    const waiting = context.service.execute(caller, {
      ...requestBase(62),
      operation: "waitForEvents",
      sessionId,
      afterEventId: initial.cursor ?? undefined,
      limit: 100,
      timeoutMs: 2_000,
    });
    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(63),
        operation: "acquireControl",
        sessionId,
        attachmentId: attachment.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 90, rows: 25 },
      }),
      "acquireControl",
    );
    const waited = await expectSuccess(waiting, "waitForEvents");
    expect(waited.timedOut).toBe(false);
    expect(waited.events.map((event) => event.type)).toEqual(["control.changed"]);

    context.runtime.data(TEST_IDS.runtime1, "not-in-journal");
    await flush(context.service, caller, sessionId);
    const afterOutput = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(64),
        operation: "readEvents",
        sessionId,
        afterEventId: waited.cursor ?? undefined,
        limit: 100,
      }),
      "readEvents",
    );
    expect(afterOutput.events).toEqual([]);

    const invalidCursor = await context.service.execute(caller, {
      ...requestBase(65),
      operation: "readEvents",
      sessionId,
      afterEventId: fixtureUuid(999),
      limit: 100,
    });
    expect(invalidCursor).toMatchObject({ ok: false, error: { code: "RESYNC_REQUIRED" } });
    const pending = context.service.execute(caller, {
      ...requestBase(66),
      operation: "waitForEvents",
      sessionId,
      afterEventId: waited.cursor ?? undefined,
      limit: 100,
      timeoutMs: 30_000,
    });
    await getSession(context.service, caller, sessionId);
    const shutdown = context.service.shutdown();
    expect(await pending).toMatchObject({
      ok: false,
      error: { code: "SESSION_STATE_INVALID" },
    });
    await shutdown;
  });

  it("rechecks caller expiry before resolving a long event wait", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const attachment = await openAttachment(context.service, caller, sessionId, 67);
    const initial = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(68),
        operation: "readEvents",
        sessionId,
        limit: 100,
      }),
      "readEvents",
    );
    const expiringCaller = { ...caller, expiresAtMs: context.clock.value + 1_000 };
    const waiting = context.service.execute(expiringCaller, {
      ...requestBase(69),
      operation: "waitForEvents",
      sessionId,
      afterEventId: initial.cursor ?? undefined,
      limit: 100,
      timeoutMs: 5_000,
    });
    await getSession(context.service, caller, sessionId);

    context.clock.value = expiringCaller.expiresAtMs;
    const freshCaller = ownerCaller(context.clock.value);
    await expectSuccess(
      context.service.execute(freshCaller, {
        ...requestBase(70),
        operation: "acquireControl",
        sessionId,
        attachmentId: attachment.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 90, rows: 25 },
      }),
      "acquireControl",
    );
    expect(await waiting).toMatchObject({
      ok: false,
      error: { code: "CAPABILITY_REQUIRED" },
    });
    await context.service.shutdown();
  });

  it("resyncs only a slow attachment while the fast observer and runtime continue", async () => {
    const context = serviceFixture({ attachmentQueueBytes: 1_000 });
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const fast = await openAttachment(context.service, caller, sessionId, 70);
    const slow = await openAttachment(context.service, caller, sessionId, 71);
    await context.service.bindStreamAttachment(
      caller,
      sessionId,
      fast.attachmentId,
      "fast",
      () => undefined,
    );
    await context.service.bindStreamAttachment(
      caller,
      sessionId,
      slow.attachmentId,
      "slow",
      () => undefined,
    );
    await takeAll(context.service, fast.attachmentId, "fast");
    await takeAll(context.service, slow.attachmentId, "slow");

    const fastSequences: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      context.runtime.data(TEST_IDS.runtime1, String(index).repeat(400));
      await flush(context.service, caller, sessionId);
      for (const event of await takeAll(context.service, fast.attachmentId, "fast")) {
        if (event.type === "terminal.output") fastSequences.push(event.sequence);
      }
    }
    expect(fastSequences).toEqual([1, 2, 3]);
    expect(await takeAll(context.service, slow.attachmentId, "slow")).toMatchObject([
      { type: "attachment.resync-required", reason: "queue-overflow" },
    ]);
    expect((await getSession(context.service, caller, sessionId)).lifecycle).toBe("running");

    const resynced = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(72),
        operation: "resyncAttachment",
        sessionId,
        attachmentId: slow.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        afterSequence: 0,
      }),
      "resyncAttachment",
    );
    expect(resynced.snapshot.sequence).toBe(3);
    context.runtime.data(TEST_IDS.runtime1, "after-resync");
    await flush(context.service, caller, sessionId);
    expect(await takeAll(context.service, slow.attachmentId, "slow")).toMatchObject([
      { type: "terminal.output", sequence: 4 },
    ]);
    await context.service.shutdown();
  });

  it("coalesces stream notifications while an attachment queue is already pending", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const attachment = await openAttachment(context.service, caller, sessionId, 80);
    let notifications = 0;
    await context.service.bindStreamAttachment(
      caller,
      sessionId,
      attachment.attachmentId,
      "coalesced",
      () => {
        notifications += 1;
      },
    );
    await Promise.resolve();
    expect(notifications).toBe(1);

    for (let index = 0; index < 100; index += 1) {
      context.runtime.data(TEST_IDS.runtime1, `queued-${index}`);
    }
    await flush(context.service, caller, sessionId);
    await Promise.resolve();
    expect(notifications).toBe(1);

    await takeAll(context.service, attachment.attachmentId, "coalesced");
    context.runtime.data(TEST_IDS.runtime1, "after-drain");
    await flush(context.service, caller, sessionId);
    await Promise.resolve();
    expect(notifications).toBe(2);
    await context.service.shutdown();
  });

  it("expires an offer without transferring control or expiring healthy attachments", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    let caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const first = await openAttachment(context.service, caller, sessionId, 90);
    const second = await openAttachment(context.service, caller, sessionId, 91);
    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(92),
        operation: "acquireControl",
        sessionId,
        attachmentId: first.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 100, rows: 30 },
      }),
      "acquireControl",
    );
    const requested = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(93),
        operation: "requestControl",
        sessionId,
        attachmentId: second.attachmentId,
        expectedControllerGeneration: 1,
      }),
      "requestControl",
    );
    const approved = await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(94),
        operation: "approveControl",
        sessionId,
        attachmentId: first.attachmentId,
        controlRequestId: requested.request.controlRequestId,
        expectedControllerGeneration: 1,
      }),
      "approveControl",
    );

    context.clock.value += 59_000;
    caller = ownerCaller(context.clock.value);
    for (const attachment of [first, second]) {
      await context.service.heartbeatAttachment(caller, {
        sessionId,
        attachmentId: attachment.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 1,
      });
    }
    context.clock.value += 1_100;
    await context.service.expireNow();
    const expiredAccept = await context.service.execute(caller, {
      ...requestBase(95),
      operation: "acceptControl",
      sessionId,
      attachmentId: second.attachmentId,
      controlOfferId: approved.offer.controlOfferId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 1,
      terminal: { cols: 120, rows: 40 },
      idempotencyKey: fixtureUuid(195),
    });
    expect(expiredAccept).toMatchObject({
      ok: false,
      error: { code: "CONTROL_OFFER_NOT_FOUND" },
    });
    expect(await getSession(context.service, caller, sessionId)).toMatchObject({
      controllerAttachmentId: first.attachmentId,
      controllerGeneration: 1,
    });
    expect(context.runtime.records[0]?.resizes).toEqual([{ cols: 100, rows: 30 }]);
    await context.service.shutdown();
  });

  it("serializes preempt and stop so late runtime/control work cannot revive a controller", async () => {
    const context = serviceFixture();
    await context.service.initialize();
    const caller = ownerCaller(context.clock.value);
    const sessionId = await createSession(context.service, caller);
    const first = await openAttachment(context.service, caller, sessionId, 100);
    const second = await openAttachment(context.service, caller, sessionId, 101);
    await expectSuccess(
      context.service.execute(caller, {
        ...requestBase(102),
        operation: "acquireControl",
        sessionId,
        attachmentId: first.attachmentId,
        expectedRuntimeId: TEST_IDS.runtime1,
        expectedControllerGeneration: 0,
        terminal: { cols: 100, rows: 30 },
      }),
      "acquireControl",
    );

    const preempt = context.service.execute(caller, {
      ...requestBase(103),
      operation: "preemptControl",
      sessionId,
      attachmentId: second.attachmentId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 1,
      terminal: { cols: 120, rows: 40 },
      idempotencyKey: fixtureUuid(203),
      reasonCode: "owner-takeover",
    });
    const stop = context.service.execute(caller, {
      ...requestBase(104),
      operation: "stopSession",
      sessionId,
      expectedSessionRevision: 1,
      expectedRuntimeId: TEST_IDS.runtime1,
      idempotencyKey: fixtureUuid(204),
    });
    await expectSuccess(preempt, "preemptControl");
    await expectSuccess(stop, "stopSession");
    const stopped = await getSession(context.service, caller, sessionId);
    expect(stopped).toMatchObject({
      lifecycle: "stopped",
      runtimeId: null,
      controllerAttachmentId: null,
      controllerGeneration: 3,
    });

    const lateInput = await context.service.execute(caller, {
      ...requestBase(105),
      operation: "sendInput",
      sessionId,
      attachmentId: second.attachmentId,
      expectedRuntimeId: TEST_IDS.runtime1,
      expectedControllerGeneration: 2,
      inputId: fixtureUuid(205),
      data: "late",
    });
    expect(lateInput).toMatchObject({ ok: false, error: { code: "SESSION_NOT_RUNNING" } });
    expect(context.runtime.records[0]?.writes).toEqual([]);
    await context.service.shutdown();
  });
});

function serviceFixture(overrides: { readonly attachmentQueueBytes?: number } = {}) {
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
    attachmentQueueBytes: overrides.attachmentQueueBytes ?? fixture.config.attachmentQueueBytes,
    eventJournalLimit: fixture.config.eventJournalLimit,
    inputDedupeTtlMs: fixture.config.inputDedupeTtlMs,
    inputDedupeLimit: fixture.config.inputDedupeLimit,
    expirySweepIntervalMs: fixture.config.expirySweepIntervalMs,
    clock,
    ids: new FakeIds(),
  });
  return { fixture, clock, runtime, service };
}

async function createSession(
  service: SessionService,
  caller: DurableSessionCallerContext,
): Promise<SessionId> {
  const result = await expectSuccess(
    service.execute(caller, {
      ...requestBase(1),
      operation: "createSession",
      idempotencyKey: fixtureUuid(101),
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
  const result = await expectSuccess(
    service.execute(caller, {
      ...requestBase(ordinal),
      operation: "openAttachment",
      sessionId,
    }),
    "openAttachment",
  );
  return result.attachment;
}

function resumeRequest(
  sessionId: SessionId,
  attachment: AttachmentLease,
  token: string,
  generation: number,
  ordinal: number,
): Extract<DurableSessionOperationRequest, { operation: "resumeAttachment" }> {
  return {
    ...requestBase(ordinal),
    operation: "resumeAttachment",
    sessionId,
    attachmentId: attachment.attachmentId,
    expectedRuntimeId: attachment.runtimeId,
    expectedControllerGeneration: generation,
    attachmentResumeToken: token,
  };
}

async function flush(
  service: SessionService,
  caller: DurableSessionCallerContext,
  sessionId: SessionId,
): Promise<void> {
  await getSession(service, caller, sessionId);
}

async function getSession(
  service: SessionService,
  caller: DurableSessionCallerContext,
  sessionId: SessionId,
) {
  const result = await expectSuccess(
    service.execute(caller, { ...requestBase(800), operation: "getSession", sessionId }),
    "getSession",
  );
  return result.session;
}

async function takeAll(
  service: SessionService,
  attachmentId: AttachmentLease["attachmentId"],
  streamId: string,
): Promise<DurableSessionEvent[]> {
  const events: DurableSessionEvent[] = [];
  for (;;) {
    const event = await service.takeStreamEvent(attachmentId, streamId);
    if (event === null) return events;
    events.push(event);
  }
}

async function expectSuccess<T extends DurableSessionOperationResult["operation"]>(
  promise: Promise<DurableSessionOperationResponse>,
  operation: T,
): Promise<Extract<DurableSessionOperationResult, { operation: T }>> {
  const response = await promise;
  if (!response.ok || response.result.operation !== operation) {
    throw new Error(`Expected successful ${operation}: ${JSON.stringify(response)}`);
  }
  return response.result as Extract<DurableSessionOperationResult, { operation: T }>;
}

function requestBase(ordinal: number) {
  return { version: 0 as const, requestId: fixtureUuid(ordinal) };
}

function fixtureUuid(ordinal: number): string {
  return `30000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}
