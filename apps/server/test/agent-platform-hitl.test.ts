import { afterEach, describe, expect, it } from "vitest";
import type { Actor, AgentEvent } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore, AgentPlatformError } from "../src/agent-platform/core.js";
import { stallCause, StallMonitor } from "../src/agent-platform/stalls.js";
import { AGENT_TOOLS } from "../src/agent-platform/tools.js";
import { OrchestratorWakeups, type WakeupBatch } from "../src/agent-platform/wakeups.js";
import { toolActivity } from "../src/agent-runtime/claude/runner.js";
import { codexActivity } from "../src/agent-runtime/codex/managed-session.js";
import { ManagedAgentSupervisor } from "../src/agent-runtime/supervisor.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const SYSTEM: Actor = { kind: "system" };
const agent = (agentSessionId: string): Actor => ({ kind: "agent", agentSessionId });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** One clock for Core's records and the stall monitor. */
const clock = { now: Date.now() };

/** A project with an orchestrator, a worker and a reviewer, and a goal the person gave. */
function fixture() {
  const repository = new NaruRepository(":memory:");
  cleanups.push(() => repository.close());
  const project = repository.createProject("/tmp/naru-hitl-project", "blog");
  clock.now = Date.now();
  const core = new AgentPlatformCore(repository.agentPlatform, {
    now: () => new Date((clock.now += 1)),
  });
  let ordinal = 0;
  const key = () => `70000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
  const ctx = (actor: Actor) => ({ actor, idempotencyKey: key() });
  const register = (role: "project-orchestrator" | "worker" | "reviewer" | "main-orchestrator") =>
    core.registerAgentSession(ctx(HUMAN), {
      projectId: role === "main-orchestrator" ? null : project.id,
      role,
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
  const orchestrator = register("project-orchestrator");
  const worker = register("worker");
  const reviewer = register("reviewer");
  for (const id of [orchestrator, worker, reviewer]) {
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: id, status: "idle" });
  }
  const goal = core.createHumanInstruction(ctx(HUMAN), {
    scope: { kind: "global" },
    verbatim: "blog에 블로그 글 10개 써봐",
  });
  const task = core.createTask(ctx(agent(orchestrator)), {
    projectId: project.id,
    title: "글 10개 추가",
    purpose: "",
    completionCriteria: ["새 글 10개", "build 통과"],
    originInstructionId: goal.id,
    assigneeAgentSessionId: worker,
  });
  const tool = (name: string) => AGENT_TOOLS.find((candidate) => candidate.name === name)!;
  return { repository, core, project, ctx, key, orchestrator, worker, reviewer, goal, task, tool };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("delegation reaches the agent it names (AP-D034)", () => {
  it("rejects arguments from another scope instead of dropping them", () => {
    const { core, project, orchestrator, reviewer, goal, task, tool } = fixture();
    const delegate = tool("delegate");
    // The review that went to the worker on 2026-10-16: task scope with the reviewer's id.
    expect(() =>
      delegate.run(core, agent(orchestrator), {
        scope_kind: "task",
        project_id: project.id,
        task_id: task.id,
        agent_session_id: reviewer,
        verbatim: "리뷰를 맡아 주세요.",
        origin_user_instruction_id: goal.id,
      }),
    ).toThrow(/scope_kind "agent"/u);
    expect(() =>
      delegate.run(core, agent(orchestrator), {
        scope_kind: "project",
        project_id: project.id,
        task_id: task.id,
        verbatim: "x",
        origin_user_instruction_id: goal.id,
      }),
    ).toThrow(/task_id is not used/u);

    const sent = delegate.run(core, agent(orchestrator), {
      scope_kind: "agent",
      project_id: project.id,
      agent_session_id: reviewer,
      verbatim: "리뷰를 맡아 주세요.",
      origin_user_instruction_id: goal.id,
    }) as { id: string };
    expect(core.instructionRecipients(SYSTEM, sent.id).map((item) => item.id)).toEqual([reviewer]);
    const toTask = core.delegate(
      { actor: agent(orchestrator), idempotencyKey: "70000000-0000-4000-8000-999999999999" },
      {
        scope: { kind: "task", projectId: project.id, taskId: task.id },
        verbatim: "작업",
        originUserInstructionId: goal.id,
      },
    );
    expect(core.instructionRecipients(SYSTEM, toTask.id).map((item) => item.id)).toEqual([
      task.assigneeAgentSessionId,
    ]);
  });

  it("tells the sender at once when the person stopped the recipient", () => {
    const { core, ctx, project, orchestrator, reviewer, goal } = fixture();
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: reviewer, status: "stopped" });
    expectCode(
      () =>
        core.delegate(ctx(agent(orchestrator)), {
          scope: { kind: "agent", projectId: project.id, agentSessionId: reviewer },
          verbatim: "리뷰",
          originUserInstructionId: goal.id,
        }),
      "AGENT_INVALID_STATE",
    );
    // A crashed (unknown) recipient is not refused: Naru starts it again to receive the work.
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: reviewer, status: "unknown" });
    expect(
      core.delegate(ctx(agent(orchestrator)), {
        scope: { kind: "agent", projectId: project.id, agentSessionId: reviewer },
        verbatim: "리뷰",
        originUserInstructionId: goal.id,
      }).scope,
    ).toMatchObject({ kind: "agent", agentSessionId: reviewer });
  });

  it("lets orchestrators read what the person said directly to the project's agents", () => {
    const { core, ctx, project, orchestrator, worker } = fixture();
    const said = core.createHumanInstruction(ctx(HUMAN), {
      scope: { kind: "agent", projectId: project.id, agentSessionId: worker },
      verbatim: "내가 끈건데...",
    });
    const read = (actor: Actor) =>
      core.getApplicableInstructions(actor, {
        projectId: project.id,
        ...(actor.kind === "agent" ? { agentSessionId: actor.agentSessionId } : {}),
      });
    expect(read(agent(orchestrator)).map((item) => item.id)).toContain(said.id);
    expect(read(agent(worker)).map((item) => item.id)).toContain(said.id);
    const other = core.registerAgentSession(ctx(HUMAN), {
      projectId: project.id,
      role: "worker",
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
    // Another worker still sees only its own words.
    expect(read(agent(other)).map((item) => item.id)).not.toContain(said.id);
  });
});

describe("wakeups skip what needs no turn (AP-D034)", () => {
  it("does not wake a project orchestrator for progress, artifacts or normal process ends", async () => {
    const { core, ctx, project, orchestrator, worker, task } = fixture();
    const batches: WakeupBatch[] = [];
    const wakeups = new OrchestratorWakeups(
      core,
      {
        deliver: (batch) => {
          batches.push(batch);
          return Promise.resolve();
        },
      },
      { minIntervalMs: 0 },
    );
    cleanups.push(() => wakeups.close());
    wakeups.register(orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 20));
    wakeups.turnCompleted(orchestrator);
    batches.length = 0;

    const run = core.startRun(ctx(agent(orchestrator)), {
      taskId: task.id,
      agentSessionId: worker,
      runtime: "claude",
    });
    wakeups.turnCompleted(orchestrator);
    batches.length = 0;
    core.reportProgress(ctx(agent(worker)), { runId: run.id, summary: "3/10 글" });
    core.publishArtifact(ctx(agent(worker)), {
      taskId: task.id,
      runId: run.id,
      kind: "commit",
      reference: "abc1234",
      summary: "글",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batches).toEqual([]);

    core.updateTask(ctx(agent(worker)), {
      taskId: task.id,
      status: "review",
      expectedRevision: core.getTaskDetail(HUMAN, task.id).task.revision,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(batches.flatMap((batch) => batch.events.map((event) => event.type))).toEqual([
      "task.updated",
    ]);
    void project;
  });
});

describe("agents that went down come back (AP-D034)", () => {
  it("relaunches a delegated agent that is down, once per cooldown, never a held one", async () => {
    const { core, ctx, project, orchestrator, reviewer, worker, goal } = fixture();
    const launched: string[] = [];
    const supervisor = new ManagedAgentSupervisor({
      core,
      launcher: {
        launch: (agentSessionId) => {
          launched.push(agentSessionId);
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      },
      channelSocketPath: "/tmp/naru-hitl-unused.sock",
      planFor: () => {
        throw new Error("no plan in this test");
      },
      autoRelaunch: true,
    });
    cleanups.push(() => supervisor.close());

    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: reviewer, status: "unknown" });
    const send = () =>
      core.delegate(ctx(agent(orchestrator)), {
        scope: { kind: "agent", projectId: project.id, agentSessionId: reviewer },
        verbatim: "리뷰를 맡아 주세요.",
        originUserInstructionId: goal.id,
      });
    send();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(launched).toEqual([reviewer]);
    // Still down a moment later: not launched again within the cooldown.
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: reviewer, status: "unknown" });
    send();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(launched).toEqual([reviewer]);

    // A person holding it, or a person's own message, does not launch it.
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: worker, status: "unknown" });
    core.setHumanHold(ctx(HUMAN), { agentSessionId: worker, held: true, reason: "takeover" });
    core.createHumanInstruction(ctx(HUMAN), {
      scope: { kind: "agent", projectId: project.id, agentSessionId: worker },
      verbatim: "잠깐",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(launched).toEqual([reviewer]);
  });
});

describe("agents running before a restart come back (AP-D034)", () => {
  it("relaunches agents left unknown after a restart, but not stopped or held ones", async () => {
    const { core, ctx, repository, orchestrator, worker, reviewer } = fixture();
    // Managed agents run in Panes; only those are checked after a restart.
    for (const id of [orchestrator, worker, reviewer]) repository.createAgentPane(id, "agent");
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: reviewer, status: "stopped" });
    core.setHumanHold(ctx(HUMAN), { agentSessionId: worker, held: true, reason: "takeover" });
    const launched: string[] = [];
    const supervisor = new ManagedAgentSupervisor({
      core,
      launcher: {
        launch: (agentSessionId) => {
          launched.push(agentSessionId);
          return Promise.resolve();
        },
        stop: () => Promise.resolve(),
      },
      channelSocketPath: "/tmp/naru-hitl-unused.sock",
      planFor: () => {
        throw new Error("no plan in this test");
      },
      disconnectGraceMs: 0,
      autoRelaunch: true,
    });
    cleanups.push(() => supervisor.close());
    supervisor.reconcileAfterStart(() => false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // The orchestrator was idle (running) and nobody holds it: it is started again.
    expect(launched).toEqual([orchestrator]);
    expect(core.getAgentSession(HUMAN, worker).status).toBe("unknown");
  });
});

describe("stalled work is noticed (AP-D034)", () => {
  function monitored(minutes = 10) {
    const setup = fixture();
    const working = new Set<string>();
    const monitor = new StallMonitor({
      core: setup.core,
      minutes,
      working: (id) => working.has(id),
      awaitingApproval: () => false,
      now: () => clock.now,
    });
    return { ...setup, monitor, working, advance: (ms: number) => (clock.now += ms) };
  }

  it("wakes the orchestrator first, then shows the person, and clears on progress", () => {
    const { core, ctx, project, worker, orchestrator, task, monitor, advance } = monitored();
    const events: AgentEvent[] = [];
    core.subscribe((event) => events.push(event));
    core.updateTask(ctx(agent(worker)), {
      taskId: task.id,
      status: "review",
      expectedRevision: core.getTaskDetail(HUMAN, task.id).task.revision,
    });
    expect(monitor.tick()).toEqual([]);

    advance(11 * 60_000);
    const first = monitor.tick();
    expect(first).toMatchObject([
      {
        projectId: project.id,
        stall: { stage: "orchestrator", cause: "no-review", taskId: task.id },
      },
    ]);
    expect(events.at(-1)).toMatchObject({
      type: "project.stalled",
      data: { stage: "orchestrator" },
    });
    // Not repeated while it waits for the orchestrator.
    advance(60_000);
    expect(monitor.tick()).toEqual([]);

    advance(10 * 60_000);
    // Minutes count from the last progress, not from the note that woke the orchestrator.
    expect(monitor.tick()).toMatchObject([
      { stall: { stage: "person", cause: "no-review", minutes: 22 } },
    ]);
    expect(core.projectProgress(project.id).stall).toMatchObject({ stage: "person" });

    // The person's nudge hands it back to the orchestrator; if it still stands, they hear again.
    core.recordStall(ctx(HUMAN), {
      projectId: project.id,
      stage: "orchestrator",
      cause: "no-review",
      taskId: task.id,
      minutes: 0,
    });
    expect(core.projectProgress(project.id).stall).toMatchObject({ stage: "orchestrator" });
    advance(5 * 60_000);
    expect(monitor.tick()).toEqual([]);
    advance(5 * 60_000);
    expect(monitor.tick()).toMatchObject([{ stall: { stage: "person", minutes: 32 } }]);

    // Real progress (a review) clears it.
    core.submitReview(ctx(agent(fixtureReviewer(core, project.id))), {
      taskId: task.id,
      kind: "correctness",
      verdict: "pass",
      findings: "ok",
    });
    expect(core.projectProgress(project.id).stall).toBeNull();
    void orchestrator;
  });

  it("leaves projects alone that wait for the person or are working", () => {
    const { core, ctx, project, orchestrator, monitor, working, advance } = monitored();
    working.add(orchestrator);
    advance(30 * 60_000);
    expect(monitor.tick()).toEqual([]);
    working.clear();
    core.requestHandoff(ctx(agent(orchestrator)), {
      projectId: project.id,
      kind: "product-decision",
      payload: {
        reason: "결정",
        blockingTaskIds: [],
        independentWorkToContinue: [],
        options: [],
        recommendation: "A",
        risks: [],
        preparedEnvironment: [],
        resumeCondition: "답",
      },
    });
    advance(30 * 60_000);
    expect(monitor.tick()).toEqual([]);
  });

  it("names the likely cause", () => {
    const { core, project, task, worker, orchestrator } = fixture();
    const agents = core.listAgentSessions(HUMAN, project.id);
    const base = core.getTaskDetail(HUMAN, task.id).task;
    expect(stallCause([{ ...base, status: "running" }], agents, () => [])).toEqual({
      cause: "assignee-idle",
      taskId: task.id,
    });
    const downAgents = agents.map((item) =>
      item.id === worker ? { ...item, status: "unknown" as const } : item,
    );
    expect(stallCause([{ ...base, status: "running" }], downAgents, () => []).cause).toBe(
      "assignee-down",
    );
    expect(
      stallCause([{ ...base, status: "ready", assigneeAgentSessionId: null }], agents, () => [])
        .cause,
    ).toBe("unassigned");
    const noOrchestrator = agents.map((item) =>
      item.id === orchestrator ? { ...item, status: "stopped" as const } : item,
    );
    expect(stallCause([base], noOrchestrator, () => []).cause).toBe("orchestrator-down");
  });
});

describe("jobs show how a goal was divided (AP-D034)", () => {
  it("lists the person's goals with their tasks, review verdicts and latest run", () => {
    const { core, ctx, project, orchestrator, worker, goal, task } = fixture();
    const run = core.startRun(ctx(agent(orchestrator)), {
      taskId: task.id,
      agentSessionId: worker,
      runtime: "claude",
    });
    core.reportProgress(ctx(agent(worker)), { runId: run.id, summary: "4/10 글" });
    const question = core.createHumanInstruction(ctx(HUMAN), {
      scope: { kind: "global" },
      verbatim: "지금 얼마나 됐어?",
    });
    const jobs = core.listJobs(HUMAN);
    expect(jobs.map((job) => job.goal.id)).toEqual([goal.id]);
    expect(jobs[0]).toMatchObject({
      projectIds: [project.id],
      tasks: [
        { task: { id: task.id }, reviews: {}, latestRun: { id: run.id, summary: "4/10 글" } },
      ],
    });
    // A question nobody turned into work is not a job.
    expect(jobs.map((job) => job.goal.id)).not.toContain(question.id);
    expect(() => core.listJobs(agent(orchestrator))).toThrow();
  });
});

describe("what an agent is doing now (AP-D026)", () => {
  it("shows a readable tool and a short target", () => {
    expect(toolActivity("Edit", { file_path: "src/content/posts/a.md" })).toEqual({
      tool: "Edit",
      target: "src/content/posts/a.md",
    });
    expect(toolActivity("Bash", { command: "npm run build\n  && npm run check" })).toEqual({
      tool: "Bash",
      target: "npm run build && npm run check",
    });
    expect(toolActivity("mcp__naru__submit_review", { task_id: "x" })).toEqual({
      tool: "naru submit_review",
      target: null,
    });
    expect(toolActivity("Bash", { command: "x".repeat(400) }).target).toHaveLength(200);
  });

  it("reads Codex items the same way", () => {
    expect(codexActivity({ type: "commandExecution", command: "pnpm  test\n" })).toEqual({
      tool: "Bash",
      target: "pnpm test",
    });
    expect(codexActivity({ type: "fileChange", changes: [{ path: "src/a.ts" }] })).toEqual({
      tool: "Edit",
      target: "src/a.ts",
    });
    expect(codexActivity({ type: "mcpToolCall", server: "naru", tool: "update_task" })).toEqual({
      tool: "naru update_task",
      target: null,
    });
    expect(codexActivity({ type: "mcpToolCall", server: { bad: true } })).toEqual({
      tool: "mcp",
      target: null,
    });
    expect(codexActivity({ type: "reasoning" })).toBeNull();
  });
});

function fixtureReviewer(core: AgentPlatformCore, projectId: string): string {
  return core.listAgentSessions(HUMAN, projectId).find((item) => item.role === "reviewer")!.id;
}
