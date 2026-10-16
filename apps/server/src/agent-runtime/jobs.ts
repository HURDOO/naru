import type {
  AgentRuntimeState,
  AgentSession,
  AgentWorktree,
  Instruction,
} from "@naru/contracts/naru-agent/v1";
import type {
  AgentPlatformCore,
  CommandContext,
  JobCompletionPlan,
} from "../agent-platform/core.js";
import type { WorktreeRemoval } from "./workspace.js";

const HUMAN = { kind: "human" } as const;
/** How long a runner may take to end its turn input and exit before its Pane is removed. */
const STOP_WAIT_MS = 10_000;
const STOP_POLL_MS = 250;
const DOWN = new Set<AgentSession["status"]>(["stopped", "failed", "unknown"]);

/** Why an agent of a job stays when the job completes. */
export type JobAgentKeep = "held" | "other-work" | "working" | "person";

export interface JobCompletionPreview {
  readonly openTasks: number;
  readonly agents: readonly { readonly agent: AgentSession; readonly keep: JobAgentKeep | null }[];
  readonly worktrees: readonly {
    readonly branch: string;
    readonly taskId: string;
    readonly merged: boolean;
  }[];
}

export interface JobCompletionResult {
  readonly retired: readonly AgentSession[];
  readonly kept: readonly { readonly agent: AgentSession; readonly keep: JobAgentKeep }[];
  readonly worktrees: readonly WorktreeRemoval[];
  /** Panes of cleaned-up agents that could not be removed; the person can still close them. */
  readonly panesKept: number;
}

export interface JobLifecycleOptions {
  readonly core: AgentPlatformCore;
  /** The managed runtimes; without them nothing runs, so nothing needs stopping or resuming. */
  readonly runtime?: {
    launch(agentSessionId: string): Promise<void>;
    stop(agentSessionId: string): void;
    runtimeState(agentSessionId: string): AgentRuntimeState;
  };
  readonly removePane?: (paneId: string) => Promise<void>;
  readonly worktrees?: {
    removeMergedWorktree(worktree: AgentWorktree, mergeCommit: string): Promise<WorktreeRemoval>;
  };
  readonly stopWaitMs?: number;
}

/**
 * Completing and reopening a job (AP-D036). Core records the decision; this class does what runs:
 * it stops the job's workers and reviewers before they are cleaned up, removes their Panes and the
 * merged worktrees, and on reopening resumes the same conversations.
 */
export class JobLifecycle {
  readonly #options: JobLifecycleOptions;

  constructor(options: JobLifecycleOptions) {
    this.#options = options;
  }

  preview(goalId: string): JobCompletionPreview {
    const plan = this.#options.core.jobCompletionPlan(HUMAN, goalId);
    return {
      openTasks: plan.openTasks,
      agents: plan.agents.map((item) => ({ agent: item.agent, keep: this.#keep(item) })),
      worktrees: plan.worktrees.map((item) => ({
        branch: item.worktree.branch,
        taskId: item.task.id,
        merged: item.mergeCommit !== null,
      })),
    };
  }

  async complete(
    context: CommandContext,
    goalId: string,
    keepAgentSessionIds: readonly string[],
  ): Promise<JobCompletionResult> {
    const { core, runtime, removePane, worktrees } = this.#options;
    const plan = core.jobCompletionPlan(HUMAN, goalId);
    const kept: { agent: AgentSession; keep: JobAgentKeep }[] = [];
    const leaving: AgentSession[] = [];
    for (const item of plan.agents) {
      const keep = keepAgentSessionIds.includes(item.agent.id) ? "person" : this.#keep(item);
      if (keep === null) leaving.push(item.agent);
      else kept.push({ agent: item.agent, keep });
    }
    // Recorded first, so the runtimes' own "stopped" reports that follow wake no orchestrator.
    const state = core.completeJob(context, {
      goalId,
      retireAgentSessionIds: leaving.map((agent) => agent.id),
    });
    const retired = state.retiredAgentSessionIds.map((id) => core.getAgentSession(HUMAN, id));
    // A connected runner ends its input and exits; anything else (a TUI, a runner that does not
    // exit in time) ends with its Pane below.
    const stopping = retired.filter((agent) => this.#connected(agent));
    for (const agent of stopping) runtime?.stop(agent.id);
    await this.#waitDisconnected(stopping.map((agent) => agent.id));
    let panesKept = 0;
    for (const agent of retired) {
      if (agent.paneId === null || removePane === undefined) continue;
      try {
        await removePane(agent.paneId);
      } catch {
        panesKept += 1;
      }
    }
    const removals: WorktreeRemoval[] = [];
    for (const item of plan.worktrees) {
      if (item.mergeCommit === null || worktrees === undefined) continue;
      removals.push(await worktrees.removeMergedWorktree(item.worktree, item.mergeCommit));
    }
    return { retired, kept, worktrees: removals, panesKept };
  }

  async reopen(
    context: CommandContext,
    goalId: string,
    verbatim: string,
  ): Promise<{
    readonly instruction: Instruction;
    readonly resumed: readonly AgentSession[];
    readonly failed: readonly AgentSession[];
  }> {
    const { core, runtime } = this.#options;
    const { instruction, resumed } = core.reopenJob(context, { goalId, verbatim });
    const failed: AgentSession[] = [];
    for (const agent of resumed) {
      if (runtime === undefined || !DOWN.has(core.getAgentSession(HUMAN, agent.id).status)) {
        continue;
      }
      // The same conversation resumes (its runtime session ref); a launch failure is reported.
      await runtime.launch(agent.id).catch(() => failed.push(agent));
    }
    return {
      instruction,
      resumed: resumed.map((agent) => core.getAgentSession(HUMAN, agent.id)),
      failed,
    };
  }

  /** Core's reason, or that it is in the middle of a turn or waits for an approval right now. */
  #keep(item: JobCompletionPlan["agents"][number]): JobAgentKeep | null {
    if (item.keep !== null) return item.keep;
    if (DOWN.has(item.agent.status)) return null;
    try {
      const state = this.#options.runtime?.runtimeState(item.agent.id);
      if (state !== undefined && (state.turnActive || state.pendingApprovals.length > 0)) {
        return "working";
      }
    } catch {
      // Not connected: nothing is running a turn.
    }
    return null;
  }

  #connected(agent: Pick<AgentSession, "id">): boolean {
    try {
      return this.#options.runtime?.runtimeState(agent.id).connected === true;
    } catch {
      return false;
    }
  }

  async #waitDisconnected(agentSessionIds: readonly string[]): Promise<void> {
    const deadline = Date.now() + (this.#options.stopWaitMs ?? STOP_WAIT_MS);
    while (agentSessionIds.some((id) => this.#connected({ id })) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, STOP_POLL_MS));
    }
  }
}
