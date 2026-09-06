import type { WorkstationGatewayConfig } from "../config.js";
import { gatewayLoopbackListenTarget } from "../config.js";
import {
  DirectPrivateTlsListener,
  requireDirectPrivateWorkstationGatewayConfig,
  type DirectPrivateTlsBootstrap,
  type GatewayNetworkInterfaces,
} from "./direct-private-tls.js";
import { LoopbackHttpListener } from "./loopback-http.js";
import type { GatewayBrowserListenerAdapter } from "./types.js";

export interface GatewayBrowserListenerDependencies {
  readonly directTlsBootstrap?: DirectPrivateTlsBootstrap;
  readonly networkInterfaces?: GatewayNetworkInterfaces;
}

export function createGatewayBrowserListener(
  config: WorkstationGatewayConfig,
  dependencies: GatewayBrowserListenerDependencies = {},
): GatewayBrowserListenerAdapter {
  if (config.version === 2 && config.browserIngress.kind === "direct-private-tls") {
    if (dependencies.directTlsBootstrap === undefined) {
      throw new Error("Direct private TLS material provider is not configured.");
    }
    return new DirectPrivateTlsListener(
      requireDirectPrivateWorkstationGatewayConfig(config),
      dependencies.directTlsBootstrap,
      dependencies.networkInterfaces,
    );
  }

  const target = gatewayLoopbackListenTarget(config);
  if (target === undefined) {
    throw new Error("Gateway listener selection is invalid.");
  }
  return new LoopbackHttpListener(target);
}

export {
  DirectPrivateTlsListener,
  assertActiveLocalPrivateIpv4,
  type DirectPrivateTlsBootstrap,
  type GatewayNetworkInterfaces,
} from "./direct-private-tls.js";
export { LoopbackHttpListener, type LoopbackHttpListenerTarget } from "./loopback-http.js";
export type { GatewayBrowserListenerAdapter, GatewayBrowserServerPort } from "./types.js";
