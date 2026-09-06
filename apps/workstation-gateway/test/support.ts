import { chmodSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PrivateIngressV0 } from "@naru/contracts/private-ingress/v0";
import {
  WorkstationGatewayConfigSchema,
  isDirectPrivateWorkstationGatewayConfig,
  type DirectPrivateWorkstationGatewayConfig,
  type GatewayAppRegistration,
  type WorkstationGatewayConfig,
} from "../src/config.js";
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

export interface DirectGatewayTestFixture {
  readonly root: string;
  readonly config: DirectPrivateWorkstationGatewayConfig;
}

export interface DirectGatewayTestOptions {
  readonly browserOrigin?: string;
  readonly listenerHost?: string;
  readonly listenerPort?: number;
  readonly tls?: PrivateIngressV0["tls"];
  readonly appRegistrations?: readonly GatewayAppRegistration[];
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

export function createDirectGatewayTestFixture(
  options: DirectGatewayTestOptions = {},
): DirectGatewayTestFixture {
  const { root, config: legacy } = createGatewayTestFixture();
  const browserOrigin = options.browserOrigin ?? "https://gateway.fixture.invalid:8443";
  const listenerPort = options.listenerPort ?? 8_443;
  const tlsRoot = join(root, "tls");
  const config = WorkstationGatewayConfigSchema.parse({
    version: 2,
    instanceId: legacy.instanceId,
    ownerSubject: legacy.ownerSubject,
    browserOrigin,
    ingressProfileId: legacy.ingressProfileId,
    rpName: legacy.rpName,
    dataDirectory: legacy.dataDirectory,
    adminSocketPath: legacy.adminSocketPath,
    sessionCookieName: legacy.sessionCookieName,
    bootstrapTtlMs: legacy.bootstrapTtlMs,
    ceremonyTtlMs: legacy.ceremonyTtlMs,
    sessionAbsoluteTtlMs: legacy.sessionAbsoluteTtlMs,
    sessionIdleTtlMs: legacy.sessionIdleTtlMs,
    principalTtlSeconds: legacy.principalTtlSeconds,
    requestBodyBytes: legacy.requestBodyBytes,
    browserIngress: {
      contractVersion: "private-ingress.v0",
      profileId: legacy.ingressProfileId,
      kind: "direct-private-tls",
      network: "wireguard-direct",
      browserOrigin,
      listener: { host: options.listenerHost ?? "10.44.0.2", port: listenerPort },
      tls:
        options.tls ??
        ({
          approvedRoot: tlsRoot,
          certificateFile: join(tlsRoot, "full-chain.pem"),
          privateKeyFile: join(tlsRoot, "private-key.pem"),
          reload: "watch-last-known-good",
          materialOwner: "user",
          renewalOwner: "external",
          terminationOwner: "gateway",
        } satisfies PrivateIngressV0["tls"]),
      sourcePolicy: {
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["10.44.0.10"],
        allowedCidrs: [],
      },
    },
    appRegistrations: options.appRegistrations ?? [
      {
        appId: "fixture-app",
        mode: "gateway-managed",
        routePrefix: "/app",
        upstream: { kind: "loopback", origin: "http://127.0.0.1:4174" },
      },
      {
        appId: "standalone-fixture",
        mode: "app-managed",
        origin: "https://standalone.fixture.invalid",
      },
    ],
  });
  if (!isDirectPrivateWorkstationGatewayConfig(config)) {
    throw new Error("Direct Gateway fixture did not select direct private TLS ingress.");
  }
  return { root, config };
}
