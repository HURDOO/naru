import { useEffect, useMemo, useRef, useState } from "react";
import { AgentAppContext, type AgentAppContextValue } from "./agent-context";
import { useAgentData } from "./agent-data";
import type { InboxItem } from "./agent-model";
import { AgentChat } from "./AgentChat";
import { DecisionSheet } from "./AgentInbox";
import { Icon, type IconName } from "./agent-ui";
import { PHONE, useMedia } from "./agent-dom";
import type { AgentJob, NaruApi } from "./api";
import { ControlRoom } from "./ControlRoom";
import { FlowView } from "./FlowView";
import { JobSheet } from "./JobSheets";
import "./agent-app.css";

type Screen = "control" | "chat" | "flow";

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
  /**
   * The screen the top menu chose (AP-D028). When given, the rail is gone and a conversation
   * opens over this screen until the menu is used again.
   */
  readonly view?: "control" | "flow";
  readonly onViewChange?: (view: "control" | "flow") => void;
  /** Changes whenever the top menu is pressed, so an open conversation closes. */
  readonly navigation?: number;
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
  view,
  onViewChange,
  navigation,
}: AgentAppProps): React.JSX.Element {
  const phone = useMedia(PHONE);
  const data = useAgentData({
    api,
    projects,
    currentProjectId,
    mutationAllowed,
    ...(onWaitingChange === undefined ? {} : { onWaitingChange }),
  });
  const { board, error, status, context } = data;
  // The job as it was when its sheet opened: completing it takes it out of the inbox (AP-D036).
  const [jobSheet, setJobSheet] = useState<{
    readonly job: AgentJob;
    readonly action: "complete" | "reopen";
  } | null>(null);
  const [ownScreen, setScreen] = useState<Screen>(
    initialAgentPaneId === null ? (view ?? "control") : "chat",
  );
  // The top menu owns control room and flow; a conversation sits over them until it is used.
  const controlled = view !== undefined;
  const screen: Screen = controlled && ownScreen !== "chat" ? view : ownScreen;
  const lastNavigation = useRef(navigation);
  useEffect(() => {
    if (!controlled || lastNavigation.current === navigation) return;
    lastNavigation.current = navigation;
    setScreen(view);
  }, [controlled, navigation, view]);
  const [chatAgentId, setChatAgentId] = useState<string | null>(null);
  const [flow, setFlow] = useState<{ projectId: string | null; taskId: string | null }>({
    projectId: null,
    taskId: null,
  });
  const [decisionKey, setDecisionKey] = useState<string | null>(
    initialHandoffId === null ? null : `handoff:${initialHandoffId}`,
  );

  const value = useMemo<AgentAppContextValue | null>(
    () =>
      context({
        openChat: (agentSessionId) => {
          setChatAgentId(agentSessionId);
          setScreen("chat");
          setDecisionKey(null);
        },
        openFlow: (projectId, taskId = null) => {
          setFlow({ projectId, taskId });
          setScreen("flow");
          onViewChange?.("flow");
          setDecisionKey(null);
        },
        openDecision: (item: InboxItem) => {
          if (item.kind === "job") setJobSheet({ job: item.job, action: "complete" });
          else setDecisionKey(item.key);
        },
        openJob: (job, action) => setJobSheet({ job, action }),
        openPane: onOpenPane,
      }),
    [context, onOpenPane, onViewChange],
  );
  const inbox = value?.inbox ?? [];

  // An alert names the agent's Pane: open its chat once the board that binds it has loaded.
  const pendingPane = useRef(initialAgentPaneId);
  useEffect(() => {
    if (pendingPane.current === null || value === null) return;
    const agent = value.agents.find((candidate) => candidate.paneId === pendingPane.current);
    pendingPane.current = null;
    if (agent !== undefined) {
      setChatAgentId(agent.id);
      setScreen("chat");
    }
  }, [value]);

  const decision = inbox.find(
    (item): item is Extract<InboxItem, { kind: "handoff" | "contract" }> =>
      item.key === decisionKey && (item.kind === "handoff" || item.kind === "contract"),
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
      data-rail={controlled ? "none" : "own"}
    >
      <p className="sr-only" role="status" aria-live="polite">
        {status}
      </p>
      {!controlled && (
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
      )}
      <div className="ag-stage">
        {error !== null && (
          <div className="ag-error" role="alert">
            <span>{error}</span>
            <button
              className="ag-icon-button"
              type="button"
              aria-label="알림 닫기"
              onClick={data.dismissError}
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
            {jobSheet !== null && (
              <JobSheet
                key={`${jobSheet.action}:${jobSheet.job.goal.id}`}
                job={jobSheet.job}
                action={jobSheet.action}
                onClose={() => setJobSheet(null)}
              />
            )}
          </AgentAppContext.Provider>
        )}
      </div>
    </section>
  );
}
