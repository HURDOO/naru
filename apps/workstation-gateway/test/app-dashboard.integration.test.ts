import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkstationGatewayConfigSchema } from "../src/config.js";
import { WorkstationGateway } from "../src/gateway.js";
import { createGatewayTestFixture } from "./support.js";

describe("Gateway-owned app dashboard", () => {
  it("authenticates navigation, lists only browser-safe fields, and reports bounded app states", async () => {
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "team/alpha",
          mode: "gateway-managed",
          routePrefix: "/alpha",
          upstream: { kind: "uds", socketPath: join(fixture.root, "u", "alpha.sock") },
        },
        {
          appId: "beta",
          mode: "gateway-managed",
          routePrefix: "/beta",
          upstream: { kind: "loopback", origin: "http://127.0.0.1:1" },
        },
        {
          appId: "disabled-fixture",
          mode: "gateway-managed",
          routePrefix: "/disabled",
          upstream: { kind: "uds", socketPath: join(fixture.root, "u", "disabled.sock") },
          enabled: false,
        },
        {
          appId: "standalone-fixture",
          mode: "app-managed",
          origin: "https://standalone.fixture.invalid",
        },
        {
          appId: "standalone-disabled",
          mode: "app-managed",
          origin: "https://disabled.fixture.invalid",
          enabled: false,
        },
      ],
    });
    const gateway = await WorkstationGateway.create(config);
    const host = new URL(config.browserOrigin).host;

    const navigation = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: { host, accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(navigation.statusCode).toBe(303);
    expect(navigation.headers.location).toBe("/_gateway/login?return=%2F_gateway%2Fapps");
    const login = await gateway.browser.inject({
      method: "GET",
      url: String(navigation.headers.location),
      headers: { host, accept: "text/html" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('const returnTo = "/_gateway/apps"');

    const unauthenticatedApi = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: { host, accept: "application/json" },
    });
    expect(unauthenticatedApi.statusCode).toBe(401);

    const session = seedSession(gateway);
    const authenticatedHeaders = {
      host,
      cookie: `${config.sessionCookieName}=${session.token}`,
    };
    const wrongOrigin = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: { ...authenticatedHeaders, origin: "https://wrong.invalid" },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const wrongHost = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: { ...authenticatedHeaders, host: "wrong.invalid" },
    });
    expect(wrongHost.statusCode).toBe(403);

    const dashboard = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: authenticatedHeaders,
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.headers["cache-control"]).toBe("no-store");
    expect(dashboard.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(dashboard.headers["referrer-policy"]).toBe("no-referrer");
    expect(dashboard.body).toContain("team/alpha");
    expect(dashboard.body).toContain('href="/alpha/"');
    expect(dashboard.body).not.toContain('href="/team/alpha"');
    expect(dashboard.body).toContain('href="/beta/"');
    expect(dashboard.body).toContain("disabled-fixture");
    expect(dashboard.body).toContain("비활성");
    expect(dashboard.body).toContain('href="https://standalone.fixture.invalid"');
    expect(dashboard.body).toContain("standalone-disabled");
    expect(dashboard.body).not.toContain("https://disabled.fixture.invalid");
    expect(dashboard.body).not.toContain("127.0.0.1");
    expect(dashboard.body).not.toContain(fixture.root);
    expect(dashboard.body).not.toContain("socketPath");
    expect(dashboard.body).not.toContain(session.token);

    const unavailable = await gateway.browser.inject({
      method: "GET",
      url: "/beta/inspect",
      headers: authenticatedHeaders,
    });
    expect(unavailable.statusCode).toBe(502);
    expect(unavailable.json()).toMatchObject({
      ok: false,
      error: { code: "APP_UNAVAILABLE", message: "Gateway managed app is unavailable." },
    });
    expect(unavailable.body).not.toContain("127.0.0.1");
    expect(unavailable.body).not.toContain("http://127.0.0.1:1");

    const updatedDashboard = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: authenticatedHeaders,
    });
    expect(updatedDashboard.statusCode).toBe(200);
    expect(updatedDashboard.body).toContain("연결 오류");
    expect(updatedDashboard.body).not.toContain("127.0.0.1");

    for (const path of ["/disabled", "/missing", "/_gateway/apps/missing"]) {
      const response = await gateway.browser.inject({
        method: "GET",
        url: path,
        headers: authenticatedHeaders,
      });
      expect(response.statusCode, path).toBe(404);
      expect(response.body, path).not.toContain(fixture.root);
      expect(response.body, path).not.toContain("127.0.0.1");
    }
    await gateway.close();
  });

  it("keeps the reserved dashboard ahead of a root app registration", async () => {
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "root-app",
          mode: "gateway-managed",
          routePrefix: "/",
          upstream: { kind: "loopback", origin: "http://127.0.0.1:1" },
        },
      ],
    });
    const gateway = await WorkstationGateway.create(config);
    const session = seedSession(gateway);
    const response = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: {
        host: new URL(config.browserOrigin).host,
        cookie: `${config.sessionCookieName}=${session.token}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("root-app");
    expect(response.body).not.toContain("127.0.0.1");
    const rootWorker = await gateway.browser.inject({
      method: "GET",
      url: "/sw.js",
      headers: {
        host: new URL(config.browserOrigin).host,
        cookie: `${config.sessionCookieName}=${session.token}`,
      },
    });
    expect(rootWorker.statusCode).toBe(502);
    expect(rootWorker.body).not.toContain("legacy root service-worker retirement");
    await gateway.close();
  });

  it("serves the dashboard at root without a root app and canonicalizes app prefixes", async () => {
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "naru",
          mode: "gateway-managed",
          routePrefix: "/naru",
          upstream: { kind: "loopback", origin: "http://127.0.0.1:1" },
        },
      ],
    });
    const gateway = await WorkstationGateway.create(config);
    const session = seedSession(gateway);
    const headers = {
      host: new URL(config.browserOrigin).host,
      cookie: `${config.sessionCookieName}=${session.token}`,
    };
    const dashboard = await gateway.browser.inject({ method: "GET", url: "/", headers });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain('href="/naru/"');

    const unauthenticatedRetirementWorker = await gateway.browser.inject({
      method: "GET",
      url: "/sw.js",
      headers: { host: headers.host },
    });
    expect(unauthenticatedRetirementWorker.statusCode).toBe(401);

    const retirementWorker = await gateway.browser.inject({
      method: "GET",
      url: "/sw.js",
      headers,
    });
    expect(retirementWorker.statusCode).toBe(200);
    expect(retirementWorker.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(retirementWorker.headers["content-type"]).toContain("application/javascript");
    expect(retirementWorker.headers["service-worker-allowed"]).toBe("/");
    expect(retirementWorker.body).toContain("naru-app-shell:/:");
    expect(retirementWorker.body).toContain("self.registration.unregister()");
    expect(retirementWorker.body).not.toContain('self.addEventListener("fetch"');

    const canonical = await gateway.browser.inject({
      method: "GET",
      url: "/naru?source=dashboard",
      headers,
    });
    expect(canonical.statusCode).toBe(308);
    expect(canonical.headers.location).toBe("/naru/?source=dashboard");
    await gateway.close();
  });

  it("uses the dashboard as the safe login destination for app-managed-only inventory", async () => {
    const fixture = createGatewayTestFixture();
    const config = WorkstationGatewayConfigSchema.parse({
      ...fixture.config,
      appRegistrations: [
        {
          appId: "standalone-only",
          mode: "app-managed",
          origin: "https://standalone.fixture.invalid",
        },
      ],
    });
    const gateway = await WorkstationGateway.create(config);
    const host = new URL(config.browserOrigin).host;
    const login = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/login",
      headers: { host, accept: "text/html" },
    });
    expect(login.statusCode).toBe(200);
    expect(login.body).toContain('const returnTo = "/"');

    const session = seedSession(gateway);
    const dashboard = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/apps",
      headers: {
        host,
        cookie: `${config.sessionCookieName}=${session.token}`,
      },
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("standalone-only");
    expect(dashboard.body).toContain('href="https://standalone.fixture.invalid"');
    await gateway.close();
  });
});

function seedSession(gateway: WorkstationGateway) {
  gateway.repository.createCredential({
    credentialRecordId: "credential-record-dashboard",
    credentialId: "raw-browser-credential-dashboard",
    publicKey: new Uint8Array([1, 2, 3]),
    counter: 0,
    transports: [],
    deviceType: "multiDevice",
    backedUp: true,
    createdAt: gateway.nowMs(),
  });
  return gateway.sessions.create({
    subject: gateway.config.ownerSubject,
    credentialRecordId: "credential-record-dashboard",
    credentialId: "raw-browser-credential-dashboard",
    authTime: Math.floor(gateway.nowMs() / 1_000),
  });
}
