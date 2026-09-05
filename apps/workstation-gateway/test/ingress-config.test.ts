import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkstationNetworkConfigSchema } from "../src/ingress/config.js";

describe("workstation network configuration", () => {
  it("accepts additive Tailscale and WireGuard profiles with resolved policies", () => {
    const parsed = WorkstationNetworkConfigSchema.parse(networkConfigFixture());
    expect(parsed.profiles.map((entry) => entry.profile.kind)).toEqual([
      "tailscale-serve",
      "wireguard-direct",
    ]);
    expect(parsed.trustedProxyPolicies).toEqual([
      { id: "verified-loopback-serve", kind: "tailscale-loopback" },
    ]);
  });

  it("rejects missing policy references and public source CIDRs", () => {
    const fixture = networkConfigFixture();
    expect(
      WorkstationNetworkConfigSchema.safeParse({
        ...fixture,
        trustedProxyPolicies: [],
      }).success,
    ).toBe(false);
    expect(
      WorkstationNetworkConfigSchema.safeParse({
        ...fixture,
        sourcePolicies: [
          {
            id: "wireguard-owner-peer",
            kind: "private-cidr-allowlist",
            cidrs: ["192.168.1.1/8"],
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      WorkstationNetworkConfigSchema.safeParse({
        ...fixture,
        sourcePolicies: [
          { id: "wireguard-owner-peer", kind: "private-cidr-allowlist", cidrs: ["203.0.113.0/24"] },
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate profile ownership and unsafe probe endpoints", () => {
    const fixture = networkConfigFixture();
    expect(
      WorkstationNetworkConfigSchema.safeParse({
        ...fixture,
        profiles: [fixture.profiles[0], fixture.profiles[0]],
      }).success,
    ).toBe(false);
    expect(
      WorkstationNetworkConfigSchema.safeParse({
        ...fixture,
        targetProbes: [
          {
            appId: "naru",
            app: { kind: "loopback-http", origin: "http://0.0.0.0:49101", path: "/readyz" },
          },
        ],
      }).success,
    ).toBe(false);
  });
});

function networkConfigFixture() {
  return {
    version: 1 as const,
    instanceId: "fixture",
    gatewayConfigPath: "/private/gateway.json",
    ownershipDirectory: "/private/ownership",
    tailscaleExecutable: "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
    trustedProxyPolicies: [{ id: "verified-loopback-serve", kind: "tailscale-loopback" as const }],
    sourcePolicies: [
      {
        id: "wireguard-owner-peer",
        kind: "private-cidr-allowlist" as const,
        cidrs: ["10.44.0.0/24"],
      },
    ],
    targetProbes: [
      {
        appId: "naru",
        app: {
          kind: "uds-http" as const,
          socketPath: join("/private", "naru.sock"),
          path: "/readyz",
        },
        host: {
          kind: "uds-http" as const,
          socketPath: join("/private", "host.sock"),
          path: "/readyz",
        },
      },
    ],
    profiles: [
      {
        version: 0 as const,
        profile: {
          id: "tailscale-main",
          kind: "tailscale-serve" as const,
          targetAppId: "naru",
          browserOrigin: "https://workstation.tailnet.ts.net",
          transport: "loopback-proxy" as const,
          bindOrUpstream: "http://127.0.0.1:49100",
          tlsOwner: "tailscale" as const,
          trustedProxyPolicy: "verified-loopback-serve",
        },
      },
      {
        version: 0 as const,
        profile: {
          id: "wireguard-existing",
          kind: "wireguard-direct" as const,
          targetAppId: "naru-standalone",
          browserOrigin: "https://naru.example.invalid:8443",
          transport: "direct-private-listener" as const,
          bindOrUpstream: "10.44.0.2:8443",
          tlsOwner: "app" as const,
          sourcePolicy: "wireguard-owner-peer",
        },
      },
    ],
  };
}
