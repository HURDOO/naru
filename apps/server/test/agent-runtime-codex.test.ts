import { chmodSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture } from "../../durable-session-host/test/support.js";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import { RuntimeLaunchers } from "../src/agent-runtime/agent-launchers.js";
import { CodexAgentPanes } from "../src/agent-runtime/codex/agent-panes.js";
import {
  RuntimeChannelServer,
  runtimeChannelSocketPath,
} from "../src/agent-runtime/runtime-channel-server.js";
import { ManagedAgentSupervisor } from "../src/agent-runtime/supervisor.js";
import { NaruRepository } from "../src/database.js";
import { DurableHostSessionFacade } from "../src/durable-session-facade.js";
import {
  UdsDurableSessionLifecycleClient,
  type DurableHostConfig,
} from "../src/durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "../src/durable-session-stream-port.js";
import { NaruCodexIntegration } from "../src/integrations/codex/port.js";
import { CodexIntegrationServer } from "../src/integrations/codex/server.js";
import { LaunchProfileRegistry } from "../src/launch-profiles.js";
import { fakeCodexScript } from "./fake-codex.js";

const HUMAN: Actor = { kind: "human" };
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxLoader = pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href;
const wsModule = createRequire(join(repositoryRoot, "apps/server/package.json")).resolve("ws");
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => boolean, label: string, ms = 30_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`timed out: ${label}`);
}

async function startFixture() {
  if (process.versions.node.split(".")[0] !== "24") throw new Error("Node 24 required");
  const fixture = createHostFixture();
  cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
  const node = realpathSync(process.execPath);
  const codex = join(fixture.root, "codex");
  writeFileSync(codex, fakeCodexScript(node, wsModule), { mode: 0o700 });
  chmodSync(codex, 0o700);
  const codexLog = join(fixture.root, "fake-codex.log");
  writeFileSync(codexLog, "", { mode: 0o600 });
  const environment = {
    PATH: `${dirname(node)}:/usr/bin:/bin`,
    HOME: fixture.root,
    FAKE_CODEX_LOG: codexLog,
  };

  const config: DurableHostConfig = {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds: ["codex-main"],
    roots: fixture.config.roots,
  };
  const repository = new NaruRepository(join(fixture.root, "naru.sqlite"), {
    sessionOwner: "durable-host",
  });
  cleanups.push(() => repository.close());
  const project = repository.createProject(
    join(fixture.config.roots[0]!.path, "sample"),
    "codex agents",
  );
  const core = new AgentPlatformCore(repository.agentPlatform);

  let supervisor: ManagedAgentSupervisor | null = null;
  let facade: DurableHostSessionFacade | null = null;
  const codexPanes = new CodexAgentPanes({
    config: {
      node: { file: node, args: ["--import", tsxLoader] },
      entries: { mcp: join(repositoryRoot, "apps/server/src/agent-mcp-cli.ts") },
      agentSocketPath: join(fixture.root, "agent.sock"),
    },
    core,
    repository,
    sessions: () => facade!,
    runnerEnvironment: (agentSessionId) => supervisor!.runnerEnvironment(agentSessionId),
  });
  const doctor = JSON.stringify({
    checks: {
      installation: { status: "ok" },
      "auth.credentials": { status: "ok" },
      "config.load": { status: "ok" },
    },
  });
  const launchProfiles = new LaunchProfileRegistry({
    codexExecutable: codex,
    environment,
    commandRunner: () => ({ stdout: doctor, stderr: "", status: 0 }),
    codexAgentPanes: codexPanes,
  });
  const codexIntegration = new NaruCodexIntegration(repository, config, launchProfiles);
  const integrationServer = new CodexIntegrationServer(fixture.root, codexIntegration);
  await integrationServer.start();
  const host = await startDurableSessionHost(
    DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      profiles: [
        {
          profileId: "codex-main",
          executable: node,
          args: [
            "--import",
            tsxLoader,
            join(repositoryRoot, "apps/server/src/codex-integration-launcher.ts"),
          ],
          envPolicyId: "safe-env",
          resourcePolicyId: "fixture-resource",
        },
      ],
      environmentPolicies: [
        {
          envPolicyId: "safe-env",
          inherit: [],
          values: { ...environment, NARU_CODEX_INTEGRATION_SOCKET: integrationServer.socketPath },
        },
      ],
      resourcePolicies: [
        {
          ...fixture.config.resourcePolicies[0],
          allowedExecutables: [node],
          stopTimeoutMs: 5_000,
        },
      ],
      integrationPolicies: [
        {
          policyRef: "naru-codex-v0",
          appId: config.appId,
          integrationKind: "codex",
          profileIds: ["codex-main"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    }),
    { logger: silentHostLogger, hostEnvironment: {} },
  );
  facade = new DurableHostSessionFacade(
    repository,
    config,
    new UdsDurableSessionLifecycleClient(config),
    new UdsDurableSessionStreamPort(config),
    Date.now,
    codexIntegration,
    integrationServer,
  );
  await facade.reconcile();
  cleanups.push(async () => {
    await host.close();
    await facade.shutdown();
  });
  const launchers = new RuntimeLaunchers(core, { codex: codexPanes });

  async function naru() {
    const instance = new ManagedAgentSupervisor({
      core,
      launcher: launchers,
      channelSocketPath: runtimeChannelSocketPath(fixture.root),
      planFor: (agent) => launchers.plan(agent),
    });
    supervisor = instance;
    const server = new RuntimeChannelServer(fixture.root, instance);
    await server.start();
    cleanups.push(async () => {
      instance.close();
      await server.close();
    });
    return { supervisor: instance, server };
  }
  const codexEvents = () =>
    readFileSync(codexLog, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  return { repository, project, core, facade, naru, codexEvents };
}

describe("managed Codex agent in a DurableSession Host PTY (AP-T13)", () => {
  it("shares one thread between Naru and the real TUI under Naru's single writer", async () => {
    const env = await startFixture();
    const worker = env.core.registerAgentSession(
      { actor: HUMAN, idempotencyKey: "c0000000-0000-4000-8000-000000000001" },
      {
        projectId: env.project.id,
        role: "worker",
        runtime: "codex",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    ).id;
    const agent = () => env.core.getAgentSession(HUMAN, worker);
    const firstNaru = await env.naru();
    const supervisor = firstNaru.supervisor;
    await supervisor.launch(worker);
    // Naru's channel starts the thread with its MCP server and role guidance; the TUI joins it.
    await until(() => agent().runtimeSessionRef !== null, "thread started");
    const threadId = agent().runtimeSessionRef!;
    await until(
      () => env.codexEvents().some((event) => event.event === "tui-resumed"),
      "TUI attached",
    );
    expect(env.codexEvents()).toEqual(
      expect.arrayContaining([
        {
          event: "thread/start",
          model: "gpt-6-astra",
          guidance: true,
          mcpCommand: true,
          mcpCapability: true,
        },
        { event: "tui-resumed", threadId, ok: true },
      ]),
    );
    const paneId = agent().paneId!;
    expect(env.repository.getPaneContext(paneId)?.pane).toMatchObject({
      kind: "codex",
      launchProfile: "codex-agent",
    });

    // The orchestrator writes through Naru's channel.
    supervisor.sendTurn(worker, "first turn", "orchestrator", supervisor.writer(worker).generation);
    await until(() => agent().status === "idle", "orchestrator turn");

    // A person typing in the TUI is refused while the orchestrator owns the conversation.
    const typed: string[] = [];
    const detach = await env.facade.attach(
      paneId,
      120,
      40,
      (frame) => {
        if (frame.type === "terminal.output") typed.push(frame.data);
      },
      undefined,
      undefined,
      { attachmentKey: "test-person", control: "controller" },
    );
    cleanups.push(detach);
    await env.facade.setControlDesired(paneId, true, 120, 40, "test-person");
    const tuiTurns = () => env.codexEvents().filter((event) => event.event === "tui-turn");
    await env.facade.write(paneId, "typed while not the writer\r", "test-person");
    await until(() => tuiTurns().length === 1, "refused TUI turn");
    expect(tuiTurns()[0]).toMatchObject({ accepted: false, code: -32001 });

    // Live handover: the person becomes the writer and their TUI prompt is recorded verbatim.
    const toTui = await supervisor.switchWriter(worker, "tui", false);
    expect(toTui).toMatchObject({ writer: "tui", phase: "active" });
    await env.facade.write(paneId, "typed as the writer\r", "test-person");
    await until(() => tuiTurns().length === 2, "accepted TUI turn");
    expect(tuiTurns()[1]).toMatchObject({ accepted: true });
    await until(
      () =>
        env.core
          .getApplicableInstructions(HUMAN, { projectId: env.project.id, agentSessionId: worker })
          .some((instruction) => instruction.verbatim === "typed as the writer"),
      "TUI prompt recorded",
    );
    expect(() => supervisor.sendTurn(worker, "late", "orchestrator", 1)).toThrow(/writer/);

    // Chat takes over; an approval answered in the TUI does not count, Naru's answer does.
    const gui = await supervisor.switchWriter(worker, "gui", false);
    await until(() => agent().status === "idle", "TUI turn ended");
    supervisor.sendTurn(worker, "please APPROVE this", "gui", gui.generation);
    await until(() => supervisor.pendingApprovals(worker).length === 1, "approval");
    await until(
      () => env.codexEvents().some((event) => event.event === "tui-approval-answered"),
      "TUI tried to answer",
    );
    expect(env.codexEvents().some((event) => event.event === "approval")).toBe(false);
    const [approval] = supervisor.pendingApprovals(worker);
    expect(approval?.summary).toBe("명령: pnpm test");
    // Codex can extend a command approval to the session; Naru offers it (AP-D023).
    expect(approval?.sessionAllow).toBe(true);
    supervisor.respondApproval(worker, approval!.requestId, "approve", "gui", gui.generation);
    await until(() => supervisor.pendingApprovals(worker).length === 0, "approval resolved");
    expect(env.codexEvents().filter((event) => event.event === "approval")).toEqual([
      { event: "approval", decision: "accept" },
    ]);
    await until(() => agent().status === "idle", "approved turn ended");

    supervisor.sendTurn(worker, "APPROVE again", "gui", gui.generation);
    await until(() => supervisor.pendingApprovals(worker).length === 1, "second approval");
    const [again] = supervisor.pendingApprovals(worker);
    supervisor.respondApprovalAsPerson(worker, again!.requestId, "approve-session");
    await until(
      () => supervisor.pendingApprovals(worker).length === 0,
      "session approval resolved",
    );
    expect(
      env
        .codexEvents()
        .filter((event) => event.event === "approval")
        .at(-1),
    ).toEqual({
      event: "approval",
      decision: "acceptForSession",
    });
    await until(() => agent().status === "idle", "session-approved turn ended");

    // Naru answers Codex's prompt for its own MCP server; the person is not asked (AP-D017).
    supervisor.sendTurn(worker, "call a NARUTOOL", "gui", gui.generation);
    await until(
      () => env.codexEvents().some((event) => event.event === "elicitation"),
      "MCP prompt answered",
    );
    expect(env.codexEvents().filter((event) => event.event === "elicitation")).toEqual([
      { event: "elicitation", action: "accept" },
    ]);
    expect(supervisor.pendingApprovals(worker)).toEqual([]);
    await until(() => agent().status === "idle", "tool turn ended");

    // Interrupt after the lifecycle reports the turn; a native subagent is observed only.
    supervisor.sendTurn(worker, "SLOW work", "gui", gui.generation);
    await until(() => supervisor.runtimeState(worker).turnActive, "slow turn");
    supervisor.interrupt(worker, "gui", gui.generation);
    await until(() => agent().status === "idle", "interrupted");
    supervisor.sendTurn(worker, "spawn a CHILD", "gui", gui.generation);
    await until(() => supervisor.runtimeState(worker).children.length === 1, "child observed");
    await until(() => agent().status === "idle", "child turn ended");
    expect(supervisor.runtimeState(worker).children).toEqual([]);

    // History pages through the runtime's own API (the fake pages by two).
    const first = await supervisor.readHistory(worker, null);
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await supervisor.readHistory(worker, first.nextCursor);
    expect(second.items.length).toBeGreaterThan(0);

    // Two big turns are over a page: each comes alone, its diff whole and its screenshot without
    // its bytes, and the next page starts right after it (AP-D040).
    for (const word of ["BIGDIFF one", "BIGDIFF two", "BIGDIFF three"]) {
      const before = env.codexEvents().filter((event) => event.event === "turn").length;
      supervisor.sendTurn(worker, word, "gui", gui.generation);
      await until(
        () => env.codexEvents().filter((event) => event.event === "turn").length === before + 1,
        `${word} starts`,
      );
      await until(() => agent().status === "idle", `${word} ends`);
    }
    const pages: unknown[][] = [];
    for (let cursor: string | null = null; pages.length === 0 || cursor !== null;) {
      const page = await supervisor.readHistory(worker, cursor);
      expect(JSON.stringify(page.items).length).toBeLessThanOrEqual(512 * 1024);
      pages.push([...page.items]);
      cursor = page.nextCursor;
    }
    const big = (turn: unknown) => JSON.stringify(turn).includes('"fileChange"');
    expect(pages.every((page) => page.filter(big).length <= 1)).toBe(true);
    const turns = pages.flat();
    expect(new Set(turns.map((turn) => (turn as { id: string }).id)).size).toBe(turns.length);
    expect(turns.slice(-3)).toMatchObject(
      [0, 1, 2].map(() => ({
        items: [
          { type: "fileChange", changes: [{ diff: "+x\n".repeat(100_000) }] },
          { type: "mcpToolCall", result: { content: [{ type: "image" }] } },
        ],
      })),
    );

    // Naru restarts: the relay reconnects and the gate follows the writer Naru remembers.
    await supervisor.switchWriter(worker, "orchestrator", false);
    supervisor.close();
    await firstNaru.server.close();
    const restarted = await env.naru();
    await until(() => restarted.supervisor.runtimeState(worker).connected, "relay reconnected");
    const turnsBefore = env.codexEvents().filter((event) => event.event === "turn").length;
    restarted.supervisor.sendTurn(
      worker,
      "after restart",
      "orchestrator",
      restarted.supervisor.writer(worker).generation,
    );
    await until(
      () => env.codexEvents().filter((event) => event.event === "turn").length === turnsBefore + 1,
      "turn after restart",
    );
    await until(() => agent().status === "idle", "turn after restart ended");
    await env.facade.write(paneId, "TUI after restart\r", "test-person");
    await until(() => tuiTurns().length === 3, "TUI refused after restart");
    expect(tuiTurns()[2]).toMatchObject({ accepted: false });

    restarted.supervisor.stop(worker);
    await until(() => agent().status === "stopped", "stopped");
  }, 180_000);
});
