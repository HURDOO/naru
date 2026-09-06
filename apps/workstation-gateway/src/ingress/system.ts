import type { IngressProfileV0 } from "@naru/contracts/workstation-gateway/v1";
import { effectiveOriginPort } from "@naru/domain/workstation";
import {
  gatewayLoopbackListenTarget,
  readWorkstationGatewayConfig,
  type WorkstationGatewayConfig,
} from "../config.js";
import type { WorkstationNetworkConfig } from "./config.js";
import { assertSha256Digest, canonicalJson, digestValue } from "./canonical.js";
import { NetworkManifestStore } from "./manifest-store.js";
import {
  WORKSTATION_NETWORK_SCHEMA_VERSION,
  WORKSTATION_NETWORK_TASK_ID,
  type NetworkCheck,
  type NetworkCheckStatus,
  type NetworkDoctorReport,
  type NetworkMutationResult,
  type NetworkOwnershipManifest,
  type NetworkPlan,
  type NetworkPlanAction,
  type NetworkStatusReport,
  type TailscaleRouteResource,
  type TailscaleState,
} from "./model.js";
import { NodeNetworkProbeAdapter, type NetworkProbePort } from "./probe.js";
import {
  TailscaleCliAdapter,
  conflictingRoutes,
  isSupportedTailscaleVersion,
  matchingRoute,
  tailscaleDisableArguments,
  tailscaleEnableArguments,
  tailscaleStateFingerprint,
  unrelatedStateFingerprint,
  type TailscalePort,
} from "./tailscale.js";

export interface NetworkClock {
  now(): Date;
}

export interface NetworkManifestPort {
  read(profileId: string): NetworkOwnershipManifest | undefined;
  write(manifest: NetworkOwnershipManifest): void;
}

export interface WorkstationNetworkDependencies {
  readonly tailscale?: TailscalePort;
  readonly manifests?: NetworkManifestPort;
  readonly probes?: NetworkProbePort;
  readonly clock?: NetworkClock;
  readonly gatewayConfig?: WorkstationGatewayConfig | null;
}

interface GatewayConfigResult {
  readonly config?: WorkstationGatewayConfig;
  readonly error?: string;
}

type NetworkCheckInput = Omit<NetworkCheck, "remediation"> & {
  readonly remediation?: string | undefined;
};

export class SystemNetworkClock implements NetworkClock {
  now(): Date {
    return new Date();
  }
}

export class WorkstationNetworkManager {
  readonly #tailscale: TailscalePort;
  readonly #manifests: NetworkManifestPort;
  readonly #probes: NetworkProbePort;
  readonly #clock: NetworkClock;
  readonly #gatewayConfigOverride: WorkstationGatewayConfig | null | undefined;

  constructor(
    readonly config: WorkstationNetworkConfig,
    dependencies: WorkstationNetworkDependencies = {},
  ) {
    this.#tailscale = dependencies.tailscale ?? new TailscaleCliAdapter(config.tailscaleExecutable);
    this.#manifests =
      dependencies.manifests ??
      new NetworkManifestStore(config.ownershipDirectory, config.instanceId);
    this.#probes = dependencies.probes ?? new NodeNetworkProbeAdapter();
    this.#clock = dependencies.clock ?? new SystemNetworkClock();
    this.#gatewayConfigOverride = dependencies.gatewayConfig;
  }

  async plan(profileId: string, operation: "apply" | "rollback" = "apply"): Promise<NetworkPlan> {
    const profile = this.#profile(profileId);
    const state = await this.#inspectTailscale();
    const resource = profile.kind === "tailscale-serve" ? resourceForProfile(profile) : undefined;
    const checks: NetworkCheck[] = [
      networkCheck({
        id: "configuration.profile",
        profileId,
        layer: "configuration",
        status: "ok",
        expected: "strict versioned ingress profile",
        actual: `${profile.kind} profile accepted`,
        owner: "package",
      }),
    ];
    const manifestResult = this.#readManifest(profileId);
    if (manifestResult.error !== undefined) checks.push(manifestResult.error);
    const manifest = manifestResult.manifest;

    if (profile.kind !== "tailscale-serve") {
      checks.push(
        networkCheck({
          id: "ingress.inspect-only",
          profileId,
          layer: "ingress",
          status: "ok",
          expected: "no external network mutation",
          actual: `${profile.kind} is inspect/doctor-only in v0`,
          owner: "user",
        }),
      );
      return finalizePlan({
        operation,
        config: this.config,
        profile,
        state,
        status: "noop",
        checks,
      });
    }

    if (resource === undefined) throw new Error("Internal Tailscale resource derivation failed.");
    checks.push(...this.#tailscalePreflightChecks(profile, resource, state, operation === "apply"));
    if (operation === "apply") {
      const gateway = this.#gatewayConfig();
      checks.push(...this.#gatewayAlignmentChecks(profile, gateway));
      checks.push(...(await this.#gatewayPlanReadinessChecks(profile, gateway)));
    }

    const route = matchingRoute(state, resource);
    const conflicts = conflictingRoutes(state, resource);
    const targetFunnel = state.routes.some(
      (entry) => entry.hostPort.toLowerCase() === resource.hostPort.toLowerCase() && entry.funnel,
    );
    if (targetFunnel) {
      checks.push(
        networkCheck({
          id: "ingress.funnel",
          profileId,
          layer: "ingress",
          status: "blocked",
          expected: "no Funnel/public exposure on the target endpoint",
          actual: "Funnel is enabled for the target host and port",
          owner: "tailscale",
          remediation: "Disable Funnel explicitly outside this package, then create a fresh plan.",
        }),
      );
    }
    if (conflicts.length > 0) {
      checks.push(
        networkCheck({
          id: "ingress.route-conflict",
          profileId,
          layer: "ingress",
          status: "blocked",
          expected: "unowned target route is absent",
          actual: `${conflicts.length} conflicting route(s) detected`,
          owner: "user",
          remediation: "Review the existing Serve route; this package will not overwrite it.",
        }),
      );
    }

    let action: NetworkPlanAction | undefined;
    let desiredStatus: NetworkPlan["status"] = "ready";
    if (operation === "apply") {
      if (manifest?.state === "pending") {
        if (!sameResource(manifest.resource, resource)) {
          checks.push(
            manifestStateCheck(
              profileId,
              "blocked",
              "pending resource mismatch",
              "Do not replace the pending resource; review the manifest.",
            ),
          );
        } else if (route !== undefined) {
          checks.push(
            manifestStateCheck(
              profileId,
              "blocked",
              "pending receipt and matching route",
              "Use an exact rollback plan or review persistence before retrying apply.",
            ),
          );
        } else {
          checks.push(
            manifestStateCheck(
              profileId,
              "warning",
              "pending receipt and route absent; fresh retry approval required",
              "Review the new state-bound plan before retrying the exact route.",
            ),
          );
          action = applyAction(resource);
        }
      } else if (manifest?.state === "active") {
        if (!sameResource(manifest.resource, resource)) {
          checks.push(
            manifestStateCheck(
              profileId,
              "blocked",
              "active resource mismatch",
              "Do not replace the owned route; review the manifest.",
            ),
          );
        } else if (route === undefined) {
          checks.push(
            manifestStateCheck(
              profileId,
              "blocked",
              "active manifest but route missing",
              "Review drift; do not recreate automatically.",
            ),
          );
        } else {
          checks.push(manifestStateCheck(profileId, "ok", "active and matching", undefined));
          desiredStatus = "noop";
        }
      } else if (route !== undefined) {
        checks.push(
          networkCheck({
            id: "ownership.unowned-existing-route",
            profileId,
            layer: "ownership",
            status: "blocked",
            expected: "matching route is absent or package-owned",
            actual: "matching route exists without an active package receipt",
            owner: "user",
            remediation: "Do not adopt the route automatically; review ownership manually.",
          }),
        );
      } else {
        action = applyAction(resource);
      }
    } else {
      if (manifest === undefined) {
        checks.push(
          manifestStateCheck(
            profileId,
            "blocked",
            "missing",
            "Rollback requires a package ownership receipt.",
          ),
        );
      } else if (!sameResource(manifest.resource, resource)) {
        checks.push(
          manifestStateCheck(
            profileId,
            "blocked",
            "resource mismatch",
            "Review the manifest and actual route manually.",
          ),
        );
      } else if (manifest.state === "rolled-back") {
        if (route === undefined) {
          checks.push(manifestStateCheck(profileId, "ok", "already rolled back", undefined));
          desiredStatus = "noop";
        } else {
          checks.push(
            manifestStateCheck(
              profileId,
              "blocked",
              "rolled-back receipt but route exists",
              "Do not infer ownership of the recreated route.",
            ),
          );
        }
      } else if (route === undefined) {
        checks.push(
          manifestStateCheck(
            profileId,
            "blocked",
            `${manifest.state} receipt but route missing`,
            "Review drift; do not guess rollback.",
          ),
        );
      } else {
        checks.push(manifestStateCheck(profileId, "ok", manifest.state, undefined));
        action = rollbackAction(resource);
      }
    }

    const status = planStatus(checks, desiredStatus);
    return finalizePlan({
      operation,
      config: this.config,
      profile,
      state,
      status,
      resource,
      ...(action === undefined ? {} : { action }),
      checks,
      ...(manifest === undefined ? {} : { manifest }),
    });
  }

  async apply(profileId: string, approvedDigest: string): Promise<NetworkMutationResult> {
    assertSha256Digest(approvedDigest);
    const plan = await this.plan(profileId, "apply");
    assertApprovedPlan(plan, approvedDigest);
    if (plan.status === "noop") return mutationResult("apply", plan, "noop");
    if (plan.status !== "ready" || plan.resource === undefined || plan.action === undefined) {
      return mutationResult("apply", plan, "blocked");
    }

    const timestamp = this.#clock.now().toISOString();
    const before = await this.#inspectRequired();
    if (tailscaleStateFingerprint(before) !== plan.stateFingerprint) {
      throw new Error("Tailscale state drifted after approval; no mutation performed.");
    }
    const unrelated = unrelatedStateFingerprint(before, plan.resource);
    const pending: NetworkOwnershipManifest = {
      schemaVersion: WORKSTATION_NETWORK_SCHEMA_VERSION,
      taskId: WORKSTATION_NETWORK_TASK_ID,
      packageId: "@naru/workstation-gateway",
      instanceId: this.config.instanceId,
      profileId,
      planDigest: approvedDigest,
      applyStateFingerprint: plan.stateFingerprint,
      unrelatedStateFingerprint: unrelated,
      resource: plan.resource,
      state: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.#manifests.write(pending);
    await this.#tailscale.enable(plan.resource);

    const after = await this.#inspectRequired();
    const route = matchingRoute(after, plan.resource);
    if (route === undefined || route.funnel) {
      throw new Error(
        "Tailscale apply returned without the exact private Serve route; pending receipt retained.",
      );
    }
    if (unrelatedStateFingerprint(after, plan.resource) !== unrelated) {
      throw new Error(
        "Tailscale apply changed unrelated state; pending receipt retained for review.",
      );
    }
    const active: NetworkOwnershipManifest = {
      ...pending,
      state: "active",
      updatedAt: this.#clock.now().toISOString(),
    };
    this.#manifests.write(active);
    return mutationResult("apply", plan, "ok", "active");
  }

  async rollback(profileId: string, approvedDigest: string): Promise<NetworkMutationResult> {
    assertSha256Digest(approvedDigest);
    const plan = await this.plan(profileId, "rollback");
    assertApprovedPlan(plan, approvedDigest);
    if (plan.status === "noop") return mutationResult("rollback", plan, "noop", "rolled-back");
    if (plan.status !== "ready" || plan.resource === undefined || plan.action === undefined) {
      return mutationResult("rollback", plan, "blocked");
    }
    const manifest = this.#manifests.read(profileId);
    if (manifest === undefined || manifest.state === "rolled-back") {
      throw new Error("Rollback ownership receipt changed after planning.");
    }
    const before = await this.#inspectRequired();
    if (tailscaleStateFingerprint(before) !== plan.stateFingerprint) {
      throw new Error("Tailscale state drifted after approval; no mutation performed.");
    }
    const unrelated = unrelatedStateFingerprint(before, plan.resource);
    await this.#tailscale.disable(plan.resource);
    const after = await this.#inspectRequired();
    if (matchingRoute(after, plan.resource) !== undefined) {
      throw new Error("Tailscale rollback returned while the owned route remained active.");
    }
    if (unrelatedStateFingerprint(after, plan.resource) !== unrelated) {
      throw new Error(
        "Tailscale rollback changed unrelated state; ownership receipt retained for review.",
      );
    }
    const rolledBack: NetworkOwnershipManifest = {
      ...manifest,
      planDigest: approvedDigest,
      unrelatedStateFingerprint: unrelated,
      state: "rolled-back",
      updatedAt: this.#clock.now().toISOString(),
    };
    this.#manifests.write(rolledBack);
    return mutationResult("rollback", plan, "ok", "rolled-back");
  }

  async status(): Promise<NetworkStatusReport> {
    const state = await this.#inspectTailscale();
    const checks: NetworkCheck[] = [];
    const profiles: NetworkStatusReport["profiles"][number][] = [];
    for (const entry of this.config.profiles) {
      const profile = entry.profile;
      const manifestResult = this.#readManifest(profile.id);
      if (manifestResult.error !== undefined) checks.push(manifestResult.error);
      if (profile.kind !== "tailscale-serve") {
        profiles.push({
          profileId: profile.id,
          kind: profile.kind,
          ...(manifestResult.manifest === undefined
            ? {}
            : { manifestState: manifestResult.manifest.state }),
          routeState: "inspect-only",
        });
        checks.push(
          networkCheck({
            id: "ingress.inspect-only",
            profileId: profile.id,
            layer: "ingress",
            status: "ok",
            expected: "external state is user-owned",
            actual: `${profile.kind} mutation is not implemented`,
            owner: "user",
          }),
        );
        continue;
      }
      const resource = resourceForProfile(profile);
      const route = matchingRoute(state, resource);
      const conflicts = conflictingRoutes(state, resource);
      profiles.push({
        profileId: profile.id,
        kind: profile.kind,
        ...(manifestResult.manifest === undefined
          ? {}
          : { manifestState: manifestResult.manifest.state }),
        routeState:
          route !== undefined ? "matching" : conflicts.length > 0 ? "conflicting" : "missing",
      });
      checks.push(...this.#tailscalePreflightChecks(profile, resource, state));
      checks.push(
        ...this.#ownershipStatusChecks(profile.id, manifestResult.manifest, route !== undefined),
      );
    }
    return {
      schemaVersion: WORKSTATION_NETWORK_SCHEMA_VERSION,
      taskId: WORKSTATION_NETWORK_TASK_ID,
      command: "status",
      readOnly: true,
      status: aggregateStatus(checks),
      instanceId: this.config.instanceId,
      stateFingerprint: tailscaleStateFingerprint(state),
      profiles,
      checks,
    };
  }

  async doctor(): Promise<NetworkDoctorReport> {
    const state = await this.#inspectTailscale();
    const gateway = this.#gatewayConfig();
    const reports: NetworkDoctorReport["profiles"][number][] = [];
    for (const entry of this.config.profiles) {
      const profile = entry.profile;
      const checks: NetworkCheck[] = [];
      const manifestResult = this.#readManifest(profile.id);
      if (manifestResult.error !== undefined) checks.push(manifestResult.error);
      if (profile.kind === "tailscale-serve") {
        const resource = resourceForProfile(profile);
        checks.push(...this.#tailscalePreflightChecks(profile, resource, state));
        checks.push(
          ...this.#ownershipStatusChecks(
            profile.id,
            manifestResult.manifest,
            matchingRoute(state, resource) !== undefined,
          ),
        );
        checks.push(...this.#gatewayAlignmentChecks(profile, gateway));
        if (matchingRoute(state, resource) === undefined) {
          checks.push(
            unavailableCheck(
              "ingress.https",
              profile.id,
              "ingress",
              "owned Serve route before HTTPS probing",
              "route unavailable",
              "tailscale",
            ),
          );
        } else {
          checks.push(await this.#originCheck(profile, "/_gateway/readyz"));
        }
        const loopbackTarget =
          gateway.config === undefined ? undefined : gatewayLoopbackListenTarget(gateway.config);
        if (gateway.config === undefined || loopbackTarget === undefined) {
          checks.push(
            unavailableCheck(
              "gateway.ready",
              profile.id,
              "gateway",
              "loopback Gateway readiness",
              gateway.error ?? "Gateway did not select loopback ingress",
              "package",
            ),
          );
        } else {
          checks.push(
            await this.#probeCheck(
              "listener.gateway",
              profile.id,
              "listener",
              {
                kind: "loopback-http",
                origin: `http://${loopbackTarget.host}:${loopbackTarget.port}`,
                path: "/_gateway/readyz",
              },
              "exact loopback Gateway listener readiness",
              "package",
              { hostHeader: new URL(gateway.config.browserOrigin).host },
            ),
          );
          checks.push(
            await this.#probeCheck(
              "gateway.ready",
              profile.id,
              "gateway",
              { kind: "uds-http", socketPath: gateway.config.adminSocketPath, path: "/readyz" },
              "Gateway private UDS readiness",
              "package",
            ),
          );
        }
      } else {
        checks.push(
          networkCheck({
            id: "ownership.external",
            profileId: profile.id,
            layer: "ownership",
            status: "ok",
            expected: "user-owned direct ingress",
            actual: "no package mutation or ownership claim",
            owner: "user",
          }),
          networkCheck({
            id: "listener.private",
            profileId: profile.id,
            layer: "listener",
            status: "ok",
            expected: "exact non-wildcard private listener",
            actual: profile.bindOrUpstream,
            owner: "app",
          }),
          networkCheck({
            id: "ingress.source-policy",
            profileId: profile.id,
            layer: "ingress",
            status: "ok",
            expected: "resolved explicit private source policy",
            actual: profile.sourcePolicy ?? "missing",
            owner: "user",
          }),
        );
        checks.push(await this.#originCheck(profile, "/"));
        checks.push(
          networkCheck({
            id: "gateway.not-required",
            profileId: profile.id,
            layer: "gateway",
            status: "ok",
            expected: "app-managed direct path may omit Gateway",
            actual: "Gateway is not treated as an auth bypass",
            owner: "app",
          }),
        );
      }
      const target = this.config.targetProbes.find(
        (candidate) => candidate.appId === profile.targetAppId,
      );
      if (target?.app === undefined) {
        checks.push(
          unavailableCheck(
            "app.ready",
            profile.id,
            "app",
            "configured private app health probe",
            "probe not configured",
            "app",
          ),
        );
      } else {
        checks.push(
          await this.#probeCheck(
            "app.ready",
            profile.id,
            "app",
            target.app,
            "private app readiness",
            "app",
          ),
        );
      }
      if (target?.host === undefined) {
        checks.push(
          unavailableCheck(
            "host.ready",
            profile.id,
            "host",
            "configured private Host health probe",
            "probe not configured",
            "host",
          ),
        );
      } else {
        checks.push(
          await this.#probeCheck(
            "host.ready",
            profile.id,
            "host",
            target.host,
            "private Host readiness",
            "host",
          ),
        );
      }
      reports.push({ profileId: profile.id, status: aggregateStatus(checks), checks });
    }
    return {
      schemaVersion: WORKSTATION_NETWORK_SCHEMA_VERSION,
      taskId: WORKSTATION_NETWORK_TASK_ID,
      command: "doctor",
      readOnly: true,
      status: aggregateStatus(reports.flatMap((entry) => entry.checks)),
      instanceId: this.config.instanceId,
      profiles: reports,
    };
  }

  #profile(profileId: string): IngressProfileV0 {
    const profile = this.config.profiles.find((entry) => entry.profile.id === profileId)?.profile;
    if (profile === undefined) throw new Error(`Unknown ingress profile: ${profileId}`);
    return profile;
  }

  async #inspectTailscale(): Promise<TailscaleState> {
    try {
      return await this.#tailscale.inspect();
    } catch (error) {
      return {
        available: false,
        selfAddresses: [],
        routes: [],
        diagnostics: [safeErrorMessage(error)],
      };
    }
  }

  async #inspectRequired(): Promise<TailscaleState> {
    const state = await this.#inspectTailscale();
    if (!state.available)
      throw new Error("Tailscale state became unavailable; no further mutation attempted.");
    return state;
  }

  #tailscalePreflightChecks(
    profile: IngressProfileV0,
    resource: TailscaleRouteResource,
    state: TailscaleState,
    strictApplyPreconditions = true,
  ): readonly NetworkCheck[] {
    const checks: NetworkCheck[] = [];
    if (!state.available) {
      checks.push(
        unavailableCheck(
          "tailscale.available",
          profile.id,
          "ingress",
          "readable Tailscale CLI JSON",
          state.diagnostics[0] ?? "unavailable",
          "tailscale",
        ),
      );
      return checks;
    }
    checks.push(
      networkCheck({
        id: "tailscale.version",
        profileId: profile.id,
        layer: "ingress",
        status:
          state.version !== undefined && isSupportedTailscaleVersion(state.version)
            ? "ok"
            : "blocked",
        expected: "Tailscale CLI 1.52 or newer with supported Serve syntax",
        actual: state.version ?? "unknown",
        owner: "tailscale",
        remediation:
          state.version !== undefined && isSupportedTailscaleVersion(state.version)
            ? undefined
            : "Install a supported Tailscale version outside this package.",
      }),
      networkCheck({
        id: "tailscale.backend",
        profileId: profile.id,
        layer: "ingress",
        status: state.backendState === "Running" ? "ok" : "blocked",
        expected: "already logged-in Running backend",
        actual: state.backendState ?? "unknown",
        owner: "user",
        remediation:
          state.backendState === "Running"
            ? undefined
            : "Log in to the intended tailnet outside this package.",
      }),
      networkCheck({
        id: "tailscale.https-capability",
        profileId: profile.id,
        layer: "tls-origin",
        status: !strictApplyPreconditions || state.httpsEnabled === true ? "ok" : "blocked",
        expected: "tailnet HTTPS certificates enabled before automated Serve apply",
        actual:
          state.httpsEnabled === true
            ? "enabled"
            : strictApplyPreconditions
              ? "not enabled"
              : "not required for exact rollback",
        owner: "user",
        remediation:
          !strictApplyPreconditions || state.httpsEnabled === true
            ? undefined
            : "Enable HTTPS certificates in the Tailscale admin console, then create a fresh plan; this package will not complete the consent flow.",
      }),
      networkCheck({
        id: "tailscale.dns-name",
        profileId: profile.id,
        layer: "tls-origin",
        status: state.selfDnsName === hostFromHostPort(resource.hostPort) ? "ok" : "blocked",
        expected: hostFromHostPort(resource.hostPort),
        actual: state.selfDnsName ?? "unknown",
        owner: "tailscale",
        remediation:
          state.selfDnsName === hostFromHostPort(resource.hostPort)
            ? undefined
            : "Use the current node canonical Tailscale DNS name; this package will not rename the node.",
      }),
    );
    for (const diagnostic of state.diagnostics) {
      checks.push(
        networkCheck({
          id: "tailscale.state-diagnostic",
          profileId: profile.id,
          layer: "ingress",
          status: "warning",
          expected: "background versioned Serve state only",
          actual: diagnostic,
          owner: "tailscale",
        }),
      );
    }
    const publicRoutes = state.routes.filter((route) => route.funnel);
    checks.push(
      networkCheck({
        id: "tailscale.funnel",
        profileId: profile.id,
        layer: "ingress",
        status: publicRoutes.length === 0 ? "ok" : strictApplyPreconditions ? "blocked" : "warning",
        expected: "no public Funnel routes",
        actual:
          publicRoutes.length === 0 ? "none" : `${publicRoutes.length} public route(s) detected`,
        owner: "tailscale",
        remediation:
          publicRoutes.length === 0
            ? undefined
            : strictApplyPreconditions
              ? "Review and disable Funnel outside this package before apply."
              : "Rollback preserves unrelated Funnel state; review public exposure separately.",
      }),
    );
    return checks;
  }

  #gatewayAlignmentChecks(
    profile: IngressProfileV0,
    supplied?: GatewayConfigResult,
  ): readonly NetworkCheck[] {
    const gateway = supplied ?? this.#gatewayConfig();
    if (gateway.config === undefined) {
      return [
        unavailableCheck(
          "gateway.configuration",
          profile.id,
          "gateway",
          "private Gateway config aligned to ingress",
          gateway.error ?? "not configured",
          "package",
        ),
      ];
    }
    const loopbackTarget = gatewayLoopbackListenTarget(gateway.config);
    const expectedUpstream =
      loopbackTarget === undefined
        ? undefined
        : `http://${loopbackTarget.host}:${loopbackTarget.port}`;
    const target = gateway.config.appRegistrations.find((app) => app.appId === profile.targetAppId);
    const aligned =
      gateway.config.browserOrigin === profile.browserOrigin &&
      gateway.config.ingressProfileId === profile.id &&
      expectedUpstream !== undefined &&
      expectedUpstream === profile.bindOrUpstream &&
      target?.mode === "gateway-managed" &&
      target.enabled;
    return [
      networkCheck({
        id: "gateway.configuration",
        profileId: profile.id,
        layer: "gateway",
        status: aligned ? "ok" : "blocked",
        expected: "same Origin/profile/loopback listener and enabled gateway-managed target app",
        actual: aligned ? "aligned" : "Gateway config does not match this ingress profile",
        owner: "package",
        remediation: aligned
          ? undefined
          : "Generate a consistent Gateway/network config; do not hand-edit active state.",
      }),
    ];
  }

  async #gatewayPlanReadinessChecks(
    profile: IngressProfileV0,
    gateway: GatewayConfigResult,
  ): Promise<readonly NetworkCheck[]> {
    if (gateway.config === undefined) return [];
    const loopbackTarget = gatewayLoopbackListenTarget(gateway.config);
    if (loopbackTarget === undefined) {
      return [
        networkCheck({
          id: "listener.gateway",
          profileId: profile.id,
          layer: "listener",
          status: "blocked",
          expected: "the exact loopback listener selected for this Tailscale profile",
          actual: "Gateway selected a different listener mode",
          owner: "package",
          remediation: "Select the explicit loopback-proxy Gateway profile before applying.",
        }),
      ];
    }
    const localOrigin = `http://${loopbackTarget.host}:${loopbackTarget.port}`;
    const listener = await this.#probeCheck(
      "listener.gateway",
      profile.id,
      "listener",
      { kind: "loopback-http", origin: localOrigin, path: "/_gateway/readyz" },
      "the exact loopback listener is the ready Workstation Gateway",
      "package",
      { hostHeader: new URL(gateway.config.browserOrigin).host },
    );
    const admin = await this.#probeCheck(
      "gateway.admin-ready",
      profile.id,
      "gateway",
      { kind: "uds-http", socketPath: gateway.config.adminSocketPath, path: "/readyz" },
      "the private Gateway admin socket is ready",
      "package",
    );
    return [
      listener.status === "unavailable" ? { ...listener, status: "blocked" } : listener,
      admin.status === "unavailable" ? { ...admin, status: "blocked" } : admin,
    ];
  }

  #gatewayConfig(): GatewayConfigResult {
    if (this.#gatewayConfigOverride === null)
      return { error: "Gateway config intentionally unavailable" };
    if (this.#gatewayConfigOverride !== undefined) return { config: this.#gatewayConfigOverride };
    if (this.config.gatewayConfigPath === undefined)
      return { error: "gatewayConfigPath is not configured" };
    try {
      return { config: readWorkstationGatewayConfig(this.config.gatewayConfigPath) };
    } catch (error) {
      return { error: safeErrorMessage(error) };
    }
  }

  #readManifest(profileId: string): { manifest?: NetworkOwnershipManifest; error?: NetworkCheck } {
    try {
      const manifest = this.#manifests.read(profileId);
      return manifest === undefined ? {} : { manifest };
    } catch {
      return {
        error: networkCheck({
          id: "ownership.manifest",
          profileId,
          layer: "ownership",
          status: "blocked",
          expected: "valid private package receipt",
          actual: "manifest missing safety invariants or does not parse",
          owner: "package",
          remediation: "Review the manifest manually; do not repair or overwrite it automatically.",
        }),
      };
    }
  }

  #ownershipStatusChecks(
    profileId: string,
    manifest: NetworkOwnershipManifest | undefined,
    routeMatches: boolean,
  ): readonly NetworkCheck[] {
    if (manifest === undefined) {
      return [
        manifestStateCheck(
          profileId,
          routeMatches ? "blocked" : "warning",
          "missing",
          routeMatches ? "Do not adopt the existing route automatically." : undefined,
        ),
      ];
    }
    const consistent =
      (manifest.state === "active" && routeMatches) ||
      (manifest.state === "rolled-back" && !routeMatches);
    return [
      manifestStateCheck(
        profileId,
        consistent ? "ok" : "blocked",
        `${manifest.state}; route ${routeMatches ? "matching" : "missing"}`,
        consistent ? undefined : "Review ownership drift before any mutation.",
      ),
    ];
  }

  async #originCheck(profile: IngressProfileV0, path: string): Promise<NetworkCheck> {
    try {
      const result = await this.#probes.probeOrigin(profile.browserOrigin, path);
      return networkCheck({
        id: "ingress.https",
        profileId: profile.id,
        layer: "tls-origin",
        status: result.healthy ? "ok" : result.reachable ? "warning" : "unavailable",
        expected: `valid TLS and exact Origin reachability at ${path}`,
        actual: result.actual,
        owner: profile.tlsOwner,
        remediation: result.healthy
          ? undefined
          : "Check the exact private route, certificate, Origin and listener.",
      });
    } catch {
      return unavailableCheck(
        "ingress.https",
        profile.id,
        "tls-origin",
        "valid TLS and exact Origin reachability",
        "probe failed",
        profile.tlsOwner,
      );
    }
  }

  async #probeCheck(
    id: string,
    profileId: string,
    layer: "listener" | "gateway" | "app" | "host",
    probe: Parameters<NetworkProbePort["probeHealth"]>[0],
    expected: string,
    owner: "package" | "app" | "host",
    options?: Parameters<NetworkProbePort["probeHealth"]>[1],
  ): Promise<NetworkCheck> {
    try {
      const result = await this.#probes.probeHealth(probe, options);
      return networkCheck({
        id,
        profileId,
        layer,
        status: result.healthy ? "ok" : result.reachable ? "blocked" : "unavailable",
        expected,
        actual: result.actual,
        owner,
        remediation: result.healthy ? undefined : `Restore ${layer} readiness and rerun doctor.`,
      });
    } catch {
      return unavailableCheck(id, profileId, layer, expected, "probe failed", owner);
    }
  }
}

function resourceForProfile(profile: IngressProfileV0): TailscaleRouteResource {
  const origin = new URL(profile.browserOrigin);
  const httpsPort = effectiveOriginPort(origin);
  return {
    profileId: profile.id,
    hostPort: `${origin.hostname.toLowerCase()}:${httpsPort}`,
    httpsPort,
    mountPath: "/",
    proxy: profile.bindOrUpstream,
  };
}

function finalizePlan(input: {
  readonly operation: "apply" | "rollback";
  readonly config: WorkstationNetworkConfig;
  readonly profile: IngressProfileV0;
  readonly state: TailscaleState;
  readonly status: NetworkPlan["status"];
  readonly resource?: TailscaleRouteResource;
  readonly action?: NetworkPlanAction;
  readonly checks: readonly NetworkCheck[];
  readonly manifest?: NetworkOwnershipManifest;
}): NetworkPlan {
  const stateFingerprint = tailscaleStateFingerprint(input.state);
  const planDigest = digestValue({
    schemaVersion: WORKSTATION_NETWORK_SCHEMA_VERSION,
    taskId: WORKSTATION_NETWORK_TASK_ID,
    operation: input.operation,
    instanceId: input.config.instanceId,
    profile: input.profile,
    stateFingerprint,
    resource: input.resource,
    action: input.action,
    manifest: input.manifest,
    checks: input.checks,
  });
  return {
    schemaVersion: WORKSTATION_NETWORK_SCHEMA_VERSION,
    taskId: WORKSTATION_NETWORK_TASK_ID,
    command: "plan",
    operation: input.operation,
    readOnly: true,
    instanceId: input.config.instanceId,
    profileId: input.profile.id,
    status: input.status,
    planDigest,
    stateFingerprint,
    profile: input.profile,
    ...(input.resource === undefined ? {} : { resource: input.resource }),
    ...(input.action === undefined ? {} : { action: input.action }),
    ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
    checks: input.checks,
    approvalBoundaries: [
      "apply/rollback requires this reviewed digest and a fresh actual-state precondition read",
      "Tailscale install/login/account/ACL/node-name/global reset are never authorized",
      "WireGuard/trusted-LAN/router/firewall/DNS mutation remains user-owned",
    ],
  };
}

function applyAction(resource: TailscaleRouteResource): NetworkPlanAction {
  return {
    kind: "tailscale-serve-enable",
    profileId: resource.profileId,
    target: `${resource.hostPort}${resource.mountPath} -> ${resource.proxy}`,
    argv: tailscaleEnableArguments(resource),
    precondition: "fresh state fingerprint, no Funnel/conflict, and no unowned matching route",
    rollback: "disable only this exact HTTPS root handler after ownership revalidation",
  };
}

function rollbackAction(resource: TailscaleRouteResource): NetworkPlanAction {
  return {
    kind: "tailscale-serve-disable",
    profileId: resource.profileId,
    target: `${resource.hostPort}${resource.mountPath}`,
    argv: tailscaleDisableArguments(resource),
    precondition: "active/pending package receipt and byte-equivalent exact actual route",
    rollback: "retain a rolled-back receipt; never restore or alter unrelated routes",
  };
}

function planStatus(
  checks: readonly NetworkCheck[],
  desired: NetworkPlan["status"],
): NetworkPlan["status"] {
  if (checks.some((entry) => entry.status === "blocked")) return "blocked";
  if (checks.some((entry) => entry.status === "unavailable")) return "unavailable";
  return desired;
}

function aggregateStatus(checks: readonly NetworkCheck[]): NetworkCheckStatus {
  if (checks.some((entry) => entry.status === "blocked")) return "blocked";
  if (checks.some((entry) => entry.status === "unavailable")) return "unavailable";
  if (checks.some((entry) => entry.status === "warning")) return "warning";
  return "ok";
}

function manifestStateCheck(
  profileId: string,
  status: NetworkCheckStatus,
  actual: string,
  remediation: string | undefined,
): NetworkCheck {
  return networkCheck({
    id: "ownership.manifest",
    profileId,
    layer: "ownership",
    status,
    expected: "receipt and actual route agree",
    actual,
    owner: "package",
    remediation,
  });
}

function unavailableCheck(
  id: string,
  profileId: string,
  layer: NetworkCheck["layer"],
  expected: string,
  actual: string,
  owner: NetworkCheck["owner"],
): NetworkCheck {
  return networkCheck({ id, profileId, layer, status: "unavailable", expected, actual, owner });
}

function networkCheck(input: NetworkCheckInput): NetworkCheck {
  const { remediation, ...required } = input;
  return remediation === undefined ? required : { ...required, remediation };
}

function sameResource(left: TailscaleRouteResource, right: TailscaleRouteResource): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function hostFromHostPort(hostPort: string): string {
  return hostPort.slice(0, hostPort.lastIndexOf(":"));
}

function assertApprovedPlan(plan: NetworkPlan, approvedDigest: string): void {
  if (plan.planDigest !== approvedDigest) {
    throw new Error("Approved plan digest does not match fresh actual state.");
  }
}

function mutationResult(
  command: "apply" | "rollback",
  plan: NetworkPlan,
  status: NetworkMutationResult["status"],
  manifestState?: NetworkOwnershipManifest["state"],
): NetworkMutationResult {
  return {
    schemaVersion: WORKSTATION_NETWORK_SCHEMA_VERSION,
    taskId: WORKSTATION_NETWORK_TASK_ID,
    command,
    status,
    instanceId: plan.instanceId,
    profileId: plan.profileId,
    planDigest: plan.planDigest,
    checks: plan.checks,
    ...(manifestState === undefined ? {} : { manifestState }),
  };
}

function safeErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 512) : "unknown failure";
}
