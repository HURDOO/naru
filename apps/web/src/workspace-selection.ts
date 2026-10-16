import type { Workspace } from "@naru/contracts";

/**
 * What this device has open in a project (AP-D031): one workspace or one Pane on its own. It is a
 * view state kept in the browser, so each device remembers its own.
 */
export type WorkspaceSelection =
  { readonly type: "view"; readonly id: string } | { readonly type: "pane"; readonly id: string };

const SELECTION_KEY = "naru-workspace-selection:";

export function readSelection(projectId: string): WorkspaceSelection | null {
  try {
    const value = JSON.parse(localStorage.getItem(SELECTION_KEY + projectId) ?? "null") as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "type" in value &&
      "id" in value &&
      (value.type === "view" || value.type === "pane") &&
      typeof value.id === "string"
    ) {
      return { type: value.type, id: value.id };
    }
  } catch {
    // Storage may be unavailable or hold an older value; the first workspace opens instead.
  }
  return null;
}

export function writeSelection(projectId: string, selection: WorkspaceSelection): void {
  try {
    localStorage.setItem(SELECTION_KEY + projectId, JSON.stringify(selection));
  } catch {
    // Remembering the open workspace is a convenience only.
  }
}

/** The stored selection if it still exists, otherwise the first workspace, then the first Pane. */
export function resolveSelection(
  workspace: Workspace,
  stored: WorkspaceSelection | null,
): WorkspaceSelection | null {
  const views = workspace.views ?? [];
  if (stored?.type === "view" && views.some((view) => view.id === stored.id)) return stored;
  if (stored?.type === "pane" && workspace.panes.some((pane) => pane.id === stored.id)) {
    return stored;
  }
  const first = views[0];
  if (first !== undefined) return { type: "view", id: first.id };
  const pane = workspace.panes[0];
  return pane === undefined ? null : { type: "pane", id: pane.id };
}
