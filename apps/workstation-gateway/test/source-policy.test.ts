import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer, request as httpsRequest } from "node:https";
import type { AddressInfo } from "node:net";
import type { TLSSocket } from "node:tls";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import { createTestTlsState } from "../../../packages/tls-material/test/support.js";
import {
  installPrivateIpv4SourceAdmission,
  PrivateIpv4SourceAdmission,
  type GatewaySecureConnectionServer,
} from "../src/listeners/index.js";

describe("Gateway direct private source admission", () => {
  it("admits only exact addresses and inclusive canonical CIDR ranges", () => {
    const admission = new PrivateIpv4SourceAdmission({
      mode: "private-ipv4-allowlist",
      allowedAddresses: ["10.44.0.10"],
      allowedCidrs: ["192.168.50.0/24", "172.20.0.8/30"],
    });

    for (const address of [
      "10.44.0.10",
      "192.168.50.0",
      "192.168.50.255",
      "172.20.0.8",
      "172.20.0.11",
    ]) {
      expect(admission.allows(address), address).toBe(true);
    }
    for (const address of [
      undefined,
      "",
      "10.44.0.11",
      "192.168.49.255",
      "192.168.51.0",
      "172.20.0.7",
      "172.20.0.12",
      "127.0.0.1",
      "203.0.113.9",
      "::1",
      "::ffff:10.44.0.10",
      "10.044.0.10",
    ]) {
      expect(admission.allows(address), String(address)).toBe(false);
    }
  });

  it("destroys denied TLS sockets before the shared HTTP or WebSocket request path", () => {
    const admission = new PrivateIpv4SourceAdmission({
      mode: "private-ipv4-allowlist",
      allowedAddresses: ["10.44.0.10"],
      allowedCidrs: [],
    });
    let listener: ((socket: TLSSocket) => void) | undefined;
    const server: GatewaySecureConnectionServer = {
      prependListener: (_event, installed) => {
        listener = installed;
        return server;
      },
    };
    installPrivateIpv4SourceAdmission(server, admission);

    const allowedDestroy = vi.fn();
    listener?.({ remoteAddress: "10.44.0.10", destroy: allowedDestroy } as unknown as TLSSocket);
    expect(allowedDestroy).not.toHaveBeenCalled();

    for (const remoteAddress of ["10.44.0.11", "::ffff:10.44.0.10", undefined]) {
      const destroy = vi.fn();
      listener?.({ remoteAddress, destroy } as unknown as TLSSocket);
      expect(destroy, String(remoteAddress)).toHaveBeenCalledOnce();
    }
  });

  it("revalidates policies at the runtime boundary", () => {
    expect(
      () =>
        new PrivateIpv4SourceAdmission({
          mode: "private-ipv4-allowlist",
          allowedAddresses: ["203.0.113.9"],
          allowedCidrs: [],
        }),
    ).toThrow();
  });

  it("drops denied real TLS sockets before either HTTP or WebSocket dispatch", async () => {
    const tls = createTestTlsState("gateway.fixture.invalid");
    const generation = tls.createGeneration("source-denied");
    let requests = 0;
    let upgrades = 0;
    const server = createServer(
      {
        key: readFileSync(generation.privateKeyFile),
        cert: readFileSync(generation.certificateFile),
      },
      (_request, response) => {
        requests += 1;
        response.end("must-not-dispatch");
      },
    );
    server.on("upgrade", () => {
      upgrades += 1;
    });
    installPrivateIpv4SourceAdmission(
      server,
      new PrivateIpv4SourceAdmission({
        mode: "private-ipv4-allowlist",
        allowedAddresses: ["10.44.0.10"],
        allowedCidrs: [],
      }),
    );
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as AddressInfo).port;
    try {
      await expect(deniedHttpsRequest(port)).rejects.toBeInstanceOf(Error);
      await expect(deniedWebSocketRequest(port)).resolves.toBeInstanceOf(Error);
      expect(requests).toBe(0);
      expect(upgrades).toBe(0);
    } finally {
      await new Promise<void>((resolvePromise, reject) => {
        server.close((error) => (error ? reject(error) : resolvePromise()));
      });
    }
  });
});

function deniedHttpsRequest(port: number): Promise<void> {
  return new Promise<void>((resolvePromise, reject) => {
    const request = httpsRequest(
      { hostname: "127.0.0.1", port, rejectUnauthorized: false },
      (response) => {
        response.resume();
        response.once("end", resolvePromise);
      },
    );
    request.once("error", reject);
    request.end();
  });
}

function deniedWebSocketRequest(port: number): Promise<Error> {
  return new Promise<Error>((resolvePromise, reject) => {
    const socket = new WebSocket(`wss://127.0.0.1:${port}/socket`, {
      rejectUnauthorized: false,
    });
    socket.once("open", () => reject(new Error("Denied WebSocket unexpectedly opened.")));
    socket.once("error", (error) => resolvePromise(error));
  });
}
