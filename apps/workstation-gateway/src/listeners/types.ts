import type { ServerOptions } from "node:https";
import type { Socket } from "node:net";
import type { TlsMaterialLifecycleStatus } from "@naru/tls-material";
import type { GatewaySecureConnectionServer } from "./source-policy.js";

export interface GatewayRawConnectionServer {
  prependListener(event: "connection", listener: (socket: Socket) => void): unknown;
}

export interface GatewayBrowserServerPort {
  readonly server: GatewaySecureConnectionServer & GatewayRawConnectionServer;
  listen(options: { readonly host: string; readonly port: number }): Promise<string>;
}

export interface GatewayBrowserListenerAdapter {
  readonly kind: "loopback-proxy" | "direct-private-tls";
  readonly httpsOptions?: ServerOptions;
  listen(server: GatewayBrowserServerPort): Promise<void>;
  close?(): void;
  tlsStatus?(): TlsMaterialLifecycleStatus;
}
