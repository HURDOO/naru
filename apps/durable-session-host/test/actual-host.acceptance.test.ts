import { realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import {
  DurableSessionOperationResponseSchema,
  type DurableSessionCallerContext,
  type DurableSessionEvent,
  type DurableSessionOperationRequest,
  type DurableSessionOperationResponse,
  type DurableSessionOperationResult,
  type SessionId,
} from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import { DurableSessionHostConfigSchema } from "../src/config.js";
import { startDurableSessionHost, type RunningDurableSessionHost } from "../src/host.js";
import { silentHostLogger } from "../src/logging.js";
import { createHostFixture, ownerCaller, profileCommand, TEST_CREDENTIAL } from "./support.js";

const actualDescribe = describe.skipIf(process.env.DURABLE_SESSION_ACTUAL_PTY !== "1");

actualDescribe("DurableSession Host actual Node 24 PTY acceptance", () => {
  it("keeps a long-running alternate-screen TUI without attachments and recovers it as stopped", async () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
    const fixture = createHostFixture();
    const tuiPath = realpathSync(
      fileURLToPath(new URL("./fixtures/generic-tui.mjs", import.meta.url)),
    );
    const profile = fixture.config.profiles[0];
    if (profile === undefined) throw new Error("Fixture profile is missing.");
    const config = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      profiles: [{ ...profile, args: [tuiPath] }],
    });

    let firstHost: RunningDurableSessionHost | null = null;
    let secondHost: RunningDurableSessionHost | null = null;
    try {
      firstHost = await startDurableSessionHost(config, {
        logger: silentHostLogger,
        hostEnvironment: {},
      });
      const caller = freshCaller();
      const created = requireSession(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "71000000-0000-4000-8000-000000000001",
          operation: "createSession",
          idempotencyKey: "72000000-0000-4000-8000-000000000001",
          command: profileCommand(),
        }),
        "createSession",
      );
      expect(created).toMatchObject({ lifecycle: "running", sessionRevision: 1 });

      const firstSnapshot = await waitForSnapshot(firstHost, created.sessionId, (snapshot) =>
        snapshot.serializedState.includes("ACTUAL-TUI-READY"),
      );
      expect(firstSnapshot.sequence).toBeGreaterThan(0);
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const laterSnapshot = await firstHost.service.terminalSnapshot(created.sessionId);
      expect(laterSnapshot.sequence).toBeGreaterThan(firstSnapshot.sequence);

      await firstHost.close();
      firstHost = null;

      secondHost = await startDurableSessionHost(config, {
        logger: silentHostLogger,
        hostEnvironment: {},
      });
      const recovered = requireSession(
        await operation(config.socketPath, freshCaller(), {
          version: 0,
          requestId: "71000000-0000-4000-8000-000000000002",
          operation: "getSession",
          sessionId: created.sessionId,
        }),
        "getSession",
      );
      expect(recovered).toMatchObject({
        sessionId: created.sessionId,
        lifecycle: "stopped",
        runtimeId: null,
        nextSequence: 0,
      });

      const restarted = requireSession(
        await operation(config.socketPath, freshCaller(), {
          version: 0,
          requestId: "71000000-0000-4000-8000-000000000003",
          operation: "startSession",
          sessionId: created.sessionId,
          expectedSessionRevision: recovered.sessionRevision,
          idempotencyKey: "72000000-0000-4000-8000-000000000003",
        }),
        "startSession",
      );
      expect(restarted.runtimeId).not.toBe(created.runtimeId);
      expect(restarted.lifecycle).toBe("running");
      await waitForSnapshot(secondHost, created.sessionId, (snapshot) =>
        snapshot.serializedState.includes("ACTUAL-TUI-READY"),
      );
    } finally {
      await firstHost?.close();
      await secondHost?.close();
    }
  }, 20_000);

  it("supports two local clients, ordered observation, transfer, preempt and grace resume", async () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
    const fixture = createHostFixture();
    const tuiPath = realpathSync(
      fileURLToPath(new URL("./fixtures/generic-tui.mjs", import.meta.url)),
    );
    const profile = fixture.config.profiles[0];
    if (profile === undefined) throw new Error("Fixture profile is missing.");
    const config = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      profiles: [{ ...profile, args: [tuiPath] }],
    });
    const host = await startDurableSessionHost(config, {
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    try {
      const caller = freshCaller();
      const created = requireSession(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000001",
          operation: "createSession",
          idempotencyKey: "74000000-0000-4000-8000-000000000001",
          command: profileCommand(),
        }),
        "createSession",
      );
      await waitForSnapshot(host, created.sessionId, (snapshot) => snapshot.sequence > 0);
      const runtimeId = created.runtimeId;
      if (runtimeId === null) throw new Error("Created session did not retain a runtime.");
      const first = requireAttachment(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000002",
          operation: "openAttachment",
          sessionId: created.sessionId,
        }),
        "openAttachment",
      );
      const second = requireAttachment(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000003",
          operation: "openAttachment",
          sessionId: created.sessionId,
        }),
        "openAttachment",
      );
      const firstUnsubscribe = await host.service.bindStreamAttachment(
        caller,
        created.sessionId,
        first.attachmentId,
        "actual-first",
        () => undefined,
      );
      const secondUnsubscribe = await host.service.bindStreamAttachment(
        caller,
        created.sessionId,
        second.attachmentId,
        "actual-second",
        () => undefined,
      );
      await takeAllEvents(host, first.attachmentId, "actual-first");
      await takeAllEvents(host, second.attachmentId, "actual-second");
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      const firstOutput = (await takeAllEvents(host, first.attachmentId, "actual-first")).filter(
        (event) => event.type === "terminal.output",
      );
      const secondOutput = (await takeAllEvents(host, second.attachmentId, "actual-second")).filter(
        (event) => event.type === "terminal.output",
      );
      expect(firstOutput.length).toBeGreaterThan(0);
      expect(firstOutput.map((event) => event.sequence)).toEqual(
        secondOutput.map((event) => event.sequence),
      );

      requireControl(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000004",
          operation: "acquireControl",
          sessionId: created.sessionId,
          attachmentId: first.attachmentId,
          expectedRuntimeId: runtimeId,
          expectedControllerGeneration: 0,
          terminal: { cols: 100, rows: 30 },
        }),
        "acquireControl",
      );
      const request = requireOperation(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000005",
          operation: "requestControl",
          sessionId: created.sessionId,
          attachmentId: second.attachmentId,
          expectedControllerGeneration: 1,
        }),
        "requestControl",
      );
      const offer = requireOperation(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000006",
          operation: "approveControl",
          sessionId: created.sessionId,
          attachmentId: first.attachmentId,
          controlRequestId: request.request.controlRequestId,
          expectedControllerGeneration: 1,
        }),
        "approveControl",
      );
      expect(
        requireControl(
          await operation(config.socketPath, caller, {
            version: 0,
            requestId: "73000000-0000-4000-8000-000000000007",
            operation: "acceptControl",
            sessionId: created.sessionId,
            attachmentId: second.attachmentId,
            controlOfferId: offer.offer.controlOfferId,
            expectedRuntimeId: runtimeId,
            expectedControllerGeneration: 1,
            terminal: { cols: 120, rows: 40 },
            idempotencyKey: "74000000-0000-4000-8000-000000000007",
          }),
          "acceptControl",
        ),
      ).toMatchObject({ controllerAttachmentId: second.attachmentId, controllerGeneration: 2 });

      secondUnsubscribe();
      await host.service.disconnectStreamAttachment(caller, created.sessionId, second.attachmentId);
      const resumed = requireAttachment(
        await operation(config.socketPath, caller, {
          version: 0,
          requestId: "73000000-0000-4000-8000-000000000008",
          operation: "resumeAttachment",
          sessionId: created.sessionId,
          attachmentId: second.attachmentId,
          expectedRuntimeId: runtimeId,
          expectedControllerGeneration: 2,
          attachmentResumeToken: second.attachmentResumeToken,
        }),
        "resumeAttachment",
      );
      expect(resumed).toMatchObject({ attachmentId: second.attachmentId, role: "controller" });
      expect(resumed.attachmentResumeToken).not.toBe(second.attachmentResumeToken);
      expect(
        requireControl(
          await operation(config.socketPath, caller, {
            version: 0,
            requestId: "73000000-0000-4000-8000-000000000009",
            operation: "preemptControl",
            sessionId: created.sessionId,
            attachmentId: first.attachmentId,
            expectedRuntimeId: runtimeId,
            expectedControllerGeneration: 2,
            terminal: { cols: 90, rows: 25 },
            idempotencyKey: "74000000-0000-4000-8000-000000000009",
            reasonCode: "owner-takeover",
          }),
          "preemptControl",
        ),
      ).toMatchObject({ controllerAttachmentId: first.attachmentId, controllerGeneration: 3 });
      const finalSnapshot = await host.service.terminalSnapshot(created.sessionId);
      expect(finalSnapshot.terminal).toEqual({ cols: 90, rows: 25 });
      firstUnsubscribe();
    } finally {
      await host.close();
    }
  }, 20_000);
});

function freshCaller(): DurableSessionCallerContext {
  return ownerCaller(Date.now());
}

async function waitForSnapshot(
  host: RunningDurableSessionHost,
  sessionId: SessionId,
  predicate: (snapshot: Awaited<ReturnType<typeof host.service.terminalSnapshot>>) => boolean,
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const snapshot = await host.service.terminalSnapshot(sessionId);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 25));
  }
  throw new Error("Actual PTY snapshot did not reach the expected state.");
}

function requireSession(
  response: DurableSessionOperationResponse,
  operationName: "createSession" | "getSession" | "startSession",
) {
  if (
    !response.ok ||
    response.result.operation !== operationName ||
    !("session" in response.result)
  ) {
    throw new Error(`Expected ${operationName} Session response: ${JSON.stringify(response)}`);
  }
  return response.result.session;
}

function requireAttachment(
  response: DurableSessionOperationResponse,
  operationName: "openAttachment" | "resumeAttachment",
) {
  if (!response.ok || response.result.operation !== operationName) {
    throw new Error(`Expected ${operationName} attachment response.`);
  }
  return response.result.attachment;
}

function requireControl(
  response: DurableSessionOperationResponse,
  operationName: "acquireControl" | "acceptControl" | "preemptControl",
) {
  const result = requireOperation(response, operationName);
  return result.control;
}

function requireOperation<T extends DurableSessionOperationResult["operation"]>(
  response: DurableSessionOperationResponse,
  operationName: T,
) {
  if (!response.ok || response.result.operation !== operationName) {
    throw new Error(`Expected ${operationName} response.`);
  }
  return response.result as Extract<DurableSessionOperationResult, { operation: T }>;
}

async function takeAllEvents(
  host: RunningDurableSessionHost,
  attachmentId: string,
  streamId: string,
): Promise<DurableSessionEvent[]> {
  const events: DurableSessionEvent[] = [];
  for (;;) {
    const event = await host.service.takeStreamEvent(attachmentId, streamId);
    if (event === null) return events;
    events.push(event);
  }
}

function operation(
  socketPath: string,
  callerContext: DurableSessionCallerContext,
  request: DurableSessionOperationRequest,
): Promise<DurableSessionOperationResponse> {
  const body = JSON.stringify({ callerContext, request });
  return new Promise((resolvePromise, reject) => {
    const outgoing = httpRequest(
      {
        socketPath,
        method: "POST",
        path: "/v0/operations",
        agent: false,
        headers: {
          authorization: `Bearer ${TEST_CREDENTIAL}`,
          "content-type": "application/json",
          "content-length": String(Buffer.byteLength(body)),
          "x-durable-session-app-id": "fixture-app",
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolvePromise(
              DurableSessionOperationResponseSchema.parse(
                JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
              ),
            );
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Host response parsing failed."));
          }
        });
      },
    );
    outgoing.once("error", reject);
    outgoing.end(body);
  });
}
