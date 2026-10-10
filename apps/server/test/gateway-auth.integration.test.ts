import { generateKeyPairSync, randomUUID, type KeyObject } from "node:crypto";
import { mkdir, mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WORKSTATION_GATEWAY_ASSERTION_HEADER,
  type GatewayPrincipalV1,
} from "@naru/contracts/workstation-gateway/v1";
import { createGatewayAssertion } from "@naru/gateway-verifier";
import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import type { GatewayManagedConfig } from "../src/config.js";
import { NaruRepository } from "../src/database.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import type { NaruSessionFacade } from "../src/session-facade.js";

const ORIGIN = "https://naru.fixture.invalid";
const ISSUER = "gateway-fixture";
const AUDIENCE = "naru";
const OWNER = "local-owner";
const KEY_ID = "gateway-test-key";

const openApps: Array<Awaited<ReturnType<typeof buildApp>>> = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("gateway-managed Naru authentication", () => {
  it("accepts one audience-bound owner assertion without a Naru cookie and rejects replay", async () => {
    const fixture = await createFixture();
    const readiness = await fixture.app.inject({ method: "GET", url: "/readyz" });
    expect(readiness.statusCode).toBe(200);
    expect(readiness.json()).toMatchObject({
      checks: { configuration: "ok" },
      metrics: { gauges: { activeSessions: 0 } },
    });
    const assertion = fixture.assertion();
    const accepted = await fixture.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { [WORKSTATION_GATEWAY_ASSERTION_HEADER]: assertion },
    });

    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual({
      authenticated: true,
      authMode: "gateway-managed",
      projectRoots: [fixture.projectRoot],
      capabilities: { terminalRestore: "staged-v1" },
    });
    expect(accepted.headers["set-cookie"]).toBeUndefined();

    const replayed = await fixture.app.inject({
      method: "GET",
      url: "/api/session",
      headers: { [WORKSTATION_GATEWAY_ASSERTION_HEADER]: assertion },
    });
    expect(replayed.statusCode).toBe(401);
    expect(replayed.json()).toMatchObject({ code: "AUTH_REQUIRED" });
  });

  it("fails closed for missing, wrong-app, wrong-Origin, wrong-owner, and invalid signatures", async () => {
    const fixture = await createFixture();
    const missing = await fixture.app.inject({ method: "GET", url: "/api/session" });
    expect(missing.statusCode).toBe(401);
    expect(JSON.stringify(missing.json())).not.toContain(fixture.projectRoot);

    for (const assertion of [
      fixture.assertion({ aud: "other-app" }),
      fixture.assertion({ origin: "https://other.fixture.invalid" }),
      fixture.assertion({ sub: "other-owner" }),
      fixture.assertion({}, generateKeyPairSync("ed25519").privateKey),
    ]) {
      const response = await fixture.app.inject({
        method: "GET",
        url: "/api/session",
        headers: { [WORKSTATION_GATEWAY_ASSERTION_HEADER]: assertion },
      });
      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: "AUTH_REQUIRED" });
    }
  });

  it("uses Gateway Origin protection for unsafe app requests and exposes no legacy auth fallback", async () => {
    const fixture = await createFixture();
    const accepted = await fixture.app.inject({
      method: "POST",
      url: "/api/project-groups/refresh",
      headers: {
        origin: ORIGIN,
        [WORKSTATION_GATEWAY_ASSERTION_HEADER]: fixture.assertion(),
        "x-csrf-token": "untrusted-app-token",
      },
    });
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toEqual([]);

    const wrongOrigin = await fixture.app.inject({
      method: "POST",
      url: "/api/project-groups/refresh",
      headers: {
        origin: "https://other.fixture.invalid",
        [WORKSTATION_GATEWAY_ASSERTION_HEADER]: fixture.assertion(),
      },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    expect(wrongOrigin.json()).toMatchObject({ code: "ORIGIN_INVALID" });

    const login = await fixture.app.inject({
      method: "POST",
      url: "/api/auth/login",
      headers: { origin: ORIGIN },
      payload: { password: "legacy-must-not-exist" },
    });
    expect(login.statusCode).toBe(404);
  });

  it("binds a verified Gateway owner to the WebSocket upgrade without a Naru session", async () => {
    const fixture = await createFixture();
    const socket = await within(
      fixture.app.injectWS("/api/terminal", {
        headers: {
          origin: ORIGIN,
          [WORKSTATION_GATEWAY_ASSERTION_HEADER]: fixture.assertion(),
        },
      }),
      "Gateway WebSocket upgrade did not complete.",
    );
    try {
      const granted = nextSocketFrame(socket);
      socket.send(
        JSON.stringify({
          type: "lease.acquire",
          clientId: randomUUID(),
        }),
      );
      await expect(
        within(granted, "Gateway WebSocket did not receive a lease frame."),
      ).resolves.toMatchObject({ type: "lease.granted", generation: 1 });
    } finally {
      socket.terminate();
    }
  });
});

async function createFixture(): Promise<{
  app: Awaited<ReturnType<typeof buildApp>>;
  projectRoot: string;
  assertion: (patch?: Partial<GatewayPrincipalV1>, signingKey?: KeyObject) => string;
}> {
  const base = await mkdtemp(join(tmpdir(), "naru-gateway-auth-"));
  const root = join(base, "coding");
  await mkdir(root, { recursive: true });
  const canonicalRoot = await realpath(root);
  const keys = generateKeyPairSync("ed25519");
  const config: GatewayManagedConfig = {
    authMode: "gateway-managed",
    environment: "test",
    host: "127.0.0.1",
    port: 4174,
    allowedOrigins: new Set([ORIGIN]),
    projectRoots: [canonicalRoot],
    dataDir: base,
    secureCookie: false,
    appBasePath: "/",
    gatewayAuth: {
      issuer: ISSUER,
      audience: AUDIENCE,
      ownerSubject: OWNER,
      origin: ORIGIN,
      verifierKeysFile: join(base, "verifier-keys.json"),
      verifierKeys: new Map([[KEY_ID, keys.publicKey]]),
    },
    sessionRuntime: {
      owner: "durable-host",
      socketPath: join(base, "host.sock"),
      credentialFile: join(base, "host.credential"),
      appId: AUDIENCE,
      subject: OWNER,
      callerTtlMs: 60_000,
      idempotencyTtlMs: 600_000,
      profileIds: ["shell", "codex-main", "codex-quick"],
      roots: [{ rootId: "coding", path: canonicalRoot }],
    },
  };
  const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
  const pathPolicy = await ProjectPathPolicy.create([canonicalRoot]);
  const app = await buildApp(config, {
    repository,
    pathPolicy,
    supervisor: new FakeSessionFacade(),
  });
  await app.ready();
  openApps.push(app);
  return {
    app,
    projectRoot: canonicalRoot,
    assertion: (patch = {}, signingKey = keys.privateKey) => {
      const now = Math.floor(Date.now() / 1_000);
      return createGatewayAssertion(
        {
          version: 1,
          iss: ISSUER,
          aud: AUDIENCE,
          sub: OWNER,
          authTime: now - 10,
          methods: ["passkey"],
          userVerified: true,
          origin: ORIGIN,
          ingressProfile: "fixture-ingress",
          issuedAt: now,
          expiresAt: now + 60,
          assertionId: randomUUID(),
          ...patch,
        },
        KEY_ID,
        signingKey,
      );
    },
  };
}

class FakeSessionFacade implements NaruSessionFacade {
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

interface TestSocket {
  send(data: string): void;
  terminate(): void;
  once(event: "message", listener: (data: { toString(): string }) => void): void;
}

function nextSocketFrame(socket: TestSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once("message", (data) =>
      resolve(JSON.parse(data.toString()) as Record<string, unknown>),
    );
  });
}

function within<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), 1_000);
      timer.unref();
    }),
  ]);
}
