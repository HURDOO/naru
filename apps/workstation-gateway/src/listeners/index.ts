import type { WorkstationGatewayConfig } from "../config.js";
import type { GatewayLogger } from "../logging.js";
import { gatewayLoopbackListenTarget } from "../config.js";
import {
  DirectPrivateTlsListener,
  requireDirectPrivateWorkstationGatewayConfig,
  type DirectPrivateTlsBootstrap,
  type GatewayNetworkInterfaces,
} from "./direct-private-tls.js";
import { LoopbackHttpListener } from "./loopback-http.js";
import { GatewayDirectTlsMaterialProvider } from "./tls-material.js";
import type { GatewayBrowserListenerAdapter } from "./types.js";

export interface GatewayBrowserListenerDependencies {
  readonly directTlsBootstrap?: DirectPrivateTlsBootstrap;
  readonly networkInterfaces?: GatewayNetworkInterfaces;
  readonly now?: () => number;
  readonly tlsReloadIntervalMs?: number;
  readonly logger?: GatewayLogger;
}

export function createGatewayBrowserListener(
  config: WorkstationGatewayConfig,
  dependencies: GatewayBrowserListenerDependencies = {},
): GatewayBrowserListenerAdapter {
  if (config.version === 2 && config.browserIngress.kind === "direct-private-tls") {
    const directConfig = requireDirectPrivateWorkstationGatewayConfig(config);
    const tlsProvider =
      dependencies.directTlsBootstrap ??
      new GatewayDirectTlsMaterialProvider(directConfig.browserIngress, {
        ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        ...(dependencies.tlsReloadIntervalMs === undefined
          ? {}
          : { reloadIntervalMs: dependencies.tlsReloadIntervalMs }),
        ...(dependencies.logger === undefined ? {} : { logger: dependencies.logger }),
      });
    return new DirectPrivateTlsListener(directConfig, tlsProvider, dependencies.networkInterfaces);
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
  installTlsAvailabilityGuard,
  type DirectPrivateTlsBootstrap,
  type GatewayNetworkInterfaces,
} from "./direct-private-tls.js";
export {
  DIRECT_PRIVATE_TLS_RELOAD_INTERVAL_MS,
  GatewayDirectTlsMaterialProvider,
  type DirectPrivateTlsMaterialProvider,
} from "./tls-material.js";
export { LoopbackHttpListener, type LoopbackHttpListenerTarget } from "./loopback-http.js";
export {
  installPrivateIpv4SourceAdmission,
  PrivateIpv4SourceAdmission,
  type GatewaySecureConnectionServer,
} from "./source-policy.js";
export type { GatewayBrowserListenerAdapter, GatewayBrowserServerPort } from "./types.js";
