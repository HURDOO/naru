import { isIP } from "node:net";
import { createECDH, ECDH, timingSafeEqual } from "node:crypto";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { parseNaruAppBasePath } from "@naru/contracts/naru-app/v1";
import { loadGatewayVerifierKeys, type GatewayManagedAuthSettings } from "./gateway-auth.js";
import { validatePasswordHash } from "./password.js";

const EnvironmentSchema = z.enum(["development", "test", "production"]);
const AuthModeSchema = z.enum(["app-managed", "gateway-managed"]);
const SessionOwnerSchema = z.enum(["legacy", "durable-host"]);
const SafeIdentifierSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);
const SESSION_COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const DEFAULT_SESSION_COOKIE_NAMES = {
  development: "naru_dev_session",
  test: "naru_test_session",
  production: "naru_session",
} as const;
const SessionCookieNameSchema = z
  .string()
  .min(1)
  .max(128)
  .refine(
    (value) => SESSION_COOKIE_NAME_PATTERN.test(value),
    "Session cookie name must be a valid HTTP cookie token.",
  );
const SessionSecretSchema = z
  .string()
  .min(32)
  .max(4096)
  .refine((value) => value.trim() === value, "Session secret must not have surrounding space.")
  .refine(
    (value) => !/(?:replace|change-me|example)/i.test(value),
    "Session secret must not be a placeholder.",
  )
  .refine(
    (value) => new Set(value).size >= 12,
    "Session secret must contain enough distinct characters.",
  );

const RawConfigSchema = z.object({
  NODE_ENV: EnvironmentSchema.default("development"),
  NARU_AUTH_MODE: AuthModeSchema,
  NARU_HOST: z.string().default("127.0.0.1"),
  NARU_PORT: z.coerce.number().int().min(1).max(65535).default(4174),
  NARU_ALLOWED_ORIGINS: z.string().min(1),
  NARU_ALLOWED_CLIENT_IPS: z.string().optional(),
  NARU_PROJECT_ROOTS: z.string().min(1),
  NARU_EXACT_PROJECT_ROOTS: z.string().optional(),
  NARU_PASSWORD_HASH: z.string().min(1).optional(),
  NARU_SESSION_SECRET: SessionSecretSchema.optional(),
  NARU_SESSION_COOKIE_NAME: SessionCookieNameSchema.optional(),
  NARU_GATEWAY_INSTANCE_ID: SafeIdentifierSchema.optional(),
  NARU_GATEWAY_APP_ID: SafeIdentifierSchema.optional(),
  NARU_GATEWAY_OWNER_SUBJECT: SafeIdentifierSchema.optional(),
  NARU_GATEWAY_VERIFIER_KEYS_FILE: z.string().min(1).optional(),
  NARU_DATA_DIR: z.string().default(".local"),
  NARU_WEB_DIST: z.string().optional(),
  NARU_APP_BASE_PATH: z.string().default("/"),
  NARU_CODEX_PATH: z.string().min(1).optional(),
  NARU_CLAUDE_PATH: z.string().min(1).optional(),
  NARU_DEFAULT_AGENT_PANE_KIND: z.enum(["codex", "claude"]).default("codex"),
  /** Agent Platform (docs/agent-platform-v0) is off unless explicitly enabled. */
  NARU_AGENT_PLATFORM: z.enum(["0", "1"]).default("0"),
  /** User-installed Claude Agent SDK entry (AP-D012); managed Claude agents need it. */
  NARU_CLAUDE_AGENT_SDK_PATH: z.string().min(1).optional(),
  /** AP-D005 hold auto-return; operating values are decided last (AP-D007). */
  NARU_AGENT_HOLD_IDLE_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(24 * 60 * 60_000)
    .default(30 * 60_000),
  NARU_AGENT_HOLD_DISCONNECT_MS: z.coerce
    .number()
    .int()
    .min(10_000)
    .max(24 * 60 * 60_000)
    .default(5 * 60_000),
  NARU_CODEX_INTEGRATION_SOCKET_PATH: z.string().min(1).optional(),
  NARU_TLS_STATE_DIR: z.string().min(1).optional(),
  NARU_TLS_RELOAD_INTERVAL_MS: z.coerce.number().int().min(1_000).max(300_000).optional(),
  NARU_VAPID_PUBLIC_KEY: z.string().min(1).optional(),
  NARU_VAPID_PRIVATE_KEY: z.string().min(1).optional(),
  NARU_VAPID_SUBJECT: z.string().min(1).optional(),
  NARU_SESSION_OWNER: SessionOwnerSchema.default("legacy"),
  NARU_DURABLE_SESSION_SOCKET_PATH: z.string().min(1).optional(),
  NARU_DURABLE_SESSION_CREDENTIAL_FILE: z.string().min(1).optional(),
  NARU_DURABLE_SESSION_APP_ID: SafeIdentifierSchema.optional(),
  NARU_DURABLE_SESSION_SUBJECT: SafeIdentifierSchema.optional(),
  NARU_DURABLE_SESSION_CALLER_TTL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60_000)
    .optional(),
  NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: z.coerce
    .number()
    .int()
    .min(1_000)
    .max(24 * 60 * 60_000)
    .optional(),
  NARU_DURABLE_SESSION_PROFILE_IDS: z.string().min(1).optional(),
  NARU_DURABLE_SESSION_ROOTS: z.string().min(1).optional(),
});

export interface TlsConfig {
  stateDirectory: string;
  serverNames: readonly string[];
  reloadIntervalMs: number;
}

export interface PushConfig {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export interface DurableSessionRootConfig {
  readonly rootId: string;
  readonly path: string;
}

export type SessionRuntimeConfig =
  | { readonly owner: "legacy" }
  | {
      readonly owner: "durable-host";
      readonly socketPath: string;
      readonly credentialFile: string;
      readonly appId: string;
      readonly subject: string;
      readonly callerTtlMs: number;
      readonly idempotencyTtlMs: number;
      readonly profileIds: readonly string[];
      readonly roots: readonly DurableSessionRootConfig[];
    };

interface AppConfigBase {
  environment: z.infer<typeof EnvironmentSchema>;
  host: string;
  port: number;
  allowedOrigins: ReadonlySet<string>;
  allowedClientIps?: ReadonlySet<string>;
  projectRoots: readonly string[];
  exactProjectRoots?: readonly string[];
  dataDir: string;
  webDist?: string;
  appBasePath: string;
  codexExecutable?: string;
  claudeExecutable?: string;
  defaultAgentPaneKind?: "codex" | "claude";
  agentPlatform?: boolean;
  claudeAgentSdkPath?: string;
  agentHoldTimeouts?: { readonly idleMs: number; readonly disconnectMs: number };
  codexIntegrationSocketPath?: string;
  tls?: TlsConfig;
  push?: PushConfig;
  sessionRuntime?: SessionRuntimeConfig;
}

export interface AppManagedConfig extends AppConfigBase {
  readonly authMode: "app-managed";
  readonly passwordHash: string;
  readonly sessionSecret: string;
  readonly sessionCookieName: string;
  readonly secureCookie: boolean;
}

export interface GatewayManagedConfig extends AppConfigBase {
  readonly authMode: "gateway-managed";
  readonly gatewayAuth: GatewayManagedAuthSettings;
  readonly secureCookie: false;
}

export type AppConfig = AppManagedConfig | GatewayManagedConfig;

export function loadConfig(
  environment: NodeJS.ProcessEnv = process.env,
  baseDirectory = process.cwd(),
): AppConfig {
  const raw = RawConfigSchema.parse(environment);
  validateHost(raw.NARU_HOST);

  const originValues = raw.NARU_ALLOWED_ORIGINS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map(normalizeOrigin);

  if (originValues.length === 0) {
    throw new Error("NARU_ALLOWED_ORIGINS must contain at least one exact origin.");
  }
  const originProtocols = new Set(originValues.map((origin) => new URL(origin).protocol));
  if (originProtocols.size !== 1) {
    throw new Error("NARU_ALLOWED_ORIGINS must not mix HTTP and HTTPS origins.");
  }
  const usesHttpsOrigin = originProtocols.has("https:");
  const tls = parseTlsConfig(
    raw,
    originValues,
    raw.NARU_AUTH_MODE === "app-managed" && usesHttpsOrigin,
    baseDirectory,
  );
  const push = parsePushConfig(raw);

  if (
    raw.NARU_AUTH_MODE === "gateway-managed" &&
    (raw.NARU_HOST !== "127.0.0.1" || raw.NARU_ALLOWED_CLIENT_IPS !== undefined)
  ) {
    throw new Error(
      "gateway-managed Naru requires exact loopback NARU_HOST=127.0.0.1 and no client IP allowlist.",
    );
  }
  const allowedClientIps = parseAllowedClientIps(raw.NARU_ALLOWED_CLIENT_IPS);
  if (!isLoopbackHost(raw.NARU_HOST) && allowedClientIps === undefined) {
    throw new Error("NARU_ALLOWED_CLIENT_IPS is required for a LAN bind.");
  }

  const projectRoots = raw.NARU_PROJECT_ROOTS.split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => resolve(baseDirectory, value));

  if (projectRoots.length === 0) {
    throw new Error("NARU_PROJECT_ROOTS must contain at least one directory.");
  }
  const exactProjectRoots = parseExactProjectRoots(raw.NARU_EXACT_PROJECT_ROOTS, projectRoots);
  const sessionRuntime = parseSessionRuntime(raw, projectRoots, baseDirectory);
  if (raw.NARU_DEFAULT_AGENT_PANE_KIND === "claude" && raw.NARU_CLAUDE_PATH === undefined) {
    throw new Error("Claude default Pane requires NARU_CLAUDE_PATH.");
  }
  const codexIntegrationSocketPath = parseCodexIntegrationSocketPath(
    raw.NARU_CODEX_INTEGRATION_SOCKET_PATH,
    sessionRuntime,
  );
  const common: AppConfigBase = {
    environment: raw.NODE_ENV,
    host: raw.NARU_HOST,
    port: raw.NARU_PORT,
    allowedOrigins: new Set(originValues),
    ...(allowedClientIps === undefined ? {} : { allowedClientIps }),
    projectRoots,
    ...(exactProjectRoots === undefined ? {} : { exactProjectRoots }),
    dataDir: resolve(baseDirectory, raw.NARU_DATA_DIR),
    ...(raw.NARU_WEB_DIST === undefined
      ? {}
      : { webDist: resolve(baseDirectory, raw.NARU_WEB_DIST) }),
    appBasePath: parseNaruAppBasePath(raw.NARU_APP_BASE_PATH),
    defaultAgentPaneKind: raw.NARU_DEFAULT_AGENT_PANE_KIND,
    agentPlatform: raw.NARU_AGENT_PLATFORM === "1",
    agentHoldTimeouts: {
      idleMs: raw.NARU_AGENT_HOLD_IDLE_MS,
      disconnectMs: raw.NARU_AGENT_HOLD_DISCONNECT_MS,
    },
    ...(raw.NARU_CLAUDE_AGENT_SDK_PATH === undefined
      ? {}
      : {
          claudeAgentSdkPath: validateExecutablePath(
            raw.NARU_CLAUDE_AGENT_SDK_PATH,
            "NARU_CLAUDE_AGENT_SDK_PATH",
          ),
        }),
    ...(raw.NARU_CODEX_PATH === undefined
      ? {}
      : { codexExecutable: validateExecutablePath(raw.NARU_CODEX_PATH, "NARU_CODEX_PATH") }),
    ...(raw.NARU_CLAUDE_PATH === undefined
      ? {}
      : { claudeExecutable: validateExecutablePath(raw.NARU_CLAUDE_PATH, "NARU_CLAUDE_PATH") }),
    ...(codexIntegrationSocketPath === undefined ? {} : { codexIntegrationSocketPath }),
    ...(tls === undefined ? {} : { tls }),
    ...(push === undefined ? {} : { push }),
    sessionRuntime,
  };

  const gatewayValues = [
    raw.NARU_GATEWAY_INSTANCE_ID,
    raw.NARU_GATEWAY_APP_ID,
    raw.NARU_GATEWAY_OWNER_SUBJECT,
    raw.NARU_GATEWAY_VERIFIER_KEYS_FILE,
  ];
  if (raw.NARU_AUTH_MODE === "app-managed") {
    if (common.appBasePath !== "/") {
      throw new Error(
        "Non-root NARU_APP_BASE_PATH requires NARU_AUTH_MODE=gateway-managed path stripping.",
      );
    }
    if (gatewayValues.some((value) => value !== undefined)) {
      throw new Error("NARU_GATEWAY_* settings require NARU_AUTH_MODE=gateway-managed.");
    }
    if (raw.NARU_PASSWORD_HASH === undefined || raw.NARU_SESSION_SECRET === undefined) {
      throw new Error(
        "NARU_PASSWORD_HASH and NARU_SESSION_SECRET are required in app-managed mode.",
      );
    }
    validatePasswordHash(raw.NARU_PASSWORD_HASH);
    const sessionCookieName =
      raw.NARU_SESSION_COOKIE_NAME ?? DEFAULT_SESSION_COOKIE_NAMES[raw.NODE_ENV];
    if (
      !usesHttpsOrigin &&
      (sessionCookieName.startsWith("__Secure-") || sessionCookieName.startsWith("__Host-"))
    ) {
      throw new Error(
        "NARU_SESSION_COOKIE_NAME with a __Secure- or __Host- prefix requires HTTPS Origins.",
      );
    }
    return {
      ...common,
      authMode: "app-managed",
      passwordHash: raw.NARU_PASSWORD_HASH,
      sessionSecret: raw.NARU_SESSION_SECRET,
      sessionCookieName,
      secureCookie: usesHttpsOrigin,
    };
  }

  if (
    raw.NARU_PASSWORD_HASH !== undefined ||
    raw.NARU_SESSION_SECRET !== undefined ||
    raw.NARU_SESSION_COOKIE_NAME !== undefined
  ) {
    throw new Error(
      "NARU_PASSWORD_HASH, NARU_SESSION_SECRET, and NARU_SESSION_COOKIE_NAME are forbidden in gateway-managed mode.",
    );
  }
  if (!usesHttpsOrigin || originValues.length !== 1) {
    throw new Error("gateway-managed Naru requires one exact external HTTPS Origin.");
  }
  if (gatewayValues.some((value) => value === undefined)) {
    throw new Error(
      "gateway-managed Naru requires Gateway instance ID, app ID, owner subject, and verifier keys file.",
    );
  }
  if (sessionRuntime.owner !== "durable-host") {
    throw new Error("gateway-managed Naru requires NARU_SESSION_OWNER=durable-host.");
  }
  if (
    sessionRuntime.appId !== raw.NARU_GATEWAY_APP_ID ||
    sessionRuntime.subject !== raw.NARU_GATEWAY_OWNER_SUBJECT
  ) {
    throw new Error(
      "Gateway app ID and owner subject must match the Durable Host caller registration.",
    );
  }
  const verifierKeysFile = raw.NARU_GATEWAY_VERIFIER_KEYS_FILE as string;
  return {
    ...common,
    authMode: "gateway-managed",
    gatewayAuth: {
      issuer: raw.NARU_GATEWAY_INSTANCE_ID as string,
      audience: raw.NARU_GATEWAY_APP_ID,
      ownerSubject: raw.NARU_GATEWAY_OWNER_SUBJECT,
      origin: originValues[0] as string,
      verifierKeysFile,
      verifierKeys: loadGatewayVerifierKeys(verifierKeysFile),
    },
    secureCookie: false,
  };
}

function parseExactProjectRoots(
  source: string | undefined,
  projectRoots: readonly string[],
): readonly string[] | undefined {
  if (source === undefined) return undefined;
  if (source.length > 64 * 1024) {
    throw new Error("NARU_EXACT_PROJECT_ROOTS exceeds the size limit.");
  }
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error("NARU_EXACT_PROJECT_ROOTS must be a JSON array.");
  }
  if (!Array.isArray(value) || value.length === 0 || value.length > 64) {
    throw new Error("NARU_EXACT_PROJECT_ROOTS must contain 1–64 paths.");
  }
  const allowed = new Set(projectRoots);
  const exact = value.map((path: unknown) => {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      resolve(path) !== path ||
      path.length > 4_096 ||
      /[\0\r\n]/.test(path) ||
      !allowed.has(path)
    ) {
      throw new Error("NARU_EXACT_PROJECT_ROOTS must name exact configured Project roots.");
    }
    return path;
  });
  if (new Set(exact).size !== exact.length) {
    throw new Error("NARU_EXACT_PROJECT_ROOTS must be unique.");
  }
  return exact;
}

function parseCodexIntegrationSocketPath(
  value: string | undefined,
  sessionRuntime: SessionRuntimeConfig,
): string | undefined {
  if (value === undefined) return undefined;
  if (sessionRuntime.owner !== "durable-host") {
    throw new Error("NARU_CODEX_INTEGRATION_SOCKET_PATH requires NARU_SESSION_OWNER=durable-host.");
  }
  if (!isAbsolute(value) || resolve(value) !== value || value === sep || /[\0\r\n]/.test(value)) {
    throw new Error("NARU_CODEX_INTEGRATION_SOCKET_PATH must be an exact absolute path.");
  }
  if (Buffer.byteLength(value) > 100) {
    throw new Error("NARU_CODEX_INTEGRATION_SOCKET_PATH exceeds the safe Unix socket limit.");
  }
  return value;
}

function parseSessionRuntime(
  raw: z.infer<typeof RawConfigSchema>,
  projectRoots: readonly string[],
  baseDirectory: string,
): SessionRuntimeConfig {
  const durableValues = [
    raw.NARU_DURABLE_SESSION_SOCKET_PATH,
    raw.NARU_DURABLE_SESSION_CREDENTIAL_FILE,
    raw.NARU_DURABLE_SESSION_APP_ID,
    raw.NARU_DURABLE_SESSION_SUBJECT,
    raw.NARU_DURABLE_SESSION_CALLER_TTL_MS,
    raw.NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS,
    raw.NARU_DURABLE_SESSION_PROFILE_IDS,
    raw.NARU_DURABLE_SESSION_ROOTS,
  ];
  if (raw.NARU_SESSION_OWNER === "legacy") {
    if (durableValues.some((value) => value !== undefined)) {
      throw new Error(
        "NARU_DURABLE_SESSION_* requires NARU_SESSION_OWNER=durable-host; mixed ownership is not allowed.",
      );
    }
    return { owner: "legacy" };
  }

  if (
    raw.NARU_DURABLE_SESSION_SOCKET_PATH === undefined ||
    raw.NARU_DURABLE_SESSION_CREDENTIAL_FILE === undefined ||
    raw.NARU_DURABLE_SESSION_APP_ID === undefined ||
    raw.NARU_DURABLE_SESSION_SUBJECT === undefined ||
    raw.NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS === undefined ||
    raw.NARU_DURABLE_SESSION_PROFILE_IDS === undefined ||
    raw.NARU_DURABLE_SESSION_ROOTS === undefined
  ) {
    throw new Error(
      "Durable Host ownership requires socket path, credential file, app ID, subject, idempotency TTL, profile IDs, and root mapping.",
    );
  }
  const socketPath = resolve(baseDirectory, raw.NARU_DURABLE_SESSION_SOCKET_PATH);
  if (Buffer.byteLength(socketPath) > 103) {
    throw new Error("NARU_DURABLE_SESSION_SOCKET_PATH exceeds the macOS Unix socket limit.");
  }
  const roots = parseDurableSessionRoots(raw.NARU_DURABLE_SESSION_ROOTS, baseDirectory);
  const profileIds = parseDurableSessionProfileIds(raw.NARU_DURABLE_SESSION_PROFILE_IDS);
  const configuredPaths = new Set(roots.map((root) => root.path));
  if (
    configuredPaths.size !== projectRoots.length ||
    projectRoots.some((root) => !configuredPaths.has(root))
  ) {
    throw new Error(
      "NARU_DURABLE_SESSION_ROOTS must map every exact NARU_PROJECT_ROOTS path once.",
    );
  }
  return {
    owner: "durable-host",
    socketPath,
    credentialFile: resolve(baseDirectory, raw.NARU_DURABLE_SESSION_CREDENTIAL_FILE),
    appId: raw.NARU_DURABLE_SESSION_APP_ID,
    subject: raw.NARU_DURABLE_SESSION_SUBJECT,
    callerTtlMs: raw.NARU_DURABLE_SESSION_CALLER_TTL_MS ?? 60_000,
    idempotencyTtlMs: raw.NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS,
    profileIds,
    roots,
  };
}

function parseDurableSessionProfileIds(source: string): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("NARU_DURABLE_SESSION_PROFILE_IDS must be a JSON array of profile IDs.");
  }
  const profileIds = z.array(SafeIdentifierSchema).min(1).max(64).parse(value);
  if (new Set(profileIds).size !== profileIds.length) {
    throw new Error("NARU_DURABLE_SESSION_PROFILE_IDS must contain unique profile IDs.");
  }
  return profileIds;
}

function parseDurableSessionRoots(
  source: string,
  baseDirectory: string,
): readonly DurableSessionRootConfig[] {
  let value: unknown;
  try {
    value = JSON.parse(source) as unknown;
  } catch {
    throw new Error("NARU_DURABLE_SESSION_ROOTS must be a JSON object of root ID to path.");
  }
  const parsed = z.record(SafeIdentifierSchema, z.string().min(1)).parse(value);
  const roots = Object.entries(parsed).map(([rootId, path]) => ({
    rootId,
    path: resolve(baseDirectory, path),
  }));
  if (roots.length === 0 || new Set(roots.map((root) => root.path)).size !== roots.length) {
    throw new Error("NARU_DURABLE_SESSION_ROOTS must contain unique paths.");
  }
  return roots;
}

function parsePushConfig(raw: z.infer<typeof RawConfigSchema>): PushConfig | undefined {
  const values = [raw.NARU_VAPID_PUBLIC_KEY, raw.NARU_VAPID_PRIVATE_KEY, raw.NARU_VAPID_SUBJECT];
  if (values.every((value) => value === undefined)) return undefined;
  if (values.some((value) => value === undefined)) {
    throw new Error(
      "NARU_VAPID_PUBLIC_KEY, NARU_VAPID_PRIVATE_KEY, and NARU_VAPID_SUBJECT must be configured together.",
    );
  }

  const publicKey = validateBase64UrlKey(raw.NARU_VAPID_PUBLIC_KEY as string, 65, "public");
  const privateKey = validateBase64UrlKey(raw.NARU_VAPID_PRIVATE_KEY as string, 32, "private");
  validateVapidKeyPair(publicKey, privateKey);
  const subject = raw.NARU_VAPID_SUBJECT as string;
  let subjectUrl: URL;
  try {
    subjectUrl = new URL(subject);
  } catch {
    throw new Error("NARU_VAPID_SUBJECT must be an HTTPS or mailto URI.");
  }
  if (subjectUrl.protocol !== "https:" && subjectUrl.protocol !== "mailto:") {
    throw new Error("NARU_VAPID_SUBJECT must be an HTTPS or mailto URI.");
  }
  return { publicKey, privateKey, subject };
}

function validateVapidKeyPair(publicKey: string, privateKey: string): void {
  const publicBytes = Buffer.from(publicKey, "base64url");
  if (publicBytes[0] !== 0x04) {
    throw new Error("NARU_VAPID_PUBLIC_KEY must be an uncompressed P-256 public key.");
  }
  try {
    ECDH.convertKey(publicBytes, "prime256v1", undefined, undefined, "uncompressed");
    const privateValidator = createECDH("prime256v1");
    privateValidator.setPrivateKey(Buffer.from(privateKey, "base64url"));
    if (!timingSafeEqual(privateValidator.getPublicKey(), publicBytes)) {
      throw new Error("mismatched VAPID key pair");
    }
  } catch {
    throw new Error(
      "NARU_VAPID_PUBLIC_KEY and NARU_VAPID_PRIVATE_KEY must be a matching P-256 key pair.",
    );
  }
}

function validateBase64UrlKey(value: string, byteLength: number, label: string): string {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error(`NARU_VAPID_${label.toUpperCase()}_KEY must use URL-safe base64.`);
  }
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== byteLength || decoded.toString("base64url") !== value) {
    throw new Error(`NARU_VAPID_${label.toUpperCase()}_KEY has an invalid length or encoding.`);
  }
  return value;
}

function parseTlsConfig(
  raw: z.infer<typeof RawConfigSchema>,
  originValues: readonly string[],
  tlsRequired: boolean,
  baseDirectory: string,
): TlsConfig | undefined {
  if (!tlsRequired) {
    if (raw.NARU_TLS_STATE_DIR !== undefined || raw.NARU_TLS_RELOAD_INTERVAL_MS !== undefined) {
      throw new Error(
        raw.NARU_AUTH_MODE === "gateway-managed"
          ? "NARU_TLS_* settings are forbidden on the gateway-managed loopback upstream."
          : "NARU_TLS_* settings require an all-HTTPS Origin configuration.",
      );
    }
    return undefined;
  }
  if (raw.NARU_TLS_STATE_DIR === undefined) {
    throw new Error("NARU_TLS_STATE_DIR is required for an HTTPS Origin configuration.");
  }
  if (!isAbsolute(raw.NARU_TLS_STATE_DIR)) {
    throw new Error("NARU_TLS_STATE_DIR must be an absolute path outside the repository.");
  }
  const repositoryRelativePath = relative(resolve(baseDirectory), resolve(raw.NARU_TLS_STATE_DIR));
  if (
    repositoryRelativePath === "" ||
    (repositoryRelativePath !== ".." &&
      !repositoryRelativePath.startsWith(`..${sep}`) &&
      !isAbsolute(repositoryRelativePath))
  ) {
    throw new Error("NARU_TLS_STATE_DIR must be an absolute path outside the repository.");
  }

  const serverNames = [...new Set(originValues.map((origin) => new URL(origin).hostname))];
  for (const serverName of serverNames) {
    if (isIP(serverName) !== 0) {
      throw new Error("HTTPS Origins must use DNS hostnames covered by the TLS certificate.");
    }
  }
  return {
    stateDirectory: raw.NARU_TLS_STATE_DIR,
    serverNames,
    reloadIntervalMs: raw.NARU_TLS_RELOAD_INTERVAL_MS ?? 10_000,
  };
}

function validateExecutablePath(value: string, name: string): string {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
  return value;
}

function validateHost(host: string): void {
  if (isLoopbackHost(host)) return;
  if (host === "0.0.0.0" || host === "::") {
    throw new Error("Naru refuses wildcard network binds. Choose loopback or a LAN address.");
  }
  if (isIP(host) !== 4) {
    throw new Error("NARU_HOST must be loopback or an IPv4 address in the public fixture subnet.");
  }

  const octets = host.split(".").map(Number);
  const last = octets[3];
  if (
    octets[0] !== 10 ||
    octets[1] !== 23 ||
    octets[2] !== 45 ||
    last === undefined ||
    last < 1 ||
    last > 254
  ) {
    throw new Error("NARU_HOST must be loopback or an IPv4 address in 10.23.45.0/24.");
  }
}

export function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "::1";
}

export function isValidSessionCookieName(value: string): boolean {
  return value.length >= 1 && value.length <= 128 && SESSION_COOKIE_NAME_PATTERN.test(value);
}

export function normalizeClientIp(value: string): string {
  const mappedIpv4 = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  return isIP(mappedIpv4) === 4 ? mappedIpv4 : value;
}

function parseAllowedClientIps(value: string | undefined): ReadonlySet<string> | undefined {
  if (value === undefined) return undefined;
  const entries = value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map(normalizeClientIp);
  if (entries.length === 0) {
    throw new Error("NARU_ALLOWED_CLIENT_IPS must contain at least one exact IP address.");
  }
  for (const entry of entries) {
    if (isIP(entry) === 0) {
      throw new Error("NARU_ALLOWED_CLIENT_IPS only accepts exact IP addresses, not CIDR ranges.");
    }
  }
  return new Set(entries);
}

function normalizeOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("NARU_ALLOWED_ORIGINS only accepts http:// or https:// origins.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("NARU_ALLOWED_ORIGINS entries must be exact origins without paths.");
  }
  return url.origin;
}
