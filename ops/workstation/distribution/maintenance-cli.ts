#!/usr/bin/env node
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { DISTRIBUTION_SCHEMA_VERSION, WORKSTATION_PACKAGE_ID } from "./constants.js";
import { MacOsLaunchctlRuntimeController } from "./runtime.js";
import {
  executeMaintenanceRequest,
  parseMaintenanceRequest,
  type MaintenanceRequestV1,
} from "./transaction.js";

export async function runMaintenanceCli(arguments_: readonly string[]): Promise<number> {
  try {
    if (process.env.NARU_PTY_HOSTED === "1") {
      throw new Error("Maintenance worker must not execute inline inside a Naru-owned PTY.");
    }
    if (process.platform === "darwin" && process.ppid !== 1) {
      throw new Error("Maintenance worker must be started by its independent launchd job.");
    }
    const request = readRequest(parseArguments(arguments_));
    const result = await executeMaintenanceRequest(request, new MacOsLaunchctlRuntimeController());
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        version: DISTRIBUTION_SCHEMA_VERSION,
        packageId: WORKSTATION_PACKAGE_ID,
        status: "error",
        message: error instanceof Error ? error.message : "Unknown maintenance worker failure.",
      })}\n`,
    );
    return 2;
  }
}

function parseArguments(arguments_: readonly string[]): string {
  if (arguments_.length !== 2 || arguments_[0] !== "--request" || arguments_[1] === undefined) {
    throw new Error("Usage: workstation-maintenance --request <private-request.json>");
  }
  return resolve(arguments_[1]);
}

function readRequest(path: string): MaintenanceRequestV1 {
  const metadata = lstatSync(path);
  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o777) !== 0o600 ||
    (process.getuid?.() !== undefined && metadata.uid !== process.getuid()) ||
    realpathSync(path) !== path ||
    metadata.size > 1024 * 1024
  ) {
    throw new Error("Maintenance request must be a canonical owner-only mode-0600 file.");
  }
  try {
    return parseMaintenanceRequest(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Maintenance request contains invalid JSON.", { cause: error });
    }
    throw error;
  }
}
