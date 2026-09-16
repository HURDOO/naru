import { describe, expect, it } from "vitest";
import { WorkstationGatewayConfigSchema } from "../src/config.js";
import { createDirectGatewayTestFixture, createGatewayTestFixture } from "./support.js";

describe("Workstation Gateway configuration", () => {
  it("accepts exact private managed and explicit app-managed registrations", () => {
    const { config } = createGatewayTestFixture();
    expect(config.appRegistrations.map((app) => app.mode)).toEqual([
      "gateway-managed",
      "app-managed",
    ]);
    expect(config.appRegistrations[0]).toMatchObject({
      enabled: true,
      includeCredentialRef: true,
    });
  });

  it("rejects public, wildcard, credential-bearing, and non-loopback managed upstreams", () => {
    const { config } = createGatewayTestFixture();
    expect(
      WorkstationGatewayConfigSchema.safeParse({ ...config, listenHost: "0.0.0.0" }).success,
    ).toBe(false);
    for (const origin of [
      "http://0.0.0.0:49100",
      "http://192.0.2.1:49100",
      "https://127.0.0.1:49100",
      ["http://user", "password@127.0.0.1:49100"].join(":"),
      "http://127.0.0.1:49100/path",
    ]) {
      expect(
        WorkstationGatewayConfigSchema.safeParse({
          ...config,
          appRegistrations: [
            {
              appId: "unsafe",
              mode: "gateway-managed",
              routePrefix: "/unsafe",
              upstream: { kind: "loopback", origin },
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("rejects overlapping and reserved app routes", () => {
    const { config } = createGatewayTestFixture();
    expect(
      WorkstationGatewayConfigSchema.safeParse({
        ...config,
        appRegistrations: [
          {
            appId: "one",
            mode: "gateway-managed",
            routePrefix: "/apps",
            upstream:
              config.appRegistrations[0]?.mode === "gateway-managed"
                ? config.appRegistrations[0].upstream
                : undefined,
          },
          {
            appId: "two",
            mode: "gateway-managed",
            routePrefix: "/apps/two",
            upstream:
              config.appRegistrations[0]?.mode === "gateway-managed"
                ? config.appRegistrations[0].upstream
                : undefined,
          },
        ],
      }).success,
    ).toBe(false);
    for (const routePrefix of ["/_gateway", "/_gateway/auth", "/_gateway/apps"]) {
      expect(
        WorkstationGatewayConfigSchema.safeParse({
          ...config,
          appRegistrations: [
            {
              appId: "reserved",
              mode: "gateway-managed",
              routePrefix,
              upstream:
                config.appRegistrations[0]?.mode === "gateway-managed"
                  ? config.appRegistrations[0].upstream
                  : undefined,
            },
          ],
        }).success,
        routePrefix,
      ).toBe(false);
    }
    for (const routePrefix of ["/apps//two", "/apps/%2e%2e/two", "/apps\\two"]) {
      expect(
        WorkstationGatewayConfigSchema.safeParse({
          ...config,
          appRegistrations: [
            {
              appId: "ambiguous",
              mode: "gateway-managed",
              routePrefix,
              upstream:
                config.appRegistrations[0]?.mode === "gateway-managed"
                  ? config.appRegistrations[0].upstream
                  : undefined,
            },
          ],
        }).success,
      ).toBe(false);
    }
  });

  it("accepts an explicit v2 listener union while retaining the v1 loopback configuration", () => {
    const legacy = createGatewayTestFixture().config;
    const direct = createDirectGatewayTestFixture().config;
    if (legacy.version !== 1) throw new Error("Legacy fixture must use config version 1.");
    expect(legacy).toMatchObject({ version: 1, listenHost: "127.0.0.1" });
    expect(direct).toMatchObject({
      version: 2,
      browserIngress: {
        kind: "direct-private-tls",
        listener: { host: "10.44.0.2", port: 8_443 },
      },
    });

    const loopbackV2Input: Record<string, unknown> = {
      ...legacy,
      version: 2,
      browserIngress: {
        kind: "loopback-proxy",
        network: "tailscale-serve",
        listenHost: "127.0.0.1",
        listenPort: legacy.listenPort,
      },
    };
    delete loopbackV2Input.listenHost;
    delete loopbackV2Input.listenPort;
    const loopbackV2 = WorkstationGatewayConfigSchema.parse(loopbackV2Input);
    expect(loopbackV2).toMatchObject({
      version: 2,
      browserIngress: { kind: "loopback-proxy", listenHost: "127.0.0.1" },
    });
  });

  it("rejects direct mode drift, cross-mode fields, and non-IPv4-loopback managed upstreams", () => {
    const direct = createDirectGatewayTestFixture().config;
    expect(
      WorkstationGatewayConfigSchema.safeParse({ ...direct, listenHost: "127.0.0.1" }).success,
    ).toBe(false);
    expect(
      WorkstationGatewayConfigSchema.safeParse({
        ...direct,
        browserOrigin: "https://other.fixture.invalid:8443",
      }).success,
    ).toBe(false);
    expect(
      WorkstationGatewayConfigSchema.safeParse({
        ...direct,
        ingressProfileId: "other-profile",
      }).success,
    ).toBe(false);
    for (const upstream of [
      { kind: "uds", socketPath: "/private/tmp/naru-fixture/naru.sock" },
      { kind: "loopback", origin: "http://[::1]:4174" },
    ]) {
      expect(
        WorkstationGatewayConfigSchema.safeParse({
          ...direct,
          appRegistrations: [
            {
              appId: "fixture-app",
              mode: "gateway-managed",
              routePrefix: "/app",
              upstream,
              includeCredentialRef: true,
              enabled: true,
            },
          ],
        }).success,
      ).toBe(false);
    }
    expect(
      WorkstationGatewayConfigSchema.safeParse({
        ...direct,
        appRegistrations: [
          {
            appId: "standalone-fixture",
            mode: "app-managed",
            origin: "https://standalone.fixture.invalid",
          },
        ],
      }).success,
    ).toBe(false);
  });
});
