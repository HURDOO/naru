import { DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV } from "@naru/durable-session-integration";
import { runCodexInteractionGuardianMode } from "./codex-interaction-guardian.js";
import { runCodexInteractionRelay } from "./codex-interaction-relay.js";
import { CODEX_SESSION_HOOK_ENVIRONMENT_KEYS } from "./codex-session-hook.js";
import { requestCodexIntegration } from "./integrations/codex/client.js";
import { NARU_CODEX_INTEGRATION_SOCKET_ENV } from "./integrations/codex/protocol.js";

if (
  process.argv[2] === "--guardian" ||
  (process.env.NARU_CODEX_GUARDIAN_MODE === "1" && process.send !== undefined)
) {
  await runCodexInteractionGuardianMode();
} else {
  await launch();
}

async function launch(): Promise<void> {
  const bootstrap = process.env[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
  const socketPath = process.env[NARU_CODEX_INTEGRATION_SOCKET_ENV];
  if (bootstrap === undefined || socketPath === undefined)
    fail("NARU_CODEX_INTEGRATION_UNAVAILABLE");

  const reply = await requestCodexIntegration(socketPath, {
    version: 1,
    type: "launch",
    bootstrap,
  });
  if (reply?.ok !== true || reply.type !== "launch") fail("NARU_CODEX_INTEGRATION_DENIED");

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NARU_PTY_HOSTED: "1",
    [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.socket]: socketPath,
    [CODEX_SESSION_HOOK_ENVIRONMENT_KEYS.bootstrap]: bootstrap,
  };
  delete environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];

  const managed = reply.plan.environment;
  const exitCode = await runCodexInteractionRelay({
    executable: reply.plan.executable,
    args: reply.plan.args,
    environment,
    bootstrap,
    integrationSocketPath: socketPath,
    cwd: process.cwd(),
    // The runner channel token stays in the relay; Codex and its tools never see it.
    ...(managed === undefined
      ? {}
      : { managed: { socketPath: managed.NARU_RUNTIME_SOCKET, token: managed.NARU_RUNTIME_TOKEN } }),
  });
  process.exitCode = exitCode;
}

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}
