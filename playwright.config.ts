import { scryptSync } from "node:crypto";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "@playwright/test";

const salt = Buffer.from("naru-e2e-salt-2026");
const hash = scryptSync("naru-test-password", salt, 64, {
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
const dataDir = mkdtempSync(join(tmpdir(), "naru-e2e-"));
const productionDataDir = mkdtempSync(join(tmpdir(), "naru-e2e-production-"));
const filesProjectsRoot = "/private/tmp/naru-e2e-projects";
const publicProjectRoot = join(filesProjectsRoot, "public/editor");
const filesProjectRoot = join(filesProjectsRoot, basename(dataDir));
for (const projectPath of [
  join(publicProjectRoot, "apps/web/src"),
  join(publicProjectRoot, "apps/server/src"),
  join(publicProjectRoot, "packages/domain"),
  join(publicProjectRoot, "packages/contracts"),
  join(publicProjectRoot, "docs"),
  join(publicProjectRoot, "claude-fixture"),
  join(publicProjectRoot, "claude-scroll-fixture"),
  join(publicProjectRoot, "claude-resume-fixture"),
]) {
  mkdirSync(projectPath, { recursive: true });
}
writeFileSync(
  join(publicProjectRoot, "docs/TASKS.md"),
  [
    "# Tasks",
    "",
    "## T14. HTTPS 인증서 갱신 인수",
    "",
    "- [~] **범위**: 인증서 갱신 시점까지 보류한다.",
    "",
    "## T15. 프로젝트 Docs·Tasks 정리 보기 Pane",
    "",
    "- [x] **범위**: 현재 선택한 프로젝트 폴더의 문서를 안전하게 탐색한다.",
    "",
    "## T26. TUI `/resume` 직후 첫 model turn 전 원클릭 재개",
    "",
    "- [~] **범위**: 실행 중 Codex TUI의 재개 공백을 보완한다.",
    "",
    "## T27. 터미널 복원 성능",
    "",
    "- [x] **범위**: 대량 출력 복원 성능을 검증했다.",
    "",
    "## T33. 인증 만료 재접속",
    "",
    "- [x] **범위**: 인증 만료 뒤 안전한 재로그인을 제공한다.",
    "",
  ].join("\n"),
);
mkdirSync(join(filesProjectRoot, "src"), { recursive: true });
writeFileSync(join(filesProjectRoot, "src", "app.ts"), "const base = true;\n");
writeFileSync(join(filesProjectRoot, ".env"), "TOKEN=fake-e2e-value\n");
process.env.NARU_E2E_FILES_PROJECT = filesProjectRoot;
const fakeCodexPath = fileURLToPath(new URL("./tests/fixtures/fake-codex.mjs", import.meta.url));
const fakeClaudePath = fileURLToPath(new URL("./tests/fixtures/fake-claude.mjs", import.meta.url));
const apiPort = readPort("NARU_E2E_API_PORT", 4990);
const productionApiPort = readPort("NARU_E2E_PRODUCTION_API_PORT", 4992);
const webPort = readPort("NARU_E2E_WEB_PORT", 4991);
const webOrigin = `http://localhost:${webPort}`;
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const productionApiOrigin = `http://127.0.0.1:${productionApiPort}`;
const webServerUrl = `http://127.0.0.1:${webPort}`;

export default defineConfig({
  testDir: "tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  use: {
    baseURL: webOrigin,
    channel: "chrome",
    trace: "retain-on-failure",
  },
  webServer: [
    {
      command: "exec ../../node_modules/.bin/tsx src/index.ts",
      cwd: "apps/server",
      url: `http://127.0.0.1:${apiPort}/healthz`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: "development",
        NARU_HOST: "127.0.0.1",
        NARU_PORT: String(apiPort),
        NARU_ALLOWED_ORIGINS: `${webOrigin},${apiOrigin}`,
        NARU_PROJECT_ROOTS: filesProjectsRoot,
        NARU_AUTH_MODE: "app-managed",
        NARU_PASSWORD_HASH: passwordHash,
        NARU_SESSION_SECRET: "naru-e2e-session-secret-that-is-not-for-production",
        NARU_DATA_DIR: dataDir,
        NARU_CODEX_PATH: fakeCodexPath,
        NARU_CLAUDE_PATH: fakeClaudePath,
      },
    },
    {
      command: "exec ../../node_modules/.bin/tsx src/index.ts",
      cwd: "apps/server",
      url: `${productionApiOrigin}/healthz`,
      reuseExistingServer: false,
      env: {
        NODE_ENV: "production",
        NARU_HOST: "127.0.0.1",
        NARU_PORT: String(productionApiPort),
        NARU_ALLOWED_ORIGINS: productionApiOrigin,
        NARU_PROJECT_ROOTS: filesProjectsRoot,
        NARU_AUTH_MODE: "app-managed",
        NARU_PASSWORD_HASH: passwordHash,
        NARU_SESSION_SECRET: "naru-e2e-production-session-secret-not-for-production",
        NARU_DATA_DIR: productionDataDir,
        NARU_CODEX_PATH: fakeCodexPath,
      },
    },
    {
      command: "exec ./node_modules/.bin/vite --host 127.0.0.1",
      cwd: "apps/web",
      url: webServerUrl,
      reuseExistingServer: false,
      env: {
        NARU_WEB_PORT: String(webPort),
        NARU_API_PORT: String(apiPort),
      },
    },
  ],
});

function readPort(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer TCP port.`);
  }
  return port;
}
