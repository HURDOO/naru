import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      if (text.includes("APPROVE")) {
        await options.canUseTool("Write", {}, { signal: new AbortController().signal });
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
    first.supervisor.sendTurn(fixture.worker, "first turn", "orchestrator", 1);
    await until(() => fixture.status(first.core) === "idle", "first turn ends");

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
});
