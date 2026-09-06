import type { ServerOptions } from "node:https";
import { networkInterfaces as systemNetworkInterfaces, type NetworkInterfaceInfo } from "node:os";
import { PrivateIpv4AddressSchema } from "@naru/contracts/private-ingress/v0";
import type { TlsMaterialLifecycleStatus } from "@naru/tls-material";
import { GATEWAY_BROWSER_LIMITS } from "../browser-security.js";
import type { DirectPrivateWorkstationGatewayConfig, WorkstationGatewayConfig } from "../config.js";
import { isDirectPrivateWorkstationGatewayConfig } from "../config.js";
import { installPrivateIpv4SourceAdmission, PrivateIpv4SourceAdmission } from "./source-policy.js";
import type {
  GatewayBrowserListenerAdapter,
  GatewayBrowserServerPort,
  GatewayRawConnectionServer,
} from "./types.js";
import type { DirectPrivateTlsMaterialProvider } from "./tls-material.js";

export type DirectPrivateTlsBootstrap = DirectPrivateTlsMaterialProvider;

export type GatewayNetworkInterfaces = () => NodeJS.Dict<NetworkInterfaceInfo[]>;

export class DirectPrivateTlsListener implements GatewayBrowserListenerAdapter {
  readonly kind = "direct-private-tls" as const;
  readonly httpsOptions: ServerOptions;
  readonly #networkInterfaces: GatewayNetworkInterfaces;
  readonly #sourceAdmission: PrivateIpv4SourceAdmission;
  readonly #tlsProvider: DirectPrivateTlsMaterialProvider;
  #sourceAdmissionInstalled = false;
  #connectionGuardInstalled = false;
  #tlsLifecycleStarted = false;

  constructor(
    readonly config: DirectPrivateWorkstationGatewayConfig,
    tlsBootstrap: DirectPrivateTlsBootstrap,
    networkInterfaces: GatewayNetworkInterfaces = systemNetworkInterfaces,
  ) {
    this.httpsOptions = {
      ...tlsBootstrap.loadInitial(config.browserIngress),
      minVersion: "TLSv1.2",
      maxHeaderSize: GATEWAY_BROWSER_LIMITS.headerBytes,
      headersTimeout: GATEWAY_BROWSER_LIMITS.headersTimeoutMs,
      requestTimeout: GATEWAY_BROWSER_LIMITS.requestTimeoutMs,
      keepAliveTimeout: GATEWAY_BROWSER_LIMITS.keepAliveTimeoutMs,
    };
    this.#tlsProvider = tlsBootstrap;
    this.#networkInterfaces = networkInterfaces;
    this.#sourceAdmission = new PrivateIpv4SourceAdmission(config.browserIngress.sourcePolicy);
  }

  async listen(server: GatewayBrowserServerPort): Promise<void> {
    assertActiveLocalPrivateIpv4(
      this.config.browserIngress.listener.host,
      this.#networkInterfaces(),
    );
    if (!this.#sourceAdmissionInstalled) {
      installPrivateIpv4SourceAdmission(server.server, this.#sourceAdmission);
      this.#sourceAdmissionInstalled = true;
    }
    if (!this.#connectionGuardInstalled) {
      installTlsAvailabilityGuard(
        server.server,
        () => this.#tlsProvider.acceptsNewConnections?.() !== false,
      );
      this.#connectionGuardInstalled = true;
    }
    try {
      this.#tlsProvider.start?.(server.server);
      this.#tlsLifecycleStarted = true;
      await server.listen({
        host: this.config.browserIngress.listener.host,
        port: this.config.browserIngress.listener.port,
      });
    } catch (error) {
      if (this.#tlsLifecycleStarted) this.#tlsProvider.stop?.();
      this.#tlsLifecycleStarted = false;
      throw error;
    }
  }

  close(): void {
    if (this.#tlsLifecycleStarted) this.#tlsProvider.stop?.();
    this.#tlsLifecycleStarted = false;
  }

  tlsStatus(): TlsMaterialLifecycleStatus {
    return (
      this.#tlsProvider.status?.() ?? {
        status: "ok" as const,
        lastReload: "initial" as const,
      }
    );
  }
}

export function installTlsAvailabilityGuard(
  server: GatewayRawConnectionServer,
  acceptsNewConnections: () => boolean,
): void {
  server.prependListener("connection", (socket) => {
    if (!acceptsNewConnections()) socket.destroy();
  });
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
