/**
 * AP-T17 UI sandbox: the built Naru server and web app with the Agent Platform enabled, against an
 * isolated DurableSession Host, scripted runtimes (a stand-in Claude SDK and TUI, a fake Codex) and
 * a temp project. It keeps running until SIGINT/SIGTERM and removes everything on exit. The stand-in
 * SDK uses its plan's own Naru MCP capability, so demo data goes through the real agent path.
 *
 * Run (Node 24) after `pnpm build`: node --import tsx tests/spikes/agent-platform/ui-sandbox.ts
 */
import { join } from "node:path";
import { startNaruStack } from "./naru-stack.js";

// Stand-in Claude SDK: answers turns; "DEMO" uses the agent's own Naru MCP capability to start a
// shared process and ask the user for a manual test; "PLAN" proposes an intent contract, a plan and
// tasks; "APPROVE" asks for a tool approval.
const SDK = `import { createConnection } from "node:net";
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
`;

const stack = await startNaruStack({
  sdkSource: SDK,
  ...(process.env.SANDBOX_PORT === undefined ? {} : { port: Number(process.env.SANDBOX_PORT) }),
});
process.stdout.write(
  `SANDBOX ${stack.origin} password ${stack.password} project ${join(stack.projectRoot, "sample")}\n`,
);

const shutdown = async (): Promise<void> => {
  await stack.stop();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
