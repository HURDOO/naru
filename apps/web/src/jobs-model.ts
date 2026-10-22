import type { ProjectStall, StallCause } from "@naru/contracts/naru-agent/v1";
import type { AgentJob, AgentJobTask, AgentWorking } from "./api";

/**
 * "맡긴 일" (AP-D034): where a goal the person handed over is in the big picture, how it was
 * divided and who is doing what at which step. Everything comes from Naru's records and the live
 * runtime; nothing is estimated.
 */

export type JobStageId = "handed" | "plan" | "work" | "verify" | "merge" | "done";
export type StageState = "done" | "current" | "todo";

export const JOB_STAGES: readonly { readonly id: JobStageId; readonly label: string }[] = [
  { id: "handed", label: "맡김" },
  { id: "plan", label: "계획" },
  { id: "work", label: "작업" },
  { id: "verify", label: "검증" },
  { id: "merge", label: "병합" },
  { id: "done", label: "완료" },
];

const ACTIVE = new Set(["pending", "ready", "running", "blocked"]);

/**
 * Where the whole goal is: the earliest step any of its open tasks is still at. A reopened job is
 * back at planning until a task moves for the new round (AP-D036). While an orchestrator that can
 * add the next task is in a turn (`deciding`), a job whose tasks are all done is still at planning,
 * not done (AP-D047).
 */
export function jobStage(job: AgentJob, deciding = false): JobStageId {
  const live = job.tasks.filter((entry) => entry.task.status !== "cancelled");
  if (live.length === 0) return "plan";
  if (live.every((entry) => entry.task.status === "done")) {
    const round = job.followUps?.at(-1)?.createdAt;
    const moved = round === undefined || live.some((entry) => entry.task.updatedAt > round);
    return moved && !deciding ? "done" : "plan";
  }
  if (live.some((entry) => ACTIVE.has(entry.task.status) || entry.task.status === "failed")) {
    return "work";
  }
  const reviewing = live.filter((entry) => entry.task.status === "review");
  return reviewing.every(reviewsPassed) ? "merge" : "verify";
}

/** The steps before the current one are done; 완료 is done only once the person completed it. */
export function stageStates(current: JobStageId, completed = true): Record<JobStageId, StageState> {
  const index = JOB_STAGES.findIndex((stage) => stage.id === current);
  return Object.fromEntries(
    JOB_STAGES.map((stage, position) => [
      stage.id,
      (current === "done" && completed) || position < index
        ? "done"
        : position === index
          ? "current"
          : "todo",
    ]),
  ) as Record<JobStageId, StageState>;
}

/** The person completed it (AP-D036); without completion records a finished job counts as done. */
export function jobCompleted(job: AgentJob): boolean {
  return job.completedAt === undefined ? jobStage(job) === "done" : job.completedAt !== null;
}

/**
 * Every task of the round is finished, no orchestrator is deciding a next one (AP-D047), and the
 * job waits for the person to complete it.
 */
export function awaitingCompletion(job: AgentJob, deciding = false): boolean {
  return job.completedAt === null && jobStage(job, deciding) === "done";
}

/** Every task of the round is finished while an orchestrator may still add the next (AP-D047). */
export function decidingNext(job: AgentJob, deciding: boolean): boolean {
  return deciding && job.completedAt === null && jobStage(job) === "done";
}

export function jobProgress(job: AgentJob): { readonly done: number; readonly total: number } {
  const live = job.tasks.filter((entry) => entry.task.status !== "cancelled");
  return {
    done: live.filter((entry) => entry.task.status === "done").length,
    total: live.length,
  };
}

/** Tasks in the order they can run: dependency levels first, then creation. */
export function orderedTasks(job: AgentJob): AgentJobTask[] {
  const byId = new Map(job.tasks.map((entry) => [entry.task.id, entry]));
  const level = new Map<string, number>();
  const levelOf = (id: string, seen: Set<string>): number => {
    const known = level.get(id);
    if (known !== undefined) return known;
    if (seen.has(id)) return 0;
    seen.add(id);
    const entry = byId.get(id);
    const value =
      entry === undefined
        ? 0
        : Math.max(
            0,
            ...entry.task.dependsOn
              .filter((dependency) => byId.has(dependency))
              .map((dependency) => levelOf(dependency, seen) + 1),
          );
    level.set(id, value);
    return value;
  };
  return [...job.tasks].sort(
    (left, right) =>
      levelOf(left.task.id, new Set()) - levelOf(right.task.id, new Set()) ||
      left.task.createdAt.localeCompare(right.task.createdAt),
  );
}

/** One task's own step: 작업, 검증 or 병합 (or finished). */
export type TaskStep =
  | { readonly stage: "work"; readonly label: "대기" | "작업 중" | "막힘" }
  | { readonly stage: "verify"; readonly label: "검증 중" }
  | { readonly stage: "merge"; readonly label: "병합 대기" }
  | { readonly stage: "done"; readonly label: "완료" }
  | { readonly stage: "failed"; readonly label: "실패" }
  | { readonly stage: "cancelled"; readonly label: "취소" };

export function taskStep(entry: AgentJobTask): TaskStep {
  switch (entry.task.status) {
    case "pending":
    case "ready":
      return { stage: "work", label: "대기" };
    case "running":
      return { stage: "work", label: "작업 중" };
    case "blocked":
      return { stage: "work", label: "막힘" };
    case "review":
      return reviewsPassed(entry)
        ? { stage: "merge", label: "병합 대기" }
        : { stage: "verify", label: "검증 중" };
    case "done":
      return { stage: "done", label: "완료" };
    case "failed":
      return { stage: "failed", label: "실패" };
    case "cancelled":
      return { stage: "cancelled", label: "취소" };
  }
}

/** Correctness and intent both passed (A11). */
export function reviewsPassed(entry: AgentJobTask): boolean {
  return entry.reviews.correctness?.verdict === "pass" && entry.reviews.intent?.verdict === "pass";
}

/** A task's own 작업 · 검증 · 병합 track. */
export function taskTrack(entry: AgentJobTask): readonly {
  readonly label: "작업" | "검증" | "병합";
  readonly state: StageState | "failed";
}[] {
  const step = taskStep(entry).stage;
  // How far along the three steps the task is; a waiting or cancelled task has not started any.
  const waiting = entry.task.status === "pending" || entry.task.status === "ready";
  const at = waiting
    ? -1
    : { work: 0, verify: 1, merge: 2, done: 3, failed: 0, cancelled: -1 }[step];
  return (["작업", "검증", "병합"] as const).map((label, position) => ({
    label,
    state:
      position < at
        ? "done"
        : position === at
          ? step === "failed"
            ? "failed"
            : "current"
          : "todo",
  }));
}

export function reviewCount(entry: AgentJobTask): number {
  return (entry.reviews.correctness ? 1 : 0) + (entry.reviews.intent ? 1 : 0);
}

/** Who acts on a task now and what they do, for its "지금" line. */
export interface TaskNow {
  readonly agentSessionId: string | null;
  readonly who: string | null;
  readonly what: string;
  /** A turn is running now (live from the runtime). */
  readonly live: boolean;
}

export function taskNow(
  entry: AgentJobTask,
  context: {
    readonly working: ReadonlyMap<string, AgentWorking>;
    /** Reviewers of the task's project whose turn runs now. */
    readonly reviewersWorking: readonly AgentWorking[];
    readonly nameOf: (agentSessionId: string) => string;
    /** The step number of a task in this job. */
    readonly numberOf: (taskId: string) => number | null;
    readonly doneTaskIds: ReadonlySet<string>;
    readonly now: number;
  },
): TaskNow {
  const { task } = entry;
  const assignee = task.assigneeAgentSessionId;
  const live = (working: AgentWorking): TaskNow => ({
    agentSessionId: working.agentSessionId,
    who: context.nameOf(working.agentSessionId),
    what: activityLine(working, context.now),
    live: true,
  });
  const step = taskStep(entry);
  if (step.stage === "work") {
    const working = assignee === null ? undefined : context.working.get(assignee);
    if (working !== undefined) return live(working);
    if (task.status === "blocked")
      return { agentSessionId: null, who: null, what: "막혀 있습니다", live: false };
    const waitingFor = task.dependsOn
      .filter((dependency) => !context.doneTaskIds.has(dependency))
      .map(context.numberOf)
      .filter((number): number is number => number !== null)
      .sort((left, right) => left - right);
    if (waitingFor.length > 0) {
      return {
        agentSessionId: null,
        who: null,
        what: `${waitingFor.join("·")}번이 끝나면 시작합니다`,
        live: false,
      };
    }
    if (assignee === null)
      return {
        agentSessionId: null,
        who: null,
        what: "아직 맡은 에이전트가 없습니다",
        live: false,
      };
    const summary = entry.latestRun?.status === "running" ? entry.latestRun.summary : null;
    return {
      agentSessionId: assignee,
      who: context.nameOf(assignee),
      what:
        summary !== null && summary !== ""
          ? `진행: ${oneLine(summary)}`
          : task.status === "running"
            ? "작업 중"
            : "시작 전",
      live: false,
    };
  }
  if (step.stage === "verify") {
    const reviewer = context.reviewersWorking[0];
    if (reviewer !== undefined) return live(reviewer);
    return {
      agentSessionId: null,
      who: null,
      what: `리뷰 ${reviewCount(entry)}/2 · 리뷰를 기다립니다`,
      live: false,
    };
  }
  if (step.stage === "merge")
    return { agentSessionId: null, who: null, what: "리뷰 통과 · 병합을 기다립니다", live: false };
  if (step.stage === "done") return { agentSessionId: null, who: null, what: "완료", live: false };
  return { agentSessionId: null, who: null, what: step.label, live: false };
}

/** "Edit · src/a.md · 12초째" from a live turn. */
export function activityLine(working: AgentWorking, now: number): string {
  const activity = working.activity;
  if (activity === null) {
    return working.turnStartedAt === null
      ? "일하는 중"
      : `일하는 중 · ${elapsedLabel(working.turnStartedAt, now)}`;
  }
  const parts = [activity.tool, activity.target, elapsedLabel(activity.since, now)].filter(
    (part): part is string => part !== null && part !== "",
  );
  return parts.join(" · ");
}

/** "12초째", "52분째", "1시간 12분째". */
export function elapsedLabel(fromIso: string, now: number): string {
  const seconds = Math.max(0, Math.floor((now - Date.parse(fromIso)) / 1000));
  return seconds < 5 ? "방금" : `${spanLabel(seconds * 1000)}째`;
}

/** "40초", "52분", "1시간 12분". */
export function spanLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}초`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}시간` : `${hours}시간 ${minutes % 60}분`;
}

/** When the last of a finished job's tasks finished, or null while it is open. */
export function jobFinishedAt(job: AgentJob, deciding = false): string | null {
  if (jobStage(job, deciding) !== "done") return null;
  return job.tasks.reduce(
    (latest, entry) => (entry.task.updatedAt > latest ? entry.task.updatedAt : latest),
    job.goal.createdAt,
  );
}

/** How long stalled work has stood still: "14분째 그대로", counting up from the last progress. */
export function stallAge(stall: ProjectStall, now: number): string {
  const since = stall.lastProgressAt === null ? null : elapsedLabel(stall.lastProgressAt, now);
  return `${since ?? `${stall.minutes}분째`} 그대로`;
}

/** A stall as the person reads it (AP-D034). */
export function stallText(cause: StallCause): string {
  switch (cause) {
    case "orchestrator-down":
      return "이 프로젝트의 오케스트레이터가 꺼져 있습니다";
    case "no-review":
      return "검증 단계인데 리뷰가 시작되지 않았습니다";
    case "assignee-down":
      return "맡은 에이전트가 꺼져 있습니다";
    case "unassigned":
      return "아무도 맡지 않았습니다";
    case "assignee-idle":
      return "맡은 에이전트가 움직이지 않습니다";
    case "blocked":
      return "막혀 있습니다";
    case "no-activity":
      return "진행이 없습니다";
  }
}

function oneLine(text: string): string {
  const line = text.replace(/\s+/gu, " ").trim();
  return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}
