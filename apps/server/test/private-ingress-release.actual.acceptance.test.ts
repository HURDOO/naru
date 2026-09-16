import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ServerWsFrameSchema, type ServerWsFrame } from "@naru/contracts";
import { describe, expect, it } from "vitest";
import WebSocket, { type RawData } from "ws";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import {
  startDurableSessionHost,
  type RunningDurableSessionHost,
} from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture } from "../../durable-session-host/test/support.js";
import { WorkstationGatewayConfigSchema } from "../../workstation-gateway/src/config.js";
import { WorkstationGateway } from "../../workstation-gateway/src/gateway.js";
import { gatewayVerifierKey, loadOrCreateGatewayKeys } from "../../workstation-gateway/src/keys.js";
import { createGatewayTestFixture } from "../../workstation-gateway/test/support.js";
import { buildApp } from "../src/app.js";
import type { GatewayManagedConfig } from "../src/config.js";
import { NaruRepository } from "../src/database.js";
import { DurableHostSessionFacade } from "../src/durable-session-facade.js";
import {
  type DurableHostConfig,
  UdsDurableSessionLifecycleClient,
} from "../src/durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "../src/durable-session-stream-port.js";
import { ProjectPathPolicy } from "../src/path-policy.js";

const actualDescribe = describe.skipIf(process.env.PRIVATE_INGRESS_ACTUAL_ACCEPTANCE !== "1");

interface RunningNaru {
  readonly app: Awaited<ReturnType<typeof buildApp>>;
  readonly repository: NaruRepository;
  readonly supervisor: DurableHostSessionFacade;
  readonly projectId: string;
  readonly paneId: string;
}

interface AttachedTerminal {
  readonly socket: WebSocket;
  readonly snapshot: Extract<ServerWsFrame, { type: "pane.snapshot" }>;
  readonly output: Extract<ServerWsFrame, { type: "terminal.output" }>;
}

actualDescribe("PI-06 isolated release continuity acceptance", () => {
  it("keeps one actual Host PTY across Gateway and Naru restarts through HTTP and WSS", async () => {
    expect(process.versions.node.split(".")[0]).toBe("24");
    const hostFixture = createHostFixture();
    const baseProfile = hostFixture.config.profiles[0];
    const resourcePolicy = hostFixture.config.resourcePolicies[0];
    const root = hostFixture.config.roots[0];
    if (baseProfile === undefined || resourcePolicy === undefined || root === undefined) {
      throw new Error("PI-06 Host fixture is incomplete.");
    }
    const genericTui = realpathSync(
      fileURLToPath(
        new URL("../../durable-session-host/test/fixtures/generic-tui.mjs", import.meta.url),
      ),
    );
    const nodeExecutable = realpathSync(process.execPath);
    const hostConfig = DurableSessionHostConfigSchema.parse({
      ...hostFixture.config,
      profiles: [
        {
          ...baseProfile,
          profileId: "shell",
          executable: nodeExecutable,
          args: [genericTui],
        },
      ],
      resourcePolicies: [
        {
          ...resourcePolicy,
          allowedExecutables: [nodeExecutable],
          stopTimeoutMs: 5_000,
        },
      ],
    });
    const durableConfig: DurableHostConfig = {
      owner: "durable-host",
      socketPath: hostConfig.socketPath,
      credentialFile: hostFixture.credentialFile,
      appId: "fixture-app",
      subject: "owner-fixture",
      callerTtlMs: 50_000,
      idempotencyTtlMs: hostConfig.idempotencyTtlMs,
      profileIds: ["shell"],
      roots: hostConfig.roots,
    };
    const projectPath = realpathSync(join(root.path, "sample"));
    const [naruPort, gatewayPort] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    const gatewayFixture = createGatewayTestFixture({
      listenPort: gatewayPort,
      appRegistrations: [
        {
          appId: "fixture-app",
          mode: "gateway-managed",
          routePrefix: "/",
          upstream: { kind: "loopback", origin: `http://127.0.0.1:${naruPort}` },
          includeCredentialRef: true,
          enabled: true,
        },
      ],
    });
    const gatewayConfig = WorkstationGatewayConfigSchema.parse(gatewayFixture.config);
    const gatewayKeys = loadOrCreateGatewayKeys(gatewayConfig.dataDirectory);
    const verifierKey = gatewayVerifierKey(gatewayKeys);
    const naruConfig: GatewayManagedConfig = {
      authMode: "gateway-managed",
      environment: "test",
      host: "127.0.0.1",
      port: naruPort,
      allowedOrigins: new Set([gatewayConfig.browserOrigin]),
      projectRoots: [root.path],
      dataDir: join(hostFixture.root, "pi06-naru-data"),
      secureCookie: false,
      appBasePath: "/",
      gatewayAuth: {
        issuer: gatewayConfig.instanceId,
        audience: "fixture-app",
        ownerSubject: gatewayConfig.ownerSubject,
        origin: gatewayConfig.browserOrigin,
        verifierKeysFile: join(gatewayFixture.root, "verifier-keys.json"),
        verifierKeys: new Map([[verifierKey.keyId, gatewayKeys.signingPublicKey]]),
      },
      sessionRuntime: durableConfig,
    };

    let host: RunningDurableSessionHost | null = null;
    let naru: RunningNaru | null = null;
    let gateway: WorkstationGateway | null = null;
    let terminal: AttachedTerminal | null = null;

    try {
      host = await startDurableSessionHost(hostConfig, {
        logger: silentHostLogger,
        hostEnvironment: {},
      });
      naru = await startNaru(naruConfig, durableConfig, projectPath);
      await naru.supervisor.start(naru.paneId, 100, 30);
      const initialLink = naru.repository.getPaneSessionLink(naru.paneId);
      if (initialLink?.sessionId === null || initialLink?.sessionId === undefined) {
        throw new Error("PI-06 terminal did not receive a Host Session.");
      }

      gateway = await startGateway(gatewayConfig);
      const session = seedGatewaySession(gateway);
      const browserHeaders = {
        host: new URL(gatewayConfig.browserOrigin).host,
        origin: gatewayConfig.browserOrigin,
        cookie: `${gatewayConfig.sessionCookieName}=${session.token}`,
      };
      await expectAuthenticatedHttp(gatewayPort, browserHeaders);
      terminal = await attachTerminal(gatewayPort, browserHeaders, naru.paneId);
      expect(terminal.output.data).toContain("heartbeat:");
      const runtimeId = terminal.snapshot.runtimeId;
      const firstSequence = terminal.output.sequence;

      const gatewaySocketClosed = waitForSocketClose(terminal.socket);
      await gateway.close();
      gateway = null;
      await gatewaySocketClosed;
      terminal = null;
      await delay(250);

      gateway = await startGateway(gatewayConfig);
      await expectAuthenticatedHttp(gatewayPort, browserHeaders);
      terminal = await attachTerminal(gatewayPort, browserHeaders, naru.paneId);
      expect(terminal.snapshot).toMatchObject({ runtimeId });
      expect(terminal.snapshot.sequence).toBeGreaterThan(firstSequence);
      const gatewayRestartSequence = terminal.output.sequence;

      const naruSocketClosed = waitForSocketClose(terminal.socket);
      const projectId = naru.projectId;
      const paneId = naru.paneId;
      await naru.app.close();
      naru = null;
      await naruSocketClosed;
      terminal = null;
      await delay(250);

      naru = await startNaru(naruConfig, durableConfig, projectPath, { projectId, paneId });
      const restartedLink = naru.repository.getPaneSessionLink(paneId);
      expect(restartedLink).toMatchObject({
        sessionId: initialLink.sessionId,
        state: "linked",
      });
      await expectAuthenticatedHttp(gatewayPort, browserHeaders);
      terminal = await attachTerminal(gatewayPort, browserHeaders, paneId);
      expect(terminal.snapshot).toMatchObject({ runtimeId });
      expect(terminal.snapshot.sequence).toBeGreaterThan(gatewayRestartSequence);
      expect(terminal.output.sequence).toBeGreaterThan(terminal.snapshot.sequence);
    } finally {
      terminal?.socket.terminate();
      await gateway?.close().catch(() => undefined);
      await naru?.app.close().catch(() => undefined);
      await host?.close().catch(() => undefined);
    }
  }, 45_000);
});

async function startNaru(
  config: GatewayManagedConfig,
  durableConfig: DurableHostConfig,
  projectPath: string,
  identity?: { readonly projectId: string; readonly paneId: string },
): Promise<RunningNaru> {
  const repository = NaruRepository.openDataDirectory(config.dataDir, {
    sessionOwner: "durable-host",
  });
  const supervisor = new DurableHostSessionFacade(
    repository,
    durableConfig,
    new UdsDurableSessionLifecycleClient(durableConfig),
    new UdsDurableSessionStreamPort(durableConfig),
  );
  let app: Awaited<ReturnType<typeof buildApp>> | undefined;
  try {
    await supervisor.reconcile();
    const project =
      identity === undefined
        ? repository.createProject(projectPath, "PI-06 isolated acceptance")
        : repository.getProject(identity.projectId);
    if (project === undefined) throw new Error("PI-06 Project did not survive Naru restart.");
    const pane = repository
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined || (identity !== undefined && pane.id !== identity.paneId)) {
      throw new Error("PI-06 terminal Pane did not survive Naru restart.");
    }
    app = await buildApp(config, {
      repository,
      pathPolicy: await ProjectPathPolicy.create(config.projectRoots),
      supervisor,
    });
    await app.listen({ host: config.host, port: config.port });
    return { app, repository, supervisor, projectId: project.id, paneId: pane.id };
  } catch (error) {
    if (app !== undefined) {
      await app.close().catch(() => undefined);
    } else {
      await supervisor.shutdown().catch(() => undefined);
      repository.close();
    }
    throw error;
  }
}

async function startGateway(
  config: ReturnType<typeof WorkstationGatewayConfigSchema.parse>,
): Promise<WorkstationGateway> {
  const gateway = await WorkstationGateway.create(config);
  try {
    await gateway.listen();
    return gateway;
  } catch (error) {
    await gateway.close();
    throw error;
  }
}

function seedGatewaySession(gateway: WorkstationGateway) {
  gateway.repository.createCredential({
    credentialRecordId: "pi06-credential-record",
    credentialId: "pi06-browser-credential",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: [],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: gateway.nowMs(),
  });
  return gateway.sessions.create({
    subject: gateway.config.ownerSubject,
    credentialRecordId: "pi06-credential-record",
    credentialId: "pi06-browser-credential",
    authTime: Math.floor(gateway.nowMs() / 1_000),
  });
}

async function expectAuthenticatedHttp(
  port: number,
  headers: Record<string, string>,
): Promise<void> {
  const response = await requestGateway(port, "/api/session", headers);
  expect(response.statusCode).toBe(200);
  expect(JSON.parse(response.body)).toMatchObject({
    authenticated: true,
    authMode: "gateway-managed",
  });
}

async function attachTerminal(
  port: number,
  headers: Record<string, string>,
  paneId: string,
): Promise<AttachedTerminal> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/api/terminal`, { headers });
  const frames: ServerWsFrame[] = [];
  socket.on("message", (data) => {
    frames.push(ServerWsFrameSchema.parse(JSON.parse(rawDataText(data)) as unknown));
  });
  await waitForSocketOpen(socket);
  socket.send(JSON.stringify({ type: "lease.acquire", clientId: randomUUID() }));
  const granted = await waitForFrame(
    frames,
    (frame): frame is Extract<ServerWsFrame, { type: "lease.granted" }> =>
      frame.type === "lease.granted",
  );
  socket.send(
    JSON.stringify({
      type: "pane.attach",
      paneId,
      leaseGeneration: granted.generation,
      cols: 100,
      rows: 30,
    }),
  );
  const snapshot = await waitForFrame(
    frames,
    (frame): frame is Extract<ServerWsFrame, { type: "pane.snapshot" }> =>
      frame.type === "pane.snapshot" && frame.paneId === paneId,
  );
  const output = await waitForFrame(
    frames,
    (frame): frame is Extract<ServerWsFrame, { type: "terminal.output" }> =>
      frame.type === "terminal.output" &&
      frame.paneId === paneId &&
      frame.sequence > snapshot.sequence &&
      frame.data.includes("heartbeat:"),
  );
  return { socket, snapshot, output };
}

async function waitForFrame<T extends ServerWsFrame>(
  frames: readonly ServerWsFrame[],
  predicate: (frame: ServerWsFrame) => frame is T,
): Promise<T> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const frame = frames.find(predicate);
    if (frame !== undefined) return frame;
    await delay(10);
  }
  throw new Error("PI-06 WebSocket frame timed out.");
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    socket.once("open", resolvePromise);
    socket.once("error", reject);
  });
}

function waitForSocketClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return Promise.race([
    once(socket, "close").then(() => undefined),
    delay(5_000).then(() => {
      throw new Error("PI-06 WebSocket did not close during service restart.");
    }),
  ]);
}

function requestGateway(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      { hostname: "127.0.0.1", port, path, method: "GET", headers },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("error", reject);
        response.once("end", () =>
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function reserveLoopbackPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("PI-06 loopback port allocation failed.");
  }
  await new Promise<void>((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
  return address.port;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}
