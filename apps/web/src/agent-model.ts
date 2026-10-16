import type {
  AgentEvent,
  AgentSession,
  AgentTask,
  Handoff,
  IntentContract,
  ProjectStall,
  SharedProcess,
} from "@naru/contracts/naru-agent/v1";
import { approvalKindLabel, handoffKindLabel, roleName } from "./agent-labels";
import { taskLevels } from "./agent-task-graph";
import type { AgentBoard, AgentBoardProject, AgentJob, AgentPendingApproval } from "./api";
import { awaitingCompletion } from "./jobs-model";

/**
 * View model for the agent screens (AP-D022): names and colors for agents, what waits for the
 * person, task states, the task graph layout and the activity timeline. Everything is derived from
 * the board and the event log; nothing here is estimated or invented.
 */

/** Events the agent screens load at once; "today" can reach past them on a busy day. */
export const EVENT_FIRST_PAGE = 500;

export type Tone = "accent" | "blue" | "violet" | "green" | "red" | "amber" | "subtle";

/** Avatar colors; orchestrators wear the accent so the conductor is easy to find. */
const AGENT_COLORS = ["#83b3d6", "#b49cf0", "#6fc7c0", "#e59ac0", "#b6d97a", "#e8c36b"] as const;
const ORCHESTRATOR_COLOR = "#f28a55";

export interface AgentIdentity {
  readonly name: string;
  /** One character for the avatar. */
  readonly glyph: string;
  readonly color: string;
}

/** Every agent on the board, project agents first, each with its project id. */
export function boardAgents(board: AgentBoard): AgentSession[] {
  return [...board.projects.flatMap((project) => project.agents), ...board.globalAgents];
}

/**
 * The board's agents and the cleaned-up ones (AP-D033). Names are numbered over all of them, so
 * cleaning up "작업자 1" never renames "작업자 2".
 */
export function namedAgents(board: AgentBoard): AgentSession[] {
  return [...boardAgents(board), ...(board.retiredAgents ?? [])];
}

/** Agents and agents' processes that no longer run and nobody holds: what cleanup removes. */
export function cleanupCandidates(board: AgentBoard): {
  readonly agents: AgentSession[];
  readonly processes: SharedProcess[];
} {
  return {
    agents: boardAgents(board).filter(
      (agent) =>
        (agent.status === "stopped" || agent.status === "failed" || agent.status === "unknown") &&
        agent.humanHoldSince === null,
    ),
    processes: board.projects
      .flatMap((project) => project.processes)
      .filter(
        (process) =>
          (process.status === "exited" ||
            process.status === "failed" ||
            process.status === "stopped" ||
            process.status === "unknown") &&
          process.humanHoldSince === null,
      ),
  };
}

export function agentIdentity(
  agent: AgentSession,
  agents: readonly AgentSession[],
  projectName: (projectId: string | null) => string,
): AgentIdentity {
  if (agent.role === "main-orchestrator") {
    return { name: "메인 오케스트레이터", glyph: "◆", color: ORCHESTRATOR_COLOR };
  }
  if (agent.role === "project-orchestrator") {
    // A project should have one; when it has more (AP-D037), numbers tell them apart.
    const peers = agents
      .filter(
        (peer) => peer.projectId === agent.projectId && peer.role === agent.role && !peer.retiredAt,
      )
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
      );
    const index = peers.findIndex((peer) => peer.id === agent.id);
    const suffix = peers.length > 1 && index >= 0 ? ` ${index + 1}` : "";
    return {
      name: `${projectName(agent.projectId)} 오케스트레이터${suffix}`,
      glyph: "◆",
      color: ORCHESTRATOR_COLOR,
    };
  }
  // Numbered by creation within the project and role, so a name never changes later.
  const peers = agents
    .filter((peer) => peer.projectId === agent.projectId && peer.role === agent.role)
    .sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
  const ordinal = Math.max(1, peers.findIndex((peer) => peer.id === agent.id) + 1);
  return {
    name: `${roleName(agent.role)} ${ordinal}`,
    glyph: roleName(agent.role).slice(0, 1),
    color: AGENT_COLORS[hash(agent.id) % AGENT_COLORS.length]!,
  };
}

function hash(value: string): number {
  let result = 0;
  for (let index = 0; index < value.length; index += 1) {
    result = (result * 31 + value.charCodeAt(index)) >>> 0;
  }
  return result;
}

/** How an agent shows in lists: who waits for me first, then who works, then the rest. */
export type Presence =
  "waiting" | "mine" | "working" | "starting" | "resting" | "stopped" | "failed";

export const PRESENCE_ORDER: readonly Presence[] = [
  "waiting",
  "mine",
  "working",
  "starting",
  "resting",
  "stopped",
  "failed",
];

/** The agent's runtime is up: a stopped, failed or unknown one must be launched again first. */
export function isLive(agent: AgentSession): boolean {
  return agent.status === "starting" || agent.status === "active" || agent.status === "idle";
}

export function presenceOf(agent: AgentSession, waiting: boolean): Presence {
  if (agent.status === "failed" || agent.status === "unknown") return "failed";
  if (agent.status === "stopped") return "stopped";
  if (waiting) return "waiting";
  if (agent.humanHoldSince !== null) return "mine";
  if (agent.status === "active") return "working";
  if (agent.status === "starting") return "starting";
  return "resting";
}

export function presenceLabel(presence: Presence): string {
  switch (presence) {
    case "waiting":
      return "나를 기다림";
    case "mine":
      return "내가 직접 대화 중";
    case "working":
      return "일하는 중";
    case "starting":
      return "시작하는 중";
    case "resting":
      return "쉬는 중";
    case "stopped":
      return "멈춤";
    case "failed":
      return "확인 필요";
  }
}

export function presenceTone(presence: Presence): Tone {
  switch (presence) {
    case "waiting":
      return "accent";
    case "mine":
      return "blue";
    case "working":
      return "green";
    case "starting":
      return "blue";
    case "failed":
      return "red";
    default:
      return "subtle";
  }
}

// What waits for the person ---------------------------------------------------------------------

export type InboxItem =
  | {
      readonly kind: "approval";
      readonly key: string;
      readonly projectId: string | null;
      readonly agent: AgentSession;
      readonly approval: AgentPendingApproval;
    }
  | {
      readonly kind: "handoff";
      readonly key: string;
      readonly projectId: string | null;
      readonly handoff: Handoff;
      readonly requester: AgentSession | undefined;
    }
  | {
      /** Open work that stands still after Naru woke the orchestrator (AP-D034). */
      readonly kind: "stall";
      readonly key: string;
      readonly projectId: string;
      readonly stall: ProjectStall;
      readonly task: AgentTask | undefined;
      readonly orchestrator: AgentSession | undefined;
    }
  | {
      readonly kind: "contract";
      readonly key: string;
      readonly projectId: string;
      readonly contract: IntentContract;
      readonly orchestrator: AgentSession | undefined;
    }
  | {
      /** Every task of a job is finished; the person completes it (AP-D036). */
      readonly kind: "job";
      readonly key: string;
      readonly projectId: string | null;
      readonly job: AgentJob;
    };

/**
 * Approvals first (an agent is stopped on them right now), then work that stands still, then
 * decisions oldest first, then intent contracts waiting for approval, then finished jobs to complete.
 */
export function inboxItems(board: AgentBoard, jobs: readonly AgentJob[] = []): InboxItem[] {
  const agents = boardAgents(board);
  const items: InboxItem[] = [];
  const approvals = [
    ...board.projects.flatMap((project) => project.pendingApprovals),
    ...board.globalPendingApprovals,
  ];
  for (const approval of approvals) {
    const agent = agents.find((candidate) => candidate.id === approval.agentSessionId);
    if (agent === undefined) continue;
    items.push({
      kind: "approval",
      key: `approval:${approval.agentSessionId}:${approval.requestId}`,
      projectId: agent.projectId,
      agent,
      approval,
    });
  }
  for (const project of board.projects) {
    const stall = project.stall;
    if (stall === undefined || stall === null) continue;
    items.push({
      kind: "stall",
      key: `stall:${project.projectId}:${stall.since}`,
      projectId: project.projectId,
      stall,
      task: project.tasks.find((task) => task.id === stall.taskId),
      orchestrator: projectOrchestrator(project),
    });
  }
  for (const handoff of [...board.openHandoffs].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const requester =
      handoff.requestedBy.kind === "agent"
        ? agents.find(
            (candidate) =>
              handoff.requestedBy.kind === "agent" &&
              candidate.id === handoff.requestedBy.agentSessionId,
          )
        : undefined;
    items.push({
      kind: "handoff",
      key: `handoff:${handoff.id}`,
      projectId: handoff.projectId,
      handoff,
      requester,
    });
  }
  for (const project of board.projects) {
    if (project.pendingIntentContract === null) continue;
    items.push({
      kind: "contract",
      key: `contract:${project.pendingIntentContract.id}`,
      projectId: project.projectId,
      contract: project.pendingIntentContract,
      orchestrator: projectOrchestrator(project),
    });
  }
  for (const job of jobs) {
    if (!awaitingCompletion(job)) continue;
    items.push({
      kind: "job",
      key: `job:${job.goal.id}`,
      projectId: job.goal.scope.kind === "global" ? null : job.goal.scope.projectId,
      job,
    });
  }
  return items;
}

/**
 * The orchestrator to show for a project. A project should have one (AP-D037); when an older one came
 * back next to a newer one, the one working now, else the one active most recently.
 */
export function projectOrchestrator(
  project: Pick<AgentBoardProject, "agents" | "working">,
): AgentSession | undefined {
  const orchestrators = project.agents.filter((agent) => agent.role === "project-orchestrator");
  if (orchestrators.length < 2) return orchestrators[0];
  const working = new Set((project.working ?? []).map((entry) => entry.agentSessionId));
  return (
    orchestrators.find((agent) => working.has(agent.id)) ??
    [...orchestrators].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]
  );
}

/** A handoff kind as a person reads it on a card ("결정 필요", "직접 확인 부탁", …). */
export function askKindLabel(kind: string): string {
  switch (kind) {
    case "manual-test":
      return "직접 확인 부탁";
    case "terminal-control":
      return "터미널 입력 부탁";
    case "product-decision":
      return "결정 필요";
    case "design-deviation":
    case "security-or-external":
      return handoffKindLabel(kind);
    default:
      return "질문";
  }
}

/** The short label at the top of an Inbox card. */
export function inboxKindLabel(item: InboxItem): string {
  switch (item.kind) {
    case "approval":
      return `${approvalKindLabel(item.approval.kind)} 승인`;
    case "contract":
      return "의도 계약 승인";
    case "handoff":
      return askKindLabel(item.handoff.kind);
    case "stall":
      return "진행 멈춤";
    case "job":
      return "완료 확인";
  }
}

/** Agents that wait for the person: an approval, or a handoff they asked for. */
export function waitingAgentIds(items: readonly InboxItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    if (item.kind === "approval") ids.add(item.agent.id);
    if (item.kind === "handoff" && item.requester !== undefined) ids.add(item.requester.id);
  }
  return ids;
}

// Tasks ------------------------------------------------------------------------------------------

export type TaskStateKey =
  | "done"
  | "running"
  | "review"
  | "waiting"
  | "blocked"
  | "failed"
  | "ready"
  | "pending"
  | "cancelled";

export interface TaskState {
  readonly key: TaskStateKey;
  readonly label: string;
  readonly tone: Tone;
}

/** What one task waits for from the person, if anything. */
export function taskWaitingFor(
  task: AgentTask,
  project: Pick<AgentBoardProject, "pendingApprovals">,
  handoffs: readonly Handoff[],
): "approval" | "decision" | "check" | null {
  const handoff = handoffs.find((candidate) => candidate.payload.blockingTaskIds.includes(task.id));
  if (handoff !== undefined) {
    return handoff.kind === "manual-test" || handoff.kind === "terminal-control"
      ? "check"
      : "decision";
  }
  const assignee = task.assigneeAgentSessionId;
  if (
    assignee !== null &&
    (task.status === "running" || task.status === "review") &&
    project.pendingApprovals.some((approval) => approval.agentSessionId === assignee)
  ) {
    return "approval";
  }
  return null;
}

export function taskState(
  task: AgentTask,
  waitingFor: "approval" | "decision" | "check" | null,
): TaskState {
  if (waitingFor !== null && task.status !== "done" && task.status !== "cancelled") {
    const what = waitingFor === "approval" ? "승인" : waitingFor === "decision" ? "결정" : "확인";
    return { key: "waiting", label: `나를 기다림 · ${what}`, tone: "accent" };
  }
  switch (task.status) {
    case "done":
      return { key: "done", label: "완료", tone: "green" };
    case "running":
      return { key: "running", label: "진행 중", tone: "blue" };
    case "review":
      return { key: "review", label: "리뷰 중", tone: "violet" };
    case "blocked":
      return { key: "blocked", label: "막힘", tone: "amber" };
    case "failed":
      return { key: "failed", label: "실패", tone: "red" };
    case "ready":
      return { key: "ready", label: "시작 가능", tone: "subtle" };
    case "pending":
      return { key: "pending", label: "대기", tone: "subtle" };
    case "cancelled":
      return { key: "cancelled", label: "취소됨", tone: "subtle" };
  }
}

/** Tasks still counted toward a plan: cancelled ones are left out of progress. */
export function taskProgress(tasks: readonly AgentTask[]): {
  readonly done: number;
  readonly total: number;
  readonly active: number;
} {
  const counted = tasks.filter((task) => task.status !== "cancelled");
  return {
    done: counted.filter((task) => task.status === "done").length,
    total: counted.length,
    active: counted.filter((task) => task.status === "running" || task.status === "review").length,
  };
}

// Task graph -------------------------------------------------------------------------------------

export interface GraphNode {
  readonly task: AgentTask;
  readonly level: number;
  readonly x: number;
  readonly y: number;
}

export type EdgeKind = "done" | "active" | "wait";

export interface GraphEdge {
  readonly key: string;
  readonly kind: EdgeKind;
  readonly path: string;
  /** Where the edge enters its task, for the arrival dot. */
  readonly end: { readonly x: number; readonly y: number };
}

export interface GraphLayout {
  readonly nodes: GraphNode[];
  readonly edges: GraphEdge[];
  readonly levels: number;
  readonly width: number;
  readonly height: number;
}

export interface GraphMetrics {
  readonly nodeWidth: number;
  readonly nodeHeight: number;
  readonly columnGap: number;
  readonly rowGap: number;
}

/**
 * Columns by dependency depth, rows ordered by where their dependencies sit (one barycenter pass,
 * enough to keep small plans uncrossed), each column centred on the tallest one.
 */
export function layoutGraph(tasks: readonly AgentTask[], metrics: GraphMetrics): GraphLayout {
  const levels = taskLevels(tasks);
  const row = new Map<string, number>();
  const ordered = levels.map((level, index) => {
    if (index === 0) {
      level.forEach((task, position) => row.set(task.id, position));
      return level;
    }
    const weight = (task: AgentTask): number => {
      const placed = task.dependsOn
        .map((id) => row.get(id))
        .filter((value): value is number => value !== undefined);
      return placed.length === 0
        ? Number.MAX_SAFE_INTEGER
        : placed.reduce((sum, value) => sum + value, 0) / placed.length;
    };
    const sorted = [...level].sort((left, right) => weight(left) - weight(right));
    sorted.forEach((task, position) => row.set(task.id, position));
    return sorted;
  });
  const tallest = Math.max(1, ...ordered.map((level) => level.length));
  const pitchY = metrics.nodeHeight + metrics.rowGap;
  const pitchX = metrics.nodeWidth + metrics.columnGap;
  const nodes: GraphNode[] = [];
  ordered.forEach((level, levelIndex) => {
    const offset = ((tallest - level.length) * pitchY) / 2;
    level.forEach((task, position) => {
      nodes.push({
        task,
        level: levelIndex,
        x: levelIndex * pitchX,
        y: offset + position * pitchY,
      });
    });
  });
  const byId = new Map(nodes.map((node) => [node.task.id, node]));
  const edges: GraphEdge[] = [];
  for (const node of nodes) {
    for (const dependencyId of node.task.dependsOn) {
      const source = byId.get(dependencyId);
      if (source === undefined) continue;
      const x1 = source.x + metrics.nodeWidth;
      const y1 = source.y + metrics.nodeHeight / 2;
      const x2 = node.x;
      const y2 = node.y + metrics.nodeHeight / 2;
      const bend = Math.max(24, (x2 - x1) * 0.5);
      edges.push({
        key: `${dependencyId}->${node.task.id}`,
        kind: edgeKind(source.task, node.task),
        path: `M${x1} ${y1} C${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`,
        end: { x: x2, y: y2 },
      });
    }
  }
  return {
    nodes,
    edges,
    levels: ordered.length,
    width: Math.max(metrics.nodeWidth, ordered.length * pitchX - metrics.columnGap),
    height: Math.max(metrics.nodeHeight, tallest * pitchY - metrics.rowGap),
  };
}

function edgeKind(source: AgentTask, target: AgentTask): EdgeKind {
  if (target.status === "running" || target.status === "review") return "active";
  if (source.status === "done") return "done";
  return "wait";
}

// Timeline ---------------------------------------------------------------------------------------

export interface TimelineSegment {
  readonly start: number;
  readonly end: number;
  /** `work`: the agent's runtime was in a turn. `mine`: the person held the agent. */
  readonly kind: "work" | "mine";
  readonly label: string | null;
}

export interface TimelineMark {
  readonly at: number;
  /** `ask`: the agent asked the person something. `merge`: a merge commit was recorded. */
  readonly kind: "ask" | "merge";
}

export interface TimelineRow {
  readonly agent: AgentSession;
  readonly segments: TimelineSegment[];
  readonly marks: TimelineMark[];
  readonly lastActivity: number;
}

const WORK_END = new Set<unknown>(["idle", "stopped", "failed", "unknown"]);

/**
 * Who worked when, from the event log: an agent's runtime turns (`agent_session.updated` to active
 * and back), the person's holds, the questions agents asked and the merges recorded. Intervals still
 * open run to `now`; one that closes before the oldest loaded event starts at that event.
 */
export function timelineRows(
  events: readonly AgentEvent[],
  agents: readonly AgentSession[],
  tasks: readonly AgentTask[],
  range: { readonly start: number; readonly end: number },
): TimelineRow[] {
  const first = events.length === 0 ? range.end : Date.parse(events[0]!.createdAt);
  const rows = new Map<
    string,
    {
      segments: { start: number; end: number; kind: "work" | "mine" }[];
      marks: TimelineMark[];
      work: number | null;
      mine: number | null;
      seen: boolean;
    }
  >();
  const rowOf = (agentSessionId: string) => {
    let row = rows.get(agentSessionId);
    if (row === undefined) {
      row = { segments: [], marks: [], work: null, mine: null, seen: false };
      rows.set(agentSessionId, row);
    }
    return row;
  };
  for (const event of events) {
    const at = Date.parse(event.createdAt);
    if (Number.isNaN(at)) continue;
    switch (event.type) {
      case "agent_session.updated": {
        const row = rowOf(event.subjectId);
        const status = event.data.status;
        if (status === "active") {
          row.work ??= at;
        } else if (WORK_END.has(status)) {
          if (row.work !== null) row.segments.push({ start: row.work, end: at, kind: "work" });
          else if (!row.seen && status === "idle") {
            row.segments.push({ start: first, end: at, kind: "work" });
          }
          row.work = null;
        }
        row.seen = true;
        break;
      }
      case "agent_session.hold_started":
        rowOf(event.subjectId).mine ??= at;
        break;
      case "agent_session.hold_released": {
        const row = rowOf(event.subjectId);
        row.segments.push({ start: row.mine ?? first, end: at, kind: "mine" });
        row.mine = null;
        break;
      }
      case "handoff.requested":
        if (event.actor.kind === "agent") {
          rowOf(event.actor.agentSessionId).marks.push({ at, kind: "ask" });
        }
        break;
      case "artifact.published":
        if (event.data.kind === "commit" && event.actor.kind === "agent") {
          rowOf(event.actor.agentSessionId).marks.push({ at, kind: "merge" });
        }
        break;
      default:
        break;
    }
  }
  const result: TimelineRow[] = [];
  for (const agent of agents) {
    const row = rows.get(agent.id);
    const segments = [...(row?.segments ?? [])];
    if (row?.work != null) segments.push({ start: row.work, end: range.end, kind: "work" });
    else if (row === undefined && agent.status === "active") {
      segments.push({ start: first, end: range.end, kind: "work" });
    }
    if (row?.mine != null) segments.push({ start: row.mine, end: range.end, kind: "mine" });
    else if (agent.humanHoldSince !== null) {
      // Held since before the loaded events.
      const since = Date.parse(agent.humanHoldSince);
      if (!Number.isNaN(since)) {
        segments.push({ start: Math.max(since, first), end: range.end, kind: "mine" });
      }
    }
    const visible = segments
      .filter((segment) => segment.end > range.start && segment.start < range.end)
      .map((segment) => ({
        start: Math.max(segment.start, range.start),
        end: Math.min(segment.end, range.end),
        kind: segment.kind,
        label: segment.kind === "mine" ? "내가 직접" : workLabel(agent, tasks, segment),
      }))
      .sort((left, right) => left.start - right.start);
    const marks = (row?.marks ?? []).filter(
      (mark) => mark.at >= range.start && mark.at <= range.end,
    );
    if (visible.length === 0 && marks.length === 0) continue;
    result.push({
      agent,
      segments: visible,
      marks,
      lastActivity: Math.max(
        ...visible.map((segment) => segment.end),
        ...marks.map((mark) => mark.at),
      ),
    });
  }
  return result.sort((left, right) => right.lastActivity - left.lastActivity);
}

/** The task an agent had while it worked, when there is exactly one candidate. */
function workLabel(
  agent: AgentSession,
  tasks: readonly AgentTask[],
  segment: { readonly start: number; readonly end: number },
): string | null {
  const candidates = tasks.filter((task) => {
    if (task.assigneeAgentSessionId !== agent.id) return false;
    const created = Date.parse(task.createdAt);
    const updated = Date.parse(task.updatedAt);
    const finished =
      task.status === "done" || task.status === "cancelled" || task.status === "failed";
    return created <= segment.end && (!finished || updated >= segment.start);
  });
  return candidates.length === 1 ? candidates[0]!.title : null;
}

// Time -------------------------------------------------------------------------------------------

/** "방금", "12분", "3시간", "10. 14." — compact relative time for lists. */
export function ago(timestamp: string | number, now: number): string {
  const at = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (Number.isNaN(at)) return "";
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  if (seconds < 60) return "방금";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}분`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}시간`;
  return new Date(at).toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

/** "10:42" in the viewer's time zone. */
export function clock(timestamp: string | number): string {
  const at = typeof timestamp === "number" ? timestamp : Date.parse(timestamp);
  if (Number.isNaN(at)) return "";
  return new Date(at).toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function startOfDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

// Activity line --------------------------------------------------------------------------------

/** What an agent is doing, in one line for lists ("승인 기다림 · pnpm test", "세션 API 진행 중"). */
export function agentActivity(
  agent: AgentSession,
  presence: Presence,
  inbox: readonly InboxItem[],
  tasks: readonly AgentTask[],
): string {
  const assigned = tasks
    .filter((task) => task.assigneeAgentSessionId === agent.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const orchestrator = agent.role === "main-orchestrator" || agent.role === "project-orchestrator";
  switch (presence) {
    case "waiting": {
      const approval = inbox.find((item) => item.kind === "approval" && item.agent.id === agent.id);
      if (approval?.kind === "approval") {
        const what = `${approvalKindLabel(approval.approval.kind)} 승인 기다림`;
        return approval.approval.summary === undefined
          ? what
          : `${what} · ${approval.approval.summary}`;
      }
      const handoff = inbox.find(
        (item) => item.kind === "handoff" && item.requester?.id === agent.id,
      );
      return handoff === undefined ? "나를 기다림" : `${inboxKindLabel(handoff)} 기다림`;
    }
    case "mine":
      return "내가 직접 대화 중";
    case "working": {
      if (orchestrator) return "계획하고 맡기는 중";
      const running = assigned.find(
        (task) => task.status === "running" || task.status === "review",
      );
      return running === undefined ? "답하는 중…" : `${running.title} 하는 중`;
    }
    case "starting":
      return "시작하는 중";
    case "resting": {
      if (orchestrator) {
        const open = tasks.filter(
          (task) =>
            task.projectId === agent.projectId &&
            task.status !== "done" &&
            task.status !== "cancelled",
        ).length;
        return open === 0 ? "쉬는 중" : `쉬는 중 · 남은 작업 ${open}개`;
      }
      const latest = assigned[0];
      if (latest === undefined) return "쉬는 중";
      return latest.status === "done"
        ? `쉬는 중 · ${latest.title} 완료`
        : `쉬는 중 · ${latest.title}`;
    }
    case "stopped":
      return "멈춤";
    case "failed":
      return "확인이 필요합니다";
  }
}
