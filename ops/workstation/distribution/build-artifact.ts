#!/usr/bin/env node
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeDistributionArtifactManifest } from "./artifact.js";
import {
  ARTIFACT_ARCHITECTURE,
  ARTIFACT_FEATURE_LOCAL_SESSION_CLI,
  ARTIFACT_PLATFORM,
  DISTRIBUTION_SCHEMA_VERSION,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_EXECUTABLE_MODE,
  PRIVATE_FILE_MODE,
  SUPPORTED_NODE_MAJOR,
  WORKSTATION_PACKAGE_ID,
  workstationArtifactName,
} from "./constants.js";
import { stableJson } from "./model.js";
import { PACKAGED_NODE_RUNTIME } from "./node-runtime.js";
import { assertNoSymlinkComponents, inspectPackagedNodeRuntime } from "./security.js";

interface BuildArguments {
  readonly outputParent: string;
  readonly buildId: string;
  readonly nodeRuntimeArchive: string;
  readonly json: true;
}

export function buildDistributionArtifact(arguments_: readonly string[]): unknown {
  const input = parseArguments(arguments_);
  assertBuildRuntime();
  const repositoryRoot = requireRepositoryRoot(process.cwd());
  assertCleanWorktree(repositoryRoot);
  const sourceCommit = run(repositoryRoot, "git", ["rev-parse", "HEAD"]).stdout.trim();
  if (!/^[a-f0-9]{40}$/.test(sourceCommit)) throw new Error("Git source commit is invalid.");
  const lockfile = join(repositoryRoot, "pnpm-lock.yaml");
  const lockfileSha256 = createHash("sha256").update(readFileSync(lockfile)).digest("hex");
  const artifactName = workstationArtifactName(input.buildId);
  const rootName = artifactName.slice(0, -".tar.zst".length);
  const artifactRoot = join(input.outputParent, rootName);
  const archivePath = join(input.outputParent, artifactName);
  if (existsSync(artifactRoot) || existsSync(archivePath)) {
    throw new Error("Artifact output already exists; refusing to overwrite it.");
  }
  ensureOutputParent(input.outputParent);

  run(repositoryRoot, "pnpm", ["build"]);
  mkdirSync(artifactRoot, { mode: PRIVATE_DIRECTORY_MODE });
  const nodeExecutable = installPackagedNodeRuntime(input.nodeRuntimeArchive, artifactRoot);
  const components = join(artifactRoot, "components");
  mkdirSync(components, { mode: PRIVATE_DIRECTORY_MODE });
  for (const component of [
    { packageName: "@naru/durable-session-host", directory: "host", usesNodePty: true },
    { packageName: "@naru/session-cli", directory: "cli", usesNodePty: false },
    { packageName: "@naru/workstation-gateway", directory: "gateway", usesNodePty: false },
    { packageName: "@naru/server", directory: "naru", usesNodePty: true },
  ]) {
    const componentRoot = join(components, component.directory);
    run(repositoryRoot, "pnpm", [
      "--offline",
      "--frozen-store",
      "--frozen-lockfile",
      "--trust-lockfile",
      "--store-dir",
      join(repositoryRoot, ".pnpm-store"),
      "--config.inject-workspace-packages=true",
      "--config.node-linker=hoisted",
      "--filter",
      component.packageName,
      "deploy",
      "--prod",
      componentRoot,
    ]);
    pruneDeployedComponent(componentRoot, component.packageName);
    makeTreePrivate(componentRoot);
    if (component.usesNodePty) {
      const spawnHelper = join(
        componentRoot,
        "node_modules",
        "node-pty",
        "prebuilds",
        "darwin-arm64",
        "spawn-helper",
      );
      const metadata = lstatSync(spawnHelper);
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new Error(`${component.packageName} contains an unsafe node-pty spawn helper.`);
      }
      chmodSync(spawnHelper, PRIVATE_EXECUTABLE_MODE);
    }
  }
  const webBase = join(artifactRoot, "web-base");
  copyDirectory(join(repositoryRoot, "apps", "web", "dist"), webBase);
  const bin = join(artifactRoot, "bin");
  mkdirSync(bin, { mode: PRIVATE_DIRECTORY_MODE });
  run(repositoryRoot, "pnpm", [
    "exec",
    "tsup",
    "ops/workstation/distribution/cli.ts",
    "ops/workstation/distribution/maintenance-launcher.ts",
    "--format",
    "esm",
    "--platform",
    "node",
    "--out-dir",
    bin,
    "--clean",
  ]);
  renameSync(join(bin, "cli.js"), join(bin, "workstation.mjs"));
  renameSync(join(bin, "maintenance-launcher.js"), join(bin, "workstation-maintenance.mjs"));
  writeFileSync(
    join(bin, "durable-session.mjs"),
    '#!/usr/bin/env node\nawait import("../components/cli/dist/main.js");\n',
    { mode: PRIVATE_FILE_MODE, flag: "wx" },
  );
  chmodSync(join(bin, "workstation.mjs"), PRIVATE_FILE_MODE);
  chmodSync(join(bin, "workstation-maintenance.mjs"), PRIVATE_FILE_MODE);
  chmodSync(join(bin, "durable-session.mjs"), PRIVATE_FILE_MODE);
  for (const name of ["LICENSE", "NOTICE", "THIRD_PARTY_NOTICES.md"] as const) {
    const source = join(repositoryRoot, name);
    const target = join(artifactRoot, name);
    const metadata = lstatSync(source);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Distribution notice input is unsafe: ${name}`);
    }
    cpSync(source, target, { errorOnExist: true, force: false });
    chmodSync(target, PRIVATE_FILE_MODE);
  }
  assertMaintenanceLauncherDispatches(nodeExecutable, join(bin, "workstation-maintenance.mjs"));
  assertRuntimeEntrypointsLoad(nodeExecutable, artifactRoot);

  assertBuildRootIsAbsent(artifactRoot, repositoryRoot);
  const verified = writeDistributionArtifactManifest(artifactRoot, {
    buildId: input.buildId,
    sourceCommit,
    lockfileSha256,
    features: [ARTIFACT_FEATURE_LOCAL_SESSION_CLI],
    nodeRuntime: PACKAGED_NODE_RUNTIME,
  });
  createDeterministicArchive(input.outputParent, rootName, artifactRoot, archivePath);
  chmodSync(archivePath, PRIVATE_FILE_MODE);
  return {
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    status: "built",
    artifactName,
    archivePath,
    expandedRoot: artifactRoot,
    buildId: input.buildId,
    sourceCommit,
    lockfileSha256,
    manifestDigest: verified.summary.manifestDigest,
    payloadDigest: verified.summary.payloadDigest,
    nodeRuntime: PACKAGED_NODE_RUNTIME,
    targetBuildRequired: false,
  };
}

function installPackagedNodeRuntime(nodeRuntimeArchive: string, artifactRoot: string): string {
  const archive = requirePinnedNodeRuntimeArchive(nodeRuntimeArchive);
  const runtimeRoot = join(artifactRoot, "runtime", "node");
  mkdirSync(runtimeRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const archiveRoot = PACKAGED_NODE_RUNTIME.archiveName.slice(0, -".tar.gz".length);
  const result = spawnSync(
    "/usr/bin/tar",
    [
      "-xzf",
      archive,
      "-C",
      runtimeRoot,
      "--strip-components",
      "1",
      `${archiveRoot}/bin/node`,
      `${archiveRoot}/LICENSE`,
    ],
    {
      encoding: "utf8",
      timeout: 5 * 60_000,
      maxBuffer: 1024 * 1024,
      env: { LANG: "C", PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout).replace(/\s+/g, " ").trim().slice(0, 2_000);
    throw new Error(`Pinned Node runtime extraction failed${detail === "" ? "." : `: ${detail}`}`);
  }

  const nodeExecutable = join(artifactRoot, PACKAGED_NODE_RUNTIME.executableRelativePath);
  const licensePath = join(artifactRoot, PACKAGED_NODE_RUNTIME.licenseRelativePath);
  for (const [path, label] of [
    [nodeExecutable, "executable"],
    [licensePath, "license"],
  ] as const) {
    const metadata = lstatSync(path);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error(`Pinned Node runtime ${label} must be a regular file.`);
    }
  }
  makeTreePrivate(join(artifactRoot, "runtime"));
  chmodSync(nodeExecutable, PRIVATE_EXECUTABLE_MODE);
  chmodSync(licensePath, PRIVATE_FILE_MODE);
  writeFileSync(join(runtimeRoot, "source.json"), `${stableJson(PACKAGED_NODE_RUNTIME)}\n`, {
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });

  const currentUid = process.getuid?.();
  if (currentUid === undefined) throw new Error("Artifact build requires a POSIX user identity.");
  inspectPackagedNodeRuntime(nodeExecutable, currentUid, PACKAGED_NODE_RUNTIME);
  return nodeExecutable;
}

function requirePinnedNodeRuntimeArchive(path: string): string {
  if (!isAbsolute(path) || basename(path) !== PACKAGED_NODE_RUNTIME.archiveName) {
    throw new Error(`Node runtime archive must be ${PACKAGED_NODE_RUNTIME.archiveName}.`);
  }
  assertNoSymlinkComponents(path);
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) throw new Error("Node runtime archive path must be canonical.");
  const metadata = lstatSync(canonical);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Node runtime archive must be a regular file.");
  }
  const digest = createHash("sha256").update(readFileSync(canonical)).digest("hex");
  if (digest !== PACKAGED_NODE_RUNTIME.archiveSha256) {
    throw new Error("Node runtime archive SHA-256 does not match the pinned official release.");
  }
  return canonical;
}

function assertMaintenanceLauncherDispatches(nodeExecutable: string, entrypoint: string): void {
  const result = spawnSync(nodeExecutable, [entrypoint], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { PATH: dirname(nodeExecutable), NARU_PTY_HOSTED: "1" },
  });
  if (
    result.error !== undefined ||
    result.status !== 2 ||
    !result.stderr.includes("Maintenance worker must not execute inline inside a Naru-owned PTY.")
  ) {
    throw new Error("Packaged maintenance launcher did not dispatch its guarded entrypoint.");
  }
}

function parseArguments(arguments_: readonly string[]): BuildArguments {
  let outputParent: string | undefined;
  let buildId: string | undefined;
  let nodeRuntimeArchive: string | undefined;
  let json = false;
  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (argument === "--json") {
      if (json) throw new Error("--json may be supplied only once.");
      json = true;
      continue;
    }
    const value = arguments_[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument ?? "argument"} requires a value.`);
    }
    if (argument === "--output-parent") {
      if (outputParent !== undefined) throw new Error("--output-parent may be supplied once.");
      outputParent = resolve(value);
    } else if (argument === "--build-id") {
      if (buildId !== undefined) throw new Error("--build-id may be supplied once.");
      buildId = value;
    } else if (argument === "--node-runtime-archive") {
      if (nodeRuntimeArchive !== undefined) {
        throw new Error("--node-runtime-archive may be supplied once.");
      }
      nodeRuntimeArchive = resolve(value);
    } else {
      throw new Error(`Unknown artifact build argument: ${argument ?? ""}.`);
    }
    index += 1;
  }
  if (
    !json ||
    outputParent === undefined ||
    buildId === undefined ||
    nodeRuntimeArchive === undefined
  ) {
    throw new Error(
      "Usage: build-artifact --json --output-parent <private-directory> --build-id <id> --node-runtime-archive <official-node-tar.gz>",
    );
  }
  workstationArtifactName(buildId);
  return { outputParent, buildId, nodeRuntimeArchive, json: true };
}

function assertBuildRuntime(): void {
  const major = Number(process.versions.node.split(".")[0]);
  if (major !== SUPPORTED_NODE_MAJOR) throw new Error("Artifact build requires exact Node 24.x.");
  if (process.platform !== ARTIFACT_PLATFORM || process.arch !== ARTIFACT_ARCHITECTURE) {
    throw new Error("Artifact build requires a darwin-arm64 host.");
  }
}

function requireRepositoryRoot(path: string): string {
  const root = realpathSync(path);
  if (!statSync(root).isDirectory() || !existsSync(join(root, "pnpm-workspace.yaml"))) {
    throw new Error("Artifact builder must run from the canonical repository root.");
  }
  return root;
}

function assertCleanWorktree(repositoryRoot: string): void {
  const status = run(repositoryRoot, "git", ["status", "--porcelain"]).stdout.trim();
  if (status !== "") throw new Error("Artifact build requires a clean committed worktree.");
}

function ensureOutputParent(path: string): void {
  if (!isAbsolute(path)) throw new Error("Artifact output parent must be absolute.");
  if (!existsSync(path)) mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (metadata.mode & 0o077) !== 0) {
    throw new Error("Artifact output parent must be a real private directory.");
  }
}

function copyDirectory(source: string, target: string): void {
  const metadata = lstatSync(source);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`Artifact input directory is unsafe: ${source}`);
  }
  cpSync(source, target, {
    recursive: true,
    dereference: false,
    errorOnExist: true,
    force: false,
  });
  makeTreePrivate(target);
}

function pruneDeployedComponent(componentRoot: string, packageName: string): void {
  for (const name of readdirSync(componentRoot)) {
    if (name === "dist" || name === "node_modules") continue;
    rmSync(join(componentRoot, name), { recursive: true, force: true });
  }
  for (const name of [".bin", ".modules.yaml", ".pnpm", ".pnpm-workspace-state-v1.json", "@naru"]) {
    rmSync(join(componentRoot, "node_modules", name), { recursive: true, force: true });
  }
  const packagePath = join(componentRoot, "package.json");
  writeFileSync(
    packagePath,
    `${JSON.stringify(
      { name: packageName, private: true, license: "Apache-2.0", type: "module" },
      null,
      2,
    )}\n`,
    { mode: PRIVATE_FILE_MODE },
  );
  chmodSync(packagePath, PRIVATE_FILE_MODE);
}

function assertBuildRootIsAbsent(artifactRoot: string, repositoryRoot: string): void {
  const forbidden = Buffer.from(repositoryRoot);
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new Error("Distribution artifact contains an unsafe filesystem entry.");
      }
      if (metadata.isDirectory()) {
        visit(path);
      } else if (readFileSync(path).includes(forbidden)) {
        throw new Error("Distribution artifact contains the build repository path.");
      }
    }
  };
  visit(artifactRoot);
}

function createDeterministicArchive(
  outputParent: string,
  rootName: string,
  artifactRoot: string,
  archivePath: string,
): void {
  const entries: string[] = [];
  const visit = (path: string, relativePath: string): void => {
    entries.push(relativePath);
    const metadata = lstatSync(path);
    if (!metadata.isDirectory()) return;
    for (const name of readdirSync(path).sort(comparePortablePaths)) {
      visit(join(path, name), `${relativePath}/${name}`);
    }
  };
  visit(artifactRoot, rootName);
  const fixedTime = new Date("2000-01-01T00:00:00.000Z");
  for (const entry of entries) utimesSync(join(outputParent, entry), fixedTime, fixedTime);

  const result = spawnSync(
    "/usr/bin/tar",
    [
      "-caf",
      archivePath,
      "--no-recursion",
      "--no-acls",
      "--no-xattrs",
      "--no-fflags",
      "--uid",
      "0",
      "--gid",
      "0",
      "--uname",
      "root",
      "--gname",
      "wheel",
      "-T",
      "-",
    ],
    {
      cwd: outputParent,
      encoding: "utf8",
      input: `${entries.join("\n")}\n`,
      timeout: 20 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
      env: { LANG: "C", PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout).replace(/\s+/g, " ").trim().slice(0, 2_000);
    throw new Error(`Deterministic archive creation failed${detail === "" ? "." : `: ${detail}`}`);
  }
}

function assertRuntimeEntrypointsLoad(nodeExecutable: string, artifactRoot: string): void {
  const checks = [
    {
      path: join(artifactRoot, "components", "host", "dist", "main.js"),
      status: 1,
      marker: "DURABLE_SESSION_HOST_CONFIG must point to a private Host config file.",
    },
    {
      path: join(artifactRoot, "components", "gateway", "dist", "main.js"),
      status: 2,
      marker: "Usage: workstation-gateway <private-config.json>",
    },
    {
      path: join(artifactRoot, "components", "naru", "dist", "index.js"),
      status: 1,
      marker: "NARU_AUTH_MODE",
    },
    {
      path: join(artifactRoot, "bin", "durable-session.mjs"),
      status: 0,
      marker: "Usage:",
      arguments: ["--help"],
    },
  ] as const;
  for (const check of checks) {
    const result = spawnSync(
      nodeExecutable,
      [check.path, ...("arguments" in check ? check.arguments : [])],
      {
        cwd: artifactRoot,
        encoding: "utf8",
        timeout: 30_000,
        maxBuffer: 512 * 1024,
        env: {
          HOME: artifactRoot,
          LANG: "C",
          PATH: dirname(nodeExecutable),
        },
      },
    );
    const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
    if (
      result.error !== undefined ||
      result.status !== check.status ||
      !output.includes(check.marker)
    ) {
      throw new Error(
        `Packaged ${basename(check.path)} did not reach its fail-closed configuration boundary.`,
      );
    }
  }
}

function makeTreePrivate(path: string): void {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink()) throw new Error("Artifact input contains a symbolic link.");
  if (metadata.isDirectory()) {
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
    for (const name of readdirSync(path)) makeTreePrivate(join(path, name));
    return;
  }
  if (!metadata.isFile()) throw new Error("Artifact input contains a non-regular file.");
  chmodSync(path, (metadata.mode & 0o111) === 0 ? PRIVATE_FILE_MODE : 0o700);
}

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function run(
  cwd: string,
  executable: string,
  arguments_: readonly string[],
): { readonly stdout: string; readonly stderr: string } {
  const environment = { ...process.env };
  delete environment.NODE_ENV;
  const result = spawnSync(executable, [...arguments_], {
    cwd,
    encoding: "utf8",
    timeout: 20 * 60_000,
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...environment,
      CI: "true",
      PATH: [dirname(process.execPath), process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin"].join(
        delimiter,
      ),
    },
  });
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr || result.stdout).replace(/\s+/g, " ").trim().slice(0, 2_000);
    throw new Error(
      `${basename(executable)} ${arguments_[0] ?? "command"} failed${
        detail === "" ? "." : `: ${detail}`
      }`,
    );
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

if (fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? "")) {
  try {
    const result = buildDistributionArtifact(process.argv.slice(2));
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(
      `${JSON.stringify({
        version: DISTRIBUTION_SCHEMA_VERSION,
        packageId: WORKSTATION_PACKAGE_ID,
        status: "error",
        message: error instanceof Error ? error.message : "Unknown artifact build failure.",
      })}\n`,
    );
    process.exitCode = 2;
  }
}
