import { randomUUID } from "node:crypto";
import type {
  AgentSession,
  AgentTask,
  ProjectStall,
  StallCause,
} from "@naru/contracts/naru-agent/v1";
import type { AgentPlatformCore } from "./core.js";

const SYSTEM = { kind: "system" } as const;
const OPEN_TASK_STATUSES: ReadonlySet<AgentTask["status"]> = new Set([
  "pending",
  "ready",
  "running",
  "blocked",
  "review",
]);
const LIVE_AGENT_STATUSES: ReadonlySet<AgentSession["status"]> = new Set([
  "starting",
  "active",
  "idle",
]);

export interface StallMonitorOptions {
  readonly core: AgentPlatformCore;
  /** Minutes without progress before Naru wakes the orchestrator; the person sees it after twice. */
  readonly minutes: number;
  /** A managed agent's turn is running now. */
  readonly working: (agentSessionId: string) => boolean;
  /** A managed agent waits for the person's approval now. */
  readonly awaitingApproval: (agentSessionId: string) => boolean;
  readonly now?: () => number;
  readonly intervalMs?: number;
}

/**
 * Notices open work that stands still (AP-D034). Asking is not stopping (INV-06), but a team that
 * silently waits on something that never comes was the most common way work stopped: a review sent
 * to the wrong agent, a worker that went down, a task nobody picked up. When a project with open
 * tasks shows no event for `minutes` and nothing waits for the person, Naru first wakes the project
 * orchestrator with `project.stalled` and the likely cause. If it still does not move after as long
 * again, the person sees it ("멈춤"); the `person` event also reaches their devices.
 */
export class StallMonitor {
  readonly #options: StallMonitorOptions;
  readonly #now: () => number;
  #timer: NodeJS.Timeout | null = null;

  constructor(options: StallMonitorOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  start(): void {
    if (this.#options.minutes <= 0 || this.#timer !== null) return;
    this.#timer = setInterval(() => this.tick(), this.#options.intervalMs ?? 60_000);
    this.#timer.unref();
  }

  close(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
  }

  /** One check of every project with open tasks; returns the stalls it recorded. */
  tick(): { readonly projectId: string; readonly stall: ProjectStall }[] {
    const recorded: { projectId: string; stall: ProjectStall }[] = [];
    const { core } = this.#options;
    const limitMs = this.#options.minutes * 60_000;
    for (const projectId of core.listProjectsWithOpenTasks(SYSTEM)) {
      try {
        const state = core.getProjectState(SYSTEM, projectId);
        // Waiting for the person is their turn, not a stall: the inbox already shows it.
        if (state.openHandoffs.length > 0) continue;
        if (core.getPendingIntentContract(SYSTEM, projectId) !== null) continue;
        const agents = core.listAgentSessions(SYSTEM, projectId);
        if (agents.some((agent) => agent.humanHoldSince !== null)) continue;
        if (
          agents.some(
            (agent) => this.#options.working(agent.id) || this.#options.awaitingApproval(agent.id),
          )
        ) {
          continue;
        }
        const progress = core.projectProgress(projectId);
        const now = this.#now();
        const lastAt = progress.lastProgressAt === null ? 0 : Date.parse(progress.lastProgressAt);
        if (now - lastAt < limitMs) continue;
        // The person hears of it once the orchestrator had as long again to move it.
        const stage =
          progress.stall === null
            ? "orchestrator"
            : progress.stall.stage === "orchestrator" &&
                progress.lastNoteAt !== null &&
                now - Date.parse(progress.lastNoteAt) >= limitMs
              ? "person"
              : null;
        if (stage === null) continue;
        const { cause, taskId } = stallCause(state.tasks, agents, (taskId) =>
          core.getTaskDetail(SYSTEM, taskId).reviews.map((review) => review.kind),
        );
        const stall = core.recordStall(
          { actor: SYSTEM, idempotencyKey: randomUUID() },
          { projectId, stage, cause, taskId, minutes: Math.floor((now - lastAt) / 60_000) },
        );
        if (stall === null) continue;
        recorded.push({ projectId, stall });
      } catch {
        // A project removed or changed while this ran is checked again on the next tick.
      }
    }
    return recorded;
  }
}

/** The most likely reason open work stands still, and the task it concerns. */
export function stallCause(
  tasks: readonly AgentTask[],
  agents: readonly AgentSession[],
  reviewKinds: (taskId: string) => readonly string[],
): { readonly cause: StallCause; readonly taskId: string | null } {
  if (
    !agents.some(
      (agent) => agent.role === "project-orchestrator" && LIVE_AGENT_STATUSES.has(agent.status),
    )
  ) {
    return { cause: "orchestrator-down", taskId: null };
  }
  const byId = new Map(agents.map((agent) => [agent.id, agent]));
  const done = new Set(tasks.filter((task) => task.status === "done").map((task) => task.id));
  const open = tasks.filter((task) => OPEN_TASK_STATUSES.has(task.status));
  const down = (agentId: string | null) => {
    const agent = agentId === null ? undefined : byId.get(agentId);
    return agent === undefined || !LIVE_AGENT_STATUSES.has(agent.status);
  };
  for (const task of open) {
    if (task.status === "review") {
      const kinds = new Set(reviewKinds(task.id));
      if (!kinds.has("correctness") || !kinds.has("intent")) {
        return { cause: "no-review", taskId: task.id };
      }
    }
    if (task.status === "blocked") return { cause: "blocked", taskId: task.id };
    if (task.status === "running") {
      return {
        cause: down(task.assigneeAgentSessionId) ? "assignee-down" : "assignee-idle",
        taskId: task.id,
      };
    }
  }
  for (const task of open) {
    if (task.status !== "ready" && task.status !== "pending") continue;
    if (!task.dependsOn.every((dependency) => done.has(dependency))) continue;
    if (task.assigneeAgentSessionId === null) return { cause: "unassigned", taskId: task.id };
    return {
      cause: down(task.assigneeAgentSessionId) ? "assignee-down" : "assignee-idle",
      taskId: task.id,
    };
  }
  return { cause: "no-activity", taskId: open[0]?.id ?? null };
}
