import { spawn, type ChildProcess } from "node:child_process";
import type { RunnerEnvironment, RunnerLauncher } from "./supervisor.js";

/**
 * Development/test launcher: runs the runner as a detached child process so it outlives a Naru
 * restart like a Host-owned one would. Production launches runners in a DurableSession PTY.
 */
export class ChildProcessRunnerLauncher implements RunnerLauncher {
  readonly #children = new Map<string, ChildProcess>();

  constructor(
    private readonly options: {
      readonly runnerEnvironment: (agentSessionId: string) => RunnerEnvironment;
      readonly command: string;
      readonly args: readonly string[];
      readonly environment: NodeJS.ProcessEnv;
      readonly onOutput?: (agentSessionId: string, line: string) => void;
    },
  ) {}

  launch(agentSessionId: string): Promise<void> {
    const child = spawn(this.options.command, [...this.options.args], {
      env: { ...this.options.environment, ...this.options.runnerEnvironment(agentSessionId) },
      stdio: ["ignore", "pipe", "inherit"],
      detached: true,
    });
    child.stdout?.setEncoding("utf8").on("data", (data: string) => {
      for (const line of data.split("\n")) {
        if (line.trim() !== "") this.options.onOutput?.(agentSessionId, line);
      }
    });
    child.on("exit", () => this.#children.delete(agentSessionId));
    this.#children.set(agentSessionId, child);
    return Promise.resolve();
  }

  stop(agentSessionId: string): Promise<void> {
    const child = this.#children.get(agentSessionId);
    if (child === undefined || child.exitCode !== null) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGTERM");
    });
  }

  kill(agentSessionId: string): void {
    this.#children.get(agentSessionId)?.kill("SIGTERM");
  }

  killAll(): void {
    for (const child of this.#children.values()) child.kill("SIGTERM");
  }
}
