import { createHash, randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { PRIVATE_DIRECTORY_MODE, PRIVATE_FILE_MODE, SUPPORTED_NODE_MAJOR } from "./constants.js";
import type { WorkstationInstallationIntent, WorkstationInstanceLayout } from "./model.js";
import type { PackagedNodeRuntimeV1 } from "./node-runtime.js";

const MAX_PRIVATE_JSON_BYTES = 1024 * 1024;

export interface ExecutableInspection {
  readonly path: string;
  readonly ownerUid: number;
  readonly mode: number;
}

export interface NodeRuntimeInspection extends ExecutableInspection {
  readonly version: string;
  readonly major: number;
  readonly codeSignatureValidation?: "strict" | "exact-hash-fallback";
}

export interface NativeRuntimeInspection {
  readonly component: "host" | "gateway" | "naru";
  readonly status: "ok";
}

export interface CodexDoctorAssessment {
  readonly status: "ok" | "blocked" | "unavailable";
  readonly requiredChecks: Readonly<
    Record<"installation" | "auth.credentials" | "config.load", string | undefined>
  >;
  readonly ignoredUnrelatedFailures: readonly string[];
  readonly remediation?: string;
}

export interface ManagedPathIssue {
  readonly path: string;
  readonly reason: "symlink" | "wrong-owner" | "wrong-mode" | "wrong-type";
}

export function inspectTargetEnvironment(
  intent: WorkstationInstallationIntent,
  packagedRuntime?: PackagedNodeRuntimeV1,
): {
  readonly node: NodeRuntimeInspection;
  readonly shell: ExecutableInspection;
  readonly codex: ExecutableInspection;
  readonly claude?: ExecutableInspection;
  readonly projectRoots: readonly string[];
} {
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && currentUid !== intent.targetUid) {
    throw new Error("Installer must run inside the target user's login session.");
  }
  assertCanonicalDirectory(intent.homeDirectory, intent.targetUid);
  const node = (() => {
    if (packagedRuntime !== undefined) {
      return inspectPackagedNodeRuntime(intent.nodeExecutable, intent.targetUid, packagedRuntime);
    }
    const externalNode = inspectNode24(intent.nodeExecutable, intent.targetUid);
    inspectMacOsLaunchdExecutable(externalNode.path);
    return { ...externalNode, codeSignatureValidation: "strict" as const };
  })();
  const shell = inspectExecutable(intent.shellExecutable);
  const codex = inspectExecutable(intent.codexExecutable);
  const claude =
    intent.claudeExecutable === undefined ? undefined : inspectExecutable(intent.claudeExecutable);
  const projectRoots = intent.allowedProjectRoots.map((path) =>
    assertCanonicalDirectory(path, intent.targetUid, false),
  );
  return { node, shell, codex, ...(claude === undefined ? {} : { claude }), projectRoots };
}

export function inspectPackagedNodeRuntime(
  path: string,
  expectedUid: number,
  runtime: PackagedNodeRuntimeV1,
  options: {
    readonly inspectCodeSignature?: typeof inspectMacOsLaunchdExecutable;
    readonly codeSignatureVerifierAvailable?: () => boolean;
  } = {},
): NodeRuntimeInspection {
  const executable = inspectExecutable(path, expectedUid);
  const digest = createHash("sha256").update(readFileSync(executable.path)).digest("hex");
  if (digest !== runtime.executableSha256) {
    throw new Error("Packaged Node executable SHA-256 does not match its manifest.");
  }
  const node = inspectNode24(executable.path, expectedUid);
  if (node.version !== runtime.nodeVersion) {
    throw new Error("Packaged Node runtime version does not match its manifest.");
  }
  let codeSignatureValidation: NodeRuntimeInspection["codeSignatureValidation"] = "strict";
  const inspectCodeSignature = options.inspectCodeSignature ?? inspectMacOsLaunchdExecutable;
  const codeSignatureVerifierAvailable =
    options.codeSignatureVerifierAvailable ?? macOsCodeSignatureVerifierAvailable;
  try {
    inspectCodeSignature(node.path);
  } catch (error) {
    if (codeSignatureVerifierAvailable()) throw error;
    codeSignatureValidation = "exact-hash-fallback";
  }
  const architecture = spawnSync(node.path, ["--print", "process.arch"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { HOME: dirname(dirname(node.path)), PATH: dirname(node.path) },
  });
  if (
    architecture.error !== undefined ||
    architecture.status !== 0 ||
    architecture.stdout.trim() !== runtime.architecture
  ) {
    throw new Error("Packaged Node runtime architecture does not match its manifest.");
  }
  return { ...node, codeSignatureValidation };
}

function macOsCodeSignatureVerifierAvailable(): boolean {
  if (process.platform !== "darwin") return true;
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", "/usr/bin/true"],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  );
  return result.error === undefined && result.status === 0;
}

export function inspectMacOsLaunchdExecutable(path: string): void {
  if (process.platform !== "darwin" || !isMachOExecutable(path)) return;
  const result = spawnSync(
    "/usr/bin/codesign",
    ["--verify", "--deep", "--strict", "--verbose=2", path],
    {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 64 * 1024,
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
    },
  );
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Target Node executable has an invalid macOS code signature.");
  }
}

export function inspectNode24(path: string, expectedUid: number): NodeRuntimeInspection {
  const executable = inspectExecutable(path, expectedUid);
  const result = spawnSync(executable.path, ["--version"], {
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: { HOME: dirname(dirname(executable.path)), PATH: dirname(executable.path) },
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("Target Node executable did not report a version successfully.");
  }
  const version = result.stdout.trim();
  const match = /^v(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (match?.[1] === undefined) throw new Error("Target Node version output is invalid.");
  const major = Number(match[1]);
  if (major !== SUPPORTED_NODE_MAJOR) {
    throw new Error(`Workstation requires exact Node ${SUPPORTED_NODE_MAJOR}.x.`);
  }
  return { ...executable, version, major };
}

export function inspectNativeRuntime(
  nodeExecutable: string,
  releaseRoot: string,
): readonly NativeRuntimeInspection[] {
  const components = [
    { name: "host", imports: ["better-sqlite3", "node-pty"] },
    { name: "gateway", imports: ["better-sqlite3"] },
    { name: "naru", imports: ["better-sqlite3", "node-pty"] },
  ] as const;
  return components.map((component) => {
    const cwd = join(releaseRoot, "components", component.name);
    const program = component.imports
      .map((name) => `await import(${JSON.stringify(name)});`)
      .join("");
    const result = spawnSync(nodeExecutable, ["--input-type=module", "--eval", program], {
      cwd,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 256 * 1024,
      env: { HOME: dirname(dirname(nodeExecutable)), PATH: dirname(nodeExecutable) },
    });
    if (result.error !== undefined || result.status !== 0) {
      throw new Error(`Standalone ${component.name} native modules failed to load with Node 24.`);
    }
    return { component: component.name, status: "ok" };
  });
}

export function inspectExecutable(path: string, expectedUid?: number): ExecutableInspection {
  if (!isAbsolute(path)) throw new Error("Executable path must be absolute.");
  assertNoSymlinkComponents(path);
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) throw new Error("Executable path must already be canonical.");
  const metadata = statSync(canonical);
  if (!metadata.isFile()) throw new Error("Executable path must be a regular file.");
  accessSync(canonical, constants.X_OK);
  if (expectedUid !== undefined && metadata.uid !== expectedUid) {
    throw new Error("Node executable must be owned by the target user.");
  }
  return { path: canonical, ownerUid: metadata.uid, mode: metadata.mode & 0o777 };
}

/**
 * The Claude Agent SDK that the Agent Platform loads into managed agents (AP-D012): a canonical
 * regular file owned by the target user or root that no one else can change.
 */
export function inspectClaudeAgentSdk(path: string, expectedUid: number): void {
  if (!isAbsolute(path)) throw new Error("Claude Agent SDK path must be absolute.");
  assertNoSymlinkComponents(path);
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) throw new Error("Claude Agent SDK path must be canonical.");
  const metadata = statSync(canonical);
  if (!metadata.isFile()) throw new Error("Claude Agent SDK path must be a regular file.");
  if (metadata.uid !== expectedUid && metadata.uid !== 0) {
    throw new Error("Claude Agent SDK must be owned by the target user or root.");
  }
  if ((metadata.mode & 0o022) !== 0) {
    throw new Error("Claude Agent SDK must not be writable by group or others.");
  }
  accessSync(canonical, constants.R_OK);
}

export function ensureInstanceDirectories(
  layout: WorkstationInstanceLayout,
  expectedUid: number,
): void {
  const applicationSupport = join(layout.homeDirectory, "Library", "Application Support");
  const longRoot = join(applicationSupport, "Naru Workstation");
  const shortRoot = join(applicationSupport, "NaruWS");
  const ordered = [
    longRoot,
    layout.directories.instancesRoot,
    layout.stateRoot,
    layout.directories.receipts,
    layout.directories.releases,
    layout.directories.webReleases,
    layout.directories.config,
    layout.directories.credentials,
    layout.directories.data,
    layout.directories.hostData,
    layout.directories.gatewayData,
    layout.directories.naruData,
    layout.directories.maintenance,
    layout.directories.logs,
    shortRoot,
    dirname(layout.shortRuntimeRoot),
    layout.shortRuntimeRoot,
  ];
  assertDirectoryBoundary(applicationSupport, expectedUid, false);
  for (const directory of ordered) ensurePrivateDirectory(directory, expectedUid);
  assertDirectoryBoundary(dirname(layout.directories.launchAgents), expectedUid, false);
  if (!existsSync(layout.directories.launchAgents)) {
    mkdirSync(layout.directories.launchAgents, { mode: PRIVATE_DIRECTORY_MODE });
  }
  assertDirectoryBoundary(layout.directories.launchAgents, expectedUid, false);
}

export function inspectManagedInstancePaths(
  layout: WorkstationInstanceLayout,
  expectedUid: number,
): readonly ManagedPathIssue[] {
  const applicationSupport = join(layout.homeDirectory, "Library", "Application Support");
  const paths = [
    join(applicationSupport, "Naru Workstation"),
    layout.directories.instancesRoot,
    layout.stateRoot,
    layout.directories.receipts,
    layout.directories.releases,
    layout.directories.webReleases,
    layout.directories.config,
    layout.directories.credentials,
    layout.directories.data,
    layout.directories.hostData,
    layout.directories.gatewayData,
    layout.directories.naruData,
    layout.directories.maintenance,
    layout.directories.logs,
    join(applicationSupport, "NaruWS"),
    dirname(layout.shortRuntimeRoot),
    layout.shortRuntimeRoot,
  ];
  const issues: ManagedPathIssue[] = [];
  for (const path of paths) {
    try {
      assertNoSymlinkComponents(path);
    } catch {
      issues.push({ path, reason: "symlink" });
      continue;
    }
    if (!existsSync(path)) continue;
    const metadata = lstatSync(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      issues.push({ path, reason: "wrong-type" });
    } else if (metadata.uid !== expectedUid) {
      issues.push({ path, reason: "wrong-owner" });
    } else if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
      issues.push({ path, reason: "wrong-mode" });
    }
  }
  return issues;
}

export function ensurePrivateDirectory(path: string, expectedUid: number): void {
  if (!isAbsolute(path)) throw new Error("Managed directory must be absolute.");
  assertNoSymlinkComponents(path);
  if (!existsSync(path)) mkdirSync(path, { mode: PRIVATE_DIRECTORY_MODE });
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Managed private path must be a real directory.");
  }
  if (metadata.uid !== expectedUid)
    throw new Error("Managed private directory has the wrong owner.");
  if ((metadata.mode & 0o777) !== PRIVATE_DIRECTORY_MODE) {
    throw new Error("Managed private directory must be exact mode 0700.");
  }
}

export function assertPrivateFile(path: string, expectedUid: number): void {
  if (!isAbsolute(path)) throw new Error("Managed private file must be absolute.");
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Managed private file must be a regular file.");
  }
  if (metadata.uid !== expectedUid) throw new Error("Managed private file has the wrong owner.");
  if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error("Managed private file must be exact mode 0600.");
  }
}

export function assertPrivateSocket(path: string, expectedUid: number): void {
  if (!isAbsolute(path)) throw new Error("Managed private socket must be absolute.");
  assertNoSymlinkComponents(path);
  const parent = lstatSync(dirname(path));
  if (
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== expectedUid ||
    (parent.mode & 0o777) !== PRIVATE_DIRECTORY_MODE
  ) {
    throw new Error("Managed private socket parent must be an owner-only directory.");
  }
  const metadata = lstatSync(path);
  if (!metadata.isSocket() || metadata.isSymbolicLink()) {
    throw new Error("Managed private socket path must be a Unix socket.");
  }
  if (metadata.uid !== expectedUid) {
    throw new Error("Managed private socket has the wrong owner.");
  }
  if ((metadata.mode & 0o777) !== PRIVATE_FILE_MODE) {
    throw new Error("Managed private socket must be exact mode 0600.");
  }
}

export function atomicWritePrivateFile(
  path: string,
  contents: string | Buffer,
  expectedUid: number,
  options: { readonly replace?: boolean; readonly parentPrivate?: boolean } = {},
): "created" | "unchanged" | "replaced" {
  if (options.parentPrivate === false) {
    assertDirectoryBoundary(dirname(path), expectedUid, false);
  } else {
    ensurePrivateDirectory(dirname(path), expectedUid);
  }
  const existed = existsSync(path);
  if (existed) {
    assertPrivateFile(path, expectedUid);
    const current = readFileSync(path);
    const next = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, "utf8");
    if (current.equals(next)) return "unchanged";
    if (options.replace !== true) {
      throw new Error("Managed private file already exists with different contents.");
    }
  }
  const temporary = join(dirname(path), `.${parse(path).base}.incoming-${randomUUID()}`);
  const descriptor = openSync(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    writeFileSync(descriptor, contents);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  chmodSync(temporary, PRIVATE_FILE_MODE);
  renameSync(temporary, path);
  fsyncDirectory(dirname(path));
  assertPrivateFile(path, expectedUid);
  return existed ? "replaced" : "created";
}

export function createPrivateCredential(
  path: string,
  expectedUid: number,
): "created" | "preserved" {
  if (existsSync(path)) {
    assertPrivateCredential(path, expectedUid);
    return "preserved";
  }
  const credential = randomBytes(32).toString("base64url");
  atomicWritePrivateFile(path, `${credential}\n`, expectedUid);
  return "created";
}

export function assertPrivateCredential(path: string, expectedUid: number): void {
  assertPrivateFile(path, expectedUid);
  const value = readFileSync(path, "utf8").trim();
  if (value.length < 32 || value.length > 1_024 || /\s/.test(value)) {
    throw new Error("Existing Host credential is invalid; refusing to rotate implicitly.");
  }
}

export function readPrivateJson(path: string, expectedUid: number): unknown {
  assertPrivateFile(path, expectedUid);
  const metadata = statSync(path);
  if (metadata.size > MAX_PRIVATE_JSON_BYTES) throw new Error("Private JSON file is too large.");
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Private JSON file contains invalid JSON.");
  }
}

export function evaluateCodexDoctor(report: unknown): CodexDoctorAssessment {
  if (!isRecord(report) || !isRecord(report.checks)) {
    return {
      status: "unavailable",
      requiredChecks: {
        installation: undefined,
        "auth.credentials": undefined,
        "config.load": undefined,
      },
      ignoredUnrelatedFailures: [],
      remediation: "Run the target user's exact Codex executable with `doctor --json`.",
    };
  }
  const requiredChecks = {
    installation: checkStatus(report.checks.installation),
    "auth.credentials": checkStatus(report.checks["auth.credentials"]),
    "config.load": checkStatus(report.checks["config.load"]),
  };
  const ignoredUnrelatedFailures = Object.entries(report.checks)
    .filter(
      ([id, check]) =>
        id !== "installation" &&
        id !== "auth.credentials" &&
        id !== "config.load" &&
        checkStatus(check) !== "ok",
    )
    .map(([id]) => id)
    .sort();
  const values = Object.values(requiredChecks);
  if (values.some((status) => status === undefined)) {
    return {
      status: "unavailable",
      requiredChecks,
      ignoredUnrelatedFailures,
      remediation:
        "Update Codex so doctor reports installation, auth.credentials, and config.load.",
    };
  }
  if (values.some((status) => status !== "ok")) {
    return {
      status: "blocked",
      requiredChecks,
      ignoredUnrelatedFailures,
      remediation: "Repair the target user's Codex installation, authentication, or config.",
    };
  }
  return { status: "ok", requiredChecks, ignoredUnrelatedFailures };
}

export function assertNoSymlinkComponents(path: string): void {
  if (!isAbsolute(path)) throw new Error("Managed path must be absolute.");
  const normalized = resolve(path);
  const root = parse(normalized).root;
  let current = root;
  for (const component of relative(root, normalized).split(sep).filter(Boolean)) {
    current = join(current, component);
    if (!existsSync(current)) continue;
    if (lstatSync(current).isSymbolicLink()) {
      throw new Error("Managed path contains a symbolic link.");
    }
  }
}

function assertCanonicalDirectory(path: string, expectedUid: number, requireOwner = true): string {
  if (!isAbsolute(path)) throw new Error("Directory path must be absolute.");
  assertNoSymlinkComponents(path);
  const canonical = realpathSync(path);
  if (canonical !== resolve(path)) throw new Error("Directory path must already be canonical.");
  const metadata = statSync(canonical);
  if (!metadata.isDirectory()) throw new Error("Configured path must be a directory.");
  if (requireOwner && metadata.uid !== expectedUid) {
    throw new Error("Configured directory must be owned by the target user.");
  }
  return canonical;
}

function assertDirectoryBoundary(path: string, expectedUid: number, privateMode: boolean): void {
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Directory boundary must be a real directory.");
  }
  if (metadata.uid !== expectedUid) throw new Error("Directory boundary has the wrong owner.");
  if (privateMode && (metadata.mode & 0o077) !== 0) {
    throw new Error("Directory boundary must be private.");
  }
}

function checkStatus(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value) || typeof value.status !== "string") return undefined;
  return value.status;
}

function isMachOExecutable(path: string): boolean {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    const magic = Buffer.alloc(4);
    if (readSync(descriptor, magic, 0, magic.byteLength, 0) !== magic.byteLength) return false;
    return new Set([
      "feedface",
      "cefaedfe",
      "feedfacf",
      "cffaedfe",
      "cafebabe",
      "bebafeca",
      "cafebabf",
      "bfbafeca",
    ]).has(magic.toString("hex"));
  } finally {
    closeSync(descriptor);
  }
}

function fsyncDirectory(path: string): void {
  const descriptor = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
