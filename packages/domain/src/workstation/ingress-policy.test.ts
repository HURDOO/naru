import type { IngressProfileV0 } from "@naru/contracts/workstation-gateway/v1";
import { describe, expect, it } from "vitest";
import {
  analyzeIngressProfiles,
  assertIngressProfilesSafe,
  isPrivateIpAddress,
} from "./ingress-policy.js";

const tailscaleProfile: IngressProfileV0 = {
  id: "tailscale-main",
  kind: "tailscale-serve",
  targetAppId: "naru",
  browserOrigin: "https://workstation.tailnet.ts.net",
  transport: "loopback-proxy",
  bindOrUpstream: "http://127.0.0.1:49100",
  tlsOwner: "tailscale",
  trustedProxyPolicy: "verified-loopback-serve",
};

const wireguardProfile: IngressProfileV0 = {
  id: "wireguard-existing",
  kind: "wireguard-direct",
  targetAppId: "naru-standalone",
  browserOrigin: "https://naru.example.invalid:8443",
  transport: "direct-private-listener",
  bindOrUpstream: "10.44.0.2:8443",
  tlsOwner: "app",
  sourcePolicy: "wireguard-owner-peer",
};

describe("workstation ingress policy", () => {
  it("accepts additive Tailscale and existing WireGuard profiles", () => {
    const analysis = analyzeIngressProfiles([tailscaleProfile, wireguardProfile]);
    expect(analysis.issues).toEqual([]);
    expect(analysis.profiles.map((entry) => entry.profile.id)).toEqual([
      "tailscale-main",
      "wireguard-existing",
    ]);
    expect(analysis.profiles[0]?.originPort).toBe(443);
    expect(analysis.profiles[1]?.directListener).toEqual({ address: "10.44.0.2", port: 8443 });
  });

  it("rejects invalid kind-specific transport, TLS, source, and proxy boundaries", () => {
    const { trustedProxyPolicy: _trustedProxyPolicy, ...tailscaleWithoutProxy } = tailscaleProfile;
    const { sourcePolicy: _sourcePolicy, ...wireguardWithoutSource } = wireguardProfile;
    void _trustedProxyPolicy;
    void _sourcePolicy;
    const analysis = analyzeIngressProfiles([
      {
        ...tailscaleWithoutProxy,
        browserOrigin: "https://public.example.invalid",
        transport: "direct-private-listener",
        tlsOwner: "app",
        bindOrUpstream: "0.0.0.0:49100",
      },
      {
        ...wireguardWithoutSource,
        transport: "loopback-proxy",
        tlsOwner: "tailscale",
        bindOrUpstream: "203.0.113.4:8443",
        trustedProxyPolicy: "guessed-proxy",
      },
    ]);
    expect(new Set(analysis.issues.map((entry) => entry.code))).toEqual(
      new Set([
        "TAILSCALE_ORIGIN_INVALID",
        "TAILSCALE_TRANSPORT_INVALID",
        "TAILSCALE_TLS_OWNER_INVALID",
        "TAILSCALE_UPSTREAM_INVALID",
        "TAILSCALE_PROXY_POLICY_REQUIRED",
        "DIRECT_TRANSPORT_INVALID",
        "DIRECT_TLS_OWNER_INVALID",
        "DIRECT_LISTENER_INVALID",
        "DIRECT_SOURCE_POLICY_REQUIRED",
        "TRUSTED_PROXY_POLICY_UNEXPECTED",
      ]),
    );
  });

  it("rejects duplicate IDs and exact Origin ownership", () => {
    const conflicting = {
      ...tailscaleProfile,
      targetAppId: "other",
      bindOrUpstream: "http://127.0.0.1:49200",
    };
    const analysis = analyzeIngressProfiles([tailscaleProfile, conflicting]);
    expect(analysis.issues.map((entry) => entry.code)).toEqual([
      "PROFILE_ID_CONFLICT",
      "ORIGIN_CONFLICT",
    ]);
    expect(() => assertIngressProfilesSafe([tailscaleProfile, conflicting])).toThrow(
      /PROFILE_ID_CONFLICT/,
    );
  });

  it("recognizes only loopback and private IPv4/IPv6 addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "192.168.1.1",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPrivateIpAddress(address)).toBe(true);
    }
    for (const address of [
      "0.0.0.0",
      "8.8.8.8",
      "172.32.0.1",
      "2001:4860:4860::8888",
      "hostname.invalid",
    ]) {
      expect(isPrivateIpAddress(address)).toBe(false);
    }
  });
});
