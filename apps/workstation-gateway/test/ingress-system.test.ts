import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  WorkstationNetworkConfigSchema,
  type WorkstationNetworkConfig,
} from "../src/ingress/config.js";
import type {
  NetworkOwnershipManifest,
  TailscaleRouteResource,
  TailscaleServeRoute,
  TailscaleState,
} from "../src/ingress/model.js";
import type { NetworkProbePort, NetworkProbeResult } from "../src/ingress/probe.js";
import {
  WorkstationNetworkManager,
  type NetworkClock,
  type NetworkManifestPort,
} from "../src/ingress/system.js";
import type { TailscalePort } from "../src/ingress/tailscale.js";
import { createGatewayTestFixture } from "./support.js";

describe("workstation network plan/apply/doctor/rollback", () => {
  it("applies and rolls back only its exact route while preserving unrelated state", async () => {
    const fixture = managerFixture();
    const unrelated = serveRoute("other.tailnet.ts.net:8443", "http://127.0.0.1:49200");
    fixture.tailscale.state = { ...fixture.tailscale.state, routes: [unrelated] };

    const plan = await fixture.manager.plan("tailscale-main");
    expect(plan.status).toBe("ready");
    expect(plan.action?.argv).toEqual([
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/",
      "http://127.0.0.1:49120",
    ]);
    expect(fixture.tailscale.enableCalls).toEqual([]);

    const applied = await fixture.manager.apply("tailscale-main", plan.planDigest);
    expect(applied).toMatchObject({ status: "ok", manifestState: "active" });
    expect(fixture.tailscale.state.routes).toEqual(expect.arrayContaining([unrelated]));
    expect(fixture.manifests.read("tailscale-main")?.state).toBe("active");

    const rollbackPlan = await fixture.manager.plan("tailscale-main", "rollback");
    expect(rollbackPlan.status).toBe("ready");
    const rolledBack = await fixture.manager.rollback("tailscale-main", rollbackPlan.planDigest);
    expect(rolledBack).toMatchObject({ status: "ok", manifestState: "rolled-back" });
    expect(fixture.tailscale.state.routes).toEqual([unrelated]);

    const idempotent = await fixture.manager.plan("tailscale-main", "rollback");
    expect(idempotent.status).toBe("noop");
  });

  it("blocks Funnel and unowned/conflicting target routes before mutation", async () => {
    const fixture = managerFixture();
    fixture.tailscale.state = {
      ...fixture.tailscale.state,
      routes: [
        {
          ...serveRoute("gateway.fixture.ts.net:443", "http://127.0.0.1:49999"),
          funnel: true,
        },
      ],
    };
    const plan = await fixture.manager.plan("tailscale-main");
    expect(plan.status).toBe("blocked");
    expect(plan.checks.map((check) => check.id)).toEqual(
      expect.arrayContaining(["tailscale.funnel", "ingress.funnel", "ingress.route-conflict"]),
    );
    expect(fixture.tailscale.enableCalls).toEqual([]);
  });

  it("blocks apply until the user enables tailnet HTTPS certificates", async () => {
    const fixture = managerFixture();
    fixture.tailscale.state = { ...fixture.tailscale.state, httpsEnabled: false };

    const plan = await fixture.manager.plan("tailscale-main");

    expect(plan.status).toBe("blocked");
    expect(plan.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tailscale.https-capability", status: "blocked" }),
      ]),
    );
    expect(fixture.tailscale.enableCalls).toEqual([]);
  });

  it("retains a pending receipt when a successful command does not persist state", async () => {
    const fixture = managerFixture();
    fixture.tailscale.persistEnable = false;
    const plan = await fixture.manager.plan("tailscale-main");
    await expect(fixture.manager.apply("tailscale-main", plan.planDigest)).rejects.toThrow(
      /pending receipt retained/,
    );
    expect(fixture.manifests.read("tailscale-main")?.state).toBe("pending");
    expect(fixture.tailscale.enableCalls).toHaveLength(1);
  });

  it("requires a fresh digest before retrying an exact pending route that is still absent", async () => {
    const fixture = managerFixture();
    fixture.tailscale.persistEnable = false;
    const initial = await fixture.manager.plan("tailscale-main");
    await expect(fixture.manager.apply("tailscale-main", initial.planDigest)).rejects.toThrow(
      /pending receipt retained/,
    );

    fixture.tailscale.persistEnable = true;
    const retry = await fixture.manager.plan("tailscale-main");
    expect(retry).toMatchObject({
      status: "ready",
      action: { kind: "tailscale-serve-enable" },
      manifest: { state: "pending" },
    });
    expect(retry.planDigest).not.toBe(initial.planDigest);

    await expect(fixture.manager.apply("tailscale-main", retry.planDigest)).resolves.toMatchObject({
      status: "ok",
      manifestState: "active",
    });
  });

  it("rejects state drift against a previously reviewed digest without mutation", async () => {
    const fixture = managerFixture();
    const plan = await fixture.manager.plan("tailscale-main");
    fixture.tailscale.state = {
      ...fixture.tailscale.state,
      routes: [serveRoute("new.tailnet.ts.net:9443", "http://127.0.0.1:49900")],
    };
    await expect(fixture.manager.apply("tailscale-main", plan.planDigest)).rejects.toThrow(
      /digest does not match fresh actual state/,
    );
    expect(fixture.tailscale.enableCalls).toEqual([]);
    expect(fixture.manifests.read("tailscale-main")).toBeUndefined();
  });

  it("reports ingress, Gateway, app and Host as separate healthy layers", async () => {
    const fixture = managerFixture();
    const plan = await fixture.manager.plan("tailscale-main");
    await fixture.manager.apply("tailscale-main", plan.planDigest);

    const status = await fixture.manager.status();
    expect(status.status).toBe("ok");
    expect(status.profiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ profileId: "tailscale-main", routeState: "matching" }),
        expect.objectContaining({ profileId: "wireguard-existing", routeState: "inspect-only" }),
      ]),
    );

    const doctor = await fixture.manager.doctor();
    expect(doctor.status).toBe("ok");
    const tailscaleChecks = doctor.profiles.find(
      (entry) => entry.profileId === "tailscale-main",
    )?.checks;
    expect(tailscaleChecks?.map((check) => check.layer)).toEqual(
      expect.arrayContaining([
        "ownership",
        "listener",
        "ingress",
        "tls-origin",
        "gateway",
        "app",
        "host",
      ]),
    );
    expect(fixture.probes.originCalls).toEqual(
      expect.arrayContaining([
        ["https://gateway.fixture.ts.net", "/_gateway/readyz"],
        ["https://naru.example.invalid:8443", "/"],
      ]),
    );
  });

  it("does not collapse a missing Host proof into an overall green doctor", async () => {
    const fixture = managerFixture({ omitHostProbe: true });
    const doctor = await fixture.manager.doctor();
    expect(doctor.status).toBe("unavailable");
    expect(
      doctor.profiles
        .flatMap((profile) => profile.checks)
        .filter((check) => check.id === "host.ready"),
    ).toEqual(expect.arrayContaining([expect.objectContaining({ status: "unavailable" })]));
  });

  it("requires Gateway readiness for apply but still permits exact rollback during Gateway outage", async () => {
    const fixture = managerFixture();
    const initial = await fixture.manager.plan("tailscale-main");
    await fixture.manager.apply("tailscale-main", initial.planDigest);

    const outageManager = new WorkstationNetworkManager(fixture.config, {
      tailscale: fixture.tailscale,
      manifests: fixture.manifests,
      probes: fixture.probes,
      clock: new FixedClock(),
      gatewayConfig: null,
    });
    const rollback = await outageManager.plan("tailscale-main", "rollback");
    expect(rollback.status).toBe("ready");

    const freshOutage = managerFixture();
    const blockedApply = new WorkstationNetworkManager(freshOutage.config, {
      tailscale: freshOutage.tailscale,
      manifests: freshOutage.manifests,
      probes: freshOutage.probes,
      clock: new FixedClock(),
      gatewayConfig: null,
    });
    expect((await blockedApply.plan("tailscale-main")).status).toBe("unavailable");
  });
});

function managerFixture(options: { omitHostProbe?: boolean } = {}) {
  const gatewayFixture = createGatewayTestFixture({
    browserOrigin: "https://gateway.fixture.ts.net",
    ingressProfileId: "tailscale-main",
    listenPort: 49_120,
  });
  const config = networkConfig(gatewayFixture.root, options.omitHostProbe ?? false);
  const tailscale = new FakeTailscale({
    available: true,
    version: "1.98.2",
    backendState: "Running",
    httpsEnabled: true,
    selfDnsName: "gateway.fixture.ts.net",
    selfAddresses: ["100.64.0.1"],
    routes: [],
    diagnostics: [],
  });
  const manifests = new MemoryManifestPort();
  const probes = new HealthyProbePort();
  const manager = new WorkstationNetworkManager(config, {
    tailscale,
    manifests,
    probes,
    clock: new FixedClock(),
    gatewayConfig: gatewayFixture.config,
  });
  return { manager, config, tailscale, manifests, probes };
}

function networkConfig(root: string, omitHostProbe: boolean): WorkstationNetworkConfig {
  const appProbe = (appId: string, socketName: string) => ({
    appId,
    app: {
      kind: "uds-http" as const,
      socketPath: join(root, `${socketName}-app.sock`),
      path: "/readyz",
    },
    ...(omitHostProbe
      ? {}
      : {
          host: {
            kind: "uds-http" as const,
            socketPath: join(root, `${socketName}-host.sock`),
            path: "/readyz",
          },
        }),
  });
  return WorkstationNetworkConfigSchema.parse({
    version: 1,
    instanceId: "fixture",
    ownershipDirectory: join(root, "ownership"),
    tailscaleExecutable: "/fixture/tailscale",
    gatewayConfigPath: join(root, "gateway.json"),
    trustedProxyPolicies: [{ id: "verified-loopback-serve", kind: "tailscale-loopback" }],
    sourcePolicies: [
      { id: "wireguard-owner-peer", kind: "private-cidr-allowlist", cidrs: ["10.44.0.0/24"] },
    ],
    targetProbes: [
      appProbe("fixture-app", "gateway"),
      appProbe("standalone-fixture", "standalone"),
    ],
    profiles: [
      {
        version: 0,
        profile: {
          id: "tailscale-main",
          kind: "tailscale-serve",
          targetAppId: "fixture-app",
          browserOrigin: "https://gateway.fixture.ts.net",
          transport: "loopback-proxy",
          bindOrUpstream: "http://127.0.0.1:49120",
          tlsOwner: "tailscale",
          trustedProxyPolicy: "verified-loopback-serve",
        },
      },
      {
        version: 0,
        profile: {
          id: "wireguard-existing",
          kind: "wireguard-direct",
          targetAppId: "standalone-fixture",
          browserOrigin: "https://naru.example.invalid:8443",
          transport: "direct-private-listener",
          bindOrUpstream: "10.44.0.2:8443",
          tlsOwner: "app",
          sourcePolicy: "wireguard-owner-peer",
        },
      },
    ],
  });
}

class FakeTailscale implements TailscalePort {
  readonly enableCalls: TailscaleRouteResource[] = [];
  readonly disableCalls: TailscaleRouteResource[] = [];
  persistEnable = true;

  constructor(public state: TailscaleState) {}

  inspect(): Promise<TailscaleState> {
    return Promise.resolve(structuredClone(this.state));
  }

  enable(resource: TailscaleRouteResource): Promise<void> {
    this.enableCalls.push(structuredClone(resource));
    if (!this.persistEnable) return Promise.resolve();
    this.state = {
      ...this.state,
      routes: [
        ...this.state.routes,
        {
          hostPort: resource.hostPort,
          mountPath: resource.mountPath,
          proxy: resource.proxy,
          protocol: "https",
          funnel: false,
          source: "background",
        },
      ],
    };
    return Promise.resolve();
  }

  disable(resource: TailscaleRouteResource): Promise<void> {
    this.disableCalls.push(structuredClone(resource));
    this.state = {
      ...this.state,
      routes: this.state.routes.filter(
        (route) =>
          !(
            route.source === "background" &&
            route.hostPort === resource.hostPort &&
            route.mountPath === resource.mountPath &&
            route.proxy === resource.proxy
          ),
      ),
    };
    return Promise.resolve();
  }
}

class MemoryManifestPort implements NetworkManifestPort {
  readonly manifests = new Map<string, NetworkOwnershipManifest>();

  read(profileId: string): NetworkOwnershipManifest | undefined {
    const manifest = this.manifests.get(profileId);
    return manifest === undefined ? undefined : structuredClone(manifest);
  }

  write(manifest: NetworkOwnershipManifest): void {
    this.manifests.set(manifest.profileId, structuredClone(manifest));
  }
}

class HealthyProbePort implements NetworkProbePort {
  readonly originCalls: [string, string][] = [];
  readonly healthCalls: unknown[] = [];

  probeOrigin(origin: string, path: string): Promise<NetworkProbeResult> {
    this.originCalls.push([origin, path]);
    return Promise.resolve({ reachable: true, healthy: true, actual: "HTTP 200" });
  }

  probeHealth(probe: Parameters<NetworkProbePort["probeHealth"]>[0]): Promise<NetworkProbeResult> {
    this.healthCalls.push(probe);
    return Promise.resolve({ reachable: true, healthy: true, actual: "HTTP 200" });
  }
}

class FixedClock implements NetworkClock {
  now(): Date {
    return new Date("2026-08-24T00:00:00.000Z");
  }
}

function serveRoute(hostPort: string, proxy: string): TailscaleServeRoute {
  return {
    hostPort,
    mountPath: "/",
    proxy,
    protocol: "https",
    funnel: false,
    source: "background",
  };
}
