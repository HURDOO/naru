import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ServerWsFrame } from "@naru/contracts";
import type {
  AttachmentLease,
  DurableSessionCallerContext,
  DurableSessionEvent,
} from "@naru/contracts/durable-session/v0";
import { DurableSessionClient } from "@naru/durable-session-client";
import {
  readPrivateCredentialFile,
  UdsWebSocketDurableSessionTransport,
} from "@naru/durable-session-client/node";
import { afterEach, describe, expect, it, vi } from "vitest";
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
} from "../../durable-session-host/test/support.js";
import { NaruRepository } from "../src/database.js";
import { DurableHostSessionFacade } from "../src/durable-session-facade.js";
import {
  operationRequestBase,
  type DurableHostConfig,
  UdsDurableSessionLifecycleClient,
} from "../src/durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "../src/durable-session-stream-port.js";

const runningHosts: RunningDurableSessionHost[] = [];

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
});

describe("Naru DurableSession UDS stream adapter", () => {
  it("connects lifecycle and stream probes through an exact private socket path with spaces", async () => {
    const fixture = createHostFixture();
    const runtimeDirectory = join(fixture.root, "runtime with space");
    mkdirSync(runtimeDirectory, { mode: 0o700 });
    const socketPath = join(runtimeDirectory, "host.sock");
    const hostConfig = {
      ...fixture.config,
      socketPath,
      appRegistrations: fixture.config.appRegistrations.map((registration) => ({
        ...registration,
        subjectScope: { kind: "ids" as const, ids: ["fixture-owner"] },
        profileScope: { kind: "ids" as const, ids: ["fixture"] },
        rootScope: { kind: "ids" as const, ids: ["projects"] },
      })),
    };
    const host = await startDurableSessionHost(hostConfig, {
      metadata: new MemoryMetadataRepository(),
      runtime: new FakeRuntimePort(),
      clock: new FakeClock(Date.now()),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);
    const config = { ...clientConfig(fixture), socketPath, callerTtlMs: 50_000 };
    const lifecycle = new UdsDurableSessionLifecycleClient(config);
    const stream = new UdsDurableSessionStreamPort(config);

    await expect(lifecycle.readiness()).resolves.toBe(true);
    await expect(stream.readiness()).resolves.toBe(true);
    await stream.shutdown();
  });

  it("preserves one Host runtime and ordered terminal state across a Naru-only restart", async () => {
    const fixture = createHostFixture();
    const hostConfig = {
      ...fixture.config,
      profiles: fixture.config.profiles.map((profile) => ({
        ...profile,
        profileId: "shell",
      })),
      appRegistrations: fixture.config.appRegistrations.map((registration) => ({
        ...registration,
        profileScope: { kind: "ids" as const, ids: ["shell"] },
      })),
    };
    const runtime = new FakeRuntimePort();
    const host = await startDurableSessionHost(hostConfig, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      clock: new FakeClock(Date.now()),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);

    const config = clientConfig(fixture, ["shell"]);
    const database = join(fixture.root, "data", "naru.sqlite");
    const firstRepository = new NaruRepository(database, { sessionOwner: "durable-host" });
    const project = firstRepository.createProject(
      join(fixture.root, "projects", "sample"),
      "sample",
    );
    const pane = firstRepository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("Fixture terminal Pane is missing.");

    const firstLifecycle = new UdsDurableSessionLifecycleClient(config);
    const firstStream = new UdsDurableSessionStreamPort(config);
    const first = new DurableHostSessionFacade(
      firstRepository,
      config,
      firstLifecycle,
      firstStream,
    );
    await expect(first.readiness()).resolves.toBe(true);
    await first.start(pane.id, 100, 30);

    const link = firstRepository.getPaneSessionLink(pane.id);
    if (link?.sessionId === null || link?.sessionId === undefined) {
      throw new Error("Naru did not persist the Host Session link.");
    }
    const created = await firstLifecycle.execute({
      ...operationRequestBase(),
      operation: "getSession",
      sessionId: link.sessionId,
    });
    if (created.operation !== "getSession" || created.session.runtimeId === null) {
      throw new Error("Host Session did not expose a running runtime.");
    }
    const runtimeId = created.session.runtimeId;
    const firstFrames: ServerWsFrame[] = [];
    const firstDetach = await first.attach(pane.id, 100, 30, (frame) => firstFrames.push(frame));
    await waitForFrame(firstFrames, "pane.snapshot");

    runtime.data(runtimeId, "before-naru-restart");
    const beforeOutput = await waitForOutput(firstFrames, "before-naru-restart");
    await first.write(pane.id, "fixture-input");
    await first.resize(pane.id, 120, 40);
    expect(runtime.records[0]?.writes).toEqual(["fixture-input"]);
    expect(runtime.records[0]?.resizes.at(-1)).toEqual({ cols: 120, rows: 40 });

    firstDetach();
    await first.shutdown();
    firstRepository.close();

    expect(runtime.records).toHaveLength(1);
    expect(runtime.records[0]).toMatchObject({ exited: false, kills: [] });

    const restartedRepository = new NaruRepository(database, {
      sessionOwner: "durable-host",
    });
    const restartedLifecycle = new UdsDurableSessionLifecycleClient(config);
    const restartedStream = new UdsDurableSessionStreamPort(config);
    const restarted = new DurableHostSessionFacade(
      restartedRepository,
      config,
      restartedLifecycle,
      restartedStream,
    );
    await restarted.reconcile();

    const restartedFrames: ServerWsFrame[] = [];
    const restartedDetach = await restarted.attach(pane.id, 120, 40, (frame) =>
      restartedFrames.push(frame),
    );
    const restored = await waitForFrame(restartedFrames, "pane.snapshot");
    expect(restored).toMatchObject({ runtimeId });
    if (restored.type !== "pane.snapshot") throw new Error("Expected a Host snapshot.");
    expect(restored.sequence).toBeGreaterThanOrEqual(beforeOutput.sequence);

    runtime.data(runtimeId, "after-naru-restart");
    const afterOutput = await waitForOutput(restartedFrames, "after-naru-restart");
    expect(afterOutput.sequence).toBeGreaterThan(beforeOutput.sequence);
    expect(runtime.records).toHaveLength(1);
    expect(restartedRepository.getPaneSessionLink(pane.id)).toMatchObject({
      sessionId: link.sessionId,
      state: "linked",
    });

    restartedDetach();
    await restarted.shutdown();
    restartedRepository.close();
    expect(runtime.records[0]).toMatchObject({ exited: false, kills: [] });
  });

  it("retires an exited attachment so one stopped Pane cannot poison runtime readiness", async () => {
    const fixture = createHostFixture();
    const hostConfig = {
      ...fixture.config,
      profiles: fixture.config.profiles.map((profile) => ({
        ...profile,
        profileId: "shell",
      })),
    };
    const runtime = new FakeRuntimePort();
    const host = await startDurableSessionHost(hostConfig, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      clock: new FakeClock(Date.now()),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);
    const config = clientConfig(fixture, ["shell"]);
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const project = repository.createProject(join(fixture.root, "projects", "sample"), "sample");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("Fixture terminal Pane is missing.");
    const stream = new UdsDurableSessionStreamPort(config);
    const facade = new DurableHostSessionFacade(
      repository,
      config,
      new UdsDurableSessionLifecycleClient(config),
      stream,
    );

    try {
      await facade.start(pane.id, 100, 30);
      const frames: ServerWsFrame[] = [];
      await facade.attach(pane.id, 100, 30, (frame) => frames.push(frame));
      await waitForFrame(frames, "pane.snapshot");
      await facade.stop(pane.id);
      expect(runtime.records[0]?.exited).toBe(true);
      await waitForFrame(frames, "terminal.exit");

      await expect(stream.readiness()).resolves.toBe(true);
      await facade.restart(pane.id);
      expect(runtime.records).toHaveLength(2);
    } finally {
      await facade.shutdown();
      repository.close();
    }
  });

  it("retires and reconciles a stale attachment after an honest Host restart", async () => {
    const fixture = createHostFixture();
    const hostConfig = {
      ...fixture.config,
      profiles: fixture.config.profiles.map((profile) => ({
        ...profile,
        profileId: "shell",
      })),
      appRegistrations: fixture.config.appRegistrations.map((registration) => ({
        ...registration,
        profileScope: { kind: "ids" as const, ids: ["shell"] },
      })),
    };
    const firstRuntime = new FakeRuntimePort();
    const firstHost = await startDurableSessionHost(hostConfig, {
      runtime: firstRuntime,
      clock: new FakeClock(Date.now()),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(firstHost);
    const config = clientConfig(fixture, ["shell"]);
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const project = repository.createProject(join(fixture.root, "projects", "sample"), "sample");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("Fixture terminal Pane is missing.");
    const lifecycle = new UdsDurableSessionLifecycleClient(config);
    const stream = new UdsDurableSessionStreamPort(config);
    const facade = new DurableHostSessionFacade(repository, config, lifecycle, stream);

    try {
      await facade.start(pane.id, 100, 30);
      const link = repository.getPaneSessionLink(pane.id);
      if (link?.sessionId === null || link?.sessionId === undefined) {
        throw new Error("Fixture Host Session link is missing.");
      }
      const runtimeId = firstRuntime.records[0]?.request.runtimeId;
      if (runtimeId === undefined) throw new Error("Fixture Host runtime is missing.");
      repository.beginPaneRuntime(pane.id, runtimeId);
      const frames: ServerWsFrame[] = [];
      await facade.attach(pane.id, 100, 30, (frame) => frames.push(frame));
      await waitForFrame(frames, "pane.snapshot");

      await firstHost.close();
      await vi.waitFor(async () => {
        await expect(stream.readiness()).resolves.toBe(false);
      });
      const restartedRuntime = new FakeRuntimePort();
      const restartedHost = await startDurableSessionHost(hostConfig, {
        runtime: restartedRuntime,
        clock: new FakeClock(Date.now()),
        ids: new FakeIds(),
        logger: silentHostLogger,
        hostEnvironment: {},
      });
      runningHosts.push(restartedHost);

      await vi.waitFor(
        () => {
          expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
            status: "stopped",
            activity: { state: "server-stopped", runtimeId },
          });
          expect(facade.isRunning(pane.id)).toBe(false);
        },
        { timeout: 5_000 },
      );
      await vi.waitFor(
        async () => {
          await expect(stream.readiness()).resolves.toBe(true);
          await expect(facade.readiness()).resolves.toBe(true);
        },
        { timeout: 5_000 },
      );
      const stopped = await lifecycle.execute({
        ...operationRequestBase(),
        operation: "getSession",
        sessionId: link.sessionId,
      });
      expect(stopped).toMatchObject({
        operation: "getSession",
        session: { lifecycle: "stopped", runtimeId: null },
      });
      expect(frames.filter((frame) => frame.type === "terminal.exit")).toHaveLength(0);
      expect(restartedRuntime.records).toHaveLength(0);
    } finally {
      await facade.shutdown();
      repository.close();
    }
  });

  it("keeps same-Pane observers read-only until an explicit preempt changes both fences", async () => {
    const fixture = createHostFixture();
    const hostConfig = {
      ...fixture.config,
      profiles: fixture.config.profiles.map((profile) => ({
        ...profile,
        profileId: "shell",
      })),
    };
    const runtime = new FakeRuntimePort();
    const host = await startDurableSessionHost(hostConfig, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      clock: new FakeClock(Date.now()),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);

    const config = clientConfig(fixture, ["shell"]);
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const project = repository.createProject(join(fixture.root, "projects", "sample"), "sample");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("Fixture terminal Pane is missing.");
    const facade = new DurableHostSessionFacade(
      repository,
      config,
      new UdsDurableSessionLifecycleClient(config),
      new UdsDurableSessionStreamPort(config),
    );

    try {
      await facade.start(pane.id, 100, 30);
      const controllerFrames: ServerWsFrame[] = [];
      const observerFrames: ServerWsFrame[] = [];
      const detachController = await facade.attach(
        pane.id,
        100,
        30,
        (frame) => controllerFrames.push(frame),
        undefined,
        undefined,
        { attachmentKey: "browser-controller", control: "controller" },
      );
      await waitForFrame(controllerFrames, "pane.snapshot");
      const resizeCountBeforeObserver = runtime.records[0]?.resizes.length ?? 0;
      const detachObserver = await facade.attach(
        pane.id,
        52,
        18,
        (frame) => observerFrames.push(frame),
        undefined,
        undefined,
        { attachmentKey: "browser-observer", control: "observer" },
      );
      const observerSnapshot = await waitForFrame(observerFrames, "pane.snapshot");
      expect(observerSnapshot).toMatchObject({ cols: 100, rows: 30 });
      expect(runtime.records[0]?.resizes).toHaveLength(resizeCountBeforeObserver);

      await expect(facade.resize(pane.id, 52, 18, "browser-observer")).rejects.toMatchObject({
        code: "LEASE_REQUIRED",
      });
      expect(runtime.records[0]?.resizes).toHaveLength(resizeCountBeforeObserver);

      const runtimeId = observerSnapshot.runtimeId;
      runtime.data(runtimeId, "fan-out");
      await waitForOutput(controllerFrames, "fan-out");
      await waitForOutput(observerFrames, "fan-out");

      const link = repository.getPaneSessionLink(pane.id);
      if (link?.sessionId === null || link?.sessionId === undefined) {
        throw new Error("Fixture Host Session link is missing.");
      }
      const requester = await openRequester(config, link.sessionId);
      try {
        const requested = await requester.client.request({
          operation: "requestControl",
          sessionId: requester.lease.sessionId,
          attachmentId: requester.lease.attachmentId,
          expectedControllerGeneration: requester.lease.controllerGeneration,
        });
        const projectedRequest = await waitForFrame(controllerFrames, "pane.control.requested");
        expect(projectedRequest).toMatchObject({
          controlRequestId: requested.request.controlRequestId,
        });
        await facade.approveControl(
          pane.id,
          requested.request.controlRequestId,
          "browser-controller",
        );
        const offered = await waitForAttachmentEvent(
          requester.transport,
          requester.lease.attachmentId,
          "control.offered",
        );
        const accepted = await requester.client.request({
          operation: "acceptControl",
          sessionId: requester.lease.sessionId,
          attachmentId: requester.lease.attachmentId,
          expectedRuntimeId: requester.lease.runtimeId,
          expectedControllerGeneration: offered.controllerGeneration,
          controlOfferId: offered.offer.controlOfferId,
          idempotencyKey: randomUUID(),
          terminal: { cols: 88, rows: 26 },
        });
        await requester.client.request({
          operation: "releaseControl",
          sessionId: requester.lease.sessionId,
          attachmentId: requester.lease.attachmentId,
          expectedControllerGeneration: accepted.control.controllerGeneration,
        });
        await vi.waitFor(() => {
          const latest = controllerFrames
            .filter(
              (frame): frame is Extract<ServerWsFrame, { type: "pane.control.state" }> =>
                frame.type === "pane.control.state",
            )
            .at(-1);
          expect(latest).toMatchObject({ role: "controller" });
          expect(latest?.controllerGeneration).toBeGreaterThan(
            accepted.control.controllerGeneration,
          );
        });
      } finally {
        await requester.client
          .request({
            operation: "closeAttachment",
            sessionId: requester.lease.sessionId,
            attachmentId: requester.lease.attachmentId,
          })
          .catch(() => undefined);
        await requester.transport.close();
      }

      await facade.preemptControl(pane.id, 72, 22, "browser-observer");
      await facade.setControlDesired(pane.id, false, 100, 30, "browser-controller");
      await facade.setControlDesired(pane.id, true, 72, 22, "browser-observer");
      expect(runtime.records[0]?.resizes.at(-1)).toEqual({ cols: 72, rows: 22 });
      await expect(
        facade.write(pane.id, "stale-controller", "browser-controller"),
      ).rejects.toMatchObject({ code: "LEASE_REQUIRED" });
      await facade.write(pane.id, "new-controller", "browser-observer");
      expect(runtime.records[0]?.writes.at(-1)).toBe("new-controller");

      await facade.releaseControl(pane.id, "browser-observer");
      await expect(
        facade.write(pane.id, "released-controller", "browser-observer"),
      ).rejects.toMatchObject({ code: "LEASE_REQUIRED" });
      await facade.preemptControl(pane.id, 74, 24, "browser-observer");
      await facade.write(pane.id, "preempted-again", "browser-observer");
      expect(runtime.records[0]?.writes.at(-1)).toBe("preempted-again");

      detachController();
      detachObserver();
    } finally {
      await facade.shutdown();
      repository.close();
    }
  });

  it("rotates expiring caller streams without reprojecting the browser attachment", async () => {
    const fixture = createHostFixture();
    const hostConfig = {
      ...fixture.config,
      profiles: fixture.config.profiles.map((profile) => ({
        ...profile,
        profileId: "shell",
      })),
    };
    const runtime = new FakeRuntimePort();
    const host = await startDurableSessionHost(hostConfig, {
      runtime,
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);

    const config = { ...clientConfig(fixture, ["shell"]), callerTtlMs: 1_000 };
    const stream = new UdsDurableSessionStreamPort(config);
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const project = repository.createProject(join(fixture.root, "projects", "sample"), "sample");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("Fixture terminal Pane is missing.");
    const facade = new DurableHostSessionFacade(
      repository,
      config,
      new UdsDurableSessionLifecycleClient(config),
      stream,
    );

    try {
      await facade.start(pane.id, 100, 30);
      const frames: ServerWsFrame[] = [];
      const detach = await facade.attach(
        pane.id,
        100,
        30,
        (frame) => frames.push(frame),
        undefined,
        undefined,
        { attachmentKey: "browser-controller", control: "controller" },
      );
      await waitForFrame(frames, "pane.snapshot");
      const controlFramesBeforeRotation = frames.filter(
        (frame) => frame.type === "pane.control.state",
      ).length;

      // The first caller is expired by this point, so a successful write proves that the scheduled
      // transport rotation resumed the same Host attachment with a fresh caller context.
      await new Promise<void>((resolve) => setTimeout(resolve, 1_250));

      const latestControl = frames
        .filter(
          (frame): frame is Extract<ServerWsFrame, { type: "pane.control.state" }> =>
            frame.type === "pane.control.state",
        )
        .at(-1);
      expect(latestControl).toMatchObject({ role: "controller" });
      await facade.write(pane.id, "after-caller-rotation", "browser-controller");
      expect(runtime.records[0]?.writes.at(-1)).toBe("after-caller-rotation");
      const runtimeId = runtime.records[0]?.request.runtimeId;
      if (runtimeId === undefined) throw new Error("Fixture Host runtime is missing.");
      runtime.data(runtimeId, "after-rotation-output");
      await waitForOutput(frames, "after-rotation-output");

      expect(frames.filter((frame) => frame.type === "pane.snapshot")).toHaveLength(1);
      expect(frames.filter((frame) => frame.type === "pane.control.state")).toHaveLength(
        controlFramesBeforeRotation,
      );
      detach();
    } finally {
      await facade.shutdown();
      repository.close();
    }
  });
});

function clientConfig(
  fixture: ReturnType<typeof createHostFixture>,
  profileIds = fixture.config.profiles.map((profile) => profile.profileId),
): DurableHostConfig {
  return {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds,
    roots: fixture.config.roots,
  };
}

async function openRequester(
  config: DurableHostConfig,
  sessionId: string,
): Promise<{
  transport: UdsWebSocketDurableSessionTransport;
  client: DurableSessionClient;
  lease: AttachmentLease;
}> {
  const callerContext: DurableSessionCallerContext = {
    appId: config.appId,
    subject: config.subject,
    capabilities: ["session:observe", "control:request"],
    sessionScope: { kind: "all" },
    profileScope: { kind: "all" },
    rootScope: { kind: "ids", ids: config.roots.map((root) => root.rootId) },
    expiresAtMs: Date.now() + config.callerTtlMs,
  };
  const transport = await UdsWebSocketDurableSessionTransport.connect({
    socketPath: config.socketPath,
    appId: config.appId,
    credential: readPrivateCredentialFile(config.credentialFile),
    callerContext,
    operationTimeoutMs: 35_000,
  });
  const client = new DurableSessionClient({ transport, callerContext });
  const opened = await client.request({
    operation: "openAttachment",
    sessionId,
    clientInstanceId: randomUUID(),
  });
  return { transport, client, lease: opened.attachment };
}

async function waitForAttachmentEvent<T extends DurableSessionEvent["type"]>(
  transport: UdsWebSocketDurableSessionTransport,
  attachmentId: string,
  type: T,
): Promise<Extract<DurableSessionEvent, { type: T }>> {
  for (;;) {
    const frame = await transport.nextAttachmentEvent();
    if (frame.attachmentId !== attachmentId || frame.event.type !== type) continue;
    return frame.event as Extract<DurableSessionEvent, { type: T }>;
  }
}

async function waitForFrame<T extends ServerWsFrame["type"]>(
  frames: ServerWsFrame[],
  type: T,
): Promise<Extract<ServerWsFrame, { type: T }>> {
  await vi.waitFor(() => {
    expect(frames.map((frame) => frame.type)).toContain(type);
  });
  const frame = frames.find(
    (candidate): candidate is Extract<ServerWsFrame, { type: T }> => candidate.type === type,
  );
  if (frame === undefined) throw new Error(`Expected ${type} frame.`);
  return frame;
}

async function waitForOutput(
  frames: ServerWsFrame[],
  data: string,
): Promise<Extract<ServerWsFrame, { type: "terminal.output" }>> {
  await vi.waitFor(() => {
    expect(frames.some((frame) => frame.type === "terminal.output" && frame.data === data)).toBe(
      true,
    );
  });
  const frame = frames.find(
    (candidate): candidate is Extract<ServerWsFrame, { type: "terminal.output" }> =>
      candidate.type === "terminal.output" && candidate.data === data,
  );
  if (frame === undefined) throw new Error("Expected terminal output frame.");
  return frame;
}
