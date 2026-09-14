import type {
  Pane,
  PaneActivity,
  ProjectActivity,
  ServerWsFrame,
  Workspace,
} from "@naru/contracts";

type CodexIdentityFrame = Extract<ServerWsFrame, { type: "codex.session.changed" }>;
type ActivityFrame = Extract<ServerWsFrame, { type: "activity.changed" }>;

/** Fences activity frames even when their Project is not the open Workspace. */
export class PaneActivityFrameFence {
  readonly #panes = new Map<string, PaneActivity>();
  readonly #projects = new Map<
    string,
    {
      activity: ProjectActivity;
      occurredAt: string;
      paneId: string;
      paneRevision: number;
      version: number;
    }
  >();
  #version = 0;

  get version(): number {
    return this.#version;
  }

  clear(): void {
    this.#panes.clear();
    this.#projects.clear();
    this.#version = 0;
  }

  accept(
    frame: ActivityFrame,
    currentPane: Pane | null,
  ): {
    pane: Pane | null;
    projectActivity: ProjectActivity | null;
  } | null {
    const cached = this.#panes.get(frame.paneId);
    const baseline =
      currentPane !== null &&
      (cached === undefined || currentPane.activity.revision > cached.revision)
        ? currentPane.activity
        : cached;
    if (cached !== undefined && frame.activity.revision <= cached.revision) return null;
    if (baseline !== undefined && frame.activity.revision < baseline.revision) return null;
    const alreadyInPane = baseline !== undefined && frame.activity.revision === baseline.revision;
    if (alreadyInPane && !sameActivity(baseline, frame.activity)) return null;
    const pane =
      currentPane === null || alreadyInPane ? null : applyPaneActivity(currentPane, frame.activity);
    if (currentPane !== null && !alreadyInPane && pane === null) return null;
    this.#panes.set(frame.paneId, frame.activity);
    this.#version += 1;
    const previous = this.#projects.get(frame.projectId);
    if (
      previous !== undefined &&
      previous.occurredAt > frame.activity.updatedAt &&
      !(previous.paneId === frame.paneId && frame.activity.revision > previous.paneRevision)
    ) {
      return { pane, projectActivity: null };
    }
    this.#projects.set(frame.projectId, {
      activity: frame.projectActivity,
      occurredAt: frame.activity.updatedAt,
      paneId: frame.paneId,
      paneRevision: frame.activity.revision,
      version: this.#version,
    });
    return { pane, projectActivity: frame.projectActivity };
  }

  projectUpdatesAfter(version: number): Array<{ projectId: string; activity: ProjectActivity }> {
    const updates: Array<{ projectId: string; activity: ProjectActivity }> = [];
    for (const [projectId, current] of this.#projects) {
      if (current.version > version) updates.push({ projectId, activity: current.activity });
    }
    return updates;
  }
}

function sameActivity(left: PaneActivity, right: PaneActivity): boolean {
  return (
    left.revision === right.revision &&
    left.eventId === right.eventId &&
    left.runtimeId === right.runtimeId &&
    left.state === right.state &&
    left.updatedAt === right.updatedAt
  );
}

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
