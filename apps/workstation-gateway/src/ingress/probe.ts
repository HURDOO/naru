import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { assertPrivateUnixSocket } from "../security.js";
import type { NetworkHealthProbe } from "./config.js";

export interface NetworkProbeResult {
  readonly reachable: boolean;
  readonly healthy: boolean;
  readonly actual: string;
}

export interface NetworkProbePort {
  probeOrigin(origin: string, path: string): Promise<NetworkProbeResult>;
  probeHealth(
    probe: NetworkHealthProbe,
    options?: NetworkHealthProbeOptions,
  ): Promise<NetworkProbeResult>;
}

export interface NetworkHealthProbeOptions {
  readonly hostHeader?: string;
}

export class NodeNetworkProbeAdapter implements NetworkProbePort {
  constructor(
    readonly timeoutMs = 5_000,
    readonly maxResponseBytes = 64 * 1024,
  ) {}

  probeOrigin(origin: string, path: string): Promise<NetworkProbeResult> {
    const target = new URL(path, `${origin}/`);
    if (target.origin !== origin || target.protocol !== "https:") {
      return Promise.reject(new Error("Ingress probe must stay on its exact HTTPS Origin."));
    }
    return this.#request({ target, health: false });
  }

  probeHealth(
    probe: NetworkHealthProbe,
    options: NetworkHealthProbeOptions = {},
  ): Promise<NetworkProbeResult> {
    if (probe.kind === "uds-http") {
      assertPrivateUnixSocket(probe.socketPath);
      return this.#request({ socketPath: probe.socketPath, path: probe.path, health: true });
    }
    const target = new URL(probe.path, `${probe.origin}/`);
    if (target.origin !== probe.origin) {
      return Promise.reject(new Error("Health probe escaped its configured loopback Origin."));
    }
    return this.#request({
      target,
      health: true,
      ...(options.hostHeader === undefined ? {} : { hostHeader: options.hostHeader }),
    });
  }

  #request(
    input:
      | { readonly target: URL; readonly health: boolean; readonly hostHeader?: string }
      | { readonly socketPath: string; readonly path: string; readonly health: boolean },
  ): Promise<NetworkProbeResult> {
    return new Promise((resolve) => {
      const isTarget = "target" in input;
      const request = isTarget && input.target.protocol === "https:" ? httpsRequest : httpRequest;
      const client = request(
        isTarget
          ? {
              protocol: input.target.protocol,
              hostname: input.target.hostname,
              port: input.target.port,
              path: `${input.target.pathname}${input.target.search}`,
              method: "GET",
              headers: {
                accept: "application/json",
                ...(input.hostHeader === undefined ? {} : { host: input.hostHeader }),
              },
              timeout: this.timeoutMs,
            }
          : {
              socketPath: input.socketPath,
              path: input.path,
              method: "GET",
              headers: { accept: "application/json", host: "localhost" },
              timeout: this.timeoutMs,
            },
        (response) => {
          let bytes = 0;
          response.on("data", (chunk: Buffer) => {
            bytes += chunk.byteLength;
            if (bytes > this.maxResponseBytes) response.destroy();
          });
          response.once("end", () => {
            const status = response.statusCode ?? 0;
            const reachable = status >= 100 && status < 500;
            const healthy = input.health ? status >= 200 && status < 300 : reachable;
            resolve({ reachable, healthy, actual: `HTTP ${status}` });
          });
          response.once("error", () => {
            resolve({ reachable: false, healthy: false, actual: "response failed" });
          });
        },
      );
      client.once("timeout", () => client.destroy(new Error("probe timeout")));
      client.once("error", () => {
        resolve({ reachable: false, healthy: false, actual: "connection failed" });
      });
      client.end();
    });
  }
}
