import { chmodSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { InMemoryGatewayReplayStore, verifyGatewayAssertion } from "@naru/gateway-verifier";
import { describe, expect, it } from "vitest";
import { WorkstationGateway } from "../src/gateway.js";
import { gatewayVerifierKey } from "../src/keys.js";
import { createGatewayTestFixture } from "./support.js";

describe("Gateway private UDS upstream", () => {
  it("proxies only to an owner-private real socket and rejects mode drift", async () => {
    const { config } = createGatewayTestFixture();
    const managed = config.appRegistrations[0];
    if (managed?.mode !== "gateway-managed" || managed.upstream.kind !== "uds") {
      throw new Error("Fixture UDS app is missing.");
    }
    let assertion: string | undefined;
    const upstream = createServer((request, response) => {
      assertion = singleHeader(request.headers["x-workstation-gateway-assertion"]);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ path: request.url, hasAssertion: assertion !== undefined }));
    });
    upstream.listen(managed.upstream.socketPath);
    await once(upstream, "listening");
    chmodSync(managed.upstream.socketPath, 0o600);

    const gateway = await WorkstationGateway.create(config);
    gateway.repository.createCredential({
      credentialRecordId: "credential-record-uds",
      credentialId: "raw-uds-credential",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: [],
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: gateway.nowMs(),
    });
    const session = gateway.sessions.create({
      subject: config.ownerSubject,
      credentialRecordId: "credential-record-uds",
      credentialId: "raw-uds-credential",
      authTime: Math.floor(gateway.nowMs() / 1_000),
    });
    const host = new URL(config.browserOrigin).host;
    const response = await gateway.browser.inject({
      method: "GET",
      url: "/app/uds?fixture=1",
      headers: {
        host,
        origin: config.browserOrigin,
        cookie: `${config.sessionCookieName}=${session.token}`,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ path: "/uds?fixture=1", hasAssertion: true });
    if (assertion === undefined) throw new Error("Gateway UDS assertion is missing.");
    const key = gatewayVerifierKey(gateway.keys);
    expect(
      verifyGatewayAssertion(assertion, {
        expectedIssuer: config.instanceId,
        expectedAudience: managed.appId,
        expectedOrigin: config.browserOrigin,
        resolveKey: (keyId) => (keyId === key.keyId ? key.publicKeyPem : undefined),
        replayStore: new InMemoryGatewayReplayStore(),
        now: () => Math.floor(gateway.nowMs() / 1_000),
      }).principal.aud,
    ).toBe(managed.appId);

    chmodSync(managed.upstream.socketPath, 0o666);
    const drifted = await gateway.browser.inject({
      method: "GET",
      url: "/app/uds",
      headers: {
        host,
        origin: config.browserOrigin,
        cookie: `${config.sessionCookieName}=${session.token}`,
      },
    });
    expect(drifted.statusCode).toBe(502);

    await gateway.close();
    await new Promise<void>((resolvePromise, reject) => {
      upstream.close((error) => (error ? reject(error) : resolvePromise()));
    });
  });
});

function singleHeader(value: string | readonly string[] | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}
