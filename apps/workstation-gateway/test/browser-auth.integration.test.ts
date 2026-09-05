import { describe, expect, it } from "vitest";
import { WORKSTATION_GATEWAY_CSRF_HEADER } from "@naru/contracts/workstation-gateway/v1";
import { WorkstationGateway } from "../src/gateway.js";
import { FakeWebAuthn, RAW_CREDENTIAL_ID, registrationResponse } from "./fake-webauthn.js";
import { createGatewayTestFixture, FakeGatewayClock } from "./support.js";

describe("Gateway browser authentication boundary", () => {
  it("keeps managed app content private while serving a no-store passkey pre-auth surface", async () => {
    const { config } = createGatewayTestFixture();
    const gateway = await WorkstationGateway.create(config, { webauthn: new FakeWebAuthn() });
    const host = new URL(config.browserOrigin).host;

    const navigation = await gateway.browser.inject({
      method: "GET",
      url: "/app/workspace?project=fixture",
      headers: { host, accept: "text/html", "sec-fetch-mode": "navigate" },
    });
    expect(navigation.statusCode).toBe(303);
    expect(navigation.headers.location).toBe(
      "/_gateway/login?return=%2Fapp%2Fworkspace%3Fproject%3Dfixture",
    );

    const page = await gateway.browser.inject({
      method: "GET",
      url: String(navigation.headers.location),
      headers: { host, accept: "text/html" },
    });
    expect(page.statusCode).toBe(200);
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(page.body).toContain("패스키로 로그인");
    expect(page.body).toContain("로컬 bootstrap code");
    expect(page.body).toContain('const returnTo = "/app/workspace?project=fixture"');
    expect(page.body).not.toContain("passwordFallback");

    const unsafeReturn = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/login?return=https%3A%2F%2Fevil.invalid%2Fsteal",
      headers: { host, accept: "text/html" },
    });
    expect(unsafeReturn.statusCode).toBe(200);
    expect(unsafeReturn.body).toContain('const returnTo = "/app"');
    expect(unsafeReturn.body).not.toContain("evil.invalid");

    const escapedReturn = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/login?return=%2Fapp%3Fquery%3D%3C%2Fscript%3E",
      headers: { host, accept: "text/html" },
    });
    expect(escapedReturn.statusCode).toBe(200);
    expect(escapedReturn.body).not.toContain('const returnTo = "/app?query=</script>"');
    expect(escapedReturn.body).toContain("/app?query=%3C/script%3E");

    const apiRequest = await gateway.browser.inject({
      method: "GET",
      url: "/app/api/private",
      headers: { host, accept: "application/json" },
    });
    expect(apiRequest.statusCode).toBe(401);
    await gateway.close();
  });

  it("completes local bootstrap registration into a hardened opaque cookie session", async () => {
    const { config } = createGatewayTestFixture();
    const gateway = await WorkstationGateway.create(config, { webauthn: new FakeWebAuthn() });
    const host = new URL(config.browserOrigin).host;
    const intent = gateway.passkeys.createBootstrapIntent("bootstrap");
    const options = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/registration/options",
      headers: { host, origin: config.browserOrigin, "content-type": "application/json" },
      payload: { code: intent.code },
    });
    expect(options.statusCode).toBe(200);
    const ceremonyId = options.json<{ ceremonyId: string }>().ceremonyId;
    const verified = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/registration/verify",
      headers: { host, origin: config.browserOrigin, "content-type": "application/json" },
      payload: { ceremonyId, response: registrationResponse },
    });
    expect(verified.statusCode).toBe(200);
    const setCookie = String(verified.headers["set-cookie"]);
    expect(setCookie).toContain(`${config.sessionCookieName}=`);
    expect(setCookie).toContain("Secure");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Path=/");
    expect(setCookie).not.toContain("Domain=");
    expect(verified.body).not.toContain(RAW_CREDENTIAL_ID);
    const body = verified.json<{ csrfToken: string }>();
    const cookie = setCookie.split(";", 1)[0];
    expect(cookie).toBeDefined();
    expect(verified.body).not.toContain(cookie ?? "missing-cookie");

    const restored = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/session",
      headers: { host, cookie: cookie ?? "" },
    });
    expect(restored.statusCode).toBe(200);
    expect(
      restored.json<{ csrfToken: string; session: { browserOrigin: string } }>(),
    ).toMatchObject({
      session: { browserOrigin: config.browserOrigin },
    });
    expect(restored.json<{ csrfToken: string }>().csrfToken).not.toBe(body.csrfToken);

    const denied = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/logout",
      headers: {
        host,
        origin: config.browserOrigin,
        cookie: cookie ?? "",
        "content-type": "application/json",
        [WORKSTATION_GATEWAY_CSRF_HEADER]: body.csrfToken,
      },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);
    await gateway.close();
  });

  it("rejects wrong host/origin, oversized unknown fields, and missing JSON media type", async () => {
    const { config } = createGatewayTestFixture();
    const gateway = await WorkstationGateway.create(config, { webauthn: new FakeWebAuthn() });
    const intent = gateway.passkeys.createBootstrapIntent("bootstrap");
    const host = new URL(config.browserOrigin).host;
    const wrongHost = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/registration/options",
      headers: {
        host: "wrong.invalid",
        origin: config.browserOrigin,
        "content-type": "application/json",
      },
      payload: { code: intent.code },
    });
    expect(wrongHost.statusCode).toBe(403);
    const wrongOrigin = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/registration/options",
      headers: {
        host,
        origin: "https://wrong.invalid",
        "content-type": "application/json",
      },
      payload: { code: intent.code },
    });
    expect(wrongOrigin.statusCode).toBe(403);
    const unknownField = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/registration/options",
      headers: { host, origin: config.browserOrigin, "content-type": "application/json" },
      payload: { code: intent.code, passwordFallback: "forbidden" },
    });
    expect(unknownField.statusCode).toBe(400);
    const wrongType = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/auth/registration/options",
      headers: { host, origin: config.browserOrigin, "content-type": "text/plain" },
      payload: JSON.stringify({ code: intent.code }),
    });
    expect(wrongType.statusCode).toBe(415);
    await gateway.close();
  });

  it("does not let a failed CSRF attempt extend session idle lifetime", async () => {
    const { config } = createGatewayTestFixture();
    const clock = new FakeGatewayClock();
    const gateway = await WorkstationGateway.create(config, { clock });
    gateway.repository.createCredential({
      credentialRecordId: "credential-record-csrf-idle",
      credentialId: "raw-credential-csrf-idle",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: [],
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: clock.nowMs(),
    });
    const session = gateway.sessions.create({
      subject: config.ownerSubject,
      credentialRecordId: "credential-record-csrf-idle",
      credentialId: "raw-credential-csrf-idle",
      authTime: Math.floor(clock.nowMs() / 1_000),
    });
    const headers = {
      host: new URL(config.browserOrigin).host,
      origin: config.browserOrigin,
      cookie: `${config.sessionCookieName}=${session.token}`,
      "content-type": "application/json",
    };
    clock.value += config.sessionIdleTtlMs - 1;
    const denied = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/logout",
      headers: { ...headers, [WORKSTATION_GATEWAY_CSRF_HEADER]: "wrong" },
      payload: {},
    });
    expect(denied.statusCode).toBe(403);

    clock.value += 2;
    const expired = await gateway.browser.inject({
      method: "GET",
      url: "/_gateway/session",
      headers: { host: headers.host, cookie: headers.cookie },
    });
    expect(expired.statusCode).toBe(401);
    await gateway.close();
  });

  it("accepts only the namespaced Gateway CSRF header", async () => {
    const { config } = createGatewayTestFixture();
    const gateway = await WorkstationGateway.create(config);
    gateway.repository.createCredential({
      credentialRecordId: "credential-record-namespaced-csrf",
      credentialId: "raw-credential-namespaced-csrf",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: [],
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: gateway.nowMs(),
    });
    const session = gateway.sessions.create({
      subject: config.ownerSubject,
      credentialRecordId: "credential-record-namespaced-csrf",
      credentialId: "raw-credential-namespaced-csrf",
      authTime: Math.floor(gateway.nowMs() / 1_000),
    });
    const headers = {
      host: new URL(config.browserOrigin).host,
      origin: config.browserOrigin,
      cookie: `${config.sessionCookieName}=${session.token}`,
      "content-type": "application/json",
    };
    const legacy = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/logout",
      headers: { ...headers, "x-csrf-token": session.csrfToken },
      payload: {},
    });
    expect(legacy.statusCode).toBe(403);

    const accepted = await gateway.browser.inject({
      method: "POST",
      url: "/_gateway/logout",
      headers: { ...headers, [WORKSTATION_GATEWAY_CSRF_HEADER]: session.csrfToken },
      payload: {},
    });
    expect(accepted.statusCode).toBe(204);
    await gateway.close();
  });
});
