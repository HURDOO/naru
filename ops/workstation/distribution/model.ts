import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { isAbsolute, join, resolve } from "node:path";
import {
  PrivateIngressV0Schema,
  type PrivateIngressV0,
} from "../../../packages/contracts/src/private-ingress/v0/index.js";
import {
  naruAppPath,
  naruAppScopePath,
  parseNaruAppBasePath,
} from "../../../packages/contracts/src/naru-app/v1/index.js";
import {
  DISTRIBUTION_SCHEMA_VERSION,
  DISTRIBUTION_TASK_ID,
  INSTANCE_DIGEST_LENGTH,
  MAX_UNIX_SOCKET_BYTES,
  PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION,
  PRIVATE_INGRESS_DISTRIBUTION_TASK_ID,
  SERVICE_NAMES,
  WORKSTATION_PACKAGE_ID,
  LOCAL_SESSION_CLI_APP_ID,
  type ArtifactFeature,
  type ServiceName,
} from "./constants.js";
import type { PackagedNodeRuntimeV1 } from "./node-runtime.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SLUG_PATTERN = /^[a-z][a-z0-9-]{0,23}$/;
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;

export type IngressKind = "none" | "tailscale-serve" | "wireguard-direct" | "trusted-lan";

interface WorkstationInstallationIntentCommon {
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly installationId: string;
  readonly slug: string;
  readonly targetUid: number;
  readonly homeDirectory: string;
  readonly artifactRoot: string;
  readonly canonicalBrowserOrigin: string;
  /** Absent only in legacy intent/receipt documents, where Naru owned `/`. */
  readonly naruAppBasePath?: string;
  /** Optional, independently hosted apps on the same authenticated Gateway Origin. */
  readonly additionalGatewayApps?: readonly AdditionalGatewayApp[];
  /** Optional binding for an independently hosted Naru behind another Workstation Gateway. */
  readonly externalGateway?: ExternalGatewayBinding;
  readonly defaultAgentPaneKind?: "codex" | "claude";
  /** Opt-in Naru Agent Platform; absent means off, as in every existing installation. */
  readonly agentPlatform?: AgentPlatformSettings;
  readonly allowedProjectRoots: readonly string[];
  /** Opt-in exact Project roots; other roots remain strict parents. */
  readonly exactProjectRoots?: readonly string[];
  readonly nodeExecutable: string;
  readonly shellExecutable: string;
  readonly codexExecutable: string;
  /** Additive: absent in existing installations until Claude Code is configured. */
  readonly claudeExecutable?: string;
  readonly vapidSubject?: string;
}

export interface AdditionalGatewayApp {
  readonly appId: string;
  readonly routePrefix: string;
  readonly upstreamPort: number;
}

export interface AgentPlatformSettings {
  /** The user-installed Claude Agent SDK entry (`sdk.mjs`); Naru never bundles it (AP-D012). */
  readonly claudeAgentSdkPath: string;
}

export interface ExternalGatewayBinding {
  readonly instanceId: string;
  readonly appId: string;
  readonly ownerSubject: string;
  readonly verifierKeysFile: string;
}

export interface WorkstationInstallationIntentV1 extends WorkstationInstallationIntentCommon {
  readonly version: typeof DISTRIBUTION_SCHEMA_VERSION;
  readonly ingress: {
    readonly kind: IngressKind;
    readonly profileId: string;
  };
}

export interface WorkstationInstallationIntentV2 extends WorkstationInstallationIntentCommon {
  readonly version: typeof PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION;
  readonly ingress: PrivateIngressV0;
}

export type WorkstationInstallationIntent =
  WorkstationInstallationIntentV1 | WorkstationInstallationIntentV2;

export type DistributionDocumentVersion = WorkstationInstallationIntent["version"];
export type DistributionDocumentTaskId =
  typeof DISTRIBUTION_TASK_ID | typeof PRIVATE_INGRESS_DISTRIBUTION_TASK_ID;

export interface DistributionArtifactSummary {
  readonly schemaVersion: typeof DISTRIBUTION_SCHEMA_VERSION;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly buildId: string;
  readonly manifestDigest: string;
  readonly payloadDigest: string;
  readonly root: string;
  readonly features: readonly ArtifactFeature[];
  readonly nodeRuntime?: PackagedNodeRuntimeV1;
}

export interface CanonicalBrowserIdentity {
  readonly origin: string;
  readonly hostname: string;
  readonly rpId: string;
  readonly manifestId: string;
  readonly manifestStartUrl: string;
  readonly manifestScope: string;
  readonly vapidSubject: string;
}

export interface WorkstationInstanceLayout {
  readonly schemaVersion: typeof DISTRIBUTION_SCHEMA_VERSION;
  readonly taskId: typeof DISTRIBUTION_TASK_ID;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly installationId: string;
  readonly namespace: string;
  readonly uid: number;
  readonly homeDirectory: string;
  readonly stateRoot: string;
  readonly shortRuntimeRoot: string;
  readonly directories: {
    readonly instancesRoot: string;
    readonly receipts: string;
    readonly releases: string;
    readonly webReleases: string;
    readonly config: string;
    readonly credentials: string;
    readonly data: string;
    readonly hostData: string;
    readonly gatewayData: string;
    readonly naruData: string;
    readonly maintenance: string;
    readonly logs: string;
    readonly launchAgents: string;
  };
  readonly files: {
    readonly instance: string;
    readonly ownership: string;
    readonly hostConfig: string;
    readonly gatewayConfig: string;
    readonly naruEnvironment: string;
    readonly hostCredential: string;
    readonly localSessionCliCredential: string;
    readonly gatewayVerifierKeys: string;
    readonly maintenanceRequest: string;
    readonly maintenanceResult: string;
    readonly maintenanceLock: string;
  };
  readonly sockets: {
    readonly host: string;
    readonly gatewayAdmin: string;
    readonly naruIntegration: string;
  };
  readonly labels: Readonly<Record<ServiceName, string>>;
  readonly launchAgentFiles: Readonly<Record<ServiceName, string>>;
  readonly logFiles: Readonly<
    Record<ServiceName, { readonly stdout: string; readonly stderr: string }>
  >;
  readonly ports: {
    readonly gateway: number;
    readonly naru: number;
  };
  readonly loopback: {
    readonly gatewayOrigin: string;
    readonly naruOrigin: string;
  };
  readonly browser: CanonicalBrowserIdentity;
  readonly appBasePath: string;
  readonly ownerSubject: string;
  readonly gatewayAppId: "naru";
  readonly localSessionCliAppId: typeof LOCAL_SESSION_CLI_APP_ID;
  readonly cookieName: string;
  readonly rootMappings: readonly { readonly rootId: string; readonly path: string }[];
  readonly releaseRoot: string;
  readonly webReleaseRoot: string;
  readonly runtime: {
    readonly nodeExecutable: string;
    readonly nodeSource: "artifact" | "external";
  };
  readonly entrypoints: {
    readonly host: string;
    readonly gateway: string;
    readonly naru: string;
    readonly sessionCli: string;
    readonly codexIntegrationLauncher: string;
    readonly codexHook: string;
    readonly claudeIntegrationLauncher: string;
    readonly claudeIntegrationHook: string;
    readonly workstation: string;
    readonly maintenance: string;
  };
}

export interface OriginTransition {
  readonly changed: boolean;
  readonly portChanged: boolean;
  readonly hostnameChanged: boolean;
  readonly pwaReinstallRequired: boolean;
  readonly pushResubscribeRequired: boolean;
  readonly passkeyBootstrapRequired: boolean;
  readonly preserveVapidKeyPair: true;
  readonly browserCleanupIsUserOwned: true;
}

export function parseInstallationIntent(value: unknown): WorkstationInstallationIntent {
  if (!isRecord(value)) throw new Error("Installation intent must be a JSON object.");
  assertExactKeys(value, [
    "version",
    "packageId",
    "installationId",
    "slug",
    "targetUid",
    "homeDirectory",
    "artifactRoot",
    "canonicalBrowserOrigin",
    "naruAppBasePath",
    "additionalGatewayApps",
    "externalGateway",
    "defaultAgentPaneKind",
    "agentPlatform",
    "allowedProjectRoots",
    "exactProjectRoots",
    "nodeExecutable",
    "shellExecutable",
    "codexExecutable",
    "claudeExecutable",
    "vapidSubject",
    "ingress",
  ]);
  if (
    value.version !== DISTRIBUTION_SCHEMA_VERSION &&
    value.version !== PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported installation intent version.");
  }
  if (value.packageId !== WORKSTATION_PACKAGE_ID) {
    throw new Error("Installation intent package identity does not match Workstation.");
  }
  if (typeof value.installationId !== "string" || !UUID_PATTERN.test(value.installationId)) {
    throw new Error("Installation ID must be a UUID.");
  }
  if (typeof value.slug !== "string" || !SLUG_PATTERN.test(value.slug)) {
    throw new Error("Instance slug must be a lowercase safe label up to 24 characters.");
  }
  assertUid(value.targetUid);
  const homeDirectory = requireAbsolutePath(value.homeDirectory, "Home directory");
  const artifactRoot = requireAbsolutePath(value.artifactRoot, "Artifact root");
  const nodeExecutable = requireAbsolutePath(value.nodeExecutable, "Node executable");
  const shellExecutable = requireAbsolutePath(value.shellExecutable, "Shell executable");
  const codexExecutable = requireAbsolutePath(value.codexExecutable, "Codex executable");
  const claudeExecutable =
    value.claudeExecutable === undefined
      ? undefined
      : requireAbsolutePath(value.claudeExecutable, "Claude Code executable");
  const canonicalBrowserOrigin = canonicalHttpsOrigin(value.canonicalBrowserOrigin);
  const naruAppBasePath =
    value.naruAppBasePath === undefined ? undefined : parseNaruAppBasePath(value.naruAppBasePath);
  const additionalGatewayApps = parseAdditionalGatewayApps(
    value.additionalGatewayApps,
    naruAppBasePath ?? "/",
  );
  const externalGateway = parseExternalGatewayBinding(value.externalGateway);
  const defaultAgentPaneKind = parseDefaultAgentPaneKind(value.defaultAgentPaneKind);
  if (defaultAgentPaneKind === "claude" && claudeExecutable === undefined) {
    throw new Error("Claude default Pane requires a configured Claude executable.");
  }
  const agentPlatform = parseAgentPlatform(value.agentPlatform);
  if (agentPlatform !== undefined && claudeExecutable === undefined) {
    throw new Error("Agent Platform requires a configured Claude executable.");
  }
  if (
    externalGateway !== undefined &&
    (value.version !== DISTRIBUTION_SCHEMA_VERSION ||
      naruAppBasePath === undefined ||
      naruAppBasePath === "/" ||
      additionalGatewayApps !== undefined)
  ) {
    throw new Error("External Gateway binding requires an isolated non-root v1 app instance.");
  }
  const allowedProjectRoots = parseProjectRoots(value.allowedProjectRoots);
  const exactProjectRoots = parseExactProjectRoots(value.exactProjectRoots, allowedProjectRoots);
  const vapidSubject =
    value.vapidSubject === undefined
      ? undefined
      : canonicalVapidSubject(value.vapidSubject, canonicalBrowserOrigin);
  const common = {
    packageId: WORKSTATION_PACKAGE_ID,
    installationId: value.installationId.toLowerCase(),
    slug: value.slug,
    targetUid: value.targetUid,
    homeDirectory,
    artifactRoot,
    canonicalBrowserOrigin,
    ...(naruAppBasePath === undefined ? {} : { naruAppBasePath }),
    ...(additionalGatewayApps === undefined ? {} : { additionalGatewayApps }),
    ...(externalGateway === undefined ? {} : { externalGateway }),
    ...(defaultAgentPaneKind === undefined ? {} : { defaultAgentPaneKind }),
    ...(agentPlatform === undefined ? {} : { agentPlatform }),
    allowedProjectRoots,
    ...(exactProjectRoots === undefined ? {} : { exactProjectRoots }),
    nodeExecutable,
    shellExecutable,
    codexExecutable,
    ...(claudeExecutable === undefined ? {} : { claudeExecutable }),
    ...(vapidSubject === undefined ? {} : { vapidSubject }),
  } as const;
  if (value.version === DISTRIBUTION_SCHEMA_VERSION) {
    const ingress = parseLegacyIngress(value.ingress);
    if (externalGateway !== undefined && ingress.kind !== "none") {
      throw new Error("External Gateway app must not own a browser ingress listener.");
    }
    return {
      version: DISTRIBUTION_SCHEMA_VERSION,
      ...common,
      ingress,
    };
  }
  const ingress = PrivateIngressV0Schema.parse(value.ingress);
  if (ingress.browserOrigin !== canonicalBrowserOrigin) {
    throw new Error("Private ingress Origin must match the installation browser Origin.");
  }
  return {
    version: PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION,
    ...common,
    ingress,
  };
}

export function createInstanceNamespace(intent: WorkstationInstallationIntent): string {
  const digest = createHash("sha256")
    .update(intent.installationId)
    .update("\0")
    .update(String(intent.targetUid))
    .digest("hex")
    .slice(0, INSTANCE_DIGEST_LENGTH);
  return `${intent.slug}-u${intent.targetUid}-${digest}`;
}

export function artifactNodeExecutable(
  artifact: DistributionArtifactSummary,
  externalFallback?: string,
): string {
  if (artifact.nodeRuntime !== undefined) {
    return join(artifact.root, artifact.nodeRuntime.executableRelativePath);
  }
  if (externalFallback === undefined) {
    throw new Error("Legacy artifact requires an external Node executable.");
  }
  return externalFallback;
}

export function createInstanceShortRuntimeRoot(intent: WorkstationInstallationIntent): string {
  return join(
    intent.homeDirectory,
    "Library",
    "Application Support",
    "NaruWS",
    createInstanceNamespace(intent),
    "run",
  );
}

export function createInstanceStateRoot(intent: WorkstationInstallationIntent): string {
  return join(
    intent.homeDirectory,
    "Library",
    "Application Support",
    "Naru Workstation",
    "instances",
    createInstanceNamespace(intent),
  );
}

export function createInstanceOwnershipReceiptPath(intent: WorkstationInstallationIntent): string {
  return join(createInstanceStateRoot(intent), "ownership.json");
}

export function createInstanceLayout(
  intent: WorkstationInstallationIntent,
  artifact: DistributionArtifactSummary,
): WorkstationInstanceLayout {
  if (artifact.packageId !== WORKSTATION_PACKAGE_ID) {
    throw new Error("Artifact package identity does not match Workstation.");
  }
  const namespace = createInstanceNamespace(intent);
  if (intent.externalGateway?.instanceId === namespace) {
    throw new Error("External Gateway binding must reference a different instance.");
  }
  const digest = namespace.slice(-INSTANCE_DIGEST_LENGTH);
  const applicationSupport = join(intent.homeDirectory, "Library", "Application Support");
  const instancesRoot = join(applicationSupport, "Naru Workstation", "instances");
  const stateRoot = createInstanceStateRoot(intent);
  const shortRuntimeRoot = createInstanceShortRuntimeRoot(intent);
  const launchAgents = join(intent.homeDirectory, "Library", "LaunchAgents");
  const releases = join(stateRoot, "releases");
  const webReleases = join(stateRoot, "web-releases");
  const releaseRoot = join(releases, artifact.buildId);
  const nodeExecutable =
    artifact.nodeRuntime === undefined
      ? intent.nodeExecutable
      : join(releaseRoot, artifact.nodeRuntime.executableRelativePath);
  const appBasePath = intent.naruAppBasePath ?? "/";
  const webIdentity =
    intent.naruAppBasePath === undefined
      ? intent.canonicalBrowserOrigin
      : `${intent.canonicalBrowserOrigin}\0${appBasePath}`;
  const originDigest = digestText(webIdentity).slice(0, 12);
  const webReleaseRoot = join(webReleases, `${artifact.buildId}-${originDigest}`);
  const config = join(stateRoot, "config");
  const credentials = join(stateRoot, "credentials");
  const data = join(stateRoot, "data");
  const maintenance = join(stateRoot, "maintenance");
  const logs = join(stateRoot, "logs");
  const labels = Object.fromEntries(
    SERVICE_NAMES.map((name) => [name, `${WORKSTATION_PACKAGE_ID}.${namespace}.${name}`]),
  ) as unknown as Readonly<Record<ServiceName, string>>;
  const launchAgentFiles = Object.fromEntries(
    SERVICE_NAMES.map((name) => [name, join(launchAgents, `${labels[name]}.plist`)]),
  ) as unknown as Readonly<Record<ServiceName, string>>;
  const logFiles = Object.fromEntries(
    SERVICE_NAMES.map((name) => [
      name,
      {
        stdout: join(logs, `${name}.stdout.log`),
        stderr: join(logs, `${name}.stderr.log`),
      },
    ]),
  ) as unknown as Readonly<
    Record<ServiceName, { readonly stdout: string; readonly stderr: string }>
  >;
  const portSlot = Number.parseInt(digest.slice(0, 4), 16) % 1_000;
  const gatewayPort = 48_000 + portSlot * 2;
  const naruPort = gatewayPort + 1;
  const browser = browserIdentity(
    intent.canonicalBrowserOrigin,
    intent.vapidSubject ?? intent.canonicalBrowserOrigin,
    appBasePath,
  );
  const rootMappings = intent.allowedProjectRoots.map((path) => ({
    rootId: `root-${digestText(path).slice(0, 16)}`,
    path,
  }));

  const layout: WorkstationInstanceLayout = {
    schemaVersion: DISTRIBUTION_SCHEMA_VERSION,
    taskId: DISTRIBUTION_TASK_ID,
    packageId: WORKSTATION_PACKAGE_ID,
    installationId: intent.installationId,
    namespace,
    uid: intent.targetUid,
    homeDirectory: intent.homeDirectory,
    stateRoot,
    shortRuntimeRoot,
    directories: {
      instancesRoot,
      receipts: join(stateRoot, "receipts"),
      releases,
      webReleases,
      config,
      credentials,
      data,
      hostData: join(data, "host"),
      gatewayData: join(data, "gateway"),
      naruData: join(data, "naru"),
      maintenance,
      logs,
      launchAgents,
    },
    files: {
      instance: join(stateRoot, "instance.json"),
      ownership: join(stateRoot, "ownership.json"),
      hostConfig: join(config, "durable-session-host.json"),
      gatewayConfig: join(config, "workstation-gateway.json"),
      naruEnvironment: join(credentials, "naru.env"),
      hostCredential: join(credentials, "naru-host.credential"),
      localSessionCliCredential: join(credentials, "local-session-cli-host.credential"),
      gatewayVerifierKeys: join(credentials, "gateway-verifier-keys.json"),
      maintenanceRequest: join(maintenance, "current-request.json"),
      maintenanceResult: join(maintenance, "latest-result.json"),
      maintenanceLock: join(maintenance, "transaction.lock"),
    },
    sockets: {
      host: join(shortRuntimeRoot, "host.sock"),
      gatewayAdmin: join(shortRuntimeRoot, "gateway-admin.sock"),
      naruIntegration: join(shortRuntimeRoot, "naru.sock"),
    },
    labels,
    launchAgentFiles,
    logFiles,
    ports: { gateway: gatewayPort, naru: naruPort },
    loopback: {
      gatewayOrigin: `http://127.0.0.1:${gatewayPort}`,
      naruOrigin: `http://127.0.0.1:${naruPort}`,
    },
    browser,
    appBasePath,
    ownerSubject: `owner-u${intent.targetUid}-${digest}`,
    gatewayAppId: "naru",
    localSessionCliAppId: LOCAL_SESSION_CLI_APP_ID,
    cookieName: `__Host-naru-ws-${digest}`,
    rootMappings,
    releaseRoot,
    webReleaseRoot,
    runtime: {
      nodeExecutable,
      nodeSource: artifact.nodeRuntime === undefined ? "external" : "artifact",
    },
    entrypoints: {
      host: join(releaseRoot, "components", "host", "dist", "main.js"),
      gateway: join(releaseRoot, "components", "gateway", "dist", "main.js"),
      naru: join(releaseRoot, "components", "naru", "dist", "index.js"),
      sessionCli: join(releaseRoot, "bin", "durable-session.mjs"),
      codexIntegrationLauncher: join(
        releaseRoot,
        "components",
        "naru",
        "dist",
        "codex-integration-launcher.js",
      ),
      codexHook: join(releaseRoot, "components", "naru", "dist", "codex-session-hook-cli.js"),
      claudeIntegrationLauncher: join(
        releaseRoot,
        "components",
        "naru",
        "dist",
        "claude-integration-launcher.js",
      ),
      claudeIntegrationHook: join(
        releaseRoot,
        "components",
        "naru",
        "dist",
        "claude-integration-hook-cli.js",
      ),
      workstation: join(releaseRoot, "bin", "workstation.mjs"),
      maintenance: join(releaseRoot, "bin", "workstation-maintenance.mjs"),
    },
  };
  assertLayout(layout);
  return layout;
}

export function describeOriginTransition(
  previousOrigin: string | undefined,
  nextOrigin: string,
): OriginTransition {
  const next = new URL(canonicalHttpsOrigin(nextOrigin));
  if (previousOrigin === undefined) {
    return {
      changed: false,
      portChanged: false,
      hostnameChanged: false,
      pwaReinstallRequired: true,
      pushResubscribeRequired: true,
      passkeyBootstrapRequired: true,
      preserveVapidKeyPair: true,
      browserCleanupIsUserOwned: true,
    };
  }
  const previous = new URL(canonicalHttpsOrigin(previousOrigin));
  const hostnameChanged = previous.hostname !== next.hostname;
  const portChanged = normalizedPort(previous) !== normalizedPort(next);
  const changed = previous.origin !== next.origin;
  return {
    changed,
    portChanged,
    hostnameChanged,
    pwaReinstallRequired: changed,
    pushResubscribeRequired: changed,
    passkeyBootstrapRequired: hostnameChanged,
    preserveVapidKeyPair: true,
    browserCleanupIsUserOwned: true,
  };
}

export function canonicalHttpsOrigin(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || value.length > 2_048) {
    throw new Error("Canonical browser Origin must be a bounded string without whitespace.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Canonical browser Origin is not a valid URL.");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.origin !== value ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    isIP(parsed.hostname) !== 0 ||
    parsed.hostname === "localhost" ||
    parsed.hostname.endsWith(".")
  ) {
    throw new Error("Canonical browser Origin must be one exact hostname HTTPS Origin.");
  }
  return parsed.origin;
}

export function digestJson(value: unknown): string {
  return digestText(stableJson(value));
}

export function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function browserIdentity(
  origin: string,
  subject: string,
  appBasePath: string,
): CanonicalBrowserIdentity {
  const parsed = new URL(canonicalHttpsOrigin(origin));
  const appScope = naruAppScopePath(appBasePath);
  return {
    origin: parsed.origin,
    hostname: parsed.hostname,
    rpId: parsed.hostname,
    manifestId: `${parsed.origin}${appScope}`,
    manifestStartUrl: `${parsed.origin}${naruAppPath(appBasePath, "/?source=pwa")}`,
    manifestScope: `${parsed.origin}${appScope}`,
    vapidSubject: canonicalVapidSubject(subject, parsed.origin),
  };
}

function canonicalVapidSubject(value: unknown, defaultOrigin: string): string {
  if (value === undefined) return defaultOrigin;
  if (typeof value !== "string" || value.trim() !== value || value.length > 2_048) {
    throw new Error("VAPID subject must be a bounded HTTPS or mailto URI.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("VAPID subject must be a valid HTTPS or mailto URI.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "mailto:") {
    throw new Error("VAPID subject must be an HTTPS or mailto URI.");
  }
  return value;
}

export function isPrivateIngressInstallationIntent(
  intent: WorkstationInstallationIntent,
): intent is WorkstationInstallationIntentV2 {
  return intent.version === PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION;
}

export function distributionDocumentTaskId(
  intent: WorkstationInstallationIntent,
): DistributionDocumentTaskId {
  return isPrivateIngressInstallationIntent(intent)
    ? PRIVATE_INGRESS_DISTRIBUTION_TASK_ID
    : DISTRIBUTION_TASK_ID;
}

function parseLegacyIngress(value: unknown): WorkstationInstallationIntentV1["ingress"] {
  if (!isRecord(value)) throw new Error("Ingress intent must be a JSON object.");
  assertExactKeys(value, ["kind", "profileId"]);
  if (
    value.kind !== "none" &&
    value.kind !== "tailscale-serve" &&
    value.kind !== "wireguard-direct" &&
    value.kind !== "trusted-lan"
  ) {
    throw new Error("Ingress kind is unsupported.");
  }
  if (typeof value.profileId !== "string" || !PROFILE_ID_PATTERN.test(value.profileId)) {
    throw new Error("Ingress profile ID is invalid.");
  }
  return { kind: value.kind, profileId: value.profileId };
}

function parseProjectRoots(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error("At least one and at most 64 allowed Project roots are required.");
  }
  const roots = value.map((path) => requireAbsolutePath(path, "Allowed Project root"));
  if (roots.some((path) => path.includes(","))) {
    throw new Error("Allowed Project roots containing commas are unsupported by Naru.");
  }
  if (new Set(roots).size !== roots.length) {
    throw new Error("Allowed Project roots must be unique.");
  }
  return roots;
}

function parseExactProjectRoots(
  value: unknown,
  allowedProjectRoots: readonly string[],
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error("Exact Project roots must contain 1–64 paths.");
  }
  const allowed = new Set(allowedProjectRoots);
  const exact = value.map((path) => requireAbsolutePath(path, "Exact Project root"));
  if (new Set(exact).size !== exact.length || exact.some((path) => !allowed.has(path))) {
    throw new Error("Exact Project roots must uniquely name allowed Project roots.");
  }
  return exact;
}

function parseDefaultAgentPaneKind(value: unknown): "codex" | "claude" | undefined {
  if (value === undefined) return undefined;
  if (value !== "codex" && value !== "claude") {
    throw new Error("Default agent Pane kind is invalid.");
  }
  return value;
}

function parseAgentPlatform(value: unknown): AgentPlatformSettings | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("Agent Platform settings must be an object.");
  assertExactKeys(value, ["claudeAgentSdkPath"]);
  return {
    claudeAgentSdkPath: requireAbsolutePath(value.claudeAgentSdkPath, "Claude Agent SDK entry"),
  };
}

function parseExternalGatewayBinding(value: unknown): ExternalGatewayBinding | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("External Gateway binding must be an object.");
  assertExactKeys(value, ["instanceId", "appId", "ownerSubject", "verifierKeysFile"]);
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,127}$/;
  for (const name of ["instanceId", "appId", "ownerSubject"] as const) {
    if (typeof value[name] !== "string" || !identifier.test(value[name])) {
      throw new Error(`External Gateway ${name} is invalid.`);
    }
  }
  if (
    !/^[a-z][a-z0-9-]{0,63}$/.test(value.appId as string) ||
    value.appId === "naru" ||
    value.appId === LOCAL_SESSION_CLI_APP_ID
  ) {
    throw new Error("External Gateway app ID must be a distinct additional app registration.");
  }
  return {
    instanceId: value.instanceId as string,
    appId: value.appId as string,
    ownerSubject: value.ownerSubject as string,
    verifierKeysFile: requireAbsolutePath(value.verifierKeysFile, "External Gateway verifier file"),
  };
}

function parseAdditionalGatewayApps(
  value: unknown,
  naruRoutePrefix: string,
): readonly AdditionalGatewayApp[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new Error("Additional Gateway apps must contain between one and 16 registrations.");
  }
  const apps: AdditionalGatewayApp[] = [];
  const appIds = new Set<string>(["naru"]);
  const routes = [naruRoutePrefix];
  for (const raw of value as unknown[]) {
    if (!isRecord(raw)) throw new Error("Additional Gateway app must be an object.");
    assertExactKeys(raw, ["appId", "routePrefix", "upstreamPort"]);
    if (typeof raw.appId !== "string" || !/^[a-z][a-z0-9-]{0,63}$/.test(raw.appId)) {
      throw new Error("Additional Gateway app ID is invalid.");
    }
    if (appIds.has(raw.appId)) throw new Error("Additional Gateway app IDs must be unique.");
    const routePrefix = parseNaruAppBasePath(raw.routePrefix);
    if (
      routes.some(
        (route) =>
          route === "/" ||
          routePrefix === "/" ||
          route === routePrefix ||
          route.startsWith(`${routePrefix}/`) ||
          routePrefix.startsWith(`${route}/`),
      )
    ) {
      throw new Error("Additional Gateway app routes must not overlap Naru or another app.");
    }
    if (
      !Number.isInteger(raw.upstreamPort) ||
      (raw.upstreamPort as number) < 1 ||
      (raw.upstreamPort as number) > 65_535
    ) {
      throw new Error("Additional Gateway app upstream port is invalid.");
    }
    appIds.add(raw.appId);
    routes.push(routePrefix);
    apps.push({ appId: raw.appId, routePrefix, upstreamPort: raw.upstreamPort as number });
  }
  return apps;
}

function requireAbsolutePath(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    value.length > 4_096 ||
    /[\0\r\n]/.test(value)
  ) {
    throw new Error(`${label} must be an absolute path without control characters.`);
  }
  return resolve(value);
}

function assertUid(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error("Target UID must be a positive integer.");
  }
}

function assertLayout(layout: WorkstationInstanceLayout): void {
  const labels = Object.values(layout.labels);
  if (new Set(labels).size !== SERVICE_NAMES.length) {
    throw new Error("Workstation service labels must be unique.");
  }
  for (const [name, label] of Object.entries(layout.labels)) {
    if (label !== `${WORKSTATION_PACKAGE_ID}.${layout.namespace}.${name}`) {
      throw new Error("Workstation service label escaped the package namespace.");
    }
    if (label === "com.naru.agent" || label === "com.naru.maintenance") {
      throw new Error("Workstation service label collides with current production Naru.");
    }
  }
  for (const socket of Object.values(layout.sockets)) {
    if (Buffer.byteLength(socket) > MAX_UNIX_SOCKET_BYTES) {
      throw new Error(`Workstation Unix socket path exceeds the macOS limit: ${socket}`);
    }
  }
  if (layout.ports.gateway === layout.ports.naru) {
    throw new Error("Gateway and Naru loopback listeners must be distinct.");
  }
}

function digestText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedPort(url: URL): string {
  return url.port || "443";
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedKeys = new Set(allowed);
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key));
  if (unexpected.length > 0) {
    throw new Error(`Unexpected installation intent field: ${unexpected.sort()[0] ?? "unknown"}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
