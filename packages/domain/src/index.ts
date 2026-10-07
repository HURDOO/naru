import {
  LAYOUT_SCHEMA_VERSION,
  LayoutNodeSchema,
  type LayoutNode,
  type PaneNode,
  type SplitNode,
} from "@naru/contracts";

export type SplitDirection = SplitNode["direction"];
export { TerminalMouseEncoding } from "./terminal-mouse-encoding.js";

export function paneNode(paneId: string): PaneNode {
  return { type: "pane", paneId, collapsed: false };
}

export function splitPane(
  root: LayoutNode | null,
  targetPaneId: string,
  newPaneId: string,
  direction: SplitDirection,
  splitId = globalThis.crypto.randomUUID(),
): LayoutNode {
  if (root === null) {
    return paneNode(newPaneId);
  }

  if (containsPane(root, newPaneId)) {
    throw new Error(`Pane ${newPaneId} already exists in the layout.`);
  }
  if (containsSplit(root, splitId)) {
    throw new Error(`Split ${splitId} already exists in the layout.`);
  }

  function replace(node: LayoutNode): LayoutNode {
    if (node.type === "pane") {
      if (node.paneId !== targetPaneId) return node;

      return {
        type: "split",
        id: splitId,
        direction,
        ratio: 0.5,
        first: node,
        second: paneNode(newPaneId),
      };
    }

    if (containsPane(node.first, targetPaneId)) {
      return { ...node, first: replace(node.first) };
    }
    if (containsPane(node.second, targetPaneId)) {
      return { ...node, second: replace(node.second) };
    }
    return node;
  }

  if (!containsPane(root, targetPaneId)) {
    throw new Error(`Pane ${targetPaneId} does not exist in the layout.`);
  }
  return replace(root);
}

export function appendPane(root: LayoutNode | null, newPaneId: string): LayoutNode {
  if (root === null) {
    return paneNode(newPaneId);
  }

  const targetPaneId = firstPaneId(root);
  return splitPane(root, targetPaneId, newPaneId, "horizontal");
}

export function removePane(root: LayoutNode | null, paneId: string): LayoutNode | null {
  if (root === null) {
    return null;
  }

  if (root.type === "pane") {
    return root.paneId === paneId ? null : root;
  }

  const first = removePane(root.first, paneId);
  const second = removePane(root.second, paneId);

  if (first === null) return second;
  if (second === null) return first;
  return { ...root, first, second };
}

export function resizeSplit(root: LayoutNode, splitId: string, ratio: number): LayoutNode {
  if (!Number.isFinite(ratio) || ratio < 0.1 || ratio > 0.9) {
    throw new Error("Split ratio must be between 0.1 and 0.9.");
  }

  if (root.type === "pane") {
    throw new Error(`Split ${splitId} does not exist in the layout.`);
  }

  if (root.id === splitId) {
    return { ...root, ratio };
  }

  if (containsSplit(root.first, splitId)) {
    return { ...root, first: resizeSplit(root.first, splitId, ratio) };
  }

  if (containsSplit(root.second, splitId)) {
    return { ...root, second: resizeSplit(root.second, splitId, ratio) };
  }

  throw new Error(`Split ${splitId} does not exist in the layout.`);
}

export function setPaneCollapsed(root: LayoutNode, paneId: string, collapsed: boolean): LayoutNode {
  if (!containsPane(root, paneId)) {
    throw new Error(`Pane ${paneId} does not exist in the layout.`);
  }
  if (collapsed && visiblePaneIds(root).length <= 1 && !isPaneCollapsed(root, paneId)) {
    throw new Error("The last visible Pane cannot be collapsed.");
  }

  function replace(node: LayoutNode): LayoutNode {
    if (node.type === "pane") {
      return node.paneId === paneId ? { ...node, collapsed } : node;
    }
    if (containsPane(node.first, paneId)) {
      return { ...node, first: replace(node.first) };
    }
    return { ...node, second: replace(node.second) };
  }
  return replace(root);
}

export function visibleLayout(root: LayoutNode | null): LayoutNode | null {
  if (root === null) return null;
  if (root.type === "pane") return root.collapsed ? null : root;

  const first = visibleLayout(root.first);
  const second = visibleLayout(root.second);
  if (first === null) return second;
  if (second === null) return first;
  return { ...root, first, second };
}

export function visiblePaneIds(root: LayoutNode | null): string[] {
  if (root === null) return [];
  if (root.type === "pane") return root.collapsed ? [] : [root.paneId];
  return [...visiblePaneIds(root.first), ...visiblePaneIds(root.second)];
}

export function collapsedPaneIds(root: LayoutNode | null): string[] {
  if (root === null) return [];
  if (root.type === "pane") return root.collapsed ? [root.paneId] : [];
  return [...collapsedPaneIds(root.first), ...collapsedPaneIds(root.second)];
}

export function isPaneCollapsed(root: LayoutNode | null, paneId: string): boolean {
  if (root === null) return false;
  if (root.type === "pane") return root.paneId === paneId && root.collapsed;
  return isPaneCollapsed(root.first, paneId) || isPaneCollapsed(root.second, paneId);
}

export function validateLayout(
  root: LayoutNode | null,
  paneIds: ReadonlySet<string>,
  maxDepth = 12,
): void {
  if (!Number.isInteger(maxDepth) || maxDepth < 1) {
    throw new Error("Maximum layout depth must be a positive integer.");
  }

  const seenPanes = new Set<string>();
  const seenSplits = new Set<string>();
  const seenNodes = new WeakSet<object>();
  let visiblePanes = 0;

  function visit(node: LayoutNode, depth: number): void {
    if (depth > maxDepth) {
      throw new Error(`Layout exceeds maximum depth ${maxDepth}.`);
    }
    if (seenNodes.has(node)) {
      throw new Error("Layout contains a cycle or reused node.");
    }
    seenNodes.add(node);

    if (node.type === "pane") {
      if (!paneIds.has(node.paneId)) {
        throw new Error(`Layout references unknown Pane ${node.paneId}.`);
      }
      if (seenPanes.has(node.paneId)) {
        throw new Error(`Layout references Pane ${node.paneId} more than once.`);
      }
      seenPanes.add(node.paneId);
      if (!node.collapsed) visiblePanes += 1;
      return;
    }

    if (seenSplits.has(node.id)) {
      throw new Error(`Layout references Split ${node.id} more than once.`);
    }
    seenSplits.add(node.id);
    if (!Number.isFinite(node.ratio) || node.ratio < 0.1 || node.ratio > 0.9) {
      throw new Error(`Split ${node.id} has an invalid ratio.`);
    }
    visit(node.first, depth + 1);
    visit(node.second, depth + 1);
  }

  if (root !== null) {
    visit(root, 1);
  }

  if (seenPanes.size !== paneIds.size) {
    throw new Error("Layout does not reference every Pane exactly once.");
  }
  if (paneIds.size > 0 && visiblePanes === 0) {
    throw new Error("Layout must keep at least one Pane visible.");
  }
}

export function migrateLayout(layout: unknown, schemaVersion: number): LayoutNode | null {
  if (schemaVersion !== 1 && schemaVersion !== LAYOUT_SCHEMA_VERSION) {
    throw new Error(`Unsupported layout schema version ${schemaVersion}.`);
  }
  if (layout === null) return null;
  return LayoutNodeSchema.parse(schemaVersion === 1 ? migrateVersionOneNode(layout) : layout);
}

export function firstPaneId(root: LayoutNode): string {
  return root.type === "pane" ? root.paneId : firstPaneId(root.first);
}

function containsPane(root: LayoutNode, paneId: string): boolean {
  if (root.type === "pane") return root.paneId === paneId;
  return containsPane(root.first, paneId) || containsPane(root.second, paneId);
}

function containsSplit(root: LayoutNode, splitId: string): boolean {
  if (root.type === "pane") return false;
  return (
    root.id === splitId || containsSplit(root.first, splitId) || containsSplit(root.second, splitId)
  );
}

function migrateVersionOneNode(value: unknown): unknown {
  if (!isRecord(value)) return value;
  if (value.type === "pane") return { ...value, collapsed: false };
  if (value.type === "split") {
    return {
      ...value,
      first: migrateVersionOneNode(value.first),
      second: migrateVersionOneNode(value.second),
    };
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export * as DurableSessionCore from "./durable-session/index.js";
