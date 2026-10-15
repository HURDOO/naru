import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { CODEX_SESSION_HOOK_COMMAND, CodexSessionHookServer } from "./codex-session-hook.js";
import { CLAUDE_ACTIVITY_HOOK_COMMAND } from "./claude-activity-hook-client.js";
import { loadConfig } from "./config.js";
import { NaruRepository } from "./database.js";
import { ProjectPathPolicy } from "./path-policy.js";
import { PtySupervisor } from "./pty.js";
import { LaunchProfileRegistry } from "./launch-profiles.js";
import { safeErrorFields } from "./observability.js";
import { loadSecureEnvironmentFile } from "./environment-file.js";
import { createGracefulShutdownHandler } from "./shutdown.js";
import { DurableHostSessionFacade } from "./durable-session-facade.js";
import { UdsDurableSessionLifecycleClient } from "./durable-session-host-client.js";
import { UdsDurableSessionStreamPort } from "./durable-session-stream-port.js";
import { NaruCodexIntegration } from "./integrations/codex/port.js";
import { NaruClaudeIntegration } from "./integrations/claude/port.js";
import { CodexIntegrationServer } from "./integrations/codex/server.js";
import { AgentPlatformCore } from "./agent-platform/core.js";
import { AgentSocketServer } from "./agent-platform/agent-socket.js";
import { OrchestratorWakeups } from "./agent-platform/wakeups.js";
import { ClaudeAgentPanes } from "./agent-runtime/claude/agent-panes.js";
import { CodexAgentPanes } from "./agent-runtime/codex/agent-panes.js";
import { RuntimeLaunchers } from "./agent-runtime/agent-launchers.js";
import {
  RuntimeChannelServer,
  runtimeChannelSocketPath,
} from "./agent-runtime/runtime-channel-server.js";
import { ManagedAgentSupervisor } from "./agent-runtime/supervisor.js";
import { SharedProcessRuntime } from "./agent-runtime/shared-processes.js";
import { AGENT_GIT_TIMEOUT_MS, AgentWorkspace } from "./agent-runtime/workspace.js";
import { GitMetadataAdapter, SystemGitCommandRunner } from "./git-metadata.js";
import { ProjectCatalogService } from "./project-catalog.js";
import { ProjectDocumentReader } from "./project-documents.js";
import { ProjectFileService } from "./project-files.js";
import { HoldMonitor } from "./agent-runtime/hold-monitor.js";
import { LeaseManager } from "./lease.js";
import type { NaruSessionFacade } from "./session-facade.js";

const projectRoot = new URL("../../../", import.meta.url);
loadRootEnvironment(projectRoot);

const config = loadConfig(process.env, fileURLToPath(projectRoot));
const sessionRuntime = config.sessionRuntime ?? { owner: "legacy" as const };
const repository = NaruRepository.openDataDirectory(config.dataDir, {
  sessionOwner: sessionRuntime.owner,
  defaultAgentPaneKind: config.defaultAgentPaneKind ?? "codex",
});
const pathPolicy = await ProjectPathPolicy.create(config.projectRoots, {
  allowExactRoots: config.exactProjectRoots ?? [],
});
// Agent Platform is opt-in (NARU_AGENT_PLATFORM=1); without it nothing agent-related starts.
const agentPlatform = config.agentPlatform
  ? new AgentPlatformCore(repository.agentPlatform)
  : undefined;
const agentSocket =
  agentPlatform === undefined ? undefined : new AgentSocketServer(config.dataDir, agentPlatform);
let supervisor: NaruSessionFacade;
let managedAgents: ManagedAgentSupervisor | undefined;
// Managed Claude agents run in Host PTY Panes and need the user-installed SDK (AP-D012).
const agentPanes =
  agentPlatform !== undefined &&
  agentSocket !== undefined &&
  sessionRuntime.owner === "durable-host" &&
  config.claudeExecutable !== undefined &&
  config.claudeAgentSdkPath !== undefined
    ? new ClaudeAgentPanes({
        config: {
          claudeExecutable: config.claudeExecutable,
          sdkEntry: config.claudeAgentSdkPath,
          ...agentProcessEntries(config.environment === "production"),
          agentSocketPath: agentSocket.socketPath,
          activityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
        },
        core: agentPlatform,
        repository,
        sessions: () => supervisor,
        runnerEnvironment: (agentSessionId) => {
          if (managedAgents === undefined) throw new Error("Managed agents are not running.");
          return managedAgents.runnerEnvironment(agentSessionId);
        },
      })
    : undefined;
// Managed Codex agents reuse the Codex Pane relay (AP-T13); the CLI is checked at launch.
const codexAgentPanes =
  agentPlatform !== undefined &&
  agentSocket !== undefined &&
  sessionRuntime.owner === "durable-host"
    ? new CodexAgentPanes({
        config: {
          node: agentProcessEntries(config.environment === "production").node,
          entries: { mcp: agentProcessEntries(config.environment === "production").entries.mcp },
          agentSocketPath: agentSocket.socketPath,
        },
        core: agentPlatform,
        repository,
        sessions: () => supervisor,
        runnerEnvironment: (agentSessionId) => {
          if (managedAgents === undefined) throw new Error("Managed agents are not running.");
          return managedAgents.runnerEnvironment(agentSessionId);
        },
      })
    : undefined;
if (sessionRuntime.owner === "durable-host") {
  const launchProfiles = new LaunchProfileRegistry({
    ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
    ...(config.claudeExecutable === undefined ? {} : { claudeExecutable: config.claudeExecutable }),
    codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
    claudeActivityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
    ...(agentPanes === undefined ? {} : { agentPanes }),
    ...(codexAgentPanes === undefined ? {} : { codexAgentPanes }),
  });
  const codexIntegration = new NaruCodexIntegration(repository, sessionRuntime, launchProfiles);
  const claudeIntegration =
    config.claudeExecutable === undefined
      ? undefined
      : new NaruClaudeIntegration(repository, sessionRuntime, launchProfiles);
  const codexIntegrationServer = new CodexIntegrationServer(config.dataDir, codexIntegration, {
    ...(config.codexIntegrationSocketPath === undefined
      ? {}
      : { socketPath: config.codexIntegrationSocketPath }),
    ...(claudeIntegration === undefined ? {} : { claudeIntegration }),
  });
  await codexIntegrationServer.start();
  const durableSupervisor = new DurableHostSessionFacade(
    repository,
    sessionRuntime,
    new UdsDurableSessionLifecycleClient(sessionRuntime),
    new UdsDurableSessionStreamPort(sessionRuntime),
    Date.now,
    codexIntegration,
    codexIntegrationServer,
    claudeIntegration,
  );
  try {
    await durableSupervisor.reconcile();
  } catch (error) {
    await durableSupervisor.shutdown();
    repository.close();
    throw error;
  }
  supervisor = durableSupervisor;
} else {
  const hookServer = new CodexSessionHookServer({
    dataDirectory: config.dataDir,
    runner:
      config.environment === "production"
        ? process.execPath
        : fileURLToPath(new URL("../../../node_modules/.bin/tsx", import.meta.url)),
    entrypoint:
      config.environment === "production"
        ? fileURLToPath(new URL("./codex-session-hook-cli.js", import.meta.url))
        : fileURLToPath(new URL("../src/codex-session-hook-cli.ts", import.meta.url)),
    claudeEntrypoint:
      config.environment === "production"
        ? fileURLToPath(new URL("./claude-activity-hook-cli.js", import.meta.url))
        : fileURLToPath(new URL("../src/claude-activity-hook-cli.ts", import.meta.url)),
  });
  await hookServer.start();
  const launchProfiles = new LaunchProfileRegistry({
    ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
    ...(config.claudeExecutable === undefined ? {} : { claudeExecutable: config.claudeExecutable }),
    codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
    claudeActivityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
  });
  supervisor = new PtySupervisor(repository, undefined, launchProfiles, hookServer);
}
let runtimeChannel: RuntimeChannelServer | undefined;
let wakeups: OrchestratorWakeups | undefined;
if (agentPlatform !== undefined && (agentPanes !== undefined || codexAgentPanes !== undefined)) {
  const launchers = new RuntimeLaunchers(agentPlatform, {
    ...(agentPanes === undefined ? {} : { claude: agentPanes }),
    ...(codexAgentPanes === undefined ? {} : { codex: codexAgentPanes }),
  });
  managedAgents = new ManagedAgentSupervisor({
    core: agentPlatform,
    launcher: launchers,
    channelSocketPath: runtimeChannelSocketPath(config.dataDir),
    planFor: (agent) => launchers.plan(agent),
    attention: (agentSessionId, required) => {
      const paneId = agentPlatform.getAgentSession({ kind: "system" }, agentSessionId).paneId;
      if (paneId !== null) supervisor.showAgentAttention?.(paneId, required);
    },
  });
  runtimeChannel = new RuntimeChannelServer(config.dataDir, managedAgents);
  wakeups = new OrchestratorWakeups(agentPlatform, managedAgents);
  managedAgents.useWakeups(wakeups);
}
// Agents' shared processes (AP-D006) run in Host PTY Panes like managed agents.
const sharedProcesses =
  agentPlatform !== undefined && sessionRuntime.owner === "durable-host"
    ? new SharedProcessRuntime({ core: agentPlatform, repository, sessions: () => supervisor })
    : undefined;
await sharedProcesses?.restore();
// Worktrees, view Panes and merge (AP-D016) use the same catalog and path policy as the person.
const projectCatalog = new ProjectCatalogService(repository, new GitMetadataAdapter(pathPolicy));
const agentWorkspace =
  agentPlatform === undefined
    ? undefined
    : new AgentWorkspace({
        core: agentPlatform,
        repository,
        pathPolicy,
        git: new SystemGitCommandRunner(undefined, AGENT_GIT_TIMEOUT_MS),
        registerProject: (realPath, name) => projectCatalog.register(realPath, name),
        // Merge commits carry the person's git identity, as their own agent's merge would (AP-D019).
        personGitConfigFiles: [
          join(homedir(), ".gitconfig"),
          join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "git", "config"),
        ],
        checkViewPath: async (projectPath, kind, relativePath) => {
          if (kind === "docs") await new ProjectDocumentReader().read(projectPath, relativePath);
          else await new ProjectFileService().read(projectPath, relativePath, true);
        },
      });
agentSocket?.useRuntime({
  ...(sharedProcesses === undefined ? {} : { processes: sharedProcesses }),
  ...(managedAgents === undefined
    ? {}
    : {
        agents: {
          spawn: (context, input) => managedAgents.spawn(context, input),
          interrupt: (actor, agentSessionId) =>
            managedAgents.interruptByAgent(actor, agentSessionId),
        },
      }),
  ...(agentWorkspace === undefined ? {} : { workspace: agentWorkspace }),
});
const leaseManager = new LeaseManager();
const holdMonitor =
  agentPlatform === undefined || config.agentHoldTimeouts === undefined
    ? undefined
    : new HoldMonitor({
        store: repository.agentPlatform,
        humanConnected: () => leaseManager.hasController(),
        idleMs: config.agentHoldTimeouts.idleMs,
        disconnectMs: config.agentHoldTimeouts.disconnectMs,
        release: {
          agent: async (agentSessionId, reason) => {
            // Back to the orchestrator first, then lift the hold so a woken orchestrator can write.
            await managedAgents
              ?.switchWriter(agentSessionId, "orchestrator", false)
              .catch(() => undefined);
            agentPlatform.setHumanHold(
              { actor: { kind: "system" }, idempotencyKey: randomUUID() },
              { agentSessionId, held: false, reason },
            );
          },
          process: async (processId, reason) => {
            await sharedProcesses?.setHold(
              { actor: { kind: "system" }, idempotencyKey: randomUUID() },
              processId,
              false,
              reason,
            );
          },
        },
      });
holdMonitor?.start();
const closeAgents = async (): Promise<void> => {
  holdMonitor?.close();
  sharedProcesses?.close();
  wakeups?.close();
  managedAgents?.close();
  await runtimeChannel?.close();
  await agentSocket?.close();
};
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  await agentSocket?.start();
  // Runners that outlived a Naru restart reconnect here (their Host PTYs keep running); those that
  // do not come back within the grace period are marked unknown with their runs (AP-T10).
  await runtimeChannel?.start();
  managedAgents?.reconcileAfterStart((paneId) => supervisor.isRunning(paneId));
  app = await buildApp(config, {
    repository,
    pathPolicy,
    supervisor,
    ...(agentPlatform === undefined ? {} : { agentPlatform }),
    ...(managedAgents === undefined ? {} : { agentRuntime: managedAgents }),
    ...(sharedProcesses === undefined
      ? {}
      : { sharedProcesses, paneControlPolicy: sharedProcesses }),
    ...(holdMonitor === undefined
      ? {}
      : { noteHumanInput: (target) => holdMonitor.noteHumanInput(target) }),
    leaseManager,
  });
} catch (error) {
  await closeAgents();
  await supervisor.shutdown();
  repository.close();
  throw error;
}
app.addHook("onClose", closeAgents);
agentSocket?.useErrorSink((tool, error) =>
  app.log.warn(
    {
      timestamp: new Date().toISOString(),
      event: "agent.tool.failed",
      tool,
      ...safeErrorFields(error),
    },
    "agent tool failed",
  ),
);

const shutdown = createGracefulShutdownHandler(app);

process.once("SIGINT", () => void shutdown("SIGINT"));
process.once("SIGTERM", () => void shutdown("SIGTERM"));

try {
  await app.listen({ host: config.host, port: config.port });
} catch (error) {
  app.log.error(
    {
      timestamp: new Date().toISOString(),
      event: "server.listen.failed",
      ...safeErrorFields(error),
    },
    "server listen failed",
  );
  await app.close();
  process.exitCode = 1;
}

/** Node command lines for the agent runner, bridge hook and MCP bins (built or from source). */
function agentProcessEntries(production: boolean) {
  const entry = (name: string): string =>
    fileURLToPath(
      production
        ? new URL(`./${name}.js`, import.meta.url)
        : new URL(`../src/${name}.ts`, import.meta.url),
    );
  return {
    node: {
      file: process.execPath,
      args: production
        ? []
        : ["--import", new URL("../../../node_modules/tsx/dist/loader.mjs", import.meta.url).href],
    },
    entries: {
      runner: entry("claude-agent-runner"),
      hook: entry("agent-hook-cli"),
      mcp: entry("agent-mcp-cli"),
    },
  };
}

function loadRootEnvironment(root: URL): void {
  const externalEnvironmentFile = process.env.NARU_ENV_FILE;
  if (externalEnvironmentFile !== undefined) {
    loadSecureEnvironmentFile(externalEnvironmentFile);
    return;
  }

  try {
    loadEnvFile(new URL(".env", root));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
}
