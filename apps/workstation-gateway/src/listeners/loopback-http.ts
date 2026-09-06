import type { GatewayBrowserListenerAdapter, GatewayBrowserServerPort } from "./types.js";

export interface LoopbackHttpListenerTarget {
  readonly host: "127.0.0.1";
  readonly port: number;
}

export class LoopbackHttpListener implements GatewayBrowserListenerAdapter {
  readonly kind = "loopback-proxy" as const;

  constructor(readonly target: LoopbackHttpListenerTarget) {}

  async listen(server: GatewayBrowserServerPort): Promise<void> {
    await server.listen(this.target);
  }
}
