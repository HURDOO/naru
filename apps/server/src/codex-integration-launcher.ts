import { execve } from "node:process";
import { DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV } from "@naru/durable-session-integration";
import { CODEX_SESSION_HOOK_ENVIRONMENT_KEYS } from "./codex-session-hook.js";
import { requestCodexIntegration } from "./integrations/codex/client.js";
import { NARU_CODEX_INTEGRATION_SOCKET_ENV } from "./integrations/codex/protocol.js";

const bootstrap = process.env[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
const socketPath = process.env[NARU_CODEX_INTEGRATION_SOCKET_ENV];
if (bootstrap === undefined || socketPath === undefined) fail("NARU_CODEX_INTEGRATION_UNAVAILABLE");

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

try {
  if (execve === undefined) fail("NARU_CODEX_EXEC_UNAVAILABLE");
  execve(reply.plan.executable, [reply.plan.executable, ...reply.plan.args], environment);
} catch {
  fail("NARU_CODEX_EXEC_FAILED");
}

function fail(code: string): never {
  process.stderr.write(`${code}\n`);
  process.exit(1);
}
