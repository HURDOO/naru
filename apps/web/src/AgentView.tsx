import type {
  AgentEvent,
  AgentOverview,
  AgentRuntimeState,
  AgentSession,
  AgentTask,
  Handoff,
  SharedProcess,
} from "@naru/contracts/naru-agent/v1";
import {
  type FormEvent,
  type KeyboardEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { agentEvents, mergeEvents } from "./agent-events";
import { historyEntries, type HistoryEntry } from "./agent-history";
import {
  agentTitle,
  agentTone,
  approvalKindLabel,
  eventLabel,
  handoffKindLabel,
  processStatusLabel,
  processTone,
  statusLabel,
  taskStatusLabel,
  taskTone,
  timeLabel,
  writerLabel,
} from "./agent-labels";
import { AgentLink, HomeOverview, ProjectOverview, TaskDetail } from "./AgentOverview";
import { ApiFailure, type AgentProjectView, type NaruApi } from "./api";

type Selection =
  | { readonly kind: "home" }
  | { readonly kind: "project" }
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "task"; readonly id: string }
  | { readonly kind: "handoff"; readonly id: string }
  | { readonly kind: "process"; readonly id: string };

const PROJECT_POLL_MS = 3_000;
const RUNTIME_POLL_MS = 2_000;
const HISTORY_PAGES = 10;
/** History also refreshes on its own: a short turn can start and end between two polls. */
const HISTORY_REFRESH_MS = 8_000;
/** Events kept for Activity: the newest page on open, then whatever arrives. */
const EVENT_FIRST_PAGE = 300;
const EVENT_PAGE = 500;
const EVENT_WINDOW = 1_000;
const ACTIVITY_ITEMS = 40;

interface AgentViewProps {
  readonly api: NaruApi;
  readonly projectId: string;
  /** Every project the user has, for Home's names and switching. */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** Changes need the human device lease (AP-D005 first layer). */
  readonly mutationAllowed: boolean;
  /** Shows an agent's or process's Pane in the workspace (TUI, console, terminal). */
  readonly onOpenPane: (paneId: string) => void;
  readonly onSelectProject: (projectId: string) => void;
  /** Opened from a handoff alert: start on that Inbox item. */
  readonly initialHandoffId?: string | null;
}

/**
 * The project's agents (AP-T17): Home across projects, the project's plan and task graph, who works
 * on what, the conversation writer, approvals, the runtime's own history, activity, open questions
 * for the user and shared processes. Everything is read from and written through Naru's agent API;
 * nothing here is a mock.
 */
export function AgentView({
  api,
  projectId,
  projects,
  mutationAllowed,
  onOpenPane,
  onSelectProject,
  initialHandoffId = null,
}: AgentViewProps): React.JSX.Element {
  const [view, setView] = useState<AgentProjectView | null>(null);
  const [overview, setOverview] = useState<AgentOverview | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection | null>(() =>
    initialHandoffId === null ? null : { kind: "handoff", id: initialHandoffId },
  );
  const [status, setStatus] = useState<string>("");
  const detailRef = useRef<HTMLDivElement | null>(null);
  const eventsLoaded = useRef(false);
  const lastSeq = useRef(0);

  const loadEvents = useCallback(async () => {
    if (!eventsLoaded.current) {
      const first = await api.agentEvents(projectId, 0, {
        limit: EVENT_FIRST_PAGE,
        latest: true,
      });
      eventsLoaded.current = true;
      lastSeq.current = first.at(-1)?.seq ?? 0;
      setEvents(first);
      return;
    }
    for (;;) {
      const page = await api.agentEvents(projectId, lastSeq.current, { limit: EVENT_PAGE });
      if (page.length === 0) return;
      lastSeq.current = page.at(-1)!.seq;
      setEvents((current) => mergeEvents(current, page, EVENT_WINDOW));
      if (page.length < EVENT_PAGE) return;
    }
  }, [api, projectId]);

  const refresh = useCallback(async () => {
    try {
      const [nextView, nextOverview] = await Promise.all([
        api.agentProject(projectId),
        api.agentOverview(),
        loadEvents(),
      ]);
      setView(nextView);
      setOverview(nextOverview);
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [api, projectId, loadEvents]);

  useEffect(() => {
    // The parent keys this view by project, so a project change starts from empty state.
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), PROJECT_POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const act = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action();
        setStatus(label);
        await refresh();
        return true;
      } catch (failure) {
        setStatus(messageOf(failure));
        return false;
      }
    },
    [refresh],
  );

  const selectionKey =
    selection === null ? "" : `${selection.kind}:${"id" in selection ? selection.id : ""}`;
  useEffect(() => {
    // A different record opens at its top, not at the previous one's scroll position.
    if (detailRef.current !== null) detailRef.current.scrollTop = 0;
  }, [selectionKey]);

  const selectAgent = (id: string) => setSelection({ kind: "agent", id });
  const selectTask = (id: string) => setSelection({ kind: "task", id });
  const selectHandoff = (id: string) => setSelection({ kind: "handoff", id });
  const projectName = projects.find((project) => project.id === projectId)?.name ?? "프로젝트";
  const allAgents = useMemo(
    () => [...(view?.agents ?? []), ...(overview?.globalAgents ?? [])],
    [view, overview],
  );

  const selectedAgent =
    selection?.kind === "agent" ? allAgents.find((agent) => agent.id === selection.id) : undefined;
  const selectedHandoff =
    selection?.kind === "handoff"
      ? (view?.openHandoffs.find((handoff) => handoff.id === selection.id) ??
        overview?.openHandoffs.find((handoff) => handoff.id === selection.id))
      : undefined;
  const selectedProcess =
    selection?.kind === "process"
      ? view?.processes.find((process) => process.id === selection.id)
      : undefined;

  return (
    <section className="agent-view" aria-label="에이전트">
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {error !== null && (
        <div className="notice" role="alert">
          <span>{error}</span>
        </div>
      )}
      <div className="agent-view-columns" data-has-selection={selection !== null}>
        <nav className="agent-list" aria-label="에이전트와 프로세스">
          <section className="agent-list-section" aria-label="보기">
            <h2>보기</h2>
            <ul>
              <li>
                <button
                  type="button"
                  className="agent-list-item"
                  data-tone="quiet"
                  aria-current={selection?.kind === "home" ? "true" : undefined}
                  onClick={() => setSelection({ kind: "home" })}
                >
                  <span className="agent-list-label">전체 현황</span>
                  <span className="agent-list-detail">
                    {overview === null
                      ? "모든 프로젝트"
                      : `프로젝트 ${overview.projects.length}개 · 결정 대기 ${overview.openHandoffs.length}건`}
                  </span>
                </button>
              </li>
              <li>
                <button
                  type="button"
                  className="agent-list-item"
                  data-tone="quiet"
                  aria-current={
                    selection === null || selection.kind === "project" || selection.kind === "task"
                      ? "true"
                      : undefined
                  }
                  onClick={() => setSelection({ kind: "project" })}
                >
                  <span className="agent-list-label">프로젝트 개요</span>
                  <span className="agent-list-detail">
                    {view === null
                      ? "계획과 작업 그래프"
                      : `작업 ${view.tasks.length}개${view.activePlan === null ? " · 계획 없음" : ` · 계획 v${view.activePlan.version}`}`}
                  </span>
                </button>
              </li>
            </ul>
          </section>
          <AgentListSection
            title="에이전트"
            empty="아직 에이전트가 없습니다."
            items={(view?.agents ?? []).map((agent) => ({
              id: agent.id,
              label: agentTitle(agent),
              detail: `${statusLabel(agent.status)} · ${writerLabel(agent)}`,
              tone: agentTone(agent),
            }))}
            selectedId={selection?.kind === "agent" ? selection.id : null}
            onSelect={selectAgent}
          />
          <CreateAgentForm
            disabled={!mutationAllowed}
            onCreate={(role, runtime) =>
              act("에이전트를 시작했습니다.", () =>
                api.createManagedAgent({ projectId, role, runtime }),
              )
            }
          />
          <AgentListSection
            title={`Inbox${view !== null && view.openHandoffs.length > 0 ? ` (${view.openHandoffs.length})` : ""}`}
            empty="답할 질문이 없습니다."
            items={(view?.openHandoffs ?? []).map((handoff) => ({
              id: handoff.id,
              label: handoffKindLabel(handoff.kind),
              detail: handoff.payload.reason,
              tone: "attention",
            }))}
            selectedId={selection?.kind === "handoff" ? selection.id : null}
            onSelect={selectHandoff}
          />
          <AgentListSection
            title="공유 프로세스"
            empty="실행 중인 프로세스가 없습니다."
            items={(view?.processes ?? []).map((process) => ({
              id: process.id,
              label: process.purpose,
              detail: `${processStatusLabel(process.status)}${process.humanHoldSince !== null ? " · 사람이 사용 중" : ""}`,
              tone: process.humanHoldSince !== null ? "held" : processTone(process),
            }))}
            selectedId={selection?.kind === "process" ? selection.id : null}
            onSelect={(id) => setSelection({ kind: "process", id })}
          />
        </nav>
        <div className="agent-detail" ref={detailRef}>
          {selection !== null && (
            <button
              className="quiet-button agent-back"
              type="button"
              onClick={() => setSelection(null)}
            >
              ← 목록
            </button>
          )}
          {view === null && error === null ? (
            <div className="inline-loading">
              <span /> 에이전트 정보를 여는 중…
            </div>
          ) : selection?.kind === "home" ? (
            <HomeOverview
              overview={overview}
              projects={projects}
              currentProjectId={projectId}
              mutationAllowed={mutationAllowed}
              act={act}
              api={api}
              onSelectProject={(id) => {
                if (id === projectId) setSelection({ kind: "project" });
                else onSelectProject(id);
              }}
              onSelectAgent={selectAgent}
              onSelectHandoff={(handoff) => {
                if (handoff.projectId === null || handoff.projectId === projectId) {
                  selectHandoff(handoff.id);
                } else {
                  onSelectProject(handoff.projectId);
                }
              }}
            />
          ) : selectedAgent !== undefined && view !== null ? (
            <AgentDetail
              key={selectedAgent.id}
              api={api}
              agent={selectedAgent}
              tasks={view.tasks}
              agents={allAgents}
              events={events}
              mutationAllowed={mutationAllowed}
              act={act}
              onOpenPane={onOpenPane}
              onSelectAgent={selectAgent}
              onSelectTask={selectTask}
            />
          ) : selection?.kind === "task" && view !== null ? (
            <TaskDetail
              key={selection.id}
              api={api}
              taskId={selection.id}
              view={view}
              onSelectAgent={selectAgent}
              onSelectTask={selectTask}
              onSelectHandoff={selectHandoff}
            />
          ) : selectedHandoff !== undefined ? (
            <HandoffDetail
              key={selectedHandoff.id}
              handoff={selectedHandoff}
              mutationAllowed={mutationAllowed}
              onResolve={(decision, option) =>
                act("결정을 보냈습니다.", () =>
                  api.resolveHandoff(selectedHandoff.id, decision, option),
                ).then((done) => {
                  if (done) setSelection(null);
                })
              }
            />
          ) : selectedProcess !== undefined ? (
            <ProcessDetail
              process={selectedProcess}
              mutationAllowed={mutationAllowed}
              act={act}
              api={api}
              onOpenPane={onOpenPane}
            />
          ) : view !== null ? (
            <ProjectOverview
              api={api}
              projectId={projectId}
              projectName={projectName}
              view={view}
              mutationAllowed={mutationAllowed}
              act={act}
              onSelectAgent={selectAgent}
              onSelectTask={selectTask}
            />
          ) : null}
        </div>
      </div>
    </section>
  );
}

function AgentListSection({
  title,
  empty,
  items,
  selectedId,
  onSelect,
}: {
  readonly title: string;
  readonly empty: string;
  readonly items: readonly {
    readonly id: string;
    readonly label: string;
    readonly detail: string;
    readonly tone: string;
  }[];
  readonly selectedId: string | null;
  readonly onSelect: (id: string) => void;
}): React.JSX.Element {
  return (
    <section className="agent-list-section" aria-label={title}>
      <h2>{title}</h2>
      {items.length === 0 ? (
        <p className="agent-list-empty">{empty}</p>
      ) : (
        <ul>
          {items.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="agent-list-item"
                data-tone={item.tone}
                aria-current={item.id === selectedId ? "true" : undefined}
                onClick={() => onSelect(item.id)}
              >
                <span className="agent-list-label">{item.label}</span>
                <span className="agent-list-detail">{item.detail}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function CreateAgentForm({
  disabled,
  onCreate,
}: {
  readonly disabled: boolean;
  readonly onCreate: (
    role: "project-orchestrator" | "worker" | "reviewer" | "specialist",
    runtime: "claude" | "codex",
  ) => Promise<boolean>;
}): React.JSX.Element {
  const [role, setRole] = useState<"project-orchestrator" | "worker" | "reviewer" | "specialist">(
    "worker",
  );
  const [runtime, setRuntime] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="agent-create"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        void onCreate(role, runtime).finally(() => setBusy(false));
      }}
    >
      <label>
        역할
        <select
          value={role}
          onChange={(event) => setRole(event.target.value as typeof role)}
          disabled={disabled}
        >
          <option value="project-orchestrator">프로젝트 오케스트레이터</option>
          <option value="worker">작업자</option>
          <option value="reviewer">리뷰어</option>
          <option value="specialist">전문가</option>
        </select>
      </label>
      <label>
        런타임
        <select
          value={runtime}
          onChange={(event) => setRuntime(event.target.value as typeof runtime)}
          disabled={disabled}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <button className="secondary-button compact" type="submit" disabled={disabled || busy}>
        새 에이전트
      </button>
    </form>
  );
}

function AgentDetail({
  api,
  agent,
  tasks,
  agents,
  events,
  mutationAllowed,
  act,
  onOpenPane,
  onSelectAgent,
  onSelectTask,
}: {
  readonly api: NaruApi;
  readonly agent: AgentSession;
  readonly tasks: readonly AgentTask[];
  /** The project's agents and the global ones, for parent and child links. */
  readonly agents: readonly AgentSession[];
  readonly events: readonly AgentEvent[];
  readonly mutationAllowed: boolean;
  readonly act: (label: string, action: () => Promise<unknown>) => Promise<boolean>;
  readonly onOpenPane: (paneId: string) => void;
  readonly onSelectAgent: (agentSessionId: string) => void;
  readonly onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const [tab, setTab] = useState<"chat" | "activity">("chat");
  const [runtime, setRuntime] = useState<AgentRuntimeState | null>(null);
  const [runtimeIssue, setRuntimeIssue] = useState<string | null>(null);
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [instruction, setInstruction] = useState("");
  const [turn, setTurn] = useState("");
  const managed = agent.paneId !== null;
  const held = agent.humanHoldSince !== null;
  const humanWritesInChat = runtime?.writer === "gui";
  const wasActive = useRef(false);

  const loadHistory = useCallback(async () => {
    try {
      const items: unknown[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < HISTORY_PAGES; page += 1) {
        const result = await api.agentHistory(agent.id, cursor);
        items.push(...result.items);
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      setHistory(historyEntries(items).slice(-120));
    } catch (failure) {
      setHistory(null);
      setRuntimeIssue(messageOf(failure));
    }
  }, [api, agent.id]);

  useEffect(() => {
    if (!managed) return;
    let stopped = false;
    const poll = async (): Promise<void> => {
      try {
        const next = await api.agentRuntime(agent.id);
        if (stopped) return;
        setRuntime(next);
        setRuntimeIssue(null);
        // A turn that just ended changed the conversation: read it again from the runtime.
        if (wasActive.current && !next.turnActive) void loadHistory();
        wasActive.current = next.turnActive;
      } catch (failure) {
        if (!stopped) setRuntimeIssue(messageOf(failure));
      }
    };
    const first = window.setTimeout(() => {
      void poll();
      void loadHistory();
    }, 0);
    const timer = window.setInterval(() => void poll(), RUNTIME_POLL_MS);
    const historyTimer = window.setInterval(() => void loadHistory(), HISTORY_REFRESH_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      window.clearInterval(historyTimer);
    };
  }, [api, agent.id, managed, loadHistory]);

  const live = agent.status === "starting" || agent.status === "active" || agent.status === "idle";

  return (
    <article className="agent-panel" aria-labelledby={`agent-${agent.id}`}>
      <header className="agent-panel-header">
        <div>
          <h2 id={`agent-${agent.id}`}>{agentTitle(agent)}</h2>
          <p className="agent-panel-meta">
            <span data-tone={agentTone(agent)} className="agent-badge">
              {statusLabel(agent.status)}
            </span>
            <span>작성자: {writerLabel(agent)}</span>
            {runtime !== null && runtime.children.length > 0 && (
              <span>보조 에이전트 {runtime.children.length}개 실행 중 (관찰만)</span>
            )}
          </p>
        </div>
        <div className="agent-panel-actions">
          {agent.paneId !== null && (
            <button
              className="quiet-button"
              type="button"
              onClick={() => onOpenPane(agent.paneId!)}
            >
              {agent.launchMode === "tui" || agent.runtime === "codex" ? "TUI 보기" : "콘솔 보기"}
            </button>
          )}
          {managed &&
            (live ? (
              <button
                className="quiet-button"
                type="button"
                disabled={!mutationAllowed}
                onClick={() => void act("에이전트를 정지했습니다.", () => api.stopAgent(agent.id))}
              >
                정지
              </button>
            ) : (
              <button
                className="secondary-button compact"
                type="button"
                disabled={!mutationAllowed}
                onClick={() =>
                  void act("에이전트를 다시 실행했습니다.", () => api.launchAgent(agent.id))
                }
              >
                다시 실행
              </button>
            ))}
        </div>
      </header>

      {runtimeIssue !== null && managed && (
        <p className="agent-panel-issue" role="status">
          {runtimeIssue}
        </p>
      )}

      <section className="agent-panel-section" aria-label="개입">
        <h3>개입</h3>
        {held ? (
          <div className="agent-intervention">
            <p>
              지금 사람이 직접 다루고 있습니다. 그동안 오케스트레이터의 지시는 받지 않고, 돌려주면
              오케스트레이터가 다시 이어 갑니다.
            </p>
            <button
              className="primary-button compact"
              type="button"
              disabled={!mutationAllowed}
              onClick={() =>
                void act("에이전트에게 돌려줬습니다.", () => api.setAgentHold(agent.id, false))
              }
            >
              에이전트에게 돌려주기
            </button>
          </div>
        ) : (
          <div className="agent-intervention">
            <button
              className="secondary-button compact"
              type="button"
              disabled={!mutationAllowed || !managed || !live}
              onClick={() =>
                void act("Chat으로 개입했습니다.", () => api.setAgentHold(agent.id, true, "chat"))
              }
            >
              Chat으로 직접 개입
            </button>
            <button
              className="secondary-button compact"
              type="button"
              disabled={!mutationAllowed || !managed || !live}
              onClick={() =>
                void act("TUI로 개입했습니다.", () => api.setAgentHold(agent.id, true, "tui")).then(
                  (done) => {
                    if (done && agent.paneId !== null) onOpenPane(agent.paneId);
                  },
                )
              }
            >
              TUI로 직접 개입
            </button>
          </div>
        )}
      </section>

      <section className="agent-panel-section" aria-label="지시만 보내기">
        <h3>지시만 보내기</h3>
        <form
          className="agent-composer"
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            const text = instruction.trim();
            if (text === "") return;
            void act("지시를 기록했습니다. 다음 차례에 반영됩니다.", () =>
              api.createInstruction(
                { kind: "agent", projectId: agent.projectId, agentSessionId: agent.id },
                text,
              ),
            ).then((done) => {
              if (done) setInstruction("");
            });
          }}
        >
          <label className="sr-only" htmlFor={`instruction-${agent.id}`}>
            이 에이전트에게 보낼 지시
          </label>
          <textarea
            id={`instruction-${agent.id}`}
            value={instruction}
            onChange={(event) => setInstruction(event.target.value)}
            placeholder="개입하지 않고 지시만 남깁니다. 원문 그대로 기록됩니다."
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
      </section>

      {runtime !== null && runtime.pendingApprovals.length > 0 && (
        <section className="agent-panel-section" aria-label="승인 대기">
          <h3>승인 대기</h3>
          <ul className="agent-approvals">
            {runtime.pendingApprovals.map((approval) => (
              <li key={approval.requestId}>
                <span>{approvalKindLabel(approval.kind)} 요청</span>
                {humanWritesInChat ? (
                  <span className="agent-approval-actions">
                    <button
                      className="primary-button compact"
                      type="button"
                      disabled={!mutationAllowed}
                      onClick={() =>
                        void act("승인했습니다.", () =>
                          api.respondAgentApproval(
                            agent.id,
                            approval.requestId,
                            "approve",
                            runtime.generation,
                          ),
                        )
                      }
                    >
                      승인
                    </button>
                    <button
                      className="quiet-button"
                      type="button"
                      disabled={!mutationAllowed}
                      onClick={() =>
                        void act("거부했습니다.", () =>
                          api.respondAgentApproval(
                            agent.id,
                            approval.requestId,
                            "deny",
                            runtime.generation,
                          ),
                        )
                      }
                    >
                      거부
                    </button>
                  </span>
                ) : (
                  <span className="agent-hint">Chat으로 개입하면 답할 수 있습니다.</span>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="agent-tabs" role="tablist" aria-label="에이전트 보기">
        {(
          [
            ["chat", "대화"],
            ["activity", "활동"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            id={`agent-tab-${agent.id}-${id}`}
            type="button"
            role="tab"
            aria-selected={tab === id}
            aria-controls={`agent-tabpanel-${agent.id}-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
            onKeyDown={(event: KeyboardEvent<HTMLButtonElement>) => {
              if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
              event.preventDefault();
              const next = tab === "chat" ? "activity" : "chat";
              setTab(next);
              document.getElementById(`agent-tab-${agent.id}-${next}`)?.focus();
            }}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "chat" ? (
        <section
          className="agent-panel-section agent-conversation"
          id={`agent-tabpanel-${agent.id}-chat`}
          role="tabpanel"
          aria-labelledby={`agent-tab-${agent.id}-chat`}
        >
          <div className="agent-conversation-header">
            <h3 className="sr-only">대화</h3>
            {humanWritesInChat && runtime?.turnActive === true && (
              <button
                className="quiet-button"
                type="button"
                disabled={!mutationAllowed}
                onClick={() =>
                  void act("중단했습니다.", () => api.interruptAgent(agent.id, runtime.generation))
                }
              >
                중단
              </button>
            )}
          </div>
          <ConversationLog entries={history} turnActive={runtime?.turnActive === true} />
          {humanWritesInChat && runtime !== null && (
            <form
              className="agent-composer"
              onSubmit={(event: FormEvent) => {
                event.preventDefault();
                const text = turn.trim();
                if (text === "") return;
                void act("보냈습니다.", () =>
                  api.sendAgentTurn(agent.id, text, runtime.generation),
                ).then((done) => {
                  if (!done) return;
                  setTurn("");
                  window.setTimeout(() => void loadHistory(), 1_500);
                });
              }}
            >
              <label className="sr-only" htmlFor={`turn-${agent.id}`}>
                에이전트에게 직접 쓰기
              </label>
              <textarea
                id={`turn-${agent.id}`}
                value={turn}
                onChange={(event) => setTurn(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                    event.preventDefault();
                    event.currentTarget.form?.requestSubmit();
                  }
                }}
                placeholder="에이전트에게 직접 씁니다 (⌘/Ctrl+Enter로 보내기)"
                rows={3}
                disabled={!mutationAllowed}
              />
              <button
                className="primary-button compact"
                type="submit"
                disabled={!mutationAllowed || turn.trim() === "" || runtime.turnActive}
              >
                보내기
              </button>
            </form>
          )}
        </section>
      ) : (
        <AgentActivity
          agent={agent}
          runtime={runtime}
          tasks={tasks}
          agents={agents}
          events={events}
          onSelectAgent={onSelectAgent}
          onSelectTask={onSelectTask}
        />
      )}
    </article>
  );
}

/**
 * Activity (SOURCE_SPEC §10): the agent's tasks, its parent and children (managed ones Naru runs,
 * native subagents it only observes, AP-D014) and the events it caused. Events hold metadata only.
 */
function AgentActivity({
  agent,
  runtime,
  tasks,
  agents,
  events,
  onSelectAgent,
  onSelectTask,
}: {
  readonly agent: AgentSession;
  readonly runtime: AgentRuntimeState | null;
  readonly tasks: readonly AgentTask[];
  readonly agents: readonly AgentSession[];
  readonly events: readonly AgentEvent[];
  readonly onSelectAgent: (agentSessionId: string) => void;
  readonly onSelectTask: (taskId: string) => void;
}): React.JSX.Element {
  const assigned = tasks.filter((task) => task.assigneeAgentSessionId === agent.id);
  const parent = agents.find((candidate) => candidate.id === agent.parentAgentSessionId);
  const managedChildren = agents.filter((candidate) => candidate.parentAgentSessionId === agent.id);
  const nativeChildren = runtime?.children ?? [];
  const recent = agentEvents(events, agent.id).slice(-ACTIVITY_ITEMS).reverse();
  const taskTitle = (taskId: string | null) =>
    taskId === null ? undefined : tasks.find((task) => task.id === taskId)?.title;
  return (
    <div
      className="agent-activity"
      id={`agent-tabpanel-${agent.id}-activity`}
      role="tabpanel"
      aria-labelledby={`agent-tab-${agent.id}-activity`}
    >
      <section className="agent-panel-section" aria-label="맡은 작업">
        <h3>맡은 작업</h3>
        {assigned.length === 0 ? (
          <p className="agent-hint">맡은 작업이 없습니다.</p>
        ) : (
          <ul className="agent-link-list">
            {assigned.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className="agent-list-item"
                  data-tone={taskTone(task.status)}
                  onClick={() => onSelectTask(task.id)}
                >
                  <span className="agent-list-label">{task.title}</span>
                  <span className="agent-list-detail">{taskStatusLabel(task.status)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent-panel-section" aria-label="관계">
        <h3>관계</h3>
        {parent === undefined && managedChildren.length === 0 && nativeChildren.length === 0 ? (
          <p className="agent-hint">상위·하위 에이전트가 없습니다.</p>
        ) : (
          <ul className="agent-link-list">
            {parent !== undefined && (
              <li>
                <span className="agent-hint">상위</span>
                <AgentLink agent={parent} onSelect={onSelectAgent} />
              </li>
            )}
            {managedChildren.map((child) => (
              <li key={child.id}>
                <span className="agent-hint">Naru가 실행한 하위 에이전트</span>
                <AgentLink agent={child} onSelect={onSelectAgent} />
              </li>
            ))}
            {nativeChildren.map((child) => (
              <li key={child.childRef} className="agent-native-child">
                <span className="agent-list-label">
                  {agent.runtime === "codex" ? "Codex" : "Claude"} 보조 에이전트
                </span>
                <span className="agent-list-detail">
                  {timeLabel(child.startedAt)}부터 실행 중 · 관찰만 (Naru에서 제어하지 않음)
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="agent-panel-section" aria-label="최근 활동">
        <h3>최근 활동</h3>
        {recent.length === 0 ? (
          <p className="agent-hint">기록된 활동이 없습니다.</p>
        ) : (
          <ol className="agent-records">
            {recent.map((event) => {
              const related = taskTitle(event.correlationId) ?? taskTitle(event.subjectId);
              return (
                <li key={event.id}>
                  <strong>{eventLabel(event)}</strong>
                  <span>
                    {timeLabel(event.createdAt)}
                    {related === undefined ? "" : ` · ${related}`}
                  </span>
                </li>
              );
            })}
          </ol>
        )}
      </section>
    </div>
  );
}

function ConversationLog({
  entries,
  turnActive,
}: {
  readonly entries: readonly HistoryEntry[] | null;
  readonly turnActive: boolean;
}): React.JSX.Element {
  const logRef = useRef<HTMLOListElement | null>(null);
  useEffect(() => {
    // Scroll only the log itself; scrollIntoView would also move the layout's hidden overflow.
    const log = logRef.current;
    if (log !== null) log.scrollTop = log.scrollHeight;
  }, [entries, turnActive]);
  if (entries === null) return <p className="agent-hint">대화 기록을 불러오는 중…</p>;
  if (entries.length === 0 && !turnActive) {
    return <p className="agent-hint">아직 대화가 없습니다.</p>;
  }
  return (
    <ol ref={logRef} className="agent-log" aria-live="polite">
      {entries.map((entry, index) => (
        <li key={index} data-role={entry.role}>
          <span className="agent-log-role">{roleLabel(entry.role)}</span>
          <p>{entry.text}</p>
        </li>
      ))}
      {turnActive && (
        <li data-role="assistant" className="agent-log-working">
          <span className="agent-log-role">에이전트</span>
          <p>작업 중…</p>
        </li>
      )}
    </ol>
  );
}

function HandoffDetail({
  handoff,
  mutationAllowed,
  onResolve,
}: {
  readonly handoff: Handoff;
  readonly mutationAllowed: boolean;
  readonly onResolve: (decision: string, option: string | null) => Promise<void>;
}): React.JSX.Element {
  const [option, setOption] = useState<string | null>(null);
  const [decision, setDecision] = useState("");
  const payload = handoff.payload;
  return (
    <article className="agent-panel" aria-labelledby={`handoff-${handoff.id}`}>
      <header className="agent-panel-header">
        <div>
          <h2 id={`handoff-${handoff.id}`}>{handoffKindLabel(handoff.kind)}</h2>
          <p className="agent-panel-meta">{payload.reason}</p>
        </div>
      </header>
      <dl className="agent-facts">
        <dt>추천</dt>
        <dd>{payload.recommendation}</dd>
        {payload.risks.length > 0 && (
          <>
            <dt>위험</dt>
            <dd>
              <ul>
                {payload.risks.map((risk) => (
                  <li key={risk}>{risk}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {payload.preparedEnvironment.length > 0 && (
          <>
            <dt>준비된 환경</dt>
            <dd>
              <ul>
                {payload.preparedEnvironment.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        {payload.independentWorkToContinue.length > 0 && (
          <>
            <dt>기다리는 동안 계속하는 일</dt>
            <dd>
              <ul>
                {payload.independentWorkToContinue.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </dd>
          </>
        )}
        <dt>재개 조건</dt>
        <dd>{payload.resumeCondition}</dd>
      </dl>
      <form
        className="agent-composer"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          const text = decision.trim() || option || "";
          if (text === "") return;
          void onResolve(text, option);
        }}
      >
        {payload.options.length > 0 && (
          <fieldset className="agent-options">
            <legend>선택지</legend>
            {payload.options.map((choice) => (
              <label key={choice.label}>
                <input
                  type="radio"
                  name={`handoff-option-${handoff.id}`}
                  value={choice.label}
                  checked={option === choice.label}
                  onChange={() => setOption(choice.label)}
                  disabled={!mutationAllowed}
                />
                <span>
                  <strong>{choice.label}</strong> {choice.description}
                </span>
              </label>
            ))}
          </fieldset>
        )}
        <label htmlFor={`decision-${handoff.id}`}>결정 (원문 그대로 에이전트에게 전달됩니다)</label>
        <textarea
          id={`decision-${handoff.id}`}
          value={decision}
          onChange={(event) => setDecision(event.target.value)}
          rows={3}
          disabled={!mutationAllowed}
        />
        <button
          className="primary-button compact"
          type="submit"
          disabled={!mutationAllowed || (decision.trim() === "" && option === null)}
        >
          결정 보내기
        </button>
      </form>
    </article>
  );
}

function ProcessDetail({
  api,
  process,
  mutationAllowed,
  act,
  onOpenPane,
}: {
  readonly api: NaruApi;
  readonly process: SharedProcess;
  readonly mutationAllowed: boolean;
  readonly act: (label: string, action: () => Promise<unknown>) => Promise<boolean>;
  readonly onOpenPane: (paneId: string) => void;
}): React.JSX.Element {
  const held = process.humanHoldSince !== null;
  const running = process.status === "running" || process.status === "starting";
  const ports = useMemo(() => process.ports.join(", "), [process.ports]);
  return (
    <article className="agent-panel" aria-labelledby={`process-${process.id}`}>
      <header className="agent-panel-header">
        <div>
          <h2 id={`process-${process.id}`}>{process.purpose}</h2>
          <p className="agent-panel-meta">
            <span className="agent-badge" data-tone={held ? "held" : processTone(process)}>
              {processStatusLabel(process.status)}
            </span>
            <span>{held ? "사람이 사용 중" : "에이전트가 사용 중"}</span>
            {ports !== "" && <span>포트 {ports}</span>}
          </p>
        </div>
        <div className="agent-panel-actions">
          {process.paneId !== null && (
            <button
              className="quiet-button"
              type="button"
              onClick={() => onOpenPane(process.paneId!)}
            >
              터미널 보기
            </button>
          )}
          {running && (
            <button
              className="quiet-button"
              type="button"
              disabled={!mutationAllowed}
              onClick={() =>
                void act("프로세스를 정지했습니다.", () => api.stopProcess(process.id))
              }
            >
              정지
            </button>
          )}
        </div>
      </header>
      <dl className="agent-facts">
        <dt>명령</dt>
        <dd>
          <code>{process.command}</code>
        </dd>
        <dt>유지</dt>
        <dd>{process.keep === "run" ? "실행이 끝나면 정지" : "정지할 때까지 유지"}</dd>
      </dl>
      {running && (
        <section className="agent-panel-section" aria-label="개입">
          <h3>개입</h3>
          {held ? (
            <div className="agent-intervention">
              <p>
                비밀번호 같은 값은 터미널 도구 모음의 &lsquo;비밀 입력&rsquo;으로 넣어 주세요. 다
                쓰고 돌려주면 에이전트가 화면을 다시 읽고 이어 갑니다.
              </p>
              <button
                className="primary-button compact"
                type="button"
                disabled={!mutationAllowed}
                onClick={() =>
                  void act("에이전트에게 돌려줬습니다.", () =>
                    api.setProcessHold(process.id, false),
                  )
                }
              >
                에이전트에게 돌려주기
              </button>
            </div>
          ) : (
            <div className="agent-intervention">
              <button
                className="secondary-button compact"
                type="button"
                disabled={!mutationAllowed}
                onClick={() =>
                  void act("터미널을 넘겨받았습니다.", () =>
                    api.setProcessHold(process.id, true),
                  ).then((done) => {
                    if (done && process.paneId !== null) onOpenPane(process.paneId);
                  })
                }
              >
                직접 개입
              </button>
            </div>
          )}
        </section>
      )}
    </article>
  );
}

function roleLabel(role: HistoryEntry["role"]): string {
  return role === "user" ? "지시" : role === "assistant" ? "에이전트" : "도구";
}

function messageOf(failure: unknown): string {
  if (failure instanceof ApiFailure) return failure.message;
  return "요청을 처리하지 못했습니다.";
}
