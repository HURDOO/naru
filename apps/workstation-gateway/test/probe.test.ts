import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { NodeNetworkProbeAdapter } from "../src/ingress/probe.js";

describe("NodeNetworkProbeAdapter", () => {
  const servers: ReturnType<typeof createServer>[] = [];

  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolvePromise, reject) => {
            server.close((error) => (error === undefined ? resolvePromise() : reject(error)));
          }),
      ),
    );
  });

  it("uses the canonical ingress Host when probing a loopback Gateway listener", async () => {
    const server = createServer((request, response) => {
      response.statusCode =
        request.headers.host === "gateway.fixture.ts.net" && request.url === "/_gateway/readyz"
          ? 200
          : 403;
      response.end();
    });
    servers.push(server);
    await new Promise<void>((resolvePromise, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolvePromise);
    });
    const port = (server.address() as AddressInfo).port;

    await expect(
      new NodeNetworkProbeAdapter().probeHealth(
        {
          kind: "loopback-http",
          origin: `http://127.0.0.1:${port}`,
          path: "/_gateway/readyz",
        },
        { hostHeader: "gateway.fixture.ts.net" },
      ),
    ).resolves.toEqual({ reachable: true, healthy: true, actual: "HTTP 200" });
  });
});
