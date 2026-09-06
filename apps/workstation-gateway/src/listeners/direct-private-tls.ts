import type { ServerOptions } from "node:https";
import { networkInterfaces as systemNetworkInterfaces, type NetworkInterfaceInfo } from "node:os";
import {
  PrivateIpv4AddressSchema,
  type PrivateIngressV0,
} from "@naru/contracts/private-ingress/v0";
import type { DirectPrivateWorkstationGatewayConfig, WorkstationGatewayConfig } from "../config.js";
import { isDirectPrivateWorkstationGatewayConfig } from "../config.js";
import type { GatewayBrowserListenerAdapter, GatewayBrowserServerPort } from "./types.js";

export interface DirectPrivateTlsBootstrap {
  loadInitial(ingress: PrivateIngressV0): ServerOptions;
}

export type GatewayNetworkInterfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export class DirectPrivateTlsListener implements GatewayBrowserListenerAdapter {
  readonly kind = "direct-private-tls" as const;
  readonly httpsOptions: ServerOptions;
  readonly #networkInterfaces: GatewayNetworkInterfaces;

  constructor(
    readonly config: DirectPrivateWorkstationGatewayConfig,
    tlsBootstrap: DirectPrivateTlsBootstrap,
    networkInterfaces: GatewayNetworkInterfaces = systemNetworkInterfaces,
  ) {
    this.httpsOptions = {
      ...tlsBootstrap.loadInitial(config.browserIngress),
      minVersion: "TLSv1.2",
    };
    this.#networkInterfaces = networkInterfaces;
  }

  async listen(server: GatewayBrowserServerPort): Promise<void> {
    assertActiveLocalPrivateIpv4(
      this.config.browserIngress.listener.host,
      this.#networkInterfaces(),
    );
    await server.listen({
      host: this.config.browserIngress.listener.host,
      port: this.config.browserIngress.listener.port,
    });
  }
}

export function requireDirectPrivateWorkstationGatewayConfig(
  config: WorkstationGatewayConfig,
): DirectPrivateWorkstationGatewayConfig {
  if (!isDirectPrivateWorkstationGatewayConfig(config)) {
    throw new Error("Gateway configuration did not select direct private TLS ingress.");
  }
  return config;
}

export function assertActiveLocalPrivateIpv4(
  host: string,
  interfaces: NodeJS.Dict<NetworkInterfaceInfo[]>,
): void {
  const active =
    PrivateIpv4AddressSchema.safeParse(host).success &&
    Object.values(interfaces).some((addresses) =>
      addresses?.some(
        (address) =>
          address.family === "IPv4" && address.internal === false && address.address === host,
      ),
    );
  if (!active) {
    throw new Error("Direct private listener address is not active on a local IPv4 interface.");
  }
}
