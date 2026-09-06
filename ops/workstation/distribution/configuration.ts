import { dirname, delimiter } from "node:path";
import {
  ARTIFACT_FEATURE_LOCAL_SESSION_CLI,
  SERVICE_NAMES,
  type ServiceName,
} from "./constants.js";
import type {
  DistributionArtifactSummary,
  WorkstationInstallationIntent,
  WorkstationInstanceLayout,
} from "./model.js";
import { isPrivateIngressInstallationIntent } from "./model.js";
import { stableJson } from "./model.js";

const NARU_APP_CAPABILITIES = [
  "session:observe",
  "control:request",
  "control:preempt",
  "session:create:profile",
  "session:start",
  "session:stop",
  "session:forget",
  "profile:use",
] as const;

const LOCAL_SESSION_CLI_CAPABILITIES = [
  "session:observe",
  "control:request",
  "control:preempt",
  "session:create:profile",
  "session:start",
  "session:stop",
  "profile:use",
] as const;

export interface LocalSessionCliConfiguration {
  readonly executable: string;
  readonly entrypoint: string;
  readonly socketPath: string;
  readonly appId: string;
  readonly credentialFile: string;
  readonly subject: string;
  readonly callerTtlMs: number;
}

export interface GeneratedInstanceConfiguration {
  readonly instance: Readonly<Record<string, unknown>>;
  readonly host: Readonly<Record<string, unknown>>;
  readonly gateway: Readonly<Record<string, unknown>>;
  readonly naruEnvironment: Readonly<Record<string, string>>;
  readonly localSessionCli?: LocalSessionCliConfiguration;
  readonly launchAgents: Readonly<Record<ServiceName, string>>;
}

export function createInstanceConfiguration(
  intent: WorkstationInstallationIntent,
  artifact: DistributionArtifactSummary,
  layout: WorkstationInstanceLayout,
): GeneratedInstanceConfiguration {
  const pathValue = uniqueDirectories([
    dirname(layout.runtime.nodeExecutable),
    dirname(intent.codexExecutable),
    dirname(intent.shellExecutable),
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ]).join(delimiter);
  const inheritedEnvironment = [
    "USER",
    "LOGNAME",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "XDG_CONFIG_HOME",
    "CODEX_HOME",
  ];
  const rootIds = layout.rootMappings.map((root) => root.rootId);
  const profileIds = ["shell", "codex-main", "codex-quick"];
  const localSessionCli = artifact.features.includes(ARTIFACT_FEATURE_LOCAL_SESSION_CLI)
    ? {
        executable: layout.runtime.nodeExecutable,
        entrypoint: layout.entrypoints.sessionCli,
        socketPath: layout.sockets.host,
        appId: layout.localSessionCliAppId,
        credentialFile: layout.files.localSessionCliCredential,
        subject: layout.ownerSubject,
        callerTtlMs: 60_000,
      }
    : undefined;
  const environmentPolicy = {
    envPolicyId: "naru-user-env",
    inherit: inheritedEnvironment,
    values: {
      HOME: layout.homeDirectory,
      SHELL: intent.shellExecutable,
      PATH: pathValue,
      COLORTERM: "truecolor",
      NARU_CODEX_INTEGRATION_SOCKET: layout.sockets.naruIntegration,
      NARU_CODEX_HOOK_RUNNER: layout.runtime.nodeExecutable,
      NARU_CODEX_HOOK_ENTRY: layout.entrypoints.codexHook,
    },
  };
  const resourcePolicy = {
    resourcePolicyId: "naru-user-processes",
    allowedExecutables: [intent.shellExecutable, layout.runtime.nodeExecutable],
    maxCols: 500,
    maxRows: 200,
    scrollbackRows: 5_000,
    outputRingCharacters: 1024 * 1024,
    stopTimeoutMs: 5_000,
  };
  const host = {
    version: 1,
    dataDirectory: layout.directories.hostData,
    socketPath: layout.sockets.host,
    roots: layout.rootMappings,
    profiles: [
      {
        profileId: "shell",
        executable: intent.shellExecutable,
        args: ["-l"],
        envPolicyId: environmentPolicy.envPolicyId,
        resourcePolicyId: resourcePolicy.resourcePolicyId,
      },
      ...(["codex-main", "codex-quick"] as const).map((profileId) => ({
        profileId,
        executable: layout.runtime.nodeExecutable,
        args: [layout.entrypoints.codexIntegrationLauncher],
        envPolicyId: environmentPolicy.envPolicyId,
        resourcePolicyId: resourcePolicy.resourcePolicyId,
      })),
    ],
    environmentPolicies: [environmentPolicy],
    resourcePolicies: [resourcePolicy],
    appRegistrations: [
      {
        appId: layout.gatewayAppId,
        credentialFile: layout.files.hostCredential,
        capabilities: [...NARU_APP_CAPABILITIES],
        subjectScope: { kind: "ids", ids: [layout.ownerSubject] },
        sessionScope: { kind: "all" },
        profileScope: { kind: "ids", ids: profileIds },
        rootScope: { kind: "ids", ids: rootIds },
        maxCallerTtlMs: 60_000,
      },
      ...(localSessionCli === undefined
        ? []
        : [
            {
              appId: layout.localSessionCliAppId,
              credentialFile: layout.files.localSessionCliCredential,
              capabilities: [...LOCAL_SESSION_CLI_CAPABILITIES],
              subjectScope: { kind: "ids", ids: [layout.ownerSubject] },
              sessionScope: { kind: "all" },
              profileScope: { kind: "all" },
              rootScope: { kind: "all" },
              maxCallerTtlMs: localSessionCli.callerTtlMs,
            },
          ]),
    ],
    integrationPolicies: [
      {
        policyRef: "naru-codex-v0",
        appId: layout.gatewayAppId,
        integrationKind: "codex",
        profileIds: ["codex-main", "codex-quick"],
        configKeys: ["policyRef", "bindingId"],
      },
    ],
  };
  const gatewayCommon = {
    instanceId: layout.namespace,
    ownerSubject: layout.ownerSubject,
    browserOrigin: layout.browser.origin,
    ingressProfileId: intent.ingress.profileId,
    rpName: "Naru Workstation",
    dataDirectory: layout.directories.gatewayData,
    adminSocketPath: layout.sockets.gatewayAdmin,
    sessionCookieName: layout.cookieName,
    appRegistrations: [
      {
        appId: layout.gatewayAppId,
        mode: "gateway-managed",
        routePrefix: "/",
        upstream: { kind: "loopback", origin: layout.loopback.naruOrigin },
        includeCredentialRef: true,
        enabled: true,
      },
    ],
  };
  const gateway = isPrivateIngressInstallationIntent(intent)
    ? {
        version: 2 as const,
        ...gatewayCommon,
        browserIngress: intent.ingress,
      }
    : {
        version: 1 as const,
        ...gatewayCommon,
        listenHost: "127.0.0.1" as const,
        listenPort: layout.ports.gateway,
      };
  const durableRoots = Object.fromEntries(
    layout.rootMappings.map((root) => [root.rootId, root.path]),
  );
  const naruEnvironment: Readonly<Record<string, string>> = {
    NODE_ENV: "production",
    NARU_AUTH_MODE: "gateway-managed",
    NARU_HOST: "127.0.0.1",
    NARU_PORT: String(layout.ports.naru),
    NARU_ALLOWED_ORIGINS: layout.browser.origin,
    NARU_PROJECT_ROOTS: layout.rootMappings.map((root) => root.path).join(","),
    NARU_DATA_DIR: layout.directories.naruData,
    NARU_WEB_DIST: layout.webReleaseRoot,
    NARU_CODEX_PATH: intent.codexExecutable,
    NARU_GATEWAY_INSTANCE_ID: layout.namespace,
    NARU_GATEWAY_APP_ID: layout.gatewayAppId,
    NARU_GATEWAY_OWNER_SUBJECT: layout.ownerSubject,
    NARU_GATEWAY_VERIFIER_KEYS_FILE: layout.files.gatewayVerifierKeys,
    NARU_SESSION_OWNER: "durable-host",
    NARU_DURABLE_SESSION_SOCKET_PATH: layout.sockets.host,
    NARU_DURABLE_SESSION_CREDENTIAL_FILE: layout.files.hostCredential,
    NARU_DURABLE_SESSION_APP_ID: layout.gatewayAppId,
    NARU_DURABLE_SESSION_SUBJECT: layout.ownerSubject,
    NARU_DURABLE_SESSION_CALLER_TTL_MS: "60000",
    NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "600000",
    NARU_DURABLE_SESSION_PROFILE_IDS: stableJson(profileIds),
    NARU_DURABLE_SESSION_ROOTS: stableJson(durableRoots),
    NARU_CODEX_INTEGRATION_SOCKET_PATH: layout.sockets.naruIntegration,
  };
  const instance = {
    version: intent.version,
    packageId: layout.packageId,
    installationId: layout.installationId,
    namespace: layout.namespace,
    uid: layout.uid,
    buildId: artifact.buildId,
    artifactManifestDigest: artifact.manifestDigest,
    canonicalBrowserOrigin: layout.browser.origin,
    rpId: layout.browser.rpId,
    ingress: intent.ingress,
    allowedProjectRoots: layout.rootMappings,
    labels: layout.labels,
    ports: layout.ports,
    sockets: layout.sockets,
    runtime: layout.runtime,
    ...(localSessionCli === undefined ? {} : { localSessionCli }),
  };
  const launchAgents = Object.fromEntries(
    SERVICE_NAMES.map((service) => [service, renderLaunchAgent(service, intent, layout)]),
  ) as unknown as Readonly<Record<ServiceName, string>>;
  renderEnvironmentFile(naruEnvironment);
  return {
    instance,
    host,
    gateway,
    naruEnvironment,
    ...(localSessionCli === undefined ? {} : { localSessionCli }),
    launchAgents,
  };
}

export function renderEnvironmentFile(values: Readonly<Record<string, string>>): string {
  return `${Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(name)) {
        throw new Error(`Environment name is invalid: ${name}`);
      }
      if (/[\0\r\n]/.test(value)) {
        throw new Error(`Environment value contains a forbidden control character: ${name}`);
      }
      return `${name}=${quoteEnvironmentValue(value, name)}`;
    })
    .join("\n")}\n`;
}

function quoteEnvironmentValue(value: string, name: string): string {
  if (!value.includes("'")) return `'${value}'`;
  if (!value.includes("`")) return `\`${value}\``;
  if (value.trim() === value && !value.includes("#")) return value;
  throw new Error(`Environment value cannot be represented safely: ${name}`);
}

function renderLaunchAgent(
  service: ServiceName,
  intent: WorkstationInstallationIntent,
  layout: WorkstationInstanceLayout,
): string {
  const runtime = service !== "maintenance";
  const programArguments =
    service === "host"
      ? [layout.runtime.nodeExecutable, layout.entrypoints.host]
      : service === "gateway"
        ? [layout.runtime.nodeExecutable, layout.entrypoints.gateway, layout.files.gatewayConfig]
        : service === "naru"
          ? [layout.runtime.nodeExecutable, layout.entrypoints.naru]
          : [
              layout.runtime.nodeExecutable,
              layout.entrypoints.maintenance,
              "--request",
              layout.files.maintenanceRequest,
            ];
  const environment =
    service === "host"
      ? { DURABLE_SESSION_HOST_CONFIG: layout.files.hostConfig }
      : service === "naru"
        ? { NARU_ENV_FILE: layout.files.naruEnvironment }
        : {};
  const body = [
    plistKeyString("Label", layout.labels[service]),
    plistKeyArray("ProgramArguments", programArguments),
    plistKeyString("WorkingDirectory", layout.releaseRoot),
    ...(Object.keys(environment).length === 0
      ? []
      : [plistKeyDictionary("EnvironmentVariables", environment)]),
    plistKeyString("StandardOutPath", layout.logFiles[service].stdout),
    plistKeyString("StandardErrorPath", layout.logFiles[service].stderr),
    plistKeyInteger("Umask", 63),
    plistKeyInteger("ThrottleInterval", 10),
    plistKeyInteger("ExitTimeOut", 20),
    plistKeyString("ProcessType", runtime ? "Interactive" : "Background"),
    ...(runtime
      ? [
          plistKeyBoolean("RunAtLoad", true),
          `<key>KeepAlive</key>\n<dict>\n${indent(plistKeyBoolean("SuccessfulExit", false))}\n</dict>`,
        ]
      : []),
  ];
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    indent(body.join("\n")),
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function plistKeyString(key: string, value: string): string {
  return `<key>${xml(key)}</key>\n<string>${xml(value)}</string>`;
}

function plistKeyInteger(key: string, value: number): string {
  return `<key>${xml(key)}</key>\n<integer>${value}</integer>`;
}

function plistKeyBoolean(key: string, value: boolean): string {
  return `<key>${xml(key)}</key>\n<${value ? "true" : "false"}/>`;
}

function plistKeyArray(key: string, values: readonly string[]): string {
  return `<key>${xml(key)}</key>\n<array>\n${indent(
    values.map((value) => `<string>${xml(value)}</string>`).join("\n"),
  )}\n</array>`;
}

function plistKeyDictionary(key: string, values: Readonly<Record<string, string>>): string {
  const body = Object.entries(values)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => plistKeyString(name, value))
    .join("\n");
  return `<key>${xml(key)}</key>\n<dict>\n${indent(body)}\n</dict>`;
}

function indent(value: string): string {
  return value
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}

function xml(value: string): string {
  if (/[\0\r\n]/.test(value)) throw new Error("launchd plist value contains a control character.");
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function uniqueDirectories(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}
