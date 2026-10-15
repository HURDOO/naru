import { spawn } from "node:child_process";
import { DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV } from "@naru/durable-session-integration";
import { requestCodexIntegration } from "./integrations/codex/client.js";
import { NARU_CODEX_INTEGRATION_SOCKET_ENV } from "./integrations/codex/protocol.js";

const bootstrap = process.env[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
const socketPath = process.env[NARU_CODEX_INTEGRATION_SOCKET_ENV];
if (bootstrap === undefined || socketPath === undefined) {
  process.stderr.write("NARU_CLAUDE_INTEGRATION_UNAVAILABLE\n");
  process.exitCode = 1;
} else {
  const reply = await requestCodexIntegration(socketPath, {
    version: 1,
    type: "claude-launch",
    bootstrap,
  });
  if (reply?.ok !== true || reply.type !== "claude-launch") {
    process.stderr.write("NARU_CLAUDE_INTEGRATION_DENIED\n");
    process.exitCode = 1;
  } else {
    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      NARU_PTY_HOSTED: "1",
      NARU_CLAUDE_HOOK_BOOTSTRAP: bootstrap,
      // A managed agent runner's private channel (AP-T14); the reply schema admits nothing else.
      ...reply.plan.environment,
    };
    delete environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
    process.exitCode = await runClaude(reply.plan.executable, reply.plan.args, environment);
  }
}

function runClaude(
  executable: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<number> {
  return new Promise<number>((resolve) => {
    const child = spawn(executable, [...args], {
      cwd: process.cwd(),
      env: environment,
      stdio: "inherit",
    });
    let settled = false;
    let stopTimer: NodeJS.Timeout | null = null;
    const stop = (): void => {
      if (settled || stopTimer !== null) return;
      child.kill("SIGTERM");
      stopTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    };
    const interrupt = (): void => {
      // The shared PTY delivers interactive input to the Claude child.
    };
    const finish = (exitCode: number): void => {
      if (settled) return;
      settled = true;
      if (stopTimer !== null) clearTimeout(stopTimer);
      process.off("SIGTERM", stop);
      process.off("SIGHUP", stop);
      process.off("SIGINT", interrupt);
      resolve(exitCode);
    };
    process.on("SIGTERM", stop);
    process.on("SIGHUP", stop);
    process.on("SIGINT", interrupt);
    child.once("error", () => {
      process.stderr.write("NARU_CLAUDE_LAUNCH_FAILED\n");
      finish(1);
    });
    child.once("exit", (code) => finish(code ?? 1));
  });
}
