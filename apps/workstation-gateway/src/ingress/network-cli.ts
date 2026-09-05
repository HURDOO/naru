import { resolve } from "node:path";
import { readWorkstationNetworkConfig } from "./config.js";
import { WorkstationNetworkManager } from "./system.js";

export type NetworkCliCommand = "plan" | "status" | "doctor" | "apply" | "rollback";

export interface ParsedNetworkArguments {
  readonly command: NetworkCliCommand;
  readonly configPath: string;
  readonly profileId?: string;
  readonly operation: "apply" | "rollback";
  readonly approvedDigest?: string;
}

export async function executeNetworkCommand(parsed: ParsedNetworkArguments): Promise<unknown> {
  const config = readWorkstationNetworkConfig(parsed.configPath);
  const manager = new WorkstationNetworkManager(config);
  switch (parsed.command) {
    case "plan":
      return await manager.plan(requiredProfile(parsed), parsed.operation);
    case "status":
      return await manager.status();
    case "doctor":
      return await manager.doctor();
    case "apply":
      return await manager.apply(requiredProfile(parsed), requiredDigest(parsed));
    case "rollback":
      return await manager.rollback(requiredProfile(parsed), requiredDigest(parsed));
  }
}

export function parseNetworkArguments(arguments_: readonly string[]): ParsedNetworkArguments {
  const command = arguments_[0];
  if (
    command !== "plan" &&
    command !== "status" &&
    command !== "doctor" &&
    command !== "apply" &&
    command !== "rollback"
  ) {
    throw new Error(networkUsage());
  }
  let configPath: string | undefined;
  let profileId: string | undefined;
  let operation: "apply" | "rollback" = "apply";
  let approvedDigest: string | undefined;
  let json = false;
  for (let index = 1; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      if (json) throw new Error("--json may be provided only once.");
      json = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument ?? "argument"} requires a value.\n${networkUsage()}`);
    }
    switch (argument) {
      case "--config":
        configPath = singleValue(configPath, resolve(value), argument);
        break;
      case "--profile":
        profileId = singleValue(profileId, value, argument);
        break;
      case "--operation":
        if (command !== "plan" || (value !== "apply" && value !== "rollback")) {
          throw new Error("--operation is available only for plan and must be apply or rollback.");
        }
        operation = value;
        break;
      case "--approve-digest":
        approvedDigest = singleValue(approvedDigest, value, argument);
        break;
      default:
        throw new Error(`Unknown argument: ${argument ?? ""}.\n${networkUsage()}`);
    }
    index += 1;
  }
  if (!json) throw new Error("--json is required so the CLI has one deterministic output mode.");
  if (configPath === undefined) throw new Error(`--config is required.\n${networkUsage()}`);
  if ((command === "status" || command === "doctor") && profileId !== undefined) {
    throw new Error(`${command} reports every configured profile and does not accept --profile.`);
  }
  if (
    (command === "status" || command === "doctor" || command === "plan") &&
    approvedDigest !== undefined
  ) {
    throw new Error(`${command} is read-only and does not accept --approve-digest.`);
  }
  if (
    (command === "plan" || command === "apply" || command === "rollback") &&
    profileId === undefined
  ) {
    throw new Error(`${command} requires --profile.`);
  }
  return {
    command,
    configPath,
    ...(profileId === undefined ? {} : { profileId }),
    operation,
    ...(approvedDigest === undefined ? {} : { approvedDigest }),
  };
}

export function networkUsage(): string {
  return [
    "Usage: workstation-network <plan|status|doctor|apply|rollback> --config <private-json> --json",
    "  plan: --profile <id> [--operation <apply|rollback>]",
    "  apply|rollback: --profile <id> --approve-digest <reviewed-sha256>",
    "  status|doctor: reports all configured profiles without mutation",
  ].join("\n");
}

function requiredProfile(parsed: ParsedNetworkArguments): string {
  if (parsed.profileId === undefined) throw new Error(`${parsed.command} requires --profile.`);
  return parsed.profileId;
}

function requiredDigest(parsed: ParsedNetworkArguments): string {
  if (parsed.approvedDigest === undefined) {
    throw new Error(`${parsed.command} requires --approve-digest from a reviewed ready plan.`);
  }
  return parsed.approvedDigest;
}

function singleValue(current: string | undefined, next: string, name: string): string {
  if (current !== undefined) throw new Error(`${name} may be provided only once.`);
  return next;
}
