import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { parseEnv } from "node:util";
import { loadGatewayVerifierKeys } from "../../../apps/server/src/gateway-auth.js";
import { digestPrivateIngressIntentV0 } from "../../../packages/contracts/src/private-ingress/v0/index.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { createRuntimeConfiguration } from "./configuration.js";
import { WORKSTATION_PACKAGE_ID } from "./constants.js";
import {
  createInstanceLayout,
  distributionDocumentTaskId,
  isPrivateIngressInstallationIntent,
  parseInstallationIntent,
  stableJson,
  type DistributionDocumentTaskId,
  type DistributionDocumentVersion,
  type WorkstationInstallationIntent,
} from "./model.js";
import {
  inspectPrivateIngressPreflight,
  type PrivateIngressPreflightDependencies,
} from "./private-ingress-preflight.js";
import {
  probePrivateIngressHttps,
  type PrivateIngressHttpsProbeResult,
} from "./private-ingress-doctor.js";
import {
  assertPrivateCredential,
  evaluateCodexDoctor,
  inspectTargetEnvironment,
  inspectManagedInstancePaths,
  inspectNativeRuntime,
  type CodexDoctorAssessment,
} from "./security.js";
import { parseVerifierKeys, type WorkstationRuntimeController } from "./runtime.js";
import {
  readCurrentReceiptForIntent,
  verifyReceiptRuntimeReleases,
  type DistributionCheck,
  type InstallationReceiptV1,
} from "./transaction.js";
import { verifyInstanceWebRelease } from "./web-release.js";

export interface WorkstationDoctorReport {
  readonly version: DistributionDocumentVersion;
  readonly taskId: DistributionDocumentTaskId;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly command: "doctor";
  readonly readOnly: true;
  readonly status: "healthy" | "degraded" | "blocked" | "unavailable";
  readonly namespace: string;
  readonly receiptId?: string;
  readonly canonicalBrowserOrigin: string;
  readonly checks: readonly DistributionCheck[];
  readonly browserOwnedChecks: readonly string[];
}

export async function doctorDistribution(
  requestedIntent: WorkstationInstallationIntent,
  runtime: WorkstationRuntimeController,
  options: {
    readonly codexDoctorReport?: unknown;
    readonly privateIngressPreflight?: Partial<PrivateIngressPreflightDependencies>;
    readonly probePrivateIngressHttps?: (
      intent: Extract<WorkstationInstallationIntent, { readonly version: 2 }>,
    ) => Promise<PrivateIngressHttpsProbeResult>;
  } = {},
): Promise<WorkstationDoctorReport> {
  const intent = parseInstallationIntent(requestedIntent);
  const current = readCurrentReceiptForIntent(intent);
  const sourceArtifact =
    current === undefined ? verifyDistributionArtifact(intent.artifactRoot) : undefined;
  const sourceLayout =
    current === undefined ? createInstanceLayout(intent, sourceArtifact!.summary) : undefined;
  const checks: DistributionCheck[] = [];
  if (current === undefined) {
    return {
      version: intent.version,
      taskId: distributionDocumentTaskId(intent),
      packageId: WORKSTATION_PACKAGE_ID,
      command: "doctor",
      readOnly: true,
      status: "blocked",
      namespace: sourceLayout!.namespace,
      canonicalBrowserOrigin: intent.canonicalBrowserOrigin,
      checks: [
        {
          id: "receipt.current",
          status: "blocked",
          expected: "an immutable current ownership receipt",
          actual: "missing",
          owner: "package",
          remediation: "Create and approve a fresh install plan.",
        },
      ],
      browserOwnedChecks: [],
    };
  }
  const installedArtifact = verifyDistributionArtifact(current.artifact.root);
  const layout = createInstanceLayout(current.intent, installedArtifact.summary);
  const runtimeReleases = verifyReceiptRuntimeReleases(current, layout);
  const expected = createRuntimeConfiguration(
    current.intent,
    installedArtifact.summary,
    layout,
    runtimeReleases,
  );
  const hostLayout = createInstanceLayout(current.intent, runtimeReleases.host);
  if (isPrivateIngressInstallationIntent(current.intent)) {
    const preflight = await inspectPrivateIngressPreflight(
      current.intent,
      options.privateIngressPreflight,
    );
    checks.push(...preflight.checks);
  }
  checks.push({
    id: "receipt.current",
    status: "ok",
    expected: "immutable receipt bound to package/namespace/UID/artifact",
    actual: `${current.receiptId}:${current.artifact.buildId}`,
    owner: "package",
  });
  if (isPrivateIngressInstallationIntent(current.intent)) {
    const actualDigest = await digestPrivateIngressIntentV0(current.intent.ingress);
    checks.push({
      id: "receipt.private-ingress-intent",
      status: actualDigest === current.privateIngressIntentDigest ? "ok" : "blocked",
      expected: "the immutable receipt digest matches its normalized private ingress intent",
      actual: actualDigest === current.privateIngressIntentDigest ? "verified" : "digest mismatch",
      owner: "package",
      ...(actualDigest === current.privateIngressIntentDigest
        ? {}
        : { remediation: "Restore an earlier immutable receipt and rerun doctor." }),
    });
  }

  checks.push(
    fileContentCheck("config.instance", layout.files.instance, expected.instance, layout.uid),
  );
  const pathIssues = inspectManagedInstancePaths(layout, layout.uid);
  checks.push({
    id: "filesystem.private-ancestors",
    status: pathIssues.length === 0 ? "ok" : "blocked",
    expected: "all package-managed ancestors are real target-owned mode-0700 directories",
    actual:
      pathIssues.length === 0
        ? "verified"
        : pathIssues.map((issue) => `${issue.reason}:${issue.path}`).join("; "),
    owner: "package",
    ...(pathIssues.length === 0
      ? {}
      : { remediation: "Repair the exact private ancestor without following symlinks." }),
  });
  checks.push(fileContentCheck("config.host", layout.files.hostConfig, expected.host, layout.uid));
  checks.push(
    fileContentCheck("config.gateway", layout.files.gatewayConfig, expected.gateway, layout.uid),
  );
  checks.push(
    naruEnvironmentCheck(layout.files.naruEnvironment, expected.naruEnvironment, layout.uid),
  );
  checks.push(localSessionCliCredentialCheck(layout, expected.localSessionCli !== undefined));
  for (const service of ["host", "gateway", "naru", "maintenance"] as const) {
    checks.push(
      textFileCheck(
        `launchd.${service}`,
        layout.launchAgentFiles[service],
        expected.launchAgents[service],
        layout.uid,
      ),
    );
  }

  try {
    const web = verifyInstanceWebRelease(layout.webReleaseRoot);
    checks.push({
      id: "pwa.instance-web-release",
      status:
        web.canonicalBrowserOrigin === layout.browser.origin &&
        (web.appBasePath ?? "/") === layout.appBasePath &&
        web.basePayloadDigest === current.artifact.payloadDigest
          ? "ok"
          : "blocked",
      expected:
        "manifest/meta/service-worker digest bound to the current canonical Origin and app base path",
      actual: `${web.canonicalBrowserOrigin}:${web.appBasePath ?? "/"}:${web.serviceWorkerRevision}`,
      owner: "package",
    });
  } catch (error) {
    checks.push(blockedCheck("pwa.instance-web-release", safeError(error), "package"));
  }

  try {
    inspectTargetEnvironment(current.intent, installedArtifact.summary.nodeRuntime);
    const inspected = new Set<string>();
    for (const release of [runtimeReleases.host, runtimeReleases.gateway, runtimeReleases.naru]) {
      if (inspected.has(release.manifestDigest)) continue;
      inspected.add(release.manifestDigest);
      const releaseLayout = createInstanceLayout(current.intent, release);
      inspectNativeRuntime(releaseLayout.runtime.nodeExecutable, releaseLayout.releaseRoot);
    }
    checks.push({
      id: "runtime.node-native",
      status: "ok",
      expected: "artifact-owned Node 24 is launchd-valid and loads packaged native modules",
      actual: `${layout.runtime.nodeSource}:${layout.runtime.nodeExecutable}`,
      owner: layout.runtime.nodeSource === "artifact" ? "package" : "user",
    });
  } catch (error) {
    checks.push(blockedCheck("runtime.node-native", safeError(error), "user"));
  }
  checks.push(localSessionCliArtifactCheck(hostLayout, expected.localSessionCli !== undefined));

  checks.push(verifierFileCheck(layout.files.gatewayVerifierKeys, layout.uid));
  if (current.intent.externalGateway !== undefined) {
    checks.push(
      verifierFileCheck(
        current.intent.externalGateway.verifierKeysFile,
        layout.uid,
        "credential.external-gateway-verifier-public",
        "user",
        true,
      ),
    );
  }
  for (const service of ["host", "gateway", "naru"] as const) {
    const state = runtime.serviceState(layout.uid, layout.labels[service]);
    checks.push({
      id: `service.${service}`,
      status: state === "running" ? "ok" : state === "unknown" ? "unavailable" : "blocked",
      expected: `running ${layout.labels[service]}`,
      actual: state,
      owner: "system",
    });
  }
  await appendReadinessChecks(checks, runtime, layout);
  if (isPrivateIngressInstallationIntent(current.intent)) {
    const directProbe = await (options.probePrivateIngressHttps ?? probePrivateIngressHttps)(
      current.intent,
    );
    checks.push({
      id: "private-ingress.https-chain",
      status:
        directProbe.status === "ready"
          ? "ok"
          : directProbe.status === "external-client-required"
            ? "warning"
            : "unavailable",
      expected: "exact direct HTTPS reaches a ready Gateway while Host and Naru are ready",
      actual:
        directProbe.status === "ready"
          ? "verified with the expected TLS material"
          : directProbe.status === "external-client-required"
            ? "the server address is not admitted as a source"
            : "direct HTTPS probe failed",
      owner: directProbe.status === "external-client-required" ? "browser" : "system",
      ...(directProbe.status === "ready"
        ? {}
        : {
            remediation:
              directProbe.status === "external-client-required"
                ? "Complete the HTTPS browser-chain check from an approved private source."
                : "Restore the exact private listener and rerun doctor.",
          }),
    });
  }

  const codexAssessment =
    options.codexDoctorReport === undefined
      ? runCodexDoctor(current)
      : evaluateCodexDoctor(options.codexDoctorReport);
  checks.push(codexCheck(codexAssessment));
  checks.push({
    id: "project.allowed-roots",
    status: "ok",
    expected:
      "allowed parent roots are policy; actual Projects must separately pass realpath containment",
    actual: current.intent.allowedProjectRoots.join(", "),
    owner: "user",
  });
  checks.push({
    id: "origin.single-source",
    status: "ok",
    expected: "Gateway/RP/Naru/PWA/Push use one exact receipt Origin",
    actual: layout.browser.origin,
    owner: "package",
  });

  return {
    version: current.intent.version,
    taskId: distributionDocumentTaskId(current.intent),
    packageId: WORKSTATION_PACKAGE_ID,
    command: "doctor",
    readOnly: true,
    status: reportStatus(checks),
    namespace: layout.namespace,
    receiptId: current.receiptId,
    canonicalBrowserOrigin: layout.browser.origin,
    checks,
    browserOwnedChecks: [
      `Confirm the installed PWA opens ${layout.browser.origin}.`,
      "Confirm no old-Origin service worker/cache/install remains unless intentionally preserved.",
      "Enable notifications only from the settings action, then verify a fresh same-Origin subscription.",
      "If the hostname changed, complete local owner bootstrap and register a new passkey.",
    ],
  };
}

function localSessionCliCredentialCheck(
  layout: ReturnType<typeof createInstanceLayout>,
  expected: boolean,
): DistributionCheck {
  if (!expected) {
    return {
      id: "credential.local-session-cli",
      status: "blocked",
      expected: "a distinct owner-only local CLI Host credential in the current artifact",
      actual: "current artifact does not declare local-session-cli-v1",
      owner: "package",
      remediation: "Upgrade to a verified artifact that includes the local Session CLI feature.",
    };
  }
  try {
    assertPrivateCredential(layout.files.hostCredential, layout.uid);
    assertPrivateCredential(layout.files.localSessionCliCredential, layout.uid);
    const naruCredential = readFileSync(layout.files.hostCredential, "utf8").trim();
    const cliCredential = readFileSync(layout.files.localSessionCliCredential, "utf8").trim();
    if (naruCredential === cliCredential) {
      throw new Error("Naru and local CLI credentials must be distinct.");
    }
    return {
      id: "credential.local-session-cli",
      status: "ok",
      expected: "distinct owner-only Naru and local CLI Host credentials",
      actual: "verified without exposing values",
      owner: "package",
    };
  } catch (error) {
    return blockedCheck("credential.local-session-cli", safeError(error), "package");
  }
}

function localSessionCliArtifactCheck(
  layout: ReturnType<typeof createInstanceLayout>,
  expected: boolean,
): DistributionCheck {
  if (!expected) {
    return blockedCheck(
      "runtime.local-session-cli",
      "current artifact does not declare local-session-cli-v1",
      "package",
    );
  }
  const result = spawnSync(
    layout.runtime.nodeExecutable,
    [layout.entrypoints.sessionCli, "--help"],
    {
      cwd: layout.releaseRoot,
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 256 * 1024,
      env: {
        HOME: layout.homeDirectory,
        LANG: "C",
        PATH: dirname(layout.runtime.nodeExecutable),
      },
    },
  );
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  if (result.error !== undefined || result.status !== 0 || !output.includes("Usage:")) {
    return blockedCheck(
      "runtime.local-session-cli",
      "packaged CLI did not reach its help boundary",
      "package",
    );
  }
  return {
    id: "runtime.local-session-cli",
    status: "ok",
    expected: "release-local Node loads the packaged durable-session CLI",
    actual: "help boundary verified",
    owner: "package",
  };
}

function runCodexDoctor(receipt: InstallationReceiptV1): CodexDoctorAssessment {
  const cwd = receipt.intent.allowedProjectRoots[0];
  if (cwd === undefined) return evaluateCodexDoctor(null);
  const result = spawnSync(receipt.intent.codexExecutable, ["doctor", "--json"], {
    cwd,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
    env: {
      HOME: receipt.intent.homeDirectory,
      SHELL: receipt.intent.shellExecutable,
      PATH: `${dirname(receipt.intent.codexExecutable)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    },
  });
  if (result.error !== undefined || result.status === null) return evaluateCodexDoctor(null);
  try {
    return evaluateCodexDoctor(JSON.parse(result.stdout) as unknown);
  } catch {
    return evaluateCodexDoctor(null);
  }
}

async function appendReadinessChecks(
  checks: DistributionCheck[],
  runtime: WorkstationRuntimeController,
  layout: ReturnType<typeof createInstanceLayout>,
): Promise<void> {
  for (const probe of [
    {
      id: "readiness.host",
      run: () => runtime.waitForUdsReady(layout.sockets.host, "/readyz"),
    },
    {
      id: "readiness.gateway",
      run: () => runtime.waitForUdsReady(layout.sockets.gatewayAdmin, "/readyz"),
    },
    {
      id: "readiness.naru",
      run: () => runtime.waitForHttpReady(layout.loopback.naruOrigin, "/readyz"),
    },
  ]) {
    try {
      await probe.run();
      checks.push({
        id: probe.id,
        status: "ok",
        expected: "exact private readiness endpoint returns HTTP 200",
        actual: "ready",
        owner: "system",
      });
    } catch (error) {
      checks.push({
        id: probe.id,
        status: "unavailable",
        expected: "exact private readiness endpoint returns HTTP 200",
        actual: safeError(error),
        owner: "system",
      });
    }
  }
}

function fileContentCheck(
  id: string,
  path: string,
  expected: unknown,
  uid: number,
): DistributionCheck {
  return textFileCheck(id, path, `${stableJson(expected)}\n`, uid);
}

function textFileCheck(id: string, path: string, expected: string, uid: number): DistributionCheck {
  try {
    const metadata = lstatPrivateFile(path, uid);
    const actual = readFileSync(path, "utf8");
    return {
      id,
      status: actual === expected ? "ok" : "blocked",
      expected: "exact receipt-derived owner-only regular file",
      actual: actual === expected ? `mode ${metadata.mode.toString(8)}` : "content drift",
      owner: "package",
    };
  } catch (error) {
    return blockedCheck(id, safeError(error), "package");
  }
}

function naruEnvironmentCheck(
  path: string,
  expected: Readonly<Record<string, string>>,
  uid: number,
): DistributionCheck {
  try {
    lstatPrivateFile(path, uid);
    const actual = parseEnv(readFileSync(path, "utf8"));
    const missingOrDrifted = Object.entries(expected)
      .filter(([name, value]) => actual[name] !== value)
      .map(([name]) => name);
    const vapidConfigured = [
      actual.NARU_VAPID_PUBLIC_KEY,
      actual.NARU_VAPID_PRIVATE_KEY,
      actual.NARU_VAPID_SUBJECT,
    ].every((value) => typeof value === "string" && value.length > 0);
    return {
      id: "config.naru-environment",
      status: missingOrDrifted.length === 0 && vapidConfigured ? "ok" : "blocked",
      expected: "exact non-secret settings and a complete private VAPID triplet",
      actual:
        missingOrDrifted.length === 0 && vapidConfigured
          ? "verified without exposing values"
          : `drifted names: ${missingOrDrifted.join(",")}; VAPID complete=${vapidConfigured}`,
      owner: "package",
    };
  } catch (error) {
    return blockedCheck("config.naru-environment", safeError(error), "package");
  }
}

function verifierFileCheck(
  path: string,
  uid: number,
  id = "credential.gateway-verifier-public",
  owner: DistributionCheck["owner"] = "package",
  validateNaruLoader = false,
): DistributionCheck {
  try {
    lstatPrivateFile(path, uid);
    parseVerifierKeys(JSON.parse(readFileSync(path, "utf8")) as unknown);
    if (validateNaruLoader) loadGatewayVerifierKeys(path);
    return {
      id,
      status: "ok",
      expected: "owner-only public Ed25519 verifier material without private keys",
      actual: "verified",
      owner,
    };
  } catch (error) {
    return blockedCheck(id, safeError(error), owner);
  }
}

function lstatPrivateFile(path: string, uid: number): { readonly mode: number } {
  if (!existsSync(path)) throw new Error("missing");
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== 0o600 ||
    metadata.size > 1024 * 1024
  ) {
    throw new Error("not an owner-only mode-0600 regular file");
  }
  return { mode: metadata.mode & 0o777 };
}

function codexCheck(assessment: CodexDoctorAssessment): DistributionCheck {
  return {
    id: "codex.required-doctor-checks",
    status: assessment.status === "ok" ? "ok" : assessment.status,
    expected: "installation, auth.credentials and config.load are ok",
    actual: `${Object.entries(assessment.requiredChecks)
      .map(([id, status]) => `${id}=${status ?? "missing"}`)
      .join(",")}; ignored unrelated failures=${assessment.ignoredUnrelatedFailures.join(",")}`,
    owner: "user",
    ...(assessment.remediation === undefined ? {} : { remediation: assessment.remediation }),
  };
}

function reportStatus(checks: readonly DistributionCheck[]): WorkstationDoctorReport["status"] {
  if (checks.some((check) => check.status === "blocked")) return "blocked";
  if (checks.some((check) => check.status === "unavailable")) return "unavailable";
  if (checks.some((check) => check.status === "warning")) return "degraded";
  return "healthy";
}

function blockedCheck(
  id: string,
  actual: string,
  owner: DistributionCheck["owner"],
): DistributionCheck {
  return {
    id,
    status: "blocked",
    expected: "receipt-derived safe state",
    actual,
    owner,
  };
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : "Unknown doctor failure.")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}
