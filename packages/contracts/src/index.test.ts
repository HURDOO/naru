import { describe, expect, it } from "vitest";
import {
  AcknowledgePaneActivityRequestSchema,
  CLIPBOARD_IMAGE_CHUNK_BYTES,
  ClientWsFrameSchema,
  ConnectDiscoveredProjectTargetRequestSchema,
  CreatePaneRequestSchema,
  CreatePushSubscriptionRequestSchema,
  CreateWorkspaceViewPaneRequestSchema,
  CreateWorkspaceViewRequestSchema,
  DeletePaneRequestSchema,
  FileDraftSchema,
  PaneSchema,
  PaneViewStateSchema,
  RenamePaneRequestSchema,
  ProjectDirectoryListingSchema,
  ProjectFileContentSchema,
  ProjectGroupSchema,
  SaveFileDraftRequestSchema,
  SaveProjectFileRequestSchema,
  SaveWorkspaceRequestSchema,
  SaveWorkspaceViewRequestSchema,
  SessionResponseSchema,
  ServerWsFrameSchema,
  PushNotificationPayloadSchema,
  PushProjectSummarySchema,
  UpdatePushConfigurationRequestSchema,
  WorkspaceSchema,
  type ClientWsFrame,
  type ServerWsFrame,
} from "./index.js";

const paneId = "11111111-1111-4111-8111-111111111111";
const runtimeId = "22222222-2222-4222-8222-222222222222";
const clientId = "33333333-3333-4333-8333-333333333333";

describe("authentication session contracts", () => {
  it("keeps standalone CSRF state separate from a Gateway-managed session", () => {
    expect(
      SessionResponseSchema.parse({
        authenticated: true,
        authMode: "app-managed",
        csrfToken: "app-csrf",
        expiresAt: "2026-08-24T00:00:00.000Z",
        projectRoots: ["/srv/workstation/projects"],
      }),
    ).toMatchObject({
      authMode: "app-managed",
      csrfToken: "app-csrf",
      projectRoots: ["/srv/workstation/projects"],
    });
    expect(
      SessionResponseSchema.parse({
        authenticated: true,
        authMode: "gateway-managed",
        projectRoots: ["/srv/workstation/projects", "/Volumes/work/projects"],
      }),
    ).toEqual({
      authenticated: true,
      authMode: "gateway-managed",
      projectRoots: ["/srv/workstation/projects", "/Volumes/work/projects"],
    });
    expect(() =>
      SessionResponseSchema.parse({
        authenticated: true,
        authMode: "gateway-managed",
        projectRoots: ["/srv/workstation/projects"],
        csrfToken: "must-not-be-shared",
      }),
    ).toThrow();
    expect(() =>
      SessionResponseSchema.parse({
        authenticated: true,
        authMode: "gateway-managed",
        projectRoots: ["relative/project-root"],
      }),
    ).toThrow();
  });
});

describe("workspace mutation contracts", () => {
  it("validates versioned split, save, and close requests", () => {
    const pane = { type: "pane" as const, paneId, collapsed: false };

    expect(
      CreatePaneRequestSchema.parse({
        kind: "terminal",
        workspaceVersion: 4,
        targetPaneId: paneId,
        direction: "vertical",
      }),
    ).toMatchObject({ workspaceVersion: 4, direction: "vertical" });
    expect(
      SaveWorkspaceRequestSchema.parse({ version: 4, layout: pane, activePaneId: paneId }),
    ).toEqual({ version: 4, layout: pane, activePaneId: paneId });
    expect(DeletePaneRequestSchema.parse({ workspaceVersion: 4 })).toEqual({
      workspaceVersion: 4,
    });
    expect(AcknowledgePaneActivityRequestSchema.parse({ eventId: runtimeId })).toEqual({
      eventId: runtimeId,
    });
  });

  it("rejects malformed workspace versions, layout ratios, and split directions", () => {
    expect(() =>
      CreatePaneRequestSchema.parse({
        kind: "terminal",
        workspaceVersion: -1,
        targetPaneId: paneId,
        direction: "diagonal",
      }),
    ).toThrow();
    expect(() =>
      SaveWorkspaceRequestSchema.parse({
        version: 1,
        layout: {
          type: "split",
          id: clientId,
          direction: "horizontal",
          ratio: 0.99,
          first: { type: "pane", paneId, collapsed: false },
          second: { type: "pane", paneId: runtimeId, collapsed: false },
        },
        activePaneId: paneId,
      }),
    ).toThrow();
    expect(() => DeletePaneRequestSchema.parse({ workspaceVersion: 1.2 })).toThrow();
    expect(() => AcknowledgePaneActivityRequestSchema.parse({ eventId: "stale" })).toThrow();
    expect(() =>
      CreatePaneRequestSchema.parse({
        kind: "codex",
        launchProfile: "--dangerously-bypass-approvals-and-sandbox",
        workspaceVersion: 1,
        targetPaneId: paneId,
        direction: "horizontal",
      }),
    ).toThrow();
  });

  it("accepts bounded document Pane state without exposing launch profile overrides", () => {
    expect(
      CreatePaneRequestSchema.parse({
        kind: "docs",
        selectedDocumentPath: "docs/ARCHITECTURE.md",
        workspaceVersion: 4,
        targetPaneId: paneId,
        direction: "horizontal",
      }),
    ).toMatchObject({ kind: "docs", selectedDocumentPath: "docs/ARCHITECTURE.md" });
    expect(
      CreatePaneRequestSchema.parse({
        kind: "tasks",
        selectedDocumentPath: "TASKS.md",
        workspaceVersion: 4,
        targetPaneId: paneId,
        direction: "vertical",
      }),
    ).toMatchObject({ kind: "tasks", selectedDocumentPath: "TASKS.md" });
    expect(
      PaneViewStateSchema.parse({
        selectedDocumentPath: "docs/TASKS.md",
        navigationOpen: false,
      }),
    ).toEqual({
      selectedDocumentPath: "docs/TASKS.md",
      navigationOpen: false,
      expandedDirectories: [],
    });

    expect(() =>
      CreatePaneRequestSchema.parse({
        kind: "docs",
        launchProfile: "shell",
        workspaceVersion: 4,
        targetPaneId: paneId,
        direction: "horizontal",
      }),
    ).toThrow();
  });
});

describe("workspace view contracts (AP-D031)", () => {
  const slotId = "44444444-4444-4444-8444-444444444444";
  const splitId = "55555555-5555-4555-8555-555555555555";
  const layout = {
    type: "split" as const,
    id: splitId,
    direction: "horizontal" as const,
    ratio: 0.5,
    first: { type: "pane" as const, paneId },
    second: {
      type: "slot" as const,
      id: slotId,
      pane: { kind: "codex" as const, launchProfile: "codex-main" as const },
    },
  };

  it("accepts pane, slot and split nodes and bounded names", () => {
    expect(
      CreateWorkspaceViewRequestSchema.parse({ name: " 리뷰 보기 ", layout, activePaneId: paneId }),
    ).toEqual({ name: "리뷰 보기", layout, activePaneId: paneId });
    expect(
      SaveWorkspaceViewRequestSchema.parse({
        version: 3,
        name: "기본",
        layout: null,
        activePaneId: null,
      }),
    ).toEqual({ version: 3, name: "기본", layout: null, activePaneId: null });
    expect(
      CreateWorkspaceViewPaneRequestSchema.parse({
        kind: "codex",
        launchProfile: "codex-main",
        viewVersion: 2,
        placement: { type: "slot", slotId },
      }),
    ).toMatchObject({ kind: "codex", placement: { type: "slot", slotId } });
    expect(RenamePaneRequestSchema.parse({ customTitle: " 로그인 담당 " })).toEqual({
      customTitle: "로그인 담당",
    });
    expect(RenamePaneRequestSchema.parse({ customTitle: null })).toEqual({ customTitle: null });
  });

  it("rejects collapsed panes, unknown slot runtimes and empty names", () => {
    const save = (value: unknown) =>
      SaveWorkspaceViewRequestSchema.parse({
        version: 1,
        name: "기본",
        layout: value,
        activePaneId: null,
      });
    expect(() => save({ type: "pane", paneId, collapsed: true })).toThrow();
    expect(() =>
      save({ type: "slot", id: slotId, pane: { kind: "files", launchProfile: "files-editor" } }),
    ).toThrow();
    expect(() =>
      save({ type: "slot", id: slotId, pane: { kind: "codex", launchProfile: "--yolo" } }),
    ).toThrow();
    expect(() =>
      CreateWorkspaceViewRequestSchema.parse({ name: "   ", layout: null, activePaneId: null }),
    ).toThrow();
    expect(() =>
      CreateWorkspaceViewPaneRequestSchema.parse({
        kind: "terminal",
        viewVersion: 1,
        placement: { type: "split", targetPaneId: paneId, direction: "diagonal" },
      }),
    ).toThrow();
    expect(() => RenamePaneRequestSchema.parse({ customTitle: "" })).toThrow();
  });

  it("reads workspaces and Panes from servers without views or custom names", () => {
    const now = "2026-10-16T00:00:00.000Z";
    const pane = {
      id: paneId,
      projectId: runtimeId,
      kind: "terminal",
      title: "Terminal 1",
      launchProfile: "shell",
      status: "running",
      exitCode: null,
      codexSessionId: null,
      codexSessionResumable: false,
      lastErrorCode: null,
      lastExitedAt: null,
      activity: { state: "idle", eventId: null, runtimeId: null, revision: 0, updatedAt: now },
      viewState: { selectedDocumentPath: null, navigationOpen: true, expandedDirectories: [] },
      createdAt: now,
      updatedAt: now,
    };
    expect(PaneSchema.parse(pane).customTitle).toBeUndefined();
    const workspace = WorkspaceSchema.parse({
      projectId: runtimeId,
      schemaVersion: 2,
      version: 0,
      layout: { type: "pane", paneId, collapsed: false },
      activePaneId: paneId,
      panes: [pane],
      updatedAt: now,
    });
    expect(workspace.views).toBeUndefined();
  });
});

describe("project file contracts", () => {
  const revision = "a".repeat(64);

  it("accepts bounded file listing, content, save, and memory draft payloads", () => {
    expect(
      ProjectDirectoryListingSchema.parse({
        path: "src",
        entries: [
          {
            path: "src/app.ts",
            name: "app.ts",
            kind: "file",
            sizeBytes: 18,
            modifiedAt: "2026-08-21T00:00:00.000Z",
            sensitive: false,
            protected: false,
            excluded: false,
            symlinkStatus: null,
          },
        ],
      }),
    ).toMatchObject({ path: "src", entries: [{ path: "src/app.ts" }] });
    expect(
      ProjectFileContentSchema.parse({
        path: "src/app.ts",
        source: "const ready = true;\n",
        revision,
        sizeBytes: 20,
        modifiedAt: "2026-08-21T00:00:00.000Z",
        sensitive: false,
      }),
    ).toMatchObject({ path: "src/app.ts", revision });
    expect(
      SaveProjectFileRequestSchema.parse({
        path: "src/app.ts",
        source: "const ready = true;\n",
        expectedRevision: revision,
      }),
    ).toMatchObject({ expectedRevision: revision, allowSensitive: false });
    expect(
      SaveFileDraftRequestSchema.parse({
        path: "src/app.ts",
        baseRevision: revision,
        draftSource: "const ready = false;\n",
      }),
    ).toMatchObject({ baseRevision: revision, allowSensitive: false, assistantMerge: null });
    expect(
      FileDraftSchema.parse({
        paneId,
        projectId: runtimeId,
        path: "src/app.ts",
        baseRevision: revision,
        baseSource: "const ready = true;\n",
        draftSource: "const ready = false;\n",
        sensitive: false,
        assistantMerge: null,
        updatedAt: "2026-08-21T00:00:00.000Z",
      }),
    ).toMatchObject({ paneId, projectId: runtimeId, path: "src/app.ts", assistantMerge: null });

    expect(
      SaveFileDraftRequestSchema.parse({
        path: "src/app.ts",
        baseRevision: revision,
        draftSource: "const ready = false;\n",
        assistantMerge: {
          paneId,
          initialActivityEventId: clientId,
          currentRevision: "b".repeat(64),
        },
      }),
    ).toMatchObject({
      assistantMerge: {
        paneId,
        initialActivityEventId: clientId,
        currentRevision: "b".repeat(64),
      },
    });
  });

  it("rejects malformed revisions, oversized listings, and extra save fields", () => {
    expect(() =>
      SaveProjectFileRequestSchema.parse({
        path: "src/app.ts",
        source: "",
        expectedRevision: "stale",
      }),
    ).toThrow();
    expect(() =>
      ProjectDirectoryListingSchema.parse({
        path: "",
        entries: Array.from({ length: 513 }, () => ({
          path: "src/app.ts",
          name: "app.ts",
          kind: "file",
          sizeBytes: 0,
          modifiedAt: null,
          sensitive: false,
          protected: false,
          excluded: false,
          symlinkStatus: null,
        })),
      }),
    ).toThrow();
    expect(() =>
      SaveFileDraftRequestSchema.parse({
        path: "src/app.ts",
        baseRevision: null,
        draftSource: "",
        persisted: true,
      }),
    ).toThrow();
  });
});

describe("project group contracts", () => {
  it("keeps connected targets distinct from discovered worktrees", () => {
    const activity = {
      state: "idle" as const,
      interactionRequiredCount: 0,
      updatedAt: null,
    };
    const timestamp = "2026-08-20T00:00:00.000Z";
    const group = {
      id: clientId,
      name: "editor",
      kind: "git" as const,
      activity,
      targets: [
        {
          registration: "connected" as const,
          projectId: paneId,
          label: "main",
          path: "/Users/example/coding/editor",
          availability: "ready" as const,
          git: {
            kind: "worktree" as const,
            role: "primary" as const,
            head: { kind: "branch" as const, name: "main", oid: "a".repeat(40) },
            locked: false,
            prunable: false,
          },
          activity,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          registration: "discovered" as const,
          label: "feature/sidebar",
          path: "/Users/example/coding/editor-sidebar",
          availability: "ready" as const,
          git: {
            kind: "worktree" as const,
            role: "linked" as const,
            head: {
              kind: "detached" as const,
              oid: "b".repeat(40),
            },
            locked: false,
            prunable: false,
          },
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(ProjectGroupSchema.parse(group)).toEqual(group);
    expect(
      ConnectDiscoveredProjectTargetRequestSchema.parse({
        path: "/Users/example/coding/editor-sidebar",
      }),
    ).toEqual({ path: "/Users/example/coding/editor-sidebar" });
    expect(() =>
      ConnectDiscoveredProjectTargetRequestSchema.parse({
        path: "/Users/example/coding/editor-sidebar",
        projectId: runtimeId,
      }),
    ).toThrow();
    expect(() =>
      ProjectGroupSchema.parse({
        ...group,
        targets: [
          {
            ...group.targets[1],
            projectId: runtimeId,
            activity,
          },
        ],
      }),
    ).toThrow();
  });

  it("does not confuse primary worktree role with a branch named main", () => {
    const timestamp = "2026-08-20T00:00:00.000Z";
    const activity = {
      state: "idle" as const,
      interactionRequiredCount: 0,
      updatedAt: null,
    };
    const base = {
      id: clientId,
      name: "editor",
      kind: "git" as const,
      activity,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(
      ProjectGroupSchema.parse({
        ...base,
        targets: [
          {
            registration: "connected",
            projectId: paneId,
            label: "release",
            path: "/Users/example/coding/editor",
            availability: "ready",
            git: {
              kind: "worktree",
              role: "primary",
              head: { kind: "branch", name: "release", oid: "c".repeat(64) },
              locked: false,
              prunable: false,
            },
            activity,
            createdAt: timestamp,
            updatedAt: timestamp,
          },
        ],
      }).targets[0]?.git,
    ).toMatchObject({ role: "primary", head: { name: "release" } });
  });

  it("allows one connected non-Git target in a standalone group", () => {
    const timestamp = "2026-08-20T00:00:00.000Z";
    const activity = {
      state: "idle" as const,
      interactionRequiredCount: 0,
      updatedAt: null,
    };
    const standalone = {
      id: clientId,
      name: "notes",
      kind: "standalone" as const,
      activity,
      targets: [
        {
          registration: "connected" as const,
          projectId: paneId,
          label: "notes",
          path: "/Users/example/coding/notes",
          availability: "ready" as const,
          git: null,
          activity,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    expect(ProjectGroupSchema.parse(standalone)).toEqual(standalone);
    expect(() =>
      ProjectGroupSchema.parse({
        ...standalone,
        targets: [
          ...standalone.targets,
          {
            registration: "discovered",
            label: "unexpected",
            path: "/Users/example/coding/unexpected",
            availability: "ready",
            git: {
              kind: "worktree",
              role: "linked",
              head: { kind: "detached", oid: "d".repeat(40) },
              locked: false,
              prunable: false,
            },
          },
        ],
      }),
    ).toThrow();
  });
});

describe("Web Push contracts", () => {
  it("accepts only an HTTPS subscription and the minimal notification payload", () => {
    expect(
      CreatePushSubscriptionRequestSchema.parse({
        name: "Windows PWA",
        endpoint: "https://push.example.test/device",
        expirationTime: null,
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
      }),
    ).toMatchObject({ name: "Windows PWA" });
    expect(() =>
      CreatePushSubscriptionRequestSchema.parse({
        name: "unsafe",
        endpoint: "http://push.example.test/device",
        expirationTime: null,
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
      }),
    ).toThrow();
    expect(() =>
      CreatePushSubscriptionRequestSchema.parse({
        name: "unsafe",
        endpoint: ["https://user", "password@push.example.test/device#secret"].join(":"),
        expirationTime: null,
        keys: { p256dh: "a".repeat(87), auth: "b".repeat(22) },
      }),
    ).toThrow();

    const payload = {
      version: 1,
      eventId: clientId,
      projectId: runtimeId,
      paneId,
      runtimeId: "44444444-4444-4444-8444-444444444444",
      eventKind: "failed",
    };
    expect(PushNotificationPayloadSchema.parse(payload)).toEqual(payload);
    expect(() => PushNotificationPayloadSchema.parse({ ...payload, command: "secret" })).toThrow();
    expect(() =>
      PushNotificationPayloadSchema.parse({ ...payload, eventKind: "running" }),
    ).toThrow();

    const summary = {
      projectId: runtimeId,
      projectName: "editor",
      state: "interaction-required",
      counts: { interactionRequired: 2, failed: 1, completed: 3 },
      suppressNotification: false,
    };
    expect(PushProjectSummarySchema.parse(summary)).toEqual(summary);
    expect(PushProjectSummarySchema.parse({ ...summary, state: "canceled" }).state).toBe(
      "canceled",
    );
    expect(PushProjectSummarySchema.parse({ ...summary, state: "server-stopped" }).state).toBe(
      "server-stopped",
    );
    expect(() =>
      PushProjectSummarySchema.parse({ ...summary, terminalOutput: "secret" }),
    ).toThrow();

    expect(UpdatePushConfigurationRequestSchema.parse({ inactivityDelayMinutes: 2 })).toEqual({
      inactivityDelayMinutes: 2,
    });
    expect(() =>
      UpdatePushConfigurationRequestSchema.parse({ inactivityDelayMinutes: 0 }),
    ).toThrow();
    expect(() =>
      UpdatePushConfigurationRequestSchema.parse({ inactivityDelayMinutes: 61 }),
    ).toThrow();
  });
});

describe("WebSocket contracts", () => {
  it("runtime-validates every client frame variant", () => {
    const frames: ClientWsFrame[] = [
      { type: "lease.acquire", clientId },
      { type: "surface.acquire", leaseGeneration: 1 },
      { type: "surface.takeover", leaseGeneration: 1, target: null },
      {
        type: "pane.control.preempt",
        paneId,
        leaseGeneration: 1,
        cols: 120,
        rows: 40,
      },
      {
        type: "pane.control.approve",
        paneId,
        controlRequestId: runtimeId,
        leaseGeneration: 1,
      },
      {
        type: "pane.control.reject",
        paneId,
        controlRequestId: runtimeId,
        leaseGeneration: 1,
      },
      { type: "pane.control.release", paneId, leaseGeneration: 1 },
      {
        type: "pane.attach",
        paneId,
        leaseGeneration: 1,
        cols: 120,
        rows: 40,
        restoreProtocol: "staged-v1",
        restoreId: runtimeId,
      },
      { type: "pane.detach", paneId, leaseGeneration: 1 },
      { type: "terminal.input", paneId, leaseGeneration: 1, data: "pwd\r" },
      { type: "terminal.resize", paneId, leaseGeneration: 1, cols: 80, rows: 24 },
      {
        type: "terminal.viewport",
        paneId,
        runtimeId,
        leaseGeneration: 1,
        bottomOffset: 25,
      },
      {
        type: "clipboard.image.begin",
        requestId: runtimeId,
        paneId,
        leaseGeneration: 1,
        byteLength: 3,
      },
      {
        type: "clipboard.image.chunk",
        requestId: runtimeId,
        paneId,
        leaseGeneration: 1,
        offset: 0,
        data: "YWJj",
      },
      {
        type: "clipboard.image.commit",
        requestId: runtimeId,
        paneId,
        leaseGeneration: 1,
      },
      {
        type: "heartbeat",
        leaseGeneration: 1,
        sentAt: 123,
        presence: { visible: true, focused: true, interactionRevision: 4 },
      },
    ];

    for (const frame of frames) {
      expect(ClientWsFrameSchema.parse(frame)).toEqual(frame);
    }
  });

  it("rejects malformed, oversized and unknown client frames", () => {
    expect(() => ClientWsFrameSchema.parse({ type: "unknown" })).toThrow();
    expect(() =>
      ClientWsFrameSchema.parse({ type: "lease.acquire", clientId, unexpected: true }),
    ).toThrow();
    expect(() =>
      ClientWsFrameSchema.parse({
        type: "pane.attach",
        paneId,
        leaseGeneration: 0,
        cols: 1,
        rows: 201,
      }),
    ).toThrow();
    expect(() =>
      ClientWsFrameSchema.parse({
        type: "heartbeat",
        leaseGeneration: 1,
        sentAt: 123,
        presence: { visible: true, focused: true, interactionRevision: -1 },
      }),
    ).toThrow();
    expect(() =>
      ClientWsFrameSchema.parse({
        type: "clipboard.image.chunk",
        requestId: runtimeId,
        paneId,
        leaseGeneration: 1,
        offset: 0,
        data: "x".repeat(Math.ceil(CLIPBOARD_IMAGE_CHUNK_BYTES / 3) * 4 + 1),
      }),
    ).toThrow();
    expect(() =>
      ClientWsFrameSchema.parse({
        type: "terminal.input",
        paneId,
        leaseGeneration: 1,
        data: "x".repeat(65_537),
      }),
    ).toThrow();
  });

  it("runtime-validates every server event variant", () => {
    const frames: ServerWsFrame[] = [
      {
        type: "lease.granted",
        generation: 1,
        replacedClient: false,
        acquisition: "initial",
      },
      { type: "lease.revoked", reason: "replaced" },
      {
        type: "surface.state",
        connectionId: clientId,
        generation: 1,
        role: "controller",
        controllerPresent: true,
        reason: "initial",
      },
      {
        type: "pane.control.state",
        paneId,
        role: "controller",
        controllerGeneration: 1,
        terminal: { cols: 120, rows: 40 },
        reason: "attached",
      },
      {
        type: "pane.control.requested",
        paneId,
        controlRequestId: clientId,
        controllerGeneration: 1,
        expiresAtMs: 123,
      },
      {
        type: "pane.control.request-resolved",
        paneId,
        controlRequestId: clientId,
        controllerGeneration: 1,
        resolution: "approved",
      },
      {
        type: "pane.snapshot",
        paneId,
        sequence: 0,
        serializedState: "snapshot",
        runtimeId,
        cols: 120,
        rows: 40,
      },
      {
        type: "pane.restore.preview",
        paneId,
        sequence: 2,
        serializedState: "preview",
        runtimeId,
        restoreId: clientId,
        bottomOffset: 40,
        previewBottomOffset: 24,
        cols: 80,
        rows: 24,
      },
      {
        type: "pane.restore.full",
        paneId,
        sequence: 2,
        serializedState: "full snapshot",
        runtimeId,
        restoreId: clientId,
        bottomOffset: 40,
        cols: 80,
        rows: 24,
      },
      { type: "terminal.output", paneId, sequence: 1, data: "output" },
      {
        type: "terminal.exit",
        paneId,
        exitCode: 130,
        signal: 2,
        codexSessionId: clientId,
        codexSessionResumable: true,
      },
      {
        type: "codex.session.changed",
        paneId,
        runtimeId,
        updatedAt: "2026-08-20T00:00:00.000Z",
        session: { id: clientId, resumable: true },
      },
      {
        type: "activity.changed",
        eventId: runtimeId,
        projectId: clientId,
        paneId,
        activity: {
          state: "interaction-required",
          eventId: runtimeId,
          runtimeId,
          revision: 3,
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
        projectActivity: {
          state: "interaction-required",
          interactionRequiredCount: 2,
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
      },
      { type: "heartbeat.ack", sentAt: 123 },
      {
        type: "clipboard.image.result",
        requestId: runtimeId,
        paneId,
        status: "attached",
      },
      {
        type: "protocol.error",
        code: "REQUEST_INVALID",
        message: "invalid frame",
        requestId: "request-1",
      },
    ];

    for (const frame of frames) {
      expect(ServerWsFrameSchema.parse(frame)).toEqual(frame);
    }
  });

  it("rejects malformed and unknown server events", () => {
    expect(() => ServerWsFrameSchema.parse({ type: "unknown" })).toThrow();
    expect(() =>
      ServerWsFrameSchema.parse({
        type: "terminal.output",
        paneId,
        sequence: 0,
        data: "output",
      }),
    ).toThrow();
    expect(() =>
      ServerWsFrameSchema.parse({ type: "lease.revoked", reason: "unexpected" }),
    ).toThrow();
    expect(() =>
      ServerWsFrameSchema.parse({
        type: "terminal.exit",
        paneId,
        exitCode: 0,
        codexSessionId: "not-a-session-id",
      }),
    ).toThrow();
    expect(() =>
      ServerWsFrameSchema.parse({
        type: "codex.session.changed",
        paneId,
        runtimeId,
        updatedAt: "2026-08-20T00:00:00.000Z",
        session: { id: null, resumable: true },
      }),
    ).toThrow();
    expect(() =>
      ServerWsFrameSchema.parse({
        type: "lease.granted",
        generation: 1,
        replacedClient: false,
        acquisition: "same-device-ish",
      }),
    ).toThrow();
    expect(() =>
      ServerWsFrameSchema.parse({
        type: "protocol.error",
        code: "NOT_A_REAL_CODE",
        message: "invalid",
      }),
    ).toThrow();
  });
});
