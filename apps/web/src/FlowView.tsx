import type { AgentTask, AgentTaskDetail, Instruction } from "@naru/contracts/naru-agent/v1";
import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useAgentApp, useTaskDetail } from "./agent-context";
import {
  artifactKindLabel,
  mergeReasonLabel,
  reviewKindLabel,
  reviewVerdictLabel,
  runStatusLabel,
  taskStatusLabel,
} from "./agent-labels";
import { ago, clock, type Tone, taskProgress, taskState, taskWaitingFor } from "./agent-model";
import { Steps } from "./AgentChat";
import { ContractBody, EmptyNote, InboxCard } from "./AgentInbox";
import { Avatar, ChatMarkdown, Icon, Pill, Sheet } from "./agent-ui";
import { autosize, PHONE, submitOnEnter, useMedia } from "./agent-dom";
import type { AgentBoardProject } from "./api";
import { TaskGraph, TaskNode } from "./TaskGraph";
import { taskLevels } from "./agent-task-graph";

const ZOOMS = [0.6, 0.75, 0.9, 1, 1.15, 1.3] as const;

/**
 * One project's work as a flow (Figma v1 D3, AP-D022): tasks in stages by dependency, who has each
 * one, and the selected task's record, artifacts and merge conditions.
 */
export function FlowView({
  projectId,
  taskId,
  onSelect,
}: {
  readonly projectId: string | null;
  readonly taskId: string | null;
  readonly onSelect: (projectId: string, taskId: string | null) => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const phone = useMedia(PHONE);
  const [zoom, setZoom] = useState(1);
  const canvas = useRef<HTMLDivElement | null>(null);
  const [canvasHeight, setCanvasHeight] = useState(0);
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const observer = new ResizeObserver(() => setCanvasHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, [phone]);
  const [sheet, setSheet] = useState<"plan" | "instruct" | null>(null);
  const chosen =
    projectId ??
    app.board.projects.find((project) => project.tasks.length > 0)?.projectId ??
    app.currentProjectId;
  const project: AgentBoardProject =
    app.board.projects.find((candidate) => candidate.projectId === chosen) ?? emptyProject(chosen);
  const task = project.tasks.find((candidate) => candidate.id === taskId);
  const progress = taskProgress(project.tasks);
  const orchestrator = project.agents.find((agent) => agent.role === "project-orchestrator");
  const name = app.projectName(project.projectId);
  return (
    <div className="ag-flow" data-drawer={task !== undefined && !phone}>
      <header className="ag-flow-head">
        <div className="ag-flow-title">
          <label className="ag-crumb">
            <span className="sr-only">프로젝트</span>
            <select
              value={project.projectId}
              onChange={(event) => onSelect(event.target.value, null)}
            >
              {app.projects.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
            <Icon name="chevronRight" size={12} />
            <span>작업 흐름</span>
          </label>
          <h2>{name}</h2>
          <p className="ag-muted">
            {project.activePlan === null ? "계획 없음" : `계획 v${project.activePlan.version}`} ·
            작업 {progress.total}개 · 완료 {progress.done}
            {orchestrator === undefined ? "" : ` · ${app.identity(orchestrator).name}가 관리`}
          </p>
        </div>
        <span className="ag-grow" />
        <div className="ag-flow-actions">
          <button className="ag-button" type="button" onClick={() => setSheet("plan")}>
            계획 문서
          </button>
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            onClick={() => setSheet("instruct")}
          >
            프로젝트에 지시
          </button>
        </div>
      </header>
      <div className="ag-flow-body">
        {phone ? (
          <PhoneStages
            project={project}
            selectedTaskId={task?.id ?? null}
            onSelect={(selected) => onSelect(project.projectId, selected.id)}
          />
        ) : (
          <div className="ag-canvas">
            <div className="ag-canvas-scroll" ref={canvas}>
              {project.tasks.length === 0 ? (
                <div className="ag-canvas-empty">
                  <EmptyNote icon="bell">
                    {orchestrator === undefined
                      ? "이 프로젝트에는 아직 오케스트레이터가 없습니다. ‘프로젝트에 지시’로 목표를 보내면 시작합니다."
                      : "아직 작업이 없습니다. 오케스트레이터가 계획을 세우면 여기에 그려집니다."}
                  </EmptyNote>
                </div>
              ) : (
                <TaskGraph
                  project={project}
                  variant="flow"
                  zoom={zoom}
                  minHeight={canvasHeight}
                  selectedTaskId={task?.id ?? null}
                  onSelect={(selected) =>
                    onSelect(project.projectId, selected.id === task?.id ? null : selected.id)
                  }
                />
              )}
            </div>
            <ul className="ag-legend ag-canvas-legend" aria-label="상태 색">
              <li data-tone="green">완료</li>
              <li data-tone="blue">진행</li>
              <li data-tone="violet">리뷰</li>
              <li data-tone="accent">나를 기다림</li>
              <li data-tone="subtle">대기</li>
            </ul>
            {project.tasks.length > 0 && (
              <div className="ag-zoom" role="group" aria-label="확대">
                <button
                  className="ag-icon-button"
                  type="button"
                  aria-label="축소"
                  disabled={zoom === ZOOMS[0]}
                  onClick={() => setZoom(ZOOMS[Math.max(0, ZOOMS.indexOf(zoom as never) - 1)]!)}
                >
                  <Icon name="minus" size={14} />
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  className="ag-icon-button"
                  type="button"
                  aria-label="확대"
                  disabled={zoom === ZOOMS.at(-1)}
                  onClick={() =>
                    setZoom(ZOOMS[Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom as never) + 1)]!)
                  }
                >
                  <Icon name="plus" size={14} />
                </button>
              </div>
            )}
          </div>
        )}
        {task !== undefined &&
          (phone ? (
            <Sheet title="작업" onClose={() => onSelect(project.projectId, null)}>
              <TaskDrawer task={task} project={project} />
            </Sheet>
          ) : (
            <aside className="ag-drawer" aria-label={`${task.title} 상세`}>
              <button
                className="ag-icon-button ag-drawer-close"
                type="button"
                aria-label="상세 닫기"
                onClick={() => onSelect(project.projectId, null)}
              >
                <Icon name="x" size={18} />
              </button>
              <TaskDrawer task={task} project={project} />
            </aside>
          ))}
      </div>
      {sheet === "plan" && <PlanSheet project={project} onClose={() => setSheet(null)} />}
      {sheet === "instruct" && <InstructSheet project={project} onClose={() => setSheet(null)} />}
    </div>
  );
}

/** On a phone the stages read top to bottom; each task says what it waits for. */
function PhoneStages({
  project,
  selectedTaskId,
  onSelect,
}: {
  readonly project: AgentBoardProject;
  readonly selectedTaskId: string | null;
  readonly onSelect: (task: AgentTask) => void;
}): React.JSX.Element {
  const levels = taskLevels(project.tasks);
  if (levels.length === 0) {
    return (
      <div className="ag-canvas-empty">
        <EmptyNote icon="bell">
          아직 작업이 없습니다. 오케스트레이터가 계획을 세우면 여기에 나옵니다.
        </EmptyNote>
      </div>
    );
  }
  return (
    <ol className="ag-phone-stages" aria-label="단계별 작업">
      {levels.map((level, index) => (
        <li key={index}>
          <h3>{index === 0 ? "1단계 · 먼저 할 일" : `${index + 1}단계`}</h3>
          <ul>
            {level.map((item) => {
              const before = item.dependsOn
                .map((id) => project.tasks.find((candidate) => candidate.id === id)?.title)
                .filter((title): title is string => title !== undefined);
              return (
                <li key={item.id}>
                  <TaskNode
                    task={item}
                    project={project}
                    selected={item.id === selectedTaskId}
                    style={{ position: "relative" }}
                    onSelect={onSelect}
                  />
                  {before.length > 0 && <p className="ag-phone-after">먼저: {before.join(", ")}</p>}
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ol>
  );
}

function emptyProject(projectId: string): AgentBoardProject {
  return {
    projectId,
    intentContract: null,
    pendingIntentContract: null,
    activePlan: null,
    tasks: [],
    openHandoffs: [],
    agents: [],
    processes: [],
    pendingApprovals: [],
  };
}

function TaskDrawer({
  task,
  project,
}: {
  readonly task: AgentTask;
  readonly project: AgentBoardProject;
}): React.JSX.Element {
  const app = useAgentApp();
  const detail = useTaskDetail(task.id);
  const state = taskState(task, taskWaitingFor(task, project, app.board.openHandoffs));
  const assignee = app.agentById(task.assigneeAgentSessionId);
  const blocking = app.inbox.filter(
    (item) => item.kind === "handoff" && item.handoff.payload.blockingTaskIds.includes(task.id),
  );
  const dependencies = task.dependsOn
    .map((id) => project.tasks.find((candidate) => candidate.id === id))
    .filter((candidate): candidate is AgentTask => candidate !== undefined);
  const record = useMemo(() => taskRecord(task, detail, app), [task, detail, app]);
  return (
    <div className="ag-drawer-body">
      <section className="ag-context-section">
        <Pill tone={state.tone}>{state.label}</Pill>
        <h3 className="ag-drawer-title">{task.title}</h3>
        {assignee === undefined ? (
          <p className="ag-muted">아직 맡은 에이전트가 없습니다.</p>
        ) : (
          <div className="ag-assignee">
            <Avatar identity={app.identity(assignee)} size={26} presence={app.presence(assignee)} />
            <span>
              <strong>{app.identity(assignee).name}</strong>
              <span className="ag-muted">
                {assignee.runtime === "codex" ? "Codex" : "Claude"} · {ago(task.updatedAt, app.now)}
                전 갱신
              </span>
            </span>
            <span className="ag-grow" />
            <button className="ag-button" type="button" onClick={() => app.openChat(assignee.id)}>
              <Icon name="chat" size={14} />
              대화 열기
            </button>
          </div>
        )}
      </section>
      {blocking.length > 0 && (
        <section className="ag-context-section">
          <h3>나를 기다리는 것</h3>
          <ul className="ag-inbox-list">
            {blocking.map((item) => (
              <li key={item.key}>
                <InboxCard item={item} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {task.purpose !== "" && (
        <section className="ag-context-section">
          <h3>목표</h3>
          <p className="ag-context-text">{task.purpose}</p>
        </section>
      )}
      {task.completionCriteria.length > 0 && (
        <section className="ag-context-section">
          <h3>완료 조건</h3>
          <ul className="ag-bullets">
            {task.completionCriteria.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </section>
      )}
      <section className="ag-context-section">
        <h3>진행</h3>
        <Steps task={task} detail={detail} />
      </section>
      {dependencies.length > 0 && (
        <section className="ag-context-section">
          <h3>먼저 끝나야 하는 작업</h3>
          <ul className="ag-task-links">
            {dependencies.map((dependency) => (
              <li key={dependency.id}>
                <button
                  className="ag-task-link"
                  type="button"
                  onClick={() => app.openFlow(project.projectId, dependency.id)}
                >
                  <span
                    className="ag-dot"
                    data-tone={dependency.status === "done" ? "green" : "subtle"}
                    aria-hidden="true"
                  />
                  <span>{dependency.title}</span>
                  <span className="ag-muted">{taskStatusLabel(dependency.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <section className="ag-context-section">
        <h3>진행 기록</h3>
        {record.length === 0 ? (
          <p className="ag-muted">아직 기록이 없습니다.</p>
        ) : (
          <ol className="ag-record">
            {record.map((entry) => (
              <li key={entry.key} data-tone={entry.tone}>
                <time dateTime={new Date(entry.at).toISOString()}>{clock(entry.at)}</time>
                <span className="ag-dot" aria-hidden="true" />
                <span>
                  {entry.text}
                  {entry.detail !== null && (
                    <span className="ag-record-detail">{entry.detail}</span>
                  )}
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
      <section className="ag-context-section">
        <h3>산출물</h3>
        {detail === null || detail.artifacts.length === 0 ? (
          <p className="ag-muted">아직 없습니다.</p>
        ) : (
          <ul className="ag-artifact-chips">
            {[...detail.artifacts].reverse().map((artifact) => (
              <li
                key={artifact.id}
                data-tone={
                  artifact.exitCode === null ? undefined : artifact.exitCode === 0 ? "green" : "red"
                }
              >
                <Icon
                  name={
                    artifact.kind === "branch" || artifact.kind === "commit"
                      ? "branch"
                      : artifact.kind === "test-result"
                        ? artifact.exitCode === 0
                          ? "check"
                          : "x"
                        : "file"
                  }
                  size={13}
                />
                <span>{artifactKindLabel(artifact.kind)}</span>
                <code>{artifact.reference}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="ag-context-section">
        <h3>병합 조건</h3>
        {detail === null ? (
          <p className="ag-muted">확인하는 중…</p>
        ) : detail.mergeGate.open ? (
          <p className="ag-gate" data-ok="true">
            <Icon name="check" size={15} strokeWidth={2.4} />
            병합할 수 있습니다
          </p>
        ) : (
          <ul className="ag-gate-list">
            {detail.mergeGate.reasons.map((reason) => (
              <li key={reason} className="ag-gate">
                <Icon name="x" size={15} strokeWidth={2.4} />
                {mergeReasonLabel(reason)}
              </li>
            ))}
          </ul>
        )}
        <p className="ag-muted">병합은 조건을 통과한 뒤 오케스트레이터가 합니다.</p>
      </section>
    </div>
  );
}

interface RecordEntry {
  readonly key: string;
  readonly at: number;
  readonly text: string;
  readonly detail: string | null;
  readonly tone: Tone;
}

/** The task's history from its runs, reviews, artifacts and status changes, oldest first. */
function taskRecord(
  task: AgentTask,
  detail: AgentTaskDetail | null,
  app: ReturnType<typeof useAgentApp>,
): RecordEntry[] {
  const entries: RecordEntry[] = [
    {
      key: "created",
      at: Date.parse(task.createdAt),
      text: "작업을 만듦",
      detail: null,
      tone: "subtle",
    },
  ];
  for (const event of app.events) {
    if (event.type !== "task.updated" || event.subjectId !== task.id) continue;
    const status = typeof event.data.status === "string" ? event.data.status : null;
    if (status === null) continue;
    entries.push({
      key: event.id,
      at: Date.parse(event.createdAt),
      text: `상태: ${taskStatusLabel(status as AgentTask["status"])}`,
      detail: null,
      tone: status === "done" ? "green" : status === "failed" ? "red" : "subtle",
    });
  }
  for (const run of detail?.runs ?? []) {
    const runner = app.agentById(run.agentSessionId);
    entries.push({
      key: `${run.id}:start`,
      at: Date.parse(run.startedAt),
      text: `${run.attempt}번째 실행 시작${runner === undefined ? "" : ` · ${app.identity(runner).name}`}`,
      detail: null,
      tone: "blue",
    });
    if (run.finishedAt !== null) {
      entries.push({
        key: `${run.id}:end`,
        at: Date.parse(run.finishedAt),
        text: `실행 ${runStatusLabel(run.status)}`,
        detail: run.summary,
        tone: run.status === "succeeded" ? "green" : run.status === "failed" ? "red" : "subtle",
      });
    }
  }
  for (const review of detail?.reviews ?? []) {
    entries.push({
      key: review.id,
      at: Date.parse(review.createdAt),
      text: `${reviewKindLabel(review.kind)}: ${reviewVerdictLabel(review.verdict)}`,
      detail: review.findings === "" ? null : review.findings,
      tone: review.verdict === "pass" ? "green" : "red",
    });
  }
  for (const artifact of detail?.artifacts ?? []) {
    entries.push({
      key: artifact.id,
      at: Date.parse(artifact.createdAt),
      text: `${artifactKindLabel(artifact.kind)}: ${artifact.reference}`,
      detail: artifact.summary,
      tone: artifact.exitCode === null ? "subtle" : artifact.exitCode === 0 ? "green" : "red",
    });
  }
  return entries
    .filter((entry) => !Number.isNaN(entry.at))
    .sort((left, right) => left.at - right.at);
}

function PlanSheet({
  project,
  onClose,
}: {
  readonly project: AgentBoardProject;
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const [instructions, setInstructions] = useState<Instruction[] | null>(null);
  useEffect(() => {
    let stopped = false;
    app.api.agentProject(project.projectId).then(
      (view) => {
        if (!stopped) setInstructions(view.instructions.slice(-8).reverse());
      },
      () => {
        if (!stopped) setInstructions([]);
      },
    );
    return () => {
      stopped = true;
    };
  }, [app.api, project.projectId]);
  const pending = app.inbox.find(
    (item) => item.kind === "contract" && item.projectId === project.projectId,
  );
  return (
    <Sheet title={`${app.projectName(project.projectId)} 계획 문서`} onClose={onClose} wide>
      <section className="ag-sheet-section">
        <h3>계획</h3>
        {project.activePlan === null ? (
          <p className="ag-muted">아직 계획이 없습니다.</p>
        ) : (
          <>
            <p className="ag-muted">
              v{project.activePlan.version} · {ago(project.activePlan.createdAt, app.now)} 전
            </p>
            <ChatMarkdown text={project.activePlan.summary} />
          </>
        )}
      </section>
      {pending !== undefined && (
        <section className="ag-sheet-section">
          <h3>승인을 기다리는 의도 계약</h3>
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            onClick={() => app.openDecision(pending)}
          >
            검토하기
          </button>
        </section>
      )}
      <section className="ag-sheet-section">
        <h3>의도 계약</h3>
        {project.intentContract === null ? (
          <p className="ag-muted">승인된 의도 계약이 없습니다.</p>
        ) : (
          <>
            <p className="ag-muted">v{project.intentContract.version}</p>
            <ContractBody contract={project.intentContract} />
          </>
        )}
      </section>
      <section className="ag-sheet-section">
        <h3>내가 남긴 지시</h3>
        {instructions === null ? (
          <p className="ag-muted">불러오는 중…</p>
        ) : instructions.length === 0 ? (
          <p className="ag-muted">아직 없습니다.</p>
        ) : (
          <ol className="ag-said">
            {instructions.map((item) => (
              <li key={item.id}>
                <p>{item.verbatim ?? "(지운 지시)"}</p>
                <span className="ag-muted">
                  {item.scope.kind === "global" ? "전체" : "프로젝트"} ·{" "}
                  {ago(item.createdAt, app.now)} 전
                </span>
              </li>
            ))}
          </ol>
        )}
      </section>
    </Sheet>
  );
}

function InstructSheet({
  project,
  onClose,
}: {
  readonly project: AgentBoardProject;
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const [text, setText] = useState("");
  const [runtime, setRuntime] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  const orchestrator = project.agents.find((agent) => agent.role === "project-orchestrator");
  return (
    <Sheet title={`${app.projectName(project.projectId)}에 지시`} onClose={onClose}>
      <form
        className="ag-sheet-form"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const message = text.trim();
          if (message === "") return;
          setBusy(true);
          void app
            .act("프로젝트에 지시를 남겼습니다.", async () => {
              if (orchestrator === undefined) {
                await app.api.createManagedAgent({
                  projectId: project.projectId,
                  role: "project-orchestrator",
                  runtime,
                });
              } else if (orchestrator.status === "stopped" || orchestrator.status === "failed") {
                await app.api.launchAgent(orchestrator.id);
              }
              await app.api.createInstruction(
                { kind: "project", projectId: project.projectId },
                message,
              );
            })
            .then((done) => {
              setBusy(false);
              if (done) onClose();
            });
        }}
      >
        <p className="ag-muted">
          이 프로젝트의 오케스트레이터가 받아 계획에 반영합니다. 원문 그대로 기록됩니다.
        </p>
        <label className="ag-field">
          <span className="sr-only">지시</span>
          <textarea
            value={text}
            rows={4}
            autoFocus
            placeholder="예: 세션 만료는 30분으로 해 줘. 리뷰가 끝나면 main에 합쳐."
            onChange={(event) => {
              setText(event.target.value);
              autosize(event.target, 12);
            }}
            onKeyDown={submitOnEnter}
            disabled={!app.mutationAllowed}
          />
        </label>
        {orchestrator === undefined && (
          <p className="ag-muted">
            오케스트레이터가 아직 없습니다. 보내면{" "}
            <label className="ag-inline-select">
              <span className="sr-only">런타임</span>
              <select
                value={runtime}
                onChange={(event) => setRuntime(event.target.value as typeof runtime)}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            로 시작합니다.
          </p>
        )}
        <div className="ag-sheet-actions">
          <button className="ag-button" type="button" onClick={onClose}>
            취소
          </button>
          <button
            className="ag-button"
            data-variant="primary"
            type="submit"
            disabled={!app.mutationAllowed || busy || text.trim() === ""}
          >
            지시 보내기
          </button>
        </div>
      </form>
    </Sheet>
  );
}
