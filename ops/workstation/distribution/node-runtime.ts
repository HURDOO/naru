import { isAbsolute } from "node:path";
import { ARTIFACT_ARCHITECTURE, ARTIFACT_PLATFORM, SUPPORTED_NODE_MAJOR } from "./constants.js";

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SAFE_RELATIVE_PATH_PATTERN = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/;

export const PACKAGED_NODE_RUNTIME = {
  version: 1,
  nodeVersion: "v24.22.1",
  platform: ARTIFACT_PLATFORM,
  architecture: ARTIFACT_ARCHITECTURE,
  archiveName: "node-v24.22.1-darwin-arm64.tar.gz",
  archiveSha256: "89c682593d76cd44233fa53b1563264e7de9cbb189cad169135c5b4fadfbc0a7",
  executableSha256: "6f32069480ec14d52b6d7b1f3c7124cfbbc46203abf5ddf5c65b127435f3f329",
  sourceUrl: "https://nodejs.org/dist/v24.22.1/node-v24.22.1-darwin-arm64.tar.gz",
  executableRelativePath: "runtime/node/bin/node",
  licenseRelativePath: "runtime/node/LICENSE",
} as const;

export interface PackagedNodeRuntimeV1 {
  readonly version: 1;
  readonly nodeVersion: string;
  readonly platform: typeof ARTIFACT_PLATFORM;
  readonly architecture: typeof ARTIFACT_ARCHITECTURE;
  readonly archiveName: string;
  readonly archiveSha256: string;
  readonly executableSha256: string;
  readonly sourceUrl: string;
  readonly executableRelativePath: string;
  readonly licenseRelativePath: string;
}

export function parsePackagedNodeRuntime(value: unknown): PackagedNodeRuntimeV1 {
  if (!isRecord(value)) throw new Error("Packaged Node runtime metadata must be an object.");
  const keys = [
    "version",
    "nodeVersion",
    "platform",
    "architecture",
    "archiveName",
    "archiveSha256",
    "executableSha256",
    "sourceUrl",
    "executableRelativePath",
    "licenseRelativePath",
  ];
  if (
    Object.keys(value).sort().join("\0") !== keys.sort().join("\0") ||
    value.version !== 1 ||
    typeof value.nodeVersion !== "string" ||
    !/^v24\.\d+\.\d+$/.test(value.nodeVersion) ||
    value.platform !== ARTIFACT_PLATFORM ||
    value.architecture !== ARTIFACT_ARCHITECTURE ||
    typeof value.archiveName !== "string" ||
    value.archiveName !== `node-${value.nodeVersion}-darwin-arm64.tar.gz` ||
    typeof value.archiveSha256 !== "string" ||
    !SHA256_PATTERN.test(value.archiveSha256) ||
    typeof value.executableSha256 !== "string" ||
    !SHA256_PATTERN.test(value.executableSha256) ||
    typeof value.sourceUrl !== "string" ||
    value.sourceUrl !== `https://nodejs.org/dist/${value.nodeVersion}/${value.archiveName}` ||
    value.executableRelativePath !== PACKAGED_NODE_RUNTIME.executableRelativePath ||
    value.licenseRelativePath !== PACKAGED_NODE_RUNTIME.licenseRelativePath ||
    typeof value.executableRelativePath !== "string" ||
    typeof value.licenseRelativePath !== "string" ||
    !isSafeRelativePath(value.executableRelativePath) ||
    !isSafeRelativePath(value.licenseRelativePath) ||
    !value.nodeVersion.startsWith(`v${SUPPORTED_NODE_MAJOR}.`)
  ) {
    throw new Error("Packaged Node runtime metadata is invalid or unsupported.");
  }
  return {
    version: 1,
    nodeVersion: value.nodeVersion,
    platform: ARTIFACT_PLATFORM,
    architecture: ARTIFACT_ARCHITECTURE,
    archiveName: value.archiveName,
    archiveSha256: value.archiveSha256,
    executableSha256: value.executableSha256,
    sourceUrl: value.sourceUrl,
    executableRelativePath: value.executableRelativePath,
    licenseRelativePath: value.licenseRelativePath,
  };
}

function isSafeRelativePath(value: string): boolean {
  return !isAbsolute(value) && SAFE_RELATIVE_PATH_PATTERN.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
