export const WORKSTATION_PACKAGE_ID = "kr.hurdoo.naru.workstation";

export const DISTRIBUTION_SCHEMA_VERSION = 1 as const;
export const DISTRIBUTION_TASK_ID = "workstation-v0/T14" as const;
export const PRIVATE_INGRESS_DISTRIBUTION_SCHEMA_VERSION = 2 as const;
export const PRIVATE_INGRESS_DISTRIBUTION_TASK_ID = "private-ingress-v0/PI-05" as const;
export const ARTIFACT_PLATFORM = "darwin" as const;
export const ARTIFACT_ARCHITECTURE = "arm64" as const;
export const SUPPORTED_NODE_MAJOR = 24;
export const INSTANCE_DIGEST_LENGTH = 12;
export const MAX_UNIX_SOCKET_BYTES = 100;

export const ARTIFACT_FEATURE_LOCAL_SESSION_CLI = "local-session-cli-v1" as const;
export type ArtifactFeature = typeof ARTIFACT_FEATURE_LOCAL_SESSION_CLI;
export const LOCAL_SESSION_CLI_APP_ID = "local-session-cli" as const;

export const RUNTIME_SERVICE_NAMES = ["host", "gateway", "naru"] as const;
export const SERVICE_NAMES = [...RUNTIME_SERVICE_NAMES, "maintenance"] as const;

export type RuntimeServiceName = (typeof RUNTIME_SERVICE_NAMES)[number];
export type ServiceName = (typeof SERVICE_NAMES)[number];

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;
export const PRIVATE_EXECUTABLE_MODE = 0o700;

export const ARTIFACT_REQUIRED_PATHS = [
  "LICENSE",
  "NOTICE",
  "THIRD_PARTY_NOTICES.md",
  "components/host/dist/main.js",
  "components/gateway/dist/main.js",
  "components/naru/dist/index.js",
  "components/naru/dist/codex-integration-launcher.js",
  "components/naru/dist/codex-session-hook-cli.js",
  "web-base/index.html",
  "web-base/manifest.webmanifest",
  "web-base/sw.js",
  "bin/workstation.mjs",
  "bin/workstation-maintenance.mjs",
] as const;

export const LOCAL_SESSION_CLI_REQUIRED_PATHS = [
  "components/cli/dist/main.js",
  "bin/durable-session.mjs",
] as const;

export function workstationArtifactName(buildId: string): string {
  if (!/^[a-z0-9][a-z0-9._-]{5,127}$/.test(buildId)) {
    throw new Error("Artifact build ID must be a lowercase safe identifier.");
  }
  return `naru-workstation-${ARTIFACT_PLATFORM}-${ARTIFACT_ARCHITECTURE}-${buildId}.tar.zst`;
}
