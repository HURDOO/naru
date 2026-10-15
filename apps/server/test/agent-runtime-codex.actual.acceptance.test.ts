import { randomUUID } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { DurableSessionHostConfigSchema } from "../../durable-session-host/src/config.js";
import { startDurableSessionHost } from "../../durable-session-host/src/host.js";
import { silentHostLogger } from "../../durable-session-host/src/logging.js";
import { createHostFixture } from "../../durable-session-host/test/support.js";
import { AgentSocketServer } from "../src/agent-platform/agent-socket.js";
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

/**
 * AP-T13 real CLI acceptance: the installed Codex CLI and model (gpt-6-astra, codex-main's xhigh
 * reasoning) with the user's own login, in a project Codex already trusts, in an isolated Host.
 * Enable with NARU_ACTUAL_CODEX=<codex path>, NARU_ACTUAL_CODEX_ROOT=<root dir> and
 * NARU_ACTUAL_CODEX_PROJECT=<trusted project dir name under the root>. No conversation text is
 * printed; checks look for fixed marker words in the runtime's own history.
 */
const codex = process.env.NARU_ACTUAL_CODEX;
const HUMAN: Actor = { kind: "human" };
const repositoryRoot = resolve(import.meta.dirname, "../../..");
const tsxLoader = pathToFileURL(join(repositoryRoot, "node_modules/tsx/dist/loader.mjs")).href;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function until(check: () => Promise<boolean> | boolean, label: string, ms = 240_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`timed out: ${label}`);
}

describe.skipIf(codex === undefined)("actual Codex managed agent (AP-T13)", () => {
  it("runs a real Codex thread shared by Naru and the TUI under Naru's writer", async () => {
    const root = realpathSync(process.env.NARU_ACTUAL_CODEX_ROOT!);
    const projectName = process.env.NARU_ACTUAL_CODEX_PROJECT!;
    const fixture = createHostFixture();
    cleanups.push(() => rmSync(fixture.root, { recursive: true, force: true }));
    const node = realpathSync(process.execPath);
    const user = process.env.USER!;
    const environment = {
      PATH: `${dirname(codex!)}:${dirname(node)}:/usr/bin:/bin`,
      HOME: process.env.HOME!,
      USER: user,
      LOGNAME: user,
      LANG: "en_US.UTF-8",
      TERM: "xterm-256color",
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
      roots: [{ rootId: "projects", path: root }],
    };
    const repository = new NaruRepository(join(fixture.root, "naru.sqlite"), {
      sessionOwner: "durable-host",
    });
    cleanups.push(() => repository.close());
    const project = repository.createProject(join(root, projectName), "actual codex");
    const core = new AgentPlatformCore(repository.agentPlatform);
    const agentSocket = new AgentSocketServer(fixture.root, core);
    await agentSocket.start();
    cleanups.push(() => agentSocket.close());

    let supervisor: ManagedAgentSupervisor | null = null;
    let facade: DurableHostSessionFacade | null = null;
    const codexPanes = new CodexAgentPanes({
      config: {
        node: { file: node, args: ["--import", tsxLoader] },
        entries: { mcp: join(repositoryRoot, "apps/server/src/agent-mcp-cli.ts") },
        agentSocketPath: agentSocket.socketPath,
      },
      core,
      repository,
      sessions: () => facade!,
      runnerEnvironment: (agentSessionId) => supervisor!.runnerEnvironment(agentSessionId),
    });
    const launchProfiles = new LaunchProfileRegistry({
      codexExecutable: codex!,
      environment,
      codexAgentPanes: codexPanes,
    });
    const codexIntegration = new NaruCodexIntegration(repository, config, launchProfiles);
    const integrationServer = new CodexIntegrationServer(fixture.root, codexIntegration);
    await integrationServer.start();
    const host = await startDurableSessionHost(
      DurableSessionHostConfigSchema.parse({
        ...fixture.config,
        roots: [{ rootId: "projects", path: root }],
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
            values: {
              ...environment,
              NARU_CODEX_INTEGRATION_SOCKET: integrationServer.socketPath,
            },
          },
        ],
        resourcePolicies: [
          {
            ...fixture.config.resourcePolicies[0],
            allowedExecutables: [node],
            stopTimeoutMs: 10_000,
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
    const naru = async () => {
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
    };

    const worker = core.registerAgentSession(
      { actor: HUMAN, idempotencyKey: randomUUID() },
      {
        projectId: project.id,
        role: "worker",
        runtime: "codex",
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    ).id;
    const agent = () => core.getAgentSession(HUMAN, worker);
    const first = await naru();
    await first.supervisor.launch(worker);
    await until(() => agent().runtimeSessionRef !== null, "thread");
    const paneId = agent().paneId!;
    const history = async (current: ManagedAgentSupervisor) => {
      const items: unknown[] = [];
      let cursor: string | null = null;
      do {
        const page = await current.readHistory(worker, cursor);
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor !== null);
      return items;
    };
    const mentions = async (current: ManagedAgentSupervisor, word: string) =>
      JSON.stringify(await history(current)).split(word).length - 1;
    const turn = async (current: ManagedAgentSupervisor, text: string) => {
      const { writer, generation } = current.writer(worker);
      current.sendTurn(worker, text, writer, generation);
      await until(() => current.runtimeState(worker).turnActive, "turn started", 60_000);
      await until(() => {
        // Approve whatever the agent asks for (Naru MCP tool calls) as the current writer.
        for (const approval of current.pendingApprovals(worker)) {
          const state = current.writer(worker);
          current.respondApproval(
            worker,
            approval.requestId,
            "approve",
            state.writer,
            state.generation,
          );
        }
        return !current.runtimeState(worker).turnActive;
      }, "turn ended");
    };

    await turn(
      first.supervisor,
      "Reply with exactly the word NARUCODEXONE and nothing else. Do not run commands.",
    );
    expect(await mentions(first.supervisor, "NARUCODEXONE")).toBeGreaterThanOrEqual(2);

    // The real TUI may not write while the orchestrator owns the conversation.
    const control = await facade.attach(paneId, 120, 40, () => undefined, undefined, undefined, {
      attachmentKey: "actual-person",
      control: "controller",
    });
    cleanups.push(control);
    await facade.setControlDesired(paneId, true, 120, 40, "actual-person");
    const turnsBefore = (await history(first.supervisor)).length;
    await facade.write(paneId, "Reply with exactly NARUCODEXREFUSED", "actual-person");
    await new Promise((done) => setTimeout(done, 500));
    await facade.write(paneId, "\r", "actual-person");
    await new Promise((done) => setTimeout(done, 5_000));
    expect((await history(first.supervisor)).length).toBe(turnsBefore);

    // Naru's MCP server is bound to this thread's agent.
    await turn(
      first.supervisor,
      "Call the naru MCP tool get_project_state once, then reply with exactly TASKS= followed by the number of tasks it returned.",
    );
    expect(await mentions(first.supervisor, "TASKS=0")).toBeGreaterThanOrEqual(1);

    // Live handover: the person writes in the real TUI and Naru records it.
    await first.supervisor.switchWriter(worker, "tui", false);
    await facade.write(
      paneId,
      "\u0015Reply with exactly the word NARUCODEXTWO and nothing else.",
      "actual-person",
    );
    await new Promise((done) => setTimeout(done, 500));
    await facade.write(paneId, "\r", "actual-person");
    await until(async () => (await mentions(first.supervisor, "NARUCODEXTWO")) >= 2, "TUI turn");
    expect(
      core
        .getApplicableInstructions(HUMAN, { projectId: project.id, agentSessionId: worker })
        .some((instruction) => instruction.verbatim?.includes("NARUCODEXTWO") === true),
    ).toBe(true);

    // Back to the orchestrator; Naru restarts and the conversation continues.
    await until(() => !first.supervisor.runtimeState(worker).turnActive, "TUI turn settled");
    await first.supervisor.switchWriter(worker, "orchestrator", false);
    first.supervisor.close();
    await first.server.close();
    const second = await naru();
    await until(() => second.supervisor.runtimeState(worker).connected, "relay reconnected");
    await turn(
      second.supervisor,
      "Repeat the first word you replied with in this conversation, exactly.",
    );
    expect(await mentions(second.supervisor, "NARUCODEXONE")).toBeGreaterThanOrEqual(3);

    second.supervisor.stop(worker);
    await until(() => agent().status === "stopped", "stopped", 60_000);
  }, 1_200_000);
});
