import type { AgentSession, SharedProcess } from "@naru/contracts/naru-agent/v1";
import { type FormEvent, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useAgentApp } from "./agent-context";
import {
  agentActivity,
  ago,
  cleanupCandidates,
  clock,
  EVENT_FIRST_PAGE,
  isLive,
  PRESENCE_ORDER,
  presenceLabel,
  startOfDay,
  taskProgress,
  taskState,
  taskWaitingFor,
  timelineRows,
} from "./agent-model";
import { EmptyNote, InboxCard } from "./AgentInbox";
import { Avatar, Icon, Pill, Progress, Sheet } from "./agent-ui";
import { autosize, PHONE, submitOnEnter, useMedia } from "./agent-dom";
import type { AgentBoardProject } from "./api";
import { TaskGraph } from "./TaskGraph";

type Runtime = "claude" | "codex";

/**
 * The control room (Figma v1 D1/M1, AP-D022): one place to hand work over, the numbers that
 * matter, every project's task flow with who has what, what waits for the person, the agents
 * and who did what when.
 */
export function ControlRoom(): React.JSX.Element {
  const phone = useMedia(PHONE);
  const [askOpen, setAskOpen] = useState(false);
  return (
    <div className="ag-control" data-phone={phone}>
      {phone ? (
        <>
          <InboxColumn limit={2} />
          <Lanes compact />
          <button
            className="ag-fab"
            type="button"
            onClick={() => setAskOpen(true)}
            aria-haspopup="dialog"
          >
            <Icon name="plus" size={18} strokeWidth={2.4} />
            맡기기
          </button>
          {askOpen && (
            <Sheet title="무엇을 맡길까요?" onClose={() => setAskOpen(false)}>
              <Ask onSent={() => setAskOpen(false)} />
            </Sheet>
          )}
        </>
      ) : (
        <>
          <section className="ag-hero" aria-labelledby="ag-ask-title">
            <h2 id="ag-ask-title">무엇을 맡길까요?</h2>
            <p>
              목표를 말하면 메인 오케스트레이터가 프로젝트별로 나눠 맡깁니다. 정할 것이 생기면
              여기로 묻습니다.
            </p>
            <Ask />
          </section>
          <Stats />
          <div className="ag-split">
            <Lanes />
            <aside className="ag-side" aria-label="나를 기다리는 것과 에이전트">
              <InboxColumn />
              <Roster />
            </aside>
          </div>
          <Timeline />
        </>
      )}
    </div>
  );
}

/** The one entry point for orchestration: a goal for the main orchestrator, verbatim. */
function Ask({ onSent }: { readonly onSent?: () => void }): React.JSX.Element {
  const app = useAgentApp();
  const [text, setText] = useState("");
  const [runtime, setRuntime] = useState<Runtime>("claude");
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string | null>(null);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const main = app.board.globalAgents.find((agent) => agent.role === "main-orchestrator");
  const presence = main === undefined ? null : app.presence(main);
  // Where the caret goes after a mention, applied right after React commits the new text.
  const caretAfter = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = input.current;
    if (caretAfter.current === null || element === null) return;
    element.setSelectionRange(caretAfter.current, caretAfter.current);
    caretAfter.current = null;
    autosize(element);
  }, [text]);
  const mention = (name: string) => {
    const element = input.current;
    const token = `@${name} `;
    const at = element?.selectionStart ?? text.length;
    const before = text.slice(0, at);
    const glue = before === "" || before.endsWith(" ") || before.endsWith("\n") ? "" : " ";
    element?.focus();
    caretAfter.current = before.length + glue.length + token.length;
    setText(`${before}${glue}${token}${text.slice(at)}`);
  };
  return (
    <form
      className="ag-ask"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const goal = text.trim();
        if (goal === "" || busy) return;
        setBusy(true);
        void app
          .act("메인 오케스트레이터에게 맡겼습니다.", async () => {
            let target = main;
            if (target === undefined) {
              target = await app.api.createManagedAgent({
                role: "main-orchestrator",
                hostProjectId: app.currentProjectId,
                runtime,
              });
            } else if (!isLive(target)) {
              await app.api.launchAgent(target.id);
            }
            await app.api.createInstruction({ kind: "global" }, goal);
            return target;
          })
          .then((done) => {
            setBusy(false);
            if (!done) return;
            setText("");
            autosize(input.current);
            setSent(main?.id ?? "new");
            onSent?.();
          });
      }}
    >
      <label className="sr-only" htmlFor="ag-ask-input">
        메인 오케스트레이터에게 맡길 목표
      </label>
      <div className="ag-ask-box">
        <textarea
          id="ag-ask-input"
          ref={input}
          value={text}
          rows={2}
          placeholder="예: alpha는 로그인을 passkey로 바꾸고, beta는 결제 설계를 정리해 줘. 둘 다 계획을 먼저 보여 줘."
          disabled={!app.mutationAllowed}
          onChange={(event) => {
            setText(event.target.value);
            setSent(null);
            autosize(event.target);
          }}
          onKeyDown={submitOnEnter}
        />
        <div className="ag-ask-row">
          <div className="ag-chips" role="group" aria-label="프로젝트 언급">
            {app.projects.map((project) => (
              <button
                key={project.id}
                className="ag-chip"
                type="button"
                disabled={!app.mutationAllowed}
                // A pointer click keeps the caret in the goal; the keyboard path still works.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => mention(project.name)}
              >
                @{project.name}
              </button>
            ))}
          </div>
          <button
            className="ag-send"
            type="submit"
            aria-label="맡기기"
            disabled={!app.mutationAllowed || busy || text.trim() === ""}
          >
            <Icon name="up" size={18} strokeWidth={2.4} />
          </button>
        </div>
      </div>
      <p className="ag-ask-foot">
        {main === undefined ? (
          <>
            메인 오케스트레이터가 아직 없습니다. 보내면{" "}
            <label className="ag-inline-select">
              <span className="sr-only">런타임</span>
              <select
                value={runtime}
                onChange={(event) => setRuntime(event.target.value as Runtime)}
                disabled={!app.mutationAllowed}
              >
                <option value="claude">Claude</option>
                <option value="codex">Codex</option>
              </select>
            </label>
            로 시작합니다.
          </>
        ) : (
          <>
            <button className="ag-agent-chip" type="button" onClick={() => app.openChat(main.id)}>
              <Avatar identity={app.identity(main)} size={18} presence={presence!} />
              {app.identity(main).name} · {presenceLabel(presence!)}
            </button>
            {presence === "mine" && <span> 내가 직접 대화 중이라, 돌려주면 이어 받습니다.</span>}
            {(presence === "stopped" || presence === "failed") && (
              <span> 보내면 다시 실행합니다.</span>
            )}
          </>
        )}
        {sent !== null && (
          <span className="ag-ask-sent" role="status">
            맡겼습니다.{" "}
            {main !== undefined && (
              <button className="ag-link" type="button" onClick={() => app.openChat(main.id)}>
                대화 보기
              </button>
            )}
          </span>
        )}
      </p>
    </form>
  );
}

function Stats(): React.JSX.Element {
  const app = useAgentApp();
  const tasks = app.board.projects.flatMap((project) => project.tasks);
  const progress = taskProgress(tasks);
  const live = app.agents.filter((agent) => isLive(agent));
  const working = app.agents.filter((agent) => app.presence(agent) === "working");
  const approvals = app.inbox.filter((item) => item.kind === "approval").length;
  const checks = app.inbox.filter(
    (item) =>
      item.kind === "handoff" &&
      (item.handoff.kind === "manual-test" || item.handoff.kind === "terminal-control"),
  ).length;
  const decisions = app.inbox.length - approvals - checks;
  const today = startOfDay(app.now);
  const todays = app.events.filter((event) => Date.parse(event.createdAt) >= today);
  const merged = todays.filter(
    (event) => event.type === "artifact.published" && event.data.kind === "commit",
  ).length;
  const finished = todays.filter(
    (event) => event.type === "task.updated" && event.data.status === "done",
  ).length;
  const partial =
    app.events.length >= EVENT_FIRST_PAGE &&
    app.events[0] !== undefined &&
    Date.parse(app.events[0].createdAt) > today;
  return (
    <section className="ag-stats" aria-label="지금 상황">
      <div className="ag-stat">
        <h3>진행 중인 작업</h3>
        <p className="ag-stat-value">
          {progress.active}
          <span>/ {progress.total}</span>
        </p>
        <Progress value={progress.done} total={progress.total} label="완료한 작업" />
        <p className="ag-stat-note">완료 {progress.done}</p>
      </div>
      <div className="ag-stat">
        <h3>일하는 에이전트</h3>
        <p className="ag-stat-value">
          {working.length}
          <span>/ {live.length}</span>
        </p>
        <span className="ag-avatar-stack" aria-hidden="true">
          {working.slice(0, 6).map((agent) => (
            <Avatar key={agent.id} identity={app.identity(agent)} size={24} />
          ))}
        </span>
      </div>
      <div className="ag-stat" data-attention={app.inbox.length > 0}>
        <h3>나를 기다림</h3>
        <p className="ag-stat-value" data-tone={app.inbox.length > 0 ? "accent" : undefined}>
          {app.inbox.length}
        </p>
        <p className="ag-stat-note">
          승인 {approvals} · 확인 {checks} · 결정 {decisions}
        </p>
      </div>
      <div className="ag-stat">
        <h3>오늘</h3>
        <p className="ag-stat-value">
          {merged}
          <span>병합 · 완료 {finished}</span>
        </p>
        <p className="ag-stat-note">
          {partial ? "최근 기록 기준 · " : ""}토큰·비용은 아직 모으지 않습니다
        </p>
      </div>
    </section>
  );
}

function orderedProjects(
  projects: readonly AgentBoardProject[],
  waitingProjects: ReadonlySet<string | null>,
): AgentBoardProject[] {
  const latest = (project: AgentBoardProject) =>
    project.tasks.reduce((max, task) => (task.updatedAt > max ? task.updatedAt : max), "");
  return [...projects].sort(
    (left, right) =>
      Number(waitingProjects.has(right.projectId)) - Number(waitingProjects.has(left.projectId)) ||
      latest(right).localeCompare(latest(left)),
  );
}

function Lanes({ compact = false }: { readonly compact?: boolean }): React.JSX.Element {
  const app = useAgentApp();
  const waitingProjects = new Set(app.inbox.map((item) => item.projectId));
  const projects = orderedProjects(app.board.projects, waitingProjects);
  return (
    <section className="ag-lanes" aria-labelledby="ag-lanes-title">
      <header className="ag-section-head">
        <h2 id="ag-lanes-title">{compact ? "진행 중" : "작업 흐름"}</h2>
        {!compact && (
          <ul className="ag-legend" aria-label="상태 색">
            <li data-tone="blue">진행 중</li>
            <li data-tone="violet">리뷰</li>
            <li data-tone="accent">나를 기다림</li>
            <li data-tone="green">완료</li>
            <li data-tone="subtle">대기</li>
          </ul>
        )}
      </header>
      {projects.length === 0 ? (
        <EmptyNote icon="bell">
          아직 에이전트가 일한 프로젝트가 없습니다. 위에서 목표를 맡기거나, 흐름 화면에서 프로젝트
          오케스트레이터를 시작하세요.
        </EmptyNote>
      ) : (
        projects.map((project) =>
          compact ? (
            <CompactLane key={project.projectId} project={project} />
          ) : (
            <Lane key={project.projectId} project={project} />
          ),
        )
      )}
    </section>
  );
}

function OrchestratorChip({ project }: { readonly project: AgentBoardProject }): React.JSX.Element {
  const app = useAgentApp();
  const [runtime, setRuntime] = useState<Runtime>("claude");
  const orchestrator = project.agents.find((agent) => agent.role === "project-orchestrator");
  if (orchestrator !== undefined) {
    const presence = app.presence(orchestrator);
    return (
      <button className="ag-agent-chip" type="button" onClick={() => app.openChat(orchestrator.id)}>
        <Avatar identity={app.identity(orchestrator)} size={20} presence={presence} />
        <span>
          {app.identity(orchestrator).name} · {presenceLabel(presence)}
        </span>
      </button>
    );
  }
  return (
    <span className="ag-start">
      <label className="ag-inline-select">
        <span className="sr-only">오케스트레이터 런타임</span>
        <select
          value={runtime}
          onChange={(event) => setRuntime(event.target.value as Runtime)}
          disabled={!app.mutationAllowed}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <button
        className="ag-button"
        type="button"
        disabled={!app.mutationAllowed}
        onClick={() =>
          void app.act("프로젝트 오케스트레이터를 시작했습니다.", () =>
            app.api.createManagedAgent({
              projectId: project.projectId,
              role: "project-orchestrator",
              runtime,
            }),
          )
        }
      >
        오케스트레이터 시작
      </button>
    </span>
  );
}

function Lane({ project }: { readonly project: AgentBoardProject }): React.JSX.Element {
  const app = useAgentApp();
  const progress = taskProgress(project.tasks);
  const name = app.projectName(project.projectId);
  const contract = app.inbox.find(
    (item) => item.kind === "contract" && item.projectId === project.projectId,
  );
  return (
    <article className="ag-lane" aria-label={`${name} 작업 흐름`}>
      <header className="ag-lane-head">
        <h3>
          <button
            className="ag-lane-title"
            type="button"
            onClick={() => app.openFlow(project.projectId)}
          >
            {name}
          </button>
        </h3>
        {progress.total > 0 && (
          <>
            <span className="ag-muted">
              {progress.done}/{progress.total} 완료
            </span>
            <Progress value={progress.done} total={progress.total} label={`${name} 완료한 작업`} />
          </>
        )}
        <span className="ag-grow" />
        <OrchestratorChip project={project} />
      </header>
      {contract !== undefined && (
        <button className="ag-callout" type="button" onClick={() => app.openDecision(contract)}>
          <Icon name="hand" size={15} />
          오케스트레이터가 의도 계약을 제안했습니다. 승인하면 계획대로 진행합니다.
          <span className="ag-link">검토하기</span>
        </button>
      )}
      {project.tasks.length === 0 ? (
        <p className="ag-lane-empty">
          아직 작업이 없습니다. 오케스트레이터가 계획을 세우면 여기에 그려집니다.
        </p>
      ) : (
        <TaskGraph
          project={project}
          variant="lane"
          onSelect={(task) => app.openFlow(project.projectId, task.id)}
        />
      )}
    </article>
  );
}

function CompactLane({ project }: { readonly project: AgentBoardProject }): React.JSX.Element {
  const app = useAgentApp();
  const progress = taskProgress(project.tasks);
  const name = app.projectName(project.projectId);
  const live = project.agents.filter((agent) => isLive(agent));
  const states = project.tasks.map((task) => ({
    task,
    state: taskState(task, taskWaitingFor(task, project, app.board.openHandoffs)),
  }));
  const next =
    states.find((entry) => entry.state.key === "waiting") ??
    states.find((entry) => entry.state.key === "running" || entry.state.key === "review") ??
    states.find((entry) => entry.state.key === "ready" || entry.state.key === "pending");
  return (
    <button
      className="ag-compact-lane"
      type="button"
      onClick={() => app.openFlow(project.projectId)}
    >
      <span className="ag-compact-head">
        <strong>{name}</strong>
        <span className="ag-muted">
          {progress.done}/{progress.total}
        </span>
      </span>
      <Progress value={progress.done} total={progress.total} label={`${name} 완료한 작업`} />
      <span className="ag-compact-foot">
        <span className="ag-avatar-stack" aria-hidden="true">
          {live.slice(0, 4).map((agent) => (
            <Avatar key={agent.id} identity={app.identity(agent)} size={20} />
          ))}
        </span>
        <span className="ag-compact-next" data-tone={next?.state.tone}>
          {next === undefined
            ? progress.total === 0
              ? "아직 작업이 없습니다"
              : "모두 끝났습니다"
            : next.state.key === "waiting"
              ? `${next.state.label}: ${next.task.title}`
              : next.state.key === "running" || next.state.key === "review"
                ? `${next.task.title} ${next.state.label}`
                : `다음: ${next.task.title}`}
        </span>
      </span>
    </button>
  );
}

function InboxColumn({ limit }: { readonly limit?: number }): React.JSX.Element {
  const app = useAgentApp();
  const [all, setAll] = useState(false);
  const shown = limit === undefined || all ? app.inbox : app.inbox.slice(0, limit);
  return (
    <section className="ag-inbox" aria-labelledby="ag-inbox-title">
      <header className="ag-section-head">
        <h2 id="ag-inbox-title">나를 기다리는 것</h2>
        {app.inbox.length > 0 && <Pill tone="accent">{app.inbox.length}</Pill>}
      </header>
      {app.inbox.length === 0 ? (
        <EmptyNote>지금은 기다리는 승인이나 결정이 없습니다.</EmptyNote>
      ) : (
        <ul className="ag-inbox-list">
          {shown.map((item) => (
            <li key={item.key}>
              <InboxCard item={item} />
            </li>
          ))}
        </ul>
      )}
      {shown.length < app.inbox.length && (
        <button className="ag-link" type="button" onClick={() => setAll(true)}>
          {app.inbox.length - shown.length}개 더 보기
        </button>
      )}
    </section>
  );
}

function Roster(): React.JSX.Element {
  const app = useAgentApp();
  const [cleanupOpen, setCleanupOpen] = useState(false);
  const stale = cleanupCandidates(app.board);
  const staleCount = stale.agents.length + stale.processes.length;
  const tasks = app.board.projects.flatMap((project) => project.tasks);
  const ordered = [...app.agents].sort(
    (left, right) =>
      PRESENCE_ORDER.indexOf(app.presence(left)) - PRESENCE_ORDER.indexOf(app.presence(right)) ||
      right.updatedAt.localeCompare(left.updatedAt),
  );
  const working = app.agents.filter((agent) => app.presence(agent) === "working").length;
  return (
    <section className="ag-roster" aria-labelledby="ag-roster-title">
      <header className="ag-section-head">
        <h2 id="ag-roster-title">에이전트</h2>
        <span className="ag-muted">
          {app.agents.length}명 · {working}명 일하는 중
        </span>
        {staleCount > 0 && (
          <button
            className="ag-link ag-grow-left"
            type="button"
            disabled={!app.mutationAllowed}
            onClick={() => setCleanupOpen(true)}
          >
            꺼진 에이전트 정리 {staleCount}
          </button>
        )}
      </header>
      {cleanupOpen && (
        <CleanupSheet
          agents={stale.agents}
          processes={stale.processes}
          onClose={() => setCleanupOpen(false)}
        />
      )}
      {ordered.length === 0 ? (
        <EmptyNote icon="bell">아직 에이전트가 없습니다.</EmptyNote>
      ) : (
        <ul className="ag-agent-list">
          {ordered.map((agent) => (
            <li key={agent.id}>
              <AgentRow agent={agent} tasks={tasks} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * "꺼진 에이전트 정리" (AP-D033): shows exactly what goes away before anything does. Records stay;
 * the lists and their Panes go.
 */
function CleanupSheet({
  agents,
  processes,
  onClose,
}: {
  readonly agents: readonly AgentSession[];
  readonly processes: readonly SharedProcess[];
  readonly onClose: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const [busy, setBusy] = useState(false);
  const count = agents.length + processes.length;
  return (
    <Sheet title="꺼진 에이전트 정리" onClose={onClose}>
      <p className="ag-muted">
        아래 {count}개를 관제실과 작업공간 목록에서 없애고, 남아 있는 Pane을 닫습니다. 지시, 작업,
        대화 기록은 그대로 남습니다. 정리한 에이전트는 다시 실행하지 않습니다.
      </p>
      <ul className="ag-cleanup-list">
        {agents.map((agent) => (
          <li key={agent.id}>
            <Avatar identity={app.identity(agent)} size={22} presence={app.presence(agent)} />
            <span>{app.identity(agent).name}</span>
            <span className="ag-muted">
              {app.projectName(agent.projectId)} · {presenceLabel(app.presence(agent))}
            </span>
          </li>
        ))}
        {processes.map((process) => (
          <li key={process.id}>
            <Icon name="terminal" size={18} />
            <span>{process.purpose}</span>
            <span className="ag-muted">
              {app.projectName(process.projectId)} · 프로세스 {processStatusLabel(process.status)}
            </span>
          </li>
        ))}
      </ul>
      <div className="ag-sheet-actions">
        <button className="ag-button" type="button" onClick={onClose}>
          취소
        </button>
        <button
          className="ag-button"
          data-variant="primary"
          type="button"
          disabled={busy || !app.mutationAllowed}
          onClick={() => {
            setBusy(true);
            void app
              .act(`${count}개를 정리했습니다.`, () =>
                app.api.cleanupAgents(
                  agents.map((agent) => agent.id),
                  processes.map((process) => process.id),
                ),
              )
              .then((done) => {
                setBusy(false);
                if (done) onClose();
              });
          }}
        >
          {count}개 정리
        </button>
      </div>
    </Sheet>
  );
}

function processStatusLabel(status: SharedProcess["status"]): string {
  switch (status) {
    case "exited":
      return "끝남";
    case "failed":
      return "실패";
    case "stopped":
      return "멈춤";
    default:
      return "확인 필요";
  }
}

export function AgentRow({
  agent,
  tasks,
  selected = false,
}: {
  readonly agent: AgentSession;
  readonly tasks: Parameters<typeof agentActivity>[3];
  readonly selected?: boolean;
}): React.JSX.Element {
  const app = useAgentApp();
  const presence = app.presence(agent);
  const identity = app.identity(agent);
  const activity = agentActivity(agent, presence, app.inbox, tasks);
  const project = projectTag(app, agent);
  return (
    <button
      type="button"
      className="ag-agent-row"
      data-presence={presence}
      aria-current={selected ? "true" : undefined}
      aria-label={`${identity.name}${project === null ? "" : ` (${project})`}, ${presenceLabel(presence)}, ${activity}`}
      onClick={() => app.openChat(agent.id)}
    >
      <Avatar identity={identity} size={30} presence={presence} />
      <span className="ag-agent-text">
        <span className="ag-agent-name">
          {identity.name}
          {project !== null && <span className="ag-agent-project">{project}</span>}
        </span>
        <span className="ag-agent-activity">{activity}</span>
      </span>
      <span className="ag-agent-time">{ago(agent.updatedAt, app.now)}</span>
    </button>
  );
}

/** Workers are numbered per project; with several projects their rows say which one. */
function projectTag(app: ReturnType<typeof useAgentApp>, agent: AgentSession): string | null {
  if (agent.projectId === null || agent.role === "project-orchestrator") return null;
  return app.board.projects.length > 1 ? app.projectName(agent.projectId) : null;
}

type Range = "1h" | "2h" | "today";

const RANGES: readonly { readonly id: Range; readonly label: string }[] = [
  { id: "1h", label: "1시간" },
  { id: "2h", label: "2시간" },
  { id: "today", label: "오늘" },
];

function Timeline(): React.JSX.Element {
  const app = useAgentApp();
  const [range, setRange] = useState<Range>("2h");
  const end = app.now;
  const start =
    range === "1h" ? end - 3_600_000 : range === "2h" ? end - 7_200_000 : startOfDay(end);
  const tasks = useMemo(() => app.board.projects.flatMap((project) => project.tasks), [app.board]);
  const rows = useMemo(
    () => timelineRows(app.events, app.agents, tasks, { start, end }),
    [app.events, app.agents, tasks, start, end],
  );
  const span = Math.max(1, end - start);
  const step = range === "1h" ? 900_000 : range === "2h" ? 1_800_000 : 7_200_000;
  const ticks: number[] = [];
  for (let tick = Math.ceil(start / step) * step; tick < end; tick += step) ticks.push(tick);
  const at = (time: number) => `${((time - start) / span) * 100}%`;
  return (
    <section className="ag-timeline" aria-labelledby="ag-timeline-title">
      <header className="ag-section-head">
        <h2 id="ag-timeline-title">타임라인</h2>
        <span className="ag-muted">누가 언제 일했는지</span>
        <span className="ag-grow" />
        <div className="ag-segmented" role="group" aria-label="기간">
          {RANGES.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-pressed={range === item.id}
              onClick={() => setRange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
      </header>
      {rows.length === 0 ? (
        <EmptyNote icon="bell">이 기간에 일한 에이전트가 없습니다.</EmptyNote>
      ) : (
        <div className="ag-tl">
          <div className="ag-tl-axis" aria-hidden="true">
            <span />
            <span className="ag-tl-track">
              {ticks.map((tick) => (
                <span key={tick} className="ag-tl-tick" style={{ left: at(tick) }}>
                  {clock(tick)}
                </span>
              ))}
            </span>
          </div>
          <ul className="ag-tl-rows">
            {rows.map((row) => {
              const identity = app.identity(row.agent);
              return (
                <li key={row.agent.id} className="ag-tl-row">
                  <button
                    className="ag-tl-label"
                    type="button"
                    onClick={() => app.openChat(row.agent.id)}
                  >
                    <Avatar identity={identity} size={20} />
                    <span>
                      {identity.name}
                      {projectTag(app, row.agent) !== null && (
                        <span className="ag-agent-project">{projectTag(app, row.agent)}</span>
                      )}
                    </span>
                  </button>
                  <span
                    className="ag-tl-track"
                    style={{ "--row-color": identity.color } as React.CSSProperties}
                  >
                    {ticks.map((tick) => (
                      <span
                        key={tick}
                        className="ag-tl-grid"
                        style={{ left: at(tick) }}
                        aria-hidden="true"
                      />
                    ))}
                    {row.segments.map((segment) => (
                      <span
                        key={`${segment.kind}-${segment.start}`}
                        className="ag-tl-bar"
                        data-kind={segment.kind}
                        style={{
                          left: at(segment.start),
                          width: `max(3px, ${((segment.end - segment.start) / span) * 100}%)`,
                        }}
                        title={`${segment.label ?? "일함"} · ${clock(segment.start)}–${clock(segment.end)}`}
                      >
                        <span>{segment.label}</span>
                      </span>
                    ))}
                    {row.marks.map((mark) => (
                      <span
                        key={`${mark.kind}-${mark.at}`}
                        className="ag-tl-mark"
                        data-kind={mark.kind}
                        style={{ left: at(mark.at) }}
                        title={`${mark.kind === "ask" ? "사람에게 물음" : "병합"} · ${clock(mark.at)}`}
                      />
                    ))}
                    <span className="ag-tl-now" aria-hidden="true" />
                  </span>
                </li>
              );
            })}
          </ul>
          <ul className="ag-tl-legend" aria-label="타임라인 표시">
            <li data-kind="work">일한 시간</li>
            <li data-kind="mine">내가 직접</li>
            <li data-kind="ask">사람에게 물음</li>
            <li data-kind="merge">병합</li>
          </ul>
        </div>
      )}
    </section>
  );
}
