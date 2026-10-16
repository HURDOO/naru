import type {
  Pane,
  Workspace,
  WorkspaceSlotPane,
  WorkspaceView,
  WorkspaceViewLayoutNode,
} from "@naru/contracts";
import type { AgentSession, SharedProcess } from "@naru/contracts/naru-agent/v1";
import {
  firstViewPaneId,
  insertIntoView,
  viewContainsPane,
  viewPaneIds,
  viewPaneNode,
} from "@naru/domain";
import { agentIdentity, boardAgents, isLive } from "./agent-model";
import type { AgentBoard } from "./api";
export type { WorkspaceSelection } from "./workspace-selection";

/**
 * View model for the workspace list (AP-D027..D031): who writes each Pane, the names the person
 * sees, what is open on this device and the small layout pictures in the list.
 */

/**
 * Who writes a Pane (AP-D005, AP-D029). A Pane nobody bound to an agent is the person's own; an
 * agent's Pane or an agent's shared process is the agent's until the person takes it over.
 */
export type PaneOwner =
  | { readonly kind: "mine" }
  | {
      readonly kind: "agent";
      readonly agent: AgentSession;
      readonly name: string;
      readonly held: boolean;
    }
  | {
      readonly kind: "process";
      readonly process: SharedProcess;
      readonly name: string;
      readonly held: boolean;
    };

const MINE: PaneOwner = { kind: "mine" };

/** Owners of the Panes agents hold, by Pane id; every other Pane is the person's. */
export function paneOwners(
  board: AgentBoard | null,
  projectName: (projectId: string | null) => string,
): ReadonlyMap<string, PaneOwner> {
  const owners = new Map<string, PaneOwner>();
  if (board === null) return owners;
  const agents = boardAgents(board);
  for (const agent of agents) {
    if (agent.paneId === null) continue;
    owners.set(agent.paneId, {
      kind: "agent",
      agent,
      name: board.paneNames?.[agent.paneId] ?? agentIdentity(agent, agents, projectName).name,
      held: agent.humanHoldSince !== null,
    });
  }
  for (const process of board.projects.flatMap((project) => project.processes)) {
    if (process.paneId === null) continue;
    owners.set(process.paneId, {
      kind: "process",
      process,
      name: process.purpose,
      held: process.humanHoldSince !== null,
    });
  }
  return owners;
}

export function ownerOf(owners: ReadonlyMap<string, PaneOwner>, paneId: string): PaneOwner {
  return owners.get(paneId) ?? MINE;
}

/** The person's name first, then the agent's, then the name Naru gave the Pane. */
export function paneDisplayName(pane: Pane, owner: PaneOwner = MINE): string {
  if (pane.customTitle) return pane.customTitle;
  return owner.kind === "agent" ? owner.name : pane.title;
}

/** The short owner label in a Pane header and the list (V3-H). */
export function ownerLabel(owner: PaneOwner): string {
  if (owner.kind === "mine") return "나 · 내 Pane";
  if (owner.held) return "나 · 끼어든 중";
  if (owner.kind === "process") return `${owner.name} · 에이전트`;
  return `${owner.name} · ${isLive(owner.agent) && owner.agent.status === "active" ? "쓰는 중" : "에이전트"}`;
}

export function slotTitle(pane: WorkspaceSlotPane): string {
  switch (pane.kind) {
    case "claude":
      return "Claude";
    case "codex":
      return pane.launchProfile === "codex-main" ? "메인 Codex" : "Codex";
    case "terminal":
      return "터미널";
  }
}

export function workspaceViews(workspace: Workspace | null): readonly WorkspaceView[] {
  return workspace?.views ?? [];
}

/** "작업공간 N" with the first number no workspace uses yet. */
export function nextViewName(views: readonly WorkspaceView[]): string {
  const names = new Set(views.map((view) => view.name));
  for (let index = views.length + 1; ; index += 1) {
    const name = `작업공간 ${index}`;
    if (!names.has(name)) return name;
  }
}

/** Adds a Pane next to the active one (or alone in an empty workspace); keeps it if present. */
export function addPaneToView(view: WorkspaceView, paneId: string): WorkspaceView {
  if (viewContainsPane(view.layout, paneId)) return { ...view, activePaneId: paneId };
  const target = view.activePaneId ?? viewPaneIds(view.layout).at(-1) ?? null;
  const layout =
    view.layout === null
      ? viewPaneNode(paneId)
      : target === null
        ? insertIntoView(
            view.layout,
            viewPaneNode(paneId),
            firstSlotTarget(view.layout),
            "horizontal",
          )
        : insertIntoView(
            view.layout,
            viewPaneNode(paneId),
            { type: "pane", paneId: target },
            "horizontal",
          );
  return { ...view, layout, activePaneId: paneId };
}

export function activeViewPaneId(view: WorkspaceView): string | null {
  return view.activePaneId !== null && viewContainsPane(view.layout, view.activePaneId)
    ? view.activePaneId
    : firstViewPaneId(view.layout);
}

/** Rectangles (0..1) of a workspace for the small picture beside its name in the list. */
export interface ThumbnailCell {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly empty: boolean;
}

export function viewThumbnail(layout: WorkspaceViewLayoutNode | null): ThumbnailCell[] {
  if (layout === null) return [];
  const cells: ThumbnailCell[] = [];
  const visit = (
    node: WorkspaceViewLayoutNode,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void => {
    if (node.type !== "split") {
      cells.push({ x, y, width, height, empty: node.type === "slot" });
      return;
    }
    if (node.direction === "horizontal") {
      visit(node.first, x, y, width * node.ratio, height);
      visit(node.second, x + width * node.ratio, y, width * (1 - node.ratio), height);
    } else {
      visit(node.first, x, y, width, height * node.ratio);
      visit(node.second, x, y + height * node.ratio, width, height * (1 - node.ratio));
    }
  };
  visit(layout, 0, 0, 1, 1);
  return cells;
}

function firstSlotTarget(layout: WorkspaceViewLayoutNode): { type: "slot"; slotId: string } {
  const find = (node: WorkspaceViewLayoutNode): string | null =>
    node.type === "slot"
      ? node.id
      : node.type === "split"
        ? (find(node.first) ?? find(node.second))
        : null;
  const slotId = find(layout);
  if (slotId === null) throw new Error("A workspace without Panes must hold a place.");
  return { type: "slot", slotId };
}
