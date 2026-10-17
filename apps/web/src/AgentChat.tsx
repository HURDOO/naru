import type {
  AgentRuntimeState,
  AgentSession,
  AgentTask,
  AgentTaskDetail,
} from "@naru/contracts/naru-agent/v1";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import { useAgentApp, useTaskDetail } from "./agent-context";
import {
  type AskBlock,
  changeSummary,
  type ConversationBlock,
  conversationPages,
  type ToolCall,
  type ToolKind,
  toolSummary,
} from "./agent-conversation";
import {
  approvalKindLabel,
  artifactKindLabel,
  mergeReasonLabel,
  reviewKindLabel,
  reviewVerdictLabel,
  roleName,
} from "./agent-labels";
import {
  askKindLabel,
  clock,
  isLive,
  PRESENCE_ORDER,
  type Presence,
  presenceLabel,
  presenceTone,
  taskState,
  taskWaitingFor,
} from "./agent-model";
import { EmptyNote, ProcessRow } from "./AgentInbox";
import { Avatar, ChatMarkdown, Icon, type IconName, Pill } from "./agent-ui";
import { autosize, PHONE, submitOnEnter, useMedia } from "./agent-dom";
import { ApiFailure, type AgentInstructions } from "./api";
import { AgentRow } from "./ControlRoom";

const RUNTIME_POLL_MS = 2_000;
const HISTORY_ACTIVE_MS = 2_500;
const HISTORY_IDLE_MS = 8_000;
/** Pages read on the first load; a longer history shows its newest part after a note. */
const HISTORY_MAX_PAGES = 200;
/** Pages and screens the thread keeps read in above what the person sees (AP-D046). */
const OLDER_PAGES_AHEAD = 2;
const OLDER_SCREENS_AHEAD = 2;
const NO_PAGES: ReadonlyMap<string, number> = new Map();

/**
 * Talking with agents (Figma v1 D2/M2, AP-D022): sessions grouped by what they need, the
 * conversation with the person's and orchestrators' requests as bubbles and the agent's answers
 * as prose, tool calls folded into gray rows, approvals inline, and the task the agent works on.
 */
export function AgentChat({
  agentId,
  onBack,
}: {
  readonly agentId: string | null;
  readonly onBack: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const phone = useMedia(PHONE);
  const agent = app.agentById(agentId);
  if (phone) {
    return agent === undefined ? (
      <div className="ag-chat" data-phone="true">
        <SessionList selectedId={null} />
      </div>
    ) : (
      <div className="ag-chat" data-phone="true">
        <Conversation key={agent.id} agent={agent} onBack={onBack} />
      </div>
    );
  }
  return (
    <div className="ag-chat">
      <SessionList selectedId={agent?.id ?? null} />
      {agent === undefined ? (
        <div className="ag-chat-empty">
          <Icon name="chat" size={28} />
          <p>왼쪽에서 에이전트를 고르면 대화가 열립니다.</p>
        </div>
      ) : (
        <Conversation key={agent.id} agent={agent} onBack={onBack} />
      )}
    </div>
  );
}

const GROUPS: readonly { readonly title: string; readonly presences: readonly Presence[] }[] = [
  { title: "나를 기다림", presences: ["waiting"] },
  { title: "내가 직접 대화 중", presences: ["mine"] },
  { title: "일하는 중", presences: ["working", "starting"] },
  { title: "쉬는 중", presences: ["resting"] },
  { title: "멈춤", presences: ["stopped", "failed"] },
];

function SessionList({ selectedId }: { readonly selectedId: string | null }): React.JSX.Element {
  const app = useAgentApp();
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const tasks = app.board.projects.flatMap((project) => project.tasks);
  const needle = query.trim().toLowerCase();
  const matches = app.agents.filter((agent) => {
    if (needle === "") return true;
    const haystack = `${app.identity(agent).name} ${app.projectName(agent.projectId)} ${roleName(agent.role)}`;
    return haystack.toLowerCase().includes(needle);
  });
  return (
    <nav className="ag-sessions" aria-label="에이전트 대화 목록">
      <div className="ag-sessions-head">
        <label className="ag-search">
          <Icon name="search" size={14} />
          <span className="sr-only">에이전트 찾기</span>
          <input
            type="search"
            value={query}
            placeholder="에이전트·프로젝트 찾기"
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        <button
          className="ag-icon-button"
          type="button"
          aria-label="새 에이전트"
          aria-expanded={creating}
          onClick={() => setCreating((open) => !open)}
        >
          <Icon name="plus" size={18} />
        </button>
      </div>
      {creating && <CreateAgent onDone={() => setCreating(false)} />}
      {GROUPS.map((group) => {
        const members = matches
          .filter((agent) => group.presences.includes(app.presence(agent)))
          .sort(
            (left, right) =>
              PRESENCE_ORDER.indexOf(app.presence(left)) -
                PRESENCE_ORDER.indexOf(app.presence(right)) ||
              right.updatedAt.localeCompare(left.updatedAt),
          );
        if (members.length === 0) return null;
        return (
          <section key={group.title} className="ag-session-group" aria-label={group.title}>
            <h2 data-tone={group.presences[0] === "waiting" ? "accent" : undefined}>
              {group.title} <span>{members.length}</span>
            </h2>
            <ul className="ag-agent-list">
              {members.map((agent) => (
                <li key={agent.id}>
                  <AgentRow agent={agent} tasks={tasks} selected={agent.id === selectedId} />
                </li>
              ))}
            </ul>
          </section>
        );
      })}
      {matches.length === 0 && (
        <EmptyNote icon="bell">
          {app.agents.length === 0 ? "아직 에이전트가 없습니다." : "찾는 에이전트가 없습니다."}
        </EmptyNote>
      )}
    </nav>
  );
}

function CreateAgent({ onDone }: { readonly onDone: () => void }): React.JSX.Element {
  const app = useAgentApp();
  const [projectId, setProjectId] = useState(app.currentProjectId);
  const [role, setRole] = useState<"project-orchestrator" | "worker" | "reviewer" | "specialist">(
    "worker",
  );
  const [runtime, setRuntime] = useState<"claude" | "codex">("claude");
  const [busy, setBusy] = useState(false);
  return (
    <form
      className="ag-create"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        setBusy(true);
        void app
          .act("에이전트를 시작했습니다.", () =>
            app.api.createManagedAgent({ projectId, role, runtime }),
          )
          .then((done) => {
            setBusy(false);
            if (done) onDone();
          });
      }}
    >
      <label>
        <span>프로젝트</span>
        <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
          {app.projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        <span>역할</span>
        <select value={role} onChange={(event) => setRole(event.target.value as typeof role)}>
          <option value="project-orchestrator">프로젝트 오케스트레이터</option>
          <option value="worker">작업자</option>
          <option value="reviewer">리뷰어</option>
          <option value="specialist">전문가</option>
        </select>
      </label>
      <label>
        <span>런타임</span>
        <select
          value={runtime}
          onChange={(event) => setRuntime(event.target.value as typeof runtime)}
        >
          <option value="claude">Claude</option>
          <option value="codex">Codex</option>
        </select>
      </label>
      <button
        className="ag-button"
        data-variant="primary"
        type="submit"
        disabled={!app.mutationAllowed || busy}
      >
        시작
      </button>
    </form>
  );
}

// Conversation ----------------------------------------------------------------------------------

interface HistoryPages {
  /** Where each page starts, to read it again forward (null: the start). */
  readonly cursors: (string | null)[];
  readonly items: unknown[][];
  /** `before` for the page before the first one held; null once the start is held. */
  readonly older: string | null;
}

interface HeldConversation {
  readonly pages: HistoryPages;
  readonly instructions: AgentInstructions;
}

/**
 * Conversations read in this tab, by agent (AP-D045): opening one again shows it at once and reads
 * only what was added. The agents opened last are kept.
 */
const heldConversations = new Map<string, HeldConversation>();
const HELD_CONVERSATIONS = 8;

function holdConversation(agentId: string, held: HeldConversation): void {
  heldConversations.delete(agentId);
  heldConversations.set(agentId, held);
  for (const oldest of heldConversations.keys()) {
    if (heldConversations.size <= HELD_CONVERSATIONS) break;
    heldConversations.delete(oldest);
  }
}

/** Runtime state, instructions and history of one agent, re-read while the chat is open. */
function useAgentConversation(agent: AgentSession): {
  readonly runtime: AgentRuntimeState | null;
  readonly blocks: ConversationBlock[] | null;
  readonly issue: string | null;
  readonly truncated: boolean;
  readonly turnStartedAt: number | null;
  /** The runtime is down: nothing to read until it is launched again. */
  readonly paused: boolean;
  readonly reload: () => void;
  readonly older: OlderHistory;
} {
  const { api } = useAgentApp();
  const managed = agent.paneId !== null;
  const paused = managed && !isLive(agent);
  const held = heldConversations.get(agent.id);
  const [runtime, setRuntime] = useState<AgentRuntimeState | null>(null);
  const [pages, setPages] = useState<HistoryPages | null>(held?.pages ?? null);
  const [instructions, setInstructions] = useState<AgentInstructions>(
    held?.instructions ?? { instructions: [], origins: [] },
  );
  const [issue, setIssue] = useState<string | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [turnStartedAt, setTurnStartedAt] = useState<number | null>(null);
  const [olderLoading, setOlderLoading] = useState(false);
  const [olderFailed, setOlderFailed] = useState(false);
  const olderBusy = useRef(false);
  const pagesRef = useRef<HistoryPages | null>(held?.pages ?? null);
  const instructionsRef = useRef<AgentInstructions>(
    held?.instructions ?? { instructions: [], origins: [] },
  );
  const loading = useRef(false);
  const active = useRef(false);
  // Reading the newest pages and an older one each start from what is held: one at a time.
  const queue = useRef<Promise<void>>(Promise.resolve());

  const commit = useCallback(
    (next: HistoryPages, said: AgentInstructions = instructionsRef.current) => {
      pagesRef.current = next;
      instructionsRef.current = said;
      setPages(next);
      setInstructions(said);
      holdConversation(agent.id, { pages: next, instructions: said });
    },
    [agent.id],
  );

  const serial = useCallback((work: () => Promise<void>): Promise<void> => {
    const run = queue.current.then(work);
    queue.current = run.catch(() => undefined);
    return run;
  }, []);

  /** Pages forward from `cursor` after those of `base`, at most `limit` of them. */
  const readForward = useCallback(
    async (base: HistoryPages, from: string | null, limit: number): Promise<HistoryPages> => {
      const cursors = [...base.cursors];
      const items = [...base.items];
      let cursor = from;
      for (let page = 0; page < limit; page += 1) {
        const result = await api.agentHistory(agent.id, { cursor });
        cursors.push(cursor);
        items.push(result.items);
        if (result.nextCursor === null) break;
        cursor = result.nextCursor;
        if (page === limit - 1) setTruncated(true);
      }
      return { cursors, items, older: base.older };
    },
    [api, agent.id],
  );

  const loadHistory = useCallback(async () => {
    if (loading.current) return;
    loading.current = true;
    try {
      await serial(async () => {
        const said = api.agentInstructions(agent.id);
        const current = pagesRef.current;
        let next: HistoryPages;
        if (current === null) {
          // Newest first (AP-D045): one page shows the conversation; the thread reads ahead.
          const latest = await api.agentHistory(agent.id, { latest: true });
          next = { cursors: [latest.cursor], items: [latest.items], older: latest.previousCursor };
          // A runner an earlier Naru or Host started sent its first page: read on from there.
          if (latest.nextCursor !== null) {
            next = await readForward(next, latest.nextCursor, HISTORY_MAX_PAGES - 1);
          }
        } else {
          // Re-read from the last page: new messages append there (Claude offsets, Codex turns).
          const from = Math.max(0, current.cursors.length - 1);
          next = await readForward(
            {
              cursors: current.cursors.slice(0, from),
              items: current.items.slice(0, from),
              older: current.older,
            },
            current.cursors[from] ?? null,
            20,
          );
        }
        commit(next, await said);
        setIssue(null);
      });
    } catch (failure) {
      setIssue(messageOf(failure));
    } finally {
      loading.current = false;
    }
  }, [api, agent.id, commit, readForward, serial]);

  const loadOlder = useCallback(
    async (keepPlace: () => void) => {
      if (pagesRef.current?.older == null || olderBusy.current) return;
      olderBusy.current = true;
      setOlderLoading(true);
      try {
        await serial(async () => {
          const current = pagesRef.current;
          if (current?.older == null) return;
          const page = await api.agentHistory(agent.id, { before: current.older });
          // The thread notes what the person sees, then the page goes in above it at once.
          flushSync(() => {
            keepPlace();
            commit({
              cursors: [page.cursor, ...current.cursors],
              items: [page.items, ...current.items],
              older: page.previousCursor,
            });
          });
        });
        setOlderFailed(false);
      } catch {
        // Not read again on its own: the thread offers to try again.
        setOlderFailed(true);
      } finally {
        olderBusy.current = false;
        setOlderLoading(false);
      }
    },
    [api, agent.id, commit, serial],
  );

  useEffect(() => {
    // A stopped runtime cannot answer; reading resumes when the agent runs again.
    if (paused) return;
    let stopped = false;
    let historyTimer: number | null = null;
    const scheduleHistory = () => {
      if (historyTimer !== null) window.clearTimeout(historyTimer);
      historyTimer = window.setTimeout(
        () => {
          void loadHistory().finally(() => {
            if (!stopped) scheduleHistory();
          });
        },
        active.current ? HISTORY_ACTIVE_MS : HISTORY_IDLE_MS,
      );
    };
    const poll = async () => {
      if (!managed) return;
      try {
        const next = await api.agentRuntime(agent.id);
        if (stopped) return;
        setRuntime(next);
        if (next.turnActive && !active.current) setTurnStartedAt(Date.now());
        // A turn that just ended changed the conversation: read it again now.
        if (!next.turnActive && active.current) void loadHistory();
        active.current = next.turnActive;
      } catch (failure) {
        if (!stopped) setIssue(messageOf(failure));
      }
    };
    const first = window.setTimeout(() => {
      void poll();
      void loadHistory().finally(() => {
        if (!stopped) scheduleHistory();
      });
    }, 0);
    const timer = window.setInterval(() => void poll(), RUNTIME_POLL_MS);
    return () => {
      stopped = true;
      window.clearTimeout(first);
      window.clearInterval(timer);
      if (historyTimer !== null) window.clearTimeout(historyTimer);
    };
  }, [api, agent.id, managed, paused, loadHistory]);

  const conversation = useMemo(
    () => (pages === null ? null : conversationPages(pages.items, instructions, pages.cursors)),
    [pages, instructions],
  );
  return {
    runtime,
    blocks: conversation?.blocks ?? null,
    issue,
    truncated,
    turnStartedAt: runtime?.turnActive === true ? turnStartedAt : null,
    paused,
    reload: () => void loadHistory(),
    older: {
      available: pages?.older != null && !paused,
      startHeld: pages !== null && pages.older === null,
      loading: olderLoading,
      failed: olderFailed,
      pages: pages?.items.length ?? 0,
      pageOf: conversation?.pageOf ?? NO_PAGES,
      load: (keepPlace) => void loadOlder(keepPlace),
    },
  };
}

/** Reading the messages above the ones shown (AP-D045, AP-D046). */
interface OlderHistory {
  /** Earlier messages are not held yet, and the runtime can be asked for them. */
  readonly available: boolean;
  /** The conversation's start is held: nothing above is missing. */
  readonly startHeld: boolean;
  readonly loading: boolean;
  /** The last read failed: the thread offers to try again rather than reading on its own. */
  readonly failed: boolean;
  /** Pages held, and the page (0: the oldest held) each block began in. */
  readonly pages: number;
  readonly pageOf: ReadonlyMap<string, number>;
  /** Reads the page above; `keepPlace` runs right before it goes in. */
  readonly load: (keepPlace: () => void) => void;
}

function Conversation({
  agent,
  onBack,
}: {
  readonly agent: AgentSession;
  readonly onBack: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const phone = useMedia(PHONE);
  const wide = useMedia("(min-width: 1180px)");
  const [contextOpen, setContextOpen] = useState(false);
  const { runtime, blocks, issue, truncated, turnStartedAt, paused, reload, older } =
    useAgentConversation(agent);
  const identity = app.identity(agent);
  const presence = app.presence(agent);
  const task = currentTask(
    agent,
    app.board.projects.flatMap((project) => project.tasks),
  );
  const meta = [
    agent.projectId === null ? "전체" : app.projectName(agent.projectId),
    agent.runtime === "codex" ? "Codex" : agent.runtime === "claude" ? "Claude" : "OpenCode",
    task === undefined ? null : `맡은 일: ${task.title}`,
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const showContext = wide || contextOpen;
  const paneLabel =
    agent.launchMode === "tui" || agent.runtime === "codex" ? "TUI로 열기" : "작업공간에서 열기";
  return (
    <div
      className="ag-conversation-wrap"
      data-context={showContext && !wide ? "overlay" : undefined}
    >
      <section className="ag-conversation" aria-label={`${identity.name} 대화`}>
        <header className="ag-convo-head">
          {phone && (
            <button className="ag-icon-button" type="button" aria-label="목록으로" onClick={onBack}>
              <Icon name="chevronLeft" size={22} />
            </button>
          )}
          <Avatar identity={identity} size={32} presence={presence} />
          <div className="ag-convo-title">
            <h2>{identity.name}</h2>
            <p>{phone ? presenceLabel(presence) : meta}</p>
          </div>
          {!phone && <Pill tone={presenceTone(presence)}>{presenceLabel(presence)}</Pill>}
          {!phone && agent.paneId !== null && (
            <button
              className="ag-button ag-pane-button"
              type="button"
              aria-label={paneLabel}
              title={paneLabel}
              onClick={() => app.openPane(agent.paneId!, agent.projectId)}
            >
              <Icon name="terminal" size={14} />
              <span>{paneLabel}</span>
            </button>
          )}
          {!wide && (
            <button
              className="ag-icon-button"
              type="button"
              aria-label="작업 맥락"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((open) => !open)}
            >
              <Icon name="panel" size={18} />
            </button>
          )}
          <AgentMenu agent={agent} runtime={runtime} />
        </header>
        {issue !== null && !paused && (
          <p className="ag-issue" role="status">
            {issue}{" "}
            <button className="ag-link" type="button" onClick={reload}>
              다시 읽기
            </button>
          </p>
        )}
        <Thread
          agent={agent}
          blocks={blocks}
          runtime={runtime}
          truncated={truncated}
          older={older}
          turnStartedAt={turnStartedAt}
          paused={paused}
        />
        <Composer agent={agent} runtime={runtime} onSent={reload} />
      </section>
      {showContext && (
        <TaskContext
          agent={agent}
          runtime={runtime}
          task={task}
          onClose={wide ? undefined : () => setContextOpen(false)}
        />
      )}
    </div>
  );
}

/**
 * An agent's conversation inside its own workspace Pane (AP-D028): the thread and the composer
 * under a slim line with its state, task and menu. The Pane's header names the agent and switches
 * to the TUI.
 */
export function PaneConversation({
  agent,
  notice = null,
  onShowConsole = null,
}: {
  readonly agent: AgentSession;
  /** Shown above the thread, such as a question before taking the agent over in the TUI. */
  readonly notice?: React.ReactNode;
  readonly onShowConsole?: (() => void) | null;
}): React.JSX.Element {
  const app = useAgentApp();
  const [contextOpen, setContextOpen] = useState(false);
  const { runtime, blocks, issue, truncated, turnStartedAt, paused, reload, older } =
    useAgentConversation(agent);
  const presence = app.presence(agent);
  const task = currentTask(
    agent,
    app.board.projects.flatMap((project) => project.tasks),
  );
  return (
    <div
      className="ag-conversation-wrap ag-pane-conversation"
      data-context={contextOpen ? "overlay" : undefined}
    >
      <section className="ag-conversation" aria-label={`${app.identity(agent).name} 대화`}>
        <div className="ag-pane-convo-bar">
          <Pill tone={presenceTone(presence)}>{presenceLabel(presence)}</Pill>
          <span className="ag-pane-convo-task">
            {task === undefined ? app.projectName(agent.projectId) : `맡은 일: ${task.title}`}
          </span>
          <button
            className="ag-icon-button"
            type="button"
            aria-label="작업 맥락"
            aria-expanded={contextOpen}
            onClick={() => setContextOpen((open) => !open)}
          >
            <Icon name="panel" size={16} />
          </button>
          <AgentMenu agent={agent} runtime={runtime} inPane={{ onShowConsole }} />
        </div>
        {notice}
        {issue !== null && !paused && (
          <p className="ag-issue" role="status">
            {issue}{" "}
            <button className="ag-link" type="button" onClick={reload}>
              다시 읽기
            </button>
          </p>
        )}
        <Thread
          agent={agent}
          blocks={blocks}
          runtime={runtime}
          truncated={truncated}
          older={older}
          turnStartedAt={turnStartedAt}
          paused={paused}
        />
        <Composer agent={agent} runtime={runtime} onSent={reload} />
      </section>
      {contextOpen && (
        <TaskContext
          agent={agent}
          runtime={runtime}
          task={task}
          onClose={() => setContextOpen(false)}
        />
      )}
    </div>
  );
}

/** The task the agent works on now, else the one it touched last. */
function currentTask(agent: AgentSession, tasks: readonly AgentTask[]): AgentTask | undefined {
  const mine = tasks
    .filter((task) => task.assigneeAgentSessionId === agent.id)
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const rank = (task: AgentTask) =>
    task.status === "running" || task.status === "review"
      ? 0
      : task.status === "blocked" || task.status === "ready" || task.status === "pending"
        ? 1
        : 2;
  return [...mine].sort((left, right) => rank(left) - rank(right))[0];
}

function AgentMenu({
  agent,
  runtime,
  inPane = null,
}: {
  readonly agent: AgentSession;
  readonly runtime: AgentRuntimeState | null;
  /** In the agent's own Pane: its header switches to TUI, and the runner's console is one step away. */
  readonly inPane?: { readonly onShowConsole: (() => void) | null } | null;
}): React.JSX.Element | null {
  const app = useAgentApp();
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement | null>(null);
  const managed = agent.paneId !== null;
  const live = isLive(agent);
  const held = agent.humanHoldSince !== null;
  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus();
    const close = (event: MouseEvent) => {
      if (!menu.current?.parentElement?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);
  if (!managed) return null;
  const items: { label: string; run: () => void }[] = [];
  if (live && !held && inPane === null) {
    items.push({
      label: "TUI에서 직접 이어받기",
      run: () =>
        void app
          .act("TUI로 이어받았습니다.", () =>
            app.api.setAgentHold(agent.id, true, "tui", runtime?.turnActive === true),
          )
          .then((done) => {
            if (done) app.openPane(agent.paneId!, agent.projectId);
          }),
    });
  }
  if (held) {
    items.push({
      label: "오케스트레이터에게 돌려주기",
      run: () =>
        void app.act("에이전트에게 돌려줬습니다.", () => app.api.setAgentHold(agent.id, false)),
    });
  }
  if (inPane?.onShowConsole) items.push({ label: "실행 콘솔 보기", run: inPane.onShowConsole });
  items.push(
    live
      ? {
          label: "에이전트 정지",
          run: () => void app.act("에이전트를 정지했습니다.", () => app.api.stopAgent(agent.id)),
        }
      : {
          label: "다시 실행",
          run: () =>
            void app.act("에이전트를 다시 실행했습니다.", () => app.api.launchAgent(agent.id)),
        },
  );
  return (
    <div className="ag-menu-wrap">
      <button
        className="ag-icon-button"
        type="button"
        aria-label="에이전트 메뉴"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name="more" size={18} />
      </button>
      {open && (
        <div
          ref={menu}
          className="ag-menu"
          role="menu"
          aria-label="에이전트 메뉴"
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
              (menu.current?.previousElementSibling as HTMLElement | null)?.focus();
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              const entries = [
                ...(menu.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]") ?? []),
              ];
              const index = entries.indexOf(document.activeElement as HTMLButtonElement);
              const next =
                (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length;
              entries[next]?.focus();
            }
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              disabled={!app.mutationAllowed}
              onClick={() => {
                setOpen(false);
                item.run();
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Thread({
  agent,
  blocks,
  runtime,
  truncated,
  older,
  turnStartedAt,
  paused,
}: {
  readonly agent: AgentSession;
  readonly blocks: ConversationBlock[] | null;
  readonly runtime: AgentRuntimeState | null;
  readonly truncated: boolean;
  readonly older: OlderHistory;
  readonly turnStartedAt: number | null;
  readonly paused: boolean;
}): React.JSX.Element {
  const app = useAgentApp();
  const scroller = useRef<HTMLDivElement | null>(null);
  const atBottom = useRef(true);
  const [behind, setBehind] = useState(false);
  // Where the person was reading when a page went in above, and the latest view of earlier pages.
  const place = useRef<KeptPlace | null>(null);
  const olderNow = useRef(older);
  const aheadFrame = useRef<number | null>(null);
  const identity = app.identity(agent);
  const approvals = runtime?.pendingApprovals ?? [];
  const working = runtime?.turnActive === true;
  const holdStart = agent.humanHoldSince === null ? null : Date.parse(agent.humanHoldSince);

  const groups = useMemo(() => groupBlocks(blocks ?? []), [blocks]);
  // The person took over: the line goes before their first message since then. It waits until all
  // said since is held (an earlier request is, or the start), or it would move when pages come in.
  const dividerAt =
    holdStart === null ||
    !(
      older.startHeld ||
      groups.some(
        (group) =>
          group.kind === "request" &&
          group.block.at !== null &&
          Date.parse(group.block.at) < holdStart - 1_000,
      )
    )
      ? -1
      : (() => {
          const index = groups.findIndex(
            (group) =>
              group.kind === "request" &&
              group.block.source.kind === "me" &&
              // Answering its question is not talking to it directly.
              group.block.answered === null &&
              group.block.at !== null &&
              Date.parse(group.block.at) >= holdStart - 1_000,
          );
          return index === -1 ? groups.length : index;
        })();

  const keepPlace = useCallback(() => {
    const element = scroller.current;
    if (element === null) return;
    const block = firstBlockInView(element);
    place.current = {
      block: block?.dataset.block ?? null,
      offset: block === null ? 0 : top(block) - top(element),
      scrollTop: element.scrollTop,
      scrollHeight: element.scrollHeight,
    };
  }, []);

  // Earlier pages are read before the person reaches them (AP-D046): two pages and two screens
  // stay above what they see, and each goes in without moving it.
  const readAhead = useCallback(() => {
    const element = scroller.current;
    const current = olderNow.current;
    if (element === null || !current.available || current.loading || current.failed) return;
    const block = firstBlockInView(element);
    const page = current.pageOf.get(block?.dataset.block ?? "") ?? 0;
    if (
      page < OLDER_PAGES_AHEAD ||
      element.scrollTop < OLDER_SCREENS_AHEAD * element.clientHeight
    ) {
      current.load(keepPlace);
    }
  }, [keepPlace]);

  const content = `${blocks?.length ?? -1}:${approvals.length}:${working}:${dividerAt}:${older.pages}`;
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null) return;
    const kept = place.current;
    place.current = null;
    if (kept !== null) {
      // A page went in above: what the person reads stays where it was. A browser that anchors
      // scrolling has done this already; otherwise the thread moves by what is left.
      const block =
        kept.block === null
          ? null
          : element.querySelector<HTMLElement>(`[data-block="${CSS.escape(kept.block)}"]`);
      const moved =
        block !== null
          ? top(block) - top(element) - kept.offset
          : element.scrollHeight - kept.scrollHeight - (element.scrollTop - kept.scrollTop);
      if (Math.abs(moved) >= 1) element.scrollTop += moved;
    } else if (atBottom.current) element.scrollTop = element.scrollHeight;
    else setBehind(true);
  }, [content]);

  useEffect(() => {
    olderNow.current = older;
    readAhead();
  }, [older, readAhead, content]);

  useEffect(
    () => () => {
      if (aheadFrame.current !== null) cancelAnimationFrame(aheadFrame.current);
    },
    [],
  );

  return (
    <div
      ref={scroller}
      className="ag-thread-scroll"
      onScroll={(event) => {
        const element = event.currentTarget;
        atBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        if (atBottom.current) setBehind(false);
        aheadFrame.current ??= requestAnimationFrame(() => {
          aheadFrame.current = null;
          readAhead();
        });
      }}
    >
      <ol className="ag-thread" aria-label="대화" aria-busy={blocks === null}>
        {truncated && <li className="ag-notice-line">오래된 대화는 일부만 불러왔습니다.</li>}
        {older.available && blocks !== null && (
          <li className="ag-notice-line">
            {older.failed ? (
              <>
                이전 대화를 불러오지 못했습니다.{" "}
                <button className="ag-link" type="button" onClick={() => older.load(keepPlace)}>
                  다시 시도
                </button>
              </>
            ) : (
              "이전 대화를 불러오는 중…"
            )}
          </li>
        )}
        {blocks === null ? (
          <li className="ag-notice-line">
            {paused
              ? "에이전트가 멈춰 있어 대화를 불러올 수 없습니다. 아래에서 다시 실행하면 이어집니다."
              : "대화를 불러오는 중…"}
          </li>
        ) : groups.length === 0 && !working ? (
          <li className="ag-notice-line">
            {agent.status === "starting"
              ? "에이전트를 시작하는 중입니다…"
              : "아직 대화가 없습니다. 아래에 메시지를 쓰면 시작합니다."}
          </li>
        ) : null}
        {groups.map((group, index) => (
          <ThreadGroup
            key={group.key}
            group={group}
            identity={identity}
            divider={index === dividerAt}
          />
        ))}
        {dividerAt === groups.length && blocks !== null && <TakeoverLine />}
        {approvals.map((approval) => (
          <li key={approval.requestId} className="ag-approval" aria-label="승인 요청">
            <div className="ag-approval-head">
              <Icon name={approval.kind === "file" ? "pen" : "terminal"} size={16} />
              <strong>
                {approval.kind === "command"
                  ? "명령을 실행하려고 합니다"
                  : `${approvalKindLabel(approval.kind)}을 하려고 합니다`}
              </strong>
            </div>
            {approval.summary !== undefined && <code>{approval.summary}</code>}
            <div className="ag-approval-actions">
              <button
                className="ag-button"
                data-variant="primary"
                type="button"
                disabled={!app.mutationAllowed}
                onClick={() =>
                  void app.act("승인했습니다.", () =>
                    app.api.respondAgentApproval(agent.id, approval.requestId, "approve"),
                  )
                }
              >
                승인
              </button>
              <button
                className="ag-button"
                type="button"
                disabled={!app.mutationAllowed}
                onClick={() =>
                  void app.act("거부했습니다.", () =>
                    app.api.respondAgentApproval(agent.id, approval.requestId, "deny"),
                  )
                }
              >
                거부
              </button>
              {approval.sessionAllow === true && (
                <button
                  className="ag-button"
                  type="button"
                  disabled={!app.mutationAllowed}
                  title="같은 종류의 요청은 이 에이전트 세션이 끝날 때까지 묻지 않습니다"
                  onClick={() =>
                    void app.act("이 세션에서는 묻지 않게 허용했습니다.", () =>
                      app.api.respondAgentApproval(agent.id, approval.requestId, "approve-session"),
                    )
                  }
                >
                  이 세션에서는 항상 허용
                </button>
              )}
            </div>
          </li>
        ))}
        {working && (
          <li className="ag-typing" aria-live="polite">
            <span className="ag-pulse" aria-hidden="true" />
            {approvals.length > 0
              ? "승인을 기다리는 중"
              : runtime?.writer === "orchestrator"
                ? "오케스트레이터 지시로 일하는 중"
                : "답하는 중"}
            {approvals.length === 0 && turnStartedAt !== null && <Elapsed since={turnStartedAt} />}
          </li>
        )}
      </ol>
      {behind && (
        <button
          className="ag-jump"
          type="button"
          onClick={() => {
            const element = scroller.current;
            if (element !== null) element.scrollTop = element.scrollHeight;
            atBottom.current = true;
            setBehind(false);
          }}
        >
          새 내용 <Icon name="chevronDown" size={14} />
        </button>
      )}
    </div>
  );
}

type ThreadGroupModel =
  | {
      readonly kind: "request";
      readonly key: string;
      readonly block: Extract<ConversationBlock, { kind: "request" }>;
    }
  | {
      readonly kind: "notice";
      readonly key: string;
      readonly block: Extract<ConversationBlock, { kind: "notice" }>;
    }
  | { readonly kind: "turn"; readonly key: string; readonly blocks: ConversationBlock[] };

/** Consecutive answers, tool rows and thinking form one agent turn under one name. */
function groupBlocks(blocks: readonly ConversationBlock[]): ThreadGroupModel[] {
  const groups: ThreadGroupModel[] = [];
  for (const block of blocks) {
    if (block.kind === "request") groups.push({ kind: "request", key: block.key, block });
    else if (block.kind === "notice") groups.push({ kind: "notice", key: block.key, block });
    else {
      const last = groups.at(-1);
      if (last?.kind === "turn") last.blocks.push(block);
      else groups.push({ kind: "turn", key: block.key, blocks: [block] });
    }
  }
  return groups;
}

/** Where the person was reading: the first block in view and how far below the top edge. */
interface KeptPlace {
  readonly block: string | null;
  readonly offset: number;
  readonly scrollTop: number;
  readonly scrollHeight: number;
}

/**
 * The first conversation block not wholly above the thread's top edge. Blocks (a request, an
 * answer, a row of tools) follow one another down the thread; a long turn holds many of them.
 */
function firstBlockInView(thread: HTMLElement): HTMLElement | null {
  const blocks = thread.querySelectorAll<HTMLElement>("[data-block]");
  const edge = top(thread);
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if (blocks[middle]!.getBoundingClientRect().bottom <= edge) low = middle + 1;
    else high = middle;
  }
  return blocks[low] ?? null;
}

function top(element: Element): number {
  return element.getBoundingClientRect().top;
}

function TakeoverLine(): React.JSX.Element {
  return (
    <li className="ag-divider" role="separator">
      <span>여기부터 내가 직접 대화 중 · 오케스트레이터는 기다립니다</span>
    </li>
  );
}

function ThreadGroup({
  group,
  identity,
  divider,
}: {
  readonly group: ThreadGroupModel;
  readonly identity: ReturnType<ReturnType<typeof useAgentApp>["identity"]>;
  readonly divider: boolean;
}): React.JSX.Element {
  const app = useAgentApp();
  const line = divider ? <TakeoverLine /> : null;
  if (group.kind === "notice") {
    return (
      <>
        {line}
        <li className="ag-notice" data-block={group.key}>
          <FoldRow icon="bell" label={group.block.text} detail={group.block.details.join("\n")} />
        </li>
      </>
    );
  }
  if (group.kind === "request") {
    const block = group.block;
    const author =
      block.source.kind === "agent" ? app.agentById(block.source.agentSessionId) : undefined;
    const label =
      block.source.kind === "me"
        ? block.answered !== null
          ? block.answered.kind === "contract"
            ? `나 · 의도 계약 v${block.answered.version} 승인`
            : "나 · 질문에 답함"
          : block.source.channel === "tui"
            ? "나 · TUI"
            : "나"
        : block.source.kind === "agent"
          ? author === undefined
            ? "에이전트"
            : app.identity(author).name
          : "요청";
    return (
      <>
        {line}
        <li className="ag-request" data-source={block.source.kind} data-block={group.key}>
          <span className="ag-request-label">
            {author !== undefined && <Avatar identity={app.identity(author)} size={16} />}
            {label}
            {block.at !== null && ` · ${clock(block.at)}`}
          </span>
          <div className="ag-bubble">
            {block.answered?.kind === "question" && block.answered.chosen !== null && (
              <span className="ag-bubble-choice">선택 · {block.answered.chosen}</span>
            )}
            <p>{block.text}</p>
            {block.answered?.kind === "question" && (
              <details className="ag-origin">
                <summary>
                  <Icon name="chevronRight" size={12} />
                  답한 질문
                </summary>
                <p>{block.answered.question}</p>
              </details>
            )}
            {block.origin !== null && block.origin.verbatim !== null && (
              <details className="ag-origin">
                <summary>
                  <Icon name="chevronRight" size={12} />
                  원본 지시 · 나 {clock(block.origin.createdAt)}
                </summary>
                <p>{block.origin.verbatim}</p>
              </details>
            )}
          </div>
        </li>
      </>
    );
  }
  return (
    <>
      {line}
      <li className="ag-turn">
        <span className="ag-turn-head">
          <Avatar identity={identity} size={22} />
          {identity.name}
        </span>
        {group.blocks.map((block) =>
          block.kind === "answer" ? (
            <ChatMarkdown key={block.key} text={block.text} block={block.key} />
          ) : block.kind === "thinking" ? (
            <FoldRow
              key={block.key}
              icon="brain"
              label="생각함"
              detail={block.text}
              block={block.key}
            />
          ) : block.kind === "tools" ? (
            <ToolGroup key={block.key} calls={block.calls} block={block.key} />
          ) : block.kind === "ask" ? (
            <AskCard key={block.key} ask={block} />
          ) : null,
        )}
      </li>
    </>
  );
}

/**
 * The agent asked the person something: the question in full, never folded, answerable here while
 * it is still open.
 */
function AskCard({ ask }: { readonly ask: AskBlock }): React.JSX.Element {
  const app = useAgentApp();
  const open =
    ask.handoffId === null
      ? undefined
      : app.inbox.find((item) => item.key === `handoff:${ask.handoffId}`);
  const state = ask.failed
    ? "failed"
    : open !== undefined
      ? "open"
      : ask.handoffId === null
        ? "sent"
        : "closed";
  return (
    <div className="ag-ask-card" data-state={state} data-block={ask.key}>
      <div className="ag-ask-card-head">
        <Icon name="hand" size={15} />
        <strong>사람에게 물음 · {askKindLabel(ask.handoffKind)}</strong>
      </div>
      {ask.reason !== "" && <p className="ag-ask-card-question">{ask.reason}</p>}
      {ask.options.length > 0 && (
        <ul className="ag-ask-card-options">
          {ask.options.map((option) => (
            <li key={option.label}>
              <strong>{option.label}</strong>
              {option.description !== "" && <span>{option.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {ask.recommendation !== "" && (
        <p className="ag-ask-card-recommend">추천: {ask.recommendation}</p>
      )}
      <div className="ag-ask-card-foot">
        {state === "open" ? (
          <button
            className="ag-button"
            data-variant="primary"
            type="button"
            onClick={() => app.openDecision(open!)}
          >
            답하기
          </button>
        ) : (
          <span className="ag-muted">
            {state === "failed"
              ? "Naru에 전달되지 않은 질문입니다."
              : state === "closed"
                ? ask.answered
                  ? "답했습니다. 내 답은 아래에 있습니다."
                  : "답했거나 취소된 질문입니다."
                : "Naru에 전달하는 중입니다."}
          </span>
        )}
      </div>
    </div>
  );
}

/** A gray one-line row that opens to show what is behind it. */
function FoldRow({
  icon,
  label,
  detail,
  meta,
  block,
}: {
  readonly icon: IconName;
  readonly label: string;
  readonly detail: string;
  readonly meta?: string;
  /** The conversation block this row shows, for keeping the reader's place (AP-D046). */
  readonly block?: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const expandable = detail.trim() !== "";
  return (
    <div className="ag-fold" data-open={open} data-block={block}>
      <button
        type="button"
        className="ag-fold-row"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={expandable ? (open ? "chevronDown" : "chevronRight") : icon} size={14} />
        <span>{label}</span>
        {meta !== undefined && <span className="ag-fold-meta">{meta}</span>}
      </button>
      {open && <pre className="ag-fold-detail">{detail}</pre>}
    </div>
  );
}

const TOOL_ICONS: Readonly<Record<ToolKind, IconName>> = {
  read: "file",
  search: "search",
  edit: "pen",
  command: "terminal",
  web: "globe",
  agent: "bot",
  naru: "spark",
  plan: "list",
  other: "spark",
};

function ToolGroup({
  calls,
  block,
}: {
  readonly calls: readonly ToolCall[];
  readonly block: string;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const failed = calls.filter((call) => call.failed).length;
  const changes = changeSummary(calls);
  const duration = calls.reduce((sum, call) => sum + (call.durationMs ?? 0), 0);
  return (
    <div className="ag-fold" data-open={open} data-block={block}>
      <button
        type="button"
        className="ag-fold-row"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Icon name={open ? "chevronDown" : "chevronRight"} size={14} />
        <span>{toolSummary(calls)}</span>
        {changes !== null && <span className="ag-fold-meta ag-diff">{changes}</span>}
        {changes === null && duration >= 1_000 && (
          <span className="ag-fold-meta">{Math.round(duration / 1000)}초</span>
        )}
        {failed > 0 && <span className="ag-fold-failed">실패 {failed}</span>}
      </button>
      {open && (
        <ul className="ag-tool-list">
          {calls.map((call) => (
            <ToolCallRow key={call.id} call={call} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ToolCallRow({ call }: { readonly call: ToolCall }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const mono = call.kind !== "naru" && call.kind !== "agent" && call.kind !== "plan";
  const body = (
    <>
      <Icon name={TOOL_ICONS[call.kind]} size={13} />
      <span className="ag-tool-title" data-mono={mono}>
        {call.title}
      </span>
      {(call.added !== null || call.removed !== null) && (
        <span className="ag-diff">
          {call.added !== null && <span data-sign="plus">+{call.added}</span>}
          {call.removed !== null && <span data-sign="minus"> −{call.removed}</span>}
        </span>
      )}
      {call.failed && <span className="ag-fold-failed">실패</span>}
    </>
  );
  return (
    <li>
      {call.output === null ? (
        <span className="ag-tool-call">{body}</span>
      ) : (
        <button
          type="button"
          className="ag-tool-call"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {body}
        </button>
      )}
      {open && call.output !== null && <pre className="ag-fold-detail">{call.output}</pre>}
    </li>
  );
}

function Elapsed({ since }: { readonly since: number }): React.JSX.Element {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.round((now - since) / 1000));
  return (
    <span className="ag-elapsed">
      {" "}
      · {seconds < 60 ? `${seconds}초` : `${Math.floor(seconds / 60)}분 ${seconds % 60}초`}
    </span>
  );
}

// Composer --------------------------------------------------------------------------------------

function Composer({
  agent,
  runtime,
  onSent,
}: {
  readonly agent: AgentSession;
  readonly runtime: AgentRuntimeState | null;
  readonly onSent: () => void;
}): React.JSX.Element {
  const app = useAgentApp();
  const identity = app.identity(agent);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement | null>(null);
  const managed = agent.paneId !== null;
  const live = isLive(agent);
  const writer = runtime?.writer ?? null;
  const mine = writer === "gui";
  const working = runtime?.turnActive === true;
  const ready = managed && live && runtime !== null && runtime.connected;

  const clear = () => {
    setText("");
    requestAnimationFrame(() => autosize(input.current));
  };
  const instructOnly = () => {
    const message = text.trim();
    if (message === "") return;
    setBusy(true);
    void app
      .act("지시로 남겼습니다. 다음 차례에 반영됩니다.", () =>
        app.api.createInstruction(
          { kind: "agent", projectId: agent.projectId, agentSessionId: agent.id },
          message,
        ),
      )
      .then((done) => {
        setBusy(false);
        if (done) {
          clear();
          onSent();
        }
      });
  };

  if (managed && writer === "tui") {
    return (
      <div className="ag-composer-note">
        <p>지금 TUI에서 직접 대화 중입니다.</p>
        <span>
          <button
            className="ag-button"
            type="button"
            onClick={() => app.openPane(agent.paneId!, agent.projectId)}
          >
            TUI 열기
          </button>
          <button
            className="ag-button"
            type="button"
            disabled={!app.mutationAllowed}
            onClick={() =>
              void app.act("에이전트에게 돌려줬습니다.", () =>
                app.api.setAgentHold(agent.id, false),
              )
            }
          >
            오케스트레이터에게 돌려주기
          </button>
        </span>
      </div>
    );
  }
  if (managed && !live) {
    return (
      <div className="ag-composer-note">
        <p>에이전트가 멈춰 있습니다.</p>
        <button
          className="ag-button"
          data-variant="primary"
          type="button"
          disabled={!app.mutationAllowed}
          onClick={() =>
            void app.act("에이전트를 다시 실행했습니다.", () => app.api.launchAgent(agent.id))
          }
        >
          다시 실행
        </button>
      </div>
    );
  }

  return (
    <form
      className="ag-composer"
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        const message = text.trim();
        if (message === "" || busy) return;
        if (!managed) {
          instructOnly();
          return;
        }
        if (!ready) return;
        setBusy(true);
        void app
          .act(mine ? "보냈습니다." : "이어받아 보냈습니다.", async () => {
            let generation = runtime.generation;
            if (!mine) {
              await app.api.setAgentHold(agent.id, true, "chat", working);
              generation = (await app.api.agentRuntime(agent.id)).generation;
            }
            await app.api.sendAgentTurn(agent.id, message, generation);
          })
          .then((done) => {
            setBusy(false);
            if (done) {
              clear();
              onSent();
            }
          });
      }}
    >
      <div className="ag-composer-box">
        <label className="sr-only" htmlFor={`ag-composer-${agent.id}`}>
          {identity.name}에게 메시지
        </label>
        <textarea
          id={`ag-composer-${agent.id}`}
          ref={input}
          value={text}
          rows={1}
          placeholder={`${identity.name}에게 메시지…`}
          disabled={!app.mutationAllowed || (managed && !ready)}
          onChange={(event) => {
            setText(event.target.value);
            autosize(event.target);
          }}
          onKeyDown={submitOnEnter}
        />
        <div className="ag-composer-row">
          <span className="ag-chip" data-static="true">
            {agent.runtime === "codex"
              ? "Codex"
              : agent.runtime === "claude"
                ? "Claude"
                : "OpenCode"}
          </span>
          <span className="ag-grow" />
          {mine && working ? (
            <button
              className="ag-send"
              data-variant="stop"
              type="button"
              aria-label="답 멈추기"
              disabled={!app.mutationAllowed}
              onClick={() =>
                void app.act("멈췄습니다.", () =>
                  app.api.interruptAgent(agent.id, runtime.generation),
                )
              }
            >
              <span className="ag-stop-square" aria-hidden="true" />
            </button>
          ) : (
            <button
              className="ag-send"
              type="submit"
              aria-label="보내기"
              disabled={!app.mutationAllowed || busy || text.trim() === "" || (managed && !ready)}
            >
              <Icon name="up" size={18} strokeWidth={2.4} />
            </button>
          )}
        </div>
      </div>
      <p className="ag-composer-hint">
        {!managed ? (
          "이 에이전트는 Naru가 실행하지 않아, 보내면 지시로 남깁니다."
        ) : mine ? (
          <>
            내가 직접 대화 중입니다.{" "}
            <button
              className="ag-link"
              type="button"
              disabled={!app.mutationAllowed}
              onClick={() =>
                void app.act("에이전트에게 돌려줬습니다.", () =>
                  app.api.setAgentHold(agent.id, false),
                )
              }
            >
              오케스트레이터에게 돌려주기
            </button>
          </>
        ) : (
          <>
            보내면 이 에이전트를 직접 이어받습니다{working ? "(지금 하던 답은 멈춥니다)" : ""}.
            한동안 입력이 없으면 오케스트레이터에게 돌아갑니다.{" "}
            <button
              className="ag-link"
              type="button"
              disabled={!app.mutationAllowed || busy || text.trim() === ""}
              onClick={instructOnly}
            >
              이어받지 않고 지시로만 보내기
            </button>
          </>
        )}
      </p>
    </form>
  );
}

// Task context ----------------------------------------------------------------------------------

function TaskContext({
  agent,
  runtime,
  task,
  onClose,
}: {
  readonly agent: AgentSession;
  readonly runtime: AgentRuntimeState | null;
  readonly task: AgentTask | undefined;
  readonly onClose: (() => void) | undefined;
}): React.JSX.Element {
  const app = useAgentApp();
  const detail = useTaskDetail(task?.id ?? null);
  const project = app.board.projects.find((candidate) => candidate.projectId === agent.projectId);
  const processes = (project?.processes ?? []).filter(
    (process) => process.agentSessionId === agent.id && process.status !== "stopped",
  );
  const orchestrator = agent.role === "main-orchestrator" || agent.role === "project-orchestrator";
  const managedTasks = agent.role === "project-orchestrator" ? (project?.tasks ?? []) : [];
  const parent = app.agentById(agent.parentAgentSessionId);
  const children = app.agents.filter((candidate) => candidate.parentAgentSessionId === agent.id);
  const reviewers =
    task === undefined
      ? []
      : (detail?.reviews ?? []).map((review) => review.reviewerAgentSessionId);
  const team = [
    ...(parent === undefined ? [] : [parent]),
    ...children,
    ...app.agents.filter(
      (candidate) => reviewers.includes(candidate.id) && candidate.id !== agent.id,
    ),
  ].filter((member, index, all) => all.findIndex((other) => other.id === member.id) === index);
  const state =
    task === undefined || project === undefined
      ? null
      : taskState(task, taskWaitingFor(task, project, app.board.openHandoffs));
  return (
    <aside className="ag-context" aria-label="작업 맥락">
      {onClose !== undefined && (
        <button
          className="ag-icon-button ag-context-close"
          type="button"
          aria-label="작업 맥락 닫기"
          onClick={onClose}
        >
          <Icon name="x" size={18} />
        </button>
      )}
      {orchestrator ? (
        <section className="ag-context-section">
          <h3>관리하는 작업</h3>
          {agent.role === "main-orchestrator" ? (
            <p className="ag-muted">
              프로젝트 {app.board.projects.length}개 · 작업{" "}
              {app.board.projects.reduce((sum, item) => sum + item.tasks.length, 0)}개
            </p>
          ) : managedTasks.length === 0 ? (
            <p className="ag-muted">아직 작업이 없습니다.</p>
          ) : (
            <ul className="ag-task-links">
              {managedTasks.map((item) => {
                const itemState = taskState(
                  item,
                  taskWaitingFor(item, project!, app.board.openHandoffs),
                );
                return (
                  <li key={item.id}>
                    <button
                      className="ag-task-link"
                      type="button"
                      onClick={() => app.openFlow(item.projectId, item.id)}
                    >
                      <span className="ag-dot" data-tone={itemState.tone} aria-hidden="true" />
                      <span>{item.title}</span>
                      <span className="ag-muted">{itemState.label}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
          {project?.activePlan != null && (
            <p className="ag-context-text">{project.activePlan.summary}</p>
          )}
        </section>
      ) : task === undefined ? (
        <section className="ag-context-section">
          <h3>맡은 작업</h3>
          <p className="ag-muted">맡은 작업이 없습니다.</p>
        </section>
      ) : (
        <>
          <section className="ag-context-section">
            <h3>맡은 작업</h3>
            <button
              className="ag-context-title"
              type="button"
              onClick={() => app.openFlow(task.projectId, task.id)}
            >
              {task.title}
            </button>
            {state !== null && <Pill tone={state.tone}>{state.label}</Pill>}
            {task.purpose !== "" && <p className="ag-context-text">{task.purpose}</p>}
          </section>
          <section className="ag-context-section">
            <h3>진행</h3>
            <Steps task={task} detail={detail} />
          </section>
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
            <h3>산출물</h3>
            {detail === null || detail.artifacts.length === 0 ? (
              <p className="ag-muted">아직 없습니다.</p>
            ) : (
              <ul className="ag-artifacts">
                {[...detail.artifacts].reverse().map((artifact) => (
                  <li key={artifact.id}>
                    <span
                      className="ag-dot"
                      data-tone={
                        artifact.exitCode === null
                          ? "subtle"
                          : artifact.exitCode === 0
                            ? "green"
                            : "red"
                      }
                      aria-hidden="true"
                    />
                    <span className="ag-artifact-kind">{artifactKindLabel(artifact.kind)}</span>
                    <code>{artifact.reference}</code>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section className="ag-context-section">
            <h3>리뷰</h3>
            {(["correctness", "intent"] as const).map((kind) => {
              const review = [...(detail?.reviews ?? [])]
                .reverse()
                .find((item) => item.kind === kind);
              return (
                <p key={kind} className="ag-review-line">
                  <span>{reviewKindLabel(kind)}</span>
                  <span
                    data-tone={
                      review === undefined ? "subtle" : review.verdict === "pass" ? "green" : "red"
                    }
                  >
                    {review === undefined ? "아직" : reviewVerdictLabel(review.verdict)}
                  </span>
                </p>
              );
            })}
            {detail !== null && !detail.mergeGate.open && detail.mergeGate.reasons.length > 0 && (
              <p className="ag-muted">
                병합 전에 남은 것: {detail.mergeGate.reasons.map(mergeReasonLabel).join(", ")}
              </p>
            )}
          </section>
        </>
      )}
      <section className="ag-context-section">
        <h3>띄워 둔 프로세스</h3>
        {processes.length === 0 ? (
          <p className="ag-muted">없습니다.</p>
        ) : (
          <ul className="ag-plain-list">
            {processes.map((process) => (
              <ProcessRow key={process.id} process={process} />
            ))}
          </ul>
        )}
      </section>
      <section className="ag-context-section">
        <h3>함께 일하는 에이전트</h3>
        {team.length === 0 && (runtime?.children.length ?? 0) === 0 ? (
          <p className="ag-muted">없습니다.</p>
        ) : (
          <ul className="ag-team">
            {team.map((member) => (
              <li key={member.id}>
                <button
                  className="ag-agent-chip"
                  type="button"
                  onClick={() => app.openChat(member.id)}
                >
                  <Avatar
                    identity={app.identity(member)}
                    size={20}
                    presence={app.presence(member)}
                  />
                  {app.identity(member).name}
                </button>
              </li>
            ))}
            {(runtime?.children.length ?? 0) > 0 && (
              <li className="ag-muted">
                {agent.runtime === "codex" ? "Codex" : "Claude"} 보조 에이전트{" "}
                {runtime!.children.length}개 실행 중 · 관찰만
              </li>
            )}
          </ul>
        )}
      </section>
    </aside>
  );
}

/** Where a task is in its life: assigned, worked on, reviewed, merged or done. */
export function Steps({
  task,
  detail,
}: {
  readonly task: AgentTask;
  readonly detail: AgentTaskDetail | null;
}): React.JSX.Element {
  const merged = detail?.artifacts.some((artifact) => artifact.kind === "commit") === true;
  const reviewed = (detail?.reviews.length ?? 0) > 0;
  const order = ["assigned", "working", "review", "done"] as const;
  const reached: (typeof order)[number] =
    task.status === "done"
      ? "done"
      : task.status === "review" || reviewed
        ? "review"
        : task.status === "running" || task.status === "blocked" || (detail?.runs.length ?? 0) > 0
          ? "working"
          : "assigned";
  const labels = {
    assigned: task.assigneeAgentSessionId === null ? "맡을 에이전트 기다림" : "맡음",
    working: task.status === "blocked" ? "진행 · 막힘" : "진행",
    review: "리뷰",
    done: merged ? "병합" : "완료",
  } as const;
  const index = order.indexOf(reached);
  return (
    <ol className="ag-steps">
      {order.map((step, position) => {
        const status =
          position < index || (step === "done" && reached === "done")
            ? "done"
            : position === index
              ? "now"
              : "todo";
        return (
          <li key={step} data-status={status}>
            {status === "done" ? (
              <Icon name="check" size={15} strokeWidth={2.4} />
            ) : status === "now" ? (
              <span className="ag-step-now" aria-hidden="true" />
            ) : (
              <Icon name="circle" size={15} strokeWidth={1.6} />
            )}
            <span>{labels[step]}</span>
            <span className="sr-only">
              {status === "done" ? " (끝남)" : status === "now" ? " (지금)" : " (남음)"}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

function messageOf(failure: unknown): string {
  return failure instanceof ApiFailure ? failure.message : "대화를 읽지 못했습니다.";
}
