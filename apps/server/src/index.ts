import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";
import { buildApp } from "./app.js";
import { CODEX_SESSION_HOOK_COMMAND, CodexSessionHookServer } from "./codex-session-hook.js";
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
import { CodexIntegrationServer } from "./integrations/codex/server.js";
import type { NaruSessionFacade } from "./session-facade.js";

const projectRoot = new URL("../../../", import.meta.url);
loadRootEnvironment(projectRoot);

const config = loadConfig(process.env, fileURLToPath(projectRoot));
const sessionRuntime = config.sessionRuntime ?? { owner: "legacy" as const };
const repository = NaruRepository.openDataDirectory(config.dataDir, {
  sessionOwner: sessionRuntime.owner,
});
const pathPolicy = await ProjectPathPolicy.create(config.projectRoots);
let supervisor: NaruSessionFacade;
if (sessionRuntime.owner === "durable-host") {
  const launchProfiles = new LaunchProfileRegistry({
    ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
    codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
  });
  const codexIntegration = new NaruCodexIntegration(repository, sessionRuntime, launchProfiles);
  const codexIntegrationServer = new CodexIntegrationServer(config.dataDir, codexIntegration, {
    ...(config.codexIntegrationSocketPath === undefined
      ? {}
      : { socketPath: config.codexIntegrationSocketPath }),
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
  });
  await hookServer.start();
  const launchProfiles = new LaunchProfileRegistry({
    ...(config.codexExecutable === undefined ? {} : { codexExecutable: config.codexExecutable }),
    codexSessionHookCommand: CODEX_SESSION_HOOK_COMMAND,
  });
  supervisor = new PtySupervisor(repository, undefined, launchProfiles, hookServer);
}
let app: Awaited<ReturnType<typeof buildApp>>;
try {
  app = await buildApp(config, { repository, pathPolicy, supervisor });
} catch (error) {
  await supervisor.shutdown();
  repository.close();
  throw error;
}

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
