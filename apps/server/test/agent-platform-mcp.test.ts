import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import {
  AgentSocketServer,
  callAgentSocket,
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../src/agent-platform/agent-socket.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Agent Platform socket and MCP bin", () => {
  it("binds every call to the capability's agent and never trusts argument identity", async () => {
    const fixture = await platform();
    expect(statSync(fixture.server.socketPath).mode & 0o777).toBe(0o600);
    const call = (capability: string, tool: string, args: Record<string, unknown>) =>
      callAgentSocket(fixture.server.socketPath, {
        version: 1,
        capability,
        tool,
        arguments: args,
      });

    const state = await call(fixture.workerToken, "get_project_state", {});
    expect(state).toMatchObject({ ok: true, result: { tasks: [], openHandoffs: [] } });

    const spoofed = await call(fixture.workerToken, "get_applicable_user_instructions", {
      from: fixture.orchestrator,
    });
    expect(spoofed).toMatchObject({ ok: false, code: "INVALID", fields: ["(root)"] });

    const denied = await call(fixture.workerToken, "create_task", {
      project_id: fixture.projectId,
      title: "worker should not plan",
      purpose: "",
      completion_criteria: [],
      origin_instruction_id: fixture.goalId,
    });
    expect(denied).toMatchObject({ ok: false, code: "AGENT_ROLE_DENIED" });

    const secret = "fixture-secret-text-never-echoed";
    const invalid = await call(fixture.workerToken, "report_progress", {
      run_id: "not-a-uuid",
      summary: secret,
    });
    expect(invalid).toMatchObject({ ok: false, code: "INVALID", fields: ["run_id"] });
    expect(JSON.stringify(invalid)).not.toContain(secret);

    expect(await call("x".repeat(43), "get_project_state", {})).toMatchObject({
      ok: false,
      code: "DENIED",
    });
    expect(await call(fixture.workerToken, "drop_database", {})).toMatchObject({
      ok: false,
      code: "UNKNOWN_TOOL",
    });

    fixture.core.revokeAgentCapabilities(HUMAN, fixture.worker);
    expect(await call(fixture.workerToken, "get_project_state", {})).toMatchObject({
      ok: false,
      code: "DENIED",
    });
  });

  it("serves MCP over stdio and records delegations under the bound orchestrator", async () => {
    const fixture = await platform();
    const mcp = startMcp(fixture.server.socketPath, fixture.orchestratorToken);

    const init = await mcp.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "fixture", version: "0" },
    });
    expect(init).toMatchObject({
      result: { protocolVersion: "2025-06-18", serverInfo: { name: "naru" } },
    });
    mcp.notify("notifications/initialized");

    const listed = (await mcp.request("tools/list", {})) as {
      result: { tools: { name: string; inputSchema: { type: string } }[] };
    };
    const names = listed.result.tools.map((tool) => tool.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "get_project_state",
        "get_applicable_user_instructions",
        "delegate",
        "request_human_handoff",
        "propose_design_change",
        "get_merge_gate",
      ]),
    );
    expect(listed.result.tools.every((tool) => tool.inputSchema.type === "object")).toBe(true);

    const instructions = (await mcp.request("tools/call", {
      name: "get_applicable_user_instructions",
      arguments: {},
    })) as { result: { content: { text: string }[] } };
    expect(instructions.result.content[0]?.text).toContain("Hook/MCP");

    const delegated = (await mcp.request("tools/call", {
      name: "delegate",
      arguments: {
        scope_kind: "agent",
        project_id: fixture.projectId,
        agent_session_id: fixture.worker,
        verbatim: "공식 확장 지점만 사용해 구현하라.",
        origin_user_instruction_id: fixture.goalId,
      },
    })) as { result: { isError?: boolean; content: { text: string }[] } };
    expect(delegated.result.isError).toBeUndefined();
    expect(JSON.parse(delegated.result.content[0]!.text)).toMatchObject({
      author: { kind: "agent", agentSessionId: fixture.orchestrator },
      originUserInstructionId: fixture.goalId,
      channel: "mcp",
    });

    const unbound = startMcp(fixture.server.socketPath, undefined);
    await unbound.request("initialize", { protocolVersion: "2099-01-01" });
    const refused = (await unbound.request("tools/call", {
      name: "get_project_state",
      arguments: {},
    })) as { result: { isError: boolean; content: { text: string }[] } };
    expect(refused.result.isError).toBe(true);
    expect(refused.result.content[0]?.text).toContain("UNAVAILABLE");
  });
});

async function platform() {
  const directory = mkdtempSync(join(tmpdir(), "naru-agent-mcp-"));
  const repository = new NaruRepository(":memory:");
  const project = repository.createProject("/tmp/naru-agent-mcp-project", "mcp");
  const core = new AgentPlatformCore(repository.agentPlatform);
  let ordinal = 0;
  const ctx = () => ({
    actor: HUMAN,
    idempotencyKey: `60000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
  });
  const register = (role: "project-orchestrator" | "worker") =>
    core.registerAgentSession(ctx(), {
      projectId: project.id,
      role,
      runtime: "claude",
      native: false,
      observation: "pty",
      conversationWriter: "orchestrator",
    }).id;
  const orchestrator = register("project-orchestrator");
  const worker = register("worker");
  const goalId = core.createHumanInstruction(ctx(), {
    scope: { kind: "project", projectId: project.id },
    verbatim: "Kiro 기존 에이전트에 Hook/MCP로 가이드를 연결해 줘.",
  }).id;
  const server = new AgentSocketServer(directory, core);
  await server.start();
  cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  cleanups.push(() => repository.close());
  cleanups.push(() => server.close());
  return {
    core,
    server,
    projectId: project.id,
    orchestrator,
    worker,
    goalId,
    orchestratorToken: core.issueAgentCapability(HUMAN, orchestrator),
    workerToken: core.issueAgentCapability(HUMAN, worker),
  };
}

function startMcp(socketPath: string, capability: string | undefined) {
  const environment: NodeJS.ProcessEnv = { ...process.env, [NARU_AGENT_SOCKET_ENV]: socketPath };
  if (capability === undefined) delete environment[NARU_AGENT_CAPABILITY_ENV];
  else environment[NARU_AGENT_CAPABILITY_ENV] = capability;
  const child = spawn(
    process.execPath,
    ["--import", "tsx", join(process.cwd(), "apps/server/src/agent-mcp-cli.ts")],
    { env: environment, stdio: ["pipe", "pipe", "inherit"] },
  );
  cleanups.push(() => {
    child.kill();
  });
  const pending = new Map<number, (message: unknown) => void>();
  createInterface({ input: child.stdout }).on("line", (line) => {
    const message = JSON.parse(line) as { id?: number };
    if (typeof message.id === "number") pending.get(message.id)?.(message);
  });
  let nextId = 0;
  return {
    request(method: string, params: unknown): Promise<unknown> {
      const id = ++nextId;
      return new Promise((resolve) => {
        pending.set(id, resolve);
        child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      });
    },
    notify(method: string): void {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method })}\n`);
    },
  };
}
