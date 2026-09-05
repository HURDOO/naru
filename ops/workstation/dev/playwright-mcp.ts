import { createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, relative, sep } from "node:path";
import {
  createRuntimeProfile,
  discoverRepositoryRoot,
  prepareRuntimeDirectories,
} from "./runtime-profile.js";

const checkOnly = process.argv.slice(2).includes("--check");
const unknownArguments = process.argv.slice(2).filter((argument) => argument !== "--check");
if (unknownArguments.length > 0) {
  throw new Error(`Unknown Playwright MCP launcher arguments: ${unknownArguments.join(", ")}`);
}
if (Number(process.versions.node.split(".")[0]) !== 24) {
  throw new Error(`Playwright MCP requires Node 24 LTS; received ${process.version}.`);
}

const repositoryRoot = discoverRepositoryRoot();
const canonicalCwd = realpathSync(process.cwd());
if (canonicalCwd !== repositoryRoot) {
  throw new Error(
    `Playwright MCP must inherit the current worktree root; cwd=${canonicalCwd}, root=${repositoryRoot}.`,
  );
}

const profile = createRuntimeProfile(repositoryRoot);
prepareRuntimeDirectories(profile);
const requireFromRoot = createRequire(join(repositoryRoot, "package.json"));
const playwrightCli = realpathSync(requireFromRoot.resolve("@playwright/test/cli"));
assertPathInsideWorktree(repositoryRoot, playwrightCli);

const proof = {
  schemaVersion: 1,
  createdAt: new Date().toISOString(),
  repositoryRoot,
  processCwd: canonicalCwd,
  gitHead: execFileSync("git", ["-C", repositoryRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim(),
  node: {
    version: process.version,
    executable: realpathSync(process.execPath),
  },
  playwrightCli,
  profileId: profile.profileId,
  inputs: [
    createFileMarker(repositoryRoot, ".codex/config.toml"),
    createFileMarker(repositoryRoot, "package.json"),
    createFileMarker(repositoryRoot, "pnpm-lock.yaml"),
  ],
  webBuild: existsSync(join(repositoryRoot, "apps/web/dist/index.html"))
    ? createFileMarker(repositoryRoot, "apps/web/dist/index.html")
    : null,
};

writePrivateMarker(profile.markerPath, `${JSON.stringify(proof, null, 2)}\n`);

if (checkOnly) {
  console.log(JSON.stringify({ status: "ok", markerPath: profile.markerPath, proof }, null, 2));
} else {
  const child = spawn(
    process.execPath,
    [playwrightCli, "mcp", "--browser=chrome", "--caps=testing"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        NARU_WORKSTATION_PROFILE_ID: profile.profileId,
        NARU_WORKTREE_ROOT: repositoryRoot,
      },
      stdio: "inherit",
    },
  );

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  child.once("error", (error) => {
    console.error(`Could not start Playwright MCP: ${error.message}`);
    process.exitCode = 1;
  });
  child.once("exit", (code, signal) => {
    process.exitCode = code ?? signalExitCode(signal);
  });
}

function createFileMarker(
  root: string,
  relativePath: string,
): {
  readonly path: string;
  readonly sha256: string;
} {
  const absolutePath = join(root, relativePath);
  return {
    path: relativePath,
    sha256: createHash("sha256").update(readFileSync(absolutePath)).digest("hex"),
  };
}

function assertPathInsideWorktree(root: string, path: string): void {
  const pathFromRoot = relative(root, path);
  if (pathFromRoot === ".." || pathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`Playwright CLI resolved outside the current worktree: ${path}`);
  }
}

function writePrivateMarker(path: string, contents: string): void {
  const descriptor = openSync(
    path,
    constants.O_CREAT | constants.O_TRUNC | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, contents, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === "SIGHUP") return 129;
  if (signal === "SIGINT") return 130;
  if (signal === "SIGTERM") return 143;
  return 1;
}
