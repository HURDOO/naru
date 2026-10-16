import type { Pane } from "@naru/contracts";
import type { AgentSession } from "@naru/contracts/naru-agent/v1";
import { type ReactNode, useCallback, useContext, useMemo, useState } from "react";
import { AgentAppContext, type AgentAppContextValue } from "./agent-context";
import { useAgentData } from "./agent-data";
import { isLive } from "./agent-model";
import {
  type AgentPaneView,
  paneView,
  type PaneViews,
  PaneViewsContext,
  useAgentPanes,
} from "./agent-pane-views";
import { Icon } from "./agent-ui";
import { PaneConversation } from "./AgentChat";
import { DecisionSheet } from "./AgentInbox";
import type { AgentJob, NaruApi } from "./api";
import { JobSheet } from "./JobSheets";
import "./agent-app.css";

/**
 * The agent data for the workspace's agent Panes (AP-D028): each agent's Pane shows its
 * conversation and switches to its TUI in place. Decisions and jobs opened from a conversation
 * show here as sheets; a flow or another agent opens through the top menu or its own Pane.
 */
export function WorkspaceAgents({
  api,
  projects,
  currentProjectId,
  mutationAllowed,
  onOpenPane,
  onNavigate,
  children,
}: {
  readonly api: NaruApi;
  readonly projects: readonly { readonly id: string; readonly name: string }[];
  readonly currentProjectId: string;
  readonly mutationAllowed: boolean;
  readonly onOpenPane: (paneId: string, projectId: string | null) => void;
  readonly onNavigate: (view: "control" | "flow") => void;
  readonly children: ReactNode;
}): React.JSX.Element {
  const { context, error, status, dismissError } = useAgentData({
    api,
    projects,
    currentProjectId,
    mutationAllowed,
  });
  const [decisionKey, setDecisionKey] = useState<string | null>(null);
  const [jobSheet, setJobSheet] = useState<{
    readonly job: AgentJob;
    readonly action: "complete" | "reopen";
  } | null>(null);
  const value = useMemo(() => {
    let built: AgentAppContextValue | null = null;
    built = context({
      openChat: (agentSessionId) => {
        const agent = built?.agentById(agentSessionId);
        if (agent?.paneId != null) onOpenPane(agent.paneId, agent.projectId);
        else onNavigate("control");
      },
      openFlow: () => onNavigate("flow"),
      openDecision: (item) => {
        if (item.kind === "job") setJobSheet({ job: item.job, action: "complete" });
        else setDecisionKey(item.key);
      },
      openJob: (job, action) => setJobSheet({ job, action }),
      openPane: onOpenPane,
    });
    return built;
  }, [context, onNavigate, onOpenPane]);

  const [chosen, setChosen] = useState<ReadonlyMap<string, AgentPaneView>>(new Map());
  const [switching, setSwitching] = useState<ReadonlyMap<string, "chat" | "tui">>(new Map());
  const [confirming, setConfirming] = useState<ReadonlySet<string>>(new Set());
  const choose = useCallback((paneId: string, view: AgentPaneView | null) => {
    setChosen((current) => {
      const next = new Map(current);
      if (view === null) next.delete(paneId);
      else next.set(paneId, view);
      return next;
    });
  }, []);
  const cancel = useCallback((agentSessionId: string) => {
    setConfirming((current) => {
      const next = new Set(current);
      next.delete(agentSessionId);
      return next;
    });
  }, []);
  const show = useCallback(
    async (agent: AgentSession, view: "chat" | "tui", confirmed = false): Promise<void> => {
      if (value === null || agent.paneId === null) return;
      const paneId = agent.paneId;
      const current = paneView(agent, chosen.get(paneId));
      if (view === "chat" && current === "console") {
        choose(paneId, null);
        return;
      }
      if (current === view) return;
      // Leaving the TUI: the person keeps the conversation and goes on in chat.
      if (view === "chat") {
        setSwitching((map) => new Map(map).set(agent.id, "chat"));
        await value.act("대화로 돌아왔습니다.", () =>
          value.api.setAgentHold(agent.id, true, "chat"),
        );
        choose(paneId, null);
        setSwitching((map) => without(map, agent.id));
        return;
      }
      // Into the TUI: the person takes the agent over there. A running turn stops, so ask first.
      const runtime = await value.api.agentRuntime(agent.id).catch(() => null);
      const turnActive = runtime?.turnActive === true;
      if (turnActive && !confirmed) {
        setConfirming((set) => new Set(set).add(agent.id));
        return;
      }
      cancel(agent.id);
      setSwitching((map) => new Map(map).set(agent.id, "tui"));
      const done = await value.act("TUI로 이어받았습니다.", () =>
        value.api.setAgentHold(agent.id, true, "tui", turnActive),
      );
      // Claude's form now says TUI; coming back later shows the conversation, not the console.
      if (done) choose(paneId, agent.runtime === "claude" ? null : "tui");
      setSwitching((map) => without(map, agent.id));
    },
    [cancel, choose, chosen, value],
  );
  const views = useMemo<PaneViews>(
    () => ({ chosen, switching, confirming, choose, show, cancel }),
    [cancel, choose, chosen, confirming, show, switching],
  );

  const decision = value?.inbox.find(
    (item): item is Extract<(typeof value.inbox)[number], { kind: "handoff" | "contract" }> =>
      item.key === decisionKey && (item.kind === "handoff" || item.kind === "contract"),
  );
  return (
    <AgentAppContext.Provider value={value}>
      <PaneViewsContext.Provider value={views}>
        {children}
        <div className="ag-app ag-pane-overlays">
          <p className="sr-only" role="status" aria-live="polite">
            {status}
          </p>
          {error !== null && value !== null && (
            <div className="ag-error ag-pane-error" role="alert">
              <span>{error}</span>
              <button
                className="ag-icon-button"
                type="button"
                aria-label="알림 닫기"
                onClick={dismissError}
              >
                <Icon name="x" size={16} />
              </button>
            </div>
          )}
          {decision !== undefined && (
            <DecisionSheet
              key={decision.key}
              item={decision}
              onClose={() => setDecisionKey(null)}
            />
          )}
          {jobSheet !== null && (
            <JobSheet
              key={`${jobSheet.action}:${jobSheet.job.goal.id}`}
              job={jobSheet.job}
              action={jobSheet.action}
              onClose={() => setJobSheet(null)}
            />
          )}
        </div>
      </PaneViewsContext.Provider>
    </AgentAppContext.Provider>
  );
}

/** An agent's conversation over its terminal Pane, or the step between it and the TUI. */
export function AgentPaneCover({ pane }: { readonly pane: Pane }): React.JSX.Element | null {
  const views = useContext(PaneViewsContext);
  const agent = useAgentPanes().agentFor(pane);
  if (agent === undefined || views === null) return null;
  const going = views.switching.get(agent.id);
  return (
    <div className="ag-app ag-pane-host">
      {going !== undefined ? (
        <div className="ag-pane-switching" role="status" aria-live="polite">
          <span className="ag-pane-spinner" aria-hidden="true" />
          <p>
            {going === "tui"
              ? `${agent.runtime === "claude" ? "Claude Code TUI" : "TUI"}로 이어받는 중…`
              : "대화로 돌아가는 중…"}
          </p>
          <span className="ag-muted">같은 대화를 이어서 엽니다.</span>
        </div>
      ) : (
        <PaneConversation
          agent={agent}
          notice={
            views.confirming.has(agent.id) ? (
              <div className="ag-pane-confirm" role="group" aria-label="TUI로 이어받기">
                <p>지금 일하는 중입니다. TUI로 이어받으면 이 차례를 멈춥니다.</p>
                <span>
                  <button
                    className="ag-button"
                    type="button"
                    onClick={() => views.cancel(agent.id)}
                  >
                    취소
                  </button>
                  <button
                    className="ag-button"
                    data-variant="primary"
                    type="button"
                    onClick={() => void views.show(agent, "tui", true)}
                  >
                    멈추고 TUI로
                  </button>
                </span>
              </div>
            ) : null
          }
          onShowConsole={
            agent.runtime === "claude" && agent.launchMode !== "tui"
              ? () => views.choose(pane.id, "console")
              : null
          }
        />
      )}
    </div>
  );
}

/** "대화 | TUI" in an agent Pane's header: TUI takes the agent over there, 대화 comes back. */
export function AgentViewSwitch({ pane }: { readonly pane: Pane }): React.JSX.Element | null {
  const app = useContext(AgentAppContext);
  const views = useContext(PaneViewsContext);
  const agent = useAgentPanes().agentFor(pane);
  if (agent === undefined || views === null || app === null) return null;
  const view = paneView(agent, views.chosen.get(pane.id));
  const busy = views.switching.has(agent.id);
  // The TUI needs the agent running: a stopped one is started again from its conversation.
  const canTui = isLive(agent);
  const enabled = app.mutationAllowed && !busy;
  return (
    <div className="view-mode-control agent-view-switch" role="group" aria-label="에이전트 보기">
      <button
        type="button"
        aria-pressed={view === "chat"}
        disabled={!enabled}
        title="대화로 보기"
        onClick={() => void views.show(agent, "chat")}
      >
        대화
      </button>
      <button
        type="button"
        aria-pressed={view === "tui"}
        disabled={!enabled || (!canTui && view !== "tui")}
        title={
          canTui
            ? "TUI로 직접 이어받기 (일하는 중이면 먼저 묻습니다)"
            : "멈춘 에이전트는 다시 실행한 뒤 TUI로 열 수 있습니다"
        }
        onClick={() => void views.show(agent, "tui")}
      >
        TUI
      </button>
      {view === "console" && <span className="agent-view-console">콘솔</span>}
    </div>
  );
}

function without<V>(map: ReadonlyMap<string, V>, key: string): ReadonlyMap<string, V> {
  const next = new Map(map);
  next.delete(key);
  return next;
}
