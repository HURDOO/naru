import { spawn, type ChildProcess } from "node:child_process";
import { NARU_RUNTIME_SOCKET_ENV, NARU_RUNTIME_TOKEN_ENV } from "./channel-protocol.js";
import type { RunnerLauncher } from "./supervisor.js";

/**
 * Development/test launcher: runs the runner as a detached child process so it outlives a Naru
 * restart like a Host-owned one would. Production launches runners in a DurableSession PTY.
 */
export class ChildProcessRunnerLauncher implements RunnerLauncher {
  readonly #children = new Map<string, ChildProcess>();

  constructor(
    private readonly options: {
      readonly socketPath: () => string;
      readonly command: string;
      readonly args: readonly string[];
      readonly environment: NodeJS.ProcessEnv;
      readonly onOutput?: (agentSessionId: string, line: string) => void;
    },
  ) {}

  launch(input: { readonly agentSessionId: string; readonly token: string }): Promise<void> {
    const child = spawn(this.options.command, [...this.options.args], {
      env: {
        ...this.options.environment,
        [NARU_RUNTIME_SOCKET_ENV]: this.options.socketPath(),
        [NARU_RUNTIME_TOKEN_ENV]: input.token,
      },
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
    });
    child.stdout?.setEncoding("utf8").on("data", (data: string) => {
      for (const line of data.split("\n")) {
        if (line.trim() !== "") this.options.onOutput?.(input.agentSessionId, line);
      }
    });
    child.on("exit", () => this.#children.delete(input.agentSessionId));
    this.#children.set(input.agentSessionId, child);
    return Promise.resolve();
  }

  kill(agentSessionId: string): void {
    this.#children.get(agentSessionId)?.kill("SIGTERM");
  }

  killAll(): void {
    for (const child of this.#children.values()) child.kill("SIGTERM");
  }
}
