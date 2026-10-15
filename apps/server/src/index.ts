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
let supervisor: NaruSessionFacade;
if (sessionRuntime.owner === "durable-host") {
  const launchProfiles = new LaunchProfileRegistry({
    ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
    ...(config.claudeExecutable === undefined ? {} : { claudeExecutable: config.claudeExecutable }),
    codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
    claudeActivityHookCommand: CLAUDE_ACTIVITY_HOOK_COMMAND,
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
// Agent Platform is opt-in (NARU_AGENT_PLATFORM=1); without it nothing below starts.
const agentPlatform = config.agentPlatform
  ? new AgentPlatformCore(repository.agentPlatform)
  : undefined;
const agentSocket =
  agentPlatform === undefined ? undefined : new AgentSocketServer(config.dataDir, agentPlatform);
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  await agentSocket?.start();
  app = await buildApp(config, {
    repository,
    pathPolicy,
    supervisor,
    ...(agentPlatform === undefined ? {} : { agentPlatform }),
  });
} catch (error) {
  await agentSocket?.close();
  await supervisor.shutdown();
  repository.close();
  throw error;
}
if (agentSocket !== undefined) app.addHook("onClose", () => agentSocket.close());

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
