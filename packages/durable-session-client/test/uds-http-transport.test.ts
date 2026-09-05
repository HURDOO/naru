import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DurableSessionCallerContext } from "@naru/contracts/durable-session/v0";
import { afterEach, describe, expect, it } from "vitest";
import { DurableSessionClient } from "../src/client.js";
import { UdsHttpDurableSessionTransport } from "../src/uds-http-transport.js";

const REQUEST_ID = "70000000-0000-4000-8000-000000000001";
const CREDENTIAL = "fixture-client-credential-0123456789-ABCDEFGHIJ";
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolvePromise, reject) =>
            server.close((error) => (error ? reject(error) : resolvePromise())),
          ),
      ),
  );
});

describe("UdsHttpDurableSessionTransport", () => {
  it("sends the authenticated public envelope over a private Unix socket", async () => {
    const root = privateTemporaryDirectory();
    const socketPath = join(root, "host.sock");
    let observedAuthorization: string | undefined;
    let observedAppId: string | undefined;
    const server = createServer((request, response) => {
      observedAuthorization = request.headers.authorization;
      observedAppId = request.headers["x-durable-session-app-id"] as string | undefined;
      void writeListResponse(request, response).catch(() => {
        response.statusCode = 500;
        response.end();
      });
    });
    await listen(server, socketPath);

    const client = fixtureClient(socketPath);
    const result = await client.request({ operation: "listSessions", limit: 10 });

    expect(result).toEqual({ operation: "listSessions", sessions: [], nextCursor: null });
    expect(observedAuthorization).toBe(`Bearer ${CREDENTIAL}`);
    expect(observedAppId).toBe("fixture-app");
  });

  it("rejects non-socket endpoints before sending credentials", async () => {
    const root = privateTemporaryDirectory();
    const socketPath = join(root, "host.sock");
    writeFileSync(socketPath, "preserve", { mode: 0o600 });

    await expect(
      fixtureClient(socketPath).request({ operation: "listSessions", limit: 10 }),
    ).rejects.toMatchObject({ code: "PRIVATE_ENDPOINT_INVALID" });
  });

  it("bounds and validates transport responses", async () => {
    const invalidRoot = privateTemporaryDirectory();
    const invalidSocket = join(invalidRoot, "host.sock");
    await listen(
      createServer((_request, response) => response.end("not-json")),
      invalidSocket,
    );
    await expect(
      fixtureClient(invalidSocket).request({ operation: "listSessions", limit: 10 }),
    ).rejects.toMatchObject({ code: "TRANSPORT_RESPONSE_INVALID" });

    const largeRoot = privateTemporaryDirectory();
    const largeSocket = join(largeRoot, "host.sock");
    await listen(
      createServer((_request, response) =>
        response.end(JSON.stringify({ value: "x".repeat(512) })),
      ),
      largeSocket,
    );
    await expect(
      fixtureClient(largeSocket, 64).request({ operation: "listSessions", limit: 10 }),
    ).rejects.toMatchObject({ code: "TRANSPORT_RESPONSE_INVALID" });
  });
});

async function writeListResponse(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = JSON.parse(await readBody(request)) as {
    readonly request: { readonly requestId: string };
  };
  response.setHeader("content-type", "application/json");
  response.end(
    JSON.stringify({
      version: 0,
      requestId: body.request.requestId,
      ok: true,
      result: { operation: "listSessions", sessions: [], nextCursor: null },
    }),
  );
}

function fixtureClient(socketPath: string, responseBytes?: number): DurableSessionClient {
  return new DurableSessionClient({
    transport: new UdsHttpDurableSessionTransport({
      socketPath,
      appId: "fixture-app",
      credential: CREDENTIAL,
      ...(responseBytes === undefined ? {} : { responseBytes }),
    }),
    callerContext: caller(),
    requestId: () => REQUEST_ID,
  });
}

function caller(): DurableSessionCallerContext {
  return {
    appId: "fixture-app",
    subject: "fixture-owner",
    capabilities: ["session:observe"],
    sessionScope: { kind: "all" },
    profileScope: { kind: "ids", ids: ["fixture-profile"] },
    rootScope: { kind: "ids", ids: ["fixture-root"] },
    expiresAtMs: 4_000_000_000_000,
  };
}

function privateTemporaryDirectory(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "dsv0-t08-uds-")));
  chmodSync(root, 0o700);
  return root;
}

async function listen(server: Server, socketPath: string): Promise<void> {
  servers.push(server);
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolvePromise);
  });
  chmodSync(socketPath, 0o600);
}

async function readBody(request: AsyncIterable<unknown>): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks).toString("utf8");
}
