/**
 * AP-T17 UI sandbox: the built Naru server and web app with the Agent Platform enabled, against an
 * isolated DurableSession Host, scripted runtimes (a stand-in Claude SDK and TUI, a fake Codex) and
 * a temp project. It keeps running until SIGINT/SIGTERM and removes everything on exit. The stand-in
 * SDK uses its plan's own Naru MCP capability, so demo data goes through the real agent path.
 *
 * Run (Node 24) after `pnpm build`: node --import tsx tests/spikes/agent-platform/ui-sandbox.ts
 */
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DurableSessionHostConfigSchema } from "../../../apps/durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../../apps/durable-session-host/src/host.js";
import { silentHostLogger } from "../../../apps/durable-session-host/src/logging.js";
import { createHostFixture } from "../../../apps/durable-session-host/test/support.js";
import { hashPassword } from "../../../apps/server/src/password.js";
import { fakeCodexScript } from "../../../apps/server/test/fake-codex.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const wsModule = createRequire(join(repositoryRoot, "apps/server/package.json")).resolve("ws");
const node = process.execPath;
const fixture = createHostFixture();
const projectRoot = fixture.config.roots[0]!.path;

// Stand-in Claude SDK: answers turns; "DEMO" uses the agent's own Naru MCP capability to start a
// shared process and ask the user for a manual test; "APPROVE" asks for a tool approval.
const sdkEntry = join(fixture.root, "fake-sdk.mjs");
writeFileSync(
  sdkEntry,
  `import { createConnection } from "node:net";
const SESSION = "11111111-2222-4333-8444-555555555555";
function naru(options, tool, args) {
  const server = options.mcpServers.naru;
  return new Promise((resolve) => {
    const socket = createConnection(server.env.NARU_AGENT_SOCKET);
    let buffered = "";
    socket.on("connect", () => socket.write(JSON.stringify({ version: 1, capability: server.env.NARU_AGENT_CAPABILITY, tool, arguments: args }) + "\\n"));
    socket.on("data", (chunk) => { buffered += chunk; });
    socket.on("end", () => resolve(buffered));
    socket.on("error", () => resolve(""));
  });
}
export function query({ prompt, options }) {
  const said = [];
  async function* run() {
    yield { type: "system", subtype: "init", session_id: options.resume ?? SESSION };
    for await (const message of prompt) {
      const text = message.message.content;
      said.push({ type: "user", message: { role: "user", content: text } });
      if (text.includes("DEMO")) {
        const started = JSON.parse(await naru(options, "start_process", { purpose: "개발 서버", command: "while true; do date; sleep 5; done", ports: [5173], keep: "keep" }) || "{}");
        await naru(options, "request_human_handoff", {
          kind: "manual-test", project_id: started.result?.projectId ?? null,
          reason: "로그인 흐름을 직접 확인해 주세요.",
          blocking_task_ids: [], independent_work_to_continue: ["문서 정리"],
          options: [{ label: "통과", description: "예상대로 동작함" }, { label: "다시", description: "문제가 있음" }],
          recommendation: "개발 서버에서 로그인 후 대시보드가 보이는지 확인",
          risks: ["테스트 계정 필요"], prepared_environment: ["http://127.0.0.1:5173"],
          resume_condition: "사용자 결정",
        });
      }
      if (text.includes("PLAN")) {
        const call = async (tool, args) => JSON.parse(await naru(options, tool, args) || "{}").result;
        const origin = (await call("get_applicable_user_instructions", {}) ?? []).find((item) => item.scope.kind === "project");
        if (origin !== undefined) {
          const project_id = origin.scope.projectId;
          await call("propose_intent_contract", {
            project_id, source_instruction_id: origin.id, principles: ["passkey만 쓴다"],
            allowed_choices: ["화면 구성"], require_approval_if: ["새 인증 방식 추가"], forbidden: ["비밀번호 저장"],
          });
          const plan = await call("create_plan", { project_id, summary: "로그인 화면과 세션 API를 나눠 만들고 통합 테스트로 묶는다.", activate: true });
          const task = (title, purpose, priority, depends_on) => call("create_task", {
            project_id, plan_id: plan.id, title, purpose, completion_criteria: ["pnpm test 통과"],
            priority, origin_instruction_id: origin.id, ...(depends_on ? { depends_on } : {}),
          });
          const screen = await task("로그인 화면", "passkey 로그인 화면", 10);
          const api = await task("세션 API", "세션 발급과 갱신", 5);
          await task("통합 테스트", "화면과 API를 함께 검증", 1, [screen.id, api.id]);
          const run = await call("start_run", { task_id: screen.id, runtime: "claude", model: "fixture" });
          await call("report_progress", { run_id: run.id, summary: "화면 골격 작성" });
        }
      }
      if (text.includes("APPROVE")) await options.canUseTool("Bash", { command: "pnpm test" }, { signal: new AbortController().signal });
      if (text.includes("SLOW")) await new Promise((done) => setTimeout(done, 8000));
      said.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "알겠습니다. " + text.slice(0, 40) }] } });
      yield { type: "result", subtype: "success", is_error: false };
    }
  }
  const iterator = run();
  iterator.interrupt = async () => {};
  globalThis.__naruSaid = said;
  return iterator;
}
export async function getSessionMessages() {
  return globalThis.__naruSaid ?? [];
}
`,
  { mode: 0o600 },
);
const claude = join(fixture.root, "claude");
writeFileSync(
  claude,
  `#!${node}
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
if (args[0] === "auth") { process.stdout.write('{"loggedIn":true}'); process.exit(0); }
const resume = args[args.indexOf("--resume") + 1];
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
for (const matcher of settings.hooks.SessionStart ?? []) for (const hook of matcher.hooks) {
  spawnSync("/bin/sh", ["-c", hook.command], {
    input: JSON.stringify({ hook_event_name: "SessionStart", session_id: resume, cwd: process.cwd(), source: "resume" }),
    stdio: ["pipe", "ignore", "ignore"],
  });
}
process.stdout.write("stand-in Claude TUI (resumed)\\r\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`,
  { mode: 0o700 },
);
chmodSync(claude, 0o700);
const codex = join(fixture.root, "codex");
writeFileSync(codex, fakeCodexScript(node, wsModule), { mode: 0o700 });
chmodSync(codex, 0o700);
const codexLog = join(fixture.root, "fake-codex.log");
writeFileSync(codexLog, "", { mode: 0o600 });

const integrationSocket = join(fixture.root, "ci.sock");
const executablePath = `${dirname(node)}:/usr/bin:/bin`;
const launcher = (name: string) => [join(repositoryRoot, `apps/server/dist/${name}.js`)];
const host = await startDurableSessionHost(
  DurableSessionHostConfigSchema.parse({
    ...fixture.config,
    profiles: [
      {
        profileId: "shell",
        executable: "/bin/zsh",
        args: ["-f"],
        envPolicyId: "safe-env",
        resourcePolicyId: "fixture-resource",
      },
      {
        profileId: "claude-code",
        executable: node,
        args: launcher("claude-integration-launcher"),
        envPolicyId: "safe-env",
        resourcePolicyId: "fixture-resource",
      },
      {
        profileId: "codex-main",
        executable: node,
        args: launcher("codex-integration-launcher"),
        envPolicyId: "safe-env",
        resourcePolicyId: "fixture-resource",
      },
    ],
    environmentPolicies: [
      {
        envPolicyId: "safe-env",
        inherit: [],
        values: {
          PATH: executablePath,
          HOME: fixture.root,
          FAKE_CODEX_LOG: codexLog,
          NARU_CODEX_INTEGRATION_SOCKET: integrationSocket,
          NARU_CLAUDE_HOOK_RUNNER: node,
          NARU_CLAUDE_HOOK_ENTRY: join(
            repositoryRoot,
            "apps/server/dist/claude-integration-hook-cli.js",
          ),
        },
      },
    ],
    resourcePolicies: [
      {
        ...fixture.config.resourcePolicies[0],
        allowedExecutables: [node, "/bin/zsh"],
        stopTimeoutMs: 5_000,
      },
    ],
    integrationPolicies: [
      {
        policyRef: "naru-claude-v0",
        appId: "fixture-app",
        integrationKind: "claude",
        profileIds: ["claude-code"],
        configKeys: ["policyRef", "bindingId"],
      },
      {
        policyRef: "naru-codex-v0",
        appId: "fixture-app",
        integrationKind: "codex",
        profileIds: ["codex-main"],
        configKeys: ["policyRef", "bindingId"],
      },
    ],
  }),
  { logger: silentHostLogger, hostEnvironment: {} },
);

const port = Number(process.env.SANDBOX_PORT ?? (await freePort()));
const origin = `http://127.0.0.1:${port}`;
const password = randomUUID().slice(0, 12);
const environmentFile = join(fixture.root, "naru.env");
writeFileSync(
  environmentFile,
  Object.entries({
    NODE_ENV: "production",
    NARU_AUTH_MODE: "app-managed",
    NARU_PORT: String(port),
    NARU_ALLOWED_ORIGINS: origin,
    NARU_PROJECT_ROOTS: projectRoot,
    NARU_DATA_DIR: join(fixture.root, "naru-data"),
    NARU_WEB_DIST: join(repositoryRoot, "apps/web/dist"),
    NARU_PASSWORD_HASH: await hashPassword(password),
    NARU_SESSION_SECRET: `${randomUUID()}${randomUUID()}`,
    NARU_SESSION_OWNER: "durable-host",
    NARU_DURABLE_SESSION_SOCKET_PATH: fixture.config.socketPath,
    NARU_DURABLE_SESSION_CREDENTIAL_FILE: fixture.credentialFile,
    NARU_DURABLE_SESSION_APP_ID: "fixture-app",
    NARU_DURABLE_SESSION_SUBJECT: "fixture-owner",
    NARU_DURABLE_SESSION_IDEMPOTENCY_TTL_MS: "30000",
    NARU_DURABLE_SESSION_PROFILE_IDS: JSON.stringify(["shell", "claude-code", "codex-main"]),
    NARU_DURABLE_SESSION_ROOTS: JSON.stringify({ projects: projectRoot }),
    NARU_CODEX_INTEGRATION_SOCKET_PATH: integrationSocket,
    NARU_CLAUDE_PATH: claude,
    NARU_CODEX_PATH: codex,
    NARU_CLAUDE_AGENT_SDK_PATH: sdkEntry,
    NARU_AGENT_PLATFORM: "1",
  })
    .map(([key, value]) => `${key}='${value}'`)
    .join("\n"),
  { mode: 0o600 },
);
const logFile = join(fixture.root, "naru.log");
const logDescriptor = openSync(logFile, "a", 0o600);
const server: ChildProcess = spawn(node, [join(repositoryRoot, "apps/server/dist/index.js")], {
  cwd: repositoryRoot,
  env: { PATH: executablePath, HOME: fixture.root, NARU_ENV_FILE: environmentFile },
  stdio: ["ignore", logDescriptor, logDescriptor],
});
closeSync(logDescriptor);
for (let attempt = 0; attempt < 100; attempt += 1) {
  if ((await fetch(`${origin}/healthz`).catch(() => null))?.ok === true) break;
  await new Promise((done) => setTimeout(done, 200));
}
process.stdout.write(
  `SANDBOX ${origin} password ${password} project ${join(projectRoot, "sample")}\n`,
);

const shutdown = async (): Promise<void> => {
  server.kill("SIGTERM");
  await new Promise((done) => setTimeout(done, 1_000));
  await host.close();
  rmSync(fixture.root, { recursive: true, force: true });
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      probe.close(() => done(typeof address === "object" && address !== null ? address.port : 0));
    });
  });
}
