import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  isApprovedPwaRuntimeOrigin,
  isPwaOriginConsistent,
  readConfiguredPwaOrigin,
  shouldRegisterPwa,
  type CanonicalOriginMetaSource,
} from "./pwa";
import { readConfiguredAppBasePath } from "./app-base-path";
import { PUBLIC_PWA_BUILD_FIXTURE_ORIGIN } from "./public-build-config";

describe("PWA runtime boundary", () => {
  it.each([
    [PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, true],
    ["https://naru.example.test", PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, false],
    ["http://naru.example.test:8443", PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, false],
    ["https://10.23.45.10:8443", PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, false],
    ["http://127.0.0.1:4474", PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, true],
    ["http://localhost:5173", PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, true],
    ["https://naru.fixture.invalid", "https://naru.fixture.invalid", true],
    ["http://localhost:5173", "https://naru.fixture.invalid", false],
    ["not a URL", PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, false],
  ] as const)("classifies %s against %s as approved=%s", (origin, configured, expected) => {
    expect(isApprovedPwaRuntimeOrigin(origin, configured)).toBe(expected);
  });

  it("reads exactly one valid configured HTTPS hostname Origin from build metadata", () => {
    expect(readConfiguredPwaOrigin(metaSource("https://custom.tailnet.ts.net:9443"))).toBe(
      "https://custom.tailnet.ts.net:9443",
    );
    expect(readConfiguredPwaOrigin(metaSource())).toBeNull();
    expect(
      readConfiguredPwaOrigin(
        metaSource(PUBLIC_PWA_BUILD_FIXTURE_ORIGIN, PUBLIC_PWA_BUILD_FIXTURE_ORIGIN),
      ),
    ).toBeNull();
    expect(readConfiguredPwaOrigin(metaSource("https://10.23.45.10:8443"))).toBeNull();
    expect(readConfiguredPwaOrigin(metaSource("https://custom.tailnet.ts.net/path"))).toBeNull();
  });

  it("requires runtime, rendered metadata and Gateway session Origin to agree exactly", () => {
    expect(
      isPwaOriginConsistent({
        runtimeOrigin: "https://custom.tailnet.ts.net:9443",
        configuredOrigin: "https://custom.tailnet.ts.net:9443",
        gatewayOrigin: "https://custom.tailnet.ts.net:9443",
      }),
    ).toBe(true);
    expect(
      isPwaOriginConsistent({
        runtimeOrigin: "https://custom.tailnet.ts.net:9443",
        configuredOrigin: "https://custom.tailnet.ts.net:9443",
        gatewayOrigin: PUBLIC_PWA_BUILD_FIXTURE_ORIGIN,
      }),
    ).toBe(false);
  });

  it("requires production, a secure context, worker support and configured Origin", () => {
    const valid = {
      origin: PUBLIC_PWA_BUILD_FIXTURE_ORIGIN,
      configuredOrigin: PUBLIC_PWA_BUILD_FIXTURE_ORIGIN,
      production: true,
      secureContext: true,
      serviceWorkerSupported: true,
    };
    expect(shouldRegisterPwa(valid)).toBe(true);
    expect(shouldRegisterPwa({ ...valid, production: false })).toBe(false);
    expect(shouldRegisterPwa({ ...valid, secureContext: false })).toBe(false);
    expect(shouldRegisterPwa({ ...valid, serviceWorkerSupported: false })).toBe(false);
    expect(shouldRegisterPwa({ ...valid, configuredOrigin: null })).toBe(false);
    expect(shouldRegisterPwa({ ...valid, origin: "https://10.23.45.10:8443" })).toBe(false);
  });

  it("keeps the base production manifest and HTML metadata on the current exact Origin", () => {
    const index = readFileSync(new URL("../index.html", import.meta.url), "utf8");
    const manifest = JSON.parse(
      readFileSync(new URL("../public/manifest.webmanifest", import.meta.url), "utf8"),
    ) as { id: string; start_url: string; scope: string };
    expect(index).toContain(
      `<meta name="naru-canonical-origin" content="${PUBLIC_PWA_BUILD_FIXTURE_ORIGIN}" />`,
    );
    expect(index).toContain('<meta name="naru-app-base-path" content="/" />');
    expect(readConfiguredAppBasePath(metaSource("/naru"))).toBe("/naru");
    expect(manifest).toMatchObject({
      id: "/naru/",
      start_url: "/naru/?source=pwa",
      scope: "/naru/",
    });
  });
});

function metaSource(...origins: readonly string[]): CanonicalOriginMetaSource {
  return {
    querySelectorAll: () =>
      origins.map((origin) => ({
        getAttribute: (name: string) => (name === "content" ? origin : null),
      })),
  };
}
