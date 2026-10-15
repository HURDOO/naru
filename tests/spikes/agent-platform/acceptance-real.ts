/**
 * AP-T18 real-model acceptance: the built Naru server and an isolated Host, with the user's own
 * Claude Agent SDK and CLI login (model as configured for each role). Projects are small fixture git
 * repositories under the owner-only experiments area.
 *
 * - A02: the user gives the main orchestrator goals for two projects; the real orchestrators plan.
 * - A04: a real worker uses a native subagent; Naru observes it (observe-only, AP-D014).
 * - A08: a real worker starts a localhost-only dev server through Naru; the user can see it.
 * - AP17: a real worker's command waits for the person; its Pane shows the existing input-needed
 *   state (which alerts the person's devices) until the person answers (AP-D017).
 *
 * Tool approvals other than Naru's own tools are denied by this runner (the person's role); it
 * prints only metadata (counts, statuses, provenance links), never conversation text.
 *
 * Run (Node 24) after `pnpm build`:
 *   NARU_REAL_SDK=<sdk.mjs> NARU_REAL_CLAUDE=<claude> NARU_REAL_DIR=<owner-only dir> \
 *     node --import tsx tests/spikes/agent-platform/acceptance-real.ts [a02,a04,a08,ap17]
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startNaruStack } from "./naru-stack.js";

type Json = Record<string, unknown>;
const required = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value === "") throw new Error(`${name} is required`);
  return value;
};
const scenarios = new Set((process.argv[2] ?? "a02,a04,a08").split(","));
const runDirectory = join(required("NARU_REAL_DIR"), `run-${Date.now()}`);
const projectRoot = join(runDirectory, "projects");
mkdirSync(projectRoot, { recursive: true, mode: 0o700 });

function git(cwd: string, ...args: string[]): void {
  execFileSync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  });
}
for (const name of ["alpha", "beta"]) {
  const path = join(projectRoot, name);
  mkdirSync(join(path, "docs"), { recursive: true });
  writeFileSync(join(path, "README.md"), `# ${name}\n\nA small fixture project.\n`);
  writeFileSync(join(path, "docs", "plan.md"), "# Plan\n\n- (empty)\n");
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "add", ".");
  git(path, "commit", "--quiet", "-m", "initial");
}

const stack = await startNaruStack({
  projectRoot: realpathSync(projectRoot),
  real: {
    sdkPath: required("NARU_REAL_SDK"),
    claudePath: required("NARU_REAL_CLAUDE"),
    home: required("HOME"),
    user: required("USER"),
  },
});

let cookie = "";
let headers: Record<string, string> = {};
let heartbeat: ReturnType<typeof setInterval> | undefined;
async function signIn(): Promise<void> {
  const response = await fetch(`${stack.origin}/api/auth/login`, {
    method: "POST",
    headers: { origin: stack.origin, "content-type": "application/json" },
    body: JSON.stringify({ password: stack.password }),
  });
  cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  const { csrfToken } = (await response.json()) as { csrfToken: string };
  const { WebSocket } = (await import("node:module")).createRequire(
    join(process.cwd(), "apps/server/package.json"),
  )("ws") as { WebSocket: new (url: string, options: Json) => WsLike };
  const socket = new WebSocket(`${stack.origin.replace("http", "ws")}/api/terminal`, {
    headers: { cookie, origin: stack.origin },
  });
  const state = await new Promise<{ connectionId: string; generation: number }>((resolve) => {
    socket.on("message", (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as Json;
      if (frame.type === "surface.state" && typeof frame.connectionId === "string") {
        resolve({ connectionId: frame.connectionId, generation: Number(frame.generation) });
      }
    });
    socket.on("open", () =>
      socket.send(JSON.stringify({ type: "lease.acquire", clientId: randomUUID() })),
    );
  });
  // Keep the device lease like a browser does; without heartbeats it expires.
  clearInterval(heartbeat);
  heartbeat = setInterval(
    () =>
      socket.send(
        JSON.stringify({
          type: "heartbeat",
          sentAt: Date.now(),
          leaseGeneration: state.generation,
          presence: { visible: true, focused: true, interactionRevision: 0 },
        }),
      ),
    15_000,
  );
  headers = {
    origin: stack.origin,
    cookie,
    "x-csrf-token": csrfToken,
    "content-type": "application/json",
    "x-naru-surface-connection": state.connectionId,
    "x-naru-surface-generation": String(state.generation),
  };
}
interface WsLike {
  on(event: string, listener: (data: Buffer) => void): void;
  send(data: string): void;
  terminate(): void;
}
const get = async <T>(path: string): Promise<T> =>
  (await (await fetch(`${stack.origin}${path}`, { headers: { cookie } })).json()) as T;
const post = async <T>(path: string, body: Json): Promise<T> => {
  const response = await fetch(`${stack.origin}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const code = ((await response.json().catch(() => ({}))) as { code?: string }).code ?? "";
    throw new Error(`POST ${path}: ${response.status} ${code}`);
  }
  return (await response.json()) as T;
};

interface Agent {
  id: string;
  role: string;
  status: string;
  paneId: string | null;
}
interface View {
  activePlan: Json | null;
  tasks: { id: string; status: string; originInstructionId: string }[];
  agents: Agent[];
  processes: { purpose: string; status: string; ports: number[] }[];
  pendingApprovals: { agentSessionId: string; requestId: string; summary?: string }[];
}
const denied: string[] = [];
/** The person's side: deny everything but what the scenario needs (Naru tools never ask). */
async function answerApprovals(projectId: string, allow: RegExp | null): Promise<void> {
  const view = await get<View>(`/api/agent/projects/${projectId}`);
  for (const approval of view.pendingApprovals) {
    const summary = approval.summary ?? "";
    const decision = allow !== null && allow.test(summary) ? "approve" : "deny";
    if (decision === "deny") denied.push(summary.split(":")[0] ?? "");
    await post(
      `/api/agent/agents/${approval.agentSessionId}/approvals/${encodeURIComponent(approval.requestId)}`,
      { decision },
    ).catch(() => undefined);
  }
}
async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  ms: number,
  onTick?: () => Promise<void>,
): Promise<T> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    await onTick?.();
    const value = await read().catch(() => undefined);
    if (value !== undefined && done(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
  throw new Error(`timed out: ${label}`);
}
const results: string[] = [];
const report = (id: string, ok: boolean, evidence: string) => {
  const line = `${ok ? "PASS" : "FAIL"} ${id}: ${evidence}`;
  results.push(line);
  process.stdout.write(`${line}\n`);
};

let exitCode = 0;
try {
  await signIn();
  const projects: Record<string, string> = {};
  for (const name of ["alpha", "beta"]) {
    projects[name] = (
      await post<{ id: string }>("/api/projects", {
        path: join(realpathSync(projectRoot), name),
        name,
      })
    ).id;
  }

  if (scenarios.has("a02")) {
    await post("/api/agent/agents", {
      role: "main-orchestrator",
      hostProjectId: projects.alpha,
      runtime: "claude",
      idempotencyKey: randomUUID(),
    });
    const goal = await post<{ id: string }>("/api/agent/instructions", {
      scope: { kind: "global" },
      verbatim: [
        "두 프로젝트에 목표를 줄게. 각 프로젝트의 오케스트레이터가 계획과 작업만 만들게 해 줘.",
        "작업자는 아직 띄우지 말고, 코드는 고치지 마.",
        "alpha: README.md에 프로젝트 소개 문단을 보강하는 작업 1개",
        "beta: docs/plan.md에 다음 단계 3개를 정리하는 작업 1개",
      ].join("\n"),
      idempotencyKey: randomUUID(),
    });
    const planned = await until(
      () =>
        Promise.all(
          ["alpha", "beta"].map((name) => get<View>(`/api/agent/projects/${projects[name]!}`)),
        ),
      (views) => views.every((view) => view.activePlan !== null && view.tasks.length >= 1),
      "both projects planned",
      20 * 60_000,
      async () => {
        for (const name of ["alpha", "beta"]) await answerApprovals(projects[name]!, null);
      },
    );
    const origins = planned.flatMap((view) => view.tasks.map((task) => task.originInstructionId));
    const orchestrators = planned.map((view) =>
      view.agents.filter((agent) => agent.role === "project-orchestrator"),
    );
    report(
      "A02",
      orchestrators.every((list) => list.length === 1 && list[0]!.paneId !== null) &&
        origins.every((origin) => origin === goal.id),
      `real main spawned one project orchestrator per project; plans and tasks (${planned.map((view) => view.tasks.length).join(", ")}) cite the user's global instruction; workers spawned: ${planned.map((view) => view.agents.filter((agent) => agent.role === "worker").length).join(", ")}`,
    );
  }

  if (scenarios.has("a04") || scenarios.has("a08") || scenarios.has("ap17")) {
    const worker = await post<Agent>("/api/agent/agents", {
      projectId: projects.beta,
      role: "worker",
      runtime: "claude",
      idempotencyKey: randomUUID(),
    });
    await until(
      () => get<{ connected: boolean }>(`/api/agent/agents/${worker.id}/runtime`),
      (state) => state.connected,
      "worker connected",
      5 * 60_000,
    );
    await post(`/api/agent/agents/${worker.id}/hold`, {
      held: true,
      surface: "chat",
      idempotencyKey: randomUUID(),
    });
    const turn = async (text: string) => {
      const state = await get<{ generation: number }>(`/api/agent/agents/${worker.id}/runtime`);
      await post(`/api/agent/agents/${worker.id}/turns`, {
        text,
        generation: state.generation,
        idempotencyKey: randomUUID(),
      });
    };
    if (scenarios.has("a04")) {
      await turn(
        "Task 도구로 general-purpose 서브에이전트를 하나 띄워서 README.md의 첫 줄을 읽게 하고, 그 결과를 한 단어로 답해 줘. 다른 도구는 쓰지 마.",
      );
      let seenChildren = 0;
      await until(
        () =>
          get<{ turnActive: boolean; children: unknown[] }>(
            `/api/agent/agents/${worker.id}/runtime`,
          ),
        (state) => {
          seenChildren = Math.max(seenChildren, state.children.length);
          return !state.turnActive && seenChildren > 0;
        },
        "subagent observed and turn ended",
        10 * 60_000,
        () => answerApprovals(projects.beta!, /^(Task|Agent|Read)/u),
      );
      report(
        "A04",
        seenChildren > 0,
        `Naru observed ${seenChildren} native subagent(s) under the real worker while the turn ran (observe-only)`,
      );
    }
    if (scenarios.has("ap17")) {
      // Not a read-only command, so Claude asks before running it.
      await turn(
        "Bash 도구로 `python3 -c 'print(21*2)'` 명령을 한 번 실행하고, 출력된 숫자만 답해 줘.",
      );
      const paneState = async (): Promise<string> => {
        const view = await get<View>(`/api/agent/projects/${projects.beta!}`);
        const paneId = view.agents.find((agent) => agent.id === worker.id)?.paneId;
        const workspace = await get<{ panes: { id: string; activity: { state: string } }[] }>(
          `/api/projects/${projects.beta!}/workspace`,
        );
        return workspace.panes.find((pane) => pane.id === paneId)?.activity.state ?? "?";
      };
      await until(
        () => get<{ turnActive: boolean }>(`/api/agent/agents/${worker.id}/runtime`),
        (state) => state.turnActive,
        "command turn started",
        5 * 60_000,
      );
      const asked = await until(
        async () => ({
          view: await get<View>(`/api/agent/projects/${projects.beta!}`),
          runtime: await get<{ turnActive: boolean; connected: boolean }>(
            `/api/agent/agents/${worker.id}/runtime`,
          ),
        }),
        ({ view, runtime }) =>
          view.pendingApprovals.some((approval) => approval.agentSessionId === worker.id) ||
          !runtime.turnActive,
        "command approval requested or turn ended",
        10 * 60_000,
      );
      if (!asked.view.pendingApprovals.some((approval) => approval.agentSessionId === worker.id)) {
        throw new Error("the turn ended without asking for the command");
      }
      const waiting = await paneState();
      await until(
        () => get<{ turnActive: boolean }>(`/api/agent/agents/${worker.id}/runtime`),
        (state) => !state.turnActive,
        "approved turn ended",
        10 * 60_000,
        () => answerApprovals(projects.beta!, /^Bash/u),
      );
      const answered = await paneState();
      report(
        "AP17",
        waiting === "interaction-required" && answered !== "interaction-required",
        `while the real worker's command waited for the person its Pane was "${waiting}"; after the person approved it was "${answered}"`,
      );
    }
    if (scenarios.has("a08")) {
      await turn(
        "naru MCP의 start_process 도구로 개발 서버를 띄워 줘. command는 `python3 -m http.server 8765 --bind 127.0.0.1`, purpose는 '정적 서버', ports는 [8765], keep은 'keep'. 띄운 뒤 read_process_screen으로 화면을 한 번 확인하고 한 문장으로 알려 줘.",
      );
      const view = await until(
        () => get<View>(`/api/agent/projects/${projects.beta!}`),
        (state) => state.processes.some((process) => process.status === "running"),
        "dev server running",
        10 * 60_000,
        () => answerApprovals(projects.beta!, null),
      );
      const response = await fetch("http://127.0.0.1:8765/").catch(() => null);
      report(
        "A08",
        response?.ok === true,
        `the real worker started "${view.processes[0]?.purpose ?? "?"}" through Naru (status running, ports ${JSON.stringify(view.processes[0]?.ports ?? [])}); it answered HTTP ${response?.status ?? "none"} on localhost`,
      );
    }
  }
} catch (error) {
  exitCode = 1;
  process.stdout.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
} finally {
  process.stdout.write(`denied approvals (tool names only): ${JSON.stringify(denied)}\n`);
  clearInterval(heartbeat);
  writeFileSync(join(runDirectory, "results.txt"), `${results.join("\n")}\n`, { mode: 0o600 });
  await stack.stop();
  process.exit(exitCode || (results.some((line) => line.startsWith("FAIL")) ? 1 : 0));
}
