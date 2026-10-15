import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import type { RunnerPlan } from "../src/agent-runtime/channel-protocol.js";
import { ChildProcessRunnerLauncher } from "../src/agent-runtime/child-process-launcher.js";
import {
  RuntimeChannelServer,
  runtimeChannelSocketPath,
} from "../src/agent-runtime/runtime-channel-server.js";
import { ManagedAgentSupervisor, SupervisorError } from "../src/agent-runtime/supervisor.js";
import { OrchestratorWakeups } from "../src/agent-platform/wakeups.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// A scripted stand-in for the user-installed SDK (AP-D012): same exports, no model.
const FAKE_SDK = `
export function query({ prompt, options }) {
  let interrupted = false;
  async function* run() {
    yield { type: "system", subtype: "init", session_id: options.resume ?? "fake-session-1" };
    for await (const message of prompt) {
      const text = message.message.content;
      if (process.env.FAKE_SDK_PROMPTS) {
        (await import("node:fs")).appendFileSync(process.env.FAKE_SDK_PROMPTS, JSON.stringify(text) + "\\n");
      }
      if (text.includes("APPROVE")) {
        await options.canUseTool("Write", {}, { signal: new AbortController().signal });
      }
      if (text.includes("CHILD")) {
        yield { type: "system", subtype: "task_started", task_id: "child-1" };
        await new Promise((resolve) => setTimeout(resolve, 400));
        yield { type: "system", subtype: "task_notification", task_id: "child-1", status: "completed" };
      }
      const slow = /SLOW(\\d+)/.exec(text);
      if (slow) await new Promise((resolve) => setTimeout(resolve, Number(slow[1])));
      yield interrupted
        ? { type: "result", subtype: "error_during_execution", is_error: true }
        : { type: "result", subtype: "success", is_error: false };
      interrupted = false;
    }
  }
  const iterator = run();
  iterator.interrupt = async () => { interrupted = true; };
  return iterator;
}
export async function getSessionMessages(sessionId) {
  return [{ type: "user", session_id: sessionId }, { type: "assistant", session_id: sessionId }];
}
`;

async function until(check: () => boolean, label: string, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out: ${label}`);
}

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "naru-supervisor-"));
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  const sdkEntry = join(directory, "fake-sdk.mjs");
  writeFileSync(sdkEntry, FAKE_SDK, { mode: 0o600 });
  const repository = new NaruRepository(":memory:");
  cleanups.push(() => repository.close());
  const project = repository.createProject(directory, "supervisor");
  let ordinal = 0;
  const ctx = (actor: Actor) => ({
    actor,
    idempotencyKey: `d0000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
  });
  const bootstrapCore = new AgentPlatformCore(repository.agentPlatform);
  const worker = bootstrapCore.registerAgentSession(ctx(HUMAN), {
    projectId: project.id,
    role: "worker",
    runtime: "claude",
    native: false,
    observation: "transcript",
    conversationWriter: "orchestrator",
  }).id;
  const plan = (resumeRef: string | null): RunnerPlan => ({
    executable: "/fixture/claude",
    sdkEntry,
    cwd: directory,
    model: "claude-opus-5-5",
    resumeRef,
    nativeName: "naru-fixture",
    settings: {},
    mcpServers: {},
    instructions: "",
    permissionMode: "default",
    environment: {},
  });
  const consoleLines: string[] = [];
  let current: ManagedAgentSupervisor | null = null;
  const launcher = new ChildProcessRunnerLauncher({
    runnerEnvironment: (agentSessionId) => current!.runnerEnvironment(agentSessionId),
    command: process.execPath,
    args: ["--import", "tsx", join(process.cwd(), "apps/server/src/claude-agent-runner.ts")],
    environment: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: directory },
    onOutput: (_agent, line) => consoleLines.push(line),
  });
  cleanups.push(() => launcher.killAll());

  /** One "Naru process": core + supervisor + channel server over the shared database. */
  async function naru() {
    const core = new AgentPlatformCore(repository.agentPlatform);
    const supervisor = new ManagedAgentSupervisor({
      core,
      launcher,
      channelSocketPath: runtimeChannelSocketPath(directory),
      planFor: (agent) => plan(agent.runtimeSessionRef),
    });
    current = supervisor;
    const server = new RuntimeChannelServer(directory, supervisor);
    await server.start();
    cleanups.push(() => supervisor.close());
    return { core, supervisor, server };
  }
  const status = (core: AgentPlatformCore) => core.getAgentSession(HUMAN, worker).status;
  return { naru, worker, status, consoleLines, ctx };
}

describe("managed agent supervisor with a real runner process", () => {
  it("runs turns through the writer gate, approvals and history, and survives a Naru restart", async () => {
    const fixture = setup();
    const first = await fixture.naru();
    await first.supervisor.launch(fixture.worker);
    await until(
      () =>
        first.core.getAgentSession(HUMAN, fixture.worker).runtimeSessionRef === "fake-session-1",
      "conversation ready",
    );

    const owner = first.supervisor.writer(fixture.worker);
    expect(owner).toEqual({ writer: "orchestrator", generation: 1 });
    expect(() => first.supervisor.sendTurn(fixture.worker, "hi", "gui", 1)).toThrow(
      SupervisorError,
    );
    first.supervisor.sendTurn(fixture.worker, "first turn with a CHILD", "orchestrator", 1);
    await until(
      () => first.supervisor.runtimeState(fixture.worker).children.length === 1,
      "subagent observed",
    );
    await until(() => fixture.status(first.core) === "idle", "first turn ends");
    expect(first.supervisor.runtimeState(fixture.worker).children).toEqual([]);

    // A person takes over the conversation in Chat; the orchestrator's generation is fenced.
    first.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: fixture.worker,
      held: true,
      reason: "takeover",
    });
    await first.supervisor.switchWriter(fixture.worker, "gui", false);
    expect(() => first.supervisor.sendTurn(fixture.worker, "late", "orchestrator", 1)).toThrow(
      /Another writer/,
    );
    first.supervisor.sendTurn(fixture.worker, "please APPROVE", "gui", 2);
    await until(() => first.supervisor.pendingApprovals(fixture.worker).length === 1, "approval");
    const [approval] = first.supervisor.pendingApprovals(fixture.worker);
    expect(approval?.kind).toBe("file");
    first.supervisor.respondApproval(fixture.worker, approval!.requestId, "approve", "gui", 2);
    await until(() => first.supervisor.pendingApprovals(fixture.worker).length === 0, "resolved");
    await until(() => fixture.status(first.core) === "idle", "approved turn ends");

    const history = await first.supervisor.readHistory(fixture.worker, null);
    expect(history.items).toHaveLength(2);

    // Naru restarts while a turn is still running; the runner keeps going and reconnects.
    first.supervisor.sendTurn(fixture.worker, "SLOW600 work", "gui", 2);
    await until(() => fixture.status(first.core) === "active", "slow turn starts");
    await first.server.close();
    const second = await fixture.naru();
    await until(() => fixture.status(second.core) === "idle", "result delivered after restart");
    expect(fixture.consoleLines.join("\n")).not.toContain("SLOW600");

    // The human hold outlives the restart: the orchestrator still cannot write.
    expect(second.supervisor.writer(fixture.worker)).toEqual({ writer: "gui", generation: 1 });
    expect(() => second.supervisor.sendTurn(fixture.worker, "x", "orchestrator", 1)).toThrow(
      /Another writer/,
    );
    second.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: fixture.worker,
      held: false,
      reason: "release",
    });
    const released = await second.supervisor.switchWriter(fixture.worker, "orchestrator", false);
    second.supervisor.sendTurn(
      fixture.worker,
      "after release",
      "orchestrator",
      released.generation,
    );
    await until(() => fixture.status(second.core) === "idle", "turn after release");

    // An idle runner (nothing else keeps it alive) waits for Naru across another restart.
    await second.server.close();
    second.supervisor.close();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const third = await fixture.naru();
    await until(() => {
      try {
        return third.supervisor.runtimeState(fixture.worker).connected;
      } catch {
        return false; // not reconnected yet
      }
    }, "idle reconnect");
    const { generation } = third.supervisor.writer(fixture.worker);
    third.supervisor.sendTurn(fixture.worker, "after an idle restart", "orchestrator", generation);
    await until(() => fixture.status(third.core) === "idle", "turn after idle restart");

    third.supervisor.stop(fixture.worker);
    await until(() => fixture.status(third.core) === "stopped", "stopped");
    await third.server.close();
  }, 60_000);

  it("lets an orchestrator interrupt a worker's turn unless a person holds it", async () => {
    const fixture = setup();
    const naru = await fixture.naru();
    const projectId = naru.core.getAgentSession(HUMAN, fixture.worker).projectId;
    const orchestrator = naru.core.registerAgentSession(fixture.ctx(HUMAN), {
      projectId,
      role: "project-orchestrator",
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
    const byAgent = (agentSessionId: string): Actor => ({ kind: "agent", agentSessionId });
    await naru.supervisor.launch(fixture.worker);
    await until(() => fixture.status(naru.core) === "idle", "conversation ready");

    naru.supervisor.sendTurn(fixture.worker, "SLOW800 long work", "orchestrator", 1);
    await until(() => naru.supervisor.runtimeState(fixture.worker).turnActive, "turn running");
    expect(() => naru.supervisor.interruptByAgent(byAgent(fixture.worker), fixture.worker)).toThrow(
      /cannot agent.interrupt/,
    );
    expect(naru.supervisor.interruptByAgent(byAgent(orchestrator), fixture.worker).turnActive).toBe(
      true,
    );
    await until(() => fixture.status(naru.core) === "idle", "interrupted turn ends");

    naru.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: fixture.worker,
      held: true,
      reason: "takeover",
    });
    expect(() => naru.supervisor.interruptByAgent(byAgent(orchestrator), fixture.worker)).toThrow(
      /human is working/,
    );
    naru.supervisor.stop(fixture.worker);
    await until(() => fixture.status(naru.core) === "stopped", "stopped");
    await naru.server.close();
  }, 30_000);

  it("wakes a project orchestrator with a Naru event turn when the user instructs its project", async () => {
    const directory = mkdtempSync(join(tmpdir(), "naru-wakeup-"));
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    const sdkEntry = join(directory, "fake-sdk.mjs");
    writeFileSync(sdkEntry, FAKE_SDK, { mode: 0o600 });
    const prompts = join(directory, "prompts.log");
    writeFileSync(prompts, "", { mode: 0o600 });
    const repository = new NaruRepository(":memory:");
    cleanups.push(() => repository.close());
    const project = repository.createProject(directory, "wakeups");
    const core = new AgentPlatformCore(repository.agentPlatform);
    let ordinal = 0;
    const ctx = () => ({
      actor: HUMAN,
      idempotencyKey: `f0000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
    });
    const orchestrator = core.registerAgentSession(ctx(), {
      projectId: project.id,
      role: "project-orchestrator",
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
    let supervisor: ManagedAgentSupervisor | null = null;
    const launcher = new ChildProcessRunnerLauncher({
      runnerEnvironment: (agentSessionId) => supervisor!.runnerEnvironment(agentSessionId),
      command: process.execPath,
      args: ["--import", "tsx", join(process.cwd(), "apps/server/src/claude-agent-runner.ts")],
      environment: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: directory,
        FAKE_SDK_PROMPTS: prompts,
      },
    });
    cleanups.push(() => launcher.killAll());
    supervisor = new ManagedAgentSupervisor({
      core,
      launcher,
      channelSocketPath: runtimeChannelSocketPath(directory),
      planFor: (agent) => ({
        executable: "/fixture/claude",
        sdkEntry,
        cwd: directory,
        model: "claude-opus-5-5",
        resumeRef: agent.runtimeSessionRef,
        nativeName: "naru-fixture",
        settings: {},
        mcpServers: {},
        instructions: "",
        permissionMode: "default",
        environment: {},
      }),
    });
    const wakeups = new OrchestratorWakeups(core, supervisor, { minIntervalMs: 0 });
    supervisor.useWakeups(wakeups);
    cleanups.push(() => wakeups.close());
    const server = new RuntimeChannelServer(directory, supervisor);
    await server.start();
    cleanups.push(async () => {
      supervisor.close();
      await server.close();
    });
    const delivered = () =>
      readFileSync(prompts, "utf8")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as string);
    await supervisor.launch(orchestrator);
    // Once reachable, the orchestrator is woken for what already happened (its registration).
    await until(() => delivered().length === 1, "first wakeup");
    expect(delivered()[0]).toContain("agent_session.registered");
    await until(() => core.getAgentSession(HUMAN, orchestrator).status === "idle", "first turn");
    // Its own turn's state reports do not wake it again (no self-wakeup loop).
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivered()).toHaveLength(1);

    core.createHumanInstruction(ctx(), {
      scope: { kind: "project", projectId: project.id },
      verbatim: "결제 흐름을 먼저 끝내 줘.",
    });
    await until(() => delivered().length === 2, "wakeup turn");
    const turn = delivered()[1]!;
    expect(turn).toContain("[Naru] New events");
    expect(turn).toContain("instruction.created");
    // The wakeup carries references only; the orchestrator reads the text through its tools.
    expect(turn).not.toContain("결제");
    await until(() => core.getAgentSession(HUMAN, orchestrator).status === "idle", "turn done");

    // While a person holds the orchestrator, events accumulate instead of becoming turns.
    core.setHumanHold(ctx(), { agentSessionId: orchestrator, held: true, reason: "takeover" });
    await supervisor.switchWriter(orchestrator, "gui", false);
    core.createHumanInstruction(ctx(), {
      scope: { kind: "project", projectId: project.id },
      verbatim: "다음 지시",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(delivered()).toHaveLength(2);
    await supervisor.switchWriter(orchestrator, "orchestrator", false);
    core.setHumanHold(ctx(), { agentSessionId: orchestrator, held: false, reason: "release" });
    await until(() => delivered().length === 3, "accumulated events after release");
    expect(delivered()[2]).toContain("agent_session.hold_released");
    expect(delivered()[2]).toContain("instruction.created");
    supervisor.stop(orchestrator);
    await until(() => core.getAgentSession(HUMAN, orchestrator).status === "stopped", "stopped");
  }, 60_000);
});
