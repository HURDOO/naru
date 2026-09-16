import { createECDH, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type AppConfig, type AppManagedConfig } from "../src/config.js";

const validPasswordHash = [
  "scrypt",
  "32768",
  "8",
  "1",
  Buffer.alloc(16, 1).toString("base64url"),
  Buffer.alloc(64, 2).toString("base64url"),
].join("$");

const validEnvironment: NodeJS.ProcessEnv = {
  NODE_ENV: "test",
  NARU_AUTH_MODE: "app-managed",
  NARU_HOST: "127.0.0.1",
  NARU_PORT: "4174",
  NARU_ALLOWED_ORIGINS: "https://naru.internal",
  NARU_PROJECT_ROOTS: "projects",
  NARU_PASSWORD_HASH: validPasswordHash,
  NARU_SESSION_SECRET: "a-session-secret-that-is-at-least-32-chars",
  NARU_DATA_DIR: ".local",
  NARU_WEB_DIST: "apps/web/dist",
  NARU_CODEX_PATH: "/opt/homebrew/bin/codex",
  NARU_TLS_STATE_DIR: "/tmp/naru-tls",
};

const vapidKey = createECDH("prime256v1");
vapidKey.setPrivateKey(Buffer.alloc(32, 1));
const validPushEnvironment = {
  NARU_VAPID_PUBLIC_KEY: vapidKey.getPublicKey().toString("base64url"),
  NARU_VAPID_PRIVATE_KEY: vapidKey.getPrivateKey().toString("base64url"),
  NARU_VAPID_SUBJECT: "https://naru.internal",
};

describe("loadConfig", () => {
  it("requires an explicit project root allowlist", () => {
    const environment = { ...validEnvironment };
    delete environment.NARU_PROJECT_ROOTS;

    expect(() => loadConfig(environment)).toThrow(/NARU_PROJECT_ROOTS/);
  });

  it("keeps legacy ownership as the explicit default and rejects mixed Host settings", () => {
    expect(loadConfig(validEnvironment).sessionRuntime).toEqual({ owner: "legacy" });
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_DURABLE_SESSION_SOCKET_PATH: "/tmp/host.sock",
      }),
    ).toThrow(/mixed ownership/);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_CODEX_INTEGRATION_SOCKET_PATH: "/private/tmp/naru-integration.sock",
      }),
    ).toThrow(/requires NARU_SESSION_OWNER=durable-host/);
  });

  it("loads a complete Durable Host single-owner configuration with exact root mapping", () => {
    const config = loadConfig(
      {
        ...validEnvironment,
        NARU_PROJECT_ROOTS: "/safe/projects,/safe/other",
        NARU_SESSION_OWNER: "durable-host",
        NARU_DURABLE_SESSION_SOCKET_PATH: "/safe/runtime/host.sock",
        NARU_DURABLE_SESSION_CREDENTIAL_FILE: "/safe/credentials/naru",
        NARU_DURABLE_SESSION_APP_ID: "naru",
        NARU_DURABLE_SESSION_SUBJECT: "local-owner",
        NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "600000",
        NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["shell", "codex-main", "codex-quick"]),
        NARU_DURABLE_SESSION_ROOTS: JSON.stringify({
          projects: "/safe/projects",
          other: "/safe/other",
        }),
        NARU_CODEX_INTEGRATION_SOCKET_PATH: "/safe/runtime/naru-integration.sock",
      },
      "/safe",
    );

    expect(config.sessionRuntime).toEqual({
      owner: "durable-host",
      socketPath: "/safe/runtime/host.sock",
      credentialFile: "/safe/credentials/naru",
      appId: "naru",
      subject: "local-owner",
      callerTtlMs: 60_000,
      idempotencyTtlMs: 600_000,
      profileIds: ["shell", "codex-main", "codex-quick"],
      roots: [
        { rootId: "projects", path: "/safe/projects" },
        { rootId: "other", path: "/safe/other" },
      ],
    });
    expect(config.codexIntegrationSocketPath).toBe("/safe/runtime/naru-integration.sock");
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_SESSION_OWNER: "durable-host",
        NARU_DURABLE_SESSION_SOCKET_PATH: "/safe/runtime/host.sock",
        NARU_DURABLE_SESSION_CREDENTIAL_FILE: "/safe/credentials/naru",
        NARU_DURABLE_SESSION_APP_ID: "naru",
        NARU_DURABLE_SESSION_SUBJECT: "local-owner",
        NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "600000",
        NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["shell"]),
        NARU_DURABLE_SESSION_ROOTS: JSON.stringify({ wrong: "/different-root" }),
      }),
    ).toThrow(/map every exact/);

    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_PROJECT_ROOTS: "/safe/projects",
        NARU_SESSION_OWNER: "durable-host",
        NARU_DURABLE_SESSION_SOCKET_PATH: "/safe/runtime/host.sock",
        NARU_DURABLE_SESSION_CREDENTIAL_FILE: "/safe/credentials/naru",
        NARU_DURABLE_SESSION_APP_ID: "naru",
        NARU_DURABLE_SESSION_SUBJECT: "local-owner",
        NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "600000",
        NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["shell"]),
        NARU_DURABLE_SESSION_ROOTS: JSON.stringify({ projects: "/safe/projects" }),
        NARU_CODEX_INTEGRATION_SOCKET_PATH: "relative/naru.sock",
      }),
    ).toThrow(/exact absolute path/);
  });

  it("resolves root-relative paths and enables secure cookies for HTTPS", () => {
    const config = requireAppManagedConfig(loadConfig(validEnvironment, "/tmp/naru-project"));

    expect(config.projectRoots).toEqual(["/tmp/naru-project/projects"]);
    expect(config.dataDir).toBe("/tmp/naru-project/.local");
    expect(config.webDist).toBe("/tmp/naru-project/apps/web/dist");
    expect(config.appBasePath).toBe("/");
    expect(config.codexExecutable).toBe("/opt/homebrew/bin/codex");
    expect(config.allowedOrigins).toEqual(new Set(["https://naru.internal"]));
    expect(config.allowedClientIps).toBeUndefined();
    expect(config.secureCookie).toBe(true);
    expect(config.sessionCookieName).toBe("naru_test_session");
    expect(config.tls).toEqual({
      stateDirectory: "/tmp/naru-tls",
      serverNames: ["naru.internal"],
      reloadIntervalMs: 10_000,
    });
  });

  it("accepts one canonical app base path and rejects traversal or Gateway-owned routes", () => {
    expect(() => loadConfig({ ...validEnvironment, NARU_APP_BASE_PATH: "/naru" })).toThrow(
      /gateway-managed path stripping/,
    );
    const verifierKeysFile = createVerifierKeysFile();
    expect(
      loadConfig({ ...gatewayEnvironment(verifierKeysFile), NARU_APP_BASE_PATH: "/naru" }, "/safe")
        .appBasePath,
    ).toBe("/naru");
    for (const appBasePath of [
      "naru",
      "/naru/",
      "/naru//nested",
      "/naru/..",
      "/naru?mode=pwa",
      "/_gateway/apps",
    ]) {
      expect(() => loadConfig({ ...validEnvironment, NARU_APP_BASE_PATH: appBasePath })).toThrow(
        /app base path|canonical|Gateway/,
      );
    }
  });

  it("uses environment-specific cookie defaults and accepts an explicit valid override", () => {
    expect(
      requireAppManagedConfig(loadConfig({ ...validEnvironment, NODE_ENV: "development" }))
        .sessionCookieName,
    ).toBe("naru_dev_session");
    expect(
      requireAppManagedConfig(loadConfig({ ...validEnvironment, NODE_ENV: "production" }))
        .sessionCookieName,
    ).toBe("naru_session");
    expect(
      requireAppManagedConfig(
        loadConfig({
          ...validEnvironment,
          NARU_SESSION_COOKIE_NAME: "naru_t49_session",
        }),
      ).sessionCookieName,
    ).toBe("naru_t49_session");
  });

  it("rejects invalid cookie names and secure prefixes on an HTTP Origin", () => {
    expect(() =>
      loadConfig({ ...validEnvironment, NARU_SESSION_COOKIE_NAME: "invalid cookie" }),
    ).toThrow(/valid HTTP cookie token/);

    const httpEnvironment: NodeJS.ProcessEnv = {
      ...validEnvironment,
      NARU_ALLOWED_ORIGINS: "http://127.0.0.1:4174",
      NARU_SESSION_COOKIE_NAME: "__Host-naru_session",
    };
    delete httpEnvironment.NARU_TLS_STATE_DIR;
    expect(() => loadConfig(httpEnvironment)).toThrow(/requires HTTPS Origins/);
  });

  it("requires exact client IPs for a LAN bind", () => {
    const config = loadConfig({
      ...validEnvironment,
      NARU_HOST: "10.23.45.10",
      NARU_PORT: "8443",
      NARU_ALLOWED_ORIGINS: "https://naru.example.test:8443",
      NARU_ALLOWED_CLIENT_IPS: "10.23.45.42, ::ffff:10.23.45.10",
    });

    expect(config.allowedClientIps).toEqual(new Set(["10.23.45.42", "10.23.45.10"]));
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_HOST: "10.23.45.10",
        NARU_PORT: "8443",
        NARU_ALLOWED_ORIGINS: "https://naru.example.test:8443",
      }),
    ).toThrow(/required for a LAN bind/);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_HOST: "10.23.45.10",
        NARU_PORT: "8443",
        NARU_ALLOWED_ORIGINS: "https://naru.example.test:8443",
        NARU_ALLOWED_CLIENT_IPS: "10.23.45.0/24",
      }),
    ).toThrow(/exact IP addresses/);
  });

  it("uses non-Secure cookies only for the approved all-HTTP boundary", () => {
    const environment: NodeJS.ProcessEnv = {
      ...validEnvironment,
      NARU_ALLOWED_ORIGINS: "http://10.23.45.20:4174,http://127.0.0.1:5173",
    };
    delete environment.NARU_TLS_STATE_DIR;
    const config = loadConfig(environment);

    expect(config.secureCookie).toBe(false);
    expect(config.tls).toBeUndefined();
  });

  it("accepts an optional complete VAPID configuration and rejects partial or malformed keys", () => {
    expect(loadConfig({ ...validEnvironment, ...validPushEnvironment }).push).toEqual({
      publicKey: validPushEnvironment.NARU_VAPID_PUBLIC_KEY,
      privateKey: validPushEnvironment.NARU_VAPID_PRIVATE_KEY,
      subject: validPushEnvironment.NARU_VAPID_SUBJECT,
    });
    expect(loadConfig(validEnvironment).push).toBeUndefined();
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_VAPID_PUBLIC_KEY: validPushEnvironment.NARU_VAPID_PUBLIC_KEY,
      }),
    ).toThrow(/configured together/);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        ...validPushEnvironment,
        NARU_VAPID_PRIVATE_KEY: "not-base64!",
      }),
    ).toThrow(/URL-safe base64/);
    const otherKey = createECDH("prime256v1");
    otherKey.setPrivateKey(Buffer.alloc(32, 2));
    expect(() =>
      loadConfig({
        ...validEnvironment,
        ...validPushEnvironment,
        NARU_VAPID_PRIVATE_KEY: otherKey.getPrivateKey().toString("base64url"),
      }),
    ).toThrow(/matching P-256 key pair/);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        ...validPushEnvironment,
        NARU_VAPID_SUBJECT: "http://naru.internal",
      }),
    ).toThrow(/HTTPS or mailto/);
  });

  it("requires an external TLS state for HTTPS and rejects it for HTTP", () => {
    const missingState = { ...validEnvironment };
    delete missingState.NARU_TLS_STATE_DIR;
    expect(() => loadConfig(missingState)).toThrow(/required for an HTTPS Origin/);

    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_ALLOWED_ORIGINS: "http://127.0.0.1:4174",
      }),
    ).toThrow(/require an all-HTTPS Origin/);
    expect(() => loadConfig({ ...validEnvironment, NARU_TLS_STATE_DIR: "relative/tls" })).toThrow(
      /absolute path outside the repository/,
    );
    expect(() =>
      loadConfig(
        { ...validEnvironment, NARU_TLS_STATE_DIR: "/tmp/naru-project/private-tls" },
        "/tmp/naru-project",
      ),
    ).toThrow(/outside the repository/);
    expect(() =>
      loadConfig({ ...validEnvironment, NARU_ALLOWED_ORIGINS: "https://10.23.45.10:8443" }),
    ).toThrow(/DNS hostnames/);
  });

  it("rejects wildcard binds, weak secrets, and unsafe Origin configuration", () => {
    expect(() => loadConfig({ ...validEnvironment, NARU_HOST: "0.0.0.0" })).toThrow(
      /wildcard network binds/,
    );
    expect(() => loadConfig({ ...validEnvironment, NARU_SESSION_SECRET: "too-short" })).toThrow();
    expect(() => loadConfig({ ...validEnvironment, NARU_SESSION_SECRET: "a".repeat(40) })).toThrow(
      /distinct characters/,
    );
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_SESSION_SECRET: "replace-with-a-random-secret-at-least-32-characters",
      }),
    ).toThrow(/placeholder/);
    expect(() =>
      loadConfig({ ...validEnvironment, NARU_ALLOWED_ORIGINS: "https://naru.internal/path" }),
    ).toThrow(/exact origins/);
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_ALLOWED_ORIGINS: "http://127.0.0.1:5173,https://naru.internal",
      }),
    ).toThrow(/must not mix HTTP and HTTPS/);
    expect(() => loadConfig({ ...validEnvironment, NARU_CODEX_PATH: "bin/codex" })).toThrow(
      /absolute path/,
    );
  });

  it("refuses startup when required security settings are missing or weak", () => {
    const missingOrigin = { ...validEnvironment };
    delete missingOrigin.NARU_ALLOWED_ORIGINS;
    expect(() => loadConfig(missingOrigin)).toThrow();

    const missingHash = { ...validEnvironment };
    delete missingHash.NARU_PASSWORD_HASH;
    expect(() => loadConfig(missingHash)).toThrow();

    const missingSecret = { ...validEnvironment };
    delete missingSecret.NARU_SESSION_SECRET;
    expect(() => loadConfig(missingSecret)).toThrow();

    const weakPasswordHash = validPasswordHash.replace("scrypt$32768$", "scrypt$1024$");
    expect(() => loadConfig({ ...validEnvironment, NARU_PASSWORD_HASH: weakPasswordHash })).toThrow(
      /weaker than the Naru minimum/,
    );
    expect(() =>
      loadConfig({ ...validEnvironment, NARU_PASSWORD_HASH: "scrypt$32768$8$1$bad$bad" }),
    ).toThrow(/payload is invalid/);
  });

  it("requires an explicit auth mode and keeps app and Gateway credentials mutually exclusive", () => {
    const missingMode = { ...validEnvironment };
    delete missingMode.NARU_AUTH_MODE;
    expect(() => loadConfig(missingMode)).toThrow();
    expect(() =>
      loadConfig({
        ...validEnvironment,
        NARU_GATEWAY_INSTANCE_ID: "gateway-fixture",
      }),
    ).toThrow(/require NARU_AUTH_MODE=gateway-managed/);
  });

  it("loads a fail-closed gateway-managed loopback configuration bound to the Host caller", () => {
    const verifierKeysFile = createVerifierKeysFile();
    const environment = gatewayEnvironment(verifierKeysFile);
    const config = loadConfig(environment, "/safe");
    if (config.authMode !== "gateway-managed") throw new Error("Expected Gateway config.");

    expect(config.host).toBe("127.0.0.1");
    expect(config.tls).toBeUndefined();
    expect(config.secureCookie).toBe(false);
    expect(config.gatewayAuth).toMatchObject({
      issuer: "gateway-fixture",
      audience: "naru",
      ownerSubject: "local-owner",
      origin: "https://naru.fixture.invalid",
      verifierKeysFile,
    });
    expect(config.gatewayAuth.verifierKeys.has("gateway-test-key")).toBe(true);

    expect(() =>
      loadConfig({ ...environment, NARU_PASSWORD_HASH: validPasswordHash }, "/safe"),
    ).toThrow(/forbidden in gateway-managed mode/);
    expect(() => loadConfig({ ...environment, NARU_HOST: "10.23.45.10" }, "/safe")).toThrow(
      /exact loopback/,
    );
    expect(() =>
      loadConfig({ ...environment, NARU_TLS_STATE_DIR: "/tmp/naru-tls" }, "/safe"),
    ).toThrow(/forbidden on the gateway-managed loopback/);
    expect(() =>
      loadConfig({ ...environment, NARU_DURABLE_SESSION_APP_ID: "other-app" }, "/safe"),
    ).toThrow(/must match the Durable Host caller/);
    expect(() =>
      loadConfig({ ...environment, NARU_DURABLE_SESSION_SUBJECT: "other-owner" }, "/safe"),
    ).toThrow(/must match the Durable Host caller/);
  });
});

function requireAppManagedConfig(config: AppConfig): AppManagedConfig {
  if (config.authMode !== "app-managed") throw new Error("Expected app-managed test config.");
  return config;
}

function createVerifierKeysFile(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "naru-gateway-config-"));
  const path = join(directory, "verifier-keys.json");
  const { publicKey } = generateKeyPairSync("ed25519");
  writeFileSync(
    path,
    JSON.stringify({
      version: 1,
      keys: [
        {
          keyId: "gateway-test-key",
          algorithm: "Ed25519",
          publicKeyPem: publicKey.export({ format: "pem", type: "spki" }).toString(),
        },
      ],
    }),
    { mode: 0o600 },
  );
  return realpathSync(path);
}

function gatewayEnvironment(verifierKeysFile: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: "test",
    NARU_AUTH_MODE: "gateway-managed",
    NARU_HOST: "127.0.0.1",
    NARU_PORT: "4174",
    NARU_ALLOWED_ORIGINS: "https://naru.fixture.invalid",
    NARU_PROJECT_ROOTS: "/safe/projects",
    NARU_DATA_DIR: "/safe/data",
    NARU_GATEWAY_INSTANCE_ID: "gateway-fixture",
    NARU_GATEWAY_APP_ID: "naru",
    NARU_GATEWAY_OWNER_SUBJECT: "local-owner",
    NARU_GATEWAY_VERIFIER_KEYS_FILE: verifierKeysFile,
    NARU_SESSION_OWNER: "durable-host",
    NARU_DURABLE_SESSION_SOCKET_PATH: "/safe/runtime/host.sock",
    NARU_DURABLE_SESSION_CREDENTIAL_FILE: "/safe/credentials/naru",
    NARU_DURABLE_SESSION_APP_ID: "naru",
    NARU_DURABLE_SESSION_SUBJECT: "local-owner",
    NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "600000",
    NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["shell", "codex-main", "codex-quick"]),
    NARU_DURABLE_SESSION_ROOTS: JSON.stringify({ projects: "/safe/projects" }),
  };
}
