import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readlinkSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  activateRelease,
  assertExactListenerAddresses,
  parseReadinessGauges,
  parseLsofListenerAddresses,
  preflightProductionEnvironment,
  renderCertificateRenewalLaunchd,
  renderLaunchdTemplate,
  resolveProductionProbeTarget,
  writeReleaseManifest,
} from "../src/operations.js";
import { createTestTlsState } from "./tls-fixture.js";

const temporaryDirectories: string[] = [];
const validPasswordHash = [
  "scrypt",
  "32768",
  "8",
  "1",
  Buffer.alloc(16, 1).toString("base64url"),
  Buffer.alloc(64, 2).toString("base64url"),
].join("$");

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("production preflight", () => {
  it("accepts an assigned exact LAN bind with private external data and built assets", () => {
    const fixture = productionFixture();

    expect(
      preflightProductionEnvironment(fixture.environment, fixture.root, {
        nodeVersion: "24.19.0",
        assignedIpv4Addresses: new Set(["127.0.0.1", "10.23.45.10"]),
      }),
    ).toMatchObject({
      status: "ok",
      host: "10.23.45.10",
      origin: "http://10.23.45.10:4174",
      sessionCookieName: "naru_session",
      dataDirectoryReady: true,
      webBuildReady: true,
      tlsReady: false,
    });
  });

  it("accepts a canonical HTTPS Origin while retaining the exact LAN bind", () => {
    const fixture = productionFixture();
    const tlsState = createTestTlsState("naru.example.test");
    temporaryDirectories.push(tlsState.root);
    const generation = tlsState.createGeneration("production-a");
    tlsState.publish(generation.generation);
    const environment = {
      ...fixture.environment,
      NARU_PORT: "8443",
      NARU_ALLOWED_ORIGINS: "https://naru.example.test:8443",
      NARU_ALLOWED_CLIENT_IPS: "10.23.45.11,10.23.45.12,10.23.45.10",
      NARU_TLS_STATE_DIR: tlsState.stateDirectory,
    };

    const report = preflightProductionEnvironment(environment, fixture.root, {
      nodeVersion: "24.19.0",
      assignedIpv4Addresses: new Set(["127.0.0.1", "10.23.45.10"]),
    });

    expect(report).toMatchObject({
      status: "ok",
      host: "10.23.45.10",
      port: 8443,
      origin: "https://naru.example.test:8443",
      sessionCookieName: "naru_session",
      allowedClientCount: 3,
      tlsReady: true,
    });
    expect(typeof report.tlsExpiresAt).toBe("string");
    const config = loadConfig(environment, fixture.root);
    expect(resolveProductionProbeTarget(config)).toEqual({
      protocol: "https:",
      connectHost: "10.23.45.10",
      port: 8443,
      hostHeader: "naru.example.test:8443",
      serverName: "naru.example.test",
    });
    expect(() =>
      resolveProductionProbeTarget({
        ...config,
        allowedClientIps: new Set(["10.23.45.11", "10.23.45.10", "10.23.45.13"]),
      }),
    ).toThrow(/exact fixture client IP allowlist/);
    expect(() =>
      resolveProductionProbeTarget({
        ...config,
        allowedOrigins: new Set(["https://other.example:8443"]),
      }),
    ).toThrow(/non-deployable fixture/);
  });

  it("rejects an unsupported Node, unassigned host, public client IP, and permissive data dir", () => {
    const fixture = productionFixture();
    const options = {
      nodeVersion: "24.19.0",
      assignedIpv4Addresses: new Set(["127.0.0.1", "10.23.45.10"]),
    };

    expect(() =>
      preflightProductionEnvironment(fixture.environment, fixture.root, {
        ...options,
        nodeVersion: "26.4.0",
      }),
    ).toThrow(/Node.js 24/);
    expect(() =>
      preflightProductionEnvironment(fixture.environment, fixture.root, {
        ...options,
        assignedIpv4Addresses: new Set(["127.0.0.1"]),
      }),
    ).toThrow(/not assigned/);
    expect(() =>
      preflightProductionEnvironment(
        { ...fixture.environment, NARU_ALLOWED_CLIENT_IPS: "203.0.113.10" },
        fixture.root,
        options,
      ),
    ).toThrow(/10\.23\.45\.0\/24/);
    expect(() =>
      preflightProductionEnvironment(
        { ...fixture.environment, NARU_ALLOWED_ORIGINS: "http://other.example:4174" },
        fixture.root,
        options,
      ),
    ).toThrow(/HTTP Origin must be exactly/);

    chmodSync(fixture.dataDirectory, 0o755);
    expect(() =>
      preflightProductionEnvironment(fixture.environment, fixture.root, options),
    ).toThrow(/0700/);
  });
});

describe("production listener verification", () => {
  it("parses lsof field output and accepts only the configured exact address", () => {
    const listeners = parseLsofListenerAddresses(
      "p123\nfcwd\nn10.23.45.10:4174\np124\nn10.23.45.10:4174\n",
      4174,
    );
    expect(listeners).toEqual(["10.23.45.10"]);
    expect(() => assertExactListenerAddresses(listeners, "10.23.45.10")).not.toThrow();
    expect(() => assertExactListenerAddresses(["*"], "10.23.45.10")).toThrow(/wildcard/);
    expect(() => assertExactListenerAddresses(["127.0.0.1"], "10.23.45.10")).toThrow(
      /Unexpected production listener/,
    );
  });

  it("requires non-negative readiness gauges", () => {
    expect(
      parseReadinessGauges({
        metrics: {
          gauges: { activePtys: 3, activeSessions: 1, activeWebSockets: 1 },
        },
      }),
    ).toEqual({ activePtys: 3, activeSessions: 1, activeWebSockets: 1 });
    expect(() => parseReadinessGauges({ metrics: { gauges: { activePtys: -1 } } })).toThrow(
      /activePtys/,
    );
  });
});

describe("release rollback", () => {
  it("atomically switches current between verified release directories", () => {
    const root = temporaryDirectory();
    const releases = join(root, "releases");
    mkdirSync(releases, { mode: 0o700 });
    createReleaseFixture(releases, "old-build", "old");
    createReleaseFixture(releases, "new-build", "new");

    expect(activateRelease(releases, "old-build")).toEqual({
      activeRelease: "old-build",
      previousRelease: null,
    });
    expect(readlinkSync(join(releases, "current"))).toBe("old-build");
    expect(activateRelease(releases, "new-build")).toEqual({
      activeRelease: "new-build",
      previousRelease: "old-build",
    });
    expect(readlinkSync(join(releases, "current"))).toBe("new-build");
    expect(activateRelease(releases, "old-build")).toEqual({
      activeRelease: "old-build",
      previousRelease: "new-build",
    });
  });

  it("keeps pre-helper v1 releases valid as rollback targets", () => {
    const root = temporaryDirectory();
    const releases = join(root, "releases");
    mkdirSync(releases, { mode: 0o700 });
    createLegacyReleaseFixture(releases, "legacy-build");
    createReleaseFixture(releases, "helper-build", "helper");

    expect(activateRelease(releases, "legacy-build")).toMatchObject({
      activeRelease: "legacy-build",
    });
    expect(activateRelease(releases, "helper-build")).toMatchObject({
      activeRelease: "helper-build",
      previousRelease: "legacy-build",
    });
    expect(activateRelease(releases, "legacy-build")).toMatchObject({
      activeRelease: "legacy-build",
      previousRelease: "helper-build",
    });
  });

  it("detects changed and untracked build artifacts before activation", () => {
    const root = temporaryDirectory();
    const releases = join(root, "releases");
    mkdirSync(releases, { mode: 0o700 });
    createReleaseFixture(releases, "changed-build", "original");
    writeFileSync(join(releases, "changed-build/apps/server/dist/chunk-runtime.js"), "tampered\n");
    expect(() => activateRelease(releases, "changed-build")).toThrow(/manifest inventory/);

    createReleaseFixture(releases, "tampered-build", "original");
    writeFileSync(join(releases, "tampered-build/apps/server/dist/chunk-shared.js"), "tampered\n");
    expect(() => activateRelease(releases, "tampered-build")).toThrow(/does not match/);
  });
});

describe("launchd template", () => {
  it("escapes values and leaves no unresolved placeholder", () => {
    const rendered = renderLaunchdTemplate(
      "<string>__LABEL__</string><string>__NODE_EXECUTABLE__</string><string>__WORKING_DIRECTORY__</string><string>__SERVER_ENTRY__</string><string>__ENVIRONMENT_FILE__</string><string>__HELPER_DIRECTORY__</string><string>__STANDARD_OUT_PATH__</string><string>__STANDARD_ERROR_PATH__</string>",
      {
        label: "com.naru&agent",
        nodeExecutable: "/opt/node&24/bin/node",
        workingDirectory: "/tmp/Naru & Current",
        environmentFile: "/tmp/naru.env",
        standardOutPath: "/tmp/naru.out.log",
        standardErrorPath: "/tmp/naru.err.log",
      },
    );

    expect(rendered).toContain("com.naru&amp;agent");
    expect(rendered).toContain("/tmp/Naru &amp; Current/apps/server/dist/index.js");
    expect(rendered).toContain("/tmp/Naru &amp; Current/ops/bin");
    expect(rendered).not.toMatch(/__[A-Z_]+__/);
  });

  it("renders a fixed non-root daily certificate renewal job without embedded secrets", () => {
    const rendered = renderCertificateRenewalLaunchd({
      label: "com.naru.certificate-renewal",
      nodeExecutable: "/opt/homebrew/opt/node@24/bin/node",
      workingDirectory: "/tmp/Naru & Current",
      hostname: "naru.example.test",
      zoneName: "example.test",
      challengeName: "_acme-challenge.naru.example.test",
      tokenFile: "/tmp/Naru & State/cloudflare-dns.env",
      stateDirectory: "/tmp/Naru & State/tls",
      standardOutPath: "/tmp/Naru & State/renewal.out.log",
      standardErrorPath: "/tmp/Naru & State/renewal.err.log",
    });

    expect(rendered).toContain("<string>com.naru.certificate-renewal</string>");
    expect(rendered).toContain("/tmp/Naru &amp; Current/apps/server/dist/acme-renewal-cli.js");
    expect(rendered).toContain("<string>renew-production</string>");
    expect(rendered).toContain("<string>naru.example.test</string>");
    expect(rendered).toContain("/tmp/Naru &amp; State/cloudflare-dns.env");
    expect(rendered).toContain("<key>StartCalendarInterval</key>");
    expect(rendered).toContain("<integer>3</integer>");
    expect(rendered).toContain("<integer>17</integer>");
    expect(rendered).not.toContain("RunAtLoad");
    expect(rendered).not.toContain("KeepAlive");
    expect(rendered).not.toMatch(/CLOUDFLARE_(?:DNS_)?API_TOKEN=/u);
    expect(() =>
      renderCertificateRenewalLaunchd({
        label: "com.naru.certificate-renewal",
        nodeExecutable: "/opt/homebrew/opt/node@24/bin/node",
        workingDirectory: "/tmp/naru",
        hostname: "naru.example.test",
        zoneName: "example.test",
        challengeName: "_acme-challenge.naru.example.test",
        tokenFile: "relative-token.env",
        stateDirectory: "/tmp/naru-tls",
        standardOutPath: "/tmp/renewal.out.log",
        standardErrorPath: "/tmp/renewal.err.log",
      }),
    ).toThrow(/absolute path/);
  });
});

function productionFixture(): {
  root: string;
  dataDirectory: string;
  environment: NodeJS.ProcessEnv;
} {
  const root = temporaryDirectory();
  const projectRoot = join(root, "projects");
  const dataDirectory = join(root, "data");
  const webDist = join(root, "web-dist");
  const codexExecutable = join(root, "codex");
  mkdirSync(projectRoot, { mode: 0o700 });
  mkdirSync(dataDirectory, { mode: 0o700 });
  mkdirSync(webDist, { mode: 0o700 });
  writeFileSync(join(webDist, "index.html"), "<!doctype html>");
  writeFileSync(codexExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  return {
    root,
    dataDirectory,
    environment: {
      NODE_ENV: "production",
      SHELL: "/bin/sh",
      NARU_HOST: "10.23.45.10",
      NARU_PORT: "4174",
      NARU_ALLOWED_ORIGINS: "http://10.23.45.10:4174",
      NARU_ALLOWED_CLIENT_IPS: "10.23.45.13,10.23.45.10",
      NARU_PROJECT_ROOTS: projectRoot,
      NARU_AUTH_MODE: "app-managed",
      NARU_PASSWORD_HASH: validPasswordHash,
      NARU_SESSION_SECRET: "a-production-session-secret-with-many-symbols-12345",
      NARU_DATA_DIR: dataDirectory,
      NARU_WEB_DIST: webDist,
      NARU_CODEX_PATH: codexExecutable,
    },
  };
}

function createReleaseFixture(parent: string, buildId: string, contents: string): void {
  const release = join(parent, buildId);
  mkdirSync(join(release, "apps/server/dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(release, "apps/web/dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(release, "node_modules"), { mode: 0o700 });
  for (const filename of [
    "apps/server/dist/index.js",
    "apps/server/dist/maintenance-cli.js",
    "apps/server/dist/operations-cli.js",
    "apps/server/dist/chunk-shared.js",
    "apps/web/dist/index.html",
    "ops/bin/naru-ops",
    "ops/launchd/com.naru.agent.plist.template",
    "ops/launchd/com.naru.maintenance.plist.template",
    "package.json",
    "pnpm-lock.yaml",
  ]) {
    mkdirSync(dirname(join(release, filename)), { recursive: true, mode: 0o700 });
    writeFileSync(join(release, filename), `${contents}:${filename}\n`, {
      mode: filename === "ops/bin/naru-ops" ? 0o700 : 0o600,
    });
  }
  writeReleaseManifest(release, buildId);
}

function createLegacyReleaseFixture(parent: string, buildId: string): void {
  const release = join(parent, buildId);
  mkdirSync(join(release, "apps/server/dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(release, "apps/web/dist"), { recursive: true, mode: 0o700 });
  mkdirSync(join(release, "node_modules"), { mode: 0o700 });
  const relativeFiles = [
    "apps/server/dist/index.js",
    "apps/server/dist/operations-cli.js",
    "apps/server/dist/chunk-shared.js",
    "apps/web/dist/index.html",
    "package.json",
    "pnpm-lock.yaml",
  ];
  const files: Record<string, string> = {};
  for (const filename of relativeFiles) {
    const contents = `legacy:${filename}\n`;
    writeFileSync(join(release, filename), contents, { mode: 0o600 });
    files[filename] = createHash("sha256").update(contents).digest("hex");
  }
  writeFileSync(
    join(release, ".naru-release.json"),
    `${JSON.stringify(
      {
        formatVersion: 1,
        buildId,
        createdAt: "2026-08-18T00:00:00.000Z",
        files,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "naru-operations-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
