import { existsSync } from "node:fs";
import {
  digestPrivateIngressIntentV0,
  redactPrivateIngressV0,
} from "../../../packages/contracts/src/private-ingress/v0/index.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { WORKSTATION_PACKAGE_ID } from "./constants.js";
import {
  createInstanceLayout,
  distributionDocumentTaskId,
  isPrivateIngressInstallationIntent,
  parseInstallationIntent,
  type DistributionDocumentTaskId,
  type DistributionDocumentVersion,
  type WorkstationInstallationIntent,
} from "./model.js";
import { readPrivateJson } from "./security.js";
import { readCurrentReceiptForIntent } from "./transaction.js";
import type { ServiceRuntimeState, WorkstationRuntimeController } from "./runtime.js";

export interface WorkstationStatusReport {
  readonly version: DistributionDocumentVersion;
  readonly taskId: DistributionDocumentTaskId;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly command: "status";
  readonly readOnly: true;
  readonly status: "not-installed" | "healthy" | "degraded" | "maintenance";
  readonly receipt?: {
    readonly receiptId: string;
    readonly sequence: number;
    readonly operation: string;
    readonly buildId: string;
    readonly planDigest: string;
  };
  readonly ingress: unknown;
  readonly services: Readonly<
    Record<"host" | "gateway" | "naru" | "maintenance", ServiceRuntimeState>
  >;
  readonly maintenance?: {
    readonly status: "running" | "completed" | "failed" | "unknown";
    readonly stage: string;
    readonly recovery?: string;
  };
}

export async function statusDistribution(
  requestedIntent: WorkstationInstallationIntent,
  runtime: WorkstationRuntimeController,
): Promise<WorkstationStatusReport> {
  const intent = parseInstallationIntent(requestedIntent);
  const receipt = readCurrentReceiptForIntent(intent);
  let artifactHealthy = true;
  let activeArtifactSummary = receipt?.artifact;
  try {
    activeArtifactSummary = verifyDistributionArtifact(
      receipt?.artifact.root ?? intent.artifactRoot,
    ).summary;
  } catch {
    if (receipt === undefined) throw new Error("Uninstalled intent artifact is unavailable.");
    artifactHealthy = false;
  }
  if (activeArtifactSummary === undefined) throw new Error("Artifact identity is unavailable.");
  const layout = createInstanceLayout(receipt?.intent ?? intent, activeArtifactSummary);
  const activeIntent = receipt?.intent ?? intent;
  const receiptIntegrity =
    receipt === undefined || !isPrivateIngressInstallationIntent(receipt.intent)
      ? true
      : (await digestPrivateIngressIntentV0(receipt.intent.ingress)) ===
        receipt.privateIngressIntentDigest;
  const services = Object.fromEntries(
    (["host", "gateway", "naru", "maintenance"] as const).map((service) => [
      service,
      runtime.serviceState(layout.uid, layout.labels[service]),
    ]),
  ) as WorkstationStatusReport["services"];
  const maintenance = readMaintenanceProjection(layout.files.maintenanceResult, layout.uid);
  const runtimeHealthy = (["host", "gateway", "naru"] as const).every(
    (service) => services[service] === "running",
  );
  const status =
    maintenance?.status === "running"
      ? "maintenance"
      : receipt === undefined
        ? "not-installed"
        : runtimeHealthy && maintenance?.status !== "failed" && receiptIntegrity && artifactHealthy
          ? "healthy"
          : "degraded";
  return {
    version: activeIntent.version,
    taskId: distributionDocumentTaskId(activeIntent),
    packageId: WORKSTATION_PACKAGE_ID,
    command: "status",
    readOnly: true,
    status,
    ...(receipt === undefined
      ? {}
      : {
          receipt: {
            receiptId: receipt.receiptId,
            sequence: receipt.sequence,
            operation: receipt.operation,
            buildId: receipt.artifact.buildId,
            planDigest: receipt.planDigest,
          },
        }),
    ingress: isPrivateIngressInstallationIntent(activeIntent)
      ? redactPrivateIngressV0(activeIntent.ingress)
      : {
          kind: activeIntent.ingress.kind,
          profileId: "[redacted-profile]",
        },
    services,
    ...(maintenance === undefined ? {} : { maintenance }),
  };
}

function readMaintenanceProjection(
  path: string,
  uid: number,
): WorkstationStatusReport["maintenance"] | undefined {
  if (!existsSync(path)) return undefined;
  try {
    const value = readPrivateJson(path, uid);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { status: "unknown", stage: "invalid" };
    }
    const record = value as Record<string, unknown>;
    const status =
      record.status === "running" || record.status === "completed" || record.status === "failed"
        ? record.status
        : "unknown";
    const stage = typeof record.stage === "string" ? record.stage.slice(0, 128) : "unknown";
    const recovery =
      typeof record.recovery === "string" ? record.recovery.slice(0, 128) : undefined;
    return { status, stage, ...(recovery === undefined ? {} : { recovery }) };
  } catch {
    return { status: "unknown", stage: "unreadable" };
  }
}
