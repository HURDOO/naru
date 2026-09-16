import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import {
  DISTRIBUTION_SCHEMA_VERSION,
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_EXECUTABLE_MODE,
  PRIVATE_FILE_MODE,
  WORKSTATION_PACKAGE_ID,
} from "./constants.js";
import {
  NARU_APP_BASE_PATH_META_NAME,
  naruAppPath,
  parseNaruAppBasePath,
} from "../../../packages/contracts/src/naru-app/v1/index.js";
import type { CanonicalBrowserIdentity } from "./model.js";
import { digestJson, stableJson } from "./model.js";

const WEB_RELEASE_RECEIPT = "workstation-web-release.json";
const ORIGIN_META_PATTERN =
  /<meta\s+name=["']naru-canonical-origin["']\s+content=["']([^"']*)["']\s*\/?>/g;
const APP_BASE_PATH_META_PATTERN = new RegExp(
  `<meta\\s+name=["']${NARU_APP_BASE_PATH_META_NAME}["']\\s+content=["']([^"']*)["']\\s*\\/?>`,
  "g",
);
const SERVICE_WORKER_REVISION_PATTERN = /Build revision: ([a-f0-9]{8,64})/;
const SERVICE_WORKER_BASE_PATH_PATTERN = /const APP_BASE_PATH = ("(?:[^"\\]|\\.)*");/g;
const SERVICE_WORKER_BASE_PATH_COMMENT_PATTERN = /Build app base path: ([^ *;]+)/g;

export interface InstanceWebReleaseReceiptV1 {
  readonly version: typeof DISTRIBUTION_SCHEMA_VERSION;
  readonly packageId: typeof WORKSTATION_PACKAGE_ID;
  readonly buildId: string;
  readonly canonicalBrowserOrigin: string;
  /** Absent only in legacy root-scoped web release receipts. */
  readonly appBasePath?: string;
  readonly rpId: string;
  readonly basePayloadDigest: string;
  readonly manifestSha256: string;
  readonly serviceWorkerRevision: string;
  readonly contentDigest: string;
}

export interface RenderInstanceWebReleaseInput {
  readonly baseWebRoot: string;
  readonly targetWebRoot: string;
  readonly buildId: string;
  readonly basePayloadDigest: string;
  readonly browser: CanonicalBrowserIdentity;
  readonly appBasePath: string;
}

export function renderInstanceWebRelease(
  input: RenderInstanceWebReleaseInput,
): InstanceWebReleaseReceiptV1 {
  const source = resolve(input.baseWebRoot);
  const target = resolve(input.targetWebRoot);
  assertRealDirectory(source);
  assertNoSymlinkTree(source);
  if (existsSync(target)) {
    const existing = verifyInstanceWebRelease(target);
    assertReceiptMatchesInput(existing, input);
    return existing;
  }
  if (!existsSync(dirname(target))) {
    throw new Error("Instance web release parent directory does not exist.");
  }

  const temporary = join(dirname(target), `.${basename(target)}.incoming-${randomUUID()}`);
  mkdirSync(temporary, { mode: PRIVATE_DIRECTORY_MODE });
  copyTree(source, temporary);

  const manifestPath = join(temporary, "manifest.webmanifest");
  const renderedManifest = renderManifest(manifestPath, input.browser, input.appBasePath);
  writeFileSync(manifestPath, renderedManifest, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  chmodSync(manifestPath, PRIVATE_FILE_MODE);

  const indexPath = join(temporary, "index.html");
  const baseIndexSource = readFileSync(indexPath, "utf8");
  const sourceAppBasePath = readAppBasePathMeta(baseIndexSource);
  if (sourceAppBasePath === null) {
    throw new Error("Base web index app base path metadata is missing.");
  }
  const renderedIndex = renderWebMetadata(baseIndexSource, input.browser.origin, input.appBasePath);
  writeFileSync(indexPath, renderedIndex, { encoding: "utf8", mode: PRIVATE_FILE_MODE });
  chmodSync(indexPath, PRIVATE_FILE_MODE);

  const serviceWorkerPath = join(temporary, "sw.js");
  const renderedWorker = renderServiceWorker(
    readFileSync(serviceWorkerPath, "utf8"),
    renderedManifest,
    renderedIndex,
    input,
    sourceAppBasePath,
  );
  writeFileSync(serviceWorkerPath, renderedWorker.source, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
  });
  chmodSync(serviceWorkerPath, PRIVATE_FILE_MODE);

  const manifestSha256 = sha256(renderedManifest);
  const contentDigest = digestWebTree(temporary);
  const receipt: InstanceWebReleaseReceiptV1 = {
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    buildId: input.buildId,
    canonicalBrowserOrigin: input.browser.origin,
    appBasePath: input.appBasePath,
    rpId: input.browser.rpId,
    basePayloadDigest: input.basePayloadDigest,
    manifestSha256,
    serviceWorkerRevision: renderedWorker.revision,
    contentDigest,
  };
  writeFileSync(join(temporary, WEB_RELEASE_RECEIPT), `${stableJson(receipt)}\n`, {
    encoding: "utf8",
    mode: PRIVATE_FILE_MODE,
    flag: "wx",
  });
  renameSync(temporary, target);
  const verified = verifyInstanceWebRelease(target);
  assertReceiptMatchesInput(verified, input);
  return verified;
}

export function verifyInstanceWebRelease(webRoot: string): InstanceWebReleaseReceiptV1 {
  const root = resolve(webRoot);
  assertRealDirectory(root);
  assertNoSymlinkTree(root);
  const receiptPath = join(root, WEB_RELEASE_RECEIPT);
  assertRegularFile(receiptPath);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(receiptPath, "utf8")) as unknown;
  } catch {
    throw new Error("Instance web release receipt is invalid JSON.");
  }
  const receipt = parseWebReleaseReceipt(value);
  if (digestWebTree(root) !== receipt.contentDigest) {
    throw new Error("Instance web release content digest does not match its receipt.");
  }
  const manifestSource = readFileSync(join(root, "manifest.webmanifest"), "utf8");
  if (sha256(manifestSource) !== receipt.manifestSha256) {
    throw new Error("Instance PWA manifest digest does not match its receipt.");
  }
  const appBasePath = receipt.appBasePath ?? "/";
  assertRenderedManifest(manifestSource, receipt.canonicalBrowserOrigin, appBasePath);
  const indexSource = readFileSync(join(root, "index.html"), "utf8");
  if (readOriginMeta(indexSource) !== receipt.canonicalBrowserOrigin) {
    throw new Error("Instance web index Origin metadata does not match its receipt.");
  }
  const indexBasePath = readAppBasePathMeta(indexSource);
  if (
    (receipt.appBasePath === undefined && indexBasePath !== null && indexBasePath !== "/") ||
    (receipt.appBasePath !== undefined && indexBasePath !== receipt.appBasePath)
  ) {
    throw new Error("Instance web index app base path does not match its receipt.");
  }
  const workerSource = readFileSync(join(root, "sw.js"), "utf8");
  if (readServiceWorkerRevision(workerSource) !== receipt.serviceWorkerRevision) {
    throw new Error("Instance service worker revision does not match its receipt.");
  }
  if (
    receipt.appBasePath !== undefined &&
    readServiceWorkerBasePath(workerSource) !== appBasePath
  ) {
    throw new Error("Instance service worker app base path does not match its receipt.");
  }
  return receipt;
}

function renderManifest(
  path: string,
  browser: CanonicalBrowserIdentity,
  appBasePath: string,
): string {
  assertRegularFile(path);
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error("Base PWA manifest is invalid JSON.");
  }
  if (!isRecord(value) || !Array.isArray(value.icons)) {
    throw new Error("Base PWA manifest is missing its icon set.");
  }
  const icons = value.icons.map((icon) => {
    if (!isRecord(icon) || typeof icon.src !== "string") {
      throw new Error("Base PWA manifest contains an invalid icon.");
    }
    const pathname = iconPathname(icon.src);
    const iconSuffix = pathname.slice(pathname.indexOf("/icons/"));
    if (!pathname.includes("/icons/") || !/^\/icons\/[A-Za-z0-9._-]+$/.test(iconSuffix)) {
      throw new Error("PWA icon must remain under the same-origin app icons path.");
    }
    return { ...icon, src: `${browser.origin}${naruAppPath(appBasePath, iconSuffix)}` };
  });
  return `${JSON.stringify(
    {
      ...value,
      id: browser.manifestId,
      start_url: browser.manifestStartUrl,
      scope: browser.manifestScope,
      icons,
    },
    null,
    2,
  )}\n`;
}

function assertRenderedManifest(source: string, origin: string, appBasePath: string): void {
  const value = JSON.parse(source) as unknown;
  if (!isRecord(value) || !Array.isArray(value.icons)) {
    throw new Error("Rendered PWA manifest is invalid.");
  }
  if (
    value.id !== `${origin}${appBasePath === "/" ? "/" : `${appBasePath}/`}` ||
    value.start_url !== `${origin}${naruAppPath(appBasePath, "/?source=pwa")}` ||
    value.scope !== `${origin}${appBasePath === "/" ? "/" : `${appBasePath}/`}`
  ) {
    throw new Error("Rendered PWA manifest identity is inconsistent with its canonical Origin.");
  }
  for (const icon of value.icons) {
    if (!isRecord(icon) || typeof icon.src !== "string") {
      throw new Error("Rendered PWA manifest contains an invalid icon.");
    }
    const iconUrl = new URL(icon.src);
    if (
      iconUrl.origin !== origin ||
      !iconUrl.pathname.startsWith(naruAppPath(appBasePath, "/icons/"))
    ) {
      throw new Error("Rendered PWA icon escaped the canonical Origin.");
    }
  }
}

function renderWebMetadata(source: string, origin: string, appBasePath: string): string {
  return renderAppBasePathMeta(renderOriginMeta(source, origin), appBasePath);
}

function renderOriginMeta(source: string, origin: string): string {
  const matches = [...source.matchAll(ORIGIN_META_PATTERN)];
  if (matches.length !== 1) {
    throw new Error("Base web index must contain exactly one Naru canonical Origin meta tag.");
  }
  ORIGIN_META_PATTERN.lastIndex = 0;
  return source.replace(
    ORIGIN_META_PATTERN,
    `<meta name="naru-canonical-origin" content="${escapeHtmlAttribute(origin)}" />`,
  );
}

function readOriginMeta(source: string): string {
  const matches = [...source.matchAll(ORIGIN_META_PATTERN)];
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error("Web index canonical Origin metadata is missing or ambiguous.");
  }
  ORIGIN_META_PATTERN.lastIndex = 0;
  return matches[0][1];
}

function renderAppBasePathMeta(source: string, appBasePath: string): string {
  const basePath = parseNaruAppBasePath(appBasePath);
  const matches = [...source.matchAll(APP_BASE_PATH_META_PATTERN)];
  if (matches.length !== 1) {
    throw new Error("Base web index must contain exactly one Naru app base path meta tag.");
  }
  APP_BASE_PATH_META_PATTERN.lastIndex = 0;
  return source.replace(
    APP_BASE_PATH_META_PATTERN,
    `<meta name="${NARU_APP_BASE_PATH_META_NAME}" content="${escapeHtmlAttribute(basePath)}" />`,
  );
}

function readAppBasePathMeta(source: string): string | null {
  const matches = [...source.matchAll(APP_BASE_PATH_META_PATTERN)];
  APP_BASE_PATH_META_PATTERN.lastIndex = 0;
  if (matches.length === 0) return null;
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error("Web index app base path metadata is ambiguous.");
  }
  return parseNaruAppBasePath(matches[0][1]);
}

function renderServiceWorker(
  source: string,
  manifest: string,
  index: string,
  input: RenderInstanceWebReleaseInput,
  sourceAppBasePath: string,
): { readonly source: string; readonly revision: string } {
  const previous = readServiceWorkerRevision(source);
  const previousBasePath = readServiceWorkerBasePath(source);
  if (previousBasePath !== sourceAppBasePath) {
    throw new Error("Base service worker app base path does not match web index metadata.");
  }
  const appBasePath = parseNaruAppBasePath(input.appBasePath);
  SERVICE_WORKER_BASE_PATH_PATTERN.lastIndex = 0;
  SERVICE_WORKER_BASE_PATH_COMMENT_PATTERN.lastIndex = 0;
  const commentMatches = [...source.matchAll(SERVICE_WORKER_BASE_PATH_COMMENT_PATTERN)];
  if (commentMatches.length !== 1) {
    throw new Error("Base service worker app base path comment is missing or ambiguous.");
  }
  SERVICE_WORKER_BASE_PATH_COMMENT_PATTERN.lastIndex = 0;
  const renderedBasePathSource = source
    .replace(
      SERVICE_WORKER_BASE_PATH_PATTERN,
      `const APP_BASE_PATH = ${JSON.stringify(appBasePath)};`,
    )
    .replace(SERVICE_WORKER_BASE_PATH_COMMENT_PATTERN, `Build app base path: ${appBasePath}`);
  const revision = createHash("sha256")
    .update(renderedBasePathSource)
    .update("\0")
    .update(manifest)
    .update("\0")
    .update(index)
    .update("\0")
    .update(input.browser.origin)
    .update("\0")
    .update(input.basePayloadDigest)
    .digest("hex")
    .slice(0, 20);
  const occurrences = renderedBasePathSource.split(previous).length - 1;
  if (occurrences < 2) {
    throw new Error("Base service worker revision is not present in its cache identity.");
  }
  return { source: renderedBasePathSource.replaceAll(previous, revision), revision };
}

function readServiceWorkerBasePath(source: string): string {
  const matches = [...source.matchAll(SERVICE_WORKER_BASE_PATH_PATTERN)];
  SERVICE_WORKER_BASE_PATH_PATTERN.lastIndex = 0;
  if (matches.length !== 1 || matches[0]?.[1] === undefined) {
    throw new Error("Service worker app base path marker is missing or ambiguous.");
  }
  return parseNaruAppBasePath(JSON.parse(matches[0][1]) as unknown);
}

function readServiceWorkerRevision(source: string): string {
  const match = SERVICE_WORKER_REVISION_PATTERN.exec(source);
  if (match?.[1] === undefined) {
    throw new Error("Service worker build revision marker is missing.");
  }
  return match[1];
}

function digestWebTree(root: string): string {
  const entries: { readonly path: string; readonly size: number; readonly sha256: string }[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("Web release contains a symbolic link.");
      if (metadata.isDirectory()) {
        visit(path);
        continue;
      }
      if (!metadata.isFile()) throw new Error("Web release contains a non-regular file.");
      const relativePath = relative(root, path).split(sep).join("/");
      if (relativePath === WEB_RELEASE_RECEIPT) continue;
      entries.push({
        path: relativePath,
        size: metadata.size,
        sha256: sha256(readFileSync(path)),
      });
    }
  };
  visit(root);
  return digestJson(entries.sort((left, right) => left.path.localeCompare(right.path)));
}

function parseWebReleaseReceipt(value: unknown): InstanceWebReleaseReceiptV1 {
  if (!isRecord(value)) throw new Error("Instance web release receipt must be an object.");
  const legacyKeys = [
    "version",
    "packageId",
    "buildId",
    "canonicalBrowserOrigin",
    "rpId",
    "basePayloadDigest",
    "manifestSha256",
    "serviceWorkerRevision",
    "contentDigest",
  ];
  const currentKeys = [...legacyKeys, "appBasePath"];
  const legacy = hasExactKeys(value, legacyKeys);
  if (!legacy && !hasExactKeys(value, currentKeys)) {
    throw new Error("Instance web release receipt fields are invalid.");
  }
  if (
    value.version !== DISTRIBUTION_SCHEMA_VERSION ||
    value.packageId !== WORKSTATION_PACKAGE_ID ||
    typeof value.buildId !== "string" ||
    typeof value.canonicalBrowserOrigin !== "string" ||
    typeof value.rpId !== "string" ||
    typeof value.basePayloadDigest !== "string" ||
    typeof value.manifestSha256 !== "string" ||
    typeof value.serviceWorkerRevision !== "string" ||
    typeof value.contentDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.basePayloadDigest) ||
    !/^[a-f0-9]{64}$/.test(value.manifestSha256) ||
    !/^[a-f0-9]{8,64}$/.test(value.serviceWorkerRevision) ||
    !/^[a-f0-9]{64}$/.test(value.contentDigest)
  ) {
    throw new Error("Instance web release receipt metadata is invalid.");
  }
  const origin = new URL(value.canonicalBrowserOrigin);
  if (origin.origin !== value.canonicalBrowserOrigin || origin.hostname !== value.rpId) {
    throw new Error("Instance web release Origin and RP ID are inconsistent.");
  }
  const appBasePath = legacy ? undefined : parseNaruAppBasePath(value.appBasePath);
  return {
    version: DISTRIBUTION_SCHEMA_VERSION,
    packageId: WORKSTATION_PACKAGE_ID,
    buildId: value.buildId,
    canonicalBrowserOrigin: value.canonicalBrowserOrigin,
    ...(appBasePath === undefined ? {} : { appBasePath }),
    rpId: value.rpId,
    basePayloadDigest: value.basePayloadDigest,
    manifestSha256: value.manifestSha256,
    serviceWorkerRevision: value.serviceWorkerRevision,
    contentDigest: value.contentDigest,
  };
}

function assertReceiptMatchesInput(
  receipt: InstanceWebReleaseReceiptV1,
  input: RenderInstanceWebReleaseInput,
): void {
  if (
    receipt.buildId !== input.buildId ||
    receipt.basePayloadDigest !== input.basePayloadDigest ||
    receipt.canonicalBrowserOrigin !== input.browser.origin ||
    receipt.rpId !== input.browser.rpId ||
    (receipt.appBasePath ?? "/") !== input.appBasePath
  ) {
    throw new Error("Immutable web release path already contains a different configuration.");
  }
}

function copyTree(sourceRoot: string, targetRoot: string): void {
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    const source = join(sourceRoot, entry.name);
    const target = join(targetRoot, entry.name);
    const metadata = lstatSync(source);
    if (metadata.isSymbolicLink()) throw new Error("Web release copy refused a symbolic link.");
    if (metadata.isDirectory()) {
      mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
      copyTree(source, target);
      continue;
    }
    if (!metadata.isFile()) throw new Error("Web release copy refused a non-regular file.");
    copyFileSync(source, target);
    chmodSync(target, (metadata.mode & 0o111) === 0 ? PRIVATE_FILE_MODE : PRIVATE_EXECUTABLE_MODE);
  }
}

function assertNoSymlinkTree(root: string): void {
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (metadata.isSymbolicLink()) throw new Error("Web release path contains a symbolic link.");
      if (metadata.isDirectory()) visit(path);
      else if (!metadata.isFile()) throw new Error("Web release path is not a regular file.");
    }
  };
  visit(root);
}

function assertRealDirectory(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error("Web release root must be a real directory.");
  }
}

function assertRegularFile(path: string): void {
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("Web release input must be a regular file.");
  }
}

function iconPathname(value: string): string {
  if (value.startsWith("/")) return new URL(value, "https://placeholder.invalid").pathname;
  const parsed = new URL(value);
  return parsed.pathname;
}

function escapeHtmlAttribute(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
