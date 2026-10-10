import {
  createServer,
  get as httpGet,
  request as httpRequest,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import { mkdirSync, realpathSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { InMemoryGatewayReplayStore, verifyGatewayAssertion } from "@naru/gateway-verifier";
import { WORKSTATION_GATEWAY_CSRF_HEADER } from "@naru/contracts/workstation-gateway/v1";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp as buildNaruApp } from "../../server/src/app.js";
import type { GatewayManagedConfig } from "../../server/src/config.js";
import { NaruRepository } from "../../server/src/database.js";
import { ProjectPathPolicy } from "../../server/src/path-policy.js";
import type { NaruSessionFacade } from "../../server/src/session-facade.js";
import { WorkstationGatewayConfigSchema } from "../src/config.js";
import { WorkstationGateway } from "../src/gateway.js";
import { gatewayVerifierKey, loadOrCreateGatewayKeys } from "../src/keys.js";
import type { GatewayLogRecord } from "../src/logging.js";
import { normalizeWebSocketCloseCode } from "../src/proxy.js";
import { createGatewayTestFixture } from "./support.js";

interface UpstreamFixture {
  server: Server;
  readonly webSockets: WebSocketServer;
  readonly webSocketPaths: string[];
  origin: string;
  readonly assertions: string[];
  requests: number;
  cookieName: string;
}

const running: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const resource of running.splice(0).reverse()) await resource.close();
});

describe("Workstation Gateway HTTP and WebSocket proxy", () => {
  it("maps abnormal and reserved peer close codes to a valid proxy failure", () => {
    for (const code of [0, 1_004, 1_005, 1_006, 1_015, 5_000]) {
      expect(normalizeWebSocketCloseCode(code), String(code)).toBe(1_011);
    }
    for (const code of [1_000, 1_001, 1_009, 3_000, 4_999]) {
      expect(normalizeWebSocketCloseCode(code), String(code)).toBe(code);
    }
  });

  it("strips browser identity material, injects a verifier-compatible assertion, and enforces Origin/CSRF", async () => {
    const upstream = await createUpstreamFixture();
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "fixture-app",
          mode: "gateway-managed",
          routePrefix: "/app",
          upstream: { kind: "loopback", origin: upstream.origin },
        },
        {
          appId: "standalone-fixture",
          mode: "app-managed",
          origin: "https://standalone.fixture.invalid",
        },
      ],
    });
    upstream.cookieName = config.sessionCookieName;
    const logs: GatewayLogRecord[] = [];
    const gateway = await WorkstationGateway.create(config, {
      logger: { write: (record) => logs.push(record) },
    });
    running.push({ close: () => gateway.close() });
    expect(await getText(`${upstream.origin}/health`)).toBe("upstream-ok");
    const session = seedSession(gateway);
    const host = new URL(config.browserOrigin).host;
    await gateway.browser.listen({ host: "127.0.0.1", port: 0 });
    const gatewayPort = (gateway.browser.server.address() as AddressInfo).port;

    const unauthenticated = await timed(
      "unauthenticated inject",
      gateway.browser.inject({
        method: "GET",
        url: "/app/inspect",
        headers: { host, origin: config.browserOrigin },
      }),
    );
    expect(unauthenticated.statusCode).toBe(401);

    const wrongOrigin = await timed(
      "wrong-origin inject",
      gateway.browser.inject({
        method: "GET",
        url: "/app/inspect",
        headers: {
          host,
          origin: "https://wrong.invalid",
          cookie: `${config.sessionCookieName}=${session.token}`,
        },
      }),
    );
    expect(wrongOrigin.statusCode).toBe(403);

    const invalidCsrf = await timed(
      "invalid-csrf inject",
      gateway.browser.inject({
        method: "POST",
        url: "/app/inspect",
        headers: {
          host,
          origin: config.browserOrigin,
          cookie: `${config.sessionCookieName}=${session.token}`,
          "content-type": "application/octet-stream",
          [WORKSTATION_GATEWAY_CSRF_HEADER]: "wrong",
        },
        payload: Buffer.from("fixture-body"),
      }),
    );
    expect(invalidCsrf.statusCode).toBe(403);

    let response;
    try {
      response = await timed(
        "valid proxy request",
        requestGateway(gatewayPort, {
          method: "POST",
          path: "/app/inspect?mode=fixture",
          headers: {
            host,
            origin: config.browserOrigin,
            cookie: `${config.sessionCookieName}=${session.token}; app_preference=dark`,
            authorization: "Bearer externally-injected",
            "content-type": "application/octet-stream",
            connection: "x-client-hop",
            "x-auth-request-email": "owner@externally.injected",
            "x-client-hop": "externally-injected",
            [WORKSTATION_GATEWAY_CSRF_HEADER]: session.csrfToken,
            "x-csrf-token": "fixture-app-csrf",
            "x-workstation-gateway-assertion": "externally-injected",
            "x-durable-session-capability": "externally-injected",
            "x-forwarded-user": "externally-injected",
          },
          body: Buffer.from("fixture-body"),
        }),
      );
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : "proxy timeout"}; origin=${upstream.origin}; configured=${config.appRegistrations[0]?.mode === "gateway-managed" && config.appRegistrations[0].upstream.kind === "loopback" ? config.appRegistrations[0].upstream.origin : "not-loopback"}; upstream requests=${upstream.requests}; assertions=${upstream.assertions.length}; logs=${JSON.stringify(logs)}`,
        { cause: error },
      );
    }
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      method: "POST",
      url: "/inspect?mode=fixture",
      body: "fixture-body",
      cookie: "app_preference=dark",
      authorization: null,
      authRequestEmail: null,
      durableCapability: null,
      forwardedUser: null,
      clientHop: null,
      csrfToken: "fixture-app-csrf",
      gatewayCsrfToken: null,
    });
    expect(response.headers["x-upstream-hop"]).toBeUndefined();
    const setCookie = response.headers["set-cookie"];
    expect(JSON.stringify(setCookie)).toContain("fixture_app=allowed");
    expect(JSON.stringify(setCookie)).not.toContain(
      `${config.sessionCookieName}=upstream-override`,
    );
    expect(upstream.assertions).toHaveLength(1);
    expect(upstream.assertions[0]).not.toBe("externally-injected");
    const assertion = upstream.assertions[0];
    if (assertion === undefined) throw new Error("Fixture assertion is missing.");
    expect(
      verifyFixtureAssertion(gateway, assertion, new InMemoryGatewayReplayStore()),
    ).toMatchObject({
      iss: config.instanceId,
      aud: "fixture-app",
      origin: config.browserOrigin,
    });
    expect(JSON.stringify(response.json())).not.toContain(session.token);

    const noReset = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/reset",
      headers: { host, origin: config.browserOrigin, "content-type": "application/json" },
      payload: {},
    });
    expect(noReset.statusCode).toBe(404);
    const appManagedNotProxied = await gateway.browser.inject({
      method: "GET",
      url: "/standalone",
      headers: {
        host,
        origin: config.browserOrigin,
        cookie: `${config.sessionCookieName}=${session.token}`,
      },
    });
    expect(appManagedNotProxied.statusCode).toBe(404);
  });

  it("isolates HTTP and WebSocket routes and assertion audiences across managed apps", async () => {
    const alpha = await createUpstreamFixture();
    const beta = await createUpstreamFixture();
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "alpha-app",
          mode: "gateway-managed",
          routePrefix: "/alpha",
          upstream: { kind: "loopback", origin: alpha.origin },
        },
        {
          appId: "beta-app",
          mode: "gateway-managed",
          routePrefix: "/beta",
          upstream: { kind: "loopback", origin: beta.origin },
        },
      ],
    });
    alpha.cookieName = config.sessionCookieName;
    beta.cookieName = config.sessionCookieName;
    const gateway = await WorkstationGateway.create(config);
    running.push({ close: () => gateway.close() });
    const session = seedSession(gateway);
    const host = new URL(config.browserOrigin).host;
    const headers = {
      host,
      origin: config.browserOrigin,
      cookie: `${config.sessionCookieName}=${session.token}`,
    };
    await gateway.browser.listen({ host: "127.0.0.1", port: 0 });
    const gatewayPort = (gateway.browser.server.address() as AddressInfo).port;

    const alphaHttp = await requestGateway(gatewayPort, {
      method: "GET",
      path: "/alpha/inspect?target=alpha",
      headers,
    });
    const betaHttp = await requestGateway(gatewayPort, {
      method: "GET",
      path: "/beta/inspect?target=beta",
      headers,
    });
    expect(alphaHttp.statusCode).toBe(200);
    expect(alphaHttp.json()).toMatchObject({ url: "/inspect?target=alpha" });
    expect(betaHttp.statusCode).toBe(200);
    expect(betaHttp.json()).toMatchObject({ url: "/inspect?target=beta" });
    expect(alpha.assertions).toHaveLength(1);
    expect(beta.assertions).toHaveLength(1);
    expect(
      verifyFixtureAssertion(
        gateway,
        requiredAssertion(alpha.assertions[0]),
        new InMemoryGatewayReplayStore(),
        "alpha-app",
      ),
    ).toMatchObject({ aud: "alpha-app" });
    expect(
      verifyFixtureAssertion(
        gateway,
        requiredAssertion(beta.assertions[0]),
        new InMemoryGatewayReplayStore(),
        "beta-app",
      ),
    ).toMatchObject({ aud: "beta-app" });

    const alphaSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/alpha/socket?target=alpha`, {
      headers,
    });
    const betaSocket = new WebSocket(`ws://127.0.0.1:${gatewayPort}/beta/socket?target=beta`, {
      headers,
    });
    await Promise.all([once(alphaSocket, "open"), once(betaSocket, "open")]);
    alphaSocket.send("alpha-only");
    betaSocket.send("beta-only");
    const [[alphaMessage], [betaMessage]] = (await Promise.all([
      once(alphaSocket, "message"),
      once(betaSocket, "message"),
    ])) as [[Buffer], [Buffer]];
    expect(alphaMessage.toString()).toBe("echo:alpha-only");
    expect(betaMessage.toString()).toBe("echo:beta-only");
    expect(alpha.webSocketPaths).toEqual(["/socket?target=alpha"]);
    expect(beta.webSocketPaths).toEqual(["/socket?target=beta"]);
    expect(
      verifyFixtureAssertion(
        gateway,
        requiredAssertion(alpha.assertions[1]),
        new InMemoryGatewayReplayStore(),
        "alpha-app",
      ),
    ).toMatchObject({ aud: "alpha-app" });
    expect(
      verifyFixtureAssertion(
        gateway,
        requiredAssertion(beta.assertions[1]),
        new InMemoryGatewayReplayStore(),
        "beta-app",
      ),
    ).toMatchObject({ aud: "beta-app" });

    const unmatchedHttp = await requestGateway(gatewayPort, {
      method: "GET",
      path: "/alpha-other/inspect",
      headers,
    });
    expect(unmatchedHttp.statusCode).toBe(404);
    await expectWebSocketUpgradeStatus(
      `ws://127.0.0.1:${gatewayPort}/beta-other/socket`,
      headers,
      404,
    );
    expect(alpha.requests).toBe(1);
    expect(beta.requests).toBe(1);

    const alphaClosed = once(alphaSocket, "close");
    const betaClosed = once(betaSocket, "close");
    alphaSocket.close();
    betaSocket.close();
    await Promise.all([alphaClosed, betaClosed]);
  });

  it("pins WebSocket identity at upgrade and closes the socket on logout without stopping the app", async () => {
    const upstream = await createUpstreamFixture();
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "fixture-app",
          mode: "gateway-managed",
          routePrefix: "/app",
          upstream: { kind: "loopback", origin: upstream.origin },
        },
      ],
    });
    upstream.cookieName = config.sessionCookieName;
    const gateway = await WorkstationGateway.create(config);
    running.push({ close: () => gateway.close() });
    const session = seedSession(gateway);
    await gateway.browser.listen({ host: "127.0.0.1", port: 0 });
    const address = gateway.browser.server.address() as AddressInfo;
    const socketUrl = `ws://127.0.0.1:${address.port}/app/socket`;
    await expectWebSocketUpgradeStatus(
      socketUrl,
      {
        host: new URL(config.browserOrigin).host,
        origin: config.browserOrigin,
      },
      401,
    );
    const client = new WebSocket(socketUrl, {
      headers: {
        host: new URL(config.browserOrigin).host,
        origin: config.browserOrigin,
        cookie: `${config.sessionCookieName}=${session.token}; app_preference=dark`,
        authorization: "Bearer externally-injected",
        "x-workstation-gateway-assertion": "externally-injected",
      },
    });
    await once(client, "open");
    client.send("hello-through-gateway");
    const [message] = (await once(client, "message")) as [Buffer];
    expect(message.toString()).toBe("echo:hello-through-gateway");
    expect(gateway.sockets.size).toBe(1);
    expect(upstream.assertions).toHaveLength(1);
    const assertion = upstream.assertions[0];
    if (assertion === undefined) throw new Error("Fixture assertion is missing.");
    expect(
      verifyFixtureAssertion(gateway, assertion, new InMemoryGatewayReplayStore()),
    ).toMatchObject({ aud: "fixture-app", sub: config.ownerSubject });

    const closeEvent = once(client, "close");
    const logout = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/logout",
      headers: {
        host: new URL(config.browserOrigin).host,
        origin: config.browserOrigin,
        cookie: `${config.sessionCookieName}=${session.token}`,
        "content-type": "application/json",
        [WORKSTATION_GATEWAY_CSRF_HEADER]: session.csrfToken,
      },
      payload: {},
    });
    expect(logout.statusCode).toBe(204);
    const [code] = (await closeEvent) as [number];
    expect(code).toBe(4003);
    expect(gateway.sockets.size).toBe(0);

    await gateway.close();
    const healthBody = await getText(`${upstream.origin}/health`);
    expect(healthBody).toBe("upstream-ok");
  });

  it("cuts Naru over to one Gateway session for HTTP and WebSocket and revokes the proxied socket", async () => {
    const fixture = createGatewayTestFixture();
    const projectRoot = join(fixture.root, "naru-projects");
    mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
    const canonicalProjectRoot = realpathSync(projectRoot);
    const keys = loadOrCreateGatewayKeys(fixture.config.dataDirectory);
    const verifierKey = gatewayVerifierKey(keys);
    const naruConfig: GatewayManagedConfig = {
      authMode: "gateway-managed",
      environment: "test",
      host: "127.0.0.1",
      port: 4174,
      allowedOrigins: new Set([fixture.config.browserOrigin]),
      projectRoots: [canonicalProjectRoot],
      dataDir: join(fixture.root, "naru-data"),
      secureCookie: false,
      appBasePath: "/naru",
      gatewayAuth: {
        issuer: fixture.config.instanceId,
        audience: "naru",
        ownerSubject: fixture.config.ownerSubject,
        origin: fixture.config.browserOrigin,
        verifierKeysFile: join(fixture.root, "verifier-keys.json"),
        verifierKeys: new Map([[verifierKey.keyId, keys.signingPublicKey]]),
      },
      sessionRuntime: {
        owner: "durable-host",
        socketPath: join(fixture.root, "host.sock"),
        credentialFile: join(fixture.root, "host.credential"),
        appId: "naru",
        subject: fixture.config.ownerSubject,
        callerTtlMs: 60_000,
        idempotencyTtlMs: 600_000,
        profileIds: ["shell", "codex-main", "codex-quick"],
        roots: [{ rootId: "projects", path: canonicalProjectRoot }],
      },
    };
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    const naru = await buildNaruApp(naruConfig, {
      repository,
      pathPolicy: await ProjectPathPolicy.create([canonicalProjectRoot]),
      supervisor: new GatewayNaruSessionFacade(),
    });
    await naru.listen({ host: "127.0.0.1", port: 0 });
    const naruAddress = naru.server.address() as AddressInfo;
    const naruOrigin = `http://127.0.0.1:${naruAddress.port}`;
    running.push({
      close: async () => {
        await naru.close();
        repository.close();
      },
    });

    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "naru",
          mode: "gateway-managed",
          routePrefix: "/naru",
          upstream: { kind: "loopback", origin: naruOrigin },
        },
      ],
    });
    const gateway = await WorkstationGateway.create(config);
    running.push({ close: () => gateway.close() });
    const session = seedSession(gateway);
    await gateway.browser.listen({ host: "127.0.0.1", port: 0 });
    const gatewayPort = (gateway.browser.server.address() as AddressInfo).port;
    const browserHeaders = {
      host: new URL(config.browserOrigin).host,
      origin: config.browserOrigin,
      cookie: `${config.sessionCookieName}=${session.token}`,
    };

    const restored = await requestGateway(gatewayPort, {
      method: "GET",
      path: "/naru/api/session",
      headers: browserHeaders,
    });
    expect(restored.statusCode).toBe(200);
    expect(restored.json()).toMatchObject({ authenticated: true, authMode: "gateway-managed" });
    expect(restored.headers["set-cookie"]).toBeUndefined();

    const mutated = await requestGateway(gatewayPort, {
      method: "POST",
      path: "/naru/api/project-groups/refresh",
      headers: {
        ...browserHeaders,
        "content-type": "application/json",
        [WORKSTATION_GATEWAY_CSRF_HEADER]: session.csrfToken,
        "x-csrf-token": "independent-app-input",
      },
      body: Buffer.from("{}"),
    });
    expect(mutated.statusCode).toBe(200);
    expect(mutated.json()).toEqual([]);

    const noLegacyFallback = await requestGateway(gatewayPort, {
      method: "POST",
      path: "/naru/api/auth/login",
      headers: {
        ...browserHeaders,
        "content-type": "application/json",
        [WORKSTATION_GATEWAY_CSRF_HEADER]: session.csrfToken,
      },
      body: Buffer.from(JSON.stringify({ password: "must-not-exist" })),
    });
    expect(noLegacyFallback.statusCode).toBe(404);

    const client = new WebSocket(`ws://127.0.0.1:${gatewayPort}/naru/api/terminal`, {
      headers: browserHeaders,
    });
    await once(client, "open");
    client.send(
      JSON.stringify({
        type: "lease.acquire",
        clientId: "11111111-1111-4111-8111-111111111111",
      }),
    );
    const [grantedBytes] = (await once(client, "message")) as [Buffer];
    expect(JSON.parse(grantedBytes.toString())).toMatchObject({
      type: "lease.granted",
      generation: 1,
    });

    const closeEvent = once(client, "close");
    const logout = await requestGateway(gatewayPort, {
      method: "POST",
      path: "/_gateway/logout",
      headers: {
        ...browserHeaders,
        "content-type": "application/json",
        [WORKSTATION_GATEWAY_CSRF_HEADER]: session.csrfToken,
      },
      body: Buffer.from("{}"),
    });
    expect(logout.statusCode).toBe(204);
    const [closeCode] = (await closeEvent) as [number];
    expect(closeCode).toBe(4003);
    expect(await getText(`${naruOrigin}/healthz`)).toBe('{"status":"ok"}');
  });
});

function seedSession(gateway: WorkstationGateway) {
  gateway.repository.createCredential({
    credentialRecordId: "credential-record-fixture",
    credentialId: "raw-browser-credential-fixture",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: [],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: gateway.nowMs(),
  });
  return gateway.sessions.create({
    subject: gateway.config.ownerSubject,
    credentialRecordId: "credential-record-fixture",
    credentialId: "raw-browser-credential-fixture",
    authTime: Math.floor(gateway.nowMs() / 1_000),
  });
}

class GatewayNaruSessionFacade implements NaruSessionFacade {
  readiness(): boolean {
    return true;
  }
  count(): number {
    return 0;
  }
  isRunning(): boolean {
    return false;
  }
  onActivity(): () => void {
    return () => undefined;
  }
  onCodexIdentity(): () => void {
    return () => undefined;
  }
  acknowledgeCompleted(): void {}
  start(): void {}
  attach(): Promise<() => void> {
    return Promise.resolve(() => undefined);
  }
  write(): void {}
  resize(): void {}
  updateViewport(): void {}
  setControlDesired(): void {}
  preemptControl(): void {}
  approveControl(): void {}
  rejectControl(): void {}
  releaseControl(): void {}
  restart(): void {}
  startNewCodex(): void {}
  startNewClaude(): void {}
  stop(): void {}
  remove(): void {}
  async shutdown(): Promise<void> {}
}

async function createUpstreamFixture(): Promise<UpstreamFixture> {
  const assertions: string[] = [];
  const fixture: UpstreamFixture = {
    server: undefined as never,
    webSockets: new WebSocketServer({ noServer: true }),
    webSocketPaths: [],
    origin: "",
    assertions,
    requests: 0,
    cookieName: "unset",
  };
  const server = createServer((request, response) => {
    void handleUpstreamRequest(fixture, assertions, request, response).catch(() => {
      if (!response.headersSent) response.statusCode = 500;
      response.end();
    });
  });
  fixture.server = server;
  server.on("upgrade", (request, socket, head) => {
    fixture.webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      fixture.webSockets.emit("connection", webSocket, request);
    });
  });
  fixture.webSockets.on("connection", (socket, request) => {
    fixture.webSocketPaths.push(request.url ?? "");
    const assertion = singleHeader(request.headers["x-workstation-gateway-assertion"]);
    if (assertion === undefined) {
      socket.close(4003, "missing identity");
      return;
    }
    assertions.push(assertion);
    socket.on("message", (data) => socket.send(`echo:${rawDataText(data)}`));
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  const address = server.address() as AddressInfo;
  Object.assign(fixture, { origin: `http://127.0.0.1:${address.port}` });
  running.push({
    close: async () => {
      fixture.webSockets.close();
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    },
  });
  return fixture;
}

async function handleUpstreamRequest(
  fixture: UpstreamFixture,
  assertions: string[],
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  fixture.requests += 1;
  if (request.url === "/health") {
    response.end("upstream-ok");
    return;
  }
  const body = await readBody(request);
  const assertion = singleHeader(request.headers["x-workstation-gateway-assertion"]);
  if (assertion === undefined) {
    response.statusCode = 401;
    response.end("missing assertion");
    return;
  }
  assertions.push(assertion);
  response.setHeader("content-type", "application/json");
  response.setHeader("connection", "x-upstream-hop");
  response.setHeader("x-upstream-hop", "must-not-cross");
  response.setHeader("set-cookie", [
    "fixture_app=allowed; Secure; SameSite=Strict",
    `${fixture.cookieName}=upstream-override; Secure; HttpOnly; Path=/`,
  ]);
  response.end(
    JSON.stringify({
      method: request.method,
      url: request.url,
      body,
      cookie: request.headers.cookie ?? null,
      authorization: request.headers.authorization ?? null,
      authRequestEmail: request.headers["x-auth-request-email"] ?? null,
      durableCapability: request.headers["x-durable-session-capability"] ?? null,
      forwardedUser: request.headers["x-forwarded-user"] ?? null,
      clientHop: request.headers["x-client-hop"] ?? null,
      csrfToken: request.headers["x-csrf-token"] ?? null,
      gatewayCsrfToken: request.headers[WORKSTATION_GATEWAY_CSRF_HEADER] ?? null,
    }),
  );
}

function verifyFixtureAssertion(
  gateway: WorkstationGateway,
  assertion: string,
  replay: InMemoryGatewayReplayStore,
  expectedAudience = "fixture-app",
) {
  const key = gatewayVerifierKey(gateway.keys);
  return verifyGatewayAssertion(assertion, {
    expectedIssuer: gateway.config.instanceId,
    expectedAudience,
    expectedOrigin: gateway.config.browserOrigin,
    resolveKey: (keyId) => (keyId === key.keyId ? key.publicKeyPem : undefined),
    replayStore: replay,
    now: () => Math.floor(gateway.nowMs() / 1_000),
  }).principal;
}

function requiredAssertion(assertion: string | undefined): string {
  if (assertion === undefined) throw new Error("Fixture assertion is missing.");
  return assertion;
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks).toString("utf8");
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

async function getText(url: string): Promise<string> {
  return new Promise<string>((resolvePromise, reject) => {
    httpGet(url, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.once("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    }).once("error", reject);
  });
}

interface GatewayHttpResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  json(): unknown;
}

async function requestGateway(
  port: number,
  input: {
    method: string;
    path: string;
    headers: Record<string, string>;
    body?: Buffer;
  },
): Promise<GatewayHttpResponse> {
  return new Promise<GatewayHttpResponse>((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
        headers: {
          ...input.headers,
          ...(input.body === undefined ? {} : { "content-length": String(input.body.byteLength) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body,
            json: () => JSON.parse(body) as unknown,
          });
        });
      },
    );
    request.once("error", reject);
    if (input.body === undefined) request.end();
    else request.end(input.body);
  });
}

async function timed<T>(label: string, promise: Promise<T>): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out`)), 1_000);
      timer.unref();
    }),
  ]);
}

async function expectWebSocketUpgradeStatus(
  url: string,
  headers: Record<string, string>,
  expectedStatus: number,
): Promise<void> {
  const client = new WebSocket(url, { headers });
  await new Promise<void>((resolvePromise, reject) => {
    client.once("error", reject);
    client.once("unexpected-response", (_request, response) => {
      expect(response.statusCode).toBe(expectedStatus);
      response.resume();
      response.once("end", resolvePromise);
    });
  });
}
