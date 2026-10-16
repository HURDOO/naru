import { afterEach, describe, expect, it } from "vitest";
import type { Actor, AgentRuntimeState, AgentSession } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore, AgentPlatformError } from "../src/agent-platform/core.js";
import { OrchestratorWakeups, type WakeupBatch } from "../src/agent-platform/wakeups.js";
import { JobLifecycle } from "../src/agent-runtime/jobs.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const SYSTEM: Actor = { kind: "system" };
const agent = (agentSessionId: string): Actor => ({ kind: "agent", agentSessionId });

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** A project team and a goal the person gave, divided into two tasks with a review. */
function fixture() {
  const repository = new NaruRepository(":memory:");
  cleanups.push(() => repository.close());
  const project = repository.createProject("/tmp/naru-jobs-project", "blog");
  let tick = Date.parse("2026-10-16T01:00:00.000Z");
  const core = new AgentPlatformCore(repository.agentPlatform, {
    now: () => new Date((tick += 1_000)),
  });
  let ordinal = 0;
  const key = () => `71000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`;
  const ctx = (actor: Actor) => ({ actor, idempotencyKey: key() });
  const register = (role: AgentSession["role"]) => {
    const id = core.registerAgentSession(ctx(HUMAN), {
      projectId: role === "main-orchestrator" ? null : project.id,
      role,
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
    core.updateAgentRuntimeState(SYSTEM, { agentSessionId: id, status: "idle" });
    return id;
  };
  const orchestrator = register("project-orchestrator");
  const worker = register("worker");
  const other = register("worker");
  const reviewer = register("reviewer");
  const goal = core.createHumanInstruction(ctx(HUMAN), {
    scope: { kind: "project", projectId: project.id },
    verbatim: "태그 페이지를 만들어 줘",
  });
  const task = (title: string, assignee: string, origin = goal.id) =>
    core.createTask(ctx(agent(orchestrator)), {
      projectId: project.id,
      title,
      purpose: "",
      completionCriteria: ["tests pass"],
      originInstructionId: origin,
      assigneeAgentSessionId: assignee,
    });
  const finish = (taskId: string) => {
    core.submitReview(ctx(agent(reviewer)), {
      taskId,
      kind: "correctness",
      verdict: "pass",
      findings: "ok",
    });
    done(taskId);
  };
  const done = (taskId: string) =>
    core.updateTask(ctx(agent(orchestrator)), {
      taskId,
      status: "done",
      expectedRevision: core.getTaskDetail(HUMAN, taskId).task.revision,
    });
  return {
    repository,
    core,
    project,
    ctx,
    orchestrator,
    worker,
    other,
    reviewer,
    goal,
    task,
    finish,
    done,
  };
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

/** Runtimes that stop when asked and resume when launched, as the supervisor would report. */
function fakeRuntime(core: AgentPlatformCore, working: readonly string[] = []) {
  const calls: string[] = [];
  const gone = new Set<string>();
  return {
    calls,
    runtime: {
      launch: (id: string) => {
        calls.push(`launch ${id}`);
        gone.delete(id);
        core.updateAgentRuntimeState(SYSTEM, { agentSessionId: id, status: "idle" });
        return Promise.resolve();
      },
      // The runner ends its input and exits a moment later, then reports itself stopped.
      stop: (id: string) => {
        calls.push(`stop ${id}`);
        setTimeout(() => {
          gone.add(id);
          core.updateAgentRuntimeState(SYSTEM, { agentSessionId: id, status: "stopped" });
        }, 5);
      },
      runtimeState: (id: string) =>
        ({
          connected: !gone.has(id),
          turnActive: working.includes(id),
          pendingApprovals: [],
        }) as unknown as AgentRuntimeState,
    },
  };
}

describe("completing a job (AP-D036)", () => {
  it("waits for its open tasks, then cleans up only its own workers and reviewers", async () => {
    const f = fixture();
    const first = f.task("태그 목록", f.worker);
    const second = f.task("태그 상세", f.worker);
    // Another goal still needs the second worker and the reviewer.
    const later = f.core.createHumanInstruction(f.ctx(HUMAN), {
      scope: { kind: "project", projectId: f.project.id },
      verbatim: "검색을 고쳐 줘",
    });
    f.task("검색 고치기", f.other, later.id);
    f.finish(first.id);

    expectCode(
      () => f.core.completeJob(f.ctx(HUMAN), { goalId: f.goal.id, retireAgentSessionIds: [] }),
      "AGENT_INVALID_STATE",
    );
    expectCode(
      () =>
        f.core.completeJob(f.ctx(agent(f.orchestrator)), {
          goalId: f.goal.id,
          retireAgentSessionIds: [],
        }),
      "AGENT_ROLE_DENIED",
    );
    f.finish(second.id);

    const plan = f.core.jobCompletionPlan(HUMAN, f.goal.id);
    expect(plan.openTasks).toBe(0);
    // Orchestrators take many jobs and are never part of it.
    expect(plan.agents.map((item) => [item.agent.id, item.keep])).toEqual([
      [f.worker, null],
      [f.reviewer, "other-work"],
    ]);

    const { runtime, calls } = fakeRuntime(f.core);
    const removed: string[] = [];
    const jobs = new JobLifecycle({
      core: f.core,
      runtime,
      removePane: (paneId) => {
        removed.push(paneId);
        return Promise.resolve();
      },
    });
    f.repository.createAgentPane(f.worker, "Claude worker");
    const context = f.ctx(HUMAN);
    const result = await jobs.complete(context, f.goal.id, []);
    expect(calls).toEqual([`stop ${f.worker}`]);
    expect(result.retired.map((item) => [item.id, item.status, Boolean(item.retiredAt)])).toEqual([
      [f.worker, "stopped", true],
    ]);
    expect(result.kept.map((item) => [item.agent.id, item.keep])).toEqual([
      [f.reviewer, "other-work"],
    ]);
    expect(removed).toHaveLength(1);
    expect(f.core.listJobs(HUMAN).find((job) => job.goal.id === f.goal.id)).toMatchObject({
      round: 1,
      completedAt: expect.any(String) as string,
    });

    // A retry is the same completion; completing again is refused.
    await expect(jobs.complete(context, f.goal.id, [])).resolves.toMatchObject({
      retired: [{ id: f.worker }],
    });
    expectCode(
      () => f.core.completeJob(f.ctx(HUMAN), { goalId: f.goal.id, retireAgentSessionIds: [] }),
      "AGENT_INVALID_STATE",
    );
  });

  it("keeps an agent the person keeps, one in a turn and one a person holds", async () => {
    const f = fixture();
    const reviewed = f.task("태그 목록", f.worker);
    f.task("태그 상세", f.other);
    f.finish(reviewed.id);
    for (const task of f.core.listTasks(HUMAN, f.project.id)) {
      if (task.status !== "done") f.done(task.id);
    }
    f.core.setHumanHold(f.ctx(HUMAN), {
      agentSessionId: f.reviewer,
      held: true,
      reason: "takeover",
    });
    const { runtime, calls } = fakeRuntime(f.core, [f.other]);
    const jobs = new JobLifecycle({ core: f.core, runtime });
    expect(jobs.preview(f.goal.id).agents.map((item) => [item.agent.id, item.keep])).toEqual([
      [f.worker, null],
      [f.other, "working"],
      [f.reviewer, "held"],
    ]);
    const result = await jobs.complete(f.ctx(HUMAN), f.goal.id, [f.worker]);
    expect(calls).toEqual([]);
    expect(result.retired).toEqual([]);
    expect(result.kept.map((item) => item.keep)).toEqual(["person", "working", "held"]);
  });
});

describe("reopening a job (AP-D036)", () => {
  it("records the next round verbatim, keeps its work in the same job and resumes its sessions", async () => {
    const f = fixture();
    const first = f.task("태그 목록", f.worker);
    f.finish(first.id);
    f.finish(f.task("태그 상세", f.other).id);
    const { runtime, calls } = fakeRuntime(f.core);
    const jobs = new JobLifecycle({ core: f.core, runtime, stopWaitMs: 1_000 });
    await jobs.complete(f.ctx(HUMAN), f.goal.id, []);
    expect(f.core.listAgentSessions(HUMAN, f.project.id).map((item) => item.id)).toEqual([
      f.orchestrator,
    ]);
    expectCode(
      () => f.core.reopenJob(f.ctx(HUMAN), { goalId: f.worker, verbatim: "x" }),
      "AGENT_NOT_FOUND",
    );

    const seen: string[] = [];
    f.core.subscribe((event) => seen.push(event.type));
    const context = f.ctx(HUMAN);
    const reopened = await jobs.reopen(context, f.goal.id, "태그 색을 바꿔 줘");
    expect(reopened.instruction).toMatchObject({
      author: { kind: "human" },
      scope: { kind: "project", projectId: f.project.id },
      originUserInstructionId: f.goal.id,
      verbatim: "태그 색을 바꿔 줘",
    });
    // The same sessions come back and resume their conversations.
    expect(reopened.resumed.map((item) => item.id).sort()).toEqual(
      [f.worker, f.other, f.reviewer].sort(),
    );
    expect(reopened.failed).toEqual([]);
    expect(calls.filter((call) => call.startsWith("launch")).sort()).toEqual(
      [f.worker, f.other, f.reviewer].map((id) => `launch ${id}`).sort(),
    );
    expect(seen).toContain("job.reopened");

    // The round's work is part of the same job; the round itself is not a job of its own.
    const delegated = f.core.delegate(f.ctx(agent(f.orchestrator)), {
      scope: { kind: "agent", projectId: f.project.id, agentSessionId: f.worker },
      verbatim: "태그 색 바꾸기",
      originUserInstructionId: reopened.instruction.id,
    });
    f.task("태그 색", f.worker, delegated.id);
    const jobsNow = f.core.listJobs(HUMAN);
    expect(jobsNow).toHaveLength(1);
    expect(jobsNow[0]).toMatchObject({
      round: 2,
      completedAt: null,
      followUps: [{ id: reopened.instruction.id }],
    });
    expect(jobsNow[0]!.tasks.map((item) => item.task.title)).toEqual([
      "태그 목록",
      "태그 상세",
      "태그 색",
    ]);

    // A retry returns the same round and launches nothing new.
    calls.length = 0;
    await expect(jobs.reopen(context, f.goal.id, "태그 색을 바꿔 줘")).resolves.toMatchObject({
      instruction: { id: reopened.instruction.id },
    });
    expect(calls).toEqual([]);
    expectCode(
      () => f.core.reopenJob(f.ctx(HUMAN), { goalId: f.goal.id, verbatim: "또" }),
      "AGENT_INVALID_STATE",
    );
  });

  it("does not wake orchestrators for the completion or for the agents it cleans up", async () => {
    const f = fixture();
    f.finish(f.task("태그 목록", f.worker).id);
    const batches: WakeupBatch[] = [];
    const wakeups = new OrchestratorWakeups(
      f.core,
      {
        deliver: (batch) => {
          batches.push(batch);
          return Promise.resolve();
        },
      },
      { minIntervalMs: 0 },
    );
    cleanups.push(() => wakeups.close());
    wakeups.register(f.orchestrator);
    await new Promise((resolve) => setTimeout(resolve, 20));
    wakeups.turnCompleted(f.orchestrator);
    batches.length = 0;
    // The runtimes report their own stop after the cleanup is recorded; neither wakes anyone.
    const { runtime, calls } = fakeRuntime(f.core);
    await new JobLifecycle({ core: f.core, runtime }).complete(f.ctx(HUMAN), f.goal.id, []);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(calls).toEqual([`stop ${f.worker}`, `stop ${f.reviewer}`]);
    expect(batches).toEqual([]);
  });
});
