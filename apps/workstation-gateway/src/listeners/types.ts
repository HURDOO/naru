import type { ServerOptions } from "node:https";

export interface GatewayBrowserServerPort {
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
}

export interface GatewayBrowserListenerAdapter {
  readonly kind: "loopback-proxy" | "direct-private-tls";
  readonly httpsOptions?: ServerOptions;
  listen(server: GatewayBrowserServerPort): Promise<void>;
}
