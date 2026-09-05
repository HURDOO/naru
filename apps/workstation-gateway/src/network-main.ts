#!/usr/bin/env node
import { executeNetworkCommand, parseNetworkArguments } from "./ingress/network-cli.js";

try {
  const parsed = parseNetworkArguments(process.argv.slice(2));
  const result = await executeNetworkCommand(parsed);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (isRecord(result)) {
    if (result.status === "blocked") process.exitCode = 4;
    else if (result.status === "unavailable") process.exitCode = 3;
  }
} catch (error) {
  process.stderr.write(
    `${JSON.stringify(
      {
        status: "error",
        message: error instanceof Error ? error.message : "Unknown workstation network failure.",
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = 2;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
