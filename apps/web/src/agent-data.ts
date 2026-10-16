import type { AgentEvent, AgentSession } from "@naru/contracts/naru-agent/v1";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { AgentAppContextValue } from "./agent-context";
import { mergeEvents } from "./agent-events";
import {
  type AgentIdentity,
  agentIdentity,
  boardAgents,
  EVENT_FIRST_PAGE,
  inboxItems,
  namedAgents,
  presenceOf,
  waitingAgentIds,
} from "./agent-model";
import { ApiFailure, type AgentBoard, type AgentJob, type AgentWorking, type NaruApi } from "./api";

const BOARD_POLL_MS = 3_000;
const EVENT_PAGE = 500;
const EVENT_WINDOW = 3_000;

/** Where an agent screen goes for a conversation, a flow, a decision, a job or a Pane. */
export type AgentNavigation = Pick<
  AgentAppContextValue,
  "openChat" | "openFlow" | "openDecision" | "openJob" | "openPane"
>;

export interface AgentData {
  readonly board: AgentBoard | null;
  /** The last failure to read or change something, until the next success or dismissal. */
  readonly error: string | null;
  readonly dismissError: () => void;
  /** The last change's outcome, for a polite live region. */
  readonly status: string;
  /** What every agent screen reads; null until the board has loaded. */
  readonly context: (navigation: AgentNavigation) => AgentAppContextValue | null;
}

/**
 * The agents, jobs and events every agent screen reads (AP-D022), polled while mounted. The
 * control room and the workspace's agent Panes (AP-D028) each provide it to their screens.
 */
export function useAgentData({
  api,
  projects,
  currentProjectId,
  mutationAllowed,
  onWaitingChange,
}: {
  readonly api: NaruApi;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly currentProjectId: string;
  readonly mutationAllowed: boolean;
  readonly onWaitingChange?: (count: number) => void;
}): AgentData {
  const [board, setBoard] = useState<AgentBoard | null>(null);
  const [jobs, setJobs] = useState<readonly AgentJob[]>([]);
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
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
      const [next, nextJobs] = await Promise.all([
        api.agentBoard(),
        // A server without jobs (before AP-D034) still shows the rest.
        api.agentJobs().catch(() => null),
        loadEvents(),
      ]);
      setBoard(next);
      if (nextJobs !== null) setJobs(nextJobs);
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
  const inbox = useMemo(() => (board === null ? [] : inboxItems(board, jobs)), [board, jobs]);
  const waiting = useMemo(() => waitingAgentIds(inbox), [inbox]);
  const working = useMemo(() => {
    const map = new Map<string, AgentWorking>();
    for (const entry of [
      ...(board?.projects.flatMap((project) => project.working ?? []) ?? []),
      ...(board?.globalWorking ?? []),
    ]) {
      map.set(entry.agentSessionId, entry);
    }
    return map;
  }, [board]);

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
  // Cleaned-up agents (AP-D033) still name what they did, and keep everyone's numbers stable.
  const named = useMemo(() => (board === null ? [] : namedAgents(board)), [board]);
  const identities = useMemo(() => {
    const map = new Map<string, AgentIdentity>();
    for (const agent of named) {
      const identity = agentIdentity(agent, named, projectName);
      // A name the person gave the agent's Pane shows here too (AP-D029).
      const custom = agent.paneId === null ? undefined : board?.paneNames?.[agent.paneId];
      map.set(agent.id, custom === undefined ? identity : { ...identity, name: custom });
    }
    return map;
  }, [board, named, projectName]);

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

  const base = useMemo(() => {
    if (board === null) return null;
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
      jobs,
      working,
      identity: (agent: AgentSession) =>
        identities.get(agent.id) ?? agentIdentity(agent, named, projectName),
      agentById: (agentSessionId: string | null) =>
        agentSessionId === null ? undefined : named.find((agent) => agent.id === agentSessionId),
      projectName,
      presence: (agent: AgentSession) => presenceOf(agent, waiting.has(agent.id)),
      act,
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
    jobs,
    mutationAllowed,
    named,
    now,
    projectName,
    projects,
    waiting,
    working,
  ]);

  const context = useCallback(
    (navigation: AgentNavigation): AgentAppContextValue | null =>
      base === null ? null : { ...base, ...navigation },
    [base],
  );

  return {
    board,
    error,
    dismissError: useCallback(() => setError(null), []),
    status,
    context,
  };
}

export function messageOf(failure: unknown): string {
  return failure instanceof ApiFailure ? failure.message : "요청을 처리하지 못했습니다.";
}
