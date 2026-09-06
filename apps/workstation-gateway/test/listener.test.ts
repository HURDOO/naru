import type { NetworkInterfaceInfo } from "node:os";
import type { Socket } from "node:net";
import type { TLSSocket } from "node:tls";
import { describe, expect, it, vi } from "vitest";
import { GATEWAY_BROWSER_LIMITS } from "../src/browser-security.js";
import {
  assertActiveLocalPrivateIpv4,
  createGatewayBrowserListener,
} from "../src/listeners/index.js";
import type { GatewayBrowserServerPort } from "../src/listeners/types.js";
import { createDirectGatewayTestFixture, createGatewayTestFixture } from "./support.js";

describe("Gateway browser listener adapters", () => {
  it("keeps legacy loopback binding exact", async () => {
    const { config } = createGatewayTestFixture({ listenPort: 49_199 });
    const listener = createGatewayBrowserListener(config);
    const server = fakeBrowserServer();

    await listener.listen(server.port);

    expect(listener.kind).toBe("loopback-proxy");
    expect(listener.httpsOptions).toBeUndefined();
    expect(server.listen).toHaveBeenCalledOnce();
    expect(server.listen).toHaveBeenCalledWith({ host: "127.0.0.1", port: 49_199 });
  });

  it("fails closed on invalid default material and binds valid direct dependencies exactly", async () => {
    const { config } = createDirectGatewayTestFixture();
    expect(() => createGatewayBrowserListener(config)).toThrow("TLS material is invalid.");

    const listener = createGatewayBrowserListener(config, {
      directTlsBootstrap: {
        loadInitial: () => ({ key: "fixture-key", cert: "fixture-certificate" }),
      },
      networkInterfaces: () => ({
        utunFixture: [privateInterface("10.44.0.2")],
      }),
    });
    const server = fakeBrowserServer();

    await listener.listen(server.port);

    expect(listener.kind).toBe("direct-private-tls");
    expect(listener.httpsOptions).toMatchObject({
      minVersion: "TLSv1.2",
      maxHeaderSize: GATEWAY_BROWSER_LIMITS.headerBytes,
      headersTimeout: GATEWAY_BROWSER_LIMITS.headersTimeoutMs,
      requestTimeout: GATEWAY_BROWSER_LIMITS.requestTimeoutMs,
      keepAliveTimeout: GATEWAY_BROWSER_LIMITS.keepAliveTimeoutMs,
    });
    expect(server.listen).toHaveBeenCalledOnce();
    expect(server.listen).toHaveBeenCalledWith({ host: "10.44.0.2", port: 8_443 });
    expect(server.prependListener).toHaveBeenCalledTimes(2);

    const admitted = fakeTlsSocket("10.44.0.10");
    server.secureConnection(admitted.socket);
    expect(admitted.destroy).not.toHaveBeenCalled();

    const denied = fakeTlsSocket("10.44.0.11");
    server.secureConnection(denied.socket);
    expect(denied.destroy).toHaveBeenCalledOnce();
  });

  it("drops new raw connections when the last-known-good certificate is expired", async () => {
    const { config } = createDirectGatewayTestFixture();
    const listener = createGatewayBrowserListener(config, {
      directTlsBootstrap: {
        loadInitial: () => ({ key: "fixture-key", cert: "fixture-certificate" }),
        acceptsNewConnections: () => false,
      },
      networkInterfaces: () => ({
        utunFixture: [privateInterface("10.44.0.2")],
      }),
    });
    const server = fakeBrowserServer();
    await listener.listen(server.port);
    const connection = fakeRawSocket();

    server.connection(connection.socket);

    expect(connection.destroy).toHaveBeenCalledOnce();
  });

  it("fails closed before bind when the configured private address is not active", async () => {
    const { config } = createDirectGatewayTestFixture();
    const listener = createGatewayBrowserListener(config, {
      directTlsBootstrap: {
        loadInitial: () => ({ key: "fixture-key", cert: "fixture-certificate" }),
      },
      networkInterfaces: () => ({
        enFixture: [privateInterface("192.168.50.2")],
      }),
    });
    const server = fakeBrowserServer();

    await expect(listener.listen(server.port)).rejects.toThrow(
      "Direct private listener address is not active on a local IPv4 interface.",
    );
    expect(server.listen).not.toHaveBeenCalled();
  });

  it("does not admit wildcard or public addresses even if an interface inventory reports them", () => {
    for (const host of ["0.0.0.0", "203.0.113.2"]) {
      expect(() =>
        assertActiveLocalPrivateIpv4(host, {
          enFixture: [privateInterface("203.0.113.2")],
        }),
      ).toThrow("Direct private listener address is not active on a local IPv4 interface.");
    }
  });
});

function fakeBrowserServer(): {
  readonly port: GatewayBrowserServerPort;
  readonly listen: ReturnType<typeof vi.fn>;
  readonly prependListener: ReturnType<typeof vi.fn>;
  secureConnection(socket: TLSSocket): void;
  connection(socket: Socket): void;
} {
  const listen = vi.fn(() => Promise.resolve("fixture-listener"));
  let secureConnectionListener: ((socket: TLSSocket) => void) | undefined;
  let connectionListener: ((socket: Socket) => void) | undefined;
  const rawServer = {
    prependListener: vi.fn(
      (event: string, listener: (socket: TLSSocket | Socket) => void): unknown => {
        if (event === "secureConnection") {
          secureConnectionListener = listener;
        }
        if (event === "connection") connectionListener = listener;
        return rawServer;
      },
    ),
  };
  return {
    port: { server: rawServer, listen },
    listen,
    prependListener: rawServer.prependListener,
    secureConnection: (socket) => {
      if (secureConnectionListener === undefined) {
        throw new Error("Secure connection listener was not installed.");
      }
      secureConnectionListener(socket);
    },
    connection: (socket) => {
      if (connectionListener === undefined) {
        throw new Error("Raw connection listener was not installed.");
      }
      connectionListener(socket);
    },
  };
}

function fakeTlsSocket(remoteAddress: string | undefined): {
  readonly socket: TLSSocket;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn();
  return {
    socket: { remoteAddress, destroy } as unknown as TLSSocket,
    destroy,
  };
}

function fakeRawSocket(): {
  readonly socket: Socket;
  readonly destroy: ReturnType<typeof vi.fn>;
} {
  const destroy = vi.fn();
  return { socket: { destroy } as unknown as Socket, destroy };
}

function privateInterface(address: string): NetworkInterfaceInfo {
  return {
    address,
    netmask: "255.255.255.0",
    family: "IPv4",
    mac: "00:00:5e:00:53:01",
    internal: false,
    cidr: `${address}/24`,
  };
}
