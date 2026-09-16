import { createECDH, scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const port = readPort(process.env.NARU_PRODUCTION_SMOKE_PORT, 4474);
const origin = `http://127.0.0.1:${port}`;
const inheritedFixtureRoot = process.env.NARU_PRODUCTION_SMOKE_ROOT;
const fixtureRoot =
  inheritedFixtureRoot === undefined
    ? realpathSync(mkdtempSync(join(tmpdir(), "naru-production-smoke-")))
    : realpathSync(inheritedFixtureRoot);
const allowedProjectRoot = join(fixtureRoot, "projects");
const projectRoot = join(allowedProjectRoot, "project");
const dataDirectory = join(fixtureRoot, "data");
const webDist = realpathSync(fileURLToPath(new URL("./apps/web/dist", import.meta.url)));
mkdirSync(projectRoot, { recursive: true, mode: 0o700 });
const fakeCodexPath = fileURLToPath(new URL("./tests/fixtures/fake-codex.mjs", import.meta.url));
const salt = Buffer.from("naru-production-smoke-salt");
const hash = scryptSync("naru-production-password", salt, 64, {
  N: 32768,
  r: 8,
  p: 1,
  maxmem: 64 * 1024 * 1024,
});
const passwordHash = [
  "scrypt",
  "32768",
  "8",
  "1",
  salt.toString("base64url"),
  hash.toString("base64url"),
].join("$");
const vapidKey = createECDH("prime256v1");
vapidKey.generateKeys();
const environmentFile = join(fixtureRoot, "naru.env");
const serviceEnvironment = {
  NODE_ENV: "production",
  SHELL: "/bin/sh",
  NARU_HOST: "127.0.0.1",
  NARU_PORT: String(port),
  NARU_ALLOWED_ORIGINS: origin,
  NARU_PROJECT_ROOTS: allowedProjectRoot,
  NARU_AUTH_MODE: "app-managed",
  NARU_APP_BASE_PATH: "/",
  NARU_PASSWORD_HASH: passwordHash,
  NARU_SESSION_SECRET: "naru-production-smoke-session-secret-1234567890",
  NARU_DATA_DIR: dataDirectory,
  NARU_WEB_DIST: webDist,
  NARU_CODEX_PATH: fakeCodexPath,
  NARU_VAPID_PUBLIC_KEY: vapidKey.getPublicKey().toString("base64url"),
  NARU_VAPID_PRIVATE_KEY: vapidKey.getPrivateKey().toString("base64url"),
  NARU_VAPID_SUBJECT: "https://naru.example.test:8443",
};
if (inheritedFixtureRoot === undefined) {
  writeFileSync(
    environmentFile,
    `${Object.entries(serviceEnvironment)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n")}\n`,
    { mode: 0o600 },
  );
}

process.env.NARU_PRODUCTION_SMOKE_ROOT = fixtureRoot;
process.env.NARU_PRODUCTION_SMOKE_PROJECT = projectRoot;
process.env.NARU_PRODUCTION_SMOKE_PORT = String(port);

export default defineConfig({
  testDir: "tests/operations",
  testMatch: "production-smoke.spec.ts",
  fullyParallel: false,
  retries: 0,
  reporter: "list",
  timeout: 60_000,
  use: {
    baseURL: origin,
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node apps/server/dist/index.js",
    url: `${origin}/readyz`,
    reuseExistingServer: false,
    env: {
      NARU_ENV_FILE: environmentFile,
      SHELL: serviceEnvironment.SHELL,
    },
  },
});

function readPort(value: string | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) {
    throw new Error("NARU_PRODUCTION_SMOKE_PORT must be an integer TCP port.");
  }
  return parsed;
}
