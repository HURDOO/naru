import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, it, vi } from "vitest";
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

  it("requires TLS bootstrap and binds direct mode to the selected active private address", async () => {
    const { config } = createDirectGatewayTestFixture();
    expect(() => createGatewayBrowserListener(config)).toThrow(
      "Direct private TLS material provider is not configured.",
    );

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
    expect(listener.httpsOptions).toMatchObject({ minVersion: "TLSv1.2" });
    expect(server.listen).toHaveBeenCalledOnce();
    expect(server.listen).toHaveBeenCalledWith({ host: "10.44.0.2", port: 8_443 });
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
} {
  const listen = vi.fn(() => Promise.resolve("fixture-listener"));
  return { port: { listen }, listen };
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
