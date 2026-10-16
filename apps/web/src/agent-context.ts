import type { AgentEvent, AgentSession, AgentTaskDetail } from "@naru/contracts/naru-agent/v1";
import { createContext, useContext, useEffect, useState } from "react";
import type { AgentIdentity, InboxItem, Presence } from "./agent-model";
import type { AgentBoard, AgentJob, AgentWorking, NaruApi } from "./api";

/** What every agent screen reads and does, provided once by AgentApp (AP-D022). */
export interface AgentAppContextValue {
  readonly api: NaruApi;
  readonly board: AgentBoard;
  readonly events: readonly AgentEvent[];
  /** When the board was last read; relative times count from here. */
  readonly now: number;
  readonly mutationAllowed: boolean;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly currentProjectId: string;
  readonly agents: readonly AgentSession[];
  readonly inbox: readonly InboxItem[];
  /** The person's goals and the tasks they became (AP-D034). */
  readonly jobs: readonly AgentJob[];
  /** Agents whose turn runs now, by agent session id (AP-D034). */
  readonly working: ReadonlyMap<string, AgentWorking>;
  identity(agent: AgentSession): AgentIdentity;
  agentById(agentSessionId: string | null): AgentSession | undefined;
  projectName(projectId: string | null): string;
  presence(agent: AgentSession): Presence;
  /** Runs a change, announces `label` politely and re-reads the board; false when it failed. */
  act(label: string, action: () => Promise<unknown>): Promise<boolean>;
  openChat(agentSessionId: string): void;
  openFlow(projectId: string, taskId?: string | null): void;
  openDecision(item: InboxItem): void;
  /** Shows an agent's or process's Pane in its workspace (TUI, console, terminal). */
  openPane(paneId: string, projectId: string | null): void;
}

export const AgentAppContext = createContext<AgentAppContextValue | null>(null);

export function useAgentApp(): AgentAppContextValue {
  const value = useContext(AgentAppContext);
  if (value === null) throw new Error("Agent screens need AgentApp.");
  return value;
}

const TASK_POLL_MS = 4_000;

/** One task with its runs, reviews, artifacts and merge gate, re-read while it is shown. */
export function useTaskDetail(taskId: string | null): AgentTaskDetail | null {
  const { api } = useAgentApp();
  // Keyed by task, so a newly selected task never shows the previous one's record.
  const [loaded, setLoaded] = useState<{
    readonly id: string;
    readonly detail: AgentTaskDetail;
  } | null>(null);
  useEffect(() => {
    if (taskId === null) return;
    let stopped = false;
    const load = async () => {
      try {
        const detail = await api.agentTask(taskId);
        if (!stopped) setLoaded({ id: taskId, detail });
      } catch {
        // Keep what was shown; the board still shows the task and the next read tries again.
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
  return loaded !== null && loaded.id === taskId ? loaded.detail : null;
}
