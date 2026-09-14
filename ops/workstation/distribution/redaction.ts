import { redactPrivateIngressV0 } from "../../../packages/contracts/src/private-ingress/v0/index.js";
import { isPrivateIngressInstallationIntent } from "./model.js";
import type { WorkstationDoctorReport } from "./doctor.js";
import type { DistributionCheck, DistributionPlan } from "./transaction.js";

export function redactDistributionPlan(plan: DistributionPlan): unknown {
  return {
    version: plan.version,
    taskId: plan.taskId,
    packageId: plan.packageId,
    command: plan.command,
    readOnly: plan.readOnly,
    operation: plan.operation,
    status: plan.status,
    planDigest: plan.planDigest,
    stateFingerprint: plan.stateFingerprint,
    ...(plan.targetReceiptId === undefined ? {} : { targetReceiptId: plan.targetReceiptId }),
    artifact: {
      buildId: plan.artifact.buildId,
      manifestDigest: plan.artifact.manifestDigest,
      payloadDigest: plan.artifact.payloadDigest,
    },
    restartServices: plan.restartServices,
    runtimeBuilds: {
      host: plan.runtimeReleases.host.buildId,
      gateway: plan.runtimeReleases.gateway.buildId,
      naru: plan.runtimeReleases.naru.buildId,
    },
    ingress: isPrivateIngressInstallationIntent(plan.targetIntent)
      ? redactPrivateIngressV0(plan.targetIntent.ingress)
      : { kind: plan.targetIntent.ingress.kind, profileId: "[redacted-profile]" },
    ...(plan.privateIngressIntentDigest === undefined
      ? {}
      : { privateIngressIntentDigest: plan.privateIngressIntentDigest }),
    ...(plan.sourceTransition === undefined ? {} : { sourceTransition: plan.sourceTransition }),
    originTransition: plan.originTransition,
    checks: plan.checks.map(redactCheck),
    actions: plan.actions.map((action) => ({
      id: action.id,
      phase: action.phase,
      mutation: action.mutation,
      target: "[redacted-target]",
      rollback: action.rollback,
    })),
    approvalBoundaries: plan.approvalBoundaries,
  };
}

export function redactDoctorReport(report: WorkstationDoctorReport): unknown {
  return {
    version: report.version,
    taskId: report.taskId,
    packageId: report.packageId,
    command: report.command,
    readOnly: report.readOnly,
    status: report.status,
    receiptId: report.receiptId,
    canonicalBrowserOrigin: "[redacted-origin]",
    checks: report.checks.map(redactCheck),
    browserOwnedChecks: report.browserOwnedChecks.map(
      () => "Complete the owner-controlled browser check.",
    ),
  };
}

export function redactPublicError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown Workstation CLI failure.";
  return message
    .replace(/https:\/\/[^\s"'`]+/giu, "[redacted-origin]")
    .replace(
      /\b(?:10\.(?:\d{1,3}\.){2}\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3})\b/gu,
      "[redacted-address]",
    )
    .replace(/(["'])\/(?:[^\r\n"']+)(["'])/gu, "$1[redacted-path]$2")
    .replace(/\s\/(?:[^\s,;:)]+\/)*[^\s,;:)]+/gu, " [redacted-path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, 800);
}

function redactCheck(check: DistributionCheck): unknown {
  return {
    id: check.id,
    status: check.status,
    expected: check.expected,
    actual: check.status === "ok" ? "verified" : "see owner-only diagnostics",
    owner: check.owner,
    ...(check.remediation === undefined ? {} : { remediation: check.remediation }),
  };
}
