import { constants, accessSync, realpathSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";

const forwardedArguments = process.argv.slice(2);
if (forwardedArguments.length === 0) {
  console.error("run-node24 requires a script or Node arguments.");
  process.exit(2);
}

const node24 = findNode24();
const child = spawn(node24, forwardedArguments, {
  cwd: process.cwd(),
  env: process.env,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.once("error", (error) => {
  console.error(`Could not start Node 24: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = code ?? signalExitCode(signal);
});

function findNode24() {
  const candidates = [];
  if (process.env.NARU_NODE24_BIN) candidates.push(resolve(process.env.NARU_NODE24_BIN));
  candidates.push(process.execPath);
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory) candidates.push(join(directory, "node"));
  }
  candidates.push(
    "/opt/homebrew/opt/node@24/bin/node",
    "/usr/local/opt/node@24/bin/node",
    "/usr/local/bin/node",
    "/usr/bin/node",
  );

  const seen = new Set();
  for (const candidate of candidates) {
    const normalized = isAbsolute(candidate) ? candidate : resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    try {
      accessSync(normalized, constants.X_OK);
      const result = spawnSync(normalized, ["--version"], {
        encoding: "utf8",
        timeout: 5_000,
      });
      if (result.status === 0 && /^v24\./.test(result.stdout.trim())) {
        return realpathSync(normalized);
      }
    } catch {
      // Try the next deterministic candidate.
    }
  }

  throw new Error(
    "Node.js 24 LTS was not found. Set NARU_NODE24_BIN to an executable Node 24 binary.",
  );
}

function signalExitCode(signal) {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
