import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import {
  deriveIntegrationBootstrapKey,
  DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV,
  verifyIntegrationBootstrap,
} from "@naru/durable-session-integration";
import { afterEach, describe, expect, it } from "vitest";
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

const runningHosts: RunningDurableSessionHost[] = [];

afterEach(async () => {
  await Promise.all(runningHosts.splice(0).map((host) => host.close()));
});

describe("DurableSession Host private UDS transport", () => {
  it("serves health/readiness and authenticated lifecycle operations on a mode-0600 socket", async () => {
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
    const runtime = new FakeRuntimePort();
    const clock = new FakeClock();
    const host = await startDurableSessionHost(config, {
      metadata: new MemoryMetadataRepository(),
      runtime,
      clock,
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);

    expect(lstatSync(fixture.config.socketPath).mode & 0o077).toBe(0);
    expect(await requestJson(fixture.config.socketPath, "GET", "/healthz")).toMatchObject({
      status: 200,
      body: { version: 1, status: "ok", protocolVersion: 0 },
    });
    expect(await requestJson(fixture.config.socketPath, "GET", "/readyz")).toMatchObject({
      status: 200,
      body: { status: "ready" },
    });

    const envelope = {
      callerContext: ownerCaller(clock.value),
      request: {
        version: 0,
        requestId: "50000000-0000-4000-8000-000000000001",
        operation: "createSession",
        idempotencyKey: "60000000-0000-4000-8000-000000000001",
        command: profileCommand(),
      },
    };
    const unauthorized = await requestJson(
      fixture.config.socketPath,
      "POST",
      "/v0/operations",
      envelope,
    );
    expect(unauthorized).toMatchObject({
      status: 200,
      body: { ok: false, error: { code: "CAPABILITY_REQUIRED" } },
    });

    const created = await requestJson(
      fixture.config.socketPath,
      "POST",
      "/v0/operations",
      envelope,
      authHeaders(),
    );
    expect(created).toMatchObject({
      status: 200,
      body: {
        version: 0,
        ok: true,
        result: {
          operation: "createSession",
          session: {
            sessionId: TEST_IDS.session1,
            runtimeId: TEST_IDS.runtime1,
            lifecycle: "running",
          },
        },
      },
    });
    expect(runtime.records).toHaveLength(1);

    const bindingId = "15000000-0000-4000-8000-000000000001";
    const integrated = await requestJson(
      config.socketPath,
      "POST",
      "/v0/operations",
      {
        callerContext: ownerCaller(clock.value),
        request: {
          version: 0,
          requestId: "50000000-0000-4000-8000-000000000010",
          operation: "createSession",
          idempotencyKey: "60000000-0000-4000-8000-000000000010",
          command: {
            ...profileCommand(),
            integration: {
              kind: "fixture",
              config: { policyRef: "fixture-integration-v0", bindingId },
            },
          },
        },
      },
      authHeaders(),
    );
    expect(integrated).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          operation: "createSession",
          session: { sessionId: TEST_IDS.session2, runtimeId: TEST_IDS.runtime2 },
        },
      },
    });
    const bootstrap =
      runtime.records[1]?.request.launch.environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
    if (bootstrap === undefined) throw new Error("Integration bootstrap was not injected.");
    expect(
      verifyIntegrationBootstrap(bootstrap, deriveIntegrationBootstrapKey(TEST_CREDENTIAL)),
    ).toMatchObject({
      appId: "fixture-app",
      subject: "fixture-owner",
      sessionId: TEST_IDS.session2,
      runtimeId: TEST_IDS.runtime2,
      profileId: "fixture",
      integration: {
        kind: "fixture",
        config: { policyRef: "fixture-integration-v0", bindingId },
      },
    });
    expect(JSON.stringify(integrated)).not.toContain(bootstrap);

    runtime.exit(TEST_IDS.runtime2, 0, null);
    const exited = await host.service.execute(ownerCaller(clock.value), {
      version: 0,
      requestId: "50000000-0000-4000-8000-000000000011",
      operation: "getSession",
      sessionId: TEST_IDS.session2,
    });
    if (!exited.ok || exited.result.operation !== "getSession") {
      throw new Error("Integrated fixture Session did not exit.");
    }
    expect(exited.result.session.lifecycle).toBe("exited");
    const restarted = await requestJson(
      config.socketPath,
      "POST",
      "/v0/operations",
      {
        callerContext: ownerCaller(clock.value),
        request: {
          version: 0,
          requestId: "50000000-0000-4000-8000-000000000012",
          operation: "startSession",
          sessionId: TEST_IDS.session2,
          expectedSessionRevision: exited.result.session.sessionRevision,
          idempotencyKey: "60000000-0000-4000-8000-000000000012",
        },
      },
      authHeaders(),
    );
    expect(restarted).toMatchObject({
      status: 200,
      body: {
        ok: true,
        result: {
          operation: "startSession",
          session: { sessionId: TEST_IDS.session2, runtimeId: TEST_IDS.runtime3 },
        },
      },
    });
    const restartedBootstrap =
      runtime.records[2]?.request.launch.environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
    if (restartedBootstrap === undefined) {
      throw new Error("Restarted integration bootstrap was not injected.");
    }
    expect(restartedBootstrap).not.toBe(bootstrap);
    expect(
      verifyIntegrationBootstrap(
        restartedBootstrap,
        deriveIntegrationBootstrapKey(TEST_CREDENTIAL),
      ),
    ).toMatchObject({
      sessionId: TEST_IDS.session2,
      runtimeId: TEST_IDS.runtime3,
      integration: {
        kind: "fixture",
        config: { policyRef: "fixture-integration-v0", bindingId },
      },
    });

    const wrongCredential = await requestJson(
      fixture.config.socketPath,
      "POST",
      "/v0/operations",
      {
        ...envelope,
        request: { ...envelope.request, requestId: "50000000-0000-4000-8000-000000000002" },
      },
      authHeaders("wrong-credential-value-012345678901234567890"),
    );
    expect(wrongCredential).toMatchObject({
      status: 200,
      body: { ok: false, error: { code: "CAPABILITY_REQUIRED" } },
    });

    await host.close();
    expect(existsSync(fixture.config.socketPath)).toBe(false);
  });

  it("fails closed for oversized, malformed and unknown transport requests", async () => {
    const fixture = createHostFixture();
    const host = await startDurableSessionHost(fixture.config, {
      metadata: new MemoryMetadataRepository(),
      runtime: new FakeRuntimePort(),
      clock: new FakeClock(),
      ids: new FakeIds(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(host);

    const oversized = await requestRaw(fixture.config.socketPath, "POST", "/v0/operations", "{}", {
      "content-type": "application/json",
      "content-length": String(fixture.config.requestBodyBytes + 1),
    });
    expect(oversized).toMatchObject({ status: 413, body: { error: { code: "REQUEST_INVALID" } } });
    const malformed = await requestRaw(
      fixture.config.socketPath,
      "POST",
      "/v0/operations",
      "{not-json",
      { "content-type": "application/json" },
    );
    expect(malformed).toMatchObject({ status: 400, body: { error: { code: "REQUEST_INVALID" } } });
    expect(await requestJson(fixture.config.socketPath, "GET", "/unknown")).toMatchObject({
      status: 404,
      body: { error: { code: "REQUEST_INVALID" } },
    });
    await host.close();
  });

  it("does not unlink a non-socket path or replace an active Host socket", async () => {
    const blockedFixture = createHostFixture();
    writeFileSync(blockedFixture.config.socketPath, "preserve-me", { mode: 0o600 });
    await expect(
      startDurableSessionHost(blockedFixture.config, {
        metadata: new MemoryMetadataRepository(),
        runtime: new FakeRuntimePort(),
        logger: silentHostLogger,
        hostEnvironment: {},
      }),
    ).rejects.toThrow("Host socket path is not a Unix socket.");
    expect(readFileSync(blockedFixture.config.socketPath, "utf8")).toBe("preserve-me");

    const activeFixture = createHostFixture();
    const activeHost = await startDurableSessionHost(activeFixture.config, {
      metadata: new MemoryMetadataRepository(),
      runtime: new FakeRuntimePort(),
      logger: silentHostLogger,
      hostEnvironment: {},
    });
    runningHosts.push(activeHost);
    await expect(
      startDurableSessionHost(activeFixture.config, {
        metadata: new MemoryMetadataRepository(),
        runtime: new FakeRuntimePort(),
        logger: silentHostLogger,
        hostEnvironment: {},
      }),
    ).rejects.toThrow("DurableSession Host socket is already active.");
    expect(await requestJson(activeFixture.config.socketPath, "GET", "/healthz")).toMatchObject({
      status: 200,
      body: { status: "ok" },
    });
    await activeHost.close();
  });
});

function authHeaders(credential = TEST_CREDENTIAL): Readonly<Record<string, string>> {
  return {
    authorization: `Bearer ${credential}`,
    "x-durable-session-app-id": "fixture-app",
  };
}

function requestJson(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
) {
  const encoded = body === undefined ? undefined : JSON.stringify(body);
  return requestRaw(socketPath, method, path, encoded, {
    ...(encoded === undefined ? {} : { "content-type": "application/json" }),
    ...headers,
  });
}

function requestRaw(
  socketPath: string,
  method: string,
  path: string,
  body: string | undefined,
  headers: Readonly<Record<string, string>>,
): Promise<{ readonly status: number; readonly body: unknown }> {
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        agent: false,
        headers: {
          ...headers,
          ...(body === undefined || headers["content-length"] !== undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(body)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          try {
            resolvePromise({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown,
            });
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Fixture response parsing failed."));
          }
        });
      },
    );
    request.once("error", reject);
    if (body !== undefined) request.end(body);
    else request.end();
  });
}
