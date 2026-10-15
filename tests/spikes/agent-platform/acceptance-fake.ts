/**
 * AP-T18 acceptance on stand-in runtimes, end to end through the built Naru server (production
 * entry point), an isolated Host and real git repositories.
 *
 * Agents are puppets: every turn Naru delivers to a managed agent (wakeups included) reaches this
 * runner, which decides the agent's tool calls; the agent then makes them with its own Naru
 * capability. So identity, scope, provenance, wakeups, Host Panes, holds, gates and merges are
 * Naru's real behaviour; only the model's judgement is scripted here. Human steps go through the
 * browser HTTP API under the device lease.
 *
 * Run (Node 24) after `pnpm build`:
 *   node --import tsx tests/spikes/agent-platform/acceptance-fake.ts
 * Prints one PASS/FAIL line per scenario and exits non-zero on a failure. Nothing touches the
 * user's own Naru, Host or accounts; the temp stack is removed at the end.
 */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { repositoryRoot, startNaruStack, type NaruStack } from "./naru-stack.js";

type Json = Record<string, unknown>;
interface ToolReply {
  readonly ok: boolean;
  readonly result?: unknown;
  readonly code?: string;
  readonly message?: string;
}
interface Turn {
  readonly agentId: string;
  readonly role: string;
  readonly text: string;
  call(tool: string, args: Json): Promise<ToolReply>;
}

const SURFACE_CONNECTION = "x-naru-surface-connection";
const SURFACE_GENERATION = "x-naru-surface-generation";
/** The part of the `ws` client used here (a server dependency, loaded from apps/server). */
interface WsClient {
  on(event: "open", listener: () => void): void;
  on(event: "message", listener: (data: Buffer) => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  send(data: string): void;
  terminate(): void;
}
const WebSocketClass = createRequire(join(repositoryRoot, "apps/server/package.json"))(
  "ws",
) as new (url: string, options: { headers: Record<string, string> }) => WsClient;
const text = (value: unknown): string => (typeof value === "string" ? value : "");

const results: { id: string; status: "PASS" | "FAIL"; evidence: string }[] = [];
function check(id: string, ok: boolean, evidence: string): void {
  results.push({ id, status: ok ? "PASS" : "FAIL", evidence });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${id}: ${evidence}\n`);
}

/** A stable UUID from a label, so a retried agent action reuses its idempotency key. */
function uuidFrom(label: string): string {
  const hex = createHash("sha256").update(label).digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

async function until<T>(
  read: () => Promise<T>,
  done: (value: T) => boolean,
  label: string,
  ms = 120_000,
): Promise<T> {
  const deadline = Date.now() + ms;
  let last: T | undefined;
  while (Date.now() < deadline) {
    try {
      last = await read();
      if (done(last)) return last;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  throw new Error(`timed out: ${label}`);
}

// Puppet SDK ---------------------------------------------------------------------------------------

function puppetSdk(socketPath: string): string {
  return `import { createConnection } from "node:net";
const PUPPET = ${JSON.stringify(socketPath)};
function naru(options, tool, args) {
  const server = options.mcpServers.naru;
  return new Promise((resolve) => {
    const socket = createConnection(server.env.NARU_AGENT_SOCKET);
    let buffered = "";
    socket.on("connect", () => socket.write(JSON.stringify({ version: 1, capability: server.env.NARU_AGENT_CAPABILITY, tool, arguments: args }) + "\\n"));
    socket.on("data", (chunk) => { buffered += chunk; });
    socket.on("end", () => { try { resolve(JSON.parse(buffered)); } catch { resolve({ ok: false, code: "NO_REPLY" }); } });
    socket.on("error", () => resolve({ ok: false, code: "SOCKET" }));
  });
}
function puppet(first, options) {
  return new Promise((resolve) => {
    const socket = createConnection(PUPPET);
    let buffered = "";
    socket.on("connect", () => socket.write(JSON.stringify(first) + "\\n"));
    socket.on("data", async (chunk) => {
      buffered += chunk;
      let index;
      while ((index = buffered.indexOf("\\n")) >= 0) {
        const line = buffered.slice(0, index);
        buffered = buffered.slice(index + 1);
        const message = JSON.parse(line);
        if (message.type === "done") { socket.end(); resolve(message.say ?? "done"); return; }
        const reply = await naru(options, message.tool, message.args);
        socket.write(JSON.stringify({ type: "result", reply }) + "\\n");
      }
    });
    socket.on("error", () => resolve("puppet unavailable"));
  });
}
export function query({ prompt, options }) {
  const said = [];
  const name = options.extraArgs?.name ?? "";
  const role = /## Role: ([a-z -]+)/.exec(options.systemPrompt?.append ?? "")?.[1] ?? "unknown";
  async function* run() {
    yield { type: "system", subtype: "init", session_id: options.resume ?? crypto.randomUUID() };
    for await (const message of prompt) {
      const text = message.message.content;
      said.push({ type: "user", message: { role: "user", content: text } });
      const say = await puppet({ type: "turn", name, role, text }, options);
      said.push({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: say }] } });
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
}

/** Serves puppet turns: each connection is one turn, a sequence of tool calls then "done". */
function servePuppets(
  socketPath: string,
  resolveAgent: (name: string) => Promise<string | null>,
  handle: (turn: Turn) => Promise<string | void>,
) {
  const server = createServer((socket: Socket) => {
    let buffered = "";
    let pending: ((reply: ToolReply) => void) | null = null;
    let lastTool = "";
    const send = (message: Json) => socket.write(`${JSON.stringify(message)}\n`);
    socket.on("data", (chunk: Buffer) => {
      buffered += chunk.toString("utf8");
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        const message = JSON.parse(buffered.slice(0, index)) as Json;
        buffered = buffered.slice(index + 1);
        if (message.type === "result") {
          const reply = message.reply as ToolReply;
          if (!reply.ok && process.env.PUPPET_TRACE === "1") {
            process.stdout.write(
              `  tool refused: ${lastTool} ${reply.code ?? ""} ${reply.message ?? ""}\n`,
            );
          }
          pending?.(reply);
          pending = null;
          continue;
        }
        void (async () => {
          const agentId = await resolveAgent(text(message.name));
          let say: string | void = "unknown agent";
          if (agentId !== null) {
            const turn: Turn = {
              agentId,
              role: text(message.role),
              text: text(message.text),
              call: (tool, args) =>
                new Promise<ToolReply>((resolve) => {
                  pending = resolve;
                  lastTool = tool;
                  send({ type: "call", tool, args });
                }),
            };
            try {
              say = await handle(turn);
            } catch (error) {
              say = `handler failed: ${error instanceof Error ? error.message : String(error)}`;
              process.stdout.write(`! ${say}\n`);
            }
          }
          send({ type: "done", say: say ?? "done" });
        })();
      }
    });
  });
  server.listen(socketPath);
  return server;
}

// Human client --------------------------------------------------------------------------------------

class Person {
  #cookie = "";
  #csrf = "";
  #headers: Record<string, string> = {};
  #socket: WsClient | null = null;

  constructor(readonly stack: NaruStack) {}

  async signIn(): Promise<void> {
    const response = await fetch(`${this.stack.origin}/api/auth/login`, {
      method: "POST",
      headers: { origin: this.stack.origin, "content-type": "application/json" },
      body: JSON.stringify({ password: this.stack.password }),
    });
    this.#cookie = (response.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    this.#csrf = ((await response.json()) as { csrfToken: string }).csrfToken;
    await this.takeLease();
  }

  /** The device lease, as a browser holds it, for writes. */
  async takeLease(): Promise<void> {
    this.#socket?.terminate();
    const socket = new WebSocketClass(`${this.stack.origin.replace("http", "ws")}/api/terminal`, {
      headers: { cookie: this.#cookie, origin: this.stack.origin },
    });
    this.#socket = socket;
    const state = await new Promise<{ connectionId: string; generation: number }>(
      (resolve, reject) => {
        socket.on("error", reject);
        socket.on("message", (data: Buffer) => {
          const frame = JSON.parse(data.toString()) as Json;
          if (
            frame.type === "surface.state" &&
            typeof frame.connectionId === "string" &&
            typeof frame.generation === "number"
          ) {
            resolve({ connectionId: frame.connectionId, generation: frame.generation });
          }
        });
        socket.on("open", () =>
          socket.send(JSON.stringify({ type: "lease.acquire", clientId: randomUUID() })),
        );
      },
    );
    this.#headers = {
      origin: this.stack.origin,
      cookie: this.#cookie,
      "x-csrf-token": this.#csrf,
      "content-type": "application/json",
      [SURFACE_CONNECTION]: state.connectionId,
      [SURFACE_GENERATION]: String(state.generation),
    };
  }

  async get<T>(path: string, retried = false): Promise<T> {
    const response = await fetch(`${this.stack.origin}${path}`, {
      headers: { cookie: this.#cookie },
    });
    // Naru restarted (sessions live in its process): sign in again like a browser would.
    if (response.status === 401 && !retried) {
      await this.signIn();
      return this.get<T>(path, true);
    }
    if (!response.ok) throw new Error(`GET ${path}: ${response.status}`);
    return (await response.json()) as T;
  }

  async post<T>(path: string, body: Json): Promise<T> {
    const response = await fetch(`${this.stack.origin}${path}`, {
      method: "POST",
      headers: this.#headers,
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`POST ${path}: ${response.status} ${await response.text()}`);
    }
    return (await response.json()) as T;
  }

  close(): void {
    this.#socket?.terminate();
  }
}

// Repositories --------------------------------------------------------------------------------------

const IDENTITY = {
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.test",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.test",
};
function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...IDENTITY,
    },
    encoding: "utf8",
  }).trim();
}
function makeRepository(path: string): void {
  mkdirSync(join(path, "docs"), { recursive: true });
  writeFileSync(join(path, "README.md"), "fixture\n");
  writeFileSync(join(path, "docs", "plan.md"), "# plan\n");
  git(path, "init", "--quiet", "--initial-branch=main");
  git(path, "add", ".");
  git(path, "commit", "--quiet", "-m", "initial");
}

// Scenario -----------------------------------------------------------------------------------------

interface AgentRecord {
  readonly id: string;
  readonly role: string;
  readonly projectId: string | null;
  readonly paneId: string | null;
  readonly status: string;
  readonly parentAgentSessionId: string | null;
}
interface TaskRecord {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly revision: number;
  readonly assigneeAgentSessionId: string | null;
}
interface ProjectView {
  readonly activePlan: { readonly id: string } | null;
  readonly tasks: TaskRecord[];
  readonly agents: AgentRecord[];
  readonly openHandoffs: { readonly id: string; readonly kind: string; readonly payload: Json }[];
  readonly processes: { readonly id: string; readonly purpose: string; readonly status: string }[];
}

/** What the scripted agents remember between turns (a model's own context in a real run). */
const memory = {
  handled: new Set<string>(),
  worktrees: new Map<string, { path: string; branch: string }>(),
  runs: new Map<string, string>(),
  handoffs: new Map<string, string>(),
  reviewRounds: new Map<string, number>(),
  received: new Map<string, string[]>(),
  mergeRefusals: new Map<string, string[]>(),
  needsReview: new Set<string>(),
  /** Which worker took which task (the worker's own memory of its assignment). */
  taskOwners: new Map<string, string>(),
};
function remember(taskId: string, reply: ToolReply): void {
  memory.mergeRefusals.set(taskId, [
    ...(memory.mergeRefusals.get(taskId) ?? []),
    `${reply.code ?? ""}: ${reply.message ?? ""}`,
  ]);
}
const once = (key: string) => (memory.handled.has(key) ? false : (memory.handled.add(key), true));

const PROJECT_PLANS: Record<string, { title: string; kind: string }[]> = {
  alpha: [
    { title: "alpha-screen", kind: "screen" },
    { title: "alpha-api", kind: "api" },
  ],
  beta: [
    { title: "beta-design", kind: "design" },
    { title: "beta-docs", kind: "docs" },
  ],
};

async function mainTurn(turn: Turn): Promise<string> {
  const instructions = (await turn.call("get_applicable_user_instructions", {})).result as Json[];
  const goal = instructions
    .filter((item) => (item.scope as Json).kind === "global" && typeof item.verbatim === "string")
    .at(-1);
  if (goal === undefined || !once(`main:${text(goal.id)}`)) return "nothing new";
  const projects = (await turn.call("list_projects", {})).result as Json[];
  for (const line of text(goal.verbatim).split("\n")) {
    const match = /^(\w+):\s*(.+)$/u.exec(line.trim());
    const project = projects.find((candidate) => candidate.name === match?.[1]);
    if (match === null || project === undefined) continue;
    const projectId = text(project.projectId);
    if (project.hasOrchestrator !== true) {
      await turn.call("spawn_agent", {
        project_id: projectId,
        role: "project-orchestrator",
        runtime: "claude",
        idempotency_key: uuidFrom(`spawn:${text(goal.id)}:${projectId}`),
      });
    }
    await turn.call("delegate", {
      scope_kind: "project",
      project_id: projectId,
      verbatim: match[2],
      origin_user_instruction_id: goal.id,
      idempotency_key: uuidFrom(`goal:${text(goal.id)}:${projectId}`),
    });
  }
  return "goals passed to the projects";
}

async function orchestratorTurn(turn: Turn, person: Person): Promise<string> {
  const work = (await turn.call("get_delegated_work", {})).result as {
    instructions: Json[];
  };
  const projectInstructions = work.instructions.filter(
    (item) => (item.scope as Json).kind === "project",
  );
  const projectId = text((projectInstructions[0]?.scope as Json | undefined)?.projectId);
  if (projectId === "") return "no project work yet";
  const projectName =
    (await person.get<{ id: string; name: string }[]>("/api/projects")).find(
      (project) => project.id === projectId,
    )?.name ?? "";
  const state = (await turn.call("get_project_state", { project_id: projectId })).result as {
    activePlan: Json | null;
    tasks: TaskRecord[];
  };

  for (const instruction of projectInstructions) {
    const id = text(instruction.id);
    if (!once(`po:${id}`)) continue;
    const origin = text(instruction.originUserInstructionId) || id;
    if (state.activePlan === null && once(`plan:${projectId}`)) {
      await planProject(turn, projectId, projectName, text(instruction.verbatim), origin);
      continue;
    }
    // A later user instruction: pass it to the workers of open tasks, citing it (A03).
    for (const task of state.tasks) {
      if (task.assigneeAgentSessionId === null || task.status === "done") continue;
      await turn.call("delegate", {
        scope_kind: "task",
        project_id: projectId,
        task_id: task.id,
        verbatim: `UPDATE ${task.id}: ${text(instruction.verbatim)}`,
        origin_user_instruction_id: origin,
        idempotency_key: uuidFrom(`update:${id}:${task.id}`),
      });
    }
  }

  // Tasks waiting for review get a reviewer; reviewed tasks are integrated.
  for (const task of state.tasks) {
    if (task.status !== "review") continue;
    const detail = (await turn.call("get_task_detail", { task_id: task.id })).result as {
      mergeGate: { open: boolean; reasons: string[] };
      reviews: Json[];
      artifacts: Json[];
    };
    const rounds = memory.reviewRounds.get(task.id) ?? 0;
    if (rounds === 0 || memory.needsReview.delete(task.id)) {
      await requestReview(turn, projectId, task, rounds);
      continue;
    }
    if (detail.reviews.length < rounds * 2) continue; // the reviewer is still at it
    if (!detail.mergeGate.open) {
      // Reviewed but rejected (A11): a merge is refused; it is fixed and reviewed again.
      const refused = await turn.call("merge_task", { task_id: task.id });
      remember(task.id, refused);
      await requestReview(turn, projectId, task, rounds);
      continue;
    }
    const hasBranch = detail.artifacts.some((artifact) => artifact.kind === "branch");
    const merged = hasBranch ? await turn.call("merge_task", { task_id: task.id }) : { ok: true };
    if (merged.ok) {
      await turn.call("update_task", {
        task_id: task.id,
        expected_revision: task.revision,
        status: "done",
      });
      continue;
    }
    remember(task.id, merged);
    if (/cannot fast-forward/u.test(merged.message ?? "")) {
      // A15: the branch diverged after another merge; rebase it and review it again.
      await turn.call("update_task", {
        task_id: task.id,
        expected_revision: task.revision,
        status: "running",
      });
      memory.needsReview.add(task.id);
      await turn.call("delegate", {
        scope_kind: "task",
        project_id: projectId,
        task_id: task.id,
        verbatim: `REBASE ${task.id} onto main`,
        origin_user_instruction_id: originOf(task.id),
        idempotency_key: uuidFrom(`rebase:${task.id}:${rounds}`),
      });
    }
  }
  return "project updated";
}

const taskOrigins = new Map<string, string>();
const originOf = (taskId: string) => taskOrigins.get(taskId) ?? "";

async function planProject(
  turn: Turn,
  projectId: string,
  projectName: string,
  goal: string,
  origin: string,
): Promise<void> {
  const plan = (
    await turn.call("create_plan", {
      project_id: projectId,
      summary: goal,
      activate: true,
      idempotency_key: uuidFrom(`plan:${projectId}`),
    })
  ).result as Json;
  for (const [index, item] of (PROJECT_PLANS[projectName] ?? []).entries()) {
    const worker = (
      await turn.call("spawn_agent", {
        project_id: projectId,
        role: "worker",
        runtime: "claude",
        idempotency_key: uuidFrom(`worker:${projectId}:${index}`),
      })
    ).result as Json;
    const task = (
      await turn.call("create_task", {
        project_id: projectId,
        plan_id: plan.id,
        title: item.title,
        purpose: goal,
        completion_criteria: ["tests pass"],
        assignee_agent_session_id: worker.id,
        origin_instruction_id: origin,
        idempotency_key: uuidFrom(`task:${projectId}:${index}`),
      })
    ).result as Json;
    const taskId = text(task.id);
    taskOrigins.set(taskId, origin);
    let worktree = "";
    if (item.kind === "screen" || item.kind === "api") {
      const created = (
        await turn.call("create_worktree", {
          task_id: taskId,
          slug: item.title,
          idempotency_key: uuidFrom(`worktree:${taskId}`),
        })
      ).result as { path: string; branch: string };
      memory.worktrees.set(taskId, created);
      worktree = ` worktree=${created.path}`;
    }
    const run = (
      await turn.call("start_run", {
        task_id: taskId,
        agent_session_id: worker.id,
        runtime: "claude",
        model: "puppet",
        idempotency_key: uuidFrom(`run:${taskId}`),
      })
    ).result as Json;
    memory.runs.set(taskId, text(run.id));
    await turn.call("delegate", {
      scope_kind: "task",
      project_id: projectId,
      task_id: taskId,
      verbatim: `TASK ${taskId} kind=${item.kind} run=${text(run.id)}${worktree}`,
      origin_user_instruction_id: origin,
      idempotency_key: uuidFrom(`assign:${taskId}`),
    });
  }
}

async function requestReview(turn: Turn, projectId: string, task: TaskRecord, round: number) {
  memory.reviewRounds.set(task.id, round + 1);
  const agents = (await turn.call("list_agents", { project_id: projectId }))
    .result as AgentRecord[];
  let reviewer = agents.find((agent) => agent.role === "reviewer")?.id;
  if (reviewer === undefined) {
    const spawned = await turn.call("spawn_agent", {
      project_id: projectId,
      role: "reviewer",
      runtime: "claude",
      idempotency_key: uuidFrom(`reviewer:${projectId}`),
    });
    reviewer = text((spawned.result as Json).id);
  }
  // The first round of alpha-screen finds an intent problem (A11); later rounds pass.
  const intent = task.title === "alpha-screen" && round === 0 ? "fail" : "pass";
  await turn.call("delegate", {
    scope_kind: "agent",
    project_id: projectId,
    agent_session_id: reviewer,
    verbatim: `REVIEW ${task.id} round=${round} intent=${intent}`,
    origin_user_instruction_id: originOf(task.id),
    idempotency_key: uuidFrom(`review-request:${task.id}:${round}`),
  });
}

async function workerTurn(turn: Turn): Promise<string> {
  const work = (await turn.call("get_delegated_work", {})).result as {
    instructions: Json[];
    origins: Json[];
  };
  for (const instruction of work.instructions) {
    const said = text(instruction.verbatim);
    const id = text(instruction.id);
    if (said.startsWith("UPDATE ") && once(`worker:${id}`)) {
      // A03: the latest user instruction reaches the worker with its provenance.
      memory.received.set(turn.agentId, [
        ...(memory.received.get(turn.agentId) ?? []),
        said,
        ...work.origins.map((origin) => `origin:${text(origin.verbatim)}`),
      ]);
      continue;
    }
    const assignment = /^TASK (\S+) kind=(\S+) run=(\S+)(?: worktree=(\S+))?/u.exec(said);
    if (assignment !== null && once(`worker:${id}`)) {
      memory.taskOwners.set(assignment[1]!, turn.agentId);
      await doTask(turn, assignment[1]!, assignment[2]!, assignment[3]!, assignment[4]);
      continue;
    }
    const rebase = /^REBASE (\S+)/u.exec(said);
    if (rebase !== null && once(`worker:${id}`)) {
      const taskId = rebase[1]!;
      const worktree = memory.worktrees.get(taskId)!;
      git(worktree.path, "rebase", "--quiet", "main");
      await setStatus(turn, taskId, "review");
    }
  }
  // A handoff of ours was answered: continue the task it blocked (A14) or the design (A10).
  for (const [taskId, handoffId] of memory.handoffs) {
    if (memory.taskOwners.get(taskId) !== turn.agentId) continue;
    const handoff = (await turn.call("get_handoff_status", { handoff_id: handoffId }))
      .result as Json;
    if (handoff.status !== "resolved" || !once(`resume:${handoffId}`)) continue;
    await setStatus(turn, taskId, "running");
    await finish(turn, taskId);
  }
  return "worked";
}

async function doTask(turn: Turn, taskId: string, kind: string, runId: string, worktree?: string) {
  await setStatus(turn, taskId, "running");
  if (worktree !== undefined) {
    writeFileSync(join(worktree, `${kind}.ts`), `export const ${kind} = true;\n`);
    git(worktree, "add", ".");
    git(worktree, "commit", "--quiet", "-m", `${kind} work`);
  }
  if (kind === "screen") {
    // A08: a dev server the user can see, kept after the run, and a helper tied to the run.
    await turn.call("start_process", {
      task_id: taskId,
      run_id: runId,
      purpose: "alpha dev server",
      command: "while true; do echo dev-ready; sleep 2; done",
      ports: [5173],
      keep: "keep",
      idempotency_key: uuidFrom(`dev:${taskId}`),
    });
    await turn.call("start_process", {
      task_id: taskId,
      run_id: runId,
      purpose: "alpha watcher",
      command: "while true; do echo watching; sleep 2; done",
      keep: "run",
      idempotency_key: uuidFrom(`watch:${taskId}`),
    });
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    await finish(turn, taskId);
    return;
  }
  if (kind === "api" || kind === "design") {
    const handoff = (
      await turn.call(kind === "api" ? "request_human_handoff" : "propose_design_change", {
        ...(kind === "api" ? { kind: "manual-test" } : {}),
        project_id: (
          (await turn.call("get_task_detail", { task_id: taskId })).result as { task: Json }
        ).task.projectId,
        reason: kind === "api" ? "로그인 API를 직접 확인해 주세요." : "별도 UI가 필요해 보입니다.",
        blocking_task_ids: [taskId],
        independent_work_to_continue: ["문서 작업"],
        options:
          kind === "api"
            ? [
                { label: "통과", description: "예상대로 동작" },
                { label: "다시", description: "문제 있음" },
              ]
            : [
                { label: "Hook/MCP 유지", description: "공식 확장 지점" },
                { label: "별도 UI", description: "비공식 API 필요" },
              ],
        recommendation: kind === "api" ? "dev server에서 로그인 후 응답 확인" : "Hook/MCP 유지",
        risks: [],
        prepared_environment:
          kind === "api" ? ["dev server http://127.0.0.1:5173", "curl /login"] : [],
        resume_condition: "사용자 결정",
        idempotency_key: uuidFrom(`handoff:${taskId}`),
      })
    ).result as Json;
    memory.handoffs.set(taskId, text(handoff.id));
    await setStatus(turn, taskId, "blocked");
    return;
  }
  await finish(turn, taskId);
}

async function finish(turn: Turn, taskId: string): Promise<void> {
  const runId = memory.runs.get(taskId)!;
  await turn.call("publish_artifact", {
    task_id: taskId,
    run_id: runId,
    kind: "test-result",
    reference: "pnpm test",
    exit_code: 0,
    idempotency_key: uuidFrom(`tests:${taskId}`),
  });
  await turn.call("finish_run", {
    run_id: runId,
    status: "succeeded",
    idempotency_key: uuidFrom(`finish:${taskId}`),
  });
  await setStatus(turn, taskId, "review");
}

async function setStatus(turn: Turn, taskId: string, status: string): Promise<void> {
  const detail = (await turn.call("get_task_detail", { task_id: taskId })).result as {
    task: TaskRecord;
  };
  if (detail.task.status === status) return;
  await turn.call("update_task", {
    task_id: taskId,
    expected_revision: detail.task.revision,
    status,
  });
}

async function reviewerTurn(turn: Turn): Promise<string> {
  const work = (await turn.call("get_delegated_work", {})).result as { instructions: Json[] };
  for (const instruction of work.instructions) {
    const request = /^REVIEW (\S+) round=(\d+) intent=(\S+)/u.exec(text(instruction.verbatim));
    if (request === null || !once(`reviewer:${text(instruction.id)}`)) continue;
    for (const [kind, verdict] of [
      ["correctness", "pass"],
      ["intent", request[3] === "fail" ? "fail" : "pass"],
    ] as const) {
      await turn.call("submit_review", {
        task_id: request[1],
        kind,
        verdict,
        findings: verdict === "pass" ? "원본 지시와 diff를 확인함" : "원본 의도(passkey)와 다름",
        idempotency_key: uuidFrom(`verdict:${text(instruction.id)}:${kind}`),
      });
    }
  }
  return "reviewed";
}

// Run ----------------------------------------------------------------------------------------------

const puppetDirectory = mkdtempSync(join(tmpdir(), "naru-puppet-"));
const puppetSocket = join(puppetDirectory, "puppet.sock");
const stack = await startNaruStack({ sdkSource: puppetSdk(puppetSocket) });
const person = new Person(stack);
const turns = new Map<string, number>();
let agentsByName = new Map<string, AgentRecord>();

async function allAgents(): Promise<AgentRecord[]> {
  const projects = await person.get<{ id: string }[]>("/api/projects");
  const views = await Promise.all(
    projects.map((project) => person.get<ProjectView>(`/api/agent/projects/${project.id}`)),
  );
  const overview = await person.get<{ globalAgents: AgentRecord[] }>("/api/agent/overview");
  return [...views.flatMap((view) => view.agents), ...overview.globalAgents];
}

const puppets = servePuppets(
  puppetSocket,
  async (name) => {
    const prefix = name.replace(/^naru-/u, "");
    let found = [...agentsByName.values()].find((agent) =>
      agent.id.replaceAll("-", "").startsWith(prefix),
    );
    if (found === undefined) {
      agentsByName = new Map((await allAgents()).map((agent) => [agent.id, agent]));
      found = [...agentsByName.values()].find((agent) =>
        agent.id.replaceAll("-", "").startsWith(prefix),
      );
    }
    return found?.id ?? null;
  },
  async (turn) => {
    turns.set(turn.agentId, (turns.get(turn.agentId) ?? 0) + 1);
    if (turn.role === "main orchestrator") return mainTurn(turn);
    if (turn.role === "project orchestrator") return orchestratorTurn(turn, person);
    if (turn.role === "worker") return workerTurn(turn);
    if (turn.role === "reviewer") return reviewerTurn(turn);
    return "no script for this role";
  },
);

let exitCode = 0;
try {
  await person.signIn();
  const paths = { alpha: join(stack.projectRoot, "alpha"), beta: join(stack.projectRoot, "beta") };
  for (const path of Object.values(paths)) makeRepository(path);
  const projects: Record<string, string> = {};
  for (const [name, path] of Object.entries(paths)) {
    projects[name] = (await person.post<{ id: string }>("/api/projects", { path, name })).id;
  }
  const view = (name: string) => person.get<ProjectView>(`/api/agent/projects/${projects[name]!}`);

  // A02 + A05: the user gives the main orchestrator goals for two projects.
  await person.post("/api/agent/agents", {
    role: "main-orchestrator",
    hostProjectId: projects.alpha,
    runtime: "claude",
    idempotencyKey: randomUUID(),
  });
  const goal = await person.post<{ id: string }>("/api/agent/instructions", {
    scope: { kind: "global" },
    verbatim: "alpha: 로그인 기능을 passkey로 만든다\nbeta: 결제 연동 설계를 정리한다",
    idempotencyKey: randomUUID(),
  });
  const [alphaPlanned, betaPlanned] = await Promise.all(
    ["alpha", "beta"].map((name) =>
      until(
        () => view(name),
        (state) => state.activePlan !== null && state.tasks.length === 2,
        `${name} planned`,
      ),
    ),
  );
  const orchestrators = [alphaPlanned!, betaPlanned!].map((state) =>
    state.agents.find((agent) => agent.role === "project-orchestrator"),
  );
  const alphaTask = await person.get<{ task: { originInstructionId: string } }>(
    `/api/agent/tasks/${alphaPlanned!.tasks[0]!.id}`,
  );
  check(
    "A02",
    orchestrators.every((agent) => agent !== undefined && agent.paneId !== null) &&
      alphaTask.task.originInstructionId === goal.id,
    "main → project orchestrators spawned in Host Panes for alpha and beta; each made a plan and 2 tasks whose origin is the user's global instruction",
  );
  const workers = await until(
    async () => (await view("alpha")).agents.filter((agent) => agent.role === "worker"),
    (list) => list.length === 2 && list.every((agent) => agent.paneId !== null),
    "alpha workers",
  );
  check(
    "A05",
    workers.every((agent) => agent.parentAgentSessionId === orchestrators[0]!.id),
    "orchestrator-spawned workers run as their own Naru Host sessions (Pane bound) with the orchestrator as parent",
  );

  // A08: the dev server stays after the run; the run-tied helper stops with it.
  const processes = await until(
    async () => (await view("alpha")).processes,
    (list) =>
      list.some(
        (process) => process.purpose === "alpha dev server" && process.status === "running",
      ) &&
      list.some((process) => process.purpose === "alpha watcher" && process.status !== "running"),
    "alpha processes",
  );
  check(
    "A08",
    true,
    `dev server kept running after its run finished; run-tied watcher ${processes.find((process) => process.purpose === "alpha watcher")?.status ?? "?"}`,
  );

  // A10: the design deviation waits for the user; the independent beta-docs task goes on.
  const betaState = await until(
    () => view("beta"),
    (state) =>
      state.openHandoffs.some((handoff) => handoff.kind === "design-deviation") &&
      state.tasks.some(
        (task) => task.title === "beta-docs" && ["review", "done"].includes(task.status),
      ),
    "beta deviation and docs",
  );
  const designTask = betaState.tasks.find((task) => task.title === "beta-design")!;
  const designGate = await person.get<{ mergeGate: { open: boolean; reasons: string[] } }>(
    `/api/agent/tasks/${designTask.id}`,
  );
  check(
    "A10",
    designTask.status === "blocked" &&
      designGate.mergeGate.reasons.includes("open-handoff-design-deviation"),
    `beta-design blocked behind a design-deviation handoff (gate: ${designGate.mergeGate.reasons.join(", ")}); beta-docs reached ${betaState.tasks.find((task) => task.title === "beta-docs")?.status}`,
  );

  // A13: Naru restarts while agents are live; nothing is duplicated and work continues.
  const before = await Promise.all(["alpha", "beta"].map((name) => view(name)));
  await stack.restartServer();
  await person.signIn();
  const after = await Promise.all(["alpha", "beta"].map((name) => view(name)));
  const sameShape = before.every(
    (state, index) =>
      state.tasks.length === after[index]!.tasks.length &&
      state.agents.length === after[index]!.agents.length &&
      after[index]!.activePlan?.id === state.activePlan?.id,
  );

  // A03: the user tells the alpha project something new; the worker receives it with provenance.
  const correction = await person.post<{ id: string }>("/api/agent/instructions", {
    scope: { kind: "project", projectId: projects.alpha },
    verbatim: "비밀번호 입력은 절대 저장하지 않는다",
    idempotencyKey: randomUUID(),
  });
  const received = await until(
    () => Promise.resolve([...memory.received.values()].flat()),
    (lines) => lines.some((line) => line.includes("비밀번호 입력은 절대 저장하지 않는다")),
    "worker got the update",
  );
  check(
    "A03",
    received.some((line) => line.startsWith("origin:비밀번호 입력은 절대 저장하지 않는다")) &&
      correction.id !== "",
    "a project instruction reached alpha's workers through the orchestrator's task delegation, citing the user's own instruction as origin",
  );

  // A14: the manual test request carries the prepared environment; answering it resumes only that task.
  const manual = await until(
    () => view("alpha"),
    (state) => state.openHandoffs.some((handoff) => handoff.kind === "manual-test"),
    "manual test handoff",
  );
  const handoff = manual.openHandoffs.find((item) => item.kind === "manual-test")!;
  const prepared = (handoff.payload.preparedEnvironment as string[]).join(" | ");
  const blockedBefore = (await view("beta")).tasks.find(
    (task) => task.title === "beta-design",
  )!.status;
  await person.post(`/api/agent/handoffs/${handoff.id}/resolve`, {
    decision: "확인했다. 통과",
    chosenOption: "통과",
    idempotencyKey: randomUUID(),
  });
  const resumed = await until(
    () => view("alpha"),
    (state) =>
      ["review", "done"].includes(state.tasks.find((task) => task.title === "alpha-api")!.status),
    "alpha-api resumed",
  );
  const blockedAfter = (await view("beta")).tasks.find(
    (task) => task.title === "beta-design",
  )!.status;
  check(
    "A14",
    prepared.includes("dev server") && blockedBefore === "blocked" && blockedAfter === "blocked",
    `handoff had environment "${prepared}"; after "통과" alpha-api went to ${resumed.tasks.find((task) => task.title === "alpha-api")!.status} while beta-design stayed ${blockedAfter}`,
  );

  // A11 + A15: reviews gate both alpha branches; the second is rebased, reviewed again, then merged.
  const integrated = await until(
    () => view("alpha"),
    (state) => state.tasks.every((task) => task.status === "done"),
    "alpha integrated",
    240_000,
  );
  const screen = integrated.tasks.find((task) => task.title === "alpha-screen")!;
  const api = integrated.tasks.find((task) => task.title === "alpha-api")!;
  const screenRefusals = memory.mergeRefusals.get(screen.id) ?? [];
  const apiRefusals = memory.mergeRefusals.get(api.id) ?? [];
  check(
    "A11",
    screenRefusals.some((line) => line.includes("intent-review-fail")),
    `alpha-screen passed its tests but the intent review failed, so merge_task was refused (${screenRefusals[0] ?? "none"}); it merged only after a passing re-review`,
  );
  const log = git(paths.alpha, "log", "--format=%s", "main");
  const merges = git(paths.alpha, "rev-list", "--merges", "--count", "main");
  check(
    "A15",
    log.includes("screen work") &&
      log.includes("api work") &&
      merges === "0" &&
      [...screenRefusals, ...apiRefusals].some((line) => line.includes("cannot fast-forward")),
    `two worktrees integrated into alpha main by fast-forward (merge commits: ${merges}); the branch that diverged was refused, rebased in its worktree and re-reviewed before merging`,
  );
  check(
    "A13",
    sameShape,
    "after a Naru restart the plans, tasks and agents were unchanged and the agents carried the work on to integration",
  );

  // A07/A06 hold-style check on a live worker: a person's hold blocks the orchestrator, release wakes it.
  const worker = (await view("beta")).agents.find((agent) => agent.role === "worker")!;
  await person.post(`/api/agent/agents/${worker.id}/hold`, {
    held: true,
    surface: "chat",
    idempotencyKey: randomUUID(),
  });
  const heldState = await person.get<{ writer: string }>(`/api/agent/agents/${worker.id}/runtime`);
  await person.post(`/api/agent/agents/${worker.id}/hold`, {
    held: false,
    idempotencyKey: randomUUID(),
  });
  const released = await until(
    () => person.get<{ writer: string }>(`/api/agent/agents/${worker.id}/runtime`),
    (state) => state.writer === "orchestrator",
    "writer back",
  );
  check(
    "HOLD",
    heldState.writer === "gui" && released.writer === "orchestrator",
    "a person's Chat hold made them the writer; releasing returned the writer to the orchestrator",
  );
  process.stdout.write(
    `turns per agent: ${JSON.stringify([...turns.values()])}; agents: ${(await allAgents()).length}\n`,
  );
} catch (error) {
  exitCode = 1;
  process.stdout.write(`ERROR ${error instanceof Error ? error.message : String(error)}\n`);
  const agents = await allAgents().catch(() => []);
  process.stdout.write(
    `agents: ${JSON.stringify(agents.map((agent) => ({ role: agent.role, status: agent.status, pane: agent.paneId !== null, turns: turns.get(agent.id) ?? 0 })))}\n`,
  );
  const { readFileSync } = await import("node:fs");
  for (const line of readFileSync(stack.logFile, "utf8").split("\n")) {
    if (line.includes('"agent.tool.failed"') || line.includes('"level":50')) {
      process.stdout.write(`log ${line.slice(0, 400)}\n`);
    }
  }
  // Stand-in transcripts are fixture text only; they show whether turns reached the puppet.
  for (const agent of agents) {
    const history = await person
      .get<{ items: unknown[] }>(`/api/agent/agents/${agent.id}/history`)
      .catch(() => ({ items: [] }));
    process.stdout.write(`history ${agent.role}: ${JSON.stringify(history.items).slice(0, 600)}\n`);
  }
} finally {
  if (results.some((result) => result.status === "FAIL")) exitCode = 1;
  person.close();
  puppets.close();
  await stack.stop();
  rmSync(puppetDirectory, { recursive: true, force: true });
  process.exit(exitCode);
}
