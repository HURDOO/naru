import { describe, expect, it } from "vitest";
import type {
  ExternalCommandResult,
  ExternalCommandRunner,
} from "../src/ingress/process-runner.js";
import {
  TailscaleCliAdapter,
  assertAllowedMutationArguments,
  conflictingRoutes,
  matchingRoute,
  parseTailscaleState,
  tailscaleDisableArguments,
  tailscaleEnableArguments,
} from "../src/ingress/tailscale.js";
import type { TailscaleRouteResource } from "../src/ingress/model.js";

const resource: TailscaleRouteResource = {
  profileId: "tailscale-main",
  hostPort: "workstation.tailnet.ts.net:443",
  httpsPort: 443,
  mountPath: "/",
  proxy: "http://127.0.0.1:49100",
};

describe("strict Tailscale adapter", () => {
  it("parses node, service, plain HTTP, TCP, and Funnel routes", () => {
    const state = parseTailscaleState(
      { short: "1.98.2" },
      {
        BackendState: "Running",
        Self: {
          DNSName: "workstation.tailnet.ts.net.",
          TailscaleIPs: ["100.64.0.1", "fd7a::1"],
          CapMap: { https: null },
        },
      },
      {
        TCP: {
          443: { HTTPS: true },
          8080: { HTTP: true },
          2222: { TCPForward: "127.0.0.1:22" },
        },
        Web: {
          "workstation.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:49100" } },
          },
          "workstation.tailnet.ts.net:8080": {
            Handlers: { "/plain": { Proxy: "http://127.0.0.1:49200" } },
          },
        },
        AllowFunnel: { "workstation.tailnet.ts.net:443": true },
        Services: {
          "svc:fixture": {
            TCP: { 443: { HTTPS: true } },
            Web: {
              "fixture.tailnet.ts.net:443": {
                Handlers: { "/": { Proxy: "http://127.0.0.1:49300" } },
              },
            },
          },
        },
      },
      {
        TCP: { 443: { HTTPS: true } },
        Web: {
          "workstation.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:49100" } },
          },
        },
        AllowFunnel: { "workstation.tailnet.ts.net:443": true },
      },
    );
    expect(state.version).toBe("1.98.2");
    expect(state.httpsEnabled).toBe(true);
    expect(state.selfDnsName).toBe("workstation.tailnet.ts.net");
    expect(state.routes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ hostPort: resource.hostPort, protocol: "https", funnel: true }),
        expect.objectContaining({ hostPort: "workstation.tailnet.ts.net:8080", protocol: "http" }),
        expect.objectContaining({ hostPort: "*:2222", protocol: "tcp" }),
        expect.objectContaining({ hostPort: "fixture.tailnet.ts.net:443", source: "service" }),
      ]),
    );
    expect(matchingRoute(state, resource)).toMatchObject({ proxy: resource.proxy, funnel: true });
  });

  it("rejects ambiguous upstream JSON instead of guessing HTTPS", () => {
    expect(() =>
      parseTailscaleState(
        { version: "1.98.2" },
        { BackendState: "Running", Self: {} },
        {
          TCP: { 443: { HTTPS: true, HTTP: true } },
          Web: { "fixture.ts.net:443": { Handlers: { "/": { Proxy: "http://127.0.0.1:1" } } } },
        },
        {},
      ),
    ).toThrow(/ambiguous/);
  });

  it("allows only exact route-level Serve enable and disable argv", () => {
    expect(tailscaleEnableArguments(resource)).toEqual([
      "serve",
      "--bg",
      "--https=443",
      "--set-path=/",
      "http://127.0.0.1:49100",
    ]);
    expect(tailscaleDisableArguments(resource)).toEqual([
      "serve",
      "--https=443",
      "--set-path=/",
      "off",
    ]);
    for (const args of [
      ["serve", "reset"],
      ["serve", "set-config", "--all", "state.json"],
      ["funnel", "--bg", "443"],
      ["up"],
      ["serve", "--bg", "--https=443", "--set-path=/", "http://0.0.0.0:49100"],
      ["serve", "--bg", "--https=99999", "--set-path=/", "http://127.0.0.1:49100"],
    ]) {
      expect(() => assertAllowedMutationArguments(args)).toThrow(/allowlist|Forbidden/);
    }
  });

  it("executes only the four read commands and the two allowlisted mutations", async () => {
    const runner = new FixtureRunner([
      jsonResult({ short: "1.98.2" }),
      jsonResult({
        BackendState: "Running",
        Self: {
          DNSName: "workstation.tailnet.ts.net.",
          Capabilities: ["https"],
        },
      }),
      jsonResult({}),
      jsonResult({}),
      commandResult(),
      commandResult(),
    ]);
    const adapter = new TailscaleCliAdapter("/fixture/tailscale", runner);
    await adapter.inspect();
    await adapter.enable(resource);
    await adapter.disable(resource);
    expect(runner.calls).toEqual([
      ["/fixture/tailscale", ["version", "--json"]],
      ["/fixture/tailscale", ["status", "--json"]],
      ["/fixture/tailscale", ["serve", "status", "--json"]],
      ["/fixture/tailscale", ["funnel", "status", "--json"]],
      ["/fixture/tailscale", tailscaleEnableArguments(resource)],
      ["/fixture/tailscale", tailscaleDisableArguments(resource)],
    ]);
  });

  it("treats a different root handler as a conflict", () => {
    const state = parseTailscaleState(
      { short: "1.98.2" },
      { BackendState: "Running", Self: { DNSName: "workstation.tailnet.ts.net." } },
      {
        TCP: { 443: { HTTPS: true } },
        Web: {
          "workstation.tailnet.ts.net:443": {
            Handlers: { "/": { Proxy: "http://127.0.0.1:49999" } },
          },
        },
      },
      {},
    );
    expect(conflictingRoutes(state, resource)).toHaveLength(1);
    expect(matchingRoute(state, resource)).toBeUndefined();
  });
});

class FixtureRunner implements ExternalCommandRunner {
  readonly calls: [string, readonly string[]][] = [];

  constructor(readonly results: ExternalCommandResult[]) {}

  run(executable: string, args: readonly string[]): Promise<ExternalCommandResult> {
    this.calls.push([executable, args]);
    const result = this.results.shift();
    if (result === undefined) throw new Error("Missing fixture command result.");
    return Promise.resolve(result);
  }
}

function jsonResult(value: unknown): ExternalCommandResult {
  return { exitCode: 0, stdout: JSON.stringify(value), stderr: "" };
}

function commandResult(): ExternalCommandResult {
  return { exitCode: 0, stdout: "", stderr: "" };
}
