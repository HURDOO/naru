import type { DurableSessionStreamAttachmentEvent } from "@naru/contracts/durable-session/v0";
import {
  DurableSessionAttachmentHandle,
  DurableSessionClient,
  type TerminalSequenceResult,
} from "@naru/durable-session-client";
import { UdsWebSocketDurableSessionTransport } from "@naru/durable-session-client/node";
import { describe, expect, it } from "vitest";
import { startDurableSessionHost } from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { MemoryMetadataRepository } from "../../durable-session-host/src/metadata.js";
import {
  createHostFixture,
  FakeIds,
  FakeRuntimePort,
  ownerCaller,
  profileCommand,
  TEST_CREDENTIAL,
  TEST_IDS,
} from "../../durable-session-host/test/support.js";

describe("public client over the T07 UDS stream", () => {
  it("routes ordered output and completes request/accept/release/preempt with two handles", async () => {
    const fixture = createHostFixture();
    const runtime = new FakeRuntimePort();
    const host = await startDurableSessionHost(fixture.config, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    const caller = ownerCaller(Date.now());
    let transport: UdsWebSocketDurableSessionTransport | null = null;

    try {
      transport = await stage(
        "connect",
        UdsWebSocketDurableSessionTransport.connect({
          socketPath: fixture.config.socketPath,
          appId: "fixture-app",
          credential: TEST_CREDENTIAL,
          callerContext: caller,
        }),
      );
      const client = new DurableSessionClient({ transport, callerContext: caller });
      const created = await stage(
        "createSession",
        client.request({
          operation: "createSession",
          idempotencyKey: crypto.randomUUID(),
          command: profileCommand(),
        }),
      );
      const first = await stage(
        "open first attachment",
        DurableSessionAttachmentHandle.open(client, {
          sessionId: created.session.sessionId,
        }),
      );
      const firstResults = await routeUntil(transport, [first], () => first.terminalSequence === 0);
      expect(firstResults).toContainEqual({
        kind: "snapshot",
        runtimeId: TEST_IDS.runtime1,
        sequence: 0,
        serializedState: "",
      });

      const second = await DurableSessionAttachmentHandle.open(client, {
        sessionId: created.session.sessionId,
      });
      await routeUntil(transport, [first, second], () => second.terminalSequence === 0);

      runtime.data(TEST_IDS.runtime1, "stream-client-output");
      await client.request({ operation: "getSession", sessionId: created.session.sessionId });
      const outputResults = await routeUntil(
        transport,
        [first, second],
        () => first.terminalSequence === 1 && second.terminalSequence === 1,
      );
      expect(outputResults.filter((result) => result.kind === "output")).toEqual([
        { kind: "output", sequence: 1, data: "stream-client-output" },
        { kind: "output", sequence: 1, data: "stream-client-output" },
      ]);

      await first.acquireControl({ cols: 90, rows: 25 });
      await routeUntil(
        transport,
        [first, second],
        () => first.view.controllerGeneration === 1 && second.view.controllerGeneration === 1,
      );
      expect(first.view.role).toBe("controller");
      expect(second.view.role).toBe("observer");

      const controlRequestId = await second.requestControl();
      const controlOfferId = await first.approveControl(controlRequestId);
      await second.acceptControl(controlOfferId, { cols: 120, rows: 40 });
      await routeUntil(
        transport,
        [first, second],
        () => first.view.controllerGeneration === 2 && second.view.controllerGeneration === 2,
      );
      expect(first.view.role).toBe("observer");
      expect(second.view.role).toBe("controller");

      await second.releaseControl();
      await routeUntil(
        transport,
        [first, second],
        () => first.view.controllerGeneration === 3 && second.view.controllerGeneration === 3,
      );
      expect(first.view.role).toBe("observer");
      expect(second.view.role).toBe("observer");

      await first.preemptControl({ cols: 100, rows: 30 }, "owner-takeover");
      await routeUntil(
        transport,
        [first, second],
        () => first.view.controllerGeneration === 4 && second.view.controllerGeneration === 4,
      );
      expect(first.view.role).toBe("controller");
      expect(second.view.role).toBe("observer");

      await first.close();
      await second.close();
    } finally {
      await transport?.close();
      await host.close();
    }
  });
});

async function routeUntil(
  transport: UdsWebSocketDurableSessionTransport,
  handles: readonly DurableSessionAttachmentHandle[],
  done: () => boolean,
): Promise<TerminalSequenceResult[]> {
  const results: TerminalSequenceResult[] = [];
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 3_000);
  try {
    while (!done()) {
      let frame: DurableSessionStreamAttachmentEvent;
      try {
        frame = await transport.nextAttachmentEvent({ signal: timeout.signal });
      } catch (error) {
        if (timeout.signal.aborted) {
          throw new Error("Timed out routing Host attachment events.", { cause: error });
        }
        throw error;
      }
      const handle = handles.find(
        (candidate) => candidate.view.attachmentId === frame.attachmentId,
      );
      if (handle !== undefined) results.push(handle.acceptEvent(frame.event));
    }
    return results;
  } finally {
    clearTimeout(timer);
  }
}

async function stage<T>(label: string, promise: Promise<T>): Promise<T> {
  try {
    return await promise;
  } catch (error) {
    const detail =
      error instanceof Error && error.cause instanceof Error ? ` ${error.cause.message}` : "";
    throw new Error(`T08 stream integration failed during ${label}.${detail}`, { cause: error });
  }
}
