// Stand-in Claude Agent SDK for the UI sandbox (AP-T17, AP-T20). Each agent's runner loads it in
// its own process. Turns produce Claude-shaped history (thinking, tool calls with results, a
// markdown answer), and keywords in the turn or in the delegated work act through the agent's own
// Naru MCP capability, so everything the screens show went through the real agent path:
//   main orchestrator: "@project" mentions → starts project orchestrators and delegates "PLAN"
//   PLAN (project orchestrator): intent contract, plan, two workers and a reviewer, four tasks
//   WORK (worker): edits, a test run, a test artifact, progress, review status
//   APPROVE: asks the person to allow a command; ASK: asks for a product decision
//   DEMO: starts a shared process and asks for a manual test; SLOW: a long turn
//   with PLAN (AP-D034): QUIET workers never ask (the team can stall), LIVE workers stay on one
//   tool call for a while, MISDELEGATE sends a review the wrong way and records the refusal,
//   FINISH marks every task done at once
/* global setTimeout, AbortController */
import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";

const SESSION = randomUUID();
const said = [];
/** Instructions already acted on: a later wakeup about other events must not redo them. */
const handled = new Set();

function naru(options, tool, args) {
  const server = options.mcpServers.naru;
  return new Promise((resolve) => {
    const socket = createConnection(server.env.NARU_AGENT_SOCKET);
    let buffered = "";
    socket.on("connect", () =>
      socket.write(
        JSON.stringify({
          version: 1,
          capability: server.env.NARU_AGENT_CAPABILITY,
          tool,
          arguments: args,
        }) + "\n",
      ),
    );
    socket.on("data", (chunk) => {
      buffered += chunk;
    });
    socket.on("end", () => {
      try {
        resolve(JSON.parse(buffered).result);
      } catch {
        resolve(undefined);
      }
    });
    socket.on("error", () => resolve(undefined));
  });
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/**
 * Asks Naru to allow a command the way the real SDK does: with the rule it proposes for "always
 * allow", and reports how the person answered.
 */
async function ask(options, command) {
  const result = await options.canUseTool(
    "Bash",
    { command },
    {
      signal: new AbortController().signal,
      suggestions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: `${command.split(" ")[0]}:*` }],
          behavior: "allow",
          destination: "localSettings",
        },
      ],
    },
  );
  if (result.behavior !== "allow") return "거부됨";
  return result.updatedPermissions?.every((update) => update.destination === "session")
    ? "이 세션 동안 허용됨"
    : "한 번 허용됨";
}

function assistant(content) {
  said.push({ type: "assistant", message: { role: "assistant", content } });
}

function think(text) {
  assistant([{ type: "thinking", thinking: text }]);
}

/** One tool call and its result, the way Claude's session records them. */
function tool(name, input, result, isError = false) {
  const id = `toolu_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
  assistant([{ type: "tool_use", id, name, input }]);
  said.push({
    type: "user",
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content: result, is_error: isError }],
    },
  });
}

function answer(text) {
  assistant([{ type: "text", text }]);
}

const READ_TOOLS = new Set([
  "get_project_state",
  "list_projects",
  "list_agents",
  "get_delegated_work",
  "get_applicable_user_instructions",
]);

/** Calls a Naru tool and records it in the history like a real MCP call. */
async function act(options, name, args) {
  const result = await naru(
    options,
    name,
    READ_TOOLS.has(name) ? args : { ...args, idempotency_key: randomUUID() },
  );
  tool(`mcp__naru__${name}`, args, JSON.stringify(result ?? { error: true }).slice(0, 300));
  return result;
}

function roleOf(options) {
  const text = options.systemPrompt?.append ?? "";
  for (const role of ["main-orchestrator", "project-orchestrator", "reviewer", "specialist"]) {
    if (text.includes(`Naru-managed ${role} agent`)) return role;
  }
  return "worker";
}

async function mainOrchestrator(options, goal, origin) {
  const projects = (await act(options, "list_projects", {})) ?? [];
  const named = projects.filter((project) => goal.includes(`@${project.name}`));
  if (named.length === 0) {
    answer("어느 프로젝트의 일인지 알려 주세요. `@프로젝트` 로 적어 주시면 나눠 맡기겠습니다.");
    return;
  }
  for (const project of named) {
    if (!project.hasOrchestrator) {
      await act(options, "spawn_agent", {
        project_id: project.projectId,
        role: "project-orchestrator",
        runtime: "claude",
      });
    }
    await act(options, "delegate", {
      scope_kind: "project",
      project_id: project.projectId,
      verbatim: `PLAN ${project.name}: ${goal.replaceAll(/@\S+/gu, "").trim()}`,
      origin_user_instruction_id: origin.id,
    });
  }
  answer(
    [
      `프로젝트 ${named.length}개에 나눠 맡겼습니다.`,
      "",
      ...named.map((project) => `- **${project.name}**: 오케스트레이터가 계획부터 세웁니다`),
      "",
      "계획과 의도 계약이 올라오면 관제실의 ‘나를 기다리는 것’에서 확인해 주세요.",
    ].join("\n"),
  );
}

async function plan(options, goal, origin, projectId) {
  think("요구를 화면, 세션, 등록, 통합 검증으로 나누고 의존 관계를 정한다.");
  tool("Glob", { pattern: "src/**/*.ts" }, "src/app.ts\nsrc/login.ts\nsrc/session.ts");
  await act(options, "propose_intent_contract", {
    project_id: projectId,
    source_instruction_id: origin.id,
    principles: ["로그인은 passkey만 쓴다", "기존 세션 모델을 재사용한다"],
    allowed_choices: ["화면 구성과 문구"],
    require_approval_if: ["새 인증 방식을 더할 때"],
    forbidden: ["비밀번호를 저장하지 않는다"],
  });
  const planned = await act(options, "create_plan", {
    project_id: projectId,
    summary:
      "1. 로그인 화면을 정리한다\n2. 세션 API와 passkey 등록을 나눠 만든다\n3. 통합 테스트로 묶고 리뷰 뒤 병합한다",
    activate: true,
  });
  const spawn = (role) =>
    act(options, "spawn_agent", { project_id: projectId, role, runtime: "claude" });
  const first = await spawn("worker");
  const second = await spawn("worker");
  const reviewer = await spawn("reviewer");
  const task = (title, purpose, assignee, dependsOn) =>
    act(options, "create_task", {
      project_id: projectId,
      plan_id: planned?.id,
      title,
      purpose,
      completion_criteria: ["pnpm test 통과", "리뷰 두 개 통과"],
      origin_instruction_id: origin.id,
      ...(assignee === undefined ? {} : { assignee_agent_session_id: assignee }),
      ...(dependsOn === undefined ? {} : { depends_on: dependsOn }),
    });
  const screen = await task(
    "로그인 화면 정리",
    "비밀번호 입력을 없애고 passkey 버튼만 남긴다",
    first?.id,
  );
  const api = await task("세션 API", "passkey 로그인 뒤 세션을 발급·갱신·만료한다", second?.id, [
    screen?.id,
  ]);
  const register = await task("passkey 등록", "회원이 passkey를 등록할 수 있게 한다", first?.id, [
    screen?.id,
  ]);
  const integration = await task("통합 테스트", "화면, API, 등록을 함께 검증한다", reviewer?.id, [
    api?.id,
    register?.id,
  ]);
  await act(options, "update_task", { task_id: screen?.id, expected_revision: 1, status: "done" });
  if (goal.includes("FINISH")) {
    for (const item of [api, register, integration]) {
      await act(options, "update_task", {
        task_id: item?.id,
        expected_revision: 1,
        status: "done",
      });
    }
    answer("나눈 일을 모두 끝냈습니다.");
    return;
  }
  const quiet = goal.includes("QUIET");
  const live = goal.includes("LIVE") ? " LIVE" : "";
  for (const [work, agent, text] of [
    [
      api,
      second,
      `세션 API를 맡아 줘. 세션은 30분 동안 쓰지 않으면 만료돼야 해. WORK${quiet ? "" : " APPROVE"}${live}`,
    ],
    [
      register,
      first,
      `passkey 등록을 맡아 줘. 비밀번호 로그인은 새로 만들지 마. WORK${quiet ? "" : " ASK"}${live}`,
    ],
  ]) {
    await act(options, "start_run", {
      task_id: work?.id,
      agent_session_id: agent?.id,
      runtime: "claude",
    });
    await act(options, "update_task", {
      task_id: work?.id,
      expected_revision: 1,
      status: "running",
    });
    await act(options, "delegate", {
      scope_kind: "agent",
      project_id: projectId,
      agent_session_id: agent?.id,
      verbatim: text,
      origin_user_instruction_id: origin.id,
    });
  }
  if (goal.includes("MISDELEGATE")) {
    // The mistake seen on a real team: a review sent as a task-scoped delegate reaches the
    // assignee, not the reviewer. Naru now refuses it instead of dropping the reviewer.
    await act(options, "delegate", {
      scope_kind: "task",
      project_id: projectId,
      task_id: screen?.id,
      agent_session_id: reviewer?.id,
      verbatim: "로그인 화면 정리를 리뷰해 줘",
      origin_user_instruction_id: origin.id,
    });
  }
  answer(
    [
      "계획을 세우고 일을 나눴습니다.",
      "",
      "| 작업 | 맡은 에이전트 | 먼저 끝나야 하는 것 |",
      "| --- | --- | --- |",
      "| 로그인 화면 정리 | 작업자 1 | — |",
      "| 세션 API | 작업자 2 | 로그인 화면 정리 |",
      "| passkey 등록 | 작업자 1 | 로그인 화면 정리 |",
      "| 통합 테스트 | 리뷰어 1 | 세션 API, passkey 등록 |",
      "",
      "의도 계약을 승인해 주시면 그 원칙 안에서 진행합니다.",
    ].join("\n"),
  );
}

async function work(options, goal) {
  think("맡은 작업의 완료 조건을 확인하고 바꿀 파일을 정한다.");
  tool("Read", { file_path: "src/session.ts" }, "export function issueSession() {\n  // TODO\n}");
  tool("Grep", { pattern: "issueSession", path: "src" }, "src/session.ts:1\nsrc/routes.ts:12");
  tool(
    "Edit",
    {
      file_path: "src/session.ts",
      old_string: "export function issueSession() {\n  // TODO\n}",
      new_string:
        "const IDLE_MS = 30 * 60_000;\n\nexport function issueSession(user: string) {\n  return { user, expiresAt: Date.now() + IDLE_MS };\n}",
    },
    "The file src/session.ts has been updated.",
  );
  tool(
    "Write",
    {
      file_path: "src/session.test.ts",
      content:
        "import { issueSession } from './session';\n\ntest('expires', () => {\n  expect(issueSession('a').expiresAt).toBeGreaterThan(Date.now());\n});\n",
    },
    "File created successfully at: src/session.test.ts",
  );
  answer(
    "구현을 마쳤습니다. `issueSession`이 30분 뒤 만료 시각을 돌려줍니다. 테스트로 확인하겠습니다.",
  );
  if (goal.includes("APPROVE")) {
    const answer = await ask(options, "pnpm test --filter auth");
    tool(
      "Bash",
      { command: "pnpm test --filter auth" },
      `(${answer})\n✓ session.test.ts (3)\n\nTest Files  1 passed\nTests  3 passed`,
    );
  }
}

export function query({ prompt, options }) {
  const role = roleOf(options);
  async function* run() {
    yield { type: "system", subtype: "init", session_id: options.resume ?? SESSION };
    for await (const message of prompt) {
      const text = message.message.content;
      said.push({ type: "user", message: { role: "user", content: text } });
      let goal = text;
      let origin;
      let latest;
      if (text.startsWith("[Naru] New events")) {
        const delegated =
          role === "main-orchestrator"
            ? {
                instructions: (await act(options, "get_applicable_user_instructions", {})) ?? [],
                origins: [],
              }
            : ((await act(options, "get_delegated_work", {})) ?? { instructions: [], origins: [] });
        latest = delegated.instructions.at(-1);
        if (latest !== undefined && handled.has(latest.id)) latest = undefined;
        if (latest !== undefined) handled.add(latest.id);
        goal = latest?.verbatim ?? "";
        origin =
          latest === undefined
            ? undefined
            : latest.author.kind === "human"
              ? latest
              : (delegated.origins.find((item) => item.id === latest.originUserInstructionId) ??
                latest);
      }
      if (role === "main-orchestrator" && origin !== undefined) {
        think("목표에 나온 프로젝트를 찾고, 프로젝트마다 오케스트레이터에게 계획부터 맡긴다.");
        await mainOrchestrator(options, goal, origin);
      } else if (goal.includes("PLAN") && origin !== undefined) {
        const projectId = latest?.scope.projectId ?? origin.scope.projectId;
        await plan(options, goal, origin, projectId);
      } else if (goal.includes("WORK")) {
        if (goal.includes("LIVE")) {
          // Streamed the way the SDK does, so Naru shows the call while it runs (AP-D034).
          yield {
            type: "assistant",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 20)}`,
                  name: "Edit",
                  input: { file_path: "src/session.ts" },
                },
              ],
            },
          };
          await sleep(45_000);
        }
        await work(options, goal);
        if (goal.includes("ASK")) {
          const projectId = latest?.scope.projectId ?? null;
          const state =
            projectId === null
              ? undefined
              : await act(options, "get_project_state", { project_id: projectId });
          const blocked = (state?.tasks ?? [])
            .filter((item) => goal.includes(item.title))
            .map((item) => item.id);
          await act(options, "request_human_handoff", {
            kind: "product-decision",
            project_id: projectId,
            reason: "passkey 등록 화면을 설정 페이지 안에 둘까요, 별도 페이지로 둘까요?",
            blocking_task_ids: blocked,
            independent_work_to_continue: ["등록 API 테스트 작성"],
            options: [
              { label: "설정 안에", description: "찾기 쉽고 화면이 하나 줄어듭니다" },
              { label: "별도 페이지", description: "처음 가입 흐름에 넣기 쉽습니다" },
            ],
            recommendation: "설정 안에 두기 — 지금 화면 구조를 그대로 쓸 수 있습니다",
            risks: ["가입 직후 등록을 유도하기 어렵습니다"],
            prepared_environment: [],
            resume_condition: "사용자 결정",
          });
          answer(
            "등록 화면 위치를 정해 주시면 이어서 만들겠습니다. 그동안 API 테스트를 먼저 쓰겠습니다.",
          );
        }
      } else if (text.includes("DEMO")) {
        const started = await act(options, "start_process", {
          purpose: "개발 서버",
          command: "while true; do date; sleep 5; done",
          ports: [5173],
          keep: "keep",
        });
        await act(options, "request_human_handoff", {
          kind: "manual-test",
          project_id: started?.projectId ?? null,
          reason: "로그인 흐름을 직접 확인해 주세요.",
          blocking_task_ids: [],
          independent_work_to_continue: ["문서 정리"],
          options: [
            { label: "통과", description: "예상대로 동작함" },
            { label: "다시", description: "문제가 있음" },
          ],
          recommendation: "개발 서버에서 로그인 후 대시보드가 보이는지 확인",
          risks: ["테스트 계정 필요"],
          prepared_environment: ["개발 서버 :5173"],
          resume_condition: "사용자 결정",
        });
        answer("개발 서버를 띄웠습니다. 로그인 흐름을 직접 확인해 주세요.");
      } else if (!text.startsWith("[Naru] New events")) {
        // A person writing directly.
        think("사람이 직접 한 말을 먼저 반영한다.");
        // Naru reminds us of our open question; this reply answers it, so withdraw it.
        for (const match of text.matchAll(/- handoff ([0-9a-f-]{36}) /gu)) {
          await act(options, "cancel_handoff", { handoff_id: match[1] });
        }
        if (text.includes("APPROVE")) {
          const answer = await ask(options, "pnpm test");
          tool("Bash", { command: "pnpm test" }, `(${answer})\nTests  12 passed`);
        }
        if (text.includes("SLOW")) await sleep(8000);
        answer(
          `알겠습니다. ${text.slice(0, 60)}\n\n- 먼저 지금 상태를 확인하고\n- 바꾼 뒤 테스트로 확인하겠습니다.`,
        );
      } else {
        answer("새 소식을 확인했습니다. 지금 할 일은 없습니다.");
      }
      await sleep(400);
      yield { type: "result", subtype: "success", is_error: false };
    }
  }
  const iterator = run();
  iterator.interrupt = async () => {};
  return iterator;
}

export async function getSessionMessages(_sessionId, { offset = 0, limit = 50 } = {}) {
  return said.slice(offset, offset + limit);
}
