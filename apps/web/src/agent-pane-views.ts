import type { Pane } from "@naru/contracts";
import type { AgentSession } from "@naru/contracts/naru-agent/v1";
import { createContext, useCallback, useContext } from "react";
import { AgentAppContext } from "./agent-context";

/** How an agent's Pane shows it: its conversation, its TUI, or the runner's console (AP-D028). */
export type AgentPaneView = "chat" | "tui" | "console";

export interface PaneViews {
  /** What the person chose where it does not follow the runtime (the console, Codex's TUI). */
  readonly chosen: ReadonlyMap<string, AgentPaneView>;
  /** Agents whose conversation is moving between the runner and the TUI, and where to. */
  readonly switching: ReadonlyMap<string, "chat" | "tui">;
  /** Agents in the middle of a turn, waiting for the person to confirm stopping it. */
  readonly confirming: ReadonlySet<string>;
  readonly choose: (paneId: string, view: AgentPaneView | null) => void;
  readonly show: (agent: AgentSession, view: "chat" | "tui", confirmed?: boolean) => Promise<void>;
  readonly cancel: (agentSessionId: string) => void;
}

export const PaneViewsContext = createContext<PaneViews | null>(null);

/** Claude runs as a runner or a TUI (AP-D011): its form decides; elsewhere the person's choice. */
export function paneView(
  agent: Pick<AgentSession, "runtime" | "launchMode">,
  chosen: AgentPaneView | undefined,
): AgentPaneView {
  if (agent.runtime === "claude") {
    if (agent.launchMode === "tui") return "tui";
    return chosen === "console" ? "console" : "chat";
  }
  return chosen === "tui" ? "tui" : "chat";
}

/**
 * Which workspace Panes belong to a managed agent, and which of them show the agent's conversation
 * over the terminal now. Outside `WorkspaceAgents` no Pane does.
 */
export function useAgentPanes(): {
  readonly agentFor: (pane: Pane) => AgentSession | undefined;
  readonly covered: (pane: Pane) => boolean;
} {
  const app = useContext(AgentAppContext);
  const views = useContext(PaneViewsContext);
  const agentFor = useCallback(
    (pane: Pane): AgentSession | undefined =>
      views === null
        ? undefined
        : app?.agents.find(
            (agent) => agent.paneId === pane.id && !agent.retiredAt && !agent.native,
          ),
    [app, views],
  );
  const covered = useCallback(
    (pane: Pane): boolean => {
      const agent = agentFor(pane);
      if (agent === undefined || views === null) return false;
      return views.switching.has(agent.id) || paneView(agent, views.chosen.get(pane.id)) === "chat";
    },
    [agentFor, views],
  );
  return { agentFor, covered };
}
