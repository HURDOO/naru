import type { AgentEvent, AgentSession } from "@naru/contracts/naru-agent/v1";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AgentAppContext, type AgentAppContextValue } from "./agent-context";
import { mergeEvents } from "./agent-events";
import {
  type AgentIdentity,
  agentIdentity,
  boardAgents,
  EVENT_FIRST_PAGE,
  type InboxItem,
  inboxItems,
  presenceOf,
  waitingAgentIds,
} from "./agent-model";
import { AgentChat } from "./AgentChat";
import { DecisionSheet } from "./AgentInbox";
import { Icon, type IconName } from "./agent-ui";
import { PHONE, useMedia } from "./agent-dom";
import { ApiFailure, type AgentBoard, type NaruApi } from "./api";
import { ControlRoom } from "./ControlRoom";
import { FlowView } from "./FlowView";
import "./agent-app.css";

type Screen = "control" | "chat" | "flow";

const BOARD_POLL_MS = 3_000;
const EVENT_PAGE = 500;
const EVENT_WINDOW = 3_000;

const SCREENS: readonly { readonly id: Screen; readonly label: string; readonly icon: IconName }[] =
  [
    { id: "control", label: "관제실", icon: "dash" },
    { id: "chat", label: "대화", icon: "chat" },
    { id: "flow", label: "흐름", icon: "flow" },
  ];

interface AgentAppProps {
  readonly api: NaruApi;
  /** Every project the user has, for names and choices. */
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  /** The project open in the workspace; hosts a new main orchestrator's Pane. */
  readonly currentProjectId: string;
  /** Changes need the human device lease (AP-D005 first layer). */
  readonly mutationAllowed: boolean;
  readonly onOpenPane: (paneId: string, projectId: string | null) => void;
  /** Opened from a handoff alert: start on that question. */
  readonly initialHandoffId?: string | null;
  /** Opened from an input-needed alert on an agent's Pane: start in that agent's chat. */
  readonly initialAgentPaneId?: string | null;
  /** How many things wait for the person, for the top bar. */
  readonly onWaitingChange?: (count: number) => void;
}

/**
 * The agent screens (Figma v1, AP-D022): control room, conversations and task flow over every
 * project. All data comes from Naru's agent API; nothing here is a mock.
 */
export function AgentApp({
  api,
  projects,
  currentProjectId,
  mutationAllowed,
  onOpenPane,
  initialHandoffId = null,
  initialAgentPaneId = null,
  onWaitingChange,
}: AgentAppProps): React.JSX.Element {
  const phone = useMedia(PHONE);
  const [board, setBoard] = useState<AgentBoard | null>(null);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [screen, setScreen] = useState<Screen>(initialAgentPaneId === null ? "control" : "chat");
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ projectId: string | null; taskId: string | null }>({
    projectId: null,
    taskId: null,
  });
  const [decisionKey, setDecisionKey] = useState<string | null>(
    initialHandoffId === null ? null : `handoff:${initialHandoffId}`,
  );
  const eventsLoaded = useRef(false);
  const lastSeq = useRef(0);

  const loadEvents = useCallback(async () => {
    if (!eventsLoaded.current) {
      const first = await api.agentEvents(null, 0, { limit: EVENT_FIRST_PAGE, latest: true });
      eventsLoaded.current = true;
      lastSeq.current = first.at(-1)?.seq ?? 0;
      setEvents(first);
      return;
    }
    for (;;) {
      const page = await api.agentEvents(null, lastSeq.current, { limit: EVENT_PAGE });
      if (page.length === 0) return;
      lastSeq.current = page.at(-1)!.seq;
      setEvents((current) => mergeEvents(current, page, EVENT_WINDOW));
      if (page.length < EVENT_PAGE) return;
    }
  }, [api]);

  const refresh = useCallback(async () => {
    try {
      const [next] = await Promise.all([api.agentBoard(), loadEvents()]);
      setBoard(next);
      setNow(Date.now());
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, [api, loadEvents]);

  useEffect(() => {
    const first = window.setTimeout(() => void refresh(), 0);
    const timer = window.setInterval(() => void refresh(), BOARD_POLL_MS);
    return () => {
      window.clearTimeout(first);
      window.clearInterval(timer);
    };
  }, [refresh]);

  const agents = useMemo(() => (board === null ? [] : boardAgents(board)), [board]);
  const inbox = useMemo(() => (board === null ? [] : inboxItems(board)), [board]);
  const waiting = useMemo(() => waitingAgentIds(inbox), [inbox]);

  useEffect(() => {
    if (board !== null) onWaitingChange?.(inbox.length);
  }, [board, inbox.length, onWaitingChange]);

  const projectName = useCallback(
    (projectId: string | null) =>
      projectId === null
        ? "전체"
        : (projects.find((project) => project.id === projectId)?.name ?? "알 수 없는 프로젝트"),
    [projects],
  );
  const identities = useMemo(() => {
    const map = new Map<string, AgentIdentity>();
    for (const agent of agents) map.set(agent.id, agentIdentity(agent, agents, projectName));
    return map;
  }, [agents, projectName]);

  // An alert names the agent's Pane: open its chat once the board that binds it has loaded.
  const pendingPane = useRef(initialAgentPaneId);
  useEffect(() => {
    if (pendingPane.current === null || board === null) return;
    const agent = agents.find((candidate) => candidate.paneId === pendingPane.current);
    pendingPane.current = null;
    if (agent !== undefined) {
      setChatAgentId(agent.id);
      setScreen("chat");
    }
  }, [agents, board]);

  const act = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<boolean> => {
      try {
        await action();
        setStatus(label);
        await refresh();
        return true;
      } catch (failure) {
        setStatus(messageOf(failure));
        setError(messageOf(failure));
        return false;
      }
    },
    [refresh],
  );

  const value = useMemo<AgentAppContextValue | null>(() => {
    if (board === null) return null;
    const agentById = (agentSessionId: string | null) =>
      agentSessionId === null ? undefined : agents.find((agent) => agent.id === agentSessionId);
    return {
      api,
      board,
      events,
      now,
      mutationAllowed,
      projects,
      currentProjectId,
      agents,
      inbox,
      identity: (agent: AgentSession) =>
        identities.get(agent.id) ?? agentIdentity(agent, agents, projectName),
      agentById,
      projectName,
      presence: (agent: AgentSession) => presenceOf(agent, waiting.has(agent.id)),
      act,
      openChat: (agentSessionId) => {
        setChatAgentId(agentSessionId);
        setScreen("chat");
        setDecisionKey(null);
      },
      openFlow: (projectId, taskId = null) => {
        setFlow({ projectId, taskId });
        setScreen("flow");
        setDecisionKey(null);
      },
      openDecision: (item: InboxItem) => setDecisionKey(item.key),
      openPane: onOpenPane,
    };
  }, [
    act,
    agents,
    api,
    board,
    currentProjectId,
    events,
    identities,
    inbox,
    mutationAllowed,
    now,
    onOpenPane,
    projectName,
    projects,
    waiting,
  ]);

  const decision = inbox.find(
    (item): item is Extract<InboxItem, { kind: "handoff" | "contract" }> =>
      item.key === decisionKey && item.kind !== "approval",
  );
  const missingDecision =
    decisionKey !== null && board !== null && decision === undefined && initialHandoffId !== null;
  const inConversation = phone && screen === "chat" && chatAgentId !== null;

  return (
    <section
      className="ag-app"
      aria-label="에이전트"
      data-screen={screen}
      data-conversation={inConversation}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      <nav className="ag-rail" aria-label="에이전트 화면">
        {SCREENS.map((item) => (
          <button
            key={item.id}
            type="button"
            className="ag-rail-item"
            aria-current={screen === item.id ? "page" : undefined}
            onClick={() => {
              setScreen(item.id);
              if (item.id === "chat" && phone) setChatAgentId(null);
            }}
          >
            <Icon name={item.icon} size={20} />
            <span>{item.label}</span>
            {item.id === "control" && inbox.length > 0 && (
              <span className="ag-rail-badge" aria-label={`나를 기다림 ${inbox.length}`}>
                {inbox.length}
              </span>
            )}
          </button>
        ))}
      </nav>
      <div className="ag-stage">
        {error !== null && (
          <div className="ag-error" role="alert">
            <span>{error}</span>
            <button
              className="ag-icon-button"
              type="button"
              aria-label="알림 닫기"
              onClick={() => setError(null)}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {missingDecision && (
          <div className="ag-error" role="status">
            <span>알림이 가리킨 질문은 이미 답했거나 취소되었습니다.</span>
            <button
              className="ag-icon-button"
              type="button"
              aria-label="알림 닫기"
              onClick={() => setDecisionKey(null)}
            >
              <Icon name="x" size={16} />
            </button>
          </div>
        )}
        {value === null ? (
          error === null && (
            <div className="inline-loading">
              <span /> 에이전트 정보를 여는 중…
            </div>
          )
        ) : (
          <AgentAppContext.Provider value={value}>
            {screen === "control" ? (
              <ControlRoom />
            ) : screen === "chat" ? (
              <AgentChat agentId={chatAgentId} onBack={() => setChatAgentId(null)} />
            ) : (
              <FlowView
                projectId={flow.projectId}
                taskId={flow.taskId}
                onSelect={(projectId, taskId) => setFlow({ projectId, taskId })}
              />
            )}
            {decision !== undefined && (
              <DecisionSheet
                key={decision.key}
                item={decision}
                onClose={() => setDecisionKey(null)}
              />
            )}
          </AgentAppContext.Provider>
        )}
      </div>
    </section>
  );
}

function messageOf(failure: unknown): string {
  return failure instanceof ApiFailure ? failure.message : "요청을 처리하지 못했습니다.";
}
