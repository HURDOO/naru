import { accessSync, constants, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createDatabaseBackupFromFile,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "./database-backup.js";
import { loadConfig } from "./config.js";
import {
  installGeneratedVapidConfiguration,
  readSecureEnvironmentFile,
} from "./environment-file.js";
import {
  parseMaintenanceConfirmationArgument,
  planProductionMaintenance,
  prepareAndQueueProductionMaintenance,
  readLatestMaintenanceResult,
  renderMaintenanceLaunchdTemplate,
} from "./maintenance.js";
import {
  activateRelease,
  preflightProductionEnvironmentFile,
  renderCertificateRenewalLaunchd,
  renderLaunchdTemplate,
  verifyRunningProductionService,
  writeReleaseManifest,
} from "./operations.js";

const [command, ...arguments_] = process.argv.slice(2);

try {
  const result = await run(command, arguments_);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : "Naru operation failed."}\n`);
  process.exitCode = 1;
}

async function run(commandName: string | undefined, args: string[]): Promise<unknown> {
  switch (commandName) {
    case "configure-vapid": {
      assertArgumentCount(args, 2, "configure-vapid <absolute-env-file> <https-or-mailto-subject>");
      return installGeneratedVapidConfiguration(
        requiredArgument(args, 0),
        requiredArgument(args, 1),
      );
    }
    case "preflight": {
      assertArgumentCount(args, 1, "preflight <absolute-env-file>");
      const environmentFile = requiredArgument(args, 0);
      return preflightProductionEnvironmentFile(environmentFile, process.cwd());
    }
    case "verify": {
      assertArgumentCount(args, 1, "verify <absolute-env-file>");
      const environmentFile = requiredArgument(args, 0);
      preflightProductionEnvironmentFile(environmentFile, process.cwd());
      const { values } = readSecureEnvironmentFile(environmentFile);
      return verifyRunningProductionService(loadConfig(values, process.cwd()));
    }
    case "backup": {
      assertArgumentCount(args, 3, "backup <absolute-env-file> <absolute-backup-dir> <build-id>");
      const { values } = readSecureEnvironmentFile(requiredArgument(args, 0));
      const config = loadConfig(values, process.cwd());
      return createDatabaseBackupFromFile(
        resolve(config.dataDir, "naru.sqlite"),
        requiredArgument(args, 1),
        requiredArgument(args, 2),
      );
    }
    case "verify-backup": {
      assertArgumentCount(args, 1, "verify-backup <absolute-backup-file>");
      return verifyDatabaseBackup(requiredArgument(args, 0));
    }
    case "restore": {
      assertArgumentCount(args, 2, "restore <absolute-backup-file> <empty-absolute-data-dir>");
      return restoreDatabaseBackup(requiredArgument(args, 0), requiredArgument(args, 1));
    }
    case "release-manifest": {
      assertArgumentCount(args, 2, "release-manifest <absolute-release-dir> <build-id>");
      return writeReleaseManifest(requiredArgument(args, 0), requiredArgument(args, 1));
    }
    case "activate-release": {
      assertArgumentCount(args, 2, "activate-release <absolute-releases-dir> <release-id>");
      return activateRelease(requiredArgument(args, 0), requiredArgument(args, 1));
    }
    case "render-launchd": {
      assertArgumentCount(
        args,
        8,
        "render-launchd <template> <output> <label> <node> <working-dir> <env-file> <stdout> <stderr>",
      );
      const [templateFile, outputFile, label, nodeExecutable, workingDirectory, environmentFile] =
        args;
      accessSync(requiredValue(nodeExecutable), constants.X_OK);
      readSecureEnvironmentFile(requiredValue(environmentFile));
      const rendered = renderLaunchdTemplate(readFileSync(requiredValue(templateFile), "utf8"), {
        label: requiredValue(label),
        nodeExecutable: requiredValue(nodeExecutable),
        workingDirectory: requiredValue(workingDirectory),
        environmentFile: requiredValue(environmentFile),
        standardOutPath: requiredArgument(args, 6),
        standardErrorPath: requiredArgument(args, 7),
      });
      writeFileSync(requiredValue(outputFile), rendered, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { status: "ok", outputFile };
    }
    case "render-maintenance-launchd": {
      assertArgumentCount(
        args,
        8,
        "render-maintenance-launchd <template> <output> <label> <node> <working-dir> <request-pointer> <stdout> <stderr>",
      );
      const [
        templateFile,
        outputFile,
        label,
        nodeExecutable,
        workingDirectory,
        requestPointerFile,
      ] = args;
      accessSync(requiredValue(nodeExecutable), constants.X_OK);
      const rendered = renderMaintenanceLaunchdTemplate(
        readFileSync(requiredValue(templateFile), "utf8"),
        {
          label: requiredValue(label),
          nodeExecutable: requiredValue(nodeExecutable),
          workingDirectory: requiredValue(workingDirectory),
          requestPointerFile: requiredValue(requestPointerFile),
          standardOutPath: requiredArgument(args, 6),
          standardErrorPath: requiredArgument(args, 7),
        },
      );
      writeFileSync(requiredValue(outputFile), rendered, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { status: "ok", outputFile };
    }
    case "render-certificate-renewal-launchd": {
      assertArgumentCount(
        args,
        11,
        "render-certificate-renewal-launchd <output> <label> <node> <working-dir> <hostname> <zone-name> <challenge-name> <token-file> <state-dir> <stdout> <stderr>",
      );
      const [
        outputFile,
        label,
        nodeExecutable,
        workingDirectory,
        hostname,
        zoneName,
        challengeName,
        tokenFile,
        stateDirectory,
      ] = args;
      accessSync(requiredValue(nodeExecutable), constants.X_OK);
      const rendered = renderCertificateRenewalLaunchd({
        label: requireCertificateRenewalLabel(label),
        nodeExecutable: requiredValue(nodeExecutable),
        workingDirectory: requiredValue(workingDirectory),
        hostname: requiredValue(hostname),
        zoneName: requiredValue(zoneName),
        challengeName: requiredValue(challengeName),
        tokenFile: requiredValue(tokenFile),
        stateDirectory: requiredValue(stateDirectory),
        standardOutPath: requiredArgument(args, 9),
        standardErrorPath: requiredArgument(args, 10),
      });
      writeFileSync(requiredValue(outputFile), rendered, {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      return { status: "ok", outputFile };
    }
    case "maintenance-status": {
      assertArgumentCount(args, 1, "maintenance-status <active-release-dir>");
      return readLatestMaintenanceResult(requiredArgument(args, 0));
    }
    case "maintenance-restart": {
      const confirmationId = parseOptionalMaintenanceConfirmation(
        args,
        1,
        "maintenance-restart <active-release-dir> [--confirm-pty-loss=<one-time-id>]",
      );
      const releaseDirectory = requiredArgument(args, 0);
      return confirmationId === undefined
        ? planProductionMaintenance("restart", releaseDirectory, undefined)
        : prepareAndQueueProductionMaintenance(
            "restart",
            releaseDirectory,
            undefined,
            confirmationId,
          );
    }
    case "maintenance-deploy": {
      const confirmationId = parseOptionalMaintenanceConfirmation(
        args,
        2,
        "maintenance-deploy <active-release-dir> <source-dir> [--confirm-pty-loss=<one-time-id>]",
      );
      const releaseDirectory = requiredArgument(args, 0);
      const sourceDirectory = requiredArgument(args, 1);
      return confirmationId === undefined
        ? planProductionMaintenance("deploy", releaseDirectory, sourceDirectory)
        : prepareAndQueueProductionMaintenance(
            "deploy",
            releaseDirectory,
            sourceDirectory,
            confirmationId,
          );
    }
    default:
      throw new Error(
        "Usage: operations-cli <configure-vapid|preflight|verify|backup|verify-backup|restore|release-manifest|activate-release|render-launchd|render-maintenance-launchd|render-certificate-renewal-launchd|maintenance-status|maintenance-restart|maintenance-deploy> ...",
      );
  }
}

function assertArgumentCount(args: string[], expected: number, usage: string): void {
  if (args.length !== expected) throw new Error(`Usage: operations-cli ${usage}`);
}

function parseOptionalMaintenanceConfirmation(
  args: string[],
  required: number,
  usage: string,
): string | undefined {
  if (args.length === required) return undefined;
  if (args.length !== required + 1) throw new Error(`Usage: operations-cli ${usage}`);
  return parseMaintenanceConfirmationArgument(requiredArgument(args, required));
}

function requiredArgument(args: string[], index: number): string {
  return requiredValue(args[index]);
}

function requiredValue(value: string | undefined): string {
  if (value === undefined || value.length === 0) throw new Error("Required argument is missing.");
  return value;
}

function requireCertificateRenewalLabel(value: string | undefined): "com.naru.certificate-renewal" {
  if (value !== "com.naru.certificate-renewal") {
    throw new Error("Certificate renewal LaunchAgent must use com.naru.certificate-renewal.");
  }
  return value;
}
