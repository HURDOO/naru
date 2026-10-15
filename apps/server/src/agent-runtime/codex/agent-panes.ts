import type { AgentRole, AgentSession } from "@naru/contracts/naru-agent/v1";
import {
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../../agent-platform/agent-socket.js";
import { nativeSessionName, type AgentPlatformCore } from "../../agent-platform/core.js";
import type { NaruRepository, PaneContext } from "../../database.js";
import { AppError } from "../../errors.js";
import type { CodexAgentPaneLaunchResolver, PaneLaunchCommand } from "../../launch-profiles.js";
import type { NaruSessionFacade } from "../../session-facade.js";
import type { CodexRunnerPlan } from "../channel-protocol.js";
import type { NodeCommand } from "../claude/agent-panes.js";
import { orchestrationGuidance } from "../orchestration-skill.js";
import type { RunnerEnvironment, RunnerLauncher } from "../supervisor.js";

const SYSTEM = { kind: "system" } as const;

/**
 * Model per role, always explicit (AP-D011). Validation runs use Astra with the codex-main profile's
 * xhigh reasoning (user choice); operating values are set last (AP-D007).
 */
export const CODEX_AGENT_MODELS: Readonly<Record<AgentRole, string>> = {
  "main-orchestrator": "gpt-6-astra",
  "project-orchestrator": "gpt-6-astra",
  worker: "gpt-6-astra",
  reviewer: "gpt-6-astra",
  specialist: "gpt-6-astra",
};

export interface CodexAgentLaunchConfig {
  readonly node: NodeCommand;
  readonly entries: { readonly mcp: string };
  readonly agentSocketPath: string;
  readonly models?: Readonly<Record<AgentRole, string>>;
}

/**
 * Hosts Naru-managed Codex agents in Panes (AP-T13). The Pane runs the usual Codex launcher, relay
 * and real TUI; in managed mode the relay is also the runner that owns the conversation thread and
 * fences the TUI by Naru's writer (live GUI and TUI on one thread, AP-D011 A).
 */
export class CodexAgentPanes implements CodexAgentPaneLaunchResolver, RunnerLauncher {
  readonly #config: CodexAgentLaunchConfig;
  readonly #core: AgentPlatformCore;
  readonly #repository: NaruRepository;
  readonly #sessions: () => NaruSessionFacade;
  readonly #runnerEnvironment: (agentSessionId: string) => RunnerEnvironment;

  constructor(options: {
    readonly config: CodexAgentLaunchConfig;
    readonly core: AgentPlatformCore;
    readonly repository: NaruRepository;
    readonly sessions: () => NaruSessionFacade;
    readonly runnerEnvironment: (agentSessionId: string) => RunnerEnvironment;
  }) {
    this.#config = options.config;
    this.#core = options.core;
    this.#repository = options.repository;
    this.#sessions = options.sessions;
    this.#runnerEnvironment = options.runnerEnvironment;
  }

  async launch(
    agentSessionId: string,
    options: { readonly hostProjectId?: string } = {},
  ): Promise<void> {
    const agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
    if (agent.runtime !== "codex") {
      throw new AppError("AGENT_INVALID_STATE", 409, "Codex 에이전트가 아닙니다.");
    }
    const pane = this.#repository.createAgentPane(
      agentSessionId,
      `Codex ${agent.role} · ${nativeSessionName(agent.id)}`,
      options.hostProjectId,
    );
    await this.#sessions().start(pane.id);
  }

  async stop(agentSessionId: string): Promise<void> {
    const paneId = this.#core.getAgentSession(SYSTEM, agentSessionId).paneId;
    if (paneId === null || this.#repository.getPaneContext(paneId) === undefined) return;
    await this.#sessions().remove(paneId);
  }

  preflight(context: PaneContext): void {
    this.#agentFor(context);
  }

  resolve(
    context: PaneContext,
    base: {
      readonly codexExecutable: string;
      readonly environment: Record<string, string>;
      readonly profileArgs: readonly string[];
    },
  ): PaneLaunchCommand {
    const agent = this.#agentFor(context);
    const launcherEnvironment = { ...this.#runnerEnvironment(agent.id) };
    // The relay resumes Naru's thread itself; the profile never carries a resume here.
    return {
      file: base.codexExecutable,
      args: [...base.profileArgs],
      environment: base.environment,
      launcherEnvironment,
    };
  }

  /** The relay's plan: a fresh agent capability per launch revokes the previous generation's. */
  plan(agent: AgentSession): CodexRunnerPlan {
    this.#core.revokeAgentCapabilities(SYSTEM, agent.id);
    const capability = this.#core.issueAgentCapability(SYSTEM, agent.id);
    return {
      runtime: "codex",
      resumeRef: agent.runtimeSessionRef,
      model: (this.#config.models ?? CODEX_AGENT_MODELS)[agent.role],
      mcpServers: {
        naru: {
          command: this.#config.node.file,
          args: [...this.#config.node.args, this.#config.entries.mcp],
          env: {
            [NARU_AGENT_SOCKET_ENV]: this.#config.agentSocketPath,
            [NARU_AGENT_CAPABILITY_ENV]: capability,
          },
        },
      },
      instructions: orchestrationGuidance(
        agent.role,
        `You are a Naru-managed ${agent.role} agent (${nativeSessionName(agent.id)}). Your naru MCP ` +
          "tools act as you; Naru checks every call against your role and project.",
      ),
    };
  }

  #agentFor(context: PaneContext): AgentSession {
    const agent = this.#repository.agentPlatform.findAgentSessionByPane(context.pane.id);
    if (agent === null || agent.runtime !== "codex") {
      throw new AppError("AGENT_NOT_FOUND", 404, "Pane에 연결된 Codex 에이전트가 없습니다.");
    }
    return agent;
  }
}
