import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { isPaneCollapsed } from "@naru/domain";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture } from "../../durable-session-host/test/support.js";
import { CLAUDE_ACTIVITY_HOOK_COMMAND } from "../src/claude-activity-hook-client.js";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import { ClaudeAgentPanes } from "../src/agent-runtime/claude/agent-panes.js";
import {
  RuntimeChannelServer,
  runtimeChannelSocketPath,
} from "../src/agent-runtime/runtime-channel-server.js";
import { SharedProcessRuntime } from "../src/agent-runtime/shared-processes.js";
import { ManagedAgentSupervisor } from "../src/agent-runtime/supervisor.js";
import { NaruRepository } from "../src/database.js";
import { DurableHostSessionFacade } from "../src/durable-session-facade.js";
import {
  UdsDurableSessionLifecycleClient,
  type DurableHostConfig,
} from "../src/durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "../src/durable-session-stream-port.js";
import { NaruClaudeIntegration } from "../src/integrations/claude/port.js";
import { NaruCodexIntegration } from "../src/integrations/codex/port.js";
import { CodexIntegrationServer } from "../src/integrations/codex/server.js";
import { LaunchProfileRegistry } from "../src/launch-profiles.js";

const HUMAN: Actor = { kind: "human" };
const SESSION = "11111111-2222-4333-8444-555555555555";
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxLoader = pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

// Scripted stand-in for the user-installed SDK (AP-D012). It records the options it was given.
const FAKE_SDK = `
import { appendFileSync } from "node:fs";
export function query({ prompt, options }) {
  appendFileSync(process.env.FAKE_SDK_LOG, JSON.stringify({
    resume: options.resume ?? null,
    model: options.model,
    name: options.extraArgs.name,
    mcp: Object.keys(options.mcpServers),
    runtimeToken: options.env.NARU_RUNTIME_TOKEN ?? null,
    bootstrap: options.env.NARU_CLAUDE_HOOK_BOOTSTRAP ?? null,
    guidance: options.systemPrompt.append.includes("## Working through Naru"),
    permissionMode: options.permissionMode ?? null,
  }) + "\\n");
  async function* run() {
    yield { type: "system", subtype: "init", session_id: options.resume ?? "${SESSION}" };
    for await (const message of prompt) {
      const slow = /SLOW(\\d+)/.exec(message.message.content);
      if (slow) await new Promise((done) => setTimeout(done, Number(slow[1])));
      yield { type: "result", subtype: "success", is_error: false };
    }
  }
  const iterator = run();
  iterator.interrupt = async () => {};
  return iterator;
}
export async function getSessionMessages(sessionId) {
  return [{ type: "user", session_id: sessionId }];
}
`;

const FAKE_CLAUDE_TUI = (node: string) => `#!${node}
const { appendFileSync, readFileSync } = require("node:fs");
const { spawnSync } = require("node:child_process");
const args = process.argv.slice(2);
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const resume = args[args.indexOf("--resume") + 1];
const settings = JSON.parse(args[args.indexOf("--settings") + 1]);
const report = readFileSync(process.env.FAKE_CLAUDE_CONTROL, "utf8").trim();
const sessionId = report === "wrong" ? "99999999-9999-4999-8999-999999999999" : resume;
for (const matcher of settings.hooks.SessionStart ?? []) {
  for (const hook of matcher.hooks) {
    spawnSync("/bin/sh", ["-c", hook.command], {
      input: JSON.stringify({ hook_event_name: "SessionStart", session_id: sessionId, cwd: process.cwd(), source: "resume" }),
      stdio: ["pipe", "ignore", "ignore"],
    });
  }
}
process.stdout.write("fake claude tui\\n");
setInterval(() => {}, 1000);
process.on("SIGTERM", () => process.exit(0));
`;

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
  const sdkEntry = join(fixture.root, "fake-sdk.mjs");
  writeFileSync(sdkEntry, FAKE_SDK, { mode: 0o600 });
  const sdkLog = join(fixture.root, "fake-sdk.log");
  writeFileSync(sdkLog, "", { mode: 0o600 });
  // Stand-in Claude TUI: reports SessionStart through the Pane's activity hook like the real one
  // (the injected command runner answers `auth status`; the SDK runner never execs this).
  const claude = join(fixture.root, "claude");
  const claudeLog = join(fixture.root, "fake-claude.log");
  const claudeControl = join(fixture.root, "fake-claude.control");
  writeFileSync(claudeLog, "", { mode: 0o600 });
  writeFileSync(claudeControl, "", { mode: 0o600 });
  writeFileSync(claude, FAKE_CLAUDE_TUI(node), { mode: 0o700 });
  chmodSync(claude, 0o700);

  const config: DurableHostConfig = {
    owner: "durable-host",
    socketPath: fixture.config.socketPath,
    credentialFile: fixture.credentialFile,
    appId: "fixture-app",
    subject: "fixture-owner",
    callerTtlMs: 50_000,
    idempotencyTtlMs: fixture.config.idempotencyTtlMs,
    profileIds: ["claude-code", "shell"],
    roots: fixture.config.roots,
  };
  const repository = new NaruRepository(join(fixture.root, "naru.sqlite"), {
    sessionOwner: "durable-host",
  });
  cleanups.push(() => repository.close());
  const project = repository.createProject(join(fixture.config.roots[0]!.path, "sample"), "agents");
  const core = new AgentPlatformCore(repository.agentPlatform);

  let supervisor: ManagedAgentSupervisor | null = null;
  let facade: DurableHostSessionFacade | null = null;
  const agentPanes = new ClaudeAgentPanes({
    config: {
      claudeExecutable: claude,
      sdkEntry,
      node: { file: node, args: ["--import", tsxLoader] },
      entries: {
        runner: join(repositoryRoot, "apps/server/src/claude-agent-runner.ts"),
        hook: join(repositoryRoot, "apps/server/src/agent-hook-cli.ts"),
        mcp: join(repositoryRoot, "apps/server/src/agent-mcp-cli.ts"),
      },
      agentSocketPath: join(fixture.root, "agent.sock"),
      activityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
    },
    core,
    repository,
    sessions: () => facade!,
    runnerEnvironment: (agentSessionId) => supervisor!.runnerEnvironment(agentSessionId),
  });
  const launchProfiles = new LaunchProfileRegistry({
    claudeExecutable: claude,
    environment: { PATH: "/usr/bin:/bin", HOME: fixture.root },
    commandRunner: () => ({ stdout: '{"loggedIn":true}', stderr: "", status: 0 }),
    agentPanes,
  });
  const codexIntegration = new NaruCodexIntegration(repository, config, launchProfiles);
  const claudeIntegration = new NaruClaudeIntegration(repository, config, launchProfiles);
  const integrationServer = new CodexIntegrationServer(fixture.root, codexIntegration, {
    claudeIntegration,
  });
  await integrationServer.start();

  const host = await startDurableSessionHost(
    DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      profiles: [
        {
          // Agents' shared processes run in a plain shell (no user rc files).
          profileId: "shell",
          executable: "/bin/zsh",
          args: ["-f"],
          envPolicyId: "safe-env",
          resourcePolicyId: "fixture-resource",
        },
        {
          profileId: "claude-code",
          executable: node,
          args: [
            "--import",
            tsxLoader,
            join(repositoryRoot, "apps/server/src/claude-integration-launcher.ts"),
          ],
          envPolicyId: "safe-env",
          resourcePolicyId: "fixture-resource",
        },
      ],
      environmentPolicies: [
        {
          envPolicyId: "safe-env",
          inherit: [],
          values: {
            PATH: `${dirname(node)}:/usr/bin:/bin`,
            HOME: fixture.root,
            FAKE_SDK_LOG: sdkLog,
            FAKE_CLAUDE_LOG: claudeLog,
            FAKE_CLAUDE_CONTROL: claudeControl,
            NARU_CODEX_INTEGRATION_SOCKET: integrationServer.socketPath,
            NARU_CLAUDE_HOOK_RUNNER: join(repositoryRoot, "node_modules/.bin/tsx"),
            NARU_CLAUDE_HOOK_ENTRY: join(
              repositoryRoot,
              "apps/server/src/claude-integration-hook-cli.ts",
            ),
          },
        },
      ],
      resourcePolicies: [
        {
          ...fixture.config.resourcePolicies[0],
          allowedExecutables: [node, "/bin/zsh"],
          stopTimeoutMs: 5_000,
        },
      ],
      integrationPolicies: [
        {
          policyRef: "naru-claude-v0",
          appId: config.appId,
          integrationKind: "claude",
          profileIds: ["claude-code"],
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
    claudeIntegration,
  );
  await facade.reconcile();
  cleanups.push(async () => {
    await host.close();
    await facade.shutdown();
  });

  /** One Naru "process" worth of agent runtime: supervisor and its channel server. */
  async function naru() {
    const instance = new ManagedAgentSupervisor({
      core,
      launcher: agentPanes,
      channelSocketPath: runtimeChannelSocketPath(fixture.root),
      planFor: (agent) => agentPanes.plan(agent),
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

  const sdkCalls = () =>
    readFileSync(sdkLog, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  const tuiCalls = () =>
    readFileSync(claudeLog, "utf8")
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as string[]);
  let ordinal = 0;
  const registerWorker = () =>
    core.registerAgentSession(
      {
        actor: HUMAN,
        idempotencyKey: `e0000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
      },
      {
        projectId: project.id,
        role: "worker",
        runtime: "claude",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    ).id;
  return {
    fixture,
    repository,
    project,
    core,
    facade,
    naru,
    sdkCalls,
    tuiCalls,
    registerWorker,
    setTuiReport: (value: "same" | "wrong") => writeFileSync(claudeControl, value),
  };
}

describe("managed Claude agent in a DurableSession Host PTY", () => {
  it("runs the runner in a collapsed agent Pane, survives a Naru restart and resumes", async () => {
    const env = await startFixture();
    const worker = env.registerWorker();
    const status = () => env.core.getAgentSession(HUMAN, worker).status;

    const first = await env.naru();
    await first.supervisor.launch(worker);
    await until(
      () => env.core.getAgentSession(HUMAN, worker).runtimeSessionRef === SESSION,
      "runner reached Naru and started the conversation",
    );

    // The agent's Pane joined the workspace collapsed and is bound to the agent.
    const agent = env.core.getAgentSession(HUMAN, worker);
    const workspace = env.repository.getWorkspace(env.project.id);
    const pane = workspace.panes.find((candidate) => candidate.id === agent.paneId);
    expect(pane?.launchProfile).toBe("claude-agent");
    expect(workspace.panes).toHaveLength(4); // the project's three default Panes and the agent's
    expect(isPaneCollapsed(workspace.layout, pane!.id)).toBe(true);
    expect(env.facade.isRunning(pane!.id)).toBe(true);

    // The runner got a plan with an explicit model and the Naru MCP server, but none of the
    // launch-only secrets in Claude's environment.
    const [call] = env.sdkCalls();
    expect(call).toMatchObject({
      resume: null,
      model: "claude-opus-5-5",
      mcp: ["naru"],
      runtimeToken: null,
      bootstrap: null,
      guidance: true,
    });

    // The console in the Pane shows lifecycle only, never conversation text.
    const output: string[] = [];
    const detach = await env.facade.attach(pane!.id, 120, 40, (frame) => {
      if (frame.type === "terminal.output") output.push(frame.data);
    });
    cleanups.push(detach);
    first.supervisor.sendTurn(worker, "SECRET-TURN-TEXT SLOW800", "orchestrator", 1);
    await until(() => status() === "active", "turn running");

    // Naru restarts mid-turn; the Host keeps the runner alive and it reconnects.
    first.supervisor.close();
    await first.server.close();
    const second = await env.naru();
    await until(() => status() === "idle", "turn result delivered after the restart");
    await until(() => output.join("").includes("turn completed"), "console lifecycle line");
    expect(output.join("")).toContain("turn started");
    expect(output.join("")).not.toContain("SECRET-TURN-TEXT");

    // Stopping ends the runner and its Pane process; relaunching resumes the same conversation.
    second.supervisor.stop(worker);
    await until(() => status() === "stopped", "stopped");
    await until(() => !env.facade.isRunning(pane!.id), "pane process exited");
    await second.supervisor.launch(worker);
    await until(() => status() === "idle", "resumed");
    expect(env.sdkCalls().at(-1)).toMatchObject({ resume: SESSION });
    expect(env.sdkCalls().at(-1)?.permissionMode).toMatch(/^(auto|default|acceptEdits|plan)$/u);
    expect(env.core.getAgentSession(HUMAN, worker).paneId).toBe(pane!.id);
    expect(env.repository.getWorkspace(env.project.id).panes).toHaveLength(4);
    second.supervisor.stop(worker);
    await until(() => status() === "stopped", "stopped again");
  }, 120_000);

  it("switches the conversation between the runner and the Claude TUI, rolling back a wrong resume", async () => {
    const env = await startFixture();
    const worker = env.registerWorker();
    const agent = () => env.core.getAgentSession(HUMAN, worker);
    const { supervisor } = await env.naru();
    await supervisor.launch(worker);
    await until(() => agent().runtimeSessionRef === SESSION && agent().status === "idle", "ready");

    // Runner → TUI: the runner stops and the same conversation resumes in the real TUI form.
    const toTui = await supervisor.switchWriter(worker, "tui", false);
    expect(toTui).toMatchObject({ writer: "tui", generation: 2, phase: "active" });
    expect(agent()).toMatchObject({ launchMode: "tui", conversationWriter: "tui", status: "idle" });
    const [tuiArgs] = env.tuiCalls();
    expect(tuiArgs).toEqual(
      expect.arrayContaining([
        "--resume",
        SESSION,
        "--model",
        "claude-opus-5-5",
        "--strict-mcp-config",
      ]),
    );
    expect(tuiArgs?.join(" ")).toContain("--setting-sources user,project,local");
    // Both forms state the person's own permission mode; a resumed TUI would keep an old one.
    expect(tuiArgs?.[tuiArgs.indexOf("--permission-mode") + 1]).toMatch(
      /^(auto|manual|acceptEdits|plan)$/u,
    );
    // The TUI form gets the same naru-orchestration guidance as the runner.
    expect(tuiArgs?.[tuiArgs.indexOf("--append-system-prompt") + 1]).toContain("## Role: worker");
    expect(() => supervisor.sendTurn(worker, "late", "orchestrator", 1)).toThrow();

    // TUI → orchestrator: the TUI exits and a fresh runner resumes the conversation.
    const back = await supervisor.switchWriter(worker, "orchestrator", false);
    expect(back).toMatchObject({ writer: "orchestrator", generation: 3, phase: "active" });
    expect(agent()).toMatchObject({ launchMode: "runner", conversationWriter: "orchestrator" });
    expect(env.sdkCalls().at(-1)).toMatchObject({ resume: SESSION });
    expect(env.sdkCalls().at(-1)?.permissionMode).toMatch(/^(auto|default|acceptEdits|plan)$/u);
    supervisor.sendTurn(worker, "after the TUI", "orchestrator", back.generation);
    await until(() => agent().status === "idle", "turn after switching back");

    // A TUI that reports another conversation is not a resume: Naru restores the runner.
    env.setTuiReport("wrong");
    const rolledBack = await supervisor.switchWriter(worker, "tui", false);
    expect(rolledBack).toMatchObject({ writer: "orchestrator", generation: 4, phase: "active" });
    expect(agent()).toMatchObject({ launchMode: "runner", runtimeSessionRef: SESSION });
    expect(env.tuiCalls()).toHaveLength(2);
    supervisor.sendTurn(worker, "after the rollback", "orchestrator", rolledBack.generation);
    await until(() => agent().status === "idle", "turn after the rollback");
    supervisor.stop(worker);
    await until(() => agent().status === "stopped", "stopped");
  }, 180_000);

  it("runs an agent's shared process in a terminal Pane and hands it to a person and back", async () => {
    const env = await startFixture();
    const worker = env.registerWorker();
    const asWorker: Actor = { kind: "agent", agentSessionId: worker };
    const context = (actor: Actor) => ({ actor, idempotencyKey: randomUUID() });
    const runtime = new SharedProcessRuntime({
      core: env.core,
      repository: env.repository,
      sessions: () => env.facade,
    });
    cleanups.push(() => runtime.close());
    const changed: string[] = [];
    runtime.onChange((paneId) => changed.push(paneId));

    const process = await runtime.start(context(asWorker), {
      projectId: env.project.id,
      purpose: "echo server",
      command: "printf 'READY\\n'; read line; printf 'GOT-%s\\n' \"$line\"",
      ports: [],
      keep: "keep",
    });
    expect(process).toMatchObject({ status: "running", agentSessionId: worker });
    const paneId = process.paneId!;
    const workspace = env.repository.getWorkspace(env.project.id);
    expect(workspace.panes.find((pane) => pane.id === paneId)).toMatchObject({
      kind: "terminal",
      launchProfile: "shell",
    });
    expect(isPaneCollapsed(workspace.layout, paneId)).toBe(true);
    // A person looking at the Pane observes; the agent keeps control.
    expect(runtime.humanMayControl(paneId)).toBe(false);

    const screen = async () => (await runtime.read(asWorker, process.id, 40)).screen;
    await untilAsync(async () => (await screen()).includes("READY"), "command ran");
    await runtime.input(context(asWorker), process.id, "hello\r");
    await untilAsync(async () => (await screen()).includes("GOT-hello"), "agent input");

    await runtime.setHold(context(HUMAN), process.id, true, "takeover");
    expect(runtime.humanMayControl(paneId)).toBe(true);
    await expect(runtime.input(context(asWorker), process.id, "late\r")).rejects.toMatchObject({
      code: "AGENT_HELD_BY_HUMAN",
    });
    await runtime.setHold(context(HUMAN), process.id, false, "release");
    expect(runtime.humanMayControl(paneId)).toBe(false);
    expect(changed).toEqual([paneId, paneId]);
    await runtime.input(context(asWorker), process.id, "echo AGAIN-$((40+2))\r");
    await untilAsync(async () => (await screen()).includes("AGAIN-42"), "input after the hold");
    expect(
      env.repository.agentPlatform.listSharedProcessInputs(process.id).map((row) => row.verbatim),
    ).toEqual(["hello\r", "echo AGAIN-$((40+2))\r"]);

    // Naru restarts: a new runtime reattaches to the surviving Host session and keeps going.
    runtime.close();
    const restarted = new SharedProcessRuntime({
      core: env.core,
      repository: env.repository,
      sessions: () => env.facade,
    });
    cleanups.push(() => restarted.close());
    await restarted.restore();
    const reread = async () => (await restarted.read(asWorker, process.id, 40)).screen;
    await untilAsync(async () => (await reread()).includes("AGAIN-42"), "screen after restart");
    await restarted.input(context(asWorker), process.id, "echo AFTER-RESTART\r");
    await untilAsync(async () => (await reread()).includes("AFTER-RESTART"), "input after restart");

    const stopped = await restarted.stop(asWorker, process.id);
    expect(stopped.status).toBe("stopped");
    await until(() => !env.facade.isRunning(paneId), "terminal stopped");
  }, 120_000);

  it("ends a server with Ctrl+C and then closes its terminal (AP-D041)", async () => {
    const env = await startFixture();
    const worker = env.registerWorker();
    const asWorker: Actor = { kind: "agent", agentSessionId: worker };
    const context = (actor: Actor) => ({ actor, idempotencyKey: randomUUID() });
    const runtime = new SharedProcessRuntime({
      core: env.core,
      repository: env.repository,
      sessions: () => env.facade,
    });
    cleanups.push(() => runtime.close());
    const process = await runtime.start(context(asWorker), {
      projectId: env.project.id,
      purpose: "preview",
      command: "printf 'SERV''ING\\n'; while :; do sleep 1; done",
      ports: [],
      keep: "keep",
    });
    const paneId = process.paneId!;
    const screen = async () => (await runtime.read(asWorker, process.id, 40)).screen;
    await untilAsync(async () => (await screen()).includes("SERVING"), "server up");

    // What the guidance asks: Ctrl+C first, and the shell prompt is back.
    await runtime.input(context(asWorker), process.id, "\u0003");
    await runtime.input(context(asWorker), process.id, "echo BACK-$((40+2))\r");
    await untilAsync(async () => (await screen()).includes("BACK-42"), "shell back");

    const closeContext = context(asWorker);
    const closed = await runtime.closeProcess(closeContext, process.id);
    expect(closed).toMatchObject({ status: "stopped", paneId: null });
    expect(closed.retiredAt).toEqual(expect.any(String));
    expect(env.facade.isRunning(paneId)).toBe(false);
    const workspace = env.repository.getWorkspace(env.project.id);
    expect(workspace.panes.some((pane) => pane.id === paneId)).toBe(false);
    expect(env.core.listSharedProcesses({ kind: "human" }, env.project.id)).toEqual([]);
    // A retry changes nothing.
    expect(await runtime.closeProcess(closeContext, process.id)).toEqual(closed);
  }, 120_000);
});

async function untilAsync(
  check: () => Promise<boolean>,
  label: string,
  ms = 30_000,
): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out: ${label}`);
}
