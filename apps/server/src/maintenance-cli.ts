import { fileURLToPath } from "node:url";
import { executeQueuedMaintenance } from "./maintenance.js";

const [requestPointerFile, ...unexpected] = process.argv.slice(2);
const runtimeReleaseDirectory = fileURLToPath(new URL("../../../", import.meta.url));

try {
  if (requestPointerFile === undefined || unexpected.length > 0) {
    throw new Error("Usage: maintenance-cli <absolute-request-pointer-file>");
  }
  const result = await executeQueuedMaintenance(requestPointerFile, runtimeReleaseDirectory);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : "Naru maintenance failed.";
  process.stderr.write(`${message.replaceAll(/[\r\n\t]+/g, " ").slice(0, 500)}\n`);
}

// The maintenance LaunchAgent is intentionally one-shot. Handled failures are
// persisted in its private result file and must not trigger launchd retry loops.
process.exitCode = 0;
