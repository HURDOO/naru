import { describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import {
  OrchestratorWakeups,
  type OrchestratorInvoker,
  type WakeupBatch,
} from "../src/agent-platform/wakeups.js";
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
    second.close();
  });

  it("wakes the main orchestrator only for cross-project signals", async () => {
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

    fixture.core.createTask(fixture.ctx({ kind: "agent", agentSessionId: fixture.orchestrator }), {
      projectId: fixture.projectId,
      title: "project detail",
      purpose: "",
      completionCriteria: [],
      originInstructionId: fixture.goal,
    });
    fixture.clock.value += 10_000;
    await flush();
    expect(fixture.batches).toHaveLength(baseline);

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
    await flush();
    expect(fixture.batches).toHaveLength(baseline + 1);
    expect(fixture.types(baseline)).toEqual(["handoff.requested"]);
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
    projectId: project.id,
    main,
    orchestrator,
    worker,
    goal,
    clock,
    batches,
    types: (index: number) => batches[index]!.events.map((event) => event.type),
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
