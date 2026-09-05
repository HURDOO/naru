#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { userInfo } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DISTRIBUTION_SCHEMA_VERSION, WORKSTATION_PACKAGE_ID } from "./constants.js";
import { createWorkstationAuthIntent, type WorkstationAuthOperation } from "./auth.js";
import { verifyDistributionArtifact } from "./artifact.js";
import { doctorDistribution } from "./doctor.js";
import {
  artifactNodeExecutable,
  parseInstallationIntent,
  type IngressKind,
  type WorkstationInstallationIntentV1,
} from "./model.js";
import { MacOsLaunchctlRuntimeController } from "./runtime.js";
import {
  planDistribution,
  stageMaintenanceHandoff,
  type DistributionOperation,
} from "./transaction.js";

type Command = "intent" | "plan" | "doctor" | "auth" | DistributionOperation;

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
  readonly canonicalBrowserOrigin: string;
  readonly projectRoots: readonly string[];
  readonly nodeExecutable?: string;
  readonly shellExecutable: string;
  readonly codexExecutable: string;
  readonly vapidSubject?: string;
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
      writeJson(report);
      return report.status === "healthy" ? 0 : report.status === "degraded" ? 3 : 4;
    }
    const operation =
      parsed.command === "plan" ? (parsed.operation as DistributionOperation) : parsed.command;
    const plan = await planDistribution(intent, operation, runtime, {
      ...(parsed.targetReceiptId === undefined ? {} : { targetReceiptId: parsed.targetReceiptId }),
    });
    if (parsed.command === "plan") {
      writeJson(plan);
      return plan.status === "ready" ? 0 : plan.status === "needs-input" ? 3 : 4;
    }
    if (parsed.approvedDigest === undefined) {
      throw new Error(`${parsed.command} requires --approve-digest from the reviewed plan.`);
    }
    const request = stageMaintenanceHandoff(plan, parsed.approvedDigest, runtime);
    writeJson({
      version: DISTRIBUTION_SCHEMA_VERSION,
      packageId: WORKSTATION_PACKAGE_ID,
      status: "handed-off",
      operation: parsed.command,
      requestId: request.requestId,
      maintenanceLabel: plan.layout.labels.maintenance,
      resultFile: plan.layout.files.maintenanceResult,
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
          message: error instanceof Error ? error.message : "Unknown Workstation CLI failure.",
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
    command !== "doctor" &&
    command !== "auth" &&
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
  let nodeExecutable: string | undefined;
  let shellExecutable: string | undefined;
  let codexExecutable: string | undefined;
  let vapidSubject: string | undefined;
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
          value !== "install" &&
          value !== "upgrade" &&
          value !== "reconfigure" &&
          value !== "rollback"
        ) {
          throw new Error("--operation must be install, upgrade, reconfigure, or rollback.");
        }
        operation = singleValue(operation, value, argument);
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
      case "--node":
        nodeExecutable = singleValue(nodeExecutable, resolve(value), argument);
        break;
      case "--shell":
        shellExecutable = singleValue(shellExecutable, resolve(value), argument);
        break;
      case "--codex":
        codexExecutable = singleValue(codexExecutable, resolve(value), argument);
        break;
      case "--vapid-subject":
        vapidSubject = singleValue(vapidSubject, value, argument);
        break;
      case "--ingress-kind":
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
        ingressProfileId = value;
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
      canonicalBrowserOrigin === undefined ||
      projectRoots.length === 0 ||
      shellExecutable === undefined ||
      codexExecutable === undefined
    ) {
      throw new Error(`intent is missing a required option.\n${usage()}`);
    }
    return {
      command,
      json: true,
      intentOptions: {
        installationId,
        slug,
        artifactRoot,
        canonicalBrowserOrigin,
        projectRoots,
        ...(nodeExecutable === undefined ? {} : { nodeExecutable }),
        shellExecutable,
        codexExecutable,
        ...(vapidSubject === undefined ? {} : { vapidSubject }),
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
  if (command === "doctor" && (approvedDigest !== undefined || operation !== undefined)) {
    throw new Error("doctor is read-only and does not accept operation approval arguments.");
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

function createIntent(options: IntentOptions): WorkstationInstallationIntentV1 {
  const identity = userInfo();
  const artifact = verifyDistributionArtifact(options.artifactRoot);
  if (artifact.summary.nodeRuntime !== undefined && options.nodeExecutable !== undefined) {
    throw new Error("Packaged Node artifacts do not accept an external --node override.");
  }
  if (artifact.summary.nodeRuntime === undefined && options.nodeExecutable === undefined) {
    throw new Error("Legacy artifacts require an explicit --node executable.");
  }
  const nodeExecutable = artifactNodeExecutable(artifact.summary, options.nodeExecutable);
  return parseInstallationIntent({
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    installationId: options.installationId,
    slug: options.slug,
    targetUid: identity.uid,
    homeDirectory: identity.homedir,
    artifactRoot: options.artifactRoot,
    canonicalBrowserOrigin: options.canonicalBrowserOrigin,
    allowedProjectRoots: options.projectRoots,
    nodeExecutable,
    shellExecutable: options.shellExecutable,
    codexExecutable: options.codexExecutable,
    ...(options.vapidSubject === undefined ? {} : { vapidSubject: options.vapidSubject }),
    ingress: { kind: options.ingressKind, profileId: options.ingressProfileId },
  });
}

function readPrivateIntent(path: string): WorkstationInstallationIntentV1 {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (process.getuid?.() !== undefined && metadata.uid !== process.getuid()) ||
    realpathSync(path) !== path ||
    metadata.size > 256 * 1024
  ) {
    throw new Error("Intent must be a canonical owner-only regular file.");
  }
  try {
    return parseInstallationIntent(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Intent file is invalid JSON.", { cause: error });
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
    "Usage: workstation <intent|plan|doctor|install|upgrade|reconfigure|rollback> --json",
    "  intent: --slug <label> --artifact <expanded-artifact> --origin <https-origin>",
    "          --project-root <allowed-parent> [--project-root ...]",
    "          --shell <shell> --codex <codex> [--node <legacy-external-node24>]",
    "          [--installation-id <uuid>] [--vapid-subject <https-or-mailto>]",
    "          [--ingress-kind <none|tailscale-serve|wireguard-direct|trusted-lan>]",
    "          [--ingress-profile <id>]",
    "  plan: --intent <private-intent.json> --operation <operation> [--target-receipt <uuid>]",
    "  doctor: --intent <private-intent.json>",
    "  auth bootstrap|recover: --intent <private-intent.json>",
    "  mutation: --intent <private-intent.json> --approve-digest <sha256>",
    "            rollback also requires --target-receipt <uuid>",
  ].join("\n");
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  process.exitCode = await runDistributionCli(process.argv.slice(2));
}
