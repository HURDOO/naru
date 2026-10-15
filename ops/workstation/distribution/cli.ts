#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_SCHEMA_VERSION, WORKSTATION_PACKAGE_ID } from "./constants.js";
import { PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION } from "./constants.js";
import { NARU_DEFAULT_APP_BASE_PATH } from "../../../packages/contracts/src/naru-app/v1/index.js";
import { PrivateIngressV0Schema } from "../../../packages/contracts/src/private-ingress/v0/index.js";
import { createWorkstationAuthIntent, type WorkstationAuthOperation } from "./auth.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { doctorDistribution } from "./doctor.js";
import { redactDistributionPlan, redactDoctorReport, redactPublicError } from "./redaction.js";
import { statusDistribution } from "./status.js";
import {
  artifactNodeExecutable,
  parseInstallationIntent,
  type IngressKind,
  type WorkstationInstallationIntent,
} from "./model.js";
import { MacOsLaunchctlRuntimeController } from "./runtime.js";
import {
  planDistribution,
  stageMaintenanceHandoff,
  type DistributionOperation,
} from "./transaction.js";

type Command = "intent" | "plan" | "status" | "doctor" | "auth" | "apply" | DistributionOperation;

interface ParsedArguments {
  readonly command: Command;
  readonly json: true;
  readonly intentFile?: string;
  readonly operation?: DistributionOperation;
  readonly approvedDigest?: string;
  readonly targetReceiptId?: string;
  readonly authOperation?: WorkstationAuthOperation;
  readonly intentOptions?: IntentOptions;
}

interface IntentOptions {
  readonly installationId: string;
  readonly slug: string;
  readonly artifactRoot: string;
  readonly canonicalBrowserOrigin?: string;
  readonly projectRoots: readonly string[];
  readonly exactProjectRoots: readonly string[];
  readonly nodeExecutable?: string;
  readonly shellExecutable: string;
  readonly codexExecutable: string;
  readonly claudeExecutable?: string;
  readonly appBasePath?: string;
  readonly externalGatewayFile?: string;
  readonly defaultAgentPaneKind?: "codex" | "claude";
  readonly claudeAgentSdkPath?: string;
  readonly vapidSubject?: string;
  readonly privateIngressFile?: string;
  readonly ingressKind: IngressKind;
  readonly ingressProfileId: string;
}

export async function runDistributionCli(arguments_: readonly string[]): Promise<number> {
  try {
    const parsed = parseDistributionArguments(arguments_);
    const runtime = new MacOsLaunchctlRuntimeController();
    if (parsed.command === "intent") {
      writeJson(createIntent(parsed.intentOptions as IntentOptions));
      return 0;
    }
    const intent = readPrivateIntent(parsed.intentFile as string);
    if (parsed.command === "auth") {
      writeJson(
        await createWorkstationAuthIntent(intent, parsed.authOperation as WorkstationAuthOperation),
      );
      return 0;
    }
    if (parsed.command === "doctor") {
      const report = await doctorDistribution(intent, runtime);
      writeJson(redactDoctorReport(report));
      return report.status === "healthy" ? 0 : report.status === "degraded" ? 3 : 4;
    }
    if (parsed.command === "status") {
      const report = await statusDistribution(intent, runtime);
      writeJson(report);
      return report.status === "healthy" || report.status === "not-installed" ? 0 : 3;
    }
    const operation =
      parsed.command === "plan"
        ? (parsed.operation as DistributionOperation)
        : parsed.command === "apply"
          ? "install"
          : parsed.command;
    const plan = await planDistribution(intent, operation, runtime, {
      ...(parsed.targetReceiptId === undefined ? {} : { targetReceiptId: parsed.targetReceiptId }),
    });
    if (parsed.command === "plan") {
      writeJson(redactDistributionPlan(plan));
      return plan.status === "ready" ? 0 : plan.status === "needs-input" ? 3 : 4;
    }
    if (parsed.approvedDigest === undefined) {
      throw new Error(`${parsed.command} requires --approve-digest from the reviewed plan.`);
    }
    const request = stageMaintenanceHandoff(plan, parsed.approvedDigest, runtime);
    writeJson({
      version: plan.targetIntent.version,
      packageId: WORKSTATION_PACKAGE_ID,
      status: "handed-off",
      operation,
      requestId: request.requestId,
      maintenanceLabel: plan.layout.labels.maintenance,
      resultFile: "[owner-only-result-file]",
      callerPreserved: process.env.NARU_PTY_HOSTED === "1",
    });
    return 0;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify(
        {
          version: DISTRIBUTION_SCHEMA_VERSION,
          packageId: WORKSTATION_PACKAGE_ID,
          status: "error",
          message: redactPublicError(error),
        },
        null,
        2,
      )}\n`,
    );
    return 2;
  }
}

export function parseDistributionArguments(arguments_: readonly string[]): ParsedArguments {
  const command = arguments_[0];
  if (
    command !== "intent" &&
    command !== "plan" &&
    command !== "status" &&
    command !== "doctor" &&
    command !== "auth" &&
    command !== "apply" &&
    command !== "install" &&
    command !== "upgrade" &&
    command !== "reconfigure" &&
    command !== "rollback"
  ) {
    throw new Error(usage());
  }
  const authOperation = command === "auth" ? arguments_[1] : undefined;
  if (command === "auth" && authOperation !== "bootstrap" && authOperation !== "recover") {
    throw new Error(`auth requires bootstrap or recover.\n${usage()}`);
  }
  let json = false;
  let intentFile: string | undefined;
  let operation: DistributionOperation | undefined;
  let approvedDigest: string | undefined;
  let targetReceiptId: string | undefined;
  let installationId: string = randomUUID();
  let slug: string | undefined;
  let artifactRoot: string | undefined;
  let canonicalBrowserOrigin: string | undefined;
  const projectRoots: string[] = [];
  const exactProjectRoots: string[] = [];
  let nodeExecutable: string | undefined;
  let shellExecutable: string | undefined;
  let codexExecutable: string | undefined;
  let claudeExecutable: string | undefined;
  let appBasePath: string | undefined;
  let externalGatewayFile: string | undefined;
  let defaultAgentPaneKind: "codex" | "claude" | undefined;
  let claudeAgentSdkPath: string | undefined;
  let vapidSubject: string | undefined;
  let privateIngressFile: string | undefined;
  let ingressOptionProvided = false;
  let ingressKind: IngressKind = "none";
  let ingressProfileId = "local-only";

  for (let index = command === "auth" ? 2 : 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      if (json) throw new Error("--json may be supplied only once.");
      json = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument ?? "argument"} requires a value.\n${usage()}`);
    }
    switch (argument) {
      case "--intent":
        intentFile = singleValue(intentFile, resolve(value), argument);
        break;
      case "--operation":
        if (
          value !== "apply" &&
          value !== "install" &&
          value !== "upgrade" &&
          value !== "reconfigure" &&
          value !== "rollback"
        ) {
          throw new Error("--operation must be apply, install, upgrade, reconfigure, or rollback.");
        }
        operation = singleValue(operation, value === "apply" ? "install" : value, argument);
        break;
      case "--approve-digest":
        approvedDigest = singleValue(approvedDigest, value, argument);
        break;
      case "--target-receipt":
        targetReceiptId = singleValue(targetReceiptId, value, argument);
        break;
      case "--installation-id":
        installationId = value;
        break;
      case "--slug":
        slug = singleValue(slug, value, argument);
        break;
      case "--artifact":
        artifactRoot = singleValue(artifactRoot, resolve(value), argument);
        break;
      case "--origin":
        canonicalBrowserOrigin = singleValue(canonicalBrowserOrigin, value, argument);
        break;
      case "--project-root":
        projectRoots.push(resolve(value));
        break;
      case "--exact-project-root":
        exactProjectRoots.push(resolve(value));
        break;
      case "--node":
        nodeExecutable = singleValue(nodeExecutable, resolve(value), argument);
        break;
      case "--shell":
        shellExecutable = singleValue(shellExecutable, resolve(value), argument);
        break;
      case "--codex":
        codexExecutable = singleValue(codexExecutable, resolve(value), argument);
        break;
      case "--claude":
        claudeExecutable = singleValue(claudeExecutable, resolve(value), argument);
        break;
      case "--app-base-path":
        appBasePath = singleValue(appBasePath, value, argument);
        break;
      case "--external-gateway":
        externalGatewayFile = singleValue(externalGatewayFile, resolve(value), argument);
        break;
      case "--default-agent-pane-kind":
        if (value !== "codex" && value !== "claude") {
          throw new Error("--default-agent-pane-kind must be codex or claude.");
        }
        defaultAgentPaneKind = singleValue(defaultAgentPaneKind, value, argument);
        break;
      case "--claude-agent-sdk":
        claudeAgentSdkPath = singleValue(claudeAgentSdkPath, resolve(value), argument);
        break;
      case "--vapid-subject":
        vapidSubject = singleValue(vapidSubject, value, argument);
        break;
      case "--ingress-kind":
        ingressOptionProvided = true;
        if (
          value !== "none" &&
          value !== "tailscale-serve" &&
          value !== "wireguard-direct" &&
          value !== "trusted-lan"
        ) {
          throw new Error("--ingress-kind is unsupported.");
        }
        ingressKind = value;
        break;
      case "--ingress-profile":
        ingressOptionProvided = true;
        ingressProfileId = value;
        break;
      case "--private-ingress":
        privateIngressFile = singleValue(privateIngressFile, resolve(value), argument);
        break;
      default:
        throw new Error(`Unknown argument: ${argument ?? ""}.\n${usage()}`);
    }
    index += 1;
  }
  if (!json) throw new Error("--json is required for deterministic machine output.");
  if (command === "intent") {
    if (
      slug === undefined ||
      artifactRoot === undefined ||
      (canonicalBrowserOrigin === undefined && privateIngressFile === undefined) ||
      projectRoots.length === 0 ||
      shellExecutable === undefined ||
      codexExecutable === undefined
    ) {
      throw new Error(`intent is missing a required option.\n${usage()}`);
    }
    if (
      privateIngressFile !== undefined &&
      (canonicalBrowserOrigin !== undefined || ingressOptionProvided)
    ) {
      throw new Error(
        "--private-ingress cannot be combined with --origin or legacy ingress options.",
      );
    }
    if (externalGatewayFile !== undefined && privateIngressFile !== undefined) {
      throw new Error("--external-gateway requires the isolated v1 loopback installation.");
    }
    return {
      command,
      json: true,
      intentOptions: {
        installationId,
        slug,
        artifactRoot,
        ...(canonicalBrowserOrigin === undefined ? {} : { canonicalBrowserOrigin }),
        projectRoots,
        exactProjectRoots,
        ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
        shellExecutable,
        codexExecutable,
        ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
        ...(appBasePath === undefined ? {} : { appBasePath }),
        ...(externalGatewayFile === undefined ? {} : { externalGatewayFile }),
        ...(defaultAgentPaneKind === undefined ? {} : { defaultAgentPaneKind }),
        ...(claudeAgentSdkPath === undefined ? {} : { claudeAgentSdkPath }),
        ...(vapidSubject === undefined ? {} : { vapidSubject }),
        ...(privateIngressFile === undefined ? {} : { privateIngressFile }),
        ingressKind,
        ingressProfileId,
      },
    };
  }
  if (intentFile === undefined) throw new Error(`--intent is required.\n${usage()}`);
  if (command === "auth") {
    if (operation !== undefined || approvedDigest !== undefined || targetReceiptId !== undefined) {
      throw new Error("auth does not accept plan, receipt, or mutation approval arguments.");
    }
    return {
      command,
      json: true,
      intentFile,
      authOperation: authOperation as WorkstationAuthOperation,
    };
  }
  if (command === "plan" && operation === undefined) {
    throw new Error("plan requires --operation.");
  }
  if (command !== "plan" && command !== "rollback" && targetReceiptId !== undefined) {
    throw new Error("--target-receipt is accepted only by plan --operation rollback or rollback.");
  }
  if (command === "rollback" && targetReceiptId === undefined) {
    throw new Error("rollback requires --target-receipt.");
  }
  if (
    (command === "doctor" || command === "status") &&
    (approvedDigest !== undefined || operation !== undefined || targetReceiptId !== undefined)
  ) {
    throw new Error(`${command} is read-only and does not accept operation approval arguments.`);
  }
  return {
    command,
    json: true,
    intentFile,
    ...(operation === undefined ? {} : { operation }),
    ...(approvedDigest === undefined ? {} : { approvedDigest }),
    ...(targetReceiptId === undefined ? {} : { targetReceiptId }),
  };
}

function createIntent(options: IntentOptions): WorkstationInstallationIntent {
  const identity = userInfo();
  const artifact = verifyDistributionArtifact(options.artifactRoot);
  if (artifact.summary.nodeRuntime !== undefined && options.nodeExecutable !== undefined) {
    throw new Error("Packaged Node artifacts do not accept an external --node override.");
  }
  if (artifact.summary.nodeRuntime === undefined && options.nodeExecutable === undefined) {
    throw new Error("Legacy artifacts require an explicit --node executable.");
  }
  const nodeExecutable = artifactNodeExecutable(artifact.summary, options.nodeExecutable);
  const privateIngress =
    options.privateIngressFile === undefined
      ? undefined
      : PrivateIngressV0Schema.parse(
          readOwnerOnlyJson(options.privateIngressFile, "Private ingress"),
        );
  const externalGateway =
    options.externalGatewayFile === undefined
      ? undefined
      : readOwnerOnlyJson(options.externalGatewayFile, "External Gateway binding");
  return parseInstallationIntent({
    version:
      privateIngress === undefined
        ? DISTRIBUTION_SCHEMA_VERSION
        : PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    installationId: options.installationId,
    slug: options.slug,
    targetUid: identity.uid,
    homeDirectory: identity.homedir,
    artifactRoot: options.artifactRoot,
    naruAppBasePath: options.appBasePath ?? NARU_DEFAULT_APP_BASE_PATH,
    ...(externalGateway === undefined ? {} : { externalGateway }),
    ...(options.defaultAgentPaneKind === undefined
      ? {}
      : { defaultAgentPaneKind: options.defaultAgentPaneKind }),
    // The Agent Platform is opt-in; its Claude agents use the SDK the user installed (AP-D012).
    ...(options.claudeAgentSdkPath === undefined
      ? {}
      : { agentPlatform: { claudeAgentSdkPath: options.claudeAgentSdkPath } }),
    canonicalBrowserOrigin: privateIngress?.browserOrigin ?? options.canonicalBrowserOrigin,
    allowedProjectRoots: options.projectRoots,
    ...(options.exactProjectRoots.length === 0
      ? {}
      : { exactProjectRoots: options.exactProjectRoots }),
    nodeExecutable,
    shellExecutable: options.shellExecutable,
    codexExecutable: options.codexExecutable,
    ...(options.claudeExecutable === undefined
      ? {}
      : { claudeExecutable: options.claudeExecutable }),
    ...(options.vapidSubject === undefined ? {} : { vapidSubject: options.vapidSubject }),
    ingress: privateIngress ?? { kind: options.ingressKind, profileId: options.ingressProfileId },
  });
}

function readPrivateIntent(path: string): WorkstationInstallationIntent {
  return parseInstallationIntent(readOwnerOnlyJson(path, "Intent"));
}

function readOwnerOnlyJson(path: string, label: string): unknown {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && metadata.uid !== process.getuid()) ||
    realpathSync(path) !== path ||
    metadata.size > 256 * 1024
  ) {
    throw new Error(`${label} must be a canonical owner-only regular file.`);
  }
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(`${label} file is invalid JSON.`, { cause: error });
    }
    throw error;
  }
}

function singleValue<T>(current: T | undefined, next: T, name: string): T {
  if (current !== undefined) throw new Error(`${name} may be supplied only once.`);
  return next;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function usage(): string {
  return [
    "Usage: workstation <intent|plan|status|doctor|apply|install|upgrade|reconfigure|rollback> --json",
    "  intent: --slug <label> --artifact <expanded-artifact> --origin <https-origin>",
    "          --project-root <allowed-parent> [--project-root ...]",
    "          [--exact-project-root <listed-project-root> ...]",
    "          --shell <shell> --codex <codex> [--claude <claude>] [--node <legacy-external-node24>]",
    "          [--app-base-path <route>] [--default-agent-pane-kind <codex|claude>]",
    "          [--external-gateway <owner-only-binding.json>] (isolated v1 app only)",
    "          [--claude-agent-sdk <sdk.mjs>] (turns on the Agent Platform; needs --claude)",
    "          [--installation-id <uuid>] [--vapid-subject <https-or-mailto>]",
    "          [--ingress-kind <none|tailscale-serve|wireguard-direct|trusted-lan>]",
    "          [--ingress-profile <id>]",
    "          or --private-ingress <owner-only-private-ingress-v0.json> instead of --origin/legacy ingress",
    "  plan: --intent <private-intent.json> --operation <apply|install|upgrade|reconfigure|rollback>",
    "  status|doctor: --intent <private-intent.json>",
    "  auth bootstrap|recover: --intent <private-intent.json>",
    "  mutation: --intent <private-intent.json> --approve-digest <sha256>",
    "            rollback also requires --target-receipt <uuid>",
  ].join("\n");
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  process.exitCode = await runDistributionCli(process.argv.slice(2));
}
