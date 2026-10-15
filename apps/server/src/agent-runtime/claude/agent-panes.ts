import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { AgentRole, AgentSession } from "@naru/contracts/naru-agent/v1";
import {
  NARU_AGENT_CAPABILITY_ENV,
  NARU_AGENT_SOCKET_ENV,
} from "../../agent-platform/agent-socket.js";
import { nativeSessionName, type AgentPlatformCore } from "../../agent-platform/core.js";
import { claudeActivityHookSettings } from "../../claude-activity-events.js";
import type { NaruRepository, PaneContext } from "../../database.js";
import { AppError } from "../../errors.js";
import type { AgentPaneLaunchResolver, PaneLaunchCommand } from "../../launch-profiles.js";
import type { NaruSessionFacade } from "../../session-facade.js";
import type { RunnerPlan } from "../channel-protocol.js";
import type { RunnerEnvironment, RunnerLauncher } from "../supervisor.js";
import { orchestrationGuidance } from "../orchestration-skill.js";
import { naruClaudeHookSettings } from "./hook-settings.js";

const SYSTEM = { kind: "system" } as const;
const TUI_POLL_MS = 200;

/**
 * Model per role, always explicit (AP-D011): without user settings Claude would fall back to a
 * small default. Validation runs use these; operating values are set last (AP-D007).
 */
export const CLAUDE_AGENT_MODELS: Readonly<Record<AgentRole, string>> = {
  "main-orchestrator": "claude-opus-5-5",
  "project-orchestrator": "claude-opus-5-5",
  worker: "claude-opus-5-5",
  reviewer: "claude-opus-5-5",
  specialist: "claude-opus-5-5",
};

/** A Node command line: the executable and the arguments before a script entry. */
export interface NodeCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface ClaudeAgentLaunchConfig {
  readonly claudeExecutable: string;
  /** User-installed Claude Agent SDK entry (AP-D012). */
  readonly sdkEntry: string;
  readonly node: NodeCommand;
  readonly entries: {
    readonly runner: string;
    readonly hook: string;
    readonly mcp: string;
  };
  readonly agentSocketPath: string;
  /** Claude activity hook for the TUI form, so its Pane reports activity like any Claude Pane. */
  readonly activityHookCommand?: string;
  readonly models?: Readonly<Record<AgentRole, string>>;
}

/**
 * Hosts Naru-managed Claude agents in Panes (AP-T14): the runner (Chat) or the Claude TUI runs in
 * the Pane's Host PTY. Every launch mints a fresh agent capability and revokes the previous ones,
 * so an older runtime generation loses Naru access.
 */
export class ClaudeAgentPanes implements AgentPaneLaunchResolver, RunnerLauncher {
  readonly #config: ClaudeAgentLaunchConfig;
  readonly #core: AgentPlatformCore;
  readonly #repository: NaruRepository;
  readonly #sessions: () => NaruSessionFacade;
  readonly #runnerEnvironment: (agentSessionId: string) => RunnerEnvironment;

  constructor(options: {
    readonly config: ClaudeAgentLaunchConfig;
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

  /** RunnerLauncher: binds (or reuses) the agent's Pane and starts its Host session. */
  async launch(
    agentSessionId: string,
    options: { readonly hostProjectId?: string } = {},
  ): Promise<void> {
    const agent = this.#core.getAgentSession(SYSTEM, agentSessionId);
    if (agent.runtime !== "claude") {
      throw new AppError("AGENT_INVALID_STATE", 409, "Claude 에이전트가 아닙니다.");
    }
    const pane = this.#repository.createAgentPane(
      agentSessionId,
      paneTitle(agent),
      options.hostProjectId,
    );
    // The TUI's SessionStart must be the one that confirms a resume, not an older report.
    if (agent.launchMode === "tui") this.#repository.clearClaudeSession(pane.id);
    await this.#sessions().start(pane.id);
  }

  /** Ends the Pane's Host session (waiting for it to exit) but keeps the Pane and its binding. */
  async stop(agentSessionId: string): Promise<void> {
    const paneId = this.#core.getAgentSession(SYSTEM, agentSessionId).paneId;
    if (paneId === null || this.#repository.getPaneContext(paneId) === undefined) return;
    await this.#sessions().remove(paneId);
  }

  async awaitTuiSession(agentSessionId: string, timeoutMs: number): Promise<string | null> {
    const paneId = this.#core.getAgentSession(SYSTEM, agentSessionId).paneId;
    if (paneId === null) return null;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const pane = this.#repository.getPaneContext(paneId)?.pane;
      if (pane === undefined) return null;
      if (pane.claudeSessionId !== null && pane.claudeSessionId !== undefined) {
        return pane.claudeSessionId;
      }
      if (!this.#sessions().isRunning(paneId)) return null;
      await new Promise((resolve) => setTimeout(resolve, TUI_POLL_MS));
    }
    return null;
  }

  preflight(context: PaneContext): void {
    const agent = this.#agentFor(context);
    if (agent.launchMode === "runner" && !isRegularFile(this.#config.sdkEntry)) {
      throw new AppError(
        "AGENT_RUNTIME_UNAVAILABLE",
        503,
        "Claude Agent SDK를 찾을 수 없습니다. 설치 경로 설정을 확인해 주세요.",
      );
    }
    if (agent.launchMode === "tui" && agent.runtimeSessionRef === null) {
      throw new AppError("AGENT_INVALID_STATE", 409, "아직 TUI로 열 대화가 없습니다.");
    }
  }

  resolve(
    context: PaneContext,
    base: { readonly claudeExecutable: string; readonly environment: Record<string, string> },
  ): PaneLaunchCommand {
    this.preflight(context);
    const agent = this.#agentFor(context);
    if (agent.launchMode === "runner") {
      const launcherEnvironment = { ...this.#runnerEnvironment(agent.id) };
      return {
        file: this.#config.node.file,
        args: [...this.#config.node.args, this.#config.entries.runner],
        environment: { ...base.environment, ...launcherEnvironment },
        launcherEnvironment,
      };
    }
    // TUI form: the same conversation, resumed in the real Claude TUI (stop-resume, AP-D011).
    const capability = this.#mintCapability(agent.id);
    const settings = mergeHookSettings(
      naruClaudeHookSettings({
        runner: this.#config.node.file,
        runnerArgs: this.#config.node.args,
        entry: this.#config.entries.hook,
        socketPath: this.#config.agentSocketPath,
        capability,
        mode: "tui",
      }),
      this.#config.activityHookCommand === undefined
        ? {}
        : (JSON.parse(claudeActivityHookSettings(this.#config.activityHookCommand)) as Record<
            string,
            unknown
          >),
    );
    return {
      file: base.claudeExecutable,
      args: [
        "--resume",
        agent.runtimeSessionRef!,
        "--model",
        this.#model(agent),
        "--name",
        nativeSessionName(agent.id),
        "--setting-sources",
        "project,local",
        "--append-system-prompt",
        roleInstructions(agent),
        "--settings",
        JSON.stringify(settings),
        "--mcp-config",
        JSON.stringify({ mcpServers: this.#mcpServers(capability) }),
        "--strict-mcp-config",
      ],
      environment: base.environment,
    };
  }

  /** The runner's plan; asked for by a fresh runner when it first reaches Naru. */
  plan(agent: AgentSession): RunnerPlan {
    const context = this.#paneContext(agent);
    const capability = this.#mintCapability(agent.id);
    return {
      executable: this.#config.claudeExecutable,
      sdkEntry: this.#config.sdkEntry,
      cwd: context.projectPath,
      model: this.#model(agent),
      resumeRef: agent.runtimeSessionRef,
      nativeName: nativeSessionName(agent.id),
      settings: naruClaudeHookSettings({
        runner: this.#config.node.file,
        runnerArgs: this.#config.node.args,
        entry: this.#config.entries.hook,
        socketPath: this.#config.agentSocketPath,
        capability,
        mode: "runner",
      }),
      mcpServers: this.#mcpServers(capability),
      instructions: roleInstructions(agent),
      permissionMode: "default",
      environment: {},
    };
  }

  #mcpServers(capability: string): Record<string, unknown> {
    return {
      naru: {
        type: "stdio",
        command: this.#config.node.file,
        args: [...this.#config.node.args, this.#config.entries.mcp],
        env: {
          [NARU_AGENT_SOCKET_ENV]: this.#config.agentSocketPath,
          [NARU_AGENT_CAPABILITY_ENV]: capability,
        },
      },
    };
  }

  #mintCapability(agentSessionId: string): string {
    this.#core.revokeAgentCapabilities(SYSTEM, agentSessionId);
    return this.#core.issueAgentCapability(SYSTEM, agentSessionId);
  }

  #model(agent: AgentSession): string {
    return (this.#config.models ?? CLAUDE_AGENT_MODELS)[agent.role];
  }

  #agentFor(context: PaneContext): AgentSession {
    const agent = this.#repository.agentPlatform.findAgentSessionByPane(context.pane.id);
    if (agent === null || agent.runtime !== "claude") {
      throw new AppError("AGENT_NOT_FOUND", 404, "Pane에 연결된 에이전트가 없습니다.");
    }
    return agent;
  }

  #paneContext(agent: AgentSession): PaneContext {
    const context =
      agent.paneId === null ? undefined : this.#repository.getPaneContext(agent.paneId);
    if (context === undefined) {
      throw new AppError("AGENT_INVALID_STATE", 409, "에이전트 Pane이 없습니다.");
    }
    return context;
  }
}

function paneTitle(agent: AgentSession): string {
  return `Claude ${agent.role} · ${nativeSessionName(agent.id)}`;
}

function roleInstructions(agent: AgentSession): string {
  return orchestrationGuidance(
    agent.role,
    `You are a Naru-managed ${agent.role} agent (${nativeSessionName(agent.id)}). Your naru MCP ` +
      "tools act as you; Naru checks every call against your role and project.",
  );
}

/** Concatenates hook matchers per event; other keys come from the first settings object. */
function mergeHookSettings(
  primary: Record<string, unknown>,
  secondary: Record<string, unknown>,
): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  for (const settings of [primary, secondary]) {
    const entries = (settings.hooks ?? {}) as Record<string, unknown[]>;
    for (const [event, matchers] of Object.entries(entries)) {
      hooks[event] = [...(hooks[event] ?? []), ...matchers];
    }
  }
  return { ...secondary, ...primary, hooks };
}

function isRegularFile(path: string): boolean {
  try {
    return isAbsolute(path) && statSync(path).isFile();
  } catch {
    return false;
  }
}
