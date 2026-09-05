import type { Pane, PaneActivity, ServerWsFrame, Workspace } from "@naru/contracts";

type CodexIdentityFrame = Extract<ServerWsFrame, { type: "codex.session.changed" }>;

export function applyPaneActivity(pane: Pane, activity: PaneActivity): Pane | null {
  if (activity.revision < pane.activity.revision) return null;
  if (
    activity.revision === pane.activity.revision &&
    (activity.eventId !== pane.activity.eventId ||
      activity.runtimeId !== pane.activity.runtimeId ||
      activity.state !== pane.activity.state ||
      activity.updatedAt !== pane.activity.updatedAt)
  ) {
    return null;
  }
  if (activity === pane.activity) return pane;
  return { ...pane, activity };
}

export function applyCodexIdentity(pane: Pane, frame: CodexIdentityFrame): Pane | null {
  if (
    pane.kind !== "codex" ||
    pane.id !== frame.paneId ||
    pane.activity.runtimeId !== frame.runtimeId
  ) {
    return null;
  }
  if (
    pane.codexSessionId === frame.session.id &&
    pane.codexSessionResumable === frame.session.resumable
  ) {
    return pane;
  }
  return {
    ...pane,
    codexSessionId: frame.session.id,
    codexSessionResumable: frame.session.resumable,
    updatedAt: frame.updatedAt > pane.updatedAt ? frame.updatedAt : pane.updatedAt,
  };
}

export function mergePaneRuntimeSnapshot(current: Pane, incoming: Pane): Pane {
  if (incoming.activity.revision > current.activity.revision) return incoming;
  if (
    incoming.activity.revision === current.activity.revision &&
    incoming.activity.eventId === current.activity.eventId &&
    incoming.activity.runtimeId === current.activity.runtimeId &&
    incoming.activity.state === current.activity.state &&
    incoming.activity.updatedAt === current.activity.updatedAt
  ) {
    if (incoming.updatedAt >= current.updatedAt) return incoming;
  }
  return {
    ...incoming,
    status: current.status,
    exitCode: current.exitCode,
    codexSessionId: current.codexSessionId,
    codexSessionResumable: current.codexSessionResumable,
    lastErrorCode: current.lastErrorCode,
    lastExitedAt: current.lastExitedAt,
    activity: current.activity,
    updatedAt: current.updatedAt > incoming.updatedAt ? current.updatedAt : incoming.updatedAt,
  };
}

export function mergeWorkspaceRuntimeSnapshot(
  current: Workspace | null,
  incoming: Workspace,
): Workspace {
  if (current?.projectId !== incoming.projectId) return incoming;
  const currentPanes = new Map(current.panes.map((pane) => [pane.id, pane]));
  return {
    ...incoming,
    panes: incoming.panes.map((pane) => {
      const currentPane = currentPanes.get(pane.id);
      return currentPane ? mergePaneRuntimeSnapshot(currentPane, pane) : pane;
    }),
  };
}
