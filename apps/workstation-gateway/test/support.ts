import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkstationGatewayConfigSchema, type WorkstationGatewayConfig } from "../src/config.js";
import type { GatewayClock } from "../src/sessions.js";

export class FakeGatewayClock implements GatewayClock {
  constructor(public value = 1_780_000_000_000) {}

  nowMs(): number {
    return this.value;
  }
}

export interface GatewayTestFixture {
  readonly root: string;
  readonly config: WorkstationGatewayConfig;
}

export function createGatewayTestFixture(
  overrides: Partial<WorkstationGatewayConfig> = {},
): GatewayTestFixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "wg-")));
  chmodSync(root, 0o700);
  const dataDirectory = join(root, "data");
  const runtimeDirectory = join(root, "r");
  const upstreamSocketDirectory = join(root, "u");
  for (const directory of [dataDirectory, runtimeDirectory, upstreamSocketDirectory]) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    chmodSync(directory, 0o700);
  }
  const config = WorkstationGatewayConfigSchema.parse({
    version: 1,
    instanceId: "gateway-fixture",
    ownerSubject: "owner-fixture",
    browserOrigin: "https://gateway.fixture.invalid",
    ingressProfileId: "fixture-private-ingress",
    rpName: "Workstation Gateway Fixture",
    dataDirectory,
    adminSocketPath: join(runtimeDirectory, "a.sock"),
    listenHost: "127.0.0.1",
    listenPort: 49_120,
    sessionCookieName: "__Host-naru_gateway_fixture",
    bootstrapTtlMs: 60_000,
    ceremonyTtlMs: 60_000,
    sessionAbsoluteTtlMs: 10 * 60_000,
    sessionIdleTtlMs: 60_000,
    principalTtlSeconds: 30,
    requestBodyBytes: 128 * 1_024,
    appRegistrations: [
      {
        appId: "fixture-app",
        mode: "gateway-managed",
        routePrefix: "/app",
        upstream: { kind: "uds", socketPath: join(upstreamSocketDirectory, "u.sock") },
      },
      {
        appId: "standalone-fixture",
        mode: "app-managed",
        origin: "https://standalone.fixture.invalid",
      },
    ],
    ...overrides,
  });
  return { root, config };
}
