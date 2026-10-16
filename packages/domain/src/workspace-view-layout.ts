import type {
  LayoutNode,
  SplitDirection,
  WorkspaceSlotPane,
  WorkspaceViewLayoutNode,
  WorkspaceViewPaneNode,
  WorkspaceViewSlotNode,
} from "@naru/contracts";

/**
 * Workspace arrangements (AP-D031). A workspace holds some of the project's Panes and places for
 * Panes not started yet; every operation returns a new tree and leaves the input unchanged.
 */

/** Where something goes in a workspace: beside a Pane or a place, or alone in an empty one. */
export type ViewTarget =
  | { readonly type: "pane"; readonly paneId: string }
  | { readonly type: "slot"; readonly slotId: string };

export const DEFAULT_VIEW_SLOTS = {
  claude: { kind: "claude", launchProfile: "claude-code" },
  codex: { kind: "codex", launchProfile: "codex-main" },
  terminal: { kind: "terminal", launchProfile: "shell" },
} as const satisfies Record<string, WorkspaceSlotPane>;

export function viewPaneNode(paneId: string): WorkspaceViewPaneNode {
  return { type: "pane", paneId };
}

export function viewSlotNode(
  pane: WorkspaceSlotPane,
  id: string = globalThis.crypto.randomUUID(),
): WorkspaceViewSlotNode {
  return { type: "slot", id, pane: { ...pane } };
}

/** Panes in reading order (left to right, top to bottom). */
export function viewPaneIds(root: WorkspaceViewLayoutNode | null): string[] {
  if (root === null) return [];
  if (root.type === "pane") return [root.paneId];
  if (root.type === "slot") return [];
  return [...viewPaneIds(root.first), ...viewPaneIds(root.second)];
}

export function firstViewPaneId(root: WorkspaceViewLayoutNode | null): string | null {
  return viewPaneIds(root)[0] ?? null;
}

export function viewSlots(root: WorkspaceViewLayoutNode | null): WorkspaceViewSlotNode[] {
  if (root === null) return [];
  if (root.type === "slot") return [root];
  if (root.type === "pane") return [];
  return [...viewSlots(root.first), ...viewSlots(root.second)];
}

export function viewContainsPane(root: WorkspaceViewLayoutNode | null, paneId: string): boolean {
  return viewPaneIds(root).includes(paneId);
}

/**
 * Splits the target with `node` on its right (horizontal) or below it (vertical). An empty
 * workspace takes the node as its whole layout and needs no target.
 */
export function insertIntoView(
  root: WorkspaceViewLayoutNode | null,
  node: WorkspaceViewPaneNode | WorkspaceViewSlotNode,
  target: ViewTarget | null,
  direction: SplitDirection,
  splitId: string = globalThis.crypto.randomUUID(),
): WorkspaceViewLayoutNode {
  if (node.type === "pane" && viewContainsPane(root, node.paneId)) {
    throw new Error(`Pane ${node.paneId} is already in the workspace.`);
  }
  if (root === null) return node;
  if (target === null) throw new Error("A target is required in a workspace that is not empty.");
  if (!hasTarget(root, target)) throw new Error("The target is not in the workspace.");

  const replace = (current: WorkspaceViewLayoutNode): WorkspaceViewLayoutNode => {
    if (current.type === "split") {
      return { ...current, first: replace(current.first), second: replace(current.second) };
    }
    if (!matches(current, target)) return current;
    return { type: "split", id: splitId, direction, ratio: 0.5, first: current, second: node };
  };
  return replace(root);
}

/** Takes a Pane out of the workspace; the split that held it collapses into its sibling. */
export function removePaneFromView(
  root: WorkspaceViewLayoutNode | null,
  paneId: string,
): WorkspaceViewLayoutNode | null {
  return removeWhere(root, (node) => node.type === "pane" && node.paneId === paneId);
}

export function removeSlotFromView(
  root: WorkspaceViewLayoutNode | null,
  slotId: string,
): WorkspaceViewLayoutNode | null {
  return removeWhere(root, (node) => node.type === "slot" && node.id === slotId);
}

/** Puts a Pane into an empty place; the arrangement around it stays as it was. */
export function fillViewSlot(
  root: WorkspaceViewLayoutNode,
  slotId: string,
  paneId: string,
): WorkspaceViewLayoutNode {
  if (viewContainsPane(root, paneId))
    throw new Error(`Pane ${paneId} is already in the workspace.`);
  if (!hasTarget(root, { type: "slot", slotId })) throw new Error(`Slot ${slotId} is missing.`);
  const replace = (node: WorkspaceViewLayoutNode): WorkspaceViewLayoutNode => {
    if (node.type === "split") {
      return { ...node, first: replace(node.first), second: replace(node.second) };
    }
    return node.type === "slot" && node.id === slotId ? viewPaneNode(paneId) : node;
  };
  return replace(root);
}

export function resizeViewSplit(
  root: WorkspaceViewLayoutNode,
  splitId: string,
  ratio: number,
): WorkspaceViewLayoutNode {
  if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) {
    throw new Error("Split ratio must be between 0.1 and 0.9.");
  }
  let found = false;
  const replace = (node: WorkspaceViewLayoutNode): WorkspaceViewLayoutNode => {
    if (node.type !== "split") return node;
    if (node.id === splitId) {
      found = true;
      return { ...node, ratio };
    }
    return { ...node, first: replace(node.first), second: replace(node.second) };
  };
  const next = replace(root);
  if (!found) throw new Error(`Split ${splitId} does not exist in the workspace.`);
  return next;
}

/**
 * Checks a workspace against the project's Panes: each Pane at most once and existing, unique
 * place and split ids, ratios in range and a bounded depth. Panes need not all be present.
 */
export function validateViewLayout(
  root: WorkspaceViewLayoutNode | null,
  paneIds: ReadonlySet<string>,
  maxDepth = 12,
): void {
  const seenPanes = new Set<string>();
  const seenIds = new Set<string>();
  const seenNodes = new WeakSet<object>();

  const visit = (node: WorkspaceViewLayoutNode, depth: number): void => {
    if (depth > maxDepth) throw new Error(`Workspace exceeds maximum depth ${maxDepth}.`);
    if (seenNodes.has(node)) throw new Error("Workspace contains a cycle or reused node.");
    seenNodes.add(node);
    if (node.type === "pane") {
      if (!paneIds.has(node.paneId)) throw new Error(`Workspace references unknown Pane.`);
      if (seenPanes.has(node.paneId)) throw new Error("Workspace references a Pane twice.");
      seenPanes.add(node.paneId);
      return;
    }
    if (seenIds.has(node.id)) throw new Error("Workspace reuses a split or place id.");
    seenIds.add(node.id);
    if (node.type === "slot") return;
    if (!Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) {
      throw new Error("Workspace split has an invalid ratio.");
    }
    visit(node.first, depth + 1);
    visit(node.second, depth + 1);
  };
  if (root !== null) visit(root, 1);
}

/**
 * The default workspace (AP-D027): Claude left and the main Codex right above, a terminal below,
 * with the proportions of the project's own default layout. A missing Pane keeps an empty place.
 */
export function defaultViewLayout(
  panes: {
    readonly claude: string | null;
    readonly codex: string | null;
    readonly terminal: string | null;
  },
  newId: () => string = () => globalThis.crypto.randomUUID(),
): WorkspaceViewLayoutNode {
  const place = (paneId: string | null, slot: WorkspaceSlotPane): WorkspaceViewLayoutNode =>
    paneId === null ? viewSlotNode(slot, newId()) : viewPaneNode(paneId);
  return {
    type: "split",
    id: newId(),
    direction: "vertical",
    ratio: 0.64,
    first: {
      type: "split",
      id: newId(),
      direction: "horizontal",
      ratio: 0.5,
      first: place(panes.claude, DEFAULT_VIEW_SLOTS.claude),
      second: place(panes.codex, DEFAULT_VIEW_SLOTS.codex),
    },
    second: place(panes.terminal, DEFAULT_VIEW_SLOTS.terminal),
  };
}

/** What a project layout shows, as a workspace: collapsed Panes are left out (AP-D031). */
export function viewFromProjectLayout(root: LayoutNode | null): WorkspaceViewLayoutNode | null {
  if (root === null) return null;
  if (root.type === "pane") return root.collapsed ? null : viewPaneNode(root.paneId);
  const first = viewFromProjectLayout(root.first);
  const second = viewFromProjectLayout(root.second);
  if (first === null) return second;
  if (second === null) return first;
  return {
    type: "split",
    id: root.id,
    direction: root.direction,
    ratio: root.ratio,
    first,
    second,
  };
}

function matches(node: WorkspaceViewLayoutNode, target: ViewTarget): boolean {
  return target.type === "pane"
    ? node.type === "pane" && node.paneId === target.paneId
    : node.type === "slot" && node.id === target.slotId;
}

function hasTarget(root: WorkspaceViewLayoutNode, target: ViewTarget): boolean {
  if (root.type === "split") return hasTarget(root.first, target) || hasTarget(root.second, target);
  return matches(root, target);
}

function removeWhere(
  root: WorkspaceViewLayoutNode | null,
  remove: (node: WorkspaceViewLayoutNode) => boolean,
): WorkspaceViewLayoutNode | null {
  if (root === null || remove(root)) return null;
  if (root.type !== "split") return root;
  const first = removeWhere(root.first, remove);
  const second = removeWhere(root.second, remove);
  if (first === null) return second;
  if (second === null) return first;
  if (first === root.first && second === root.second) return root;
  return { ...root, first, second };
}
