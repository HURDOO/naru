import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NARU_SURFACE_CONNECTION_HEADER,
  NARU_SURFACE_GENERATION_HEADER,
} from "../../../packages/contracts/src/index.js";
import type {
  Actor,
  AgentRuntimeState,
  AgentSession,
  Handoff,
  Instruction,
} from "@naru/contracts/naru-agent/v1";
import type { AgentHistoryWindow } from "@naru/contracts/naru-agent/v1/history";
import { AgentPlatformCore, AgentPlatformError } from "../src/agent-platform/core.js";
import type { AgentRuntimeControl } from "../src/agent-platform/http-routes.js";
import type { HistoryRead } from "../src/agent-runtime/history-window.js";
import { SupervisorError } from "../src/agent-runtime/supervisor.js";
import type { WriterKind } from "../src/agent-runtime/writer-gate.js";
import { buildApp } from "../src/app.js";
import type { AppConfig } from "../src/config.js";
import { NaruRepository } from "../src/database.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { hashPassword } from "../src/password.js";
import type { PushNotificationService } from "../src/push-notifications.js";
import { PtySupervisor, type PtyProcess } from "../src/pty.js";

const origin = "http://127.0.0.1:5173";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Agent Platform browser API", () => {
  it("is absent unless the core is supplied", async () => {
    const fixture = await createFixture(false);
    const login = await fixture.login();
    const response = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/overview",
      headers: { cookie: login.cookie },
    });
    expect(response.statusCode).toBe(404);
  });

  it("requires a session for reads and the human device lease for writes", async () => {
    const fixture = await createFixture(true);
    expect(
      (await fixture.app.inject({ method: "GET", url: "/api/agent/overview" })).statusCode,
    ).toBe(401);
    const login = await fixture.login();
    const overview = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/overview",
      headers: { cookie: login.cookie },
    });
    expect(overview.statusCode).toBe(200);

    const payload = {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "로그인은 passkey로 해 줘.",
      idempotencyKey: "90000000-0000-4000-8000-000000000001",
    };
    const withoutLease = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/instructions",
      headers: { origin, cookie: login.cookie, "x-csrf-token": login.csrfToken },
      payload,
    });
    expect(withoutLease.statusCode).toBe(409);
    expect(withoutLease.json()).toMatchObject({ code: "LEASE_REQUIRED" });

    const controller = await fixture.controller(login);
    const created = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/instructions",
      headers: controller,
      payload,
    });
    expect(created.statusCode).toBe(201);
    const replay = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/instructions",
      headers: controller,
      payload,
    });
    expect(replay.json<Instruction>().id).toBe(created.json<Instruction>().id);

    const state = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/projects/${fixture.projectId}`,
      headers: { cookie: login.cookie },
    });
    expect(state.json<{ instructions: Instruction[] }>().instructions).toHaveLength(1);

    // Events reference the instruction but never carry its text (AP-D002).
    const events = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/events?after=0",
      headers: { cookie: login.cookie },
    });
    expect(events.statusCode).toBe(200);
    expect(events.body).not.toContain("passkey로");
  });

  it("resolves handoffs once and holds an agent against orchestrator messages", async () => {
    const fixture = await createFixture(true);
    const login = await fixture.login();
    const controller = await fixture.controller(login);
    const core = fixture.core!;
    let ordinal = 100;
    const ctx = (actor: Actor) => ({
      actor,
      idempotencyKey: `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const register = (role: "project-orchestrator" | "worker") =>
      core.registerAgentSession(ctx({ kind: "human" }), {
        projectId: fixture.projectId,
        role,
        runtime: "codex",
        native: false,
        observation: "pty",
        conversationWriter: "orchestrator",
      }).id;
    const orchestrator = register("project-orchestrator");
    const worker = register("worker");
    const goal = core.createHumanInstruction(ctx({ kind: "human" }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "goal",
    }).id;
    const handoff = core.requestHandoff(ctx({ kind: "agent", agentSessionId: worker }), {
      projectId: fixture.projectId,
      kind: "manual-test",
      payload: {
        reason: "로그인 흐름 확인",
        blockingTaskIds: [],
        independentWorkToContinue: ["문서"],
        options: [],
        recommendation: "dev server에서 로그인해 보기",
        risks: [],
        preparedEnvironment: ["http://127.0.0.1:5173"],
        resumeCondition: "승인",
      },
    });

    const inbox = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/handoffs?projectId=${fixture.projectId}`,
      headers: { cookie: login.cookie },
    });
    expect(inbox.json<Handoff[]>().map((item) => item.id)).toEqual([handoff.id]);

    const resolve = (key: string) =>
      fixture.app.inject({
        method: "POST",
        url: `/api/agent/handoffs/${handoff.id}/resolve`,
        headers: controller,
        payload: { decision: "통과", chosenOption: "pass", idempotencyKey: key },
      });
    expect((await resolve("90000000-0000-4000-8000-000000000201")).statusCode).toBe(200);
    const again = await resolve("90000000-0000-4000-8000-000000000202");
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ code: "AGENT_INVALID_STATE" });

    const hold = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/agents/${worker}/hold`,
      headers: controller,
      payload: { held: true, idempotencyKey: "90000000-0000-4000-8000-000000000203" },
    });
    expect(hold.statusCode).toBe(200);
    expect(() =>
      core.delegate(ctx({ kind: "agent", agentSessionId: orchestrator }), {
        scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: worker },
        verbatim: "continue",
        originUserInstructionId: goal,
      }),
    ).toThrow(AgentPlatformError);
  });
});

describe("Agent Platform handoff alerts", () => {
  it("pushes an agent's handoff to the person's devices by IDs only", async () => {
    const alerts: unknown[] = [];
    const push = {
      configuration: () => ({ configured: true, publicKey: null, inactivityDelayMinutes: 5 }),
      updateConfiguration: () => ({ configured: true, publicKey: null, inactivityDelayMinutes: 5 }),
      list: () => [],
      subscribe: () => {
        throw new Error("unused");
      },
      rename: () => {
        throw new Error("unused");
      },
      delete: () => false,
      handleActivity: () => undefined,
      notifyHandoff: (input: unknown) => alerts.push(input),
      close: () => Promise.resolve(),
    } satisfies PushNotificationService;
    const fixture = await createFixture(true, undefined, push);
    const core = fixture.core!;
    const worker = core.registerAgentSession(
      { actor: { kind: "human" }, idempotencyKey: "90000000-0000-4000-8000-000000000601" },
      {
        projectId: fixture.projectId,
        role: "worker",
        runtime: "claude",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    ).id;
    const handoff = core.requestHandoff(
      {
        actor: { kind: "agent", agentSessionId: worker },
        idempotencyKey: "90000000-0000-4000-8000-000000000602",
      },
      {
        projectId: fixture.projectId,
        kind: "manual-test",
        payload: {
          reason: "로그인 확인",
          blockingTaskIds: [],
          independentWorkToContinue: [],
          options: [],
          recommendation: "dev server에서 확인",
          risks: [],
          preparedEnvironment: [],
          resumeCondition: "결정",
        },
      },
    );
    expect(alerts).toEqual([
      { projectId: fixture.projectId, handoffId: handoff.id, kind: "manual-test" },
    ]);
  });
});

describe("Agent Platform task detail API", () => {
  it("shows a task with its runs, reviews, artifacts and merge gate", async () => {
    const fixture = await createFixture(true);
    const core = fixture.core!;
    let ordinal = 300;
    const ctx = (actor: Actor) => ({
      actor,
      idempotencyKey: `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const register = (role: "project-orchestrator" | "worker" | "reviewer") =>
      core.registerAgentSession(ctx({ kind: "human" }), {
        projectId: fixture.projectId,
        role,
        runtime: "claude",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      }).id;
    const orchestrator = register("project-orchestrator");
    const worker = register("worker");
    const reviewer = register("reviewer");
    const goal = core.createHumanInstruction(ctx({ kind: "human" }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "goal",
    }).id;
    const task = core.createTask(ctx({ kind: "agent", agentSessionId: orchestrator }), {
      projectId: fixture.projectId,
      title: "로그인 화면",
      purpose: "passkey 로그인",
      completionCriteria: ["tests pass"],
      originInstructionId: goal,
      assigneeAgentSessionId: worker,
    });
    const run = core.startRun(ctx({ kind: "agent", agentSessionId: orchestrator }), {
      taskId: task.id,
      agentSessionId: worker,
      runtime: "claude",
    });
    core.publishArtifact(ctx({ kind: "agent", agentSessionId: worker }), {
      taskId: task.id,
      runId: run.id,
      kind: "test-result",
      reference: "pnpm test",
      exitCode: 0,
    });
    core.finishRun(ctx({ kind: "agent", agentSessionId: worker }), {
      runId: run.id,
      status: "succeeded",
    });
    core.submitReview(ctx({ kind: "agent", agentSessionId: reviewer }), {
      taskId: task.id,
      runId: run.id,
      kind: "correctness",
      verdict: "pass",
      findings: "covered",
    });

    expect(
      (await fixture.app.inject({ method: "GET", url: `/api/agent/tasks/${task.id}` })).statusCode,
    ).toBe(401);
    const login = await fixture.login();
    const detail = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/tasks/${task.id}`,
      headers: { cookie: login.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      task: { id: task.id, assigneeAgentSessionId: worker },
      runs: [{ id: run.id, status: "succeeded" }],
      reviews: [{ kind: "correctness", verdict: "pass" }],
      artifacts: [{ kind: "test-result", exitCode: 0 }],
      mergeGate: { open: false, reasons: ["missing-intent-review"] },
    });
    const missing = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/tasks/90000000-0000-4000-8000-999999999999",
      headers: { cookie: login.cookie },
    });
    expect(missing.statusCode).toBe(404);

    // A view's first load reads the newest events, still oldest first.
    const all = (
      await fixture.app.inject({
        method: "GET",
        url: "/api/agent/events?after=0&limit=500",
        headers: { cookie: login.cookie },
      })
    ).json<{ seq: number }[]>();
    const latest = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/events?after=0&limit=2&latest=1&projectId=${fixture.projectId}`,
      headers: { cookie: login.cookie },
    });
    expect(latest.json<{ seq: number }[]>().map((event) => event.seq)).toEqual(
      all.slice(-2).map((event) => event.seq),
    );
  });
});

describe("Agent Platform control room reads", () => {
  it("shows every project's board and who asked an agent what", async () => {
    const fixture = await createFixture(true);
    const core = fixture.core!;
    let ordinal = 700;
    const ctx = (actor: Actor) => ({
      actor,
      idempotencyKey: `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const register = (projectId: string | null, role: AgentSession["role"]) =>
      core.registerAgentSession(ctx({ kind: "human" }), {
        projectId,
        role,
        runtime: "claude",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      }).id;
    const main = register(null, "main-orchestrator");
    const orchestrator = register(fixture.projectId, "project-orchestrator");
    const worker = register(fixture.projectId, "worker");
    const goal = core.createHumanInstruction(ctx({ kind: "human" }), {
      scope: { kind: "global" },
      verbatim: "alpha는 passkey로 바꿔 줘.",
    });
    const project = core.delegate(ctx({ kind: "agent", agentSessionId: main }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "passkey 로그인 계획을 세워.",
      originUserInstructionId: goal.id,
    });
    const task = core.createTask(ctx({ kind: "agent", agentSessionId: orchestrator }), {
      projectId: fixture.projectId,
      title: "passkey 등록",
      purpose: "등록 흐름",
      completionCriteria: [],
      originInstructionId: goal.id,
      assigneeAgentSessionId: worker,
    });
    const delegation = core.delegate(ctx({ kind: "agent", agentSessionId: orchestrator }), {
      scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: worker },
      verbatim: "passkey 등록을 맡아 줘.",
      originUserInstructionId: goal.id,
    });

    expect((await fixture.app.inject({ method: "GET", url: "/api/agent/board" })).statusCode).toBe(
      401,
    );
    const login = await fixture.login();
    const read = (url: string) =>
      fixture.app.inject({ method: "GET", url, headers: { cookie: login.cookie } });

    const board = await read("/api/agent/board");
    expect(board.statusCode).toBe(200);
    expect(board.json()).toMatchObject({
      projects: [
        {
          projectId: fixture.projectId,
          tasks: [{ id: task.id, assigneeAgentSessionId: worker }],
          agents: [{ id: orchestrator }, { id: worker }],
          pendingApprovals: [],
          processes: [],
        },
      ],
      globalAgents: [{ id: main }],
      openHandoffs: [],
      globalPendingApprovals: [],
      paneNames: {},
    });

    // A name the person gives an agent's Pane shows wherever the agent does (AP-D029).
    const workerPane = fixture.repository.createAgentPane(worker, "Claude worker · fixture");
    const mainPane = fixture.repository.createAgentPane(main, "Claude main", fixture.projectId);
    fixture.repository.renamePane(workerPane.id, "로그인 담당");
    expect((await read("/api/agent/board")).json()).toMatchObject({
      paneNames: { [workerPane.id]: "로그인 담당" },
    });
    fixture.repository.renamePane(mainPane.id, "총괄");
    expect((await read("/api/agent/board")).json<{ paneNames: unknown }>().paneNames).toEqual({
      [workerPane.id]: "로그인 담당",
      [mainPane.id]: "총괄",
    });
    // The board carries no instruction text; conversations read it per agent.
    expect(board.body).not.toContain("passkey로 바꿔");

    const toWorker = await read(`/api/agent/agents/${worker}/instructions`);
    expect(toWorker.json()).toEqual({ instructions: [delegation], origins: [goal], decisions: [] });
    // A project orchestrator also hears what is sent to its project; the main one the user's goals.
    const toOrchestrator = await read(`/api/agent/agents/${orchestrator}/instructions`);
    expect(toOrchestrator.json<{ instructions: Instruction[] }>().instructions).toEqual([project]);
    const toMain = await read(`/api/agent/agents/${main}/instructions`);
    expect(toMain.json()).toEqual({ instructions: [goal], origins: [], decisions: [] });
    const missing = await read(
      "/api/agent/agents/90000000-0000-4000-8000-999999999999/instructions",
    );
    expect(missing.statusCode).toBe(404);
  });
});

describe("Agent Platform cleanup (AP-D033)", () => {
  it("cleans up a stopped agent with the device lease and removes its Pane", async () => {
    const fixture = await createFixture(true);
    const core = fixture.core!;
    let ordinal = 900;
    const key = () => `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
    const register = (role: AgentSession["role"]) =>
      core.registerAgentSession(
        { actor: { kind: "human" }, idempotencyKey: key() },
        {
          projectId: fixture.projectId,
          role,
          runtime: "claude",
          native: false,
          observation: "transcript",
          conversationWriter: "orchestrator",
        },
      ).id;
    const orchestrator = register("project-orchestrator");
    const worker = register("worker");
    const pane = fixture.repository.createAgentPane(worker, "Claude worker · fixture");
    core.updateAgentRuntimeState({ kind: "system" }, { agentSessionId: worker, status: "unknown" });
    const login = await fixture.login();
    const body = { agentSessionIds: [worker], processIds: [], idempotencyKey: key() };

    const withoutLease = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/cleanup",
      headers: { origin, cookie: login.cookie, "x-csrf-token": login.csrfToken },
      payload: body,
    });
    expect(withoutLease.json()).toMatchObject({ code: "LEASE_REQUIRED" });

    const headers = await fixture.controller(login);
    const cleaned = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/cleanup",
      headers,
      payload: body,
    });
    expect(cleaned.statusCode).toBe(200);
    expect(cleaned.json()).toMatchObject({
      agents: [{ id: worker, retiredAt: expect.any(String) as string }],
      processes: [],
      panesKept: 0,
    });
    expect(fixture.repository.getPaneContext(pane.id)).toBeUndefined();

    const board = (
      await fixture.app.inject({
        method: "GET",
        url: "/api/agent/board",
        headers: { cookie: login.cookie },
      })
    ).json<{ projects: { agents: { id: string }[] }[]; retiredAgents: { id: string }[] }>();
    expect(board.projects[0]!.agents.map((agent) => agent.id)).toEqual([orchestrator]);
    expect(board.retiredAgents.map((agent) => agent.id)).toEqual([worker]);

    const running = await fixture.app.inject({
      method: "POST",
      url: "/api/agent/cleanup",
      headers,
      payload: { agentSessionIds: [orchestrator], processIds: [], idempotencyKey: key() },
    });
    expect(running.statusCode).toBe(409);
    expect(running.json()).toMatchObject({ code: "AGENT_INVALID_STATE" });
  });
});

describe("Agent Platform job completion (AP-D036)", () => {
  it("previews, completes with the device lease and reopens a job", async () => {
    const fixture = await createFixture(true);
    const core = fixture.core!;
    let ordinal = 1_100;
    const key = () => `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
    const ctx = (actor: Actor) => ({ actor, idempotencyKey: key() });
    const register = (role: AgentSession["role"]) =>
      core.registerAgentSession(ctx({ kind: "human" }), {
        projectId: fixture.projectId,
        role,
        runtime: "claude",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      }).id;
    const orchestrator = register("project-orchestrator");
    const worker = register("worker");
    core.updateAgentRuntimeState({ kind: "system" }, { agentSessionId: worker, status: "idle" });
    const pane = fixture.repository.createAgentPane(worker, "Claude worker · fixture");
    const goal = core.createHumanInstruction(ctx({ kind: "human" }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "태그 페이지",
    });
    const task = core.createTask(ctx({ kind: "agent", agentSessionId: orchestrator }), {
      projectId: fixture.projectId,
      title: "태그 목록",
      purpose: "",
      completionCriteria: [],
      originInstructionId: goal.id,
      assigneeAgentSessionId: worker,
    });
    const login = await fixture.login();
    const read = (url: string) =>
      fixture.app.inject({ method: "GET", url, headers: { cookie: login.cookie } });
    expect((await read(`/api/agent/jobs/${goal.id}/completion`)).json()).toMatchObject({
      openTasks: 1,
      agents: [{ agent: { id: worker }, keep: null }],
      worktrees: [],
    });
    core.updateTask(ctx({ kind: "agent", agentSessionId: orchestrator }), {
      taskId: task.id,
      status: "done",
      expectedRevision: task.revision,
    });

    const complete = (headers: Record<string, string>) =>
      fixture.app.inject({
        method: "POST",
        url: `/api/agent/jobs/${goal.id}/complete`,
        headers,
        payload: { keepAgentSessionIds: [], idempotencyKey: key() },
      });
    const withoutLease = await complete({
      origin,
      cookie: login.cookie,
      "x-csrf-token": login.csrfToken,
    });
    expect(withoutLease.json()).toMatchObject({ code: "LEASE_REQUIRED" });
    const headers = await fixture.controller(login);
    const completed = await complete(headers);
    expect(completed.statusCode).toBe(200);
    expect(completed.json()).toMatchObject({
      retired: [{ id: worker, retiredAt: expect.any(String) as string }],
      kept: [],
      worktrees: [],
      panesKept: 0,
    });
    expect(fixture.repository.getPaneContext(pane.id)).toBeUndefined();
    expect((await read("/api/agent/jobs")).json()).toMatchObject({
      jobs: [{ goal: { id: goal.id }, round: 1, completedAt: expect.any(String) as string }],
    });

    const reopened = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/jobs/${goal.id}/reopen`,
      headers,
      payload: { verbatim: "태그 색도 바꿔 줘", idempotencyKey: key() },
    });
    expect(reopened.statusCode).toBe(200);
    expect(reopened.json()).toMatchObject({
      instruction: { verbatim: "태그 색도 바꿔 줘", originUserInstructionId: goal.id },
      resumed: [{ id: worker, retiredAt: null }],
    });
    expect((await read("/api/agent/jobs")).json()).toMatchObject({
      jobs: [{ goal: { id: goal.id }, round: 2, completedAt: null, followUps: [{}] }],
    });
  });
});

describe("Agent Platform stalls, jobs and agent Panes (AP-D034)", () => {
  it("shows a stall that reached the person, lets them nudge and keeps agent Panes", async () => {
    const fixture = await createFixture(true);
    const core = fixture.core!;
    let ordinal = 950;
    const key = () => `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
    const orchestrator = core.registerAgentSession(
      { actor: { kind: "human" }, idempotencyKey: key() },
      {
        projectId: fixture.projectId,
        role: "project-orchestrator",
        runtime: "claude",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    ).id;
    const goal = core.createHumanInstruction(
      { actor: { kind: "human" }, idempotencyKey: key() },
      { scope: { kind: "global" }, verbatim: "글 10개 써봐" },
    );
    const task = core.createTask(
      { actor: { kind: "agent", agentSessionId: orchestrator }, idempotencyKey: key() },
      {
        projectId: fixture.projectId,
        title: "글 10개",
        purpose: "",
        completionCriteria: [],
        originInstructionId: goal.id,
      },
    );
    const login = await fixture.login();
    const read = async <T>(url: string) =>
      (
        await fixture.app.inject({ method: "GET", url, headers: { cookie: login.cookie } })
      ).json<T>();
    type Board = { projects: { stall: unknown; working: unknown[] }[] };
    expect((await read<Board>("/api/agent/board")).projects[0]).toMatchObject({
      stall: null,
      working: [],
    });
    // Only the `person` stage shows: the orchestrator gets the first chance.
    core.recordStall(
      { actor: { kind: "system" }, idempotencyKey: key() },
      {
        projectId: fixture.projectId,
        stage: "orchestrator",
        cause: "unassigned",
        taskId: task.id,
        minutes: 11,
      },
    );
    expect((await read<Board>("/api/agent/board")).projects[0]!.stall).toBeNull();
    core.recordStall(
      { actor: { kind: "system" }, idempotencyKey: key() },
      {
        projectId: fixture.projectId,
        stage: "person",
        cause: "unassigned",
        taskId: task.id,
        minutes: 21,
      },
    );
    expect((await read<Board>("/api/agent/board")).projects[0]!.stall).toMatchObject({
      stage: "person",
      cause: "unassigned",
      taskId: task.id,
    });

    const headers = await fixture.controller(login);
    const nudged = await fixture.app.inject({
      method: "POST",
      url: `/api/agent/projects/${fixture.projectId}/nudge`,
      headers,
      payload: { idempotencyKey: key() },
    });
    expect(nudged.statusCode).toBe(200);
    const events = core.readEvents({ kind: "human" }, { afterSeq: 0, latest: true, limit: 1 });
    expect(events[0]).toMatchObject({
      type: "project.stalled",
      actor: { kind: "human" },
      data: { stage: "orchestrator", cause: "unassigned" },
    });
    // The nudge hands it back to the orchestrator, so the person's screens stop showing it.
    expect((await read<Board>("/api/agent/board")).projects[0]!.stall).toBeNull();

    const jobs = await read<{
      jobs: { goal: { id: string }; tasks: { task: { id: string } }[] }[];
    }>("/api/agent/jobs");
    expect(jobs.jobs).toMatchObject([
      { goal: { id: goal.id }, tasks: [{ task: { id: task.id } }] },
    ]);

    // An agent's Pane is stopped or cleaned up, not closed.
    const pane = fixture.repository.createAgentPane(orchestrator, "Claude orchestrator");
    const version = fixture.repository.getWorkspace(fixture.projectId).version;
    const closed = await fixture.app.inject({
      method: "DELETE",
      url: `/api/panes/${pane.id}`,
      headers,
      payload: { workspaceVersion: version },
    });
    expect(closed.statusCode).toBe(409);
    expect(closed.json()).toMatchObject({ code: "AGENT_INVALID_STATE" });
    expect(fixture.repository.getPaneContext(pane.id)).toBeDefined();
  });
});

describe("Agent Platform intent contract approval", () => {
  it("shows a proposal until the user approves it with the device lease", async () => {
    const fixture = await createFixture(true);
    const core = fixture.core!;
    const login = await fixture.login();
    let ordinal = 400;
    const ctx = (actor: Actor) => ({
      actor,
      idempotencyKey: `90000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const orchestrator = core.registerAgentSession(ctx({ kind: "human" }), {
      projectId: fixture.projectId,
      role: "project-orchestrator",
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
    const goal = core.createHumanInstruction(ctx({ kind: "human" }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "goal",
    }).id;
    const proposal = core.proposeIntentContract(
      ctx({ kind: "agent", agentSessionId: orchestrator }),
      {
        projectId: fixture.projectId,
        body: { principles: ["passkey"], allowedChoices: [], requireApprovalIf: [], forbidden: [] },
        sourceInstructionId: goal,
      },
    );
    const state = async () =>
      (
        await fixture.app.inject({
          method: "GET",
          url: `/api/agent/projects/${fixture.projectId}`,
          headers: { cookie: login.cookie },
        })
      ).json<{
        intentContract: { id: string } | null;
        pendingIntentContract: { id: string } | null;
      }>();
    expect(await state()).toMatchObject({
      intentContract: null,
      pendingIntentContract: { id: proposal.id },
    });

    const approve = (headers: Record<string, string>) =>
      fixture.app.inject({
        method: "POST",
        url: `/api/agent/intent-contracts/${proposal.id}/approve`,
        headers,
        payload: { idempotencyKey: "90000000-0000-4000-8000-000000000499" },
      });
    const withoutLease = await approve({
      origin,
      cookie: login.cookie,
      "x-csrf-token": login.csrfToken,
    });
    expect(withoutLease.statusCode).toBe(409);
    expect((await approve(await fixture.controller(login))).statusCode).toBe(200);
    expect(await state()).toMatchObject({
      intentContract: { id: proposal.id },
      pendingIntentContract: null,
    });

    // The person's decisions show in the asking agent's chat as their words (AP-D035).
    const worker = core.registerAgentSession(ctx({ kind: "human" }), {
      projectId: fixture.projectId,
      role: "worker",
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
    const ask = (agentSessionId: string, reason: string) =>
      core.requestHandoff(ctx({ kind: "agent", agentSessionId }), {
        projectId: fixture.projectId,
        kind: "product-decision",
        payload: {
          reason,
          blockingTaskIds: [],
          independentWorkToContinue: [],
          options: [
            { label: "설정 안", description: "" },
            { label: "새 메뉴", description: "" },
          ],
          recommendation: "설정 안",
          risks: [],
          preparedEnvironment: [],
          resumeCondition: "결정",
        },
      });
    const question = ask(orchestrator, "로그인 설정을 어디에 둘까요?");
    const workersQuestion = ask(worker, "버튼 문구는?");
    const stillOpen = ask(orchestrator, "색은?");
    core.resolveHandoff(ctx({ kind: "human" }), {
      handoffId: question.id,
      decision: "설정 안에 두고 이름은 보안으로",
      chosenOption: "설정 안",
    });
    core.resolveHandoff(ctx({ kind: "human" }), {
      handoffId: workersQuestion.id,
      decision: "로그인",
    });
    const decisions = async (agentSessionId: string) =>
      (
        await fixture.app.inject({
          method: "GET",
          url: `/api/agent/agents/${agentSessionId}/instructions`,
          headers: { cookie: login.cookie },
        })
      ).json<{ decisions: unknown[] }>().decisions;
    // Both can share a millisecond; the chat places each where the agent was told of it.
    const forOrchestrator = await decisions(orchestrator);
    expect(forOrchestrator).toHaveLength(2);
    expect(forOrchestrator).toEqual(
      expect.arrayContaining([
        { kind: "contract", id: proposal.id, version: 1, at: expect.any(String) as string },
        {
          kind: "handoff",
          id: question.id,
          question: "로그인 설정을 어디에 둘까요?",
          decision: "설정 안에 두고 이름은 보안으로",
          chosenOption: "설정 안",
          at: expect.any(String) as string,
        },
      ]),
    );
    // Another agent's answer and an open question are not this agent's decisions.
    expect(await decisions(worker)).toEqual([
      expect.objectContaining({ kind: "handoff", id: workersQuestion.id, chosenOption: null }),
    ]);
    expect(JSON.stringify(await decisions(orchestrator))).not.toContain(stillOpen.id);
  });
});

describe("Agent Platform managed runtime API", () => {
  it("couples intervention with the writer, records Chat turns once and fences stale writers", async () => {
    const runtime = new FakeRuntime();
    const fixture = await createFixture(true, runtime);
    const login = await fixture.login();
    const controller = await fixture.controller(login);
    const core = fixture.core!;
    const post = (url: string, payload: Record<string, unknown>) =>
      fixture.app.inject({ method: "POST", url, headers: controller, payload });

    const createPayload = {
      projectId: fixture.projectId,
      role: "worker",
      runtime: "claude",
      idempotencyKey: "91000000-0000-4000-8000-000000000001",
    };
    const created = await post("/api/agent/agents", createPayload);
    expect(created.statusCode).toBe(201);
    const agent = created.json<AgentSession>();
    expect((await post("/api/agent/agents", createPayload)).json<AgentSession>().id).toBe(agent.id);
    expect(runtime.launches).toEqual([agent.id]);

    // The global main orchestrator is hosted in a workspace the person chooses.
    const main = await post("/api/agent/agents", {
      role: "main-orchestrator",
      hostProjectId: fixture.projectId,
      runtime: "claude",
      idempotencyKey: "91000000-0000-4000-8000-000000000009",
    });
    expect(main.json<AgentSession>()).toMatchObject({ role: "main-orchestrator", projectId: null });
    expect(runtime.launchOptions.at(-1)).toEqual({ hostProjectId: fixture.projectId });
    const missingHost = await post("/api/agent/agents", {
      role: "main-orchestrator",
      runtime: "claude",
      idempotencyKey: "91000000-0000-4000-8000-000000000010",
    });
    expect(missingHost.statusCode).toBe(400);
    fixture.repository.createAgentPane(agent.id, "agent");
    runtime.heldNow = () =>
      core.getAgentSession({ kind: "human" }, agent.id).humanHoldSince !== null;

    // Before a takeover the person is not the writer: nothing is recorded or sent.
    const early = await post(`/api/agent/agents/${agent.id}/turns`, {
      text: "지금 멈추고 테스트부터 고쳐.",
      generation: 1,
      idempotencyKey: "91000000-0000-4000-8000-000000000002",
    });
    expect(early.statusCode).toBe(409);
    expect(early.json()).toMatchObject({ code: "AGENT_WRITER_REQUIRED" });

    const held = await post(`/api/agent/agents/${agent.id}/hold`, {
      held: true,
      surface: "chat",
      idempotencyKey: "91000000-0000-4000-8000-000000000003",
    });
    expect(held.statusCode).toBe(200);
    expect(runtime.switches).toEqual([{ to: "gui", heldDuringSwitch: true }]);
    const state = await fixture.app.inject({
      method: "GET",
      url: `/api/agent/agents/${agent.id}/runtime`,
      headers: { cookie: login.cookie },
    });
    expect(state.json<AgentRuntimeState>()).toMatchObject({ writer: "gui", generation: 2 });

    const turn = {
      text: "지금 멈추고 테스트부터 고쳐.",
      generation: 2,
      idempotencyKey: "91000000-0000-4000-8000-000000000004",
    };
    expect((await post(`/api/agent/agents/${agent.id}/turns`, turn)).statusCode).toBe(202);
    expect((await post(`/api/agent/agents/${agent.id}/turns`, turn)).statusCode).toBe(202);
    expect(runtime.turns).toEqual([turn.text]);

    // An open question of this agent rides along on the person's next turn as a marked Naru note,
    // so the agent can withdraw it once answered; the person's words are recorded as typed.
    const question = core.requestHandoff(
      {
        actor: { kind: "agent", agentSessionId: agent.id },
        idempotencyKey: "91000000-0000-4000-8000-000000000020",
      },
      {
        projectId: fixture.projectId,
        kind: "product-decision",
        payload: {
          reason: "등록 화면을 어디에 둘까요?",
          blockingTaskIds: [],
          independentWorkToContinue: [],
          options: [],
          recommendation: "설정 안에",
          risks: [],
          preparedEnvironment: [],
          resumeCondition: "결정",
        },
      },
    );
    await post(`/api/agent/agents/${agent.id}/turns`, {
      text: "설정 안에 둬.",
      generation: 2,
      idempotencyKey: "91000000-0000-4000-8000-000000000021",
    });
    expect(runtime.turns.at(-1)).toContain(
      "설정 안에 둬.\n\n[Naru] Your question to the person is still open",
    );
    expect(runtime.turns.at(-1)).toContain(question.id);
    expect(
      core
        .getApplicableInstructions(
          { kind: "human" },
          { projectId: fixture.projectId, agentSessionId: agent.id },
        )
        .map((instruction) => instruction.verbatim),
    ).toContain("설정 안에 둬.");
    // The person answers approvals whoever writes (AP-D017); an old generation is ignored.
    await post(`/api/agent/agents/${agent.id}/approvals/request-1`, {
      decision: "approve",
      generation: 1,
    });
    await post(`/api/agent/agents/${agent.id}/approvals/request-2`, { decision: "deny" });
    // "Allow for this session" (AP-D023) reaches the runtime as its own answer.
    await post(`/api/agent/agents/${agent.id}/approvals/request-3`, {
      decision: "approve-session",
    });
    expect(
      (await post(`/api/agent/agents/${agent.id}/approvals/request-4`, { decision: "always" }))
        .statusCode,
    ).toBe(400);
    expect(runtime.approvals).toEqual([
      "request-1:approve",
      "request-2:deny",
      "request-3:approve-session",
    ]);

    const history = (query: string) =>
      fixture.app.inject({
        method: "GET",
        url: `/api/agent/agents/${agent.id}/history${query}`,
        headers: { cookie: login.cookie },
      });
    expect((await history("?latest=1")).json()).toEqual({
      items: [{ type: "user" }],
      cursor: "40",
      nextCursor: null,
      previousCursor: "40",
    });
    await history("?before=40");
    await history("?cursor=40");
    await history("");
    // Newest first (AP-D045); one way of reading at a time.
    expect((await history("?latest=1&before=40")).statusCode).toBe(400);
    expect(runtime.historyReads).toEqual([
      { kind: "latest" },
      { kind: "before", cursor: "40" },
      { kind: "forward", cursor: "40" },
      { kind: "forward", cursor: null },
    ]);

    // Release hands the writer back before the hold lifts, so a woken orchestrator can write.
    const released = await post(`/api/agent/agents/${agent.id}/hold`, {
      held: false,
      idempotencyKey: "91000000-0000-4000-8000-000000000005",
    });
    expect(released.json<AgentSession>().humanHoldSince).toBeNull();
    expect(runtime.switches.at(-1)).toEqual({ to: "orchestrator", heldDuringSwitch: true });

    // The Chat turn is the person's verbatim instruction to this agent; events carry no text.
    const events = await fixture.app.inject({
      method: "GET",
      url: "/api/agent/events?after=0",
      headers: { cookie: login.cookie },
    });
    expect(events.body).toContain("instruction.created");
    expect(events.body).not.toContain("테스트부터");
  });
});

class NoopPty implements PtyProcess {
  readonly pid = 4242;
  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  onExit(): { dispose(): void } {
    return { dispose: () => undefined };
  }
  write(): void {}
  resize(): void {}
  kill(): void {}
}

/** Records what the routes ask of the runtime; enforces the writer generation like the gate. */
class FakeRuntime implements AgentRuntimeControl {
  writer: WriterKind = "orchestrator";
  generation = 1;
  readonly launches: string[] = [];
  readonly launchOptions: unknown[] = [];
  readonly switches: { to: WriterKind; heldDuringSwitch: boolean }[] = [];
  readonly turns: string[] = [];
  readonly approvals: string[] = [];
  heldNow: () => boolean = () => false;

  launch(agentSessionId: string, options?: { hostProjectId?: string }): Promise<void> {
    this.launches.push(agentSessionId);
    this.launchOptions.push(options);
    return Promise.resolve();
  }
  stop(): void {}
  runtimeState(agentSessionId: string): AgentRuntimeState {
    return {
      agentSessionId,
      connected: true,
      writer: this.writer,
      generation: this.generation,
      phase: "active",
      turnActive: false,
      launchMode: this.writer === "tui" ? "tui" : "runner",
      pendingApprovals: [],
      children: [],
    };
  }
  assertWriter(_id: string, writer: WriterKind, generation: number): void {
    if (writer !== this.writer || generation !== this.generation) {
      throw new SupervisorError("WRITER_REQUIRED", "stale");
    }
  }
  sendTurn(id: string, text: string, writer: WriterKind, generation: number): void {
    this.assertWriter(id, writer, generation);
    this.turns.push(text);
  }
  interrupt(id: string, writer: WriterKind, generation: number): void {
    this.assertWriter(id, writer, generation);
  }
  respondApproval(
    id: string,
    requestId: string,
    decision: string,
    writer: WriterKind,
    generation: number,
  ): void {
    this.assertWriter(id, writer, generation);
    this.approvals.push(`${requestId}:${decision}`);
  }
  respondApprovalAsPerson(_id: string, requestId: string, decision: string): void {
    this.approvals.push(`${requestId}:${decision}`);
  }
  readonly historyReads: HistoryRead[] = [];
  readHistoryWindow(_id: string, read: HistoryRead): Promise<AgentHistoryWindow> {
    this.historyReads.push(read);
    return Promise.resolve({
      items: [{ type: "user" }],
      cursor: "40",
      nextCursor: null,
      previousCursor: "40",
    });
  }
  switchWriter(_id: string, to: WriterKind): Promise<unknown> {
    this.switches.push({ to, heldDuringSwitch: this.heldNow() });
    if (to !== this.writer) {
      this.writer = to;
      this.generation += 1;
    }
    return Promise.resolve();
  }
}

async function createFixture(
  withAgentPlatform: boolean,
  agentRuntime?: AgentRuntimeControl,
  pushNotifications?: PushNotificationService,
) {
  const base = await mkdtemp(join(tmpdir(), "naru-agent-api-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "coding");
  await mkdir(join(root, "project"), { recursive: true });
  const realRoot = await realpath(root);
  const config: AppConfig = {
    authMode: "app-managed",
    environment: "test",
    host: "127.0.0.1",
    port: 4174,
    allowedOrigins: new Set([origin]),
    projectRoots: [realRoot],
    passwordHash: await hashPassword("naru-test-password", { N: 1024, salt: Buffer.alloc(16, 4) }),
    sessionSecret: "naru-test-session-secret-that-is-long-enough",
    sessionCookieName: "naru_test_session",
    appBasePath: "/",
    dataDir: base,
    secureCookie: false,
    sessionRuntime: { owner: "legacy" },
  };
  const repository = new NaruRepository(":memory:");
  const project = repository.createProject(join(realRoot, "project"), "project");
  const core = withAgentPlatform ? new AgentPlatformCore(repository.agentPlatform) : undefined;
  const supervisor = new PtySupervisor(repository, () => new NoopPty(), {
    resolve: () => ({ file: "/bin/zsh", args: ["-l"], environment: {} }),
  });
  const app = await buildApp(config, {
    repository,
    pathPolicy: await ProjectPathPolicy.create([realRoot]),
    supervisor,
    ...(core === undefined ? {} : { agentPlatform: core }),
    ...(agentRuntime === undefined ? {} : { agentRuntime }),
    ...(pushNotifications === undefined ? {} : { pushNotifications }),
  });
  cleanups.push(async () => {
    await app.close();
    await supervisor.shutdown();
    repository.close();
  });
  return {
    app,
    core,
    repository,
    projectId: project.id,
    async login(): Promise<{ cookie: string; csrfToken: string }> {
      const response = await app.inject({
        method: "POST",
        url: "/api/auth/login",
        headers: { origin },
        payload: { password: "naru-test-password" },
      });
      const header = response.headers["set-cookie"];
      const cookie = (Array.isArray(header) ? header[0] : header)?.split(";")[0] ?? "";
      return { cookie, csrfToken: response.json<{ csrfToken: string }>().csrfToken };
    },
    async controller(login: { cookie: string; csrfToken: string }) {
      const socket = await app.injectWS("/api/terminal", {
        headers: { cookie: login.cookie, origin },
      });
      cleanups.push(() => {
        socket.terminate();
        return Promise.resolve();
      });
      const state = await new Promise<{ connectionId: string; generation: number }>((resolve) => {
        socket.on("message", (data: { toString(): string }) => {
          const frame = JSON.parse(data.toString()) as Record<string, unknown>;
          if (
            frame.type === "surface.state" &&
            typeof frame.connectionId === "string" &&
            typeof frame.generation === "number"
          ) {
            resolve({ connectionId: frame.connectionId, generation: frame.generation });
          }
        });
        socket.send(
          JSON.stringify({
            type: "lease.acquire",
            clientId: "11111111-1111-4111-8111-111111111111",
          }),
        );
      });
      return {
        origin,
        cookie: login.cookie,
        "x-csrf-token": login.csrfToken,
        [NARU_SURFACE_CONNECTION_HEADER]: state.connectionId,
        [NARU_SURFACE_GENERATION_HEADER]: String(state.generation),
      };
    },
  };
}
