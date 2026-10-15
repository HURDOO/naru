import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import {
  AgentPlatformCore,
  AgentPlatformError,
  nativeSessionName,
  parseCrossSessionPrompt,
} from "../src/agent-platform/core.js";
import {
  AgentSocketServer,
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../src/agent-platform/agent-socket.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

const wrap = (pid: number, body: string, name = "naru-sender") =>
  `<cross-session-message from="uds:/tmp/cc-socks/${pid}.sock" from-name="${name}" from-mode="prompting">\n${body}\n</cross-session-message>`;

describe("native Claude messaging under the Naru bridge (AP-D015)", () => {
  it("authorizes managed recipients with provenance and delivers only to the recorded sender", () => {
    const fixture = setup();
    const agent = (id: string): Actor => ({ kind: "agent", agentSessionId: id });
    const authorized = fixture.core.authorizeNativeMessage(fixture.ctx(agent(fixture.a)), {
      recipientName: nativeSessionName(fixture.b),
      message: "BRIDGE-PING verbatim",
      senderPids: [4242],
    });
    expect(authorized).toMatchObject({
      channel: "native-message",
      author: { kind: "agent", agentSessionId: fixture.a },
      originUserInstructionId: fixture.taskOrigin,
      scope: { kind: "agent", agentSessionId: fixture.b },
    });

    // Another process or another recipient cannot consume it.
    expectCode(
      () =>
        fixture.core.deliverNativeMessage(agent(fixture.b), {
          prompt: wrap(9999, "BRIDGE-PING verbatim"),
        }),
      "AGENT_INVALID_REFERENCE",
    );
    expectCode(
      () =>
        fixture.core.deliverNativeMessage(agent(fixture.c), {
          prompt: wrap(4242, "BRIDGE-PING verbatim"),
        }),
      "AGENT_INVALID_REFERENCE",
    );
    const delivered = fixture.core.deliverNativeMessage(agent(fixture.b), {
      prompt: wrap(4242, "BRIDGE-PING   verbatim"),
    });
    expect(delivered.id).toBe(authorized.id);
    // Replays are refused once delivered.
    expectCode(
      () =>
        fixture.core.deliverNativeMessage(agent(fixture.b), {
          prompt: wrap(4242, "BRIDGE-PING verbatim"),
        }),
      "AGENT_INVALID_REFERENCE",
    );
    expect(
      fixture.core
        .readEvents(HUMAN, { afterSeq: 0 })
        .filter((event) => event.type === "instruction.delivered")
        .map((event) => event.subjectId),
    ).toEqual([authorized.id]);
  });

  it("refuses unmanaged, out-of-scope, held and origin-less sends", () => {
    const fixture = setup();
    const agent = (id: string): Actor => ({ kind: "agent", agentSessionId: id });
    const send = (from: string, to: string) =>
      fixture.core.authorizeNativeMessage(fixture.ctx(agent(from)), {
        recipientName: to,
        message: "hello",
        senderPids: [1234],
      });
    expectCode(() => send(fixture.a, "naru-spike-somebody"), "AGENT_NOT_FOUND");
    expectCode(() => send(fixture.a, nativeSessionName(fixture.other)), "AGENT_SCOPE_DENIED");
    fixture.core.setHumanHold(fixture.ctx(HUMAN), {
      agentSessionId: fixture.b,
      held: true,
      reason: "takeover",
    });
    expectCode(() => send(fixture.a, nativeSessionName(fixture.b)), "AGENT_HELD_BY_HUMAN");
    // c has no task and no user instruction applies to its project yet.
    expectCode(
      () => send(fixture.otherSender, nativeSessionName(fixture.other)),
      "AGENT_INVALID_REFERENCE",
    );
  });

  it("parses the native wrapper and rejects plain prompts", () => {
    expect(parseCrossSessionPrompt(wrap(77, "body text"))).toEqual({
      pid: 77,
      name: "naru-sender",
      body: "body text",
    });
    expect(parseCrossSessionPrompt("plain prompt")).toBeNull();
  });

  it("runs the hook bin end to end: allow, deny, deliver, block and fail closed", async () => {
    const fixture = setup();
    const directory = mkdtempSync(join(tmpdir(), "naru-agent-hook-"));
    const server = new AgentSocketServer(directory, fixture.core);
    await server.start();
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    cleanups.push(() => server.close());
    const tokenA = fixture.core.issueAgentCapability(HUMAN, fixture.a);
    const tokenB = fixture.core.issueAgentCapability(HUMAN, fixture.b);

    const sendHook = (token: string, to: string, message: string, socket = server.socketPath) =>
      runHook(socket, token, {
        hook_event_name: "PreToolUse",
        tool_name: "SendMessage",
        tool_use_id: `toolu_${to}_${message.length}`,
        tool_input: { to, message },
      });
    expect((await sendHook(tokenA, nativeSessionName(fixture.b), "HOOK-PING")).stdout).toBe("");
    const denied = JSON.parse((await sendHook(tokenA, "someone-else", "HOOK-PING")).stdout) as {
      hookSpecificOutput: { permissionDecision: string };
    };
    expect(denied.hookSpecificOutput.permissionDecision).toBe("deny");

    // The hook's sender pids are the test process (its parent) and the test's parent.
    const receive = (token: string, pid: number, body: string) =>
      runHook(server.socketPath, token, {
        hook_event_name: "UserPromptSubmit",
        prompt: wrap(pid, body),
        prompt_id: "prompt-1",
      });
    expect((await receive(tokenB, process.pid, "HOOK-PING")).stdout).toBe("");
    const blocked = JSON.parse((await receive(tokenB, process.pid, "HOOK-INTRUDER")).stdout) as {
      decision: string;
    };
    expect(blocked.decision).toBe("block");

    // Subagent messaging is not routed through Naru.
    expect(
      (
        await runHook(server.socketPath, tokenA, {
          hook_event_name: "PreToolUse",
          tool_name: "SendMessage",
          tool_input: { to: "agent-1", message: "x", recipient_kind: "agent" },
        })
      ).stdout,
    ).toBe("");

    // Naru unreachable: deny.
    const closed = JSON.parse(
      (
        await sendHook(
          tokenA,
          nativeSessionName(fixture.b),
          "HOOK-DOWN",
          join(directory, "missing.sock"),
        )
      ).stdout,
    ) as { hookSpecificOutput: { permissionDecisionReason: string } };
    expect(closed.hookSpecificOutput.permissionDecisionReason).toContain("unavailable");
  });

  it("records a person's TUI prompt only in TUI mode", async () => {
    const fixture = setup();
    const directory = mkdtempSync(join(tmpdir(), "naru-agent-hook-"));
    const server = new AgentSocketServer(directory, fixture.core);
    await server.start();
    cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
    cleanups.push(() => server.close());
    const token = fixture.core.issueAgentCapability(HUMAN, fixture.b);
    const prompt = {
      hook_event_name: "UserPromptSubmit",
      prompt: "테스트를 먼저 써.",
      prompt_id: "p-1",
    };
    await runHook(server.socketPath, token, prompt, "runner");
    const tuiOnly = () =>
      fixture.core
        .getApplicableInstructions(HUMAN, {
          projectId: fixture.projectId,
          agentSessionId: fixture.b,
        })
        .filter((instruction) => instruction.channel === "tui");
    expect(tuiOnly()).toEqual([]);
    await runHook(server.socketPath, token, prompt, "tui");
    await runHook(server.socketPath, token, prompt, "tui");
    expect(tuiOnly().map((instruction) => instruction.verbatim)).toEqual(["테스트를 먼저 써."]);
  });
});

function setup() {
  const repository = new NaruRepository(":memory:");
  cleanups.push(() => repository.close());
  const project = repository.createProject("/tmp/naru-native-project", "native");
  const otherProject = repository.createProject("/tmp/naru-native-other", "other");
  const core = new AgentPlatformCore(repository.agentPlatform);
  let ordinal = 0;
  const ctx = (actor: Actor) => ({
    actor,
    idempotencyKey: `a0000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
  });
  const register = (role: "project-orchestrator" | "worker", projectId: string) =>
    core.registerAgentSession(ctx(HUMAN), {
      projectId,
      role,
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
  const a = register("project-orchestrator", project.id);
  const b = register("worker", project.id);
  const c = register("worker", project.id);
  const other = register("worker", otherProject.id);
  const otherSender = register("project-orchestrator", otherProject.id);
  const goal = core.createHumanInstruction(ctx(HUMAN), {
    scope: { kind: "project", projectId: project.id },
    verbatim: "goal",
  }).id;
  const task = core.createTask(ctx({ kind: "agent", agentSessionId: a }), {
    projectId: project.id,
    title: "coordinate",
    purpose: "",
    completionCriteria: [],
    originInstructionId: goal,
  });
  core.updateTask(ctx(HUMAN), {
    taskId: task.id,
    expectedRevision: task.revision,
    assigneeAgentSessionId: a,
    status: "running",
  });
  return {
    core,
    ctx,
    projectId: project.id,
    a,
    b,
    c,
    other,
    otherSender,
    taskOrigin: goal,
  };
}

function runHook(
  socketPath: string,
  capability: string,
  payload: Record<string, unknown>,
  mode: "runner" | "tui" = "runner",
): Promise<{ stdout: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", join(process.cwd(), "apps/server/src/agent-hook-cli.ts")],
      {
        env: {
          ...process.env,
          [NARU_AGENT_SOCKET_ENV]: socketPath,
          [NARU_AGENT_CAPABILITY_ENV]: capability,
          NARU_AGENT_HOOK_MODE: mode,
        },
        stdio: ["pipe", "pipe", "inherit"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (data: Buffer) => (stdout += data.toString("utf8")));
    child.on("close", (code) => resolve({ stdout: stdout.trim(), code }));
    child.stdin.end(JSON.stringify(payload));
  });
}

function expectCode(action: () => unknown, code: AgentPlatformError["code"]): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AgentPlatformError);
    expect((error as AgentPlatformError).code).toBe(code);
    return;
  }
  throw new Error(`Expected ${code}`);
}
