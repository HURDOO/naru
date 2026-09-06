import type { TlsMaterialLifecycleStatus } from "@naru/tls-material";

export interface GatewayReadiness {
  readonly ready: boolean;
  readonly checks: {
    readonly storage: boolean;
    readonly auth: boolean;
    readonly registry: boolean;
    readonly tls?: boolean;
  };
  readonly tlsMaterial?: TlsMaterialLifecycleStatus;
}
