import type { ServerOptions } from "node:https";
import type { GatewaySecureConnectionServer } from "./source-policy.js";

export interface GatewayBrowserServerPort {
  readonly server: GatewaySecureConnectionServer;
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
}

export interface GatewayBrowserListenerAdapter {
  readonly kind: "loopback-proxy" | "direct-private-tls";
  readonly httpsOptions?: ServerOptions;
  listen(server: GatewayBrowserServerPort): Promise<void>;
}
