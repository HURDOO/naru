import { describe, expect, it } from "vitest";
import { WorkstationGatewayConfigSchema } from "../src/config.js";
import { createGatewayTestFixture } from "./support.js";

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
    expect(
      WorkstationGatewayConfigSchema.safeParse({
        ...config,
        appRegistrations: [
          {
            appId: "reserved",
            mode: "gateway-managed",
            routePrefix: "/_gateway/auth",
            upstream:
              config.appRegistrations[0]?.mode === "gateway-managed"
                ? config.appRegistrations[0].upstream
                : undefined,
          },
        ],
      }).success,
    ).toBe(false);
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
});
