import { chmodSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  startDurableSessionHost,
  type RunningDurableSessionHost,
} from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { MemoryMetadataRepository } from "../../durable-session-host/src/metadata.js";
import {
  createHostFixture,
  FakeClock,
  FakeIds,
  FakeRuntimePort,
  profileCommand,
} from "../../durable-session-host/test/support.js";
import {
  DurableSessionHostOperationError,
  DurableSessionHostTransportError,
  UdsDurableSessionLifecycleClient,
  operationRequestBase,
  type DurableHostConfig,
} from "../src/durable-session-host-client.js";

const runningHosts: RunningDurableSessionHost[] = [];

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
});

describe("Naru DurableSession UDS lifecycle client", () => {
  it("uses the private socket, registered credential, caller scope and v0 response parser", async () => {
    const fixture = createHostFixture();
    const runtime = new FakeRuntimePort();
    const clock = new FakeClock(Date.now());
    const host = await startDurableSessionHost(
      {
        ...fixture.config,
        appRegistrations: fixture.config.appRegistrations.map((registration) => ({
          ...registration,
          profileScope: { kind: "ids" as const, ids: ["fixture"] },
        })),
      },
      {
        metadata: new MemoryMetadataRepository(),
        runtime,
        clock,
        ids: new FakeIds(),
        logger: silentHostLogger,
        hostEnvironment: {},
      },
    );
    runningHosts.push(host);
    const client = new UdsDurableSessionLifecycleClient(clientConfig(fixture));

    await expect(client.readiness()).resolves.toBe(true);
    await expect(
      client.execute({
        ...operationRequestBase(),
        operation: "createSession",
        idempotencyKey: "60000000-0000-4000-8000-000000000099",
        command: profileCommand(),
      }),
    ).resolves.toMatchObject({
      operation: "createSession",
      session: { lifecycle: "running" },
    });
    expect(runtime.records).toHaveLength(1);
  });

  it("fails closed for insecure credentials and surfaces stable Host denials separately", async () => {
    const fixture = createHostFixture();
    const host = await startDurableSessionHost(fixture.config, {
      metadata: new MemoryMetadataRepository(),
      runtime: new FakeRuntimePort(),
      clock: new FakeClock(Date.now()),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);

    const denied = new UdsDurableSessionLifecycleClient({
      ...clientConfig(fixture),
      appId: "unregistered-app",
    });
    await expect(
      denied.execute({ ...operationRequestBase(), operation: "listSessions", limit: 10 }),
    ).rejects.toBeInstanceOf(DurableSessionHostOperationError);

    chmodSync(fixture.credentialFile, 0o644);
    const insecure = new UdsDurableSessionLifecycleClient(clientConfig(fixture));
    await expect(
      insecure.execute({ ...operationRequestBase(), operation: "listSessions", limit: 10 }),
    ).rejects.toBeInstanceOf(DurableSessionHostTransportError);
  });
});

function clientConfig(fixture: ReturnType<typeof createHostFixture>): DurableHostConfig {
  return {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds: fixture.config.profiles.map((profile) => profile.profileId),
    roots: fixture.config.roots,
  };
}
