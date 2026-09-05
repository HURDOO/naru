import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
  closeSync,
  fsyncSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ARTIFACT_ARCHITECTURE,
  ARTIFACT_FEATURE_LOCAL_SESSION_CLI,
  ARTIFACT_PLATFORM,
  ARTIFACT_REQUIRED_PATHS,
  DISTRIBUTION_SCHEMA_VERSION,
  DISTRIBUTION_TASK_ID,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_EXECUTABLE_MODE,
  PRIVATE_FILE_MODE,
  SUPPORTED_NODE_MAJOR,
  WORKSTATION_PACKAGE_ID,
  LOCAL_SESSION_CLI_REQUIRED_PATHS,
  type ArtifactFeature,
} from "./constants.js";
import type { DistributionArtifactSummary } from "./model.js";
import { digestJson, stableJson } from "./model.js";
import { parsePackagedNodeRuntime, type PackagedNodeRuntimeV1 } from "./node-runtime.js";

const ARTIFACT_MANIFEST_NAME = "artifact.json";
const BUILD_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{5,127}$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SOURCE_COMMIT_PATTERN = /^[a-f0-9]{40}$/;

export interface ArtifactFileV1 {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface DistributionArtifactManifestV1 {
  readonly version: typeof DISTRIBUTION_SCHEMA_VERSION;
  readonly taskId: typeof DISTRIBUTION_TASK_ID;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly buildId: string;
  readonly platform: typeof ARTIFACT_PLATFORM;
  readonly architecture: typeof ARTIFACT_ARCHITECTURE;
  readonly nodeMajor: typeof SUPPORTED_NODE_MAJOR;
  readonly sourceCommit: string;
  readonly lockfileSha256: string;
  readonly files: readonly ArtifactFileV1[];
  readonly payloadDigest: string;
  readonly features?: readonly ArtifactFeature[];
  readonly nodeRuntime?: PackagedNodeRuntimeV1;
}

export interface ArtifactManifestInput {
  readonly buildId: string;
  readonly sourceCommit: string;
  readonly lockfileSha256: string;
  readonly features: readonly ArtifactFeature[];
  readonly nodeRuntime?: PackagedNodeRuntimeV1;
}

export interface VerifiedDistributionArtifact {
  readonly summary: DistributionArtifactSummary;
  readonly manifest: DistributionArtifactManifestV1;
  readonly manifestPath: string;
}

export function writeDistributionArtifactManifest(
  artifactRoot: string,
  input: ArtifactManifestInput,
): VerifiedDistributionArtifact {
  const root = requireCanonicalDirectory(artifactRoot);
  validateManifestMetadata(input);
  const manifestPath = join(root, ARTIFACT_MANIFEST_NAME);
  if (existsSync(manifestPath)) {
    throw new Error("Artifact manifest already exists; refusing to overwrite it.");
  }
  const files = scanArtifactFiles(root);
  assertStandalonePayload(root, files, input.features, input.nodeRuntime);
  const unsigned = {
    version: DISTRIBUTION_SCHEMA_VERSION,
    taskId: DISTRIBUTION_TASK_ID,
    packageId: WORKSTATION_PACKAGE_ID,
    buildId: input.buildId,
    platform: ARTIFACT_PLATFORM,
    architecture: ARTIFACT_ARCHITECTURE,
    nodeMajor: SUPPORTED_NODE_MAJOR,
    sourceCommit: input.sourceCommit,
    lockfileSha256: input.lockfileSha256,
    files,
    features: input.features,
    ...(input.nodeRuntime === undefined ? {} : { nodeRuntime: input.nodeRuntime }),
  } as const;
  const manifest: DistributionArtifactManifestV1 = {
    ...unsigned,
    payloadDigest: digestJson(unsigned),
  };
  writePrivateFile(manifestPath, `${stableJson(manifest)}\n`, false);
  return verifyDistributionArtifact(root);
}

export function verifyDistributionArtifact(artifactRoot: string): VerifiedDistributionArtifact {
  const root = requireCanonicalDirectory(artifactRoot);
  assertPathHasNoSymlink(root);
  const manifestPath = join(root, ARTIFACT_MANIFEST_NAME);
  assertRegularFileWithoutSymlink(manifestPath);
  const manifestSource = readFileSync(manifestPath, "utf8");
  let value: unknown;
  try {
    value = JSON.parse(manifestSource) as unknown;
  } catch {
    throw new Error("Distribution artifact manifest is not valid JSON.");
  }
  const manifest = parseArtifactManifest(value);
  const actualFiles = scanArtifactFiles(root);
  if (stableJson(actualFiles) !== stableJson(manifest.files)) {
    throw new Error("Distribution artifact payload does not match its file manifest.");
  }
  assertStandalonePayload(root, actualFiles, manifest.features ?? [], manifest.nodeRuntime);
  if (digestJson({ ...manifest, payloadDigest: undefined }) !== manifest.payloadDigest) {
    throw new Error("Distribution artifact payload digest is invalid.");
  }
  const manifestDigest = createHash("sha256").update(manifestSource).digest("hex");
  return {
    summary: {
      schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
      packageId: WORKSTATION_PACKAGE_ID,
      buildId: manifest.buildId,
      manifestDigest,
      payloadDigest: manifest.payloadDigest,
      root,
      features: manifest.features ?? [],
      ...(manifest.nodeRuntime === undefined ? {} : { nodeRuntime: manifest.nodeRuntime }),
    },
    manifest,
    manifestPath,
  };
}

export function installVerifiedArtifact(
  artifact: VerifiedDistributionArtifact,
  targetRoot: string,
): "installed" | "already-installed" {
  if (!isAbsolute(targetRoot)) throw new Error("Artifact install target must be absolute.");
  const target = resolve(targetRoot);
  assertPathHasNoSymlink(dirname(target));
  if (existsSync(target)) {
    const installed = verifyDistributionArtifact(target);
    if (
      installed.summary.manifestDigest !== artifact.summary.manifestDigest ||
      installed.summary.payloadDigest !== artifact.summary.payloadDigest
    ) {
      throw new Error("Immutable release path already contains a different artifact.");
    }
    return "already-installed";
  }

  const temporary = join(dirname(target), `.${basename(target)}.incoming-${randomUUID()}`);
  mkdirSync(temporary, { mode: PRIVATE_DIRECTORY_MODE });
  copyArtifactTree(artifact.summary.root, temporary);
  const copied = verifyDistributionArtifact(temporary);
  if (copied.summary.manifestDigest !== artifact.summary.manifestDigest) {
    throw new Error("Copied artifact digest changed during installation.");
  }
  renameSync(temporary, target);
  fsyncDirectory(dirname(target));
  return "installed";
}

export function parseArtifactManifest(value: unknown): DistributionArtifactManifestV1 {
  if (!isRecord(value)) throw new Error("Artifact manifest must be a JSON object.");
  const expectedKeys = [
    "version",
    "taskId",
    "packageId",
    "buildId",
    "platform",
    "architecture",
    "nodeMajor",
    "sourceCommit",
    "lockfileSha256",
    "files",
    "payloadDigest",
    ...(value.features === undefined ? [] : ["features"]),
    ...(value.nodeRuntime === undefined ? [] : ["nodeRuntime"]),
  ];
  if (!hasExactKeys(value, expectedKeys)) {
    throw new Error("Artifact manifest contains missing or unexpected fields.");
  }
  if (
    value.version !== DISTRIBUTION_SCHEMA_VERSION ||
    value.taskId !== DISTRIBUTION_TASK_ID ||
    value.packageId !== WORKSTATION_PACKAGE_ID ||
    value.platform !== ARTIFACT_PLATFORM ||
    value.architecture !== ARTIFACT_ARCHITECTURE ||
    value.nodeMajor !== SUPPORTED_NODE_MAJOR ||
    typeof value.buildId !== "string" ||
    !BUILD_ID_PATTERN.test(value.buildId) ||
    typeof value.sourceCommit !== "string" ||
    !SOURCE_COMMIT_PATTERN.test(value.sourceCommit) ||
    typeof value.lockfileSha256 !== "string" ||
    !SHA256_PATTERN.test(value.lockfileSha256) ||
    typeof value.payloadDigest !== "string" ||
    !SHA256_PATTERN.test(value.payloadDigest) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("Artifact manifest metadata is invalid.");
  }
  const files = value.files.map(parseArtifactFile);
  const features = value.features === undefined ? undefined : parseArtifactFeatures(value.features);
  const nodeRuntime =
    value.nodeRuntime === undefined ? undefined : parsePackagedNodeRuntime(value.nodeRuntime);
  const paths = files.map((file) => file.path);
  if (
    paths.join("\0") !== [...paths].sort(comparePortablePaths).join("\0") ||
    new Set(paths).size !== paths.length
  ) {
    throw new Error("Artifact files must be unique and sorted by path.");
  }
  return {
    version: DISTRIBUTION_SCHEMA_VERSION,
    taskId: DISTRIBUTION_TASK_ID,
    packageId: WORKSTATION_PACKAGE_ID,
    buildId: value.buildId,
    platform: ARTIFACT_PLATFORM,
    architecture: ARTIFACT_ARCHITECTURE,
    nodeMajor: SUPPORTED_NODE_MAJOR,
    sourceCommit: value.sourceCommit,
    lockfileSha256: value.lockfileSha256,
    files,
    payloadDigest: value.payloadDigest,
    ...(features === undefined ? {} : { features }),
    ...(nodeRuntime === undefined ? {} : { nodeRuntime }),
  };
}

function scanArtifactFiles(root: string): readonly ArtifactFileV1[] {
  const files: ArtifactFileV1[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      comparePortablePaths(left.name, right.name),
    )) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) {
        throw new Error("Distribution artifact must not contain symbolic links.");
      }
      if (metadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (!metadata.isFile()) {
        throw new Error("Distribution artifact must contain only directories and regular files.");
      }
      const relativePath = portableRelative(root, path);
      if (relativePath === ARTIFACT_MANIFEST_NAME) continue;
      files.push({
        path: relativePath,
        size: metadata.size,
        sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
        executable: (metadata.mode & 0o111) !== 0,
      });
    }
  };
  visit(root);
  return files.sort((left, right) => comparePortablePaths(left.path, right.path));
}

function assertStandalonePayload(
  root: string,
  files: readonly ArtifactFileV1[],
  features: readonly ArtifactFeature[],
  nodeRuntime: PackagedNodeRuntimeV1 | undefined,
): void {
  const paths = new Set(files.map((file) => file.path));
  for (const required of ARTIFACT_REQUIRED_PATHS) {
    if (!paths.has(required)) throw new Error(`Distribution artifact is missing ${required}.`);
  }
  for (const required of features.includes(ARTIFACT_FEATURE_LOCAL_SESSION_CLI)
    ? LOCAL_SESSION_CLI_REQUIRED_PATHS
    : []) {
    if (!paths.has(required)) throw new Error(`Distribution artifact is missing ${required}.`);
  }
  if (!files.some((file) => file.path.includes("better-sqlite3") && file.path.endsWith(".node"))) {
    throw new Error("Distribution artifact is missing the better-sqlite3 native binary.");
  }
  if (!files.some((file) => file.path.includes("node-pty") && file.path.endsWith(".node"))) {
    throw new Error("Distribution artifact is missing the node-pty native binary.");
  }
  if (
    !files.some(
      (file) =>
        file.path.includes("node-pty") && file.path.endsWith("spawn-helper") && file.executable,
    )
  ) {
    throw new Error("Distribution artifact is missing the executable node-pty spawn helper.");
  }
  if (nodeRuntime !== undefined) {
    for (const required of [
      nodeRuntime.executableRelativePath,
      nodeRuntime.licenseRelativePath,
      "runtime/node/source.json",
    ]) {
      if (!paths.has(required)) {
        throw new Error(`Distribution artifact is missing packaged Node runtime file ${required}.`);
      }
    }
    const executable = files.find((file) => file.path === nodeRuntime.executableRelativePath);
    if (executable?.executable !== true) {
      throw new Error("Distribution artifact packaged Node runtime is not executable.");
    }
    if (executable.sha256 !== nodeRuntime.executableSha256) {
      throw new Error("Distribution artifact packaged Node executable digest does not match.");
    }
    const sourceMetadata = readFileSync(join(root, "runtime", "node", "source.json"), "utf8");
    if (sourceMetadata !== `${stableJson(nodeRuntime)}\n`) {
      throw new Error("Distribution artifact packaged Node source metadata does not match.");
    }
  }
}

function copyArtifactTree(sourceRoot: string, targetRoot: string): void {
  const visit = (sourceDirectory: string, targetDirectory: string): void => {
    chmodSync(targetDirectory, PRIVATE_DIRECTORY_MODE);
    for (const entry of readdirSync(sourceDirectory, { withFileTypes: true })) {
      const source = join(sourceDirectory, entry.name);
      const target = join(targetDirectory, entry.name);
      const metadata = lstatSync(source);
      if (metadata.isSymbolicLink()) throw new Error("Artifact copy refused a symbolic link.");
      if (metadata.isDirectory()) {
        mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
        visit(source, target);
        continue;
      }
      if (!metadata.isFile()) throw new Error("Artifact copy refused a non-regular file.");
      copyFileSync(source, target);
      chmodSync(
        target,
        (metadata.mode & 0o111) === 0 ? PRIVATE_FILE_MODE : PRIVATE_EXECUTABLE_MODE,
      );
    }
  };
  visit(sourceRoot, targetRoot);
}

function parseArtifactFile(value: unknown): ArtifactFileV1 {
  if (!isRecord(value) || !hasExactKeys(value, ["path", "size", "sha256", "executable"])) {
    throw new Error("Artifact file entry is invalid.");
  }
  if (
    typeof value.path !== "string" ||
    !isSafePortablePath(value.path) ||
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    typeof value.sha256 !== "string" ||
    !SHA256_PATTERN.test(value.sha256) ||
    typeof value.executable !== "boolean"
  ) {
    throw new Error("Artifact file entry contains an invalid field.");
  }
  return {
    path: value.path,
    size: value.size as number,
    sha256: value.sha256,
    executable: value.executable,
  };
}

function validateManifestMetadata(input: ArtifactManifestInput): void {
  if (!BUILD_ID_PATTERN.test(input.buildId)) throw new Error("Artifact build ID is invalid.");
  if (!SOURCE_COMMIT_PATTERN.test(input.sourceCommit)) {
    throw new Error("Artifact source commit must be a full Git SHA-1.");
  }
  if (!SHA256_PATTERN.test(input.lockfileSha256)) {
    throw new Error("Artifact lockfile digest must be a SHA-256 value.");
  }
  parseArtifactFeatures(input.features);
}

function parseArtifactFeatures(value: unknown): readonly ArtifactFeature[] {
  if (!Array.isArray(value)) {
    throw new Error("Artifact features must be a unique sorted supported list.");
  }
  if (value.some((feature) => feature !== ARTIFACT_FEATURE_LOCAL_SESSION_CLI)) {
    throw new Error("Artifact features must be a unique sorted supported list.");
  }
  const features = value as ArtifactFeature[];
  if (
    new Set(features).size !== features.length ||
    features.join("\0") !== [...features].sort().join("\0")
  ) {
    throw new Error("Artifact features must be a unique sorted supported list.");
  }
  return features;
}

function requireCanonicalDirectory(path: string): string {
  if (!isAbsolute(path)) throw new Error("Artifact root must be absolute.");
  const canonical = realpathSync(path);
  if (canonical !== resolve(path) || !statSync(canonical).isDirectory()) {
    throw new Error("Artifact root must be a canonical directory.");
  }
  return canonical;
}

function assertPathHasNoSymlink(path: string): void {
  const absolute = resolve(path);
  const root = absolute.slice(0, 1) === sep ? sep : resolve(absolute).slice(0, 3);
  let current = root;
  for (const component of relative(root, absolute).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Artifact path contains a symbolic link.");
    }
  }
}

function assertRegularFileWithoutSymlink(path: string): void {
  assertPathHasNoSymlink(path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Artifact manifest must be a regular file.");
  }
}

function writePrivateFile(path: string, contents: string, executable: boolean): void {
  const descriptor = openSync(path, "wx", executable ? PRIVATE_EXECUTABLE_MODE : PRIVATE_FILE_MODE);
  try {
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  fsyncDirectory(dirname(path));
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, "r");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function portableRelative(root: string, path: string): string {
  const value = relative(root, path).split(sep).join("/");
  if (!isSafePortablePath(value)) throw new Error("Artifact file escaped its root.");
  return value;
}

function comparePortablePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isSafePortablePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 4_096 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\0") &&
    !value.split("/").some((part) => part === "" || part === "." || part === "..")
  );
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
