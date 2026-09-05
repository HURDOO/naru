import { existsSync, lstatSync, readFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { WorkstationGateway } from "../src/gateway.js";
import { createGatewayTestFixture } from "./support.js";

describe("Gateway same-user admin IPC", () => {
  it("creates local-only bootstrap intents, exposes verifier material, and revokes passkey sessions", async () => {
    const { config } = createGatewayTestFixture();
    const gateway = await WorkstationGateway.create(config);
    await gateway.admin.listen();
    expect(lstatSync(config.adminSocketPath).isSocket()).toBe(true);
    expect(lstatSync(config.adminSocketPath).mode & 0o777).toBe(0o600);

    const keyResponse = await adminRequest(config.adminSocketPath, "GET", "/v1/verifier-keys");
    expect(keyResponse.statusCode).toBe(200);
    expect(keyResponse.json()).toMatchObject({
      version: 1,
      keys: [{ keyId: gateway.keys.signingKeyId, algorithm: "Ed25519" }],
    });

    const bootstrap = await adminRequest(config.adminSocketPath, "POST", "/v1/auth/bootstrap", {});
    expect(bootstrap.statusCode).toBe(201);
    const bootstrapBody = bootstrap.json() as { intent: { code: string; origin: string } };
    expect(bootstrapBody.intent.origin).toBe(config.browserOrigin);
    expect(bootstrapBody.intent.code.length).toBeGreaterThanOrEqual(20);
    expect(readFileSync(join(config.dataDirectory, "gateway.sqlite"), "latin1")).not.toContain(
      bootstrapBody.intent.code,
    );

    const credentialRecordId = "00000000-0000-4000-8000-000000000091";
    gateway.repository.createCredential({
      credentialRecordId,
      credentialId: "raw-admin-fixture-credential",
      publicKey: new Uint8Array([1, 2, 3]),
      counter: 0,
      transports: [],
      deviceType: "multiDevice",
      backedUp: true,
      createdAt: gateway.nowMs(),
    });
    const session = gateway.sessions.create({
      subject: config.ownerSubject,
      credentialRecordId,
      credentialId: "raw-admin-fixture-credential",
      authTime: Math.floor(gateway.nowMs() / 1_000),
    });
    const revoke = await adminRequest(
      config.adminSocketPath,
      "POST",
      `/v1/credentials/${credentialRecordId}/revoke`,
      {},
    );
    expect(revoke.statusCode).toBe(200);
    expect(revoke.json()).toEqual({ version: 1, revoked: true, sessionsClosed: 1 });
    expect(gateway.sessions.authenticate(session.token)).toBeUndefined();
    expect(
      JSON.stringify(await adminRequest(config.adminSocketPath, "GET", "/v1/credentials")),
    ).not.toContain("raw-admin-fixture-credential");

    await gateway.close();
    expect(existsSync(config.adminSocketPath)).toBe(false);
  });

  it("rejects non-JSON mutation requests and has no password or remote-reset operation", async () => {
    const { config } = createGatewayTestFixture();
    const gateway = await WorkstationGateway.create(config);
    await gateway.admin.listen();
    const wrongContentType = await adminRequest(
      config.adminSocketPath,
      "POST",
      "/v1/auth/bootstrap",
      undefined,
      "text/plain",
    );
    expect(wrongContentType.statusCode).toBe(415);
    for (const path of ["/v1/auth/password", "/v1/auth/reset", "/v1/auth/remote-recover"]) {
      const response = await adminRequest(config.adminSocketPath, "POST", path, {});
      expect(response.statusCode).toBe(404);
    }
    await gateway.close();
  });
});

interface AdminResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
  json(): unknown;
}

async function adminRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: object,
  contentType = "application/json",
): Promise<AdminResponse> {
  const payload = body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body));
  return new Promise<AdminResponse>((resolvePromise, reject) => {
    const request = httpRequest(
      {
        socketPath,
        method,
        path,
        headers:
          method === "POST"
            ? { "content-type": contentType, "content-length": String(payload.byteLength) }
            : {},
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.once("end", () => {
          const source = Buffer.concat(chunks).toString("utf8");
          resolvePromise({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: source,
            json: () => JSON.parse(source) as unknown,
          });
        });
      },
    );
    request.once("error", reject);
    request.end(payload);
  });
}
