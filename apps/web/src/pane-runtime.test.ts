import { describe, expect, it } from "vitest";
import type { Pane, PaneActivity, PaneActivityState, PaneStatus, Workspace } from "@naru/contracts";
import {
  applyCodexIdentity,
  applyPaneActivity,
  mergePaneRuntimeSnapshot,
  mergeWorkspaceRuntimeSnapshot,
} from "./pane-runtime";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const PANE_ID = "22222222-2222-4222-8222-222222222222";
const OLD_RUNTIME_ID = "33333333-3333-4333-8333-333333333333";
const CURRENT_RUNTIME_ID = "44444444-4444-4444-8444-444444444444";

describe("Pane runtime snapshot ordering", () => {
  it("applies Codex identity only to the current runtime and supports fail-closed clearing", () => {
    const pane = paneAt(5, "running", CURRENT_RUNTIME_ID, "running");
    const identified = applyCodexIdentity(pane, {
      type: "codex.session.changed",
      paneId: PANE_ID,
      runtimeId: CURRENT_RUNTIME_ID,
      updatedAt: "2026-08-21T00:01:00.000Z",
      session: { id: "55555555-5555-4555-8555-555555555555", resumable: true },
    });

    expect(identified).toMatchObject({
      codexSessionId: "55555555-5555-4555-8555-555555555555",
      codexSessionResumable: true,
    });
    expect(
      applyCodexIdentity(identified as Pane, {
        type: "codex.session.changed",
        paneId: PANE_ID,
        runtimeId: OLD_RUNTIME_ID,
        updatedAt: "2026-08-21T00:02:00.000Z",
        session: { id: "66666666-6666-4666-8666-666666666666", resumable: true },
      }),
    ).toBeNull();
    expect(
      applyCodexIdentity(identified as Pane, {
        type: "codex.session.changed",
        paneId: PANE_ID,
        runtimeId: CURRENT_RUNTIME_ID,
        updatedAt: "2026-08-21T00:03:00.000Z",
        session: { id: null, resumable: false },
      }),
    ).toMatchObject({ codexSessionId: null, codexSessionResumable: false });
  });

  it("rejects late activity frames from an older revision or a conflicting equal revision", () => {
    const pane = paneAt(5, "running", CURRENT_RUNTIME_ID, "running");
    const stale = activityAt(4, "failed", OLD_RUNTIME_ID);
    const conflicting = activityAt(5, "failed", OLD_RUNTIME_ID);

    expect(applyPaneActivity(pane, stale)).toBeNull();
    expect(applyPaneActivity(pane, conflicting)).toBeNull();
    expect(applyPaneActivity(pane, pane.activity)).toBe(pane);
    expect(
      mergePaneRuntimeSnapshot(pane, {
        ...paneAt(5, "failed", OLD_RUNTIME_ID, "error"),
        updatedAt: "2026-08-21T00:01:00.000Z",
      }),
    ).toMatchObject({ status: "running", activity: pane.activity });
  });

  it("accepts a newer activity frame for both progress and a real current-runtime failure", () => {
    const pane = paneAt(5, "idle", CURRENT_RUNTIME_ID, "running");
    const running = activityAt(6, "running", CURRENT_RUNTIME_ID);
    const failed = activityAt(7, "failed", CURRENT_RUNTIME_ID);

    const withRunning = applyPaneActivity(pane, running);
    expect(withRunning?.activity).toEqual(running);
    expect(applyPaneActivity(withRunning as Pane, failed)?.activity).toEqual(failed);
  });

  it("keeps newer runtime metadata when a cached workspace resolves late", () => {
    const currentPane = paneAt(8, "running", CURRENT_RUNTIME_ID, "running");
    const cachedPane = {
      ...paneAt(3, "failed", OLD_RUNTIME_ID, "error"),
      viewState: {
        selectedDocumentPath: "docs/TASKS.md",
        navigationOpen: false,
        expandedDirectories: ["docs"],
      },
    };
    const mergedPane = mergePaneRuntimeSnapshot(currentPane, cachedPane);

    expect(mergedPane).toMatchObject({
      status: "running",
      exitCode: null,
      lastErrorCode: null,
      activity: currentPane.activity,
      viewState: cachedPane.viewState,
    });

    const mergedWorkspace = mergeWorkspaceRuntimeSnapshot(
      workspaceWith(currentPane, 3),
      workspaceWith(cachedPane, 4),
    );
    expect(mergedWorkspace.version).toBe(4);
    expect(mergedWorkspace.panes[0]).toMatchObject({
      status: "running",
      activity: currentPane.activity,
      viewState: cachedPane.viewState,
    });
  });

  it("does not let an equal-activity cached snapshot restore a cleared Codex identity", () => {
    const currentPane = {
      ...paneAt(8, "running", CURRENT_RUNTIME_ID, "running"),
      codexSessionId: null,
      codexSessionResumable: false,
      updatedAt: "2026-08-21T00:02:00.000Z",
    };
    const cachedPane = {
      ...paneAt(8, "running", CURRENT_RUNTIME_ID, "running"),
      codexSessionId: "77777777-7777-4777-8777-777777777777",
      codexSessionResumable: true,
      updatedAt: "2026-08-21T00:01:00.000Z",
      viewState: {
        selectedDocumentPath: "docs/SPEC.md",
        navigationOpen: false,
        expandedDirectories: ["docs"],
      },
    };

    expect(mergePaneRuntimeSnapshot(currentPane, cachedPane)).toMatchObject({
      codexSessionId: null,
      codexSessionResumable: false,
      updatedAt: currentPane.updatedAt,
      viewState: cachedPane.viewState,
    });
  });

  it("accepts a newer workspace failure instead of masking it", () => {
    const currentPane = paneAt(8, "running", CURRENT_RUNTIME_ID, "running");
    const actualFailure = paneAt(9, "failed", CURRENT_RUNTIME_ID, "error");

    expect(mergePaneRuntimeSnapshot(currentPane, actualFailure)).toBe(actualFailure);
    expect(
      mergeWorkspaceRuntimeSnapshot(workspaceWith(currentPane, 3), workspaceWith(actualFailure, 4))
        .panes[0],
    ).toBe(actualFailure);
  });
});

function activityAt(
  revision: number,
  state: PaneActivityState,
  runtimeId: string | null,
): PaneActivity {
  return {
    state,
    eventId: `00000000-0000-4000-8000-${String(revision).padStart(12, "0")}`,
    runtimeId,
    revision,
    updatedAt: `2026-08-21T00:00:${String(revision).padStart(2, "0")}.000Z`,
  };
}

function paneAt(
  revision: number,
  state: PaneActivityState,
  runtimeId: string | null,
  status: PaneStatus,
): Pane {
  return {
    id: PANE_ID,
    projectId: PROJECT_ID,
    kind: "codex",
    title: "Main Codex",
    launchProfile: "codex-main",
    status,
    exitCode: status === "error" ? 1 : null,
    codexSessionId: null,
    codexSessionResumable: false,
    lastErrorCode: status === "error" ? "PTY_SPAWN_FAILED" : null,
    lastExitedAt: null,
    activity: activityAt(revision, state, runtimeId),
    viewState: { selectedDocumentPath: null, navigationOpen: true, expandedDirectories: [] },
    createdAt: "2026-08-21T00:00:00.000Z",
    updatedAt: `2026-08-21T00:00:${String(revision).padStart(2, "0")}.000Z`,
  };
}

function workspaceWith(pane: Pane, version: number): Workspace {
  return {
    projectId: PROJECT_ID,
    schemaVersion: 2,
    version,
    layout: { type: "pane", paneId: PANE_ID, collapsed: false },
    activePaneId: PANE_ID,
    panes: [pane],
    updatedAt: "2026-08-21T00:01:00.000Z",
  };
}
