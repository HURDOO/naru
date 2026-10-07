/** Isolated, owner-only 9443 acceptance server. This is not a Workstation deployment path. */
import { accessSync, constants, existsSync, lstatSync, realpathSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { ServerOptions } from "node:https";
import {
  LastKnownGoodTlsMaterialManager,
  validateTlsMaterial,
  type TlsMaterialSource,
  type TlsMaterialReference,
} from "../../packages/tls-material/src/index.js";
import {
  PrivateIngressExactHttpsOriginSchema,
  PrivateIngressSourcePolicyV0Schema,
  PrivateIpv4AddressSchema,
  type PrivateIngressSourcePolicyV0,
} from "../../packages/contracts/src/private-ingress/v0/index.js";
import { buildApp } from "../../apps/server/src/app.js";
import type { AppManagedConfig } from "../../apps/server/src/config.js";
import { NaruRepository } from "../../apps/server/src/database.js";
import { LaunchProfileRegistry } from "../../apps/server/src/launch-profiles.js";
import { ProjectPathPolicy } from "../../apps/server/src/path-policy.js";
import { PtySupervisor } from "../../apps/server/src/pty.js";
import { validatePasswordHash } from "../../apps/server/src/password.js";
import type {
  TlsCertificateEvent,
  TlsCertificateService,
  TlsCertificateStatus,
} from "../../apps/server/src/tls-certificate.js";
import {
  assertActiveLocalPrivateIpv4,
  installTlsAvailabilityGuard,
} from "../../apps/workstation-gateway/src/listeners/direct-private-tls.js";
import {
  installPrivateIpv4SourceAdmission,
  PrivateIpv4SourceAdmission,
} from "../../apps/workstation-gateway/src/listeners/source-policy.js";
import {
  assertNoSymlinkComponents,
  inspectExecutable,
  readPrivateJson,
} from "../workstation/distribution/security.js";

const TEST_PORT = 9443;
const TEST_ROOT_PREFIX = "/private/tmp/naru-claude-9443.";
const TEST_COOKIE_NAME = "naru_claude_9443_session";

interface TestSettings {
  readonly browserOrigin: string;
  readonly listenerHost: string;
  readonly sourcePolicy: PrivateIngressSourcePolicyV0;
  readonly tls: TlsMaterialReference;
  readonly passwordHash: string;
  readonly sessionSecret: string;
  readonly claudeExecutable: string;
  readonly codexExecutable?: string;
  readonly exactProjectRoot?: string;
  readonly worktreeRoots?: readonly [string, string];
}

export function parseSettings(value: unknown): TestSettings {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid test server settings.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) =>
        ![
          "browserOrigin",
          "listenerHost",
          "sourcePolicy",
          "tls",
          "passwordHash",
          "sessionSecret",
          "claudeExecutable",
          "codexExecutable",
          "exactProjectRoot",
          "worktreeRoots",
        ].includes(key),
    ) ||
    typeof record.passwordHash !== "string" ||
    typeof record.sessionSecret !== "string" ||
    record.sessionSecret.length < 32 ||
    typeof record.claudeExecutable !== "string" ||
    record.claudeExecutable.length === 0 ||
    (record.codexExecutable !== undefined &&
      (typeof record.codexExecutable !== "string" || record.codexExecutable.length === 0)) ||
    (record.exactProjectRoot !== undefined &&
      (typeof record.exactProjectRoot !== "string" || record.exactProjectRoot.length === 0)) ||
    (record.worktreeRoots !== undefined &&
      (record.exactProjectRoot === undefined || !isWorktreeRoots(record.worktreeRoots)))
  ) {
    throw new Error("Invalid test server settings.");
  }
  const browserOrigin = PrivateIngressExactHttpsOriginSchema.parse(record.browserOrigin);
  const listenerHost = PrivateIpv4AddressSchema.parse(record.listenerHost);
  const sourcePolicy = PrivateIngressSourcePolicyV0Schema.parse(record.sourcePolicy);
  const worktreeRoots = isWorktreeRoots(record.worktreeRoots) ? record.worktreeRoots : undefined;
  if (record.tls === null || typeof record.tls !== "object" || Array.isArray(record.tls)) {
    throw new Error("Invalid test TLS reference.");
  }
  const tlsRecord = record.tls as Record<string, unknown>;
  if (
    Object.keys(tlsRecord).some(
      (key) =>
        ![
          "approvedRoot",
          "certificateFile",
          "privateKeyFile",
          "serverNames",
          "allowSymlinkReferences",
        ].includes(key),
    ) ||
    typeof tlsRecord.approvedRoot !== "string" ||
    typeof tlsRecord.certificateFile !== "string" ||
    typeof tlsRecord.privateKeyFile !== "string" ||
    !Array.isArray(tlsRecord.serverNames) ||
    tlsRecord.serverNames.length !== 1 ||
    tlsRecord.serverNames[0] !== new URL(browserOrigin).hostname ||
    tlsRecord.allowSymlinkReferences !== true
  ) {
    throw new Error("Invalid test TLS reference.");
  }
  return {
    browserOrigin,
    listenerHost,
    sourcePolicy,
    tls: {
      approvedRoot: tlsRecord.approvedRoot,
      certificateFile: tlsRecord.certificateFile,
      privateKeyFile: tlsRecord.privateKeyFile,
      serverNames: [tlsRecord.serverNames[0]],
      allowSymlinkReferences: true,
    },
    passwordHash: record.passwordHash,
    sessionSecret: record.sessionSecret,
    claudeExecutable: record.claudeExecutable,
    ...(record.codexExecutable === undefined ? {} : { codexExecutable: record.codexExecutable }),
    ...(record.exactProjectRoot === undefined ? {} : { exactProjectRoot: record.exactProjectRoot }),
    ...(worktreeRoots === undefined ? {} : { worktreeRoots }),
  };
}

function isWorktreeRoots(value: unknown): value is readonly [string, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((path: unknown) => typeof path === "string" && path.length > 0)
  );
}

export function loadTestServerSettings(root: string): {
  readonly settings: TestSettings;
  readonly config: AppManagedConfig;
} {
  assertOwnerOnlyTestRoot(root);
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("A user-owned test root is required.");
  const settings = parseSettings(readPrivateJson(join(root, "settings.json"), uid));
  if (settings.sourcePolicy.allowedCidrs.length !== 0) {
    throw new Error("The password test ingress requires exact source addresses, not CIDRs.");
  }
  const origin = new URL(settings.browserOrigin);
  if (origin.port !== String(TEST_PORT)) throw new Error("Test Origin and listener port differ.");
  assertActiveLocalPrivateIpv4(settings.listenerHost, networkInterfaces());
  validatePasswordHash(settings.passwordHash);
  inspectExecutable(settings.claudeExecutable);
  if (settings.codexExecutable !== undefined) inspectExecutable(settings.codexExecutable);
  const dataDir = requireChildDirectory(root, "data", uid);
  const projectRoot = requireChildDirectory(root, "projects", uid);
  const exactProjectRoot =
    settings.exactProjectRoot === undefined
      ? undefined
      : requireExactProjectRoot(settings.exactProjectRoot, uid);
  const worktreeRoots =
    settings.worktreeRoots === undefined
      ? []
      : requireConfiguredWorktreeRoots(exactProjectRoot!, settings.worktreeRoots, uid);
  const webDist = requireChildDirectory(root, "web-dist", uid);
  if (!existsSync(join(webDist, "index.html"))) throw new Error("Test web build is missing.");
  const config: AppManagedConfig = {
    environment: "test",
    authMode: "app-managed",
    host: settings.listenerHost,
    port: TEST_PORT,
    allowedOrigins: new Set([settings.browserOrigin]),
    allowedClientIps: new Set(settings.sourcePolicy.allowedAddresses),
    projectRoots: [
      projectRoot,
      ...(exactProjectRoot === undefined ? [] : [exactProjectRoot]),
      ...worktreeRoots,
    ],
    dataDir,
    webDist,
    appBasePath: "/",
    passwordHash: settings.passwordHash,
    sessionSecret: settings.sessionSecret,
    sessionCookieName: TEST_COOKIE_NAME,
    secureCookie: true,
    claudeExecutable: settings.claudeExecutable,
    ...(settings.codexExecutable === undefined
      ? {}
      : { codexExecutable: settings.codexExecutable }),
    tls: {
      stateDirectory: root,
      serverNames: [origin.hostname],
      reloadIntervalMs: 10_000,
    },
    sessionRuntime: { owner: "legacy" },
  };
  return { settings, config };
}

class ExternalTestTls implements TlsCertificateService {
  readonly #provider: LastKnownGoodTlsMaterialManager;

  constructor(reference: TlsMaterialReference) {
    const source: TlsMaterialSource = {
      load: (now) => validateTlsMaterial(reference, { now }),
      watch: (onChange) => {
        const timer = setInterval(onChange, 10_000);
        timer.unref();
        return { close: () => clearInterval(timer) };
      },
    };
    this.#provider = new LastKnownGoodTlsMaterialManager(source);
  }

  loadInitial(): ServerOptions {
    return {
      ...this.#provider.loadInitial(),
      minVersion: "TLSv1.2",
      maxHeaderSize: 16 * 1024,
      headersTimeout: 5_000,
      requestTimeout: 30_000,
      keepAliveTimeout: 5_000,
    };
  }

  start(server: unknown): void {
    this.#provider.start(server);
  }

  stop(): void {
    this.#provider.stop();
  }

  status(): TlsCertificateStatus {
    const status = this.#provider.status();
    return {
      status: status.status,
      lastReload: status.lastReload,
      ...(status.expiresAt === undefined ? {} : { expiresAt: status.expiresAt }),
      ...(status.fingerprint256 === undefined ? {} : { fingerprint256: status.fingerprint256 }),
      ...(status.lastReloadAt === undefined ? {} : { lastReloadAt: status.lastReloadAt }),
      ...(status.lastReloadErrorCode === undefined
        ? {}
        : { lastReloadErrorCode: "TLS_RELOAD_FAILED" }),
    };
  }

  setEventSink(eventSink: (event: TlsCertificateEvent) => void): void {
    // The test-only provider already exposes redacted readiness; never log material references.
    void eventSink;
  }

  acceptsNewConnections(): boolean {
    return this.#provider.acceptsNewConnections();
  }
}

export function assertOwnerOnlyTestRoot(root: string): void {
  if (!isAbsolute(root) || !root.startsWith(TEST_ROOT_PREFIX)) {
    throw new Error("Refusing to use a non-isolated test root.");
  }
  assertNoSymlinkComponents(root);
  if (realpathSync(root) !== root) throw new Error("Test root must be canonical.");
  const metadata = lstatSync(root);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== process.getuid?.() ||
    (metadata.mode & 0o777) !== 0o700
  ) {
    throw new Error("Test root must be an owner-only directory.");
  }
}

function requireChildDirectory(root: string, name: string, uid: number): string {
  const path = join(root, name);
  assertNoSymlinkComponents(path);
  const metadata = lstatSync(path);
  if (
    !metadata.isDirectory() ||
    metadata.uid !== uid ||
    (metadata.mode & 0o777) !== 0o700 ||
    relative(root, realpathSync(path)).startsWith(`..${sep}`)
  ) {
    throw new Error("Test resource must stay in an owner-only directory.");
  }
  return path;
}

function requireExactProjectRoot(path: string, uid: number): string {
  if (!isAbsolute(path)) throw new Error("Exact test project root must be absolute.");
  assertNoSymlinkComponents(path);
  if (realpathSync(path) !== path) throw new Error("Exact test project root must be canonical.");
  const metadata = lstatSync(path);
  if (!metadata.isDirectory() || metadata.uid !== uid) {
    throw new Error("Exact test project root must be an owner directory.");
  }
  accessSync(path, constants.R_OK | constants.X_OK);
  return path;
}

export function approvedSiblingWorktreeRoots(
  exactProjectRoot: string,
  uid: number,
): readonly [string, string] {
  const codingRoot = dirname(dirname(requireExactProjectRoot(exactProjectRoot, uid)));
  return [
    requireExactProjectRoot(join(codingRoot, "worktree"), uid),
    requireExactProjectRoot(join(codingRoot, "worktrees"), uid),
  ];
}

function requireConfiguredWorktreeRoots(
  exactProjectRoot: string,
  configured: readonly [string, string],
  uid: number,
): readonly [string, string] {
  const approved = approvedSiblingWorktreeRoots(exactProjectRoot, uid);
  if (configured[0] !== approved[0] || configured[1] !== approved[1]) {
    throw new Error("Test worktree roots must be the two approved sibling directories.");
  }
  return approved;
}

async function main(): Promise<void> {
  const root = process.argv[2];
  if (root === undefined || process.argv.length !== 3) throw new Error("Expected one test root.");
  const { settings, config } = loadTestServerSettings(root);
  const repository = NaruRepository.openDataDirectory(config.dataDir, {
    sessionOwner: "legacy",
    defaultAgentPaneKind: "claude",
  });
  const pathPolicy = await ProjectPathPolicy.create(config.projectRoots, {
    ...(settings.exactProjectRoot === undefined
      ? {}
      : { allowExactRoots: [settings.exactProjectRoot] }),
  });
  const launchProfiles = new LaunchProfileRegistry({
    ...(config.claudeExecutable === undefined ? {} : { claudeExecutable: config.claudeExecutable }),
    ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
  });
  const supervisor = new PtySupervisor(repository, undefined, launchProfiles);
  const tls = new ExternalTestTls(settings.tls);
  let app: Awaited<ReturnType<typeof buildApp>>;
  try {
    app = await buildApp(config, {
      repository,
      pathPolicy,
      supervisor,
      tlsCertificateManager: tls,
    });
  } catch (error) {
    await supervisor.shutdown();
    repository.close();
    throw error;
  }
  installPrivateIpv4SourceAdmission(
    app.server,
    new PrivateIpv4SourceAdmission(settings.sourcePolicy),
  );
  installTlsAvailabilityGuard(app.server, () => tls.acceptsNewConnections());
  process.once("SIGINT", () => void app.close());
  process.once("SIGTERM", () => void app.close());
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    throw error;
  }
}

if (process.argv[1]?.endsWith("/ops/test-private-password/server.ts")) {
  void main().catch(() => {
    // No private path, Origin, source address, certificate reference or auth data in stderr.
    process.stderr.write("Isolated password test server failed to start.\n");
    process.exitCode = 1;
  });
}
