import { chmodSync, mkdirSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkstationAuthIntent, gatewayAdminSocketPath } from "./auth.js";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE } from "./constants.js";
import { createInstanceLayout, createInstanceShortRuntimeRoot } from "./model.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { createDistributionFixture } from "./test-support.js";

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      async (server) =>
        await new Promise<void>((resolvePromise, reject) => {
          server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
        }),
    ),
  );
});

describe("T14 local Workstation auth CLI transport", () => {
  it.each(["bootstrap", "recover"] as const)(
    "creates a short-lived exact-Origin %s intent through the private admin UDS",
    async (operation) => {
      const fixture = createDistributionFixture();
      const socketPath = gatewayAdminSocketPath(fixture.intent);
      expect(socketPath).toBe(
        createInstanceLayout(
          fixture.intent,
          verifyDistributionArtifact(fixture.artifactRoot).summary,
        ).sockets.gatewayAdmin,
      );
      createPrivateRuntimeRoot(createInstanceShortRuntimeRoot(fixture.intent));
      const requests: { method: string | undefined; url: string | undefined; body: string }[] = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => {
          chunks.push(chunk);
        });
        request.once("end", () => {
          requests.push({
            method: request.method,
            url: request.url,
            body: Buffer.concat(chunks).toString(),
          });
          response.statusCode = 201;
          response.setHeader("content-type", "application/json");
          response.end(
            JSON.stringify({
              version: 1,
              intent: {
                intentId: "22222222-2222-4222-8222-222222222222",
                kind: operation,
                code: "fixtureBootstrapCode_1234567890",
                origin: fixture.intent.canonicalBrowserOrigin,
                expiresAt: Date.now() + 5 * 60_000,
              },
            }),
          );
        });
      });
      await listen(server, socketPath);

      const result = await createWorkstationAuthIntent(fixture.intent, operation);

      expect(result).toMatchObject({
        packageId: "kr.hurdoo.naru.workstation",
        status: "created",
        operation,
        origin: fixture.intent.canonicalBrowserOrigin,
        code: "fixtureBootstrapCode_1234567890",
      });
      expect(requests).toEqual([{ method: "POST", url: `/v1/auth/${operation}`, body: "{}" }]);
    },
  );

  it("rejects an admin socket that is not exact mode 0600 before sending a code request", async () => {
    const fixture = createDistributionFixture();
    const socketPath = gatewayAdminSocketPath(fixture.intent);
    createPrivateRuntimeRoot(createInstanceShortRuntimeRoot(fixture.intent));
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.statusCode = 500;
      response.end();
    });
    await listen(server, socketPath);
    chmodSync(socketPath, 0o666);

    await expect(createWorkstationAuthIntent(fixture.intent, "bootstrap")).rejects.toThrow(/0600/);
    expect(requests).toBe(0);
  });
});

function createPrivateRuntimeRoot(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
}

async function listen(server: Server, socketPath: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  servers.push(server);
  chmodSync(socketPath, PRIVATE_FILE_MODE);
}
