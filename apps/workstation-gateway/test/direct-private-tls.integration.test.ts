import { once } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import { request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { InjectOptions } from "fastify";
import WebSocket, { type RawData, WebSocketServer } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { createTestTlsState } from "../../server/test/tls-fixture.js";
import { GATEWAY_BROWSER_LIMITS } from "../src/browser-security.js";
import { WorkstationGateway } from "../src/gateway.js";
import type { GatewayLogRecord } from "../src/logging.js";
import { createDirectGatewayTestFixture } from "./support.js";

const running: { close: () => Promise<void> }[] = [];

afterEach(async () => {
  for (const resource of running.splice(0).reverse()) await resource.close();
});

describe("Gateway direct private TLS transport", () => {
  it("serves authenticated HTTPS and WSS while proxying only to exact IPv4 loopback", async () => {
    const upstream = await createEchoUpstream();
    running.push(upstream);
    const tls = createTestTlsState("gateway.fixture.invalid");
    const generation = tls.createGeneration("direct-a");
    const fixture = createDirectGatewayTestFixture({
      tls: {
        approvedRoot: generation.directory,
        certificateFile: generation.certificateFile,
        privateKeyFile: generation.privateKeyFile,
        reload: "watch-last-known-good",
        materialOwner: "user",
        renewalOwner: "external",
        terminationOwner: "gateway",
      },
      appRegistrations: [
        {
          appId: "fixture-app",
          mode: "gateway-managed",
          routePrefix: "/app",
          upstream: { kind: "loopback", origin: upstream.origin },
          includeCredentialRef: true,
          enabled: true,
        },
      ],
    });
    const logs: GatewayLogRecord[] = [];
    const gateway = await WorkstationGateway.create(fixture.config, {
      logger: { write: (record) => logs.push(record) },
      browserListener: {
        directTlsBootstrap: {
          loadInitial: (ingress) => ({
            key: readFileSync(ingress.tls.privateKeyFile),
            cert: readFileSync(ingress.tls.certificateFile),
          }),
        },
      },
    });
    running.push({ close: () => gateway.close() });
    const session = seedSession(gateway);
    await gateway.browser.listen({ host: "127.0.0.1", port: 0 });
    const gatewayPort = (gateway.browser.server.address() as AddressInfo).port;

    const health = await secureRequest(gatewayPort, fixture.config.browserOrigin);
    expect(health.statusCode).toBe(200);
    expect(health.body).toBe('{"version":1,"status":"ok"}');
    await expect(cleartextRequest(gatewayPort)).rejects.toThrow();

    await expectWebSocketUpgradeStatus(
      `wss://127.0.0.1:${gatewayPort}/app/socket`,
      {
        host: new URL(fixture.config.browserOrigin).host,
        origin: fixture.config.browserOrigin,
      },
      401,
    );
    await expectWebSocketUpgradeStatus(
      `wss://127.0.0.1:${gatewayPort}/app/socket`,
      {
        host: new URL(fixture.config.browserOrigin).host,
        origin: fixture.config.browserOrigin,
        cookie: `${fixture.config.sessionCookieName}=${session.token}`,
        "x-workstation-gateway-assertion": "externally-injected",
      },
      400,
    );

    const client = new WebSocket(`wss://127.0.0.1:${gatewayPort}/app/socket`, {
      rejectUnauthorized: false,
      headers: {
        host: new URL(fixture.config.browserOrigin).host,
        origin: fixture.config.browserOrigin,
        cookie: `${fixture.config.sessionCookieName}=${session.token}`,
      },
    });
    await once(client, "open");
    client.send("direct-private-wss");
    const [message] = (await once(client, "message")) as [Buffer];
    expect(message.toString()).toBe("echo:direct-private-wss");
    const closed = once(client, "close");
    client.close(1000, "fixture complete");
    await closed;

    const serializedLogs = JSON.stringify(logs);
    expect(serializedLogs).not.toContain(generation.directory);
    expect(serializedLogs).not.toContain(fixture.config.browserIngress.listener.host);
    expect(serializedLogs).not.toContain(fixture.config.browserOrigin);
  });

  it("rejects wrong request authority, spoofed identity headers, and bounded inputs before auth", async () => {
    const tls = createTestTlsState("gateway.fixture.invalid");
    const generation = tls.createGeneration("direct-request-boundary");
    const fixture = createDirectGatewayTestFixture({
      tls: {
        approvedRoot: generation.directory,
        certificateFile: generation.certificateFile,
        privateKeyFile: generation.privateKeyFile,
        reload: "watch-last-known-good",
        materialOwner: "user",
        renewalOwner: "external",
        terminationOwner: "gateway",
      },
    });
    const logs: GatewayLogRecord[] = [];
    const gateway = await WorkstationGateway.create(fixture.config, {
      logger: { write: (record) => logs.push(record) },
      browserListener: {
        directTlsBootstrap: {
          loadInitial: (ingress) => ({
            key: readFileSync(ingress.tls.privateKeyFile),
            cert: readFileSync(ingress.tls.certificateFile),
          }),
        },
      },
    });
    running.push({ close: () => gateway.close() });
    const host = new URL(fixture.config.browserOrigin).host;
    const inject = (input: InjectOptions) =>
      gateway.browser.inject({ ...input, remoteAddress: "10.44.0.10" });

    expect(gateway.browser.initialConfig).toMatchObject({
      requestTimeout: GATEWAY_BROWSER_LIMITS.requestTimeoutMs,
      keepAliveTimeout: GATEWAY_BROWSER_LIMITS.keepAliveTimeoutMs,
      maxRequestsPerSocket: GATEWAY_BROWSER_LIMITS.requestsPerSocket,
    });
    expect(gateway.browser.server.headersTimeout).toBe(GATEWAY_BROWSER_LIMITS.headersTimeoutMs);

    const wrongHost = await inject({
      method: "GET",
      url: "/_gateway/healthz",
      headers: { host: "wrong.fixture.invalid" },
    });
    expect(wrongHost.statusCode).toBe(403);

    const wrongOrigin = await inject({
      method: "GET",
      url: "/_gateway/healthz",
      headers: { host, origin: "https://wrong.fixture.invalid" },
    });
    expect(wrongOrigin.statusCode).toBe(403);

    for (const [name, value] of [
      ["forwarded", "for=203.0.113.9"],
      ["x-forwarded-for", "203.0.113.9"],
      ["x-workstation-gateway-assertion", "externally-injected"],
      ["x-durable-session-capability", "externally-injected"],
    ] as const) {
      const denied = await inject({
        method: "GET",
        url: "/app/private",
        headers: { host, [name]: value },
      });
      expect(denied.statusCode, name).toBe(400);
      expect(denied.json()).toMatchObject({ error: { code: "REQUEST_INVALID" } });
    }

    const allowedCsrfHeader = await inject({
      method: "GET",
      url: "/app/private",
      headers: { host, "x-workstation-gateway-csrf": "browser-input" },
    });
    expect(allowedCsrfHeader.statusCode).toBe(401);

    const manyHeaders: Record<string, string> = { host };
    for (let index = 0; index < GATEWAY_BROWSER_LIMITS.headerCount; index += 1) {
      manyHeaders[`x-fixture-${index}`] = "value";
    }
    const tooManyHeaders = await inject({
      method: "GET",
      url: "/_gateway/healthz",
      headers: manyHeaders,
    });
    expect(tooManyHeaders.statusCode).toBe(431);

    const oversizedHeader = await inject({
      method: "GET",
      url: "/_gateway/healthz",
      headers: { host, "x-fixture": "x".repeat(GATEWAY_BROWSER_LIMITS.headerBytes) },
    });
    expect(oversizedHeader.statusCode).toBe(431);

    const oversizedBody = await inject({
      method: "POST",
      url: "/app/private",
      headers: {
        host,
        origin: fixture.config.browserOrigin,
        "content-type": "application/octet-stream",
      },
      payload: Buffer.alloc(fixture.config.requestBodyBytes + 1),
    });
    expect(oversizedBody.statusCode).toBe(413);
    expect(oversizedBody.json()).toMatchObject({ error: { code: "REQUEST_INVALID" } });

    const serializedLogs = JSON.stringify(logs);
    for (const privateValue of [
      "10.44.0.10",
      "203.0.113.9",
      "wrong.fixture.invalid",
      "externally-injected",
    ]) {
      expect(serializedLogs).not.toContain(privateValue);
    }
  });

  it("rate limits authentication work by actual socket source with a generic failure", async () => {
    const tls = createTestTlsState("gateway.fixture.invalid");
    const generation = tls.createGeneration("direct-auth-rate");
    const fixture = createDirectGatewayTestFixture({
      tls: {
        approvedRoot: generation.directory,
        certificateFile: generation.certificateFile,
        privateKeyFile: generation.privateKeyFile,
        reload: "watch-last-known-good",
        materialOwner: "user",
        renewalOwner: "external",
        terminationOwner: "gateway",
      },
    });
    const gateway = await WorkstationGateway.create(fixture.config, {
      browserListener: {
        directTlsBootstrap: {
          loadInitial: (ingress) => ({
            key: readFileSync(ingress.tls.privateKeyFile),
            cert: readFileSync(ingress.tls.certificateFile),
          }),
        },
      },
    });
    running.push({ close: () => gateway.close() });
    const headers = {
      host: new URL(fixture.config.browserOrigin).host,
      origin: fixture.config.browserOrigin,
      "content-type": "application/json",
    };

    for (
      let attempt = 0;
      attempt < GATEWAY_BROWSER_LIMITS.authenticationAttemptsPerSource;
      attempt += 1
    ) {
      const response = await gateway.browser.inject({
        method: "POST",
        url: "/_gateway/auth/authentication/options",
        headers,
        payload: {},
        remoteAddress: "10.44.0.10",
      });
      expect(response.statusCode).toBe(400);
    }
    const limited = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/authentication/options",
      headers,
      payload: {},
      remoteAddress: "10.44.0.10",
    });
    expect(limited.statusCode).toBe(429);
    expect(limited.json()).toMatchObject({ error: { code: "PASSKEY_DENIED" } });
  });

  it("removes the admin socket when direct address admission fails before browser bind", async () => {
    const tls = createTestTlsState("gateway.fixture.invalid");
    const generation = tls.createGeneration("direct-bind-failure");
    const fixture = createDirectGatewayTestFixture({
      tls: {
        approvedRoot: generation.directory,
        certificateFile: generation.certificateFile,
        privateKeyFile: generation.privateKeyFile,
        reload: "watch-last-known-good",
        materialOwner: "user",
        renewalOwner: "external",
        terminationOwner: "gateway",
      },
    });
    const gateway = await WorkstationGateway.create(fixture.config, {
      browserListener: {
        directTlsBootstrap: {
          loadInitial: (ingress) => ({
            key: readFileSync(ingress.tls.privateKeyFile),
            cert: readFileSync(ingress.tls.certificateFile),
          }),
        },
        networkInterfaces: () => ({}),
      },
    });
    running.push({ close: () => gateway.close() });

    await expect(gateway.listen()).rejects.toThrow(
      "Direct private listener address is not active on a local IPv4 interface.",
    );
    expect(existsSync(fixture.config.adminSocketPath)).toBe(false);
  });
});

function seedSession(gateway: WorkstationGateway) {
  gateway.repository.createCredential({
    credentialRecordId: "credential-record-direct-fixture",
    credentialId: "raw-direct-fixture-credential",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: [],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: gateway.nowMs(),
  });
  return gateway.sessions.create({
    subject: gateway.config.ownerSubject,
    credentialRecordId: "credential-record-direct-fixture",
    credentialId: "raw-direct-fixture-credential",
    authTime: Math.floor(gateway.nowMs() / 1_000),
  });
}

async function createEchoUpstream(): Promise<{
  readonly server: Server;
  readonly origin: string;
  close(): Promise<void>;
}> {
  const server = createServer((_request, response) => response.end("upstream-http"));
  const sockets = new WebSocketServer({ server });
  sockets.on("connection", (socket) => {
    socket.on("message", (data: RawData, binary: boolean) => {
      socket.send(binary ? data : `echo:${rawDataText(data)}`, { binary });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    origin: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        sockets.close();
        server.close((error) => (error ? reject(error) : resolvePromise()));
      }),
  };
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return Buffer.from(data).toString("utf8");
}

async function secureRequest(
  port: number,
  browserOrigin: string,
): Promise<{ readonly statusCode: number; readonly body: string }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpsRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: "/_gateway/healthz",
        method: "GET",
        rejectUnauthorized: false,
        servername: "gateway.fixture.invalid",
        headers: { host: new URL(browserOrigin).host },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

async function cleartextRequest(port: number): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const request = httpRequest({ hostname: "127.0.0.1", port, path: "/" }, () => resolvePromise());
    request.once("error", reject);
    request.end();
  });
}

async function expectWebSocketUpgradeStatus(
  url: string,
  headers: Record<string, string>,
  expectedStatus: number,
): Promise<void> {
  const client = new WebSocket(url, { headers, rejectUnauthorized: false });
  await new Promise<void>((resolvePromise, reject) => {
    client.once("error", reject);
    client.once("unexpected-response", (_request, response) => {
      expect(response.statusCode).toBe(expectedStatus);
      response.resume();
      response.once("end", resolvePromise);
    });
  });
}
