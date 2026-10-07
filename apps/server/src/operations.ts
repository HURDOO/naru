import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { AppConfig } from "./config.js";
import { isLoopbackHost, loadConfig } from "./config.js";
import { readSecureEnvironmentFile } from "./environment-file.js";
import { readTlsCertificateGeneration } from "./tls-certificate.js";

const RELEASE_MANIFEST_FILENAME = ".naru-release.json";
const RELEASE_MANIFEST_VERSION = 2;
const LEGACY_RELEASE_MANIFEST_VERSION = 1;
const RELEASE_REQUIRED_FILES_V1 = [
  "apps/server/dist/index.js",
  "apps/server/dist/operations-cli.js",
  "apps/web/dist/index.html",
  "package.json",
  "pnpm-lock.yaml",
] as const;
const RELEASE_REQUIRED_FILES_V2 = [
  ...RELEASE_REQUIRED_FILES_V1,
  "apps/server/dist/maintenance-cli.js",
  "ops/bin/naru-ops",
  "ops/launchd/com.naru.agent.plist.template",
  "ops/launchd/com.naru.maintenance.plist.template",
] as const;
const RELEASE_BUILD_DIRECTORIES = ["apps/server/dist", "apps/web/dist"] as const;
// Fail-closed, non-deployable source compatibility fixture. Configurable private ingress is owned
// by the Workstation Gateway contract; this adapter must never widen the fixture subnet or infer a
// client from forwarded headers.
const COMPATIBILITY_FIXTURE_TLS_HOST = "10.23.45.10";
const COMPATIBILITY_FIXTURE_TLS_PORT = 8443;
const COMPATIBILITY_FIXTURE_TLS_ORIGIN = "https://naru.example.test:8443";
const COMPATIBILITY_FIXTURE_TLS_CLIENTS = new Set(["10.23.45.11", "10.23.45.12", "10.23.45.10"]);

export interface ProductionPreflightReport {
  status: "ok";
  nodeVersion: string;
  host: string;
  port: number;
  origin: string;
  sessionCookieName: string;
  projectRootCount: number;
  allowedClientCount: number;
  dataDirectoryReady: boolean;
  webBuildReady: boolean;
  shellExecutableReady: boolean;
  codexExecutableConfigured: boolean;
  tlsReady: boolean;
  tlsExpiresAt?: string;
}

export interface RunningServiceReport {
  status: "ok";
  health: "ok";
  readiness: "ready";
  listeners: readonly string[];
  metrics: {
    activePtys: number;
    activeSessions: number;
    activeWebSockets: number;
  };
}

export interface ReleaseManifest {
  formatVersion: number;
  buildId: string;
  createdAt: string;
  files: Record<string, string>;
}

export interface LaunchdTemplateValues {
  label: string;
  nodeExecutable: string;
  workingDirectory: string;
  environmentFile: string;
  standardOutPath: string;
  standardErrorPath: string;
}

export interface CertificateRenewalLaunchdValues {
  label: "com.naru.certificate-renewal";
  nodeExecutable: string;
  workingDirectory: string;
  hostname: string;
  zoneName: string;
  challengeName: string;
  tokenFile: string;
  stateDirectory: string;
  standardOutPath: string;
  standardErrorPath: string;
}

export function preflightProductionEnvironmentFile(
  environmentFile: string,
  rootDirectory: string,
  options: {
    nodeVersion?: string;
    assignedIpv4Addresses?: ReadonlySet<string>;
  } = {},
): ProductionPreflightReport {
  const { values } = readSecureEnvironmentFile(environmentFile);
  return preflightProductionEnvironment(values, rootDirectory, options);
}

export function preflightProductionEnvironment(
  environment: NodeJS.ProcessEnv,
  rootDirectory: string,
  options: {
    nodeVersion?: string;
    assignedIpv4Addresses?: ReadonlySet<string>;
  } = {},
): ProductionPreflightReport {
  if (environment.NODE_ENV !== "production") {
    throw new Error("Production preflight requires NODE_ENV=production.");
  }
  assertAbsoluteEnvironmentPath(environment, "NARU_DATA_DIR");
  assertAbsoluteEnvironmentPath(environment, "NARU_WEB_DIST");
  assertAbsoluteEnvironmentPath(environment, "SHELL");
  for (const projectRoot of splitEnvironmentList(environment.NARU_PROJECT_ROOTS)) {
    if (!isAbsolute(projectRoot)) throw new Error("NARU_PROJECT_ROOTS must use absolute paths.");
  }

  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number(nodeVersion.replace(/^v/, "").split(".")[0]);
  if (nodeMajor !== 24) throw new Error("Production service requires Node.js 24 LTS.");

  const config = loadConfig(environment, rootDirectory);
  if (config.authMode !== "app-managed") {
    throw new Error(
      "The current production preflight is for explicit app-managed Naru; workstation packaging owns gateway-managed preflight.",
    );
  }
  if (config.host === "localhost" || config.host === "::1") {
    throw new Error("Production NARU_HOST must use the exact IPv4 address 127.0.0.1.");
  }
  const assignedAddresses =
    options.assignedIpv4Addresses ?? collectAssignedIpv4Addresses(networkInterfaces());
  if (!isLoopbackHost(config.host) && !assignedAddresses.has(config.host)) {
    throw new Error("NARU_HOST is not assigned to an active local interface.");
  }
  for (const clientIp of config.allowedClientIps ?? []) {
    if (!isLoopbackHost(clientIp) && !isApprovedLanIpv4(clientIp)) {
      throw new Error("NARU_ALLOWED_CLIENT_IPS must stay inside loopback or 10.23.45.0/24.");
    }
  }

  const origin = productionOrigin(config);
  assertProductionTlsBoundary(config, origin);
  const tlsCertificate =
    config.tls === undefined ? undefined : readTlsCertificateGeneration(config.tls);

  if (config.webDist === undefined || !existsSync(join(config.webDist, "index.html"))) {
    throw new Error("NARU_WEB_DIST must contain a clean production web build.");
  }
  for (const projectRoot of config.projectRoots)
    assertExistingDirectory(projectRoot, "project root");
  const dataDirectoryReady = ensureOrInspectPrivateDirectory(config.dataDir);
  assertExecutableFile(environment.SHELL as string, "SHELL");
  if (config.codexExecutable !== undefined) {
    assertExecutableFile(config.codexExecutable, "NARU_CODEX_PATH");
  }
  if (config.claudeExecutable !== undefined) {
    assertExecutableFile(config.claudeExecutable, "NARU_CLAUDE_PATH");
  }

  return {
    status: "ok",
    nodeVersion,
    host: config.host,
    port: config.port,
    origin,
    sessionCookieName: config.sessionCookieName,
    projectRootCount: config.projectRoots.length,
    allowedClientCount: config.allowedClientIps?.size ?? 0,
    dataDirectoryReady,
    webBuildReady: true,
    shellExecutableReady: true,
    codexExecutableConfigured: config.codexExecutable !== undefined,
    tlsReady: tlsCertificate !== undefined,
    ...(tlsCertificate === undefined ? {} : { tlsExpiresAt: tlsCertificate.expiresAt }),
  };
}

export async function verifyRunningProductionService(
  config: AppConfig,
): Promise<RunningServiceReport> {
  const listenerOutput = execFileSync(
    "/usr/sbin/lsof",
    ["-nP", "-a", `-iTCP:${config.port}`, "-sTCP:LISTEN", "-Fn"],
    { encoding: "utf8" },
  );
  const listeners = parseLsofListenerAddresses(listenerOutput, config.port);
  assertExactListenerAddresses(listeners, config.host);

  const [healthResponse, readinessResponse] = await Promise.all([
    requestProductionJson(config, "/healthz"),
    requestProductionJson(config, "/readyz"),
  ]);
  const health = healthResponse.body;
  const readiness = readinessResponse.body;
  if (
    healthResponse.statusCode < 200 ||
    healthResponse.statusCode >= 300 ||
    health.status !== "ok"
  ) {
    throw new Error("Production health check failed.");
  }
  if (
    !isRecord(readiness) ||
    readinessResponse.statusCode < 200 ||
    readinessResponse.statusCode >= 300 ||
    readiness.status !== "ready"
  ) {
    throw new Error("Production readiness check failed.");
  }

  return {
    status: "ok",
    health: "ok",
    readiness: "ready",
    listeners,
    metrics: parseReadinessGauges(readiness),
  };
}

export interface ProductionProbeTarget {
  protocol: "http:" | "https:";
  connectHost: string;
  port: number;
  hostHeader: string;
  serverName?: string;
}

export function resolveProductionProbeTarget(config: AppConfig): ProductionProbeTarget {
  const originValue = productionOrigin(config);
  assertProductionTlsBoundary(config, originValue);
  const origin = new URL(originValue);
  return {
    protocol: origin.protocol as "http:" | "https:",
    connectHost: config.host,
    port: config.port,
    hostHeader: origin.host,
    ...(origin.protocol === "https:" ? { serverName: origin.hostname } : {}),
  };
}

export function productionOrigin(config: AppConfig): string {
  if (config.allowedOrigins.size !== 1) {
    throw new Error("Production NARU_ALLOWED_ORIGINS must contain one exact Origin.");
  }
  const originValue = config.allowedOrigins.values().next().value;
  if (originValue === undefined) {
    throw new Error("Production NARU_ALLOWED_ORIGINS must contain one exact Origin.");
  }
  const origin = new URL(originValue);
  const expectedProtocol = config.tls === undefined ? "http:" : "https:";
  if (origin.protocol !== expectedProtocol || config.secureCookie !== (config.tls !== undefined)) {
    throw new Error(`Production Origin must use ${expectedProtocol.slice(0, -1)}.`);
  }
  const originPort =
    origin.port === "" ? (origin.protocol === "https:" ? 443 : 80) : Number(origin.port);
  if (originPort !== config.port) {
    throw new Error(`Production Origin port must match NARU_PORT ${config.port}.`);
  }
  if (config.tls === undefined) {
    const expectedOrigin = new URL(`http://${config.host}:${config.port}`).origin;
    if (origin.origin !== expectedOrigin) {
      throw new Error(`Production HTTP Origin must be exactly ${expectedOrigin}.`);
    }
  }
  return origin.origin;
}

function assertProductionTlsBoundary(config: AppConfig, origin: string): void {
  if (config.tls === undefined) return;
  if (
    config.host !== COMPATIBILITY_FIXTURE_TLS_HOST ||
    config.port !== COMPATIBILITY_FIXTURE_TLS_PORT ||
    origin !== COMPATIBILITY_FIXTURE_TLS_ORIGIN
  ) {
    throw new Error(
      "Source compatibility HTTPS is restricted to the documented non-deployable fixture; " +
        "use the Workstation Gateway for configured private ingress.",
    );
  }
  const clients = config.allowedClientIps;
  if (
    clients === undefined ||
    clients.size !== COMPATIBILITY_FIXTURE_TLS_CLIENTS.size ||
    [...COMPATIBILITY_FIXTURE_TLS_CLIENTS].some((client) => !clients.has(client))
  ) {
    throw new Error("Source compatibility HTTPS must use the exact fixture client IP allowlist.");
  }
}

async function requestProductionJson(
  config: AppConfig,
  path: "/healthz" | "/readyz",
): Promise<{ statusCode: number; body: Record<string, unknown> }> {
  const target = resolveProductionProbeTarget(config);
  return new Promise((resolve, reject) => {
    const request = (target.protocol === "https:" ? httpsRequest : httpRequest)(
      {
        hostname: target.connectHost,
        port: target.port,
        path,
        method: "GET",
        headers: { accept: "application/json", host: target.hostHeader },
        ...(target.serverName === undefined
          ? {}
          : {
              servername: target.serverName,
              rejectUnauthorized: true,
              minVersion: "TLSv1.2" as const,
            }),
      },
      (response) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        response.once("aborted", () => reject(new Error("Production check response aborted.")));
        response.once("error", (error) => reject(error));
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          receivedBytes += buffer.byteLength;
          if (receivedBytes > 128 * 1024) {
            request.destroy(new Error("Production check response is too large."));
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
            if (!isRecord(parsed)) throw new Error("Production check returned invalid JSON.");
            resolve({ statusCode: response.statusCode ?? 0, body: parsed });
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Production check failed."));
          }
        });
      },
    );
    request.setTimeout(5_000, () => request.destroy(new Error("Production check timed out.")));
    request.once("error", reject);
    request.end();
  });
}

export function parseReadinessGauges(value: unknown): RunningServiceReport["metrics"] {
  if (!isRecord(value) || !isRecord(value.metrics) || !isRecord(value.metrics.gauges)) {
    throw new Error("Production readiness metrics are missing.");
  }
  const gauges = value.metrics.gauges;
  return {
    activePtys: readNonNegativeInteger(gauges.activePtys, "activePtys"),
    activeSessions: readNonNegativeInteger(gauges.activeSessions, "activeSessions"),
    activeWebSockets: readNonNegativeInteger(gauges.activeWebSockets, "activeWebSockets"),
  };
}

export function parseLsofListenerAddresses(output: string, expectedPort: number): string[] {
  const addresses: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.startsWith("n")) continue;
    const endpoint = line.slice(1);
    const suffix = `:${expectedPort}`;
    if (!endpoint.endsWith(suffix)) continue;
    addresses.push(endpoint.slice(0, -suffix.length));
  }
  return [...new Set(addresses)];
}

export function assertExactListenerAddresses(
  listeners: readonly string[],
  expectedHost: string,
): void {
  if (listeners.length === 0) throw new Error("No production listener was found.");
  for (const listener of listeners) {
    if (listener === "*" || listener === "0.0.0.0" || listener === "[::]") {
      throw new Error("Production service is exposed on a wildcard interface.");
    }
    if (listener !== expectedHost) {
      throw new Error(`Unexpected production listener ${listener}; expected ${expectedHost}.`);
    }
  }
}

export function writeReleaseManifest(releaseDirectory: string, buildId: string): ReleaseManifest {
  assertAbsolutePath(releaseDirectory, "release directory");
  assertSafeIdentifier(buildId, "build ID");
  assertExistingDirectory(releaseDirectory, "release directory");
  assertExistingDirectory(join(releaseDirectory, "node_modules"), "release node_modules");

  const files: Record<string, string> = {};
  for (const relativePath of collectReleaseManifestFiles(
    releaseDirectory,
    RELEASE_MANIFEST_VERSION,
  )) {
    const filename = join(releaseDirectory, relativePath);
    const metadata = lstatSync(filename);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Release file ${relativePath} must be a regular file.`);
    }
    files[relativePath] = sha256File(filename);
  }

  const manifest: ReleaseManifest = {
    formatVersion: RELEASE_MANIFEST_VERSION,
    buildId,
    createdAt: new Date().toISOString(),
    files,
  };
  const manifestFile = join(releaseDirectory, RELEASE_MANIFEST_FILENAME);
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  return manifest;
}

export function activateRelease(
  releasesDirectory: string,
  releaseId: string,
): { activeRelease: string; previousRelease: string | null } {
  assertAbsolutePath(releasesDirectory, "releases directory");
  assertSafeIdentifier(releaseId, "release ID");
  const canonicalRoot = realpathSync(releasesDirectory);
  const releaseDirectory = join(canonicalRoot, releaseId);
  const releaseMetadata = lstatSync(releaseDirectory);
  if (releaseMetadata.isSymbolicLink() || !releaseMetadata.isDirectory()) {
    throw new Error("Release must be a direct, regular directory inside the releases root.");
  }
  if (dirname(realpathSync(releaseDirectory)) !== canonicalRoot) {
    throw new Error("Release escapes the releases root.");
  }
  verifyReleaseManifest(releaseDirectory, releaseId);

  const currentLink = join(canonicalRoot, "current");
  let previousRelease: string | null = null;
  if (existsSync(currentLink)) {
    const currentMetadata = lstatSync(currentLink);
    if (!currentMetadata.isSymbolicLink()) {
      throw new Error("The active release path must be a symbolic link.");
    }
    previousRelease = readlinkSync(currentLink);
  }

  const temporaryLink = join(canonicalRoot, `.current-${randomUUID()}`);
  symlinkSync(releaseId, temporaryLink, "dir");
  renameSync(temporaryLink, currentLink);
  return { activeRelease: releaseId, previousRelease };
}

export function renderLaunchdTemplate(template: string, values: LaunchdTemplateValues): string {
  const replacements: Record<string, string> = {
    __LABEL__: values.label,
    __NODE_EXECUTABLE__: values.nodeExecutable,
    __WORKING_DIRECTORY__: values.workingDirectory,
    __SERVER_ENTRY__: join(values.workingDirectory, "apps/server/dist/index.js"),
    __ENVIRONMENT_FILE__: values.environmentFile,
    __HELPER_DIRECTORY__: join(values.workingDirectory, "ops/bin"),
    __STANDARD_OUT_PATH__: values.standardOutPath,
    __STANDARD_ERROR_PATH__: values.standardErrorPath,
  };
  let rendered = template;
  for (const [placeholder, value] of Object.entries(replacements)) {
    if (!isAbsolute(value) && placeholder !== "__LABEL__") {
      throw new Error(`${placeholder} must be an absolute path.`);
    }
    rendered = rendered.replaceAll(placeholder, escapeXml(value));
  }
  if (/__[A-Z_]+__/.test(rendered)) throw new Error("Launchd template has unresolved values.");
  return rendered;
}

export function renderCertificateRenewalLaunchd(values: CertificateRenewalLaunchdValues): string {
  if (values.label !== "com.naru.certificate-renewal") {
    throw new Error("Certificate renewal LaunchAgent must use the fixed Naru label.");
  }
  for (const [label, value] of Object.entries({
    nodeExecutable: values.nodeExecutable,
    workingDirectory: values.workingDirectory,
    tokenFile: values.tokenFile,
    stateDirectory: values.stateDirectory,
    standardOutPath: values.standardOutPath,
    standardErrorPath: values.standardErrorPath,
  })) {
    if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  }

  const nodeExecutable = escapeXml(values.nodeExecutable);
  const workingDirectory = escapeXml(values.workingDirectory);
  const renewalEntry = escapeXml(
    join(values.workingDirectory, "apps/server/dist/acme-renewal-cli.js"),
  );
  const tokenFile = escapeXml(values.tokenFile);
  const stateDirectory = escapeXml(values.stateDirectory);
  const hostname = escapeXml(values.hostname);
  const zoneName = escapeXml(values.zoneName);
  const challengeName = escapeXml(values.challengeName);
  const standardOutPath = escapeXml(values.standardOutPath);
  const standardErrorPath = escapeXml(values.standardErrorPath);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.naru.certificate-renewal</string>

  <key>ProgramArguments</key>
  <array>
    <string>${nodeExecutable}</string>
    <string>${renewalEntry}</string>
    <string>renew-production</string>
    <string>${hostname}</string>
    <string>${zoneName}</string>
    <string>${challengeName}</string>
    <string>${tokenFile}</string>
    <string>${stateDirectory}</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${workingDirectory}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/bin:/bin</string>
  </dict>

  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>3</integer>
    <key>Minute</key>
    <integer>17</integer>
  </dict>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>Umask</key>
  <integer>63</integer>

  <key>StandardOutPath</key>
  <string>${standardOutPath}</string>
  <key>StandardErrorPath</key>
  <string>${standardErrorPath}</string>
</dict>
</plist>
`;
}

export function verifyReleaseManifest(
  releaseDirectory: string,
  expectedBuildId: string,
): ReleaseManifest {
  const manifestFile = join(releaseDirectory, RELEASE_MANIFEST_FILENAME);
  const parsed = JSON.parse(readFileSync(manifestFile, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) throw new Error("Invalid release manifest.");
  const manifest = parsed as Partial<ReleaseManifest>;
  if (
    (manifest.formatVersion !== LEGACY_RELEASE_MANIFEST_VERSION &&
      manifest.formatVersion !== RELEASE_MANIFEST_VERSION) ||
    manifest.buildId !== expectedBuildId ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.files !== "object" ||
    manifest.files === null
  ) {
    throw new Error("Invalid release manifest.");
  }
  const manifestFiles = manifest.files as Record<string, unknown>;
  const expectedPaths = collectReleaseManifestFiles(releaseDirectory, manifest.formatVersion);
  if (Object.keys(manifestFiles).sort().join("\n") !== expectedPaths.join("\n")) {
    throw new Error("Release files do not match the manifest inventory.");
  }
  for (const relativePath of expectedPaths) {
    const expectedHash = manifestFiles[relativePath];
    if (
      typeof expectedHash !== "string" ||
      expectedHash !== sha256File(join(releaseDirectory, relativePath))
    ) {
      throw new Error(`Release file ${relativePath} does not match its manifest.`);
    }
  }
  return manifest as ReleaseManifest;
}

function collectReleaseManifestFiles(releaseDirectory: string, formatVersion: number): string[] {
  const files = new Set<string>(
    formatVersion === LEGACY_RELEASE_MANIFEST_VERSION
      ? RELEASE_REQUIRED_FILES_V1
      : RELEASE_REQUIRED_FILES_V2,
  );
  for (const relativeDirectory of RELEASE_BUILD_DIRECTORIES) {
    collectRegularFiles(releaseDirectory, relativeDirectory, files);
  }

  const result = [...files].sort();
  for (const relativePath of result) {
    const metadata = lstatSync(join(releaseDirectory, relativePath));
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`Release file ${relativePath} must be a regular file.`);
    }
  }
  if (formatVersion >= RELEASE_MANIFEST_VERSION) {
    accessSync(join(releaseDirectory, "ops/bin/naru-ops"), constants.X_OK);
  }
  return result;
}

function collectRegularFiles(
  releaseDirectory: string,
  relativeDirectory: string,
  files: Set<string>,
): void {
  const directory = join(releaseDirectory, relativeDirectory);
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`Release directory ${relativeDirectory} must be a regular directory.`);
  }

  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Release build artifact ${relativePath} must not be a symbolic link.`);
    }
    if (entry.isDirectory()) {
      collectRegularFiles(releaseDirectory, relativePath, files);
    } else if (entry.isFile()) {
      files.add(relativePath);
    } else {
      throw new Error(`Release build artifact ${relativePath} must be a regular file.`);
    }
  }
}

function collectAssignedIpv4Addresses(
  interfaces: ReturnType<typeof networkInterfaces>,
): ReadonlySet<string> {
  const addresses = new Set<string>(["127.0.0.1"]);
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4") addresses.add(entry.address);
    }
  }
  return addresses;
}

function isApprovedLanIpv4(value: string): boolean {
  const octets = value.split(".").map(Number);
  return (
    octets.length === 4 &&
    octets[0] === 10 &&
    octets[1] === 23 &&
    octets[2] === 45 &&
    (octets[3] ?? 0) >= 1 &&
    (octets[3] ?? 255) <= 254
  );
}

function ensureOrInspectPrivateDirectory(directory: string): boolean {
  if (!existsSync(directory)) {
    throw new Error("NARU_DATA_DIR must exist before production startup.");
  }
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("NARU_DATA_DIR must be a regular directory, not a symbolic link.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("NARU_DATA_DIR permissions must be 0700 or stricter.");
  }
  return true;
}

function assertExecutableFile(filename: string, label: string): void {
  accessSync(filename, constants.X_OK);
  if (!statSync(filename).isFile()) throw new Error(`${label} must be an executable file.`);
}

function assertExistingDirectory(directory: string, label: string): void {
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error(`${label} must be a regular directory, not a symbolic link.`);
  }
}

function assertAbsoluteEnvironmentPath(environment: NodeJS.ProcessEnv, key: string): void {
  const value = environment[key];
  if (value === undefined || !isAbsolute(value))
    throw new Error(`${key} must be an absolute path.`);
}

function splitEnvironmentList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function sha256File(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function assertAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
}

function assertSafeIdentifier(value: string, label: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${label} contains unsupported characters.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new Error(`Production readiness ${label} metric is invalid.`);
  }
  return value as number;
}
