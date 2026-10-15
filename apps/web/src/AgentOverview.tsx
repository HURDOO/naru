import type {
  AgentOverview,
  AgentSession,
  AgentTask,
  AgentTaskDetail,
  Handoff,
  IntentContract,
} from "@naru/contracts/naru-agent/v1";
import { type FormEvent, useEffect, useState } from "react";
import {
  actorLabel,
  agentTitle,
  agentTone,
  artifactKindLabel,
  channelLabel,
  handoffKindLabel,
  mergeReasonLabel,
  reviewKindLabel,
  reviewVerdictLabel,
  runStatusLabel,
  statusLabel,
  taskStatusLabel,
  taskTone,
  timeLabel,
} from "./agent-labels";
import { taskLevels } from "./agent-task-graph";
import { ApiFailure, type AgentProjectView, type NaruApi } from "./api";

type Act = (label: string, action: () => Promise<unknown>) => Promise<boolean>;
type Runtime = "claude" | "codex";

const TASK_POLL_MS = 3_000;
const RECENT_INSTRUCTIONS = 5;

/**
 * Home (SOURCE_SPEC §10): every project's agent work, the Main Orchestrator and the decisions
 * waiting for the user. Counts come from Core's overview; nothing is estimated here.
 */
export function HomeOverview({
  overview,
  projects,
  currentProjectId,
  mutationAllowed,
  act,
  api,
  onSelectProject,
  onSelectAgent,
  onSelectHandoff,
}: {
  readonly overview: AgentOverview | null;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly currentProjectId: string;
  readonly mutationAllowed: boolean;
  readonly act: Act;
  readonly api: NaruApi;
  readonly onSelectProject: (projectId: string) => void;
  readonly onSelectAgent: (agentSessionId: string) => void;
  readonly onSelectHandoff: (handoff: Handoff) => void;
}): React.JSX.Element {
  const nameOf = (projectId: string | null): string =>
    projects.find((project) => project.id === projectId)?.name ?? "전체";
  const mains = (overview?.globalAgents ?? []).filter(
    (agent) => agent.role === "main-orchestrator",
  );
  return (
    <article className="agent-panel" aria-labelledby="agent-home-title">
      <header className="agent-panel-header">
        <div>
          <h2 id="agent-home-title">전체 현황</h2>
          <p className="agent-panel-meta">
            <span>프로젝트 {overview?.projects.length ?? 0}개</span>
            <span>결정 대기 {overview?.openHandoffs.length ?? 0}건</span>
          </p>
        </div>
      </header>
      {overview === null ? (
        <div className="inline-loading">
          <span /> 전체 현황을 여는 중…
        </div>
      ) : (
        <>
          <section className="agent-panel-section" aria-label="메인 오케스트레이터">
            <h3>메인 오케스트레이터</h3>
            {mains.length > 0 ? (
              <ul className="agent-link-list">
                {mains.map((agent) => (
                  <li key={agent.id}>
                    <AgentLink agent={agent} onSelect={onSelectAgent} />
                  </li>
                ))}
              </ul>
            ) : (
              <StartAgentForm
                label="메인 오케스트레이터 시작"
                hint={`전체 목표를 받아 프로젝트별 오케스트레이터에게 나눠 줍니다. Pane은 지금 프로젝트(${nameOf(currentProjectId)}) 작업공간에 둡니다.`}
                disabled={!mutationAllowed}
                onStart={(runtime) =>
                  act("메인 오케스트레이터를 시작했습니다.", () =>
                    api.createManagedAgent({
                      role: "main-orchestrator",
                      hostProjectId: currentProjectId,
                      runtime,
                    }),
                  )
                }
              />
            )}
          </section>

          <section className="agent-panel-section" aria-label="프로젝트">
            <h3>프로젝트</h3>
            {overview.projects.length === 0 ? (
              <p className="agent-hint">아직 에이전트가 일한 프로젝트가 없습니다.</p>
            ) : (
              <div className="agent-table-scroll">
                <table className="agent-table">
                  <thead>
                    <tr>
                      <th scope="col">프로젝트</th>
                      <th scope="col">작업</th>
                      <th scope="col">진행 중</th>
                      <th scope="col">막힘</th>
                      <th scope="col">리뷰</th>
                      <th scope="col">완료</th>
                      <th scope="col">결정 대기</th>
                      <th scope="col">에이전트</th>
                    </tr>
                  </thead>
                  <tbody>
                    {overview.projects.map((summary) => (
                      <tr key={summary.projectId}>
                        <th scope="row">
                          <button
                            type="button"
                            className="agent-table-link"
                            aria-current={
                              summary.projectId === currentProjectId ? "true" : undefined
                            }
                            onClick={() => onSelectProject(summary.projectId)}
                          >
                            {nameOf(summary.projectId)}
                          </button>
                        </th>
                        <td>
                          {Object.values(summary.taskCounts).reduce(
                            (total, count) => total + count,
                            0,
                          )}
                        </td>
                        <td>{summary.taskCounts.running ?? 0}</td>
                        <td>{summary.taskCounts.blocked ?? 0}</td>
                        <td>{summary.taskCounts.review ?? 0}</td>
                        <td>{summary.taskCounts.done ?? 0}</td>
                        <td>{summary.openHandoffs}</td>
                        <td>
                          {summary.agents}
                          {summary.heldAgents > 0 ? ` (사람 ${summary.heldAgents})` : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="agent-panel-section" aria-label="결정 대기">
            <h3>결정 대기</h3>
            {overview.openHandoffs.length === 0 ? (
              <p className="agent-hint">기다리는 결정이 없습니다.</p>
            ) : (
              <ul className="agent-link-list">
                {overview.openHandoffs.map((handoff) => (
                  <li key={handoff.id}>
                    <button
                      type="button"
                      className="agent-list-item"
                      data-tone="attention"
                      onClick={() => onSelectHandoff(handoff)}
                    >
                      <span className="agent-list-label">
                        {handoffKindLabel(handoff.kind)} · {nameOf(handoff.projectId)}
                      </span>
                      <span className="agent-list-detail">{handoff.payload.reason}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <p className="agent-hint">리소스 사용량과 최근 성과 요약은 아직 수집하지 않습니다.</p>
        </>
      )}
    </article>
  );
}

/**
 * Project (SOURCE_SPEC §10): the Project Orchestrator, the user's own instructions, the approved
 * Intent Contract, the active plan and the task dependency graph.
 */
export function ProjectOverview({
  api,
  projectId,
  projectName,
  view,
  mutationAllowed,
  act,
  onSelectAgent,
  onSelectTask,
}: {
  readonly api: NaruApi;
  readonly projectId: string;
  readonly projectName: string;
  readonly view: AgentProjectView;
  readonly mutationAllowed: boolean;
  readonly act: Act;
  readonly onSelectAgent: (agentSessionId: string) => void;
  readonly onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const [instruction, setInstruction] = useState("");
  const orchestrators = view.agents.filter((agent) => agent.role === "project-orchestrator");
  const contract = view.intentContract;
  const pending = view.pendingIntentContract;
  const recent = view.instructions.slice(-RECENT_INSTRUCTIONS).reverse();
  return (
    <article className="agent-panel" aria-labelledby="agent-project-title">
      <header className="agent-panel-header">
        <div>
          <h2 id="agent-project-title">{projectName}</h2>
          <p className="agent-panel-meta">
            <span>
              {view.activePlan === null ? "계획 없음" : `계획 v${view.activePlan.version}`}
            </span>
            <span>
              {contract !== null
                ? `의도 계약 v${contract.version}`
                : pending !== null
                  ? "의도 계약 승인 대기"
                  : "의도 계약 없음"}
            </span>
            <span>작업 {view.tasks.length}개</span>
          </p>
        </div>
      </header>

      <section className="agent-panel-section" aria-label="프로젝트 오케스트레이터">
        <h3>프로젝트 오케스트레이터</h3>
        {orchestrators.length > 0 ? (
          <ul className="agent-link-list">
            {orchestrators.map((agent) => (
              <li key={agent.id}>
                <AgentLink agent={agent} onSelect={onSelectAgent} />
              </li>
            ))}
          </ul>
        ) : (
          <StartAgentForm
            label="오케스트레이터 시작"
            hint="이 프로젝트의 계획을 세우고 작업자와 리뷰어에게 일을 나눕니다."
            disabled={!mutationAllowed}
            onStart={(runtime) =>
              act("프로젝트 오케스트레이터를 시작했습니다.", () =>
                api.createManagedAgent({ projectId, role: "project-orchestrator", runtime }),
              )
            }
          />
        )}
      </section>

      <section className="agent-panel-section" aria-label="프로젝트 지시">
        <h3>프로젝트 지시</h3>
        <form
          className="agent-composer"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const text = instruction.trim();
            if (text === "") return;
            void act("지시를 기록했습니다. 오케스트레이터가 다음 차례에 반영합니다.", () =>
              api.createInstruction({ kind: "project", projectId }, text),
            ).then((done) => {
              if (done) setInstruction("");
            });
          }}
        >
          <label className="sr-only" htmlFor={`project-instruction-${projectId}`}>
            프로젝트 전체에 남길 지시
          </label>
          <textarea
            id={`project-instruction-${projectId}`}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="프로젝트 목표나 바꿀 방향을 적습니다. 원문 그대로 기록되고 관련 작업자에게 전달됩니다."
            rows={2}
            disabled={!mutationAllowed}
          />
          <button
            className="secondary-button compact"
            type="submit"
            disabled={!mutationAllowed || instruction.trim() === ""}
          >
            지시 보내기
          </button>
        </form>
        {recent.length > 0 && (
          <ol className="agent-instructions" aria-label="최근 지시">
            {recent.map((item) => (
              <li key={item.id}>
                <p>{item.verbatim ?? "(사용자가 지운 지시)"}</p>
                <span>
                  {channelLabel(item.channel)} · {actorLabel(item.author, view.agents)} ·{" "}
                  {timeLabel(item.createdAt)}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="agent-panel-section" aria-label="의도 계약">
        <h3>의도 계약</h3>
        {pending !== null && (
          <div className="agent-pending-contract">
            <p className="agent-pending-title">
              <span className="agent-badge" data-tone="held">
                승인 대기
              </span>
              <strong>제안 v{pending.version}</strong>
            </p>
            <ContractFacts contract={pending} />
            <button
              className="primary-button compact"
              type="button"
              disabled={!mutationAllowed}
              onClick={() =>
                void act(`의도 계약 v${pending.version}을 승인했습니다.`, () =>
                  api.approveIntentContract(pending.id),
                )
              }
            >
              이 의도 계약 승인
            </button>
          </div>
        )}
        {contract === null ? (
          pending === null && (
            <p className="agent-hint">
              승인된 의도 계약이 없습니다. 오케스트레이터가 제안하면 여기서 승인합니다.
            </p>
          )
        ) : (
          <>
            {pending !== null && <p className="agent-hint">지금 적용 중: v{contract.version}</p>}
            <ContractFacts contract={contract} />
          </>
        )}
      </section>

      <section className="agent-panel-section" aria-label="계획">
        <h3>계획</h3>
        {view.activePlan === null ? (
          <p className="agent-hint">
            아직 계획이 없습니다. 오케스트레이터가 계획을 세우면 여기에 나타납니다.
          </p>
        ) : (
          <p className="agent-plan">{view.activePlan.summary}</p>
        )}
      </section>

      <section className="agent-panel-section" aria-label="작업 그래프">
        <h3>작업 그래프</h3>
        <TaskGraph
          tasks={view.tasks}
          agents={view.agents}
          handoffs={view.openHandoffs}
          onSelectTask={onSelectTask}
        />
      </section>
    </article>
  );
}

function TaskGraph({
  tasks,
  agents,
  handoffs,
  onSelectTask,
}: {
  readonly tasks: readonly AgentTask[];
  readonly agents: readonly AgentSession[];
  readonly handoffs: readonly Handoff[];
  readonly onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  if (tasks.length === 0) {
    return <p className="agent-hint">아직 작업이 없습니다.</p>;
  }
  const titleOf = (taskId: string) => tasks.find((task) => task.id === taskId)?.title;
  return (
    <ol className="task-graph" aria-label="작업 의존 관계">
      {taskLevels(tasks).map((level, index) => (
        <li key={index} className="task-graph-level">
          <h4>{index === 0 ? "1단계 · 먼저 할 일" : `${index + 1}단계`}</h4>
          <ul>
            {level.map((task) => {
              const assignee = agents.find((agent) => agent.id === task.assigneeAgentSessionId);
              const dependencies = task.dependsOn
                .map(titleOf)
                .filter((title) => title !== undefined);
              const waiting = handoffs.some((handoff) =>
                handoff.payload.blockingTaskIds.includes(task.id),
              );
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    className="task-node"
                    data-tone={taskTone(task.status)}
                    onClick={() => onSelectTask(task.id)}
                  >
                    <span className="task-node-title">{task.title}</span>
                    <span className="task-node-meta">
                      <span className="agent-badge" data-tone={taskTone(task.status)}>
                        {taskStatusLabel(task.status)}
                      </span>
                      <span>{assignee === undefined ? "담당 없음" : agentTitle(assignee)}</span>
                    </span>
                    {dependencies.length > 0 && (
                      <span className="task-node-deps">선행: {dependencies.join(", ")}</span>
                    )}
                    {waiting && <span className="task-node-flag">사람 확인 대기</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

/** One task node opened: runs, reviews, artifacts (tests, diffs) and its merge gate. */
export function TaskDetail({
  api,
  taskId,
  view,
  onSelectAgent,
  onSelectTask,
  onSelectHandoff,
}: {
  readonly api: NaruApi;
  readonly taskId: string;
  readonly view: AgentProjectView;
  readonly onSelectAgent: (agentSessionId: string) => void;
  readonly onSelectTask: (taskId: string) => void;
  readonly onSelectHandoff: (handoffId: string) => void;
}): React.JSX.Element {
  const [detail, setDetail] = useState<AgentTaskDetail | null>(null);
  const [issue, setIssue] = useState<string | null>(null);

  useEffect(() => {
    let stopped = false;
    const load = async (): Promise<void> => {
      try {
        const next = await api.agentTask(taskId);
        if (stopped) return;
        setDetail(next);
        setIssue(null);
      } catch (failure) {
        if (!stopped) {
          setIssue(failure instanceof ApiFailure ? failure.message : "작업을 읽지 못했습니다.");
        }
      }
    };
    const first = window.setTimeout(() => void load(), 0);
    const timer = window.setInterval(() => void load(), TASK_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [api, taskId]);

  if (detail === null) {
    return issue === null ? (
      <div className="inline-loading">
        <span /> 작업을 여는 중…
      </div>
    ) : (
      <p className="agent-panel-issue" role="status">
        {issue}
      </p>
    );
  }
  const task = detail.task;
  const assignee = view.agents.find((agent) => agent.id === task.assigneeAgentSessionId);
  const agentOf = (agentSessionId: string | null) =>
    view.agents.find((agent) => agent.id === agentSessionId);
  const blocking = view.openHandoffs.filter((handoff) =>
    handoff.payload.blockingTaskIds.includes(task.id),
  );
  return (
    <article className="agent-panel" aria-labelledby={`task-${task.id}`}>
      <header className="agent-panel-header">
        <div>
          <h2 id={`task-${task.id}`}>{task.title}</h2>
          <p className="agent-panel-meta">
            <span className="agent-badge" data-tone={taskTone(task.status)}>
              {taskStatusLabel(task.status)}
            </span>
            <span>우선순위 {task.priority}</span>
            <span>개정 {task.revision}</span>
          </p>
        </div>
      </header>
      {issue !== null && (
        <p className="agent-panel-issue" role="status">
          {issue}
        </p>
      )}
      <dl className="agent-facts">
        <dt>담당</dt>
        <dd>
          {assignee === undefined ? (
            "담당 없음"
          ) : (
            <button
              type="button"
              className="agent-inline-link"
              onClick={() => onSelectAgent(assignee.id)}
            >
              {agentTitle(assignee)}
            </button>
          )}
        </dd>
        {task.purpose !== "" && (
          <>
            <dt>목적</dt>
            <dd>{task.purpose}</dd>
          </>
        )}
        <FactList title="완료 조건" items={task.completionCriteria} />
        {task.dependsOn.length > 0 && (
          <>
            <dt>선행 작업</dt>
            <dd>
              <ul>
                {task.dependsOn.map((dependencyId) => {
                  const dependency = view.tasks.find((item) => item.id === dependencyId);
                  return (
                    <li key={dependencyId}>
                      {dependency === undefined ? (
                        "다른 프로젝트나 삭제된 작업"
                      ) : (
                        <button
                          type="button"
                          className="agent-inline-link"
                          onClick={() => onSelectTask(dependency.id)}
                        >
                          {dependency.title} ({taskStatusLabel(dependency.status)})
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </dd>
          </>
        )}
        {blocking.length > 0 && (
          <>
            <dt>기다리는 결정</dt>
            <dd>
              <ul>
                {blocking.map((handoff) => (
                  <li key={handoff.id}>
                    <button
                      type="button"
                      className="agent-inline-link"
                      onClick={() => onSelectHandoff(handoff.id)}
                    >
                      {handoffKindLabel(handoff.kind)}
                    </button>
                  </li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>병합 조건</dt>
        <dd>
          {detail.mergeGate.open ? (
            "통과"
          ) : (
            <ul>
              {detail.mergeGate.reasons.map((reason) => (
                <li key={reason}>{mergeReasonLabel(reason)}</li>
              ))}
            </ul>
          )}
        </dd>
      </dl>

      <section className="agent-panel-section" aria-label="실행">
        <h3>실행</h3>
        {detail.runs.length === 0 ? (
          <p className="agent-hint">아직 실행이 없습니다.</p>
        ) : (
          <ol className="agent-records">
            {[...detail.runs].reverse().map((run) => {
              const runner = agentOf(run.agentSessionId);
              return (
                <li key={run.id}>
                  <strong>
                    {run.attempt}번째 · {runStatusLabel(run.status)}
                  </strong>
                  <span>
                    {runner === undefined ? run.runtime : agentTitle(runner)}
                    {run.model === null ? "" : ` · ${run.model}`} · {timeLabel(run.startedAt)}
                    {run.finishedAt === null ? "" : ` → ${timeLabel(run.finishedAt)}`}
                  </span>
                  {run.errorClass !== null && <span>오류: {run.errorClass}</span>}
                  {run.summary !== null && <p>{run.summary}</p>}
                </li>
              );
            })}
          </ol>
        )}
      </section>

      <section className="agent-panel-section" aria-label="리뷰">
        <h3>리뷰</h3>
        {detail.reviews.length === 0 ? (
          <p className="agent-hint">아직 리뷰가 없습니다.</p>
        ) : (
          <ol className="agent-records">
            {[...detail.reviews].reverse().map((review) => (
              <li key={review.id}>
                <strong>
                  {reviewKindLabel(review.kind)} · {reviewVerdictLabel(review.verdict)}
                </strong>
                <span>{timeLabel(review.createdAt)}</span>
                <p>{review.findings}</p>
              </li>
            ))}
          </ol>
        )}
      </section>

      <section className="agent-panel-section" aria-label="산출물">
        <h3>산출물</h3>
        {detail.artifacts.length === 0 ? (
          <p className="agent-hint">아직 산출물이 없습니다.</p>
        ) : (
          <ol className="agent-records">
            {[...detail.artifacts].reverse().map((artifact) => (
              <li key={artifact.id}>
                <strong>
                  {artifactKindLabel(artifact.kind)}
                  {artifact.exitCode === null
                    ? ""
                    : artifact.exitCode === 0
                      ? " · 성공"
                      : ` · 종료 코드 ${artifact.exitCode}`}
                </strong>
                <code>{artifact.reference}</code>
                {artifact.summary !== null && <p>{artifact.summary}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </article>
  );
}

export function AgentLink({
  agent,
  onSelect,
}: {
  readonly agent: AgentSession;
  readonly onSelect: (agentSessionId: string) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      className="agent-list-item"
      data-tone={agentTone(agent)}
      onClick={() => onSelect(agent.id)}
    >
      <span className="agent-list-label">{agentTitle(agent)}</span>
      <span className="agent-list-detail">{statusLabel(agent.status)} · 대화 열기</span>
    </button>
  );
}

function StartAgentForm({
  label,
  hint,
  disabled,
  onStart,
}: {
  readonly label: string;
  readonly hint: string;
  readonly disabled: boolean;
  readonly onStart: (runtime: Runtime) => Promise<boolean>;
}): React.JSX.Element {
  const [runtime, setRuntime] = useState<Runtime>("claude");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="agent-create"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        void onStart(runtime).finally(() => setBusy(false));
      }}
    >
      <p className="agent-hint">{hint}</p>
      <label>
        런타임
        <select
          value={runtime}
          onChange={(event) => setRuntime(event.target.value as Runtime)}
          disabled={disabled}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <button className="secondary-button compact" type="submit" disabled={disabled || busy}>
        {label}
      </button>
    </form>
  );
}

function ContractFacts({ contract }: { readonly contract: IntentContract }): React.JSX.Element {
  return (
    <dl className="agent-facts">
      <FactList title="원칙" items={contract.body.principles} />
      <FactList title="스스로 정해도 되는 것" items={contract.body.allowedChoices} />
      <FactList title="승인이 필요한 경우" items={contract.body.requireApprovalIf} />
      <FactList title="하지 않을 것" items={contract.body.forbidden} />
    </dl>
  );
}

function FactList({
  title,
  items,
}: {
  readonly title: string;
  readonly items: readonly string[];
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  return (
    <>
      <dt>{title}</dt>
      <dd>
        <ul>
          {items.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </dd>
    </>
  );
}
