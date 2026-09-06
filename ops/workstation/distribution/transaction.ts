import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { digestPrivateIngressIntentV0 } from "../../../packages/contracts/src/private-ingress/v0/index.js";
import {
  ARTIFACT_FEATURE_LOCAL_SESSION_CLI,
  DISTRIBUTION_SCHEMA_VERSION,
  DISTRIBUTION_TASK_ID,
  PRIVATE_FILE_MODE,
  PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION,
  PRIVATE_INGRESS_DISTRIBUTION_TASK_ID,
  RUNTIME_SERVICE_NAMES,
  WORKSTATION_PACKAGE_ID,
  type RuntimeServiceName,
  type ServiceName,
} from "./constants.js";
import {
  installVerifiedArtifact,
  verifyDistributionArtifact,
  type VerifiedDistributionArtifact,
} from "./artifact.js";
import {
  createInstanceConfiguration,
  type GeneratedInstanceConfiguration,
} from "./configuration.js";
import { installOrUpdateInstanceCredentials } from "./credentials.js";
import {
  createInstanceLayout,
  createInstanceNamespace,
  createInstanceOwnershipReceiptPath,
  artifactNodeExecutable,
  describeOriginTransition,
  digestJson,
  distributionDocumentTaskId,
  isPrivateIngressInstallationIntent,
  parseInstallationIntent,
  stableJson,
  type DistributionDocumentTaskId,
  type DistributionDocumentVersion,
  type DistributionArtifactSummary,
  type OriginTransition,
  type WorkstationInstallationIntent,
  type WorkstationInstanceLayout,
} from "./model.js";
import {
  atomicWritePrivateFile,
  assertNoSymlinkComponents,
  assertPrivateFile,
  ensureInstanceDirectories,
  inspectManagedInstancePaths,
  inspectNativeRuntime,
  inspectTargetEnvironment,
  readPrivateJson,
} from "./security.js";
import {
  handoffMaintenanceRequest,
  startRuntimeTopology,
  stopRuntimeTopology,
  type GatewayVerifierKeySetV1,
  type ServiceRuntimeState,
  type WorkstationRuntimeController,
} from "./runtime.js";
import { renderInstanceWebRelease, type InstanceWebReleaseReceiptV1 } from "./web-release.js";
import { parsePackagedNodeRuntime } from "./node-runtime.js";
import {
  inspectPrivateIngressPreflight,
  type PrivateIngressPreflightDependencies,
} from "./private-ingress-preflight.js";

export type DistributionOperation = "install" | "upgrade" | "reconfigure" | "rollback";
export type DistributionPlanStatus = "ready" | "blocked" | "needs-input";
export type DistributionCheckStatus = "ok" | "warning" | "blocked" | "unavailable";

export interface DistributionCheck {
  readonly id: string;
  readonly status: DistributionCheckStatus;
  readonly expected: string;
  readonly actual: string;
  readonly owner: "package" | "user" | "system" | "browser";
  readonly remediation?: string;
}

export interface DistributionAction {
  readonly id: string;
  readonly phase: "handoff" | "filesystem" | "credential" | "service" | "network" | "browser";
  readonly mutation: "none" | "package" | "service" | "network" | "user-action";
  readonly target: string;
  readonly rollback: string;
}

export interface DistributionConfigurationDigests {
  readonly settings: string;
  readonly host: string;
  readonly gateway: string;
  readonly naruEnvironment: string;
  readonly webIdentity: string;
  readonly launchAgents: Readonly<Record<ServiceName, string>>;
}

export interface InstallationReceiptV1 {
  readonly version: DistributionDocumentVersion;
  readonly taskId: DistributionDocumentTaskId;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly receiptId: string;
  readonly sequence: number;
  readonly operation: DistributionOperation;
  readonly namespace: string;
  readonly installationId: string;
  readonly uid: number;
  readonly planDigest: string;
  readonly stateFingerprint: string;
  readonly supersedesReceiptId?: string;
  readonly appliedAt: string;
  readonly artifact: DistributionArtifactSummary;
  readonly intent: WorkstationInstallationIntent;
  readonly privateIngressIntentDigest?: string;
  readonly sourceCommit?: string;
  readonly configurationDigests: DistributionConfigurationDigests;
  readonly webRelease: InstanceWebReleaseReceiptV1;
  readonly vapidPublicKeyFingerprint: string;
  readonly labels: WorkstationInstanceLayout["labels"];
}

export interface DistributionPlan {
  readonly version: DistributionDocumentVersion;
  readonly taskId: DistributionDocumentTaskId;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly command: "plan";
  readonly readOnly: true;
  readonly operation: DistributionOperation;
  readonly status: DistributionPlanStatus;
  readonly planDigest: string;
  readonly stateFingerprint: string;
  readonly listenerPreflight: "verified" | "skipped-test";
  readonly targetReceiptId?: string;
  readonly requestedIntent: WorkstationInstallationIntent;
  readonly targetIntent: WorkstationInstallationIntent;
  readonly privateIngressIntentDigest?: string;
  readonly sourceTransition?: OperatorSourceTransitionPlan;
  readonly artifact: DistributionArtifactSummary;
  readonly layout: WorkstationInstanceLayout;
  readonly currentReceipt?: InstallationReceiptV1;
  readonly rollbackReceipt?: InstallationReceiptV1;
  readonly configurationDigests: DistributionConfigurationDigests;
  readonly originTransition: OriginTransition;
  readonly checks: readonly DistributionCheck[];
  readonly actions: readonly DistributionAction[];
  readonly approvalBoundaries: readonly string[];
}

export interface OperatorSourceTransitionPlan {
  readonly mutation: "none";
  readonly requiresSeparateOperatorApproval: true;
  readonly exactTarget: {
    readonly sourceCommit: string;
    readonly artifactManifestDigest: string;
    readonly artifactPayloadDigest: string;
    readonly gatewayConfigurationDigest: string;
  };
  readonly verification: readonly string[];
  readonly rollback: readonly string[];
}

export interface MaintenanceRequestV1 {
  readonly version: DistributionDocumentVersion;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly requestId: string;
  readonly issuedAt: string;
  readonly approvedPlanDigest: string;
  readonly operation: DistributionOperation;
  readonly listenerPreflight: "verified" | "skipped-test";
  readonly targetReceiptId?: string;
  readonly intent: WorkstationInstallationIntent;
}

export interface MaintenanceResultV1 {
  readonly version: DistributionDocumentVersion;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly requestId: string;
  readonly operation: DistributionOperation;
  readonly status: "running" | "completed" | "failed";
  readonly stage: string;
  readonly startedAt: string;
  readonly completedAt?: string;
  readonly receiptId?: string;
  readonly buildId?: string;
  readonly recovery?:
    "not-needed" | "cleaned-fresh-install" | "restored-previous" | "manual-required";
  readonly error?: string;
}

export interface ListenerProbeTarget {
  readonly host: string;
  readonly port: number;
}

export type ListenerProbe = (
  targets: readonly ListenerProbeTarget[],
) => Promise<{ readonly available: boolean; readonly detail: string }>;

export async function planDistribution(
  requestedIntent: WorkstationInstallationIntent,
  operation: DistributionOperation,
  runtime: WorkstationRuntimeController,
  options: {
    readonly targetReceiptId?: string;
    readonly probePorts?: boolean;
    readonly probeListenerTargets?: ListenerProbe;
    readonly privateIngressPreflight?: Partial<PrivateIngressPreflightDependencies>;
  } = {},
): Promise<DistributionPlan> {
  const normalizedRequest = parseInstallationIntent(requestedIntent);
  const requestedArtifact = verifyDistributionArtifact(normalizedRequest.artifactRoot);
  const requestedLayout = createInstanceLayout(normalizedRequest, requestedArtifact.summary);
  const currentReceipt = readCurrentReceipt(requestedLayout);
  assertReceiptIdentity(currentReceipt, requestedLayout);
  await assertPrivateIngressReceiptDigest(currentReceipt);
  const rollbackReceipt =
    operation === "rollback"
      ? readRollbackReceipt(requestedLayout, requiredTargetReceiptId(options))
      : undefined;
  await assertPrivateIngressReceiptDigest(rollbackReceipt);
  const targetIntent =
    rollbackReceipt === undefined
      ? normalizedRequest
      : parseInstallationIntent({
          ...rollbackReceipt.intent,
          artifactRoot: rollbackReceipt.artifact.root,
        });
  const artifact =
    rollbackReceipt === undefined
      ? requestedArtifact
      : verifyDistributionArtifact(rollbackReceipt.artifact.root);
  const layout = createInstanceLayout(targetIntent, artifact.summary);
  if (layout.namespace !== requestedLayout.namespace) {
    throw new Error("Rollback receipt escaped the requested Workstation instance namespace.");
  }
  const configuration = createInstanceConfiguration(targetIntent, artifact.summary, layout);
  const configurationDigests = configurationDigest(
    targetIntent,
    artifact.summary,
    layout,
    configuration,
  );
  const privateIngressIntentDigest = isPrivateIngressInstallationIntent(targetIntent)
    ? await digestPrivateIngressIntentV0(targetIntent.ingress)
    : undefined;
  const sourceTransition = isPrivateIngressInstallationIntent(targetIntent)
    ? createOperatorSourceTransitionPlan(
        artifact.manifest.sourceCommit,
        artifact.summary,
        configurationDigests.gateway,
      )
    : undefined;
  const checks: DistributionCheck[] = [];
  const privateIngressPreflight = isPrivateIngressInstallationIntent(targetIntent)
    ? await inspectPrivateIngressPreflight(targetIntent, options.privateIngressPreflight)
    : undefined;
  if (privateIngressPreflight !== undefined) checks.push(...privateIngressPreflight.checks);

  try {
    const expectedNodeExecutable = artifactNodeExecutable(
      artifact.summary,
      targetIntent.nodeExecutable,
    );
    if (targetIntent.nodeExecutable !== expectedNodeExecutable) {
      throw new Error("Installation intent Node must match the packaged artifact runtime.");
    }
    const environment = inspectTargetEnvironment(targetIntent, artifact.summary.nodeRuntime);
    const signatureFallback = environment.node.codeSignatureValidation === "exact-hash-fallback";
    checks.push({
      id: "runtime.target-user-node24",
      status: signatureFallback ? "warning" : "ok",
      expected: "artifact-owned exact Node 24 and canonical shell/Codex/root paths",
      actual: `${layout.runtime.nodeSource}:${expectedNodeExecutable}; codesign=${environment.node.codeSignatureValidation ?? "not-applicable"}`,
      owner: "user",
      ...(signatureFallback
        ? {
            remediation:
              "The current context cannot validate even an Apple system binary; exact packaged Node SHA-256 was used and launchd mutation remains separately approved.",
          }
        : {}),
    });
  } catch (error) {
    checks.push({
      id: "runtime.target-user-node24",
      status: "blocked",
      expected: "artifact-owned exact Node 24 and canonical shell/Codex/root paths",
      actual: safeError(error),
      owner: "user",
      remediation: "Use the verified Node 24 runtime embedded in the expanded artifact.",
    });
  }

  checks.push({
    id: "artifact.standalone",
    status: "ok",
    expected: "verified standalone darwin-arm64 payload with native modules and no target build",
    actual: `${artifact.summary.buildId}:${artifact.summary.manifestDigest}`,
    owner: "package",
  });
  const managedIssues = inspectManagedInstancePaths(layout, layout.uid);
  checks.push({
    id: "filesystem.private-ancestors",
    status: managedIssues.length === 0 ? "ok" : "blocked",
    expected: "package-managed real directories owned by target UID with exact mode 0700",
    actual:
      managedIssues.length === 0
        ? "missing paths will be created private; existing paths are safe"
        : managedIssues.map((issue) => `${issue.reason}:${issue.path}`).join("; "),
    owner: "package",
    ...(managedIssues.length === 0
      ? {}
      : { remediation: "Repair the exact package-owned ancestor without following symlinks." }),
  });

  const serviceStates = serviceStateMap(runtime, layout);
  const orphanedRuntimePlists =
    currentReceipt === undefined
      ? RUNTIME_SERVICE_NAMES.filter((service) => existsSync(layout.launchAgentFiles[service]))
      : [];
  const labelConflict =
    currentReceipt === undefined &&
    (RUNTIME_SERVICE_NAMES.some((service) => serviceStates[service] !== "unloaded") ||
      orphanedRuntimePlists.length > 0);
  checks.push({
    id: "launchd.namespace",
    status: labelConflict ? "blocked" : "ok",
    expected: "three runtime labels and one maintenance label owned only by this instance",
    actual: `${Object.entries(serviceStates)
      .map(([service, state]) => `${service}=${state}`)
      .join(",")}; runtime-plists=${
      orphanedRuntimePlists.length === 0 ? "none" : orphanedRuntimePlists.join(",")
    }`,
    owner: "package",
    ...(labelConflict
      ? { remediation: "Resolve the existing same-label service before installing." }
      : {}),
  });

  const portTargets = listenerProbeTargets(targetIntent, layout, currentReceipt);
  const portProbe =
    options.probePorts === false || portTargets.length === 0
      ? { available: true, detail: "listener probe skipped or current receipt owns the targets" }
      : await (options.probeListenerTargets ?? probeListenerTargets)(portTargets);
  const listenerPreflight = options.probePorts === false ? "skipped-test" : "verified";
  const listenerStateFingerprint = digestJson({
    purpose: "naru.workstation.listener-preflight.v1",
    mode: listenerPreflight,
    available: portProbe.available,
    targetCount: portTargets.length,
  });
  checks.push({
    id: isPrivateIngressInstallationIntent(targetIntent)
      ? "private-ingress.listener-allocation"
      : "listener.loopback-allocation",
    status: portProbe.available ? "ok" : "blocked",
    expected: isPrivateIngressInstallationIntent(targetIntent)
      ? "the exact private listener and loopback upstream ports are package-available"
      : "two distinct exact loopback ports without another listener",
    actual: isPrivateIngressInstallationIntent(targetIntent)
      ? portProbe.available
        ? "exact listener targets available or receipt-owned"
        : "an exact listener target is unavailable"
      : portProbe.detail,
    owner: "system",
    ...(portProbe.available
      ? {}
      : { remediation: "Resolve the port conflict and create a new plan." }),
  });

  checks.push(operationCheck(operation, currentReceipt, rollbackReceipt, artifact, targetIntent));
  checks.push({
    id: "origin.single-source",
    status: "ok",
    expected: "one exact HTTPS Origin for Gateway, RP ID, Naru, ingress, PWA and Push",
    actual: `${layout.browser.origin} (RP ID ${layout.browser.rpId})`,
    owner: "package",
  });
  checks.push(ingressPrerequisiteCheck(targetIntent));
  checks.push({
    id: "codex.hook-trust",
    status: "warning",
    expected: "hook trust remains an explicit target-user decision",
    actual: "installer will not accept a Codex hook trust prompt",
    owner: "user",
    remediation: "Review the exact installed hook command when Codex asks for trust.",
  });

  const originTransition = describeOriginTransition(
    currentReceipt?.intent.canonicalBrowserOrigin,
    targetIntent.canonicalBrowserOrigin,
  );
  const stateFingerprint = fingerprintState(
    layout,
    currentReceipt,
    serviceStates,
    privateIngressPreflight?.stateFingerprint,
    listenerStateFingerprint,
  );
  const actions = createActions(operation, layout, targetIntent, originTransition);
  const approvalBoundaries = [
    "This plan does not approve launchd install/start; the mutation command requires this exact digest.",
    "Tailscale Serve/listener apply is a separate approved transaction after local readiness.",
    "Owner passkey bootstrap, notification permission, and Codex hook trust stay user-controlled.",
    "Current com.naru.agent/com.naru.maintenance and production data are outside this package boundary.",
  ];
  const status: DistributionPlanStatus = checks.some(
    (check) => check.status === "blocked" || check.status === "unavailable",
  )
    ? "blocked"
    : checks.some((check) => check.status === "warning")
      ? "needs-input"
      : "ready";
  const core: Omit<DistributionPlan, "planDigest"> = {
    version: targetIntent.version,
    taskId: distributionDocumentTaskId(targetIntent),
    packageId: WORKSTATION_PACKAGE_ID,
    command: "plan" as const,
    readOnly: true as const,
    operation,
    status,
    stateFingerprint,
    listenerPreflight,
    ...(options.targetReceiptId === undefined ? {} : { targetReceiptId: options.targetReceiptId }),
    requestedIntent: normalizedRequest,
    targetIntent,
    ...(privateIngressIntentDigest === undefined ? {} : { privateIngressIntentDigest }),
    ...(sourceTransition === undefined ? {} : { sourceTransition }),
    artifact: artifact.summary,
    layout,
    ...(currentReceipt === undefined ? {} : { currentReceipt }),
    ...(rollbackReceipt === undefined ? {} : { rollbackReceipt }),
    configurationDigests,
    originTransition,
    checks,
    actions,
    approvalBoundaries,
  };
  return { ...core, planDigest: approvalDigest(core) };
}

function approvalDigest(core: Omit<DistributionPlan, "planDigest">): string {
  const canonicalIntent = (
    intent: WorkstationInstallationIntent,
  ): WorkstationInstallationIntent => ({
    ...intent,
    artifactRoot: "<verified-artifact-transport>",
    ...(core.artifact.nodeRuntime === undefined
      ? {}
      : { nodeExecutable: "<artifact-owned-node-runtime>" }),
  });
  return digestJson({
    ...core,
    // A rollback request uses current intent only to locate the instance; the selected target
    // receipt owns the applied settings. Hash the semantic target so the release-local handoff can
    // discard every source transport path without weakening artifact or state binding.
    requestedIntent: canonicalIntent(core.targetIntent),
    targetIntent: canonicalIntent(core.targetIntent),
    artifact: { ...core.artifact, root: "<verified-artifact-transport>" },
    checks: core.checks.map((check) => ({
      id: check.id,
      status: check.status,
      expected: check.expected,
      owner: check.owner,
      ...(check.remediation === undefined ? {} : { remediation: check.remediation }),
    })),
  });
}

export function stageMaintenanceHandoff(
  plan: DistributionPlan,
  approvedPlanDigest: string,
  runtime: WorkstationRuntimeController,
  now = new Date(),
): MaintenanceRequestV1 {
  if (plan.planDigest !== approvedPlanDigest) {
    throw new Error("Approved plan digest does not match the reviewed Workstation plan.");
  }
  if (plan.status === "blocked") throw new Error("Blocked Workstation plan cannot be handed off.");
  ensureInstanceDirectories(plan.layout, plan.layout.uid);
  refuseUnconsumedMaintenanceRequest(plan.layout);
  const sourceArtifact = verifyDistributionArtifact(plan.artifact.root);
  assertApprovedArtifactIdentity(plan.artifact, sourceArtifact.summary);
  installVerifiedArtifact(sourceArtifact, plan.layout.releaseRoot);
  const installedArtifact = verifyDistributionArtifact(plan.layout.releaseRoot);
  assertApprovedArtifactIdentity(plan.artifact, installedArtifact.summary);
  const maintenanceIntent = parseInstallationIntent({
    ...plan.targetIntent,
    artifactRoot: plan.layout.releaseRoot,
    nodeExecutable: artifactNodeExecutable(
      installedArtifact.summary,
      plan.targetIntent.nodeExecutable,
    ),
  });
  const maintenanceLayout = createInstanceLayout(maintenanceIntent, installedArtifact.summary);
  if (
    maintenanceLayout.namespace !== plan.layout.namespace ||
    maintenanceLayout.stateRoot !== plan.layout.stateRoot ||
    maintenanceLayout.releaseRoot !== plan.layout.releaseRoot ||
    stableJson(maintenanceLayout.labels) !== stableJson(plan.layout.labels)
  ) {
    throw new Error("Managed maintenance release escaped the approved instance layout.");
  }
  const bootstrapConfiguration = createInstanceConfiguration(
    plan.targetIntent,
    installedArtifact.summary,
    maintenanceLayout,
  );
  atomicWritePrivateFile(
    plan.layout.launchAgentFiles.maintenance,
    bootstrapConfiguration.launchAgents.maintenance,
    plan.layout.uid,
    { replace: true, parentPrivate: false },
  );
  const request: MaintenanceRequestV1 = {
    version: plan.targetIntent.version,
    packageId: WORKSTATION_PACKAGE_ID,
    requestId: randomUUID(),
    issuedAt: now.toISOString(),
    approvedPlanDigest,
    operation: plan.operation,
    listenerPreflight: plan.listenerPreflight,
    ...(plan.targetReceiptId === undefined ? {} : { targetReceiptId: plan.targetReceiptId }),
    intent: maintenanceIntent,
  };
  atomicWritePrivateFile(
    plan.layout.files.maintenanceRequest,
    `${stableJson(request)}\n`,
    plan.layout.uid,
    { replace: true },
  );
  handoffMaintenanceRequest(runtime, plan.layout);
  return request;
}

function assertApprovedArtifactIdentity(
  approved: DistributionArtifactSummary,
  actual: DistributionArtifactSummary,
): void {
  if (
    approved.buildId !== actual.buildId ||
    approved.manifestDigest !== actual.manifestDigest ||
    approved.payloadDigest !== actual.payloadDigest ||
    stableJson(approved.nodeRuntime ?? null) !== stableJson(actual.nodeRuntime ?? null) ||
    stableJson(approved.features) !== stableJson(actual.features)
  ) {
    throw new Error("Distribution artifact identity changed after plan approval.");
  }
}

export async function executeMaintenanceRequest(
  request: MaintenanceRequestV1,
  runtime: WorkstationRuntimeController,
  options: {
    readonly now?: () => Date;
    readonly inspectNative?: typeof inspectNativeRuntime;
    readonly privateIngressPreflight?: Partial<PrivateIngressPreflightDependencies>;
    readonly probeListenerTargets?: ListenerProbe;
  } = {},
): Promise<MaintenanceResultV1> {
  const normalized = parseMaintenanceRequest(request);
  const now = options.now ?? (() => new Date());
  const inspectNative = options.inspectNative ?? inspectNativeRuntime;
  const previewArtifact = verifyDistributionArtifact(normalized.intent.artifactRoot);
  const previewLayout = createInstanceLayout(normalized.intent, previewArtifact.summary);
  const releaseLock = acquireMaintenanceLock(previewLayout, normalized.requestId);
  const startedAt = now().toISOString();
  let currentResult: MaintenanceResultV1 = {
    version: normalized.intent.version,
    packageId: WORKSTATION_PACKAGE_ID,
    requestId: normalized.requestId,
    operation: normalized.operation,
    status: "running",
    stage: "revalidate-plan",
    startedAt,
  };
  writeMaintenanceResult(previewLayout, currentResult);
  let plan: DistributionPlan | undefined;
  let snapshots: readonly FileSnapshot[] = [];
  let runtimeConfigurationWritten = false;
  try {
    plan = await planDistribution(normalized.intent, normalized.operation, runtime, {
      ...(normalized.targetReceiptId === undefined
        ? {}
        : { targetReceiptId: normalized.targetReceiptId }),
      probePorts: normalized.listenerPreflight === "skipped-test" ? false : true,
      ...(options.privateIngressPreflight === undefined
        ? {}
        : { privateIngressPreflight: options.privateIngressPreflight }),
      ...(options.probeListenerTargets === undefined
        ? {}
        : { probeListenerTargets: options.probeListenerTargets }),
    });
    if (plan.planDigest !== normalized.approvedPlanDigest) {
      throw new Error("Workstation state drifted after approval; create and approve a new plan.");
    }
    if (plan.status === "blocked") throw new Error("Revalidated Workstation plan is blocked.");
    snapshots = captureMutableFiles(plan.layout);
    currentResult = updateStage(plan.layout, currentResult, "install-artifact");
    ensureInstanceDirectories(plan.layout, plan.layout.uid);
    const sourceArtifact = verifyDistributionArtifact(plan.artifact.root);
    installVerifiedArtifact(sourceArtifact, plan.layout.releaseRoot);
    const installedArtifact = verifyDistributionArtifact(plan.layout.releaseRoot);
    inspectTargetEnvironment(
      {
        ...plan.targetIntent,
        artifactRoot: plan.layout.releaseRoot,
        nodeExecutable: plan.layout.runtime.nodeExecutable,
      },
      installedArtifact.summary.nodeRuntime,
    );
    inspectNative(plan.layout.runtime.nodeExecutable, plan.layout.releaseRoot);

    currentResult = updateStage(plan.layout, currentResult, "render-instance-web-release");
    const webRelease = renderInstanceWebRelease({
      baseWebRoot: join(plan.layout.releaseRoot, "web-base"),
      targetWebRoot: plan.layout.webReleaseRoot,
      buildId: installedArtifact.summary.buildId,
      basePayloadDigest: installedArtifact.summary.payloadDigest,
      browser: plan.layout.browser,
    });

    currentResult = updateStage(plan.layout, currentResult, "write-private-configuration");
    const configuration = createInstanceConfiguration(
      plan.targetIntent,
      installedArtifact.summary,
      plan.layout,
    );
    installOrUpdateInstanceCredentials(plan.layout, configuration.naruEnvironment, {
      localSessionCli: configuration.localSessionCli !== undefined,
    });
    writeGeneratedConfiguration(plan.layout, configuration);
    runtimeConfigurationWritten = true;

    currentResult = updateStage(plan.layout, currentResult, "restart-runtime-topology");
    const services = changedRuntimeServices(plan);
    const activeLayout = plan.layout;
    if (plan.currentReceipt !== undefined) {
      stopRuntimeTopology(runtime, activeLayout, [...services].reverse());
    }
    await startRuntimeTopology(
      runtime,
      activeLayout,
      (keys) => writeVerifierKeys(activeLayout, keys),
      services,
    );

    currentResult = updateStage(plan.layout, currentResult, "finalize-receipt");
    const credentialSummary = installOrUpdateInstanceCredentials(
      plan.layout,
      configuration.naruEnvironment,
      { localSessionCli: configuration.localSessionCli !== undefined },
    );
    const receipt = writeInstallationReceipt(
      plan,
      installedArtifact.summary,
      webRelease,
      credentialSummary.vapidPublicKeyFingerprint,
      now(),
    );
    currentResult = {
      ...currentResult,
      status: "completed",
      stage: "completed",
      completedAt: now().toISOString(),
      receiptId: receipt.receiptId,
      buildId: receipt.artifact.buildId,
      recovery: "not-needed",
    };
    writeMaintenanceResult(plan.layout, currentResult);
    return currentResult;
  } catch (error) {
    let recovery: MaintenanceResultV1["recovery"] = "manual-required";
    if (plan !== undefined && plan.currentReceipt === undefined && runtimeConfigurationWritten) {
      try {
        stopRuntimeTopology(runtime, plan.layout);
        removeFreshRuntimePlists(plan.layout);
        recovery = "cleaned-fresh-install";
      } catch {
        recovery = "manual-required";
      }
    } else if (plan?.currentReceipt !== undefined && snapshots.length > 0) {
      try {
        restoreMutableFiles(plan.layout, snapshots);
        const previousLayout = createInstanceLayout(
          plan.currentReceipt.intent,
          plan.currentReceipt.artifact,
        );
        await startRuntimeTopology(runtime, previousLayout, (keys) =>
          writeVerifierKeys(previousLayout, keys),
        );
        recovery = "restored-previous";
      } catch {
        recovery = "manual-required";
      }
    }
    currentResult = {
      ...currentResult,
      status: "failed",
      stage: "failed",
      completedAt: now().toISOString(),
      recovery,
      error: isPrivateIngressInstallationIntent(normalized.intent)
        ? "Private ingress maintenance failed; create a fresh plan and run status or doctor."
        : safeError(error),
    };
    writeMaintenanceResult(plan?.layout ?? previewLayout, currentResult);
    return currentResult;
  } finally {
    releaseLock();
  }
}

export function readCurrentReceipt(
  layout: WorkstationInstanceLayout,
): InstallationReceiptV1 | undefined {
  if (!existsSync(layout.files.ownership)) return undefined;
  return parseInstallationReceipt(readPrivateJson(layout.files.ownership, layout.uid));
}

export function readCurrentReceiptForIntent(
  intent: WorkstationInstallationIntent,
): InstallationReceiptV1 | undefined {
  const path = createInstanceOwnershipReceiptPath(intent);
  if (!existsSync(path)) return undefined;
  const receipt = parseInstallationReceipt(readPrivateJson(path, intent.targetUid));
  if (
    receipt.namespace !== createInstanceNamespace(intent) ||
    receipt.installationId !== intent.installationId ||
    receipt.uid !== intent.targetUid
  ) {
    throw new Error("Existing ownership receipt belongs to another Workstation instance.");
  }
  return receipt;
}

export function parseMaintenanceRequest(value: unknown): MaintenanceRequestV1 {
  if (!isRecord(value)) throw new Error("Maintenance request must be a JSON object.");
  if (
    (value.version !== DISTRIBUTION_SCHEMA_VERSION &&
      value.version !== PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION) ||
    value.packageId !== WORKSTATION_PACKAGE_ID ||
    typeof value.requestId !== "string" ||
    !isUuid(value.requestId) ||
    typeof value.issuedAt !== "string" ||
    !Number.isFinite(Date.parse(value.issuedAt)) ||
    typeof value.approvedPlanDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.approvedPlanDigest) ||
    (value.operation !== "install" &&
      value.operation !== "upgrade" &&
      value.operation !== "reconfigure" &&
      value.operation !== "rollback") ||
    (value.listenerPreflight !== "verified" && value.listenerPreflight !== "skipped-test") ||
    (value.targetReceiptId !== undefined &&
      (typeof value.targetReceiptId !== "string" || !isUuid(value.targetReceiptId)))
  ) {
    throw new Error("Maintenance request metadata is invalid.");
  }
  const intent = parseInstallationIntent(value.intent);
  if (intent.version !== value.version) {
    throw new Error("Maintenance request and intent versions do not match.");
  }
  return {
    version: intent.version,
    packageId: WORKSTATION_PACKAGE_ID,
    requestId: value.requestId,
    issuedAt: value.issuedAt,
    approvedPlanDigest: value.approvedPlanDigest,
    operation: value.operation,
    listenerPreflight: value.listenerPreflight,
    ...(value.targetReceiptId === undefined ? {} : { targetReceiptId: value.targetReceiptId }),
    intent,
  };
}

export function parseInstallationReceipt(value: unknown): InstallationReceiptV1 {
  if (!isRecord(value)) throw new Error("Installation receipt must be a JSON object.");
  if (
    (value.version !== DISTRIBUTION_SCHEMA_VERSION &&
      value.version !== PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION) ||
    (value.taskId !== DISTRIBUTION_TASK_ID &&
      value.taskId !== PRIVATE_INGRESS_DISTRIBUTION_TASK_ID) ||
    value.packageId !== WORKSTATION_PACKAGE_ID ||
    typeof value.receiptId !== "string" ||
    !isUuid(value.receiptId) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.operation !== "install" &&
      value.operation !== "upgrade" &&
      value.operation !== "reconfigure" &&
      value.operation !== "rollback") ||
    typeof value.namespace !== "string" ||
    typeof value.installationId !== "string" ||
    typeof value.uid !== "number" ||
    typeof value.planDigest !== "string" ||
    typeof value.stateFingerprint !== "string" ||
    typeof value.appliedAt !== "string" ||
    !isRecord(value.artifact) ||
    !isRecord(value.configurationDigests) ||
    !isRecord(value.webRelease) ||
    typeof value.vapidPublicKeyFingerprint !== "string" ||
    !isRecord(value.labels)
  ) {
    throw new Error("Installation receipt metadata is invalid.");
  }
  const intent = parseInstallationIntent(value.intent);
  const expectedTaskId = distributionDocumentTaskId(intent);
  if (value.version !== intent.version || value.taskId !== expectedTaskId) {
    throw new Error("Installation receipt version does not match its intent contract.");
  }
  if (
    isPrivateIngressInstallationIntent(intent) &&
    (typeof value.privateIngressIntentDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.privateIngressIntentDigest))
  ) {
    throw new Error("Private ingress receipt digest is invalid.");
  }
  if (
    isPrivateIngressInstallationIntent(intent) &&
    (typeof value.sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(value.sourceCommit))
  ) {
    throw new Error("Private ingress receipt source commit is invalid.");
  }
  const artifact = parseArtifactSummary(value.artifact);
  const configurationDigests = parseConfigurationDigests(value.configurationDigests);
  const webRelease = parseWebReceiptShape(value.webRelease);
  const labels = parseLabels(value.labels);
  return {
    version: intent.version,
    taskId: expectedTaskId,
    packageId: WORKSTATION_PACKAGE_ID,
    receiptId: value.receiptId,
    sequence: value.sequence as number,
    operation: value.operation,
    namespace: value.namespace,
    installationId: value.installationId,
    uid: value.uid,
    planDigest: value.planDigest,
    stateFingerprint: value.stateFingerprint,
    ...(typeof value.supersedesReceiptId === "string"
      ? { supersedesReceiptId: value.supersedesReceiptId }
      : {}),
    appliedAt: value.appliedAt,
    artifact,
    intent,
    ...(isPrivateIngressInstallationIntent(intent)
      ? { privateIngressIntentDigest: value.privateIngressIntentDigest as string }
      : {}),
    ...(isPrivateIngressInstallationIntent(intent)
      ? { sourceCommit: value.sourceCommit as string }
      : {}),
    configurationDigests,
    webRelease,
    vapidPublicKeyFingerprint: value.vapidPublicKeyFingerprint,
    labels,
  };
}

function configurationDigest(
  intent: WorkstationInstallationIntent,
  artifact: DistributionArtifactSummary,
  layout: WorkstationInstanceLayout,
  configuration: GeneratedInstanceConfiguration,
): DistributionConfigurationDigests {
  return {
    settings: digestJson({
      installationId: intent.installationId,
      canonicalBrowserOrigin: intent.canonicalBrowserOrigin,
      allowedProjectRoots: intent.allowedProjectRoots,
      nodeExecutable: layout.runtime.nodeExecutable,
      nodeRuntime: artifact.nodeRuntime ?? null,
      shellExecutable: intent.shellExecutable,
      codexExecutable: intent.codexExecutable,
      vapidSubject: intent.vapidSubject ?? intent.canonicalBrowserOrigin,
      ingress: intent.ingress,
    }),
    host: digestJson(configuration.host),
    gateway: digestJson(configuration.gateway),
    naruEnvironment: digestJson(configuration.naruEnvironment),
    webIdentity: digestJson({
      buildId: artifact.buildId,
      payloadDigest: artifact.payloadDigest,
      origin: intent.canonicalBrowserOrigin,
    }),
    launchAgents: Object.fromEntries(
      Object.entries(configuration.launchAgents).map(([service, source]) => [
        service,
        createHash("sha256").update(source).digest("hex"),
      ]),
    ) as unknown as Readonly<Record<ServiceName, string>>,
  };
}

function operationCheck(
  operation: DistributionOperation,
  current: InstallationReceiptV1 | undefined,
  rollback: InstallationReceiptV1 | undefined,
  artifact: VerifiedDistributionArtifact,
  targetIntent: WorkstationInstallationIntent,
): DistributionCheck {
  let valid: boolean;
  let actual: string;
  const currentTransactionSettings =
    current === undefined ? undefined : transactionSettingsDigest(current.intent, current.artifact);
  const targetTransactionSettings = transactionSettingsDigest(targetIntent, artifact.summary);
  const settingsChanged =
    currentTransactionSettings === undefined ||
    currentTransactionSettings !== targetTransactionSettings;
  const legacyRuntimeMigration =
    current !== undefined &&
    current.artifact.nodeRuntime === undefined &&
    artifact.summary.nodeRuntime !== undefined &&
    nonRuntimeSettingsDigest(current.intent) === nonRuntimeSettingsDigest(targetIntent);
  if (operation === "install") {
    valid = current === undefined;
    actual =
      current === undefined
        ? "fresh instance"
        : `already installed at receipt ${current.receiptId}`;
  } else if (operation === "upgrade") {
    valid =
      current !== undefined &&
      current.artifact.payloadDigest !== artifact.summary.payloadDigest &&
      (!settingsChanged || legacyRuntimeMigration);
    actual =
      current === undefined
        ? "instance is not installed"
        : `${current.artifact.buildId} -> ${artifact.summary.buildId}; approved settings ${
            legacyRuntimeMigration
              ? "unchanged; runtime external -> artifact"
              : settingsChanged
                ? "changed"
                : "unchanged"
          }`;
  } else if (operation === "reconfigure") {
    valid =
      current !== undefined &&
      current.artifact.payloadDigest === artifact.summary.payloadDigest &&
      settingsChanged;
    actual =
      current === undefined
        ? "instance is not installed"
        : `artifact ${
            current.artifact.payloadDigest === artifact.summary.payloadDigest
              ? "unchanged"
              : "changed"
          }; approved settings ${settingsChanged ? "changed" : "unchanged"}`;
  } else {
    valid =
      current !== undefined && rollback !== undefined && rollback.receiptId !== current.receiptId;
    actual =
      current === undefined || rollback === undefined
        ? "current or rollback receipt is missing"
        : `${current.receiptId} -> ${rollback.receiptId}`;
  }
  return {
    id: `transaction.${operation}`,
    status: valid ? "ok" : "blocked",
    expected:
      operation === "install"
        ? "fresh instance"
        : operation === "upgrade"
          ? "new artifact with unchanged approved settings or a one-way legacy external-to-artifact runtime migration"
          : operation === "reconfigure"
            ? "same artifact with changed approved settings"
            : "an earlier immutable receipt",
    actual,
    owner: "package",
    ...(valid ? {} : { remediation: "Choose the transaction matching the intended state change." }),
  };
}

function transactionSettingsDigest(
  intent: WorkstationInstallationIntent,
  artifact: DistributionArtifactSummary,
): string {
  return digestJson({
    nonRuntime: nonRuntimeSettings(intent),
    runtime:
      artifact.nodeRuntime === undefined
        ? { source: "external", nodeExecutable: intent.nodeExecutable }
        : { source: "artifact" },
  });
}

function nonRuntimeSettingsDigest(intent: WorkstationInstallationIntent): string {
  return digestJson(nonRuntimeSettings(intent));
}

function nonRuntimeSettings(intent: WorkstationInstallationIntent): unknown {
  return {
    installationId: intent.installationId,
    slug: intent.slug,
    targetUid: intent.targetUid,
    homeDirectory: intent.homeDirectory,
    canonicalBrowserOrigin: intent.canonicalBrowserOrigin,
    allowedProjectRoots: intent.allowedProjectRoots,
    shellExecutable: intent.shellExecutable,
    codexExecutable: intent.codexExecutable,
    vapidSubject: intent.vapidSubject ?? intent.canonicalBrowserOrigin,
    ingress: intent.ingress,
  };
}

function ingressPrerequisiteCheck(intent: WorkstationInstallationIntent): DistributionCheck {
  if (intent.ingress.kind !== "tailscale-serve") {
    return {
      id: "ingress.user-owned-prerequisites",
      status: "ok",
      expected: "network mutation remains outside package install",
      actual: intent.ingress.kind,
      owner: "user",
    };
  }
  return {
    id: "ingress.user-owned-prerequisites",
    status: "warning",
    expected: "tailnet owner has enabled MagicDNS/HTTPS and accepted CT disclosure",
    actual: "must be verified by a separate network plan before apply",
    owner: "user",
    remediation: "Review public Certificate Transparency disclosure before Tailscale Serve apply.",
  };
}

function createActions(
  operation: DistributionOperation,
  layout: WorkstationInstanceLayout,
  intent: WorkstationInstallationIntent,
  transition: OriginTransition,
): readonly DistributionAction[] {
  return [
    {
      id: "artifact.bootstrap-stage",
      phase: "filesystem",
      mutation: "package",
      target: layout.releaseRoot,
      rollback:
        "preserve the verified but unreferenced immutable release; only a receipt marks installation success",
    },
    {
      id: "maintenance.handoff",
      phase: "handoff",
      mutation: "service",
      target: layout.labels.maintenance,
      rollback: "one-shot exits without stopping the caller or current production Naru",
    },
    {
      id: "web.render",
      phase: "filesystem",
      mutation: "package",
      target: layout.webReleaseRoot,
      rollback: "preserve old/new browser state and restore the previous web release receipt",
    },
    {
      id: "credentials.preserve",
      phase: "credential",
      mutation: "package",
      target: layout.directories.credentials,
      rollback: "never rotate Host/VAPID secrets implicitly",
    },
    {
      id: "services.runtime",
      phase: "service",
      mutation: "service",
      target: `${layout.labels.host}, ${layout.labels.gateway}, ${layout.labels.naru}`,
      rollback: "bootout exact package labels and restart the previous immutable receipt",
    },
    {
      id: "network.separate-approval",
      phase: "network",
      mutation: "none",
      target: `${intent.ingress.kind}:${intent.ingress.profileId}`,
      rollback: "remove only a separately approved package-owned route",
    },
    {
      id: "browser.origin-transition",
      phase: "browser",
      mutation: "user-action",
      target: `${operation}:${layout.browser.origin}`,
      rollback: transition.changed
        ? "browser-owned old Origin install/cache/subscription is diagnosed, never force-deleted"
        : "no previous browser Origin is modified",
    },
  ];
}

function fingerprintState(
  layout: WorkstationInstanceLayout,
  receipt: InstallationReceiptV1 | undefined,
  services: Readonly<Record<ServiceName, ServiceRuntimeState>>,
  privateIngressStateFingerprint?: string,
  listenerStateFingerprint?: string,
): string {
  const files = [
    layout.files.ownership,
    layout.files.instance,
    layout.files.hostConfig,
    layout.files.gatewayConfig,
    layout.files.naruEnvironment,
    layout.files.localSessionCliCredential,
    layout.launchAgentFiles.host,
    layout.launchAgentFiles.gateway,
    layout.launchAgentFiles.naru,
  ].map((path) => ({ path, fingerprint: fingerprintFile(path) }));
  return digestJson({
    receiptId: receipt?.receiptId ?? null,
    files,
    services: {
      host: services.host,
      gateway: services.gateway,
      naru: services.naru,
    },
    privateIngressStateFingerprint: privateIngressStateFingerprint ?? null,
    listenerStateFingerprint: listenerStateFingerprint ?? null,
  });
}

function fingerprintFile(path: string): string {
  if (!existsSync(path)) return "missing";
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) return "unsafe";
  return createHash("sha256")
    .update(`${metadata.uid}:${metadata.mode & 0o777}:${metadata.size}:`)
    .update(readFileSync(path))
    .digest("hex");
}

function serviceStateMap(
  runtime: WorkstationRuntimeController,
  layout: WorkstationInstanceLayout,
): Readonly<Record<ServiceName, ServiceRuntimeState>> {
  return Object.fromEntries(
    (["host", "gateway", "naru", "maintenance"] as const).map((service) => [
      service,
      runtime.serviceState(layout.uid, layout.labels[service]),
    ]),
  ) as unknown as Readonly<Record<ServiceName, ServiceRuntimeState>>;
}

function changedRuntimeServices(plan: DistributionPlan): readonly RuntimeServiceName[] {
  const current = plan.currentReceipt;
  if (current === undefined || plan.operation === "upgrade") return [...RUNTIME_SERVICE_NAMES];
  const services = new Set<RuntimeServiceName>();
  if (
    current.configurationDigests.host !== plan.configurationDigests.host ||
    current.configurationDigests.launchAgents.host !== plan.configurationDigests.launchAgents.host
  ) {
    services.add("host");
  }
  if (
    current.configurationDigests.gateway !== plan.configurationDigests.gateway ||
    current.configurationDigests.launchAgents.gateway !==
      plan.configurationDigests.launchAgents.gateway
  ) {
    services.add("gateway");
  }
  if (
    current.configurationDigests.naruEnvironment !== plan.configurationDigests.naruEnvironment ||
    current.configurationDigests.webIdentity !== plan.configurationDigests.webIdentity ||
    current.configurationDigests.launchAgents.naru !== plan.configurationDigests.launchAgents.naru
  ) {
    services.add("naru");
  }
  if (services.has("host")) return [...RUNTIME_SERVICE_NAMES];
  if (services.has("gateway")) services.add("naru");
  return RUNTIME_SERVICE_NAMES.filter((service) => services.has(service));
}

function writeGeneratedConfiguration(
  layout: WorkstationInstanceLayout,
  configuration: GeneratedInstanceConfiguration,
): void {
  atomicWritePrivateFile(
    layout.files.instance,
    `${stableJson(configuration.instance)}\n`,
    layout.uid,
    {
      replace: true,
    },
  );
  atomicWritePrivateFile(
    layout.files.hostConfig,
    `${stableJson(configuration.host)}\n`,
    layout.uid,
    {
      replace: true,
    },
  );
  atomicWritePrivateFile(
    layout.files.gatewayConfig,
    `${stableJson(configuration.gateway)}\n`,
    layout.uid,
    { replace: true },
  );
  for (const service of ["host", "gateway", "naru", "maintenance"] as const) {
    atomicWritePrivateFile(
      layout.launchAgentFiles[service],
      configuration.launchAgents[service],
      layout.uid,
      { replace: true, parentPrivate: false },
    );
  }
}

function writeVerifierKeys(layout: WorkstationInstanceLayout, keys: GatewayVerifierKeySetV1): void {
  atomicWritePrivateFile(layout.files.gatewayVerifierKeys, `${stableJson(keys)}\n`, layout.uid, {
    replace: true,
  });
}

function writeInstallationReceipt(
  plan: DistributionPlan,
  artifact: DistributionArtifactSummary,
  webRelease: InstanceWebReleaseReceiptV1,
  vapidPublicKeyFingerprint: string,
  now: Date,
): InstallationReceiptV1 {
  const current = plan.currentReceipt;
  const receipt: InstallationReceiptV1 = {
    version: plan.targetIntent.version,
    taskId: distributionDocumentTaskId(plan.targetIntent),
    packageId: WORKSTATION_PACKAGE_ID,
    receiptId: randomUUID(),
    sequence: (current?.sequence ?? 0) + 1,
    operation: plan.operation,
    namespace: plan.layout.namespace,
    installationId: plan.layout.installationId,
    uid: plan.layout.uid,
    planDigest: plan.planDigest,
    stateFingerprint: plan.stateFingerprint,
    ...(current === undefined ? {} : { supersedesReceiptId: current.receiptId }),
    appliedAt: now.toISOString(),
    artifact: { ...artifact, root: plan.layout.releaseRoot },
    intent: {
      ...plan.targetIntent,
      artifactRoot: plan.layout.releaseRoot,
      nodeExecutable: plan.layout.runtime.nodeExecutable,
    },
    ...(plan.privateIngressIntentDigest === undefined
      ? {}
      : { privateIngressIntentDigest: plan.privateIngressIntentDigest }),
    ...(plan.sourceTransition === undefined
      ? {}
      : { sourceCommit: plan.sourceTransition.exactTarget.sourceCommit }),
    configurationDigests: plan.configurationDigests,
    webRelease,
    vapidPublicKeyFingerprint,
    labels: plan.layout.labels,
  };
  const receiptPath = join(
    plan.layout.directories.receipts,
    `${String(receipt.sequence).padStart(6, "0")}-${receipt.receiptId}.json`,
  );
  atomicWritePrivateFile(receiptPath, `${stableJson(receipt)}\n`, plan.layout.uid);
  atomicWritePrivateFile(plan.layout.files.ownership, `${stableJson(receipt)}\n`, plan.layout.uid, {
    replace: true,
  });
  return receipt;
}

function readRollbackReceipt(
  layout: WorkstationInstanceLayout,
  receiptId: string,
): InstallationReceiptV1 {
  if (!existsSync(layout.directories.receipts)) {
    throw new Error("Rollback receipt directory does not exist.");
  }
  for (const name of readdirSync(layout.directories.receipts).sort()) {
    if (!name.endsWith(`-${receiptId}.json`)) continue;
    return parseInstallationReceipt(
      readPrivateJson(join(layout.directories.receipts, name), layout.uid),
    );
  }
  throw new Error("Requested immutable rollback receipt was not found.");
}

function assertReceiptIdentity(
  receipt: InstallationReceiptV1 | undefined,
  layout: WorkstationInstanceLayout,
): void {
  if (receipt === undefined) return;
  if (
    receipt.namespace !== layout.namespace ||
    receipt.installationId !== layout.installationId ||
    receipt.uid !== layout.uid
  ) {
    throw new Error("Existing ownership receipt belongs to another Workstation instance.");
  }
}

async function assertPrivateIngressReceiptDigest(
  receipt: InstallationReceiptV1 | undefined,
): Promise<void> {
  if (receipt === undefined || !isPrivateIngressInstallationIntent(receipt.intent)) return;
  const actual = await digestPrivateIngressIntentV0(receipt.intent.ingress);
  if (actual !== receipt.privateIngressIntentDigest) {
    throw new Error("Private ingress receipt intent digest does not match its immutable intent.");
  }
}

function captureMutableFiles(layout: WorkstationInstanceLayout): readonly FileSnapshot[] {
  return [
    layout.files.instance,
    layout.files.hostConfig,
    layout.files.gatewayConfig,
    layout.files.naruEnvironment,
    layout.files.gatewayVerifierKeys,
    layout.launchAgentFiles.host,
    layout.launchAgentFiles.gateway,
    layout.launchAgentFiles.naru,
    layout.launchAgentFiles.maintenance,
  ]
    .filter((path) => existsSync(path))
    .map((path) => {
      assertPrivateFile(path, layout.uid);
      return { path, contents: readFileSync(path) };
    });
}

interface FileSnapshot {
  readonly path: string;
  readonly contents: Buffer;
}

function restoreMutableFiles(
  layout: WorkstationInstanceLayout,
  snapshots: readonly FileSnapshot[],
): void {
  for (const snapshot of snapshots) {
    atomicWritePrivateFile(snapshot.path, snapshot.contents, layout.uid, {
      replace: true,
      ...(snapshot.path.endsWith(".plist") ? { parentPrivate: false } : {}),
    });
  }
}

function removeFreshRuntimePlists(layout: WorkstationInstanceLayout): void {
  for (const service of RUNTIME_SERVICE_NAMES) {
    const path = layout.launchAgentFiles[service];
    if (!existsSync(path)) continue;
    assertPrivateFile(path, layout.uid);
    unlinkSync(path);
  }
}

function acquireMaintenanceLock(layout: WorkstationInstanceLayout, requestId: string): () => void {
  ensureInstanceDirectories(layout, layout.uid);
  const descriptor = openSync(
    layout.files.maintenanceLock,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  writeFileSync(descriptor, `${stableJson({ requestId, pid: process.pid })}\n`, "utf8");
  closeSync(descriptor);
  const identity = lstatSync(layout.files.maintenanceLock);
  return () => {
    try {
      const current = lstatSync(layout.files.maintenanceLock);
      if (current.dev === identity.dev && current.ino === identity.ino) {
        unlinkSync(layout.files.maintenanceLock);
      }
    } catch {
      // A missing lock is already released; a replaced lock belongs to another request.
    }
  };
}

function writeMaintenanceResult(
  layout: WorkstationInstanceLayout,
  result: MaintenanceResultV1,
): void {
  atomicWritePrivateFile(layout.files.maintenanceResult, `${stableJson(result)}\n`, layout.uid, {
    replace: true,
  });
}

function updateStage(
  layout: WorkstationInstanceLayout,
  result: MaintenanceResultV1,
  stage: string,
): MaintenanceResultV1 {
  const next = { ...result, stage };
  writeMaintenanceResult(layout, next);
  return next;
}

function refuseUnconsumedMaintenanceRequest(layout: WorkstationInstanceLayout): void {
  if (!existsSync(layout.files.maintenanceRequest)) return;
  const request = parseMaintenanceRequest(
    readPrivateJson(layout.files.maintenanceRequest, layout.uid),
  );
  if (!existsSync(layout.files.maintenanceResult)) {
    throw new Error(`Maintenance request ${request.requestId} has no terminal result.`);
  }
  const result = readPrivateJson(layout.files.maintenanceResult, layout.uid);
  if (
    !isRecord(result) ||
    result.requestId !== request.requestId ||
    (result.status !== "completed" && result.status !== "failed")
  ) {
    throw new Error(`Maintenance request ${request.requestId} is still active or ambiguous.`);
  }
}

function listenerProbeTargets(
  intent: WorkstationInstallationIntent,
  layout: WorkstationInstanceLayout,
  current: InstallationReceiptV1 | undefined,
): readonly ListenerProbeTarget[] {
  const desired = configuredListenerTargets(intent, layout);
  if (current === undefined) return desired;
  const currentTargets = new Set(
    configuredListenerTargets(current.intent, layout).map(listenerTargetKey),
  );
  return desired.filter((target) => !currentTargets.has(listenerTargetKey(target)));
}

function configuredListenerTargets(
  intent: WorkstationInstallationIntent,
  layout: WorkstationInstanceLayout,
): readonly ListenerProbeTarget[] {
  return isPrivateIngressInstallationIntent(intent)
    ? [intent.ingress.listener, { host: "127.0.0.1", port: layout.ports.naru }]
    : [
        { host: "127.0.0.1", port: layout.ports.gateway },
        { host: "127.0.0.1", port: layout.ports.naru },
      ];
}

function listenerTargetKey(target: ListenerProbeTarget): string {
  return `${target.host}:${target.port}`;
}

async function probeListenerTargets(
  targets: readonly ListenerProbeTarget[],
): Promise<{ readonly available: boolean; readonly detail: string }> {
  const servers: Server[] = [];
  try {
    for (const target of targets) servers.push(await holdPort(target));
    return {
      available: true,
      detail: targets.map((target) => `${target.host}:${target.port}`).join(","),
    };
  } catch (error) {
    return { available: false, detail: safeError(error) };
  } finally {
    await Promise.all(servers.map(closeServer));
  }
}

function holdPort(target: ListenerProbeTarget): Promise<Server> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen({ host: target.host, port: target.port, exclusive: true }, () => {
      server.removeAllListeners("error");
      resolvePromise(server);
    });
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolvePromise) => server.close(() => resolvePromise()));
}

function parseArtifactSummary(value: Record<string, unknown>): DistributionArtifactSummary {
  if (
    value.schemaVersion !== DISTRIBUTION_SCHEMA_VERSION ||
    value.packageId !== WORKSTATION_PACKAGE_ID ||
    typeof value.buildId !== "string" ||
    typeof value.manifestDigest !== "string" ||
    typeof value.payloadDigest !== "string" ||
    typeof value.root !== "string"
  ) {
    throw new Error("Receipt artifact summary is invalid.");
  }
  return {
    schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    buildId: value.buildId,
    manifestDigest: value.manifestDigest,
    payloadDigest: value.payloadDigest,
    root: value.root,
    features: parseArtifactFeatures(value.features),
    ...(value.nodeRuntime === undefined
      ? {}
      : { nodeRuntime: parsePackagedNodeRuntime(value.nodeRuntime) }),
  };
}

function parseArtifactFeatures(value: unknown): DistributionArtifactSummary["features"] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new Error("Receipt artifact features are invalid.");
  }
  if (value.some((feature) => feature !== ARTIFACT_FEATURE_LOCAL_SESSION_CLI)) {
    throw new Error("Receipt artifact features are invalid.");
  }
  const features = value as DistributionArtifactSummary["features"];
  if (
    new Set(features).size !== features.length ||
    features.join("\0") !== [...features].sort().join("\0")
  ) {
    throw new Error("Receipt artifact features are invalid.");
  }
  return features;
}

function parseConfigurationDigests(
  value: Record<string, unknown>,
): DistributionConfigurationDigests {
  if (
    typeof value.settings !== "string" ||
    typeof value.host !== "string" ||
    typeof value.gateway !== "string" ||
    typeof value.naruEnvironment !== "string" ||
    typeof value.webIdentity !== "string" ||
    !isRecord(value.launchAgents)
  ) {
    throw new Error("Receipt configuration digests are invalid.");
  }
  return {
    settings: value.settings,
    host: value.host,
    gateway: value.gateway,
    naruEnvironment: value.naruEnvironment,
    webIdentity: value.webIdentity,
    launchAgents: parseLabels(value.launchAgents),
  };
}

function parseLabels(value: Record<string, unknown>): Readonly<Record<ServiceName, string>> {
  const output: Partial<Record<ServiceName, string>> = {};
  for (const service of ["host", "gateway", "naru", "maintenance"] as const) {
    const item = value[service];
    if (typeof item !== "string") throw new Error(`Receipt ${service} value is invalid.`);
    output[service] = item;
  }
  return output as Readonly<Record<ServiceName, string>>;
}

function parseWebReceiptShape(value: Record<string, unknown>): InstanceWebReleaseReceiptV1 {
  const root = value.canonicalBrowserOrigin;
  if (typeof root !== "string") throw new Error("Receipt web release Origin is invalid.");
  // The filesystem verifier owns the full shape validation; receipt parsing keeps the same fields bounded.
  return {
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    buildId: requireString(value.buildId, "web build ID"),
    canonicalBrowserOrigin: root,
    rpId: requireString(value.rpId, "web RP ID"),
    basePayloadDigest: requireString(value.basePayloadDigest, "web base digest"),
    manifestSha256: requireString(value.manifestSha256, "manifest digest"),
    serviceWorkerRevision: requireString(value.serviceWorkerRevision, "worker revision"),
    contentDigest: requireString(value.contentDigest, "web content digest"),
  };
}

function requiredTargetReceiptId(options: { readonly targetReceiptId?: string }): string {
  if (options.targetReceiptId === undefined) {
    throw new Error("Rollback requires an explicit immutable target receipt ID.");
  }
  return options.targetReceiptId;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value === "") throw new Error(`Receipt ${label} is invalid.`);
  return value;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown Workstation failure.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function createOperatorSourceTransitionPlan(
  sourceCommit: string,
  artifact: DistributionArtifactSummary,
  gatewayConfigurationDigest: string,
): OperatorSourceTransitionPlan {
  return {
    mutation: "none",
    requiresSeparateOperatorApproval: true,
    exactTarget: {
      sourceCommit,
      artifactManifestDigest: artifact.manifestDigest,
      artifactPayloadDigest: artifact.payloadDigest,
      gatewayConfigurationDigest,
    },
    verification: [
      "Verify the operator-private admission names the approved repository identity and this exact source commit.",
      "Verify the expanded artifact manifest, payload and rendered Gateway configuration digests.",
      "Run isolated status and doctor checks before any canonical listener cutover.",
    ],
    rollback: [
      "Preserve the pre-existing service, data and source admission through cutover and soak.",
      "Restore only the previous immutable receipt and listener if candidate verification fails.",
      "Do not bypass a rejected operator admission with a manual production command.",
    ],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
