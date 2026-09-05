import { createRequire } from "node:module";
import {
  deriveIntegrationBootstrapKey,
  DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV,
  verifyIntegrationBootstrap,
} from "@naru/durable-session-integration";
import { afterEach, describe, expect, it } from "vitest";
import type { DurableSessionStreamServerFrame } from "../src/stream-protocol.js";
import { DurableSessionHostConfigSchema } from "../src/config.js";
import { startDurableSessionHost, type RunningDurableSessionHost } from "../src/host.js";
import { silentHostLogger } from "../src/logging.js";
import { MemoryMetadataRepository } from "../src/metadata.js";
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

const require = createRequire(import.meta.url);
const webSocketAvailable = canResolveWebSocket();
const runningHosts: RunningDurableSessionHost[] = [];

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
});

describe.skipIf(!webSocketAvailable)("DurableSession Host UDS WebSocket adapter", () => {
  it("multiplexes operation responses and ordered attachment events", async () => {
    const fixture = createHostFixture();
    const config = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      integrationPolicies: [
        {
          policyRef: "fixture-integration-v0",
          appId: "fixture-app",
          integrationKind: "fixture",
          profileIds: ["fixture"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    });
    const clock = new FakeClock();
    const runtime = new FakeRuntimePort();
    const host = await startDurableSessionHost(config, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      clock,
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);
    await expect(connectWebSocket(fixture.config.socketPath, {})).rejects.toThrow(/401/);
    const client = await connectWebSocket(fixture.config.socketPath);

    client.send({ version: 0, type: "stream.hello", callerContext: ownerCaller(clock.value) });
    await expect(client.next()).resolves.toMatchObject({ type: "stream.ready" });
    client.send({
      version: 0,
      type: "stream.operation",
      request: {
        version: 0,
        requestId: fixtureUuid(1),
        operation: "createSession",
        idempotencyKey: fixtureUuid(101),
        command: profileCommand(),
      },
    });
    const created = await client.next();
    if (created.type === "stream.error") {
      throw new Error(`Unexpected stream error: ${JSON.stringify(created.error)}`);
    }
    expect(created).toMatchObject({
      type: "stream.operation-response",
      response: { ok: true, result: { operation: "createSession" } },
    });
    client.send({
      version: 0,
      type: "stream.operation",
      request: {
        version: 0,
        requestId: fixtureUuid(2),
        operation: "openAttachment",
        sessionId: TEST_IDS.session1,
      },
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "stream.operation-response",
      response: { ok: true, result: { operation: "openAttachment" } },
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "stream.attachment-event",
      attachmentId: TEST_IDS.attachment1,
      event: { type: "terminal.snapshot", sequence: 0 },
    });

    runtime.data(TEST_IDS.runtime1, "uds-websocket-output");
    await host.service.execute(ownerCaller(clock.value), {
      version: 0,
      requestId: fixtureUuid(3),
      operation: "getSession",
      sessionId: TEST_IDS.session1,
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "stream.attachment-event",
      attachmentId: TEST_IDS.attachment1,
      event: { type: "terminal.output", sequence: 1, data: "uds-websocket-output" },
    });

    const bindingId = fixtureUuid(201);
    client.send({
      version: 0,
      type: "stream.operation",
      request: {
        version: 0,
        requestId: fixtureUuid(4),
        operation: "createSession",
        idempotencyKey: fixtureUuid(104),
        command: {
          ...profileCommand(),
          integration: {
            kind: "fixture",
            config: { policyRef: "fixture-integration-v0", bindingId },
          },
        },
      },
    });
    await expect(client.next()).resolves.toMatchObject({
      type: "stream.operation-response",
      response: {
        ok: true,
        result: {
          operation: "createSession",
          session: { sessionId: TEST_IDS.session2, runtimeId: TEST_IDS.runtime2 },
        },
      },
    });
    const bootstrap =
      runtime.records[1]?.request.launch.environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
    if (bootstrap === undefined) throw new Error("WebSocket integration bootstrap is missing.");
    expect(
      verifyIntegrationBootstrap(bootstrap, deriveIntegrationBootstrapKey(TEST_CREDENTIAL)),
    ).toMatchObject({
      sessionId: TEST_IDS.session2,
      runtimeId: TEST_IDS.runtime2,
      integration: {
        kind: "fixture",
        config: { policyRef: "fixture-integration-v0", bindingId },
      },
    });

    await client.close();
    await host.close();
  });
});

interface WebSocketClient {
  send(frame: unknown): void;
  next(): Promise<DurableSessionStreamServerFrame>;
  close(): Promise<void>;
}

interface TestWebSocket {
  send(data: string): void;
  close(): void;
  on(event: "open" | "close" | "error", listener: (error?: Error) => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
}

function connectWebSocket(
  socketPath: string,
  headers: Readonly<Record<string, string>> = {
    authorization: `Bearer ${TEST_CREDENTIAL}`,
    "x-durable-session-app-id": "fixture-app",
  },
): Promise<WebSocketClient> {
  const WebSocket = (
    require("ws") as { WebSocket: new (url: string, options: unknown) => TestWebSocket }
  ).WebSocket;
  const socket = new WebSocket(`ws+unix://${socketPath}:/v0/stream`, {
    headers,
    perMessageDeflate: false,
  });
  const queued: DurableSessionStreamServerFrame[] = [];
  const waiters: ((frame: DurableSessionStreamServerFrame) => void)[] = [];
  socket.on("message", (data) => {
    const frame = JSON.parse(data.toString("utf8")) as DurableSessionStreamServerFrame;
    const waiter = waiters.shift();
    if (waiter === undefined) queued.push(frame);
    else waiter(frame);
  });
  return new Promise((resolvePromise, reject) => {
    socket.on("error", (error) => reject(error ?? new Error("WebSocket connection failed.")));
    socket.on("open", () => {
      resolvePromise({
        send: (frame) => socket.send(JSON.stringify(frame)),
        next: () => {
          const frame = queued.shift();
          if (frame !== undefined) return Promise.resolve(frame);
          return new Promise((resolveFrame) => waiters.push(resolveFrame));
        },
        close: () =>
          new Promise((resolveClose) => {
            socket.on("close", () => resolveClose());
            socket.close();
          }),
      });
    });
  });
}

function canResolveWebSocket(): boolean {
  try {
    require.resolve("ws");
    return true;
  } catch {
    return false;
  }
}

function fixtureUuid(ordinal: number): string {
  return `70000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
}
