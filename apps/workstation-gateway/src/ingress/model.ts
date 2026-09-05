import type { IngressProfileV0 } from "@naru/contracts/workstation-gateway/v1";

export const WORKSTATION_NETWORK_SCHEMA_VERSION = 1 as const;
export const WORKSTATION_NETWORK_TASK_ID = "workstation-v0/T10" as const;

export type NetworkCheckStatus = "ok" | "warning" | "blocked" | "unavailable";
export type NetworkPlanStatus = "ready" | "noop" | "blocked" | "unavailable";
export type NetworkOwner = "package" | "user" | "system" | "tailscale" | "gateway" | "app" | "host";
export type NetworkLayer =
  | "configuration"
  | "ownership"
  | "listener"
  | "ingress"
  | "tls-origin"
  | "gateway"
  | "app"
  | "host";

export interface NetworkCheck {
  readonly id: string;
  readonly profileId?: string;
  readonly layer: NetworkLayer;
  readonly status: NetworkCheckStatus;
  readonly expected: string;
  readonly actual: string;
  readonly owner: NetworkOwner;
  readonly remediation?: string;
}

export interface TailscaleServeRoute {
  readonly hostPort: string;
  readonly mountPath: string;
  readonly proxy: string;
  readonly protocol: "https" | "http" | "tcp" | "tls-terminated-tcp";
  readonly funnel: boolean;
  readonly source: "background" | "foreground" | "service";
}

export interface TailscaleState {
  readonly available: boolean;
  readonly version?: string;
  readonly backendState?: string;
  readonly httpsEnabled?: boolean;
  readonly selfDnsName?: string;
  readonly selfAddresses: readonly string[];
  readonly routes: readonly TailscaleServeRoute[];
  readonly diagnostics: readonly string[];
}

export interface TailscaleRouteResource {
  readonly profileId: string;
  readonly hostPort: string;
  readonly httpsPort: number;
  readonly mountPath: "/";
  readonly proxy: string;
}

export interface NetworkPlanAction {
  readonly kind: "tailscale-serve-enable" | "tailscale-serve-disable";
  readonly profileId: string;
  readonly target: string;
  readonly argv: readonly string[];
  readonly precondition: string;
  readonly rollback: string;
}

export interface NetworkPlan {
  readonly schemaVersion: typeof WORKSTATION_NETWORK_SCHEMA_VERSION;
  readonly taskId: typeof WORKSTATION_NETWORK_TASK_ID;
  readonly command: "plan";
  readonly operation: "apply" | "rollback";
  readonly readOnly: true;
  readonly instanceId: string;
  readonly profileId: string;
  readonly status: NetworkPlanStatus;
  readonly planDigest: string;
  readonly stateFingerprint: string;
  readonly profile: IngressProfileV0;
  readonly resource?: TailscaleRouteResource;
  readonly action?: NetworkPlanAction;
  readonly manifest?: NetworkOwnershipManifest;
  readonly checks: readonly NetworkCheck[];
  readonly approvalBoundaries: readonly string[];
}

export interface NetworkOwnershipManifest {
  readonly schemaVersion: typeof WORKSTATION_NETWORK_SCHEMA_VERSION;
  readonly taskId: typeof WORKSTATION_NETWORK_TASK_ID;
  readonly packageId: "@naru/workstation-gateway";
  readonly instanceId: string;
  readonly profileId: string;
  readonly planDigest: string;
  readonly applyStateFingerprint: string;
  readonly unrelatedStateFingerprint: string;
  readonly resource: TailscaleRouteResource;
  readonly state: "pending" | "active" | "rolled-back";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NetworkMutationResult {
  readonly schemaVersion: typeof WORKSTATION_NETWORK_SCHEMA_VERSION;
  readonly taskId: typeof WORKSTATION_NETWORK_TASK_ID;
  readonly command: "apply" | "rollback";
  readonly status: "ok" | "noop" | "blocked";
  readonly instanceId: string;
  readonly profileId: string;
  readonly planDigest: string;
  readonly checks: readonly NetworkCheck[];
  readonly manifestState?: NetworkOwnershipManifest["state"];
}

export interface NetworkStatusReport {
  readonly schemaVersion: typeof WORKSTATION_NETWORK_SCHEMA_VERSION;
  readonly taskId: typeof WORKSTATION_NETWORK_TASK_ID;
  readonly command: "status";
  readonly readOnly: true;
  readonly status: NetworkCheckStatus;
  readonly instanceId: string;
  readonly stateFingerprint: string;
  readonly profiles: readonly {
    readonly profileId: string;
    readonly kind: IngressProfileV0["kind"];
    readonly manifestState?: NetworkOwnershipManifest["state"];
    readonly routeState: "matching" | "missing" | "conflicting" | "inspect-only";
  }[];
  readonly checks: readonly NetworkCheck[];
}

export interface NetworkDoctorReport {
  readonly schemaVersion: typeof WORKSTATION_NETWORK_SCHEMA_VERSION;
  readonly taskId: typeof WORKSTATION_NETWORK_TASK_ID;
  readonly command: "doctor";
  readonly readOnly: true;
  readonly status: NetworkCheckStatus;
  readonly instanceId: string;
  readonly profiles: readonly {
    readonly profileId: string;
    readonly status: NetworkCheckStatus;
    readonly checks: readonly NetworkCheck[];
  }[];
}
