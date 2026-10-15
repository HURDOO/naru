import type { AgentRuntime, AgentSession } from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore } from "../agent-platform/core.js";
import { AgentPlatformError } from "../agent-platform/core.js";
import type { AnyRunnerPlan } from "./channel-protocol.js";
import type { RunnerLauncher } from "./supervisor.js";

const SYSTEM = { kind: "system" } as const;

/** A runtime's Pane host: launches, stops and plans its managed agents. */
export interface AgentRuntimeHost extends RunnerLauncher {
  plan(agent: AgentSession): AnyRunnerPlan;
}

/** Dispatches each managed agent to its runtime's host (Claude runner, Codex relay). */
export class RuntimeLaunchers implements RunnerLauncher {
  readonly #core: AgentPlatformCore;
  readonly #hosts: Partial<Record<AgentRuntime, AgentRuntimeHost>>;

  constructor(core: AgentPlatformCore, hosts: Partial<Record<AgentRuntime, AgentRuntimeHost>>) {
    this.#core = core;
    this.#hosts = hosts;
  }

  launch(agentSessionId: string, options?: { readonly hostProjectId?: string }): Promise<void> {
    return this.#host(this.#runtime(agentSessionId)).launch(agentSessionId, options);
  }

  stop(agentSessionId: string): Promise<void> {
    return this.#host(this.#runtime(agentSessionId)).stop(agentSessionId);
  }

  awaitTuiSession(agentSessionId: string, timeoutMs: number): Promise<string | null> {
    const host = this.#host(this.#runtime(agentSessionId));
    return host.awaitTuiSession?.(agentSessionId, timeoutMs) ?? Promise.resolve(null);
  }

  plan(agent: AgentSession): AnyRunnerPlan {
    return this.#host(agent.runtime).plan(agent);
  }

  supports(runtime: AgentRuntime): boolean {
    return this.#hosts[runtime] !== undefined;
  }

  #runtime(agentSessionId: string): AgentRuntime {
    return this.#core.getAgentSession(SYSTEM, agentSessionId).runtime;
  }

  #host(runtime: AgentRuntime): AgentRuntimeHost {
    const host = this.#hosts[runtime];
    if (host === undefined) {
      throw new AgentPlatformError(
        "AGENT_RUNTIME_UNAVAILABLE",
        `Naru cannot run managed ${runtime} agents here.`,
      );
    }
    return host;
  }
}
