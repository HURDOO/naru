import type { AgentSession } from "@naru/contracts/naru-agent/v1";
import { useState } from "react";
import { useAgentApp } from "./agent-context";
import { clock, presenceLabel, type Tone } from "./agent-model";
import { Avatar, Icon, Pill } from "./agent-ui";
import type { AgentJob, AgentJobTask, AgentWorking } from "./api";
import {
  awaitingCompletion,
  elapsedLabel,
  JOB_STAGES,
  jobCompleted,
  jobFinishedAt,
  jobProgress,
  jobStage,
  orderedTasks,
  spanLabel,
  stageStates,
  stallAge,
  stallText,
  type TaskNow,
  taskNow,
  taskStep,
  taskTrack,
} from "./jobs-model";

/**
 * "맡긴 일" (AP-D034): each goal the person handed over, where it is in the big picture, how it was
 * divided and who does what at which step now. A finished goal waits for the person to complete it;
 * completed goals fold away and can be reopened for another round (AP-D036).
 */
export function JobCards({
  compact = false,
}: {
  readonly compact?: boolean;
}): React.JSX.Element | null {
  const app = useAgentApp();
  const open = app.jobs.filter((job) => !jobCompleted(job));
  const finished = app.jobs.filter((job) => jobCompleted(job));
  if (app.jobs.length === 0) return null;
  return (
    <section className="ag-jobs" aria-labelledby="ag-jobs-title">
      <header className="ag-section-head">
        <h2 id="ag-jobs-title">맡긴 일</h2>
        <span className="ag-muted">
          진행 중 {open.length}
          {finished.length > 0 ? ` · 끝남 ${finished.length}` : ""}
        </span>
      </header>
      {open.length === 0 ? (
        <p className="ag-lane-empty">지금 진행 중인 맡긴 일이 없습니다.</p>
      ) : (
        <ul className="ag-job-list">
          {open.map((job) => (
            <li key={job.goal.id}>
              <JobCard job={job} compact={compact} />
            </li>
          ))}
        </ul>
      )}
      {finished.length > 0 && (
        <ul className="ag-job-list" aria-label="끝난 일">
          {finished.map((job) => (
            <li key={job.goal.id}>
              <details className="ag-job-done">
                <summary>
                  <Icon name="check" size={14} />
                  <span className="ag-job-done-goal">{goalText(job)}</span>
                  <span className="ag-muted">
                    {jobProgress(job).total}개 완료 · {clock(job.goal.createdAt)} 맡김 ·{" "}
                    {spanLabel(
                      Date.parse(jobFinishedAt(job) ?? job.goal.createdAt) -
                        Date.parse(job.goal.createdAt),
                    )}{" "}
                    걸림
                    {(job.round ?? 1) > 1 ? ` · ${job.round}라운드` : ""}
                  </span>
                </summary>
                <JobCard job={job} compact={compact} />
              </details>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function goalText(job: AgentJob): string {
  return job.goal.verbatim ?? "잊은 지시";
}

function JobCard({
  job,
  compact,
}: {
  readonly job: AgentJob;
  readonly compact: boolean;
}): React.JSX.Element {
  const app = useAgentApp();
  const [all, setAll] = useState(false);
  const stage = jobStage(job);
  const completed = jobCompleted(job);
  const awaiting = awaitingCompletion(job);
  const states = stageStates(stage, completed);
  const progress = jobProgress(job);
  const ordered = orderedTasks(job);
  const numbers = new Map(ordered.map((entry, index) => [entry.task.id, index + 1]));
  const doneTaskIds = new Set(
    ordered.filter((entry) => entry.task.status === "done").map((entry) => entry.task.id),
  );
  const projects = app.board.projects.filter((project) =>
    job.projectIds.includes(project.projectId),
  );
  const orchestrators = projects
    .map((project) => project.agents.find((agent) => agent.role === "project-orchestrator"))
    .filter((agent): agent is AgentSession => agent !== undefined);
  const main = app.board.globalAgents.find((agent) => agent.role === "main-orchestrator");
  const managers = orchestrators.length > 0 ? orchestrators : main === undefined ? [] : [main];
  const stalled = projects.filter(
    (project) => project.stall !== undefined && project.stall !== null,
  );
  const nameOf = (agentSessionId: string) => {
    const agent = app.agentById(agentSessionId);
    return agent === undefined ? "알 수 없는 에이전트" : app.identity(agent).name;
  };
  const nows = new Map<string, TaskNow>(
    ordered.map((entry) => [
      entry.task.id,
      taskNow(entry, {
        working: app.working,
        reviewersWorking: reviewersWorking(app, entry.task.projectId),
        nameOf,
        numberOf: (taskId) => numbers.get(taskId) ?? null,
        doneTaskIds,
        now: app.now,
      }),
    ]),
  );
  const current = (entry: AgentJobTask) =>
    nows.get(entry.task.id)?.live === true ||
    entry.task.status === "running" ||
    entry.task.status === "review" ||
    entry.task.status === "blocked";
  const finishedAt = jobFinishedAt(job);
  const shown = compact && !all ? ordered.filter(current) : ordered;
  const multiProject = job.projectIds.length > 1;
  return (
    <article className="ag-job" data-stage={stage} data-stalled={stalled.length > 0}>
      <header className="ag-job-head">
        <h3 className="ag-job-goal">{goalText(job)}</h3>
        {(job.followUps ?? []).length > 0 && (
          <ol className="ag-job-rounds" aria-label="이어서 맡긴 것">
            {(job.followUps ?? []).map((followUp, index) => (
              <li key={followUp.id}>
                <span className="ag-job-round-tag">{index + 2}라운드</span>
                <span className="ag-job-round-text">{followUp.verbatim ?? "잊은 지시"}</span>
                <span className="ag-muted">{clock(followUp.createdAt)}</span>
              </li>
            ))}
          </ol>
        )}
        <p className="ag-job-meta">
          <span>
            {clock(job.goal.createdAt)} 맡김 ·{" "}
            {finishedAt === null
              ? elapsedLabel(job.goal.createdAt, app.now)
              : `${spanLabel(Date.parse(finishedAt) - Date.parse(job.goal.createdAt))} 걸림`}
          </span>
          {managers.map((agent) => (
            <button
              key={agent.id}
              className="ag-agent-chip"
              type="button"
              onClick={() => app.openChat(agent.id)}
            >
              <Avatar identity={app.identity(agent)} size={18} presence={app.presence(agent)} />
              {app.identity(agent).name} · {presenceLabel(app.presence(agent))}
            </button>
          ))}
        </p>
      </header>
      <div className="ag-job-track">
        <ol className="ag-job-stages" aria-label="큰 그림">
          {JOB_STAGES.map((item) => (
            <li
              key={item.id}
              data-state={states[item.id]}
              aria-current={states[item.id] === "current" ? "step" : undefined}
            >
              <span className="ag-job-stage-dot" aria-hidden="true" />
              {item.label}
            </li>
          ))}
        </ol>
        <p className="ag-job-count">
          {progress.total === 0
            ? "오케스트레이터가 일을 나누는 중입니다"
            : awaiting
              ? `작업 ${progress.total}개 모두 끝남 · 완료 확인을 기다립니다`
              : `작업 ${progress.total}개 중 ${progress.done}개 완료`}
        </p>
      </div>
      {awaiting && (
        <div className="ag-job-complete" role="status">
          <Icon name="check" size={16} />
          <p>
            <strong>모든 작업이 끝났습니다.</strong> 확인하고 완료하면 이 일을 한 작업자와 리뷰어를
            정리합니다.
          </p>
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            onClick={() => app.openJob(job, "complete")}
          >
            완료하기
          </button>
        </div>
      )}
      {stalled.map((project) => (
        <StallBanner key={project.projectId} job={job} project={project} numbers={numbers} />
      ))}
      {ordered.length > 0 && (
        <div className="ag-job-tasks-wrap">
          <h4 className="ag-job-sub">나눈 일</h4>
          <ol className="ag-job-tasks">
            {shown.map((entry) => (
              <li key={entry.task.id}>
                <TaskRow
                  entry={entry}
                  number={numbers.get(entry.task.id) ?? 0}
                  now={nows.get(entry.task.id)!}
                  current={current(entry)}
                  project={multiProject ? app.projectName(entry.task.projectId) : null}
                />
              </li>
            ))}
          </ol>
          {compact && ordered.length > shown.length && (
            <button
              className="ag-link"
              type="button"
              aria-expanded={all}
              onClick={() => setAll(true)}
            >
              나눈 일 {ordered.length}개 모두 보기
            </button>
          )}
        </div>
      )}
      {typeof job.completedAt === "string" && (
        <footer className="ag-job-foot">
          <span className="ag-muted">
            {clock(job.completedAt)} 완료
            {(job.cleanedUpAgentSessionIds ?? []).length > 0
              ? ` · 에이전트 ${(job.cleanedUpAgentSessionIds ?? []).length}개 정리함`
              : ""}
          </span>
          <button className="ag-button" type="button" onClick={() => app.openJob(job, "reopen")}>
            다시 열기
          </button>
        </footer>
      )}
    </article>
  );
}

function reviewersWorking(app: ReturnType<typeof useAgentApp>, projectId: string): AgentWorking[] {
  const project = app.board.projects.find((candidate) => candidate.projectId === projectId);
  if (project === undefined) return [];
  return project.agents
    .filter((agent) => agent.role === "reviewer")
    .map((agent) => app.working.get(agent.id))
    .filter((working): working is AgentWorking => working !== undefined);
}

function stepTone(entry: AgentJobTask): Tone {
  const step = taskStep(entry);
  switch (step.stage) {
    case "work":
      return step.label === "대기" ? "subtle" : step.label === "막힘" ? "amber" : "blue";
    case "verify":
      return "violet";
    case "merge":
      return "blue";
    case "done":
      return "green";
    case "failed":
      return "red";
    case "cancelled":
      return "subtle";
  }
}

function TaskRow({
  entry,
  number,
  now,
  current,
  project,
}: {
  readonly entry: AgentJobTask;
  readonly number: number;
  readonly now: TaskNow;
  readonly current: boolean;
  /** The task's project, when the goal spans several. */
  readonly project: string | null;
}): React.JSX.Element {
  const app = useAgentApp();
  const { task } = entry;
  const step = taskStep(entry);
  const assignee = app.agentById(task.assigneeAgentSessionId);
  const nowAgent = app.agentById(now.agentSessionId);
  const finished = step.stage === "done" || step.stage === "cancelled";
  return (
    <button
      className="ag-job-task"
      type="button"
      data-current={current}
      data-stage={step.stage}
      onClick={() => app.openFlow(task.projectId, task.id)}
    >
      <span className="ag-job-num" aria-hidden="true">
        {step.stage === "done" ? <Icon name="check" size={12} strokeWidth={3} /> : number}
      </span>
      <span className="ag-job-task-main">
        <span className="ag-job-task-title">
          <span className="sr-only">{number}번 </span>
          {task.title}
        </span>
        <span className="ag-job-task-meta">
          {project !== null && <span>{project}</span>}
          <span>{assignee === undefined ? "맡은 에이전트 없음" : app.identity(assignee).name}</span>
          <span className="ag-job-steps">
            <span className="sr-only">{trackLabel(entry)}</span>
            {taskTrack(entry).map((item) => (
              <span key={item.label} data-state={item.state} aria-hidden="true">
                {item.label}
              </span>
            ))}
          </span>
        </span>
        {!finished && (
          <span className="ag-job-now" data-live={now.live}>
            <span className="ag-job-now-tag">지금</span>
            {nowAgent !== undefined && (
              <Avatar
                identity={app.identity(nowAgent)}
                size={16}
                presence={app.presence(nowAgent)}
              />
            )}
            <span className="ag-job-now-text">
              {now.who === null ? now.what : `${now.who} · ${now.what}`}
            </span>
          </span>
        )}
      </span>
      <Pill tone={stepTone(entry)}>{step.label}</Pill>
    </button>
  );
}

function trackLabel(entry: AgentJobTask): string {
  const word = { done: "끝남", current: "진행", todo: "전", failed: "실패" } as const;
  return taskTrack(entry)
    .map((item) => `${item.label} ${word[item.state]}`)
    .join(", ");
}

function StallBanner({
  job,
  project,
  numbers,
}: {
  readonly job: AgentJob;
  readonly project: ReturnType<typeof useAgentApp>["board"]["projects"][number];
  readonly numbers: ReadonlyMap<string, number>;
}): React.JSX.Element | null {
  const app = useAgentApp();
  const stall = project.stall;
  if (stall === undefined || stall === null) return null;
  const orchestrator = project.agents.find((agent) => agent.role === "project-orchestrator");
  const task = job.tasks.find((entry) => entry.task.id === stall.taskId)?.task;
  const number = task === undefined ? undefined : numbers.get(task.id);
  return (
    <div className="ag-job-stall" role="status">
      <Icon name="hand" size={16} />
      <p>
        <strong>
          {job.projectIds.length > 1 ? `${app.projectName(project.projectId)} · ` : ""}
          {stallAge(stall, app.now)}
        </strong>{" "}
        {stallText(stall.cause)}
        {task === undefined ? "" : ` · ${number === undefined ? "" : `${number}. `}${task.title}`}
      </p>
      <div className="ag-job-stall-actions">
        <button
          className="ag-button"
          data-variant="primary"
          type="button"
          disabled={!app.mutationAllowed}
          onClick={() =>
            void app.act("오케스트레이터에게 다시 확인시켰습니다.", () =>
              app.api.nudgeProject(project.projectId),
            )
          }
        >
          오케스트레이터에게 확인시키기
        </button>
        {orchestrator !== undefined && (
          <button className="ag-link" type="button" onClick={() => app.openChat(orchestrator.id)}>
            대화 보기
          </button>
        )}
      </div>
    </div>
  );
}
