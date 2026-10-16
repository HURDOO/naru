import { describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import {
  OrchestratorWakeups,
  type OrchestratorInvoker,
  type WakeupBatch,
} from "../src/agent-platform/wakeups.js";
import { wakeupText } from "../src/agent-runtime/supervisor.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };

describe("orchestrator wakeups", () => {
  it("wakes on others' events, ignores its own, and keeps one turn in flight", async () => {
    const fixture = setup();
    const wakeups = fixture.wakeups();
    wakeups.register(fixture.orchestrator);
    await flush();
    // The goal instruction and registrations happened before; they arrive as the first batch.
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.types(0)).toContain("instruction.created");

    // While the first turn is in flight, new events wait.
    fixture.core.delegate(fixture.ctx({ kind: "agent", agentSessionId: fixture.orchestrator }), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "own delegation",
      originUserInstructionId: fixture.goal,
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "user follow-up",
    });
    await flush();
    expect(fixture.batches).toHaveLength(1);
    expect(wakeups.state(fixture.orchestrator).kind).toBe("in-flight");

    fixture.clock.value += 10_000;
    wakeups.turnCompleted(fixture.orchestrator);
    await flush();
    expect(fixture.batches).toHaveLength(2);
    // Its own delegation is not echoed back; the user's follow-up is.
    expect(fixture.batches[1]!.events.map((event) => event.actor.kind)).toEqual(["human"]);
    wakeups.close();
  });

  it("wakes a working agent only for work addressed to it", async () => {
    const fixture = setup();
    const wakeups = fixture.wakeups();
    const orchestratorActor: Actor = { kind: "agent", agentSessionId: fixture.orchestrator };
    wakeups.register(fixture.worker);
    await flush();
    // The project goal and registrations are the project's business, not the worker's.
    expect(fixture.batches).toHaveLength(0);

    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "project-wide follow-up",
    });
    const unassigned = fixture.core.createTask(fixture.ctx(orchestratorActor), {
      projectId: fixture.projectId,
      title: "someone else's",
      purpose: "",
      completionCriteria: [],
      originInstructionId: fixture.goal,
    });
    await flush();
    expect(fixture.batches).toHaveLength(0);

    // Assigned a task, then given work: one turn each (one turn in flight at a time).
    const task = fixture.core.createTask(fixture.ctx(orchestratorActor), {
      projectId: fixture.projectId,
      title: "login screen",
      purpose: "",
      completionCriteria: [],
      originInstructionId: fixture.goal,
      assigneeAgentSessionId: fixture.worker,
    });
    fixture.core.delegate(fixture.ctx(orchestratorActor), {
      scope: { kind: "task", projectId: fixture.projectId, taskId: task.id },
      verbatim: "build the login screen",
      originUserInstructionId: fixture.goal,
    });
    await flush();
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.batches[0]!.orchestrator.id).toBe(fixture.worker);
    expect(fixture.types(0)).toEqual(["task.created"]);
    fixture.clock.value += 10_000;
    wakeups.turnCompleted(fixture.worker);
    await flush();
    expect(fixture.types(1)).toEqual(["instruction.created"]);
    expect(
      fixture.batches.flatMap((batch) => batch.events.map((event) => event.subjectId)),
    ).not.toContain(unassigned.id);

    // Its own status change does not wake it again.
    fixture.clock.value += 10_000;
    wakeups.turnCompleted(fixture.worker);
    fixture.core.updateTask(fixture.ctx({ kind: "agent", agentSessionId: fixture.worker }), {
      taskId: task.id,
      expectedRevision: task.revision,
      status: "running",
    });
    fixture.clock.value += 10_000;
    await flush();
    expect(fixture.batches).toHaveLength(2);
    wakeups.close();
  });

  it("ignores routine runtime state reports but wakes when another agent fails", async () => {
    const fixture = setup();
    const wakeups = fixture.wakeups();
    wakeups.register(fixture.orchestrator);
    await flush();
    fixture.clock.value += 10_000;
    wakeups.turnCompleted(fixture.orchestrator);
    await flush();
    const before = fixture.batches.length;
    const system: Actor = { kind: "system" };
    // Its own turn and a worker's turn report active/idle: no wakeup (no self-wakeup loop).
    for (const agentSessionId of [fixture.orchestrator, fixture.worker]) {
      fixture.core.updateAgentRuntimeState(system, { agentSessionId, status: "active" });
      fixture.core.updateAgentRuntimeState(system, { agentSessionId, status: "idle" });
    }
    fixture.clock.value += 60_000;
    await flush();
    expect(fixture.batches).toHaveLength(before);

    fixture.core.updateAgentRuntimeState(system, {
      agentSessionId: fixture.worker,
      status: "failed",
    });
    await flush();
    expect(fixture.batches).toHaveLength(before + 1);
    expect(fixture.batches.at(-1)!.events.map((event) => event.data.status)).toEqual(["failed"]);
    wakeups.close();
  });

  it("accumulates while a human holds the orchestrator and delivers once on release", async () => {
    const fixture = setup();
    const wakeups = fixture.wakeups();
    wakeups.register(fixture.orchestrator);
    await flush();
    fixture.clock.value += 10_000;
    wakeups.turnCompleted(fixture.orchestrator);
    await flush();
    const before = fixture.batches.length;

    fixture.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: fixture.orchestrator,
      held: true,
      reason: "takeover",
    });
    for (const text of ["one", "two", "three"]) {
      fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
        scope: { kind: "project", projectId: fixture.projectId },
        verbatim: text,
      });
    }
    fixture.clock.value += 60_000;
    await flush();
    expect(fixture.batches).toHaveLength(before);
    expect(wakeups.state(fixture.orchestrator).kind).toBe("held");

    fixture.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: fixture.orchestrator,
      held: false,
      reason: "release",
    });
    await flush();
    expect(fixture.batches).toHaveLength(before + 1);
    expect(fixture.types(before)).toEqual([
      "agent_session.hold_started",
      "instruction.created",
      "instruction.created",
      "instruction.created",
      "agent_session.hold_released",
    ]);
    wakeups.close();
  });

  it("throttles bursts and resumes from the persisted cursor after a restart", async () => {
    const fixture = setup();
    const first = fixture.wakeups({ minIntervalMs: 5_000 });
    first.register(fixture.orchestrator);
    await flush();
    const delivered = fixture.batches[0]!.toSeq;
    first.turnCompleted(fixture.orchestrator);
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "burst",
    });
    await flush();
    expect(fixture.batches).toHaveLength(1);
    expect(first.state(fixture.orchestrator).kind).toBe("throttled");
    fixture.clock.value += 5_000;
    fixture.fireTimers();
    await flush();
    expect(fixture.batches).toHaveLength(2);

    // Naru restarts while the second turn is in flight: its batch is delivered again, the first
    // (completed) batch is not.
    first.close();
    const second = fixture.wakeups();
    second.register(fixture.orchestrator);
    await flush();
    expect(fixture.batches).toHaveLength(3);
    expect(fixture.batches[2]!.fromSeq).toBe(delivered);
    expect(fixture.batches[2]!.events.map((event) => event.seq)).toEqual(
      fixture.batches[1]!.events.map((event) => event.seq),
    );
    // It says so (AP-D037), so the orchestrator checks before doing it again; first sends do not.
    expect(fixture.batches.map((batch) => batch.resent === true)).toEqual([false, false, true]);
    expect(wakeupText(fixture.batches[2]!)).toContain("sent before: check the current state");
    expect(wakeupText(fixture.batches[1]!)).not.toContain("sent before");
    second.close();
  });

  it("wakes the main orchestrator only for what is addressed to it (AP-D037)", async () => {
    const fixture = setup();
    const wakeups = fixture.wakeups();
    wakeups.register(fixture.main);
    await flush();
    const initial = fixture.batches.length;
    if (initial > 0) {
      fixture.clock.value += 10_000;
      wakeups.turnCompleted(fixture.main);
      await flush();
    }
    const baseline = fixture.batches.length;
    const system: Actor = { kind: "system" };

    // Project details, a worker's question and a worker going down are the project's business.
    fixture.core.createTask(fixture.ctx({ kind: "agent", agentSessionId: fixture.orchestrator }), {
      projectId: fixture.projectId,
      title: "project detail",
      purpose: "",
      completionCriteria: [],
      originInstructionId: fixture.goal,
    });
    fixture.core.requestHandoff(fixture.ctx({ kind: "agent", agentSessionId: fixture.worker }), {
      projectId: fixture.projectId,
      kind: "product-decision",
      payload: {
        reason: "priority conflict",
        blockingTaskIds: [],
        independentWorkToContinue: [],
        options: [],
        recommendation: "ship A first",
        risks: [],
        preparedEnvironment: [],
        resumeCondition: "user choice",
      },
    });
    fixture.core.updateAgentRuntimeState(system, {
      agentSessionId: fixture.worker,
      status: "failed",
    });
    fixture.clock.value += 10_000;
    await flush();
    expect(fixture.batches).toHaveLength(baseline);

    // The person's goal and a project orchestrator going down are.
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "global" },
      verbatim: "global goal",
    });
    fixture.core.updateAgentRuntimeState(system, {
      agentSessionId: fixture.orchestrator,
      status: "unknown",
    });
    expect(await fixture.drain(wakeups, fixture.main, baseline)).toEqual([
      "instruction.created",
      "agent_session.updated",
    ]);
    wakeups.close();
  });

  it("keeps a project orchestrator to its own project (AP-D037)", async () => {
    const fixture = setup();
    const wakeups = fixture.wakeups();
    wakeups.register(fixture.orchestrator);
    await flush();
    fixture.clock.value += 10_000;
    wakeups.turnCompleted(fixture.orchestrator);
    await flush();
    const baseline = fixture.batches.length;
    const system: Actor = { kind: "system" };

    // The person's global goal is the main orchestrator's; so is the person's word to it, and the
    // main orchestrator's own state. Another project is another orchestrator's. The person's word to
    // a worker is the worker's.
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "global" },
      verbatim: "global goal",
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "agent", projectId: null, agentSessionId: fixture.main },
      verbatim: "to main",
    });
    fixture.core.updateAgentRuntimeState(system, {
      agentSessionId: fixture.main,
      status: "unknown",
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.otherProjectId },
      verbatim: "other project",
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: fixture.worker },
      verbatim: "to the worker",
    });
    fixture.clock.value += 10_000;
    await flush();
    expect(fixture.batches).toHaveLength(baseline);

    // The main orchestrator's delegation to it and the person's project instruction wake it.
    fixture.core.delegate(fixture.ctx({ kind: "agent", agentSessionId: fixture.main }), {
      scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: fixture.orchestrator },
      verbatim: "plan it",
      originUserInstructionId: fixture.goal,
    });
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "project follow-up",
    });
    expect(await fixture.drain(wakeups, fixture.orchestrator, baseline)).toEqual([
      "instruction.created",
      "instruction.created",
    ]);
    wakeups.close();
  });

  it("sends a project's events to its lead when it has two orchestrators (AP-D038)", async () => {
    const fixture = setup();
    // The person started a second orchestrator (or an older one came back): the first one leads,
    // so adding one does not take the work away.
    const lead = fixture.orchestrator;
    const second = fixture.register("project-orchestrator", fixture.projectId);
    expect(fixture.core.leadProjectOrchestrator(fixture.projectId)?.id).toBe(lead);
    const wakeups = fixture.wakeups();
    for (const id of [lead, second]) {
      wakeups.register(id);
      await flush();
      fixture.clock.value += 10_000;
      wakeups.turnCompleted(id);
    }
    await flush();
    const baseline = fixture.batches.length;
    const woken = (from: number) =>
      new Set(fixture.batches.slice(from).map((b) => b.orchestrator.id));

    // The person's word to the project and a worker failing: the lead's.
    const followUp = fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "project", projectId: fixture.projectId },
      verbatim: "project follow-up",
    });
    expect(
      fixture.core.instructionRecipients({ kind: "system" }, followUp.id).map((agent) => agent.id),
    ).toEqual([lead]);
    fixture.core.updateAgentRuntimeState(
      { kind: "system" },
      { agentSessionId: fixture.worker, status: "failed" },
    );
    await fixture.drain(wakeups, lead, baseline);
    expect(woken(baseline)).toEqual(new Set([lead]));

    // What is addressed to the second one by name still reaches it.
    const before = fixture.batches.length;
    fixture.core.createHumanInstruction(fixture.ctx(HUMAN), {
      scope: { kind: "agent", projectId: fixture.projectId, agentSessionId: second },
      verbatim: "to the second one",
    });
    expect(await fixture.drain(wakeups, second, before)).toEqual(["instruction.created"]);
    expect(woken(before)).toEqual(new Set([second]));

    // Its delegated work is what is addressed to it; the project's work is the lead's.
    const work = (agentSessionId: string) =>
      fixture.core
        .getDelegatedWork({ kind: "agent", agentSessionId })
        .instructions.map((item) => item.verbatim);
    expect(work(second)).toEqual(["to the second one"]);
    expect(work(lead)).toEqual(expect.arrayContaining(["goal", "project follow-up"]));
    expect(work(lead)).not.toContain("to the second one");

    // The owner of the active plan leads, even when it came later.
    fixture.core.createPlan(fixture.ctx({ kind: "agent", agentSessionId: second }), {
      projectId: fixture.projectId,
      summary: "plan",
      activate: true,
    });
    expect(fixture.core.leadProjectOrchestrator(fixture.projectId)?.id).toBe(second);
    wakeups.close();
  });

  it("retries the same batch when the runtime does not accept it", async () => {
    const fixture = setup();
    let failures = 1;
    const wakeups = fixture.wakeups({}, (batch) => {
      if (failures-- > 0) return Promise.reject(new Error("runtime busy"));
      fixture.batches.push(batch);
      return Promise.resolve();
    });
    wakeups.register(fixture.orchestrator);
    await flush();
    expect(fixture.batches).toHaveLength(0);
    fixture.clock.value += 5_000;
    fixture.fireTimers();
    await flush();
    expect(fixture.batches).toHaveLength(1);
    expect(fixture.batches[0]!.fromSeq).toBe(0);
    wakeups.close();
  });
});

function setup() {
  const repository = new NaruRepository(":memory:");
  const project = repository.createProject("/tmp/naru-wakeup-project", "wakeup");
  const core = new AgentPlatformCore(repository.agentPlatform);
  let ordinal = 0;
  const ctx = (actor: Actor) => ({
    actor,
    idempotencyKey: `80000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
  });
  const register = (
    role: "main-orchestrator" | "project-orchestrator" | "worker",
    projectId: string | null,
  ) =>
    core.registerAgentSession(ctx(HUMAN), {
      projectId,
      role,
      runtime: "claude",
      native: false,
      observation: "pty",
      conversationWriter: "orchestrator",
    }).id;
  const main = register("main-orchestrator", null);
  const orchestrator = register("project-orchestrator", project.id);
  const otherProject = repository.createProject("/tmp/naru-wakeup-other", "other");
  const worker = register("worker", project.id);
  const goal = core.createHumanInstruction(ctx(HUMAN), {
    scope: { kind: "project", projectId: project.id },
    verbatim: "goal",
  }).id;
  const clock = { value: 1_000_000 };
  const timers: (() => void)[] = [];
  const batches: WakeupBatch[] = [];
  const recorder: OrchestratorInvoker["deliver"] = (batch) => {
    batches.push(batch);
    return Promise.resolve();
  };
  return {
    core,
    ctx,
    register,
    projectId: project.id,
    otherProjectId: otherProject.id,
    main,
    orchestrator,
    worker,
    goal,
    clock,
    batches,
    types: (index: number) => batches[index]!.events.map((event) => event.type),
    /** Ends each delivered turn until nothing is left; the event types delivered since `from`. */
    drain: async (wakeups: OrchestratorWakeups, agentSessionId: string, from: number) => {
      for (let round = 0; round < 10; round += 1) {
        await flush();
        clock.value += 10_000;
        wakeups.turnCompleted(agentSessionId);
        for (const timer of timers.splice(0)) timer();
      }
      await flush();
      return batches.slice(from).flatMap((batch) => batch.events.map((event) => event.type));
    },
    fireTimers: () => {
      for (const timer of timers.splice(0)) timer();
    },
    wakeups: (
      options: { minIntervalMs?: number } = {},
      deliver: OrchestratorInvoker["deliver"] = recorder,
    ) =>
      new OrchestratorWakeups(
        core,
        { deliver },
        {
          minIntervalMs: options.minIntervalMs ?? 5_000,
          now: () => clock.value,
          setTimer: (callback) => {
            timers.push(callback);
            return { cancel: () => undefined };
          },
        },
      ),
  };
}

async function flush(): Promise<void> {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
