import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { LAYOUT_SCHEMA_VERSION } from "@naru/contracts";
import type { SessionView } from "@naru/contracts/durable-session/v0";
import { resizeSplit } from "@naru/domain";
import {
  DATABASE_MIGRATIONS,
  NaruRepository,
  runDatabaseMigrations,
  type DatabaseMigration,
} from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("NaruRepository", () => {
  it("reports whether the migrated database can answer readiness probes", () => {
    const repository = new NaruRepository(temporaryDatabase());
    expect(repository.isReady()).toBe(true);
    repository.close();
    expect(repository.isReady()).toBe(false);
  });

  it("persists a stable WebAuthn user handle and passkey credential metadata", () => {
    const filename = temporaryDatabase();
    const repository = new NaruRepository(filename);
    const userId = repository.getOrCreatePasskeyUserId();
    expect(userId).toHaveLength(32);
    expect(repository.getOrCreatePasskeyUserId()).toEqual(userId);

    const created = repository.createPasskey({
      name: "Galaxy",
      credentialId: "credential-one",
      publicKey: Uint8Array.from([1, 2, 3]),
      counter: 4,
      transports: ["internal", "hybrid"],
      deviceType: "multiDevice",
      backedUp: true,
    });
    expect(repository.listPasskeys()).toEqual([created]);
    expect(repository.getPasskeyByCredentialId("credential-one")).toMatchObject({
      ...created,
      credentialId: "credential-one",
      publicKey: Uint8Array.from([1, 2, 3]),
      counter: 4,
      transports: ["internal", "hybrid"],
    });
    expect(() =>
      repository.createPasskey({
        name: "Duplicate",
        credentialId: "credential-one",
        publicKey: Uint8Array.from([4]),
        counter: 0,
        transports: [],
        deviceType: "singleDevice",
        backedUp: false,
      }),
    ).toThrowError(expect.objectContaining({ code: "PASSKEY_DUPLICATE", statusCode: 409 }));

    const renamed = repository.updatePasskeyName(created.id, "Phone");
    expect(renamed.name).toBe("Phone");
    expect(repository.updatePasskeyAfterAuthentication(created.id, 5, "multiDevice", true)).toBe(
      true,
    );
    expect(repository.updatePasskeyAfterAuthentication(created.id, 4, "multiDevice", true)).toBe(
      true,
    );
    const authenticated = repository.getPasskeyByCredentialId("credential-one");
    expect(authenticated).toMatchObject({
      name: "Phone",
      counter: 5,
    });
    expect(typeof authenticated?.lastUsedAt).toBe("string");
    expect(authenticated?.counter).toBe(5);
    expect(repository.deletePasskey(created.id)).toBe(true);
    expect(repository.updatePasskeyAfterAuthentication(created.id, 6, "multiDevice", true)).toBe(
      false,
    );
    expect(repository.deletePasskey(created.id)).toBe(false);
    repository.close();

    const reopened = new NaruRepository(filename);
    try {
      expect(reopened.getOrCreatePasskeyUserId()).toEqual(userId);
      expect(reopened.listPasskeys()).toEqual([]);
    } finally {
      reopened.close();
    }
  });

  it("stores bounded push subscriptions without exposing endpoints and deduplicates deliveries", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const created = repository.upsertPushSubscription(pushInput(1));
      expect(created).toMatchObject({
        name: "Device 1",
        expirationTime: null,
      });
      expect(created.endpointFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(created).not.toHaveProperty("endpoint");
      expect(created).not.toHaveProperty("p256dh");

      const updated = repository.upsertPushSubscription({
        ...pushInput(1),
        name: "Current PWA",
      });
      expect(updated).toMatchObject({ id: created.id, name: "Current PWA" });
      expect(repository.updatePushSubscriptionName(created.id, "Windows PWA").name).toBe(
        "Windows PWA",
      );

      const deliveryRecord = repository.listActivePushSubscriptionRecords()[0];
      expect(deliveryRecord).toMatchObject({
        id: created.id,
        endpoint: "https://push.example.test/device-1",
      });
      expect(typeof deliveryRecord?.p256dh).toBe("string");
      expect(typeof deliveryRecord?.auth).toBe("string");
      const payload = {
        version: 1 as const,
        eventId: randomUUID(),
        projectId: randomUUID(),
        paneId: randomUUID(),
        runtimeId: randomUUID(),
        eventKind: "completed" as const,
      };
      expect(repository.reservePushDelivery(created.id, payload)).toBe(true);
      expect(repository.reservePushDelivery(created.id, payload)).toBe(false);
      repository.markPushDeliverySent(created.id, payload.eventId);

      for (let index = 2; index <= 10; index += 1) {
        repository.upsertPushSubscription(pushInput(index));
      }
      expect(repository.listPushSubscriptions()).toHaveLength(10);
      expect(() => repository.upsertPushSubscription(pushInput(11))).toThrowError(
        expect.objectContaining({ code: "PUSH_SUBSCRIPTION_LIMIT", statusCode: 409 }),
      );
      expect(repository.deletePushSubscription(created.id)).toBe(true);
      expect(repository.deletePushSubscription(created.id)).toBe(false);

      repository.upsertPushSubscription(pushInput(12, Date.now() - 1));
      expect(repository.listPushSubscriptions().some(({ name }) => name === "Device 12")).toBe(
        false,
      );
    } finally {
      repository.close();
    }
  });

  it("persists the global push inactivity delay", () => {
    const filename = temporaryDatabase();
    const repository = new NaruRepository(filename);
    expect(repository.getPushInactivityDelayMinutes()).toBe(2);
    expect(repository.updatePushInactivityDelayMinutes(5)).toBe(5);
    repository.close();

    const reopened = new NaruRepository(filename);
    try {
      expect(reopened.getPushInactivityDelayMinutes()).toBe(5);
    } finally {
      reopened.close();
    }
  });

  it("creates the approved three-Pane Workspace and mutates its tree transactionally", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const project = repository.createProject("/tmp/naru-project", "naru-project");
      const initial = repository.getWorkspace(project.id);

      expect(repository.listProjects()).toEqual([project]);
      expect(initial.schemaVersion).toBe(LAYOUT_SCHEMA_VERSION);
      expect(initial.version).toBe(0);
      expect(
        initial.panes.map(({ title, kind, launchProfile }) => ({ title, kind, launchProfile })),
      ).toEqual([
        { title: "Main Codex", kind: "codex", launchProfile: "codex-main" },
        { title: "Quick Codex", kind: "codex", launchProfile: "codex-quick" },
        { title: "Dev Terminal", kind: "terminal", launchProfile: "shell" },
      ]);
      expect(initial.layout).toMatchObject({
        type: "split",
        direction: "vertical",
        ratio: 0.64,
        first: { type: "split", direction: "horizontal", ratio: 0.5 },
      });
      expect(initial.activePaneId).toBe(initial.panes[0]?.id);
      expect(initial.panes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            codexSessionId: null,
            codexSessionResumable: false,
            lastErrorCode: null,
            lastExitedAt: null,
            viewState: {
              selectedDocumentPath: null,
              navigationOpen: true,
              expandedDirectories: [],
            },
          }),
        ]),
      );

      const created = repository.createPane(project.id, {
        kind: "terminal",
        workspaceVersion: initial.version,
        targetPaneId: initial.panes[2]?.id ?? null,
        direction: "vertical",
      });
      const withCreated = repository.getWorkspace(project.id);
      expect(withCreated).toMatchObject({ version: 1, activePaneId: created.id });
      expect(withCreated.panes).toHaveLength(4);

      const rootSplitId = withCreated.layout?.type === "split" ? withCreated.layout.id : "";
      const saved = repository.saveWorkspace(project.id, {
        version: withCreated.version,
        layout:
          withCreated.layout === null ? null : resizeSplit(withCreated.layout, rootSplitId, 0.7),
        activePaneId: initial.panes[1]?.id ?? null,
      });
      expect(saved).toMatchObject({ version: 2, activePaneId: initial.panes[1]?.id });
      expect(saved.layout).toMatchObject({ ratio: 0.7 });

      const deleted = repository.deletePane(created.id, saved.version);
      expect(deleted).toMatchObject({ version: 3 });
      expect(deleted?.panes).toHaveLength(3);
      expect(deleted?.panes.some((pane) => pane.id === created.id)).toBe(false);
    } finally {
      repository.close();
    }
  });

  it("opts new projects into two Claude Code Panes without rewriting existing Codex workspaces", () => {
    const filename = temporaryDatabase();
    const original = new NaruRepository(filename);
    const existing = original.createProject("/tmp/existing-codex-project", "existing");
    original.close();

    const repository = new NaruRepository(filename, { defaultAgentPaneKind: "claude" });
    try {
      expect(repository.getWorkspace(existing.id).panes.map((pane) => pane.kind)).toEqual([
        "codex",
        "codex",
        "terminal",
      ]);
      const project = repository.createProject("/tmp/new-claude-project", "new");
      const workspace = repository.getWorkspace(project.id);
      expect(
        workspace.panes.map(({ title, kind, launchProfile }) => ({ title, kind, launchProfile })),
      ).toEqual([
        { title: "Claude Code 1", kind: "claude", launchProfile: "claude-code" },
        { title: "Claude Code 2", kind: "claude", launchProfile: "claude-code" },
        { title: "Dev Terminal", kind: "terminal", launchProfile: "shell" },
      ]);
      expect(workspace.activePaneId).toBe(workspace.panes[0]?.id);
    } finally {
      repository.close();
    }
  });

  it("groups concrete Project targets without changing their Workspace identity", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const primary = repository.createProject("/tmp/repository", "repository");
      const linked = repository.createProject("/tmp/repository-feature", "repository-feature");
      const primaryWorkspace = repository.getWorkspace(primary.id);
      const linkedWorkspace = repository.getWorkspace(linked.id);

      expect(repository.listStoredProjectGroups()).toHaveLength(2);
      const group = repository.assignProjectToGitGroup(primary.id, "/tmp/repository/.git", "");
      expect(group).toMatchObject({ name: "repository", kind: "git" });
      expect(repository.assignProjectToGitGroup(linked.id, "/tmp/repository/.git", "").id).toBe(
        group.id,
      );
      expect(repository.listStoredProjectGroups()).toEqual([
        expect.objectContaining({
          id: group.id,
          name: "repository",
          kind: "git",
          gitCommonDirectory: "/tmp/repository/.git",
          gitRelativePath: "",
        }),
      ]);
      expect(
        repository.listStoredProjectTargets().map(({ id, groupId }) => ({ id, groupId })),
      ).toEqual(
        expect.arrayContaining([
          { id: primary.id, groupId: group.id },
          { id: linked.id, groupId: group.id },
        ]),
      );
      expect(repository.getWorkspace(primary.id)).toEqual(primaryWorkspace);
      expect(repository.getWorkspace(linked.id)).toEqual(linkedWorkspace);

      const standalone = repository.assignProjectToStandaloneGroup(linked.id);
      expect(standalone).toMatchObject({ name: "repository-feature", kind: "standalone" });
      expect(repository.listStoredProjectGroups()).toHaveLength(2);
      expect(repository.getWorkspace(linked.id)).toEqual(linkedWorkspace);
    } finally {
      repository.close();
    }
  });

  it("keeps different project-relative folders in the same Git repository as separate groups", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const web = repository.createProject("/tmp/repository/apps/web", "web");
      const domain = repository.createProject("/tmp/repository/packages/domain", "domain");

      const webGroup = repository.assignProjectToGitGroup(
        web.id,
        "/tmp/repository/.git",
        "apps/web",
      );
      const domainGroup = repository.assignProjectToGitGroup(
        domain.id,
        "/tmp/repository/.git",
        "packages/domain",
      );

      expect(domainGroup.id).not.toBe(webGroup.id);
      expect(repository.findStoredGitProjectGroup("/tmp/repository/.git", "apps/web")?.id).toBe(
        webGroup.id,
      );
      expect(
        repository.findStoredGitProjectGroup("/tmp/repository/.git", "packages/domain")?.id,
      ).toBe(domainGroup.id);
    } finally {
      repository.close();
    }
  });

  it("rolls back Project creation when its Workspace insert fails", () => {
    const filename = temporaryDatabase();
    const setup = new NaruRepository(filename);
    setup.close();
    withRawDatabase(filename, (database) => {
      database.exec(`
        CREATE TRIGGER reject_workspace_insert
        BEFORE INSERT ON workspaces
        BEGIN
          SELECT RAISE(ABORT, 'workspace insert rejected');
        END
      `);
    });

    const repository = new NaruRepository(filename);
    try {
      expect(() => repository.createProject("/tmp/rollback-project", "rollback")).toThrow(
        /workspace insert rejected/,
      );
      expect(repository.listProjects()).toEqual([]);
    } finally {
      repository.close();
    }
  });

  it("persists independent Files, Docs, and Tasks Pane selections", () => {
    const filename = temporaryDatabase();
    const repository = new NaruRepository(filename);
    const project = repository.createProject("/tmp/document-panes", "document-panes");
    const initial = repository.getWorkspace(project.id);
    const targetPaneId = initial.activePaneId;
    if (!targetPaneId) throw new Error("default active Pane is missing");

    const firstDocs = repository.createPane(project.id, {
      kind: "docs",
      selectedDocumentPath: "docs/SPEC.md",
      workspaceVersion: initial.version,
      targetPaneId,
      direction: "horizontal",
    });
    const afterFirst = repository.getWorkspace(project.id);
    const secondDocs = repository.createPane(project.id, {
      kind: "docs",
      selectedDocumentPath: "docs/SPEC.md",
      workspaceVersion: afterFirst.version,
      targetPaneId: firstDocs.id,
      direction: "vertical",
    });
    const afterSecond = repository.getWorkspace(project.id);
    const files = repository.createPane(project.id, {
      kind: "files",
      selectedDocumentPath: "src/app.ts",
      workspaceVersion: afterSecond.version,
      targetPaneId: secondDocs.id,
      direction: "horizontal",
    });
    const afterFiles = repository.getWorkspace(project.id);
    const tasks = repository.createPane(project.id, {
      kind: "tasks",
      selectedDocumentPath: "docs/TASKS.md",
      workspaceVersion: afterFiles.version,
      targetPaneId: files.id,
      direction: "horizontal",
    });

    expect([firstDocs, secondDocs, files, tasks]).toEqual([
      expect.objectContaining({
        kind: "docs",
        title: "Docs",
        launchProfile: "docs-readonly",
        status: "ready",
        viewState: {
          selectedDocumentPath: "docs/SPEC.md",
          navigationOpen: true,
          expandedDirectories: [],
        },
      }),
      expect.objectContaining({
        kind: "docs",
        title: "Docs 2",
        viewState: {
          selectedDocumentPath: "docs/SPEC.md",
          navigationOpen: true,
          expandedDirectories: [],
        },
      }),
      expect.objectContaining({
        kind: "files",
        title: "Files",
        launchProfile: "files-editor",
        status: "ready",
        viewState: {
          selectedDocumentPath: "src/app.ts",
          navigationOpen: true,
          expandedDirectories: [],
        },
      }),
      expect.objectContaining({
        kind: "tasks",
        title: "Tasks",
        launchProfile: "tasks-readonly",
        status: "ready",
      }),
    ]);

    repository.updatePaneViewState(firstDocs.id, {
      selectedDocumentPath: "docs/ARCHITECTURE.md",
      navigationOpen: false,
    });
    repository.updatePaneViewState(files.id, {
      selectedDocumentPath: "src/app.ts",
      expandedDirectories: ["src"],
    });
    repository.close();

    const reopened = new NaruRepository(filename);
    try {
      const panes = reopened.getWorkspace(project.id).panes;
      expect(panes.find((pane) => pane.id === firstDocs.id)?.viewState).toEqual({
        selectedDocumentPath: "docs/ARCHITECTURE.md",
        navigationOpen: false,
        expandedDirectories: [],
      });
      expect(panes.find((pane) => pane.id === secondDocs.id)?.viewState).toEqual({
        selectedDocumentPath: "docs/SPEC.md",
        navigationOpen: true,
        expandedDirectories: [],
      });
      expect(panes.find((pane) => pane.id === files.id)?.viewState).toEqual({
        selectedDocumentPath: "src/app.ts",
        navigationOpen: true,
        expandedDirectories: ["src"],
      });
      const terminal = panes.find((pane) => pane.kind === "terminal");
      expect(() =>
        reopened.updatePaneViewState(terminal?.id ?? "missing", { navigationOpen: false }),
      ).toThrowError(expect.objectContaining({ code: "REQUEST_INVALID" }));
    } finally {
      reopened.close();
    }
  });

  it("rolls back Pane creation when its Workspace update fails", () => {
    const filename = temporaryDatabase();
    const repository = new NaruRepository(filename);
    const project = repository.createProject("/tmp/rollback-pane", "rollback-pane");
    repository.close();

    withRawDatabase(filename, (database) => {
      database.exec(`
        CREATE TRIGGER reject_workspace_update
        BEFORE UPDATE OF layout_json ON workspaces
        BEGIN
          SELECT RAISE(ABORT, 'workspace update rejected');
        END
      `);
    });

    const reopened = new NaruRepository(filename);
    try {
      const initial = reopened.getWorkspace(project.id);
      expect(() =>
        reopened.createPane(project.id, {
          kind: "terminal",
          workspaceVersion: initial.version,
          targetPaneId: initial.activePaneId,
          direction: "horizontal",
        }),
      ).toThrow(/workspace update rejected/);
      expect(reopened.getWorkspace(project.id)).toMatchObject({
        version: 0,
        activePaneId: initial.activePaneId,
      });
      expect(reopened.getWorkspace(project.id).panes).toHaveLength(3);
    } finally {
      reopened.close();
    }
  });

  it("keeps the last valid layout when stale or invalid saves are rejected", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const project = repository.createProject("/tmp/conflict-project", "conflict");
      const initial = repository.getWorkspace(project.id);
      if (initial.layout?.type !== "split") throw new Error("default split is missing");
      const firstSave = repository.saveWorkspace(project.id, {
        version: initial.version,
        layout: resizeSplit(initial.layout, initial.layout.id, 0.72),
        activePaneId: initial.panes[2]?.id ?? null,
      });

      expect(() =>
        repository.saveWorkspace(project.id, {
          version: initial.version,
          layout: initial.layout,
          activePaneId: initial.activePaneId,
        }),
      ).toThrowError(expect.objectContaining({ code: "LAYOUT_CONFLICT", statusCode: 409 }));
      expect(() =>
        repository.saveWorkspace(project.id, {
          version: firstSave.version,
          layout: {
            type: "pane",
            paneId: firstSave.panes[0]?.id ?? "",
            collapsed: false,
          },
          activePaneId: firstSave.panes[0]?.id ?? null,
        }),
      ).toThrowError(expect.objectContaining({ code: "REQUEST_INVALID", statusCode: 400 }));

      expect(repository.getWorkspace(project.id)).toMatchObject({
        version: firstSave.version,
        layout: { ratio: 0.72 },
        activePaneId: firstSave.activePaneId,
      });
    } finally {
      repository.close();
    }
  });

  it("rolls back stale create and close mutations without orphaning Pane metadata", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const project = repository.createProject("/tmp/stale-mutation", "stale-mutation");
      const initial = repository.getWorkspace(project.id);
      const target = initial.panes[2];
      if (!target) throw new Error("default terminal is missing");
      const saved = repository.saveWorkspace(project.id, {
        version: initial.version,
        layout: initial.layout,
        activePaneId: target.id,
      });

      expect(() =>
        repository.createPane(project.id, {
          kind: "terminal",
          workspaceVersion: initial.version,
          targetPaneId: target.id,
          direction: "horizontal",
        }),
      ).toThrowError(expect.objectContaining({ code: "LAYOUT_CONFLICT" }));
      expect(() => repository.deletePane(target.id, initial.version)).toThrowError(
        expect.objectContaining({ code: "LAYOUT_CONFLICT" }),
      );

      const current = repository.getWorkspace(project.id);
      expect(current.version).toBe(saved.version);
      expect(current.panes).toHaveLength(3);
      expect(current.panes.some((pane) => pane.id === target.id)).toBe(true);
    } finally {
      repository.close();
    }
  });

  it("rolls back layout saves and Pane closes when the Workspace write fails", () => {
    const filename = temporaryDatabase();
    const setup = new NaruRepository(filename);
    const project = setup.createProject("/tmp/failed-layout-write", "failed-layout-write");
    const initial = setup.getWorkspace(project.id);
    setup.close();
    withRawDatabase(filename, (database) => {
      database.exec(`
        CREATE TRIGGER reject_layout_write
        BEFORE UPDATE OF layout_json ON workspaces
        BEGIN
          SELECT RAISE(ABORT, 'layout write rejected');
        END
      `);
    });

    const repository = new NaruRepository(filename);
    try {
      const initialLayout = initial.layout;
      if (initialLayout?.type !== "split") throw new Error("default split is missing");
      expect(() =>
        repository.saveWorkspace(project.id, {
          version: initial.version,
          layout: resizeSplit(initialLayout, initialLayout.id, 0.75),
          activePaneId: initial.activePaneId,
        }),
      ).toThrow(/layout write rejected/);
      const paneToClose = initial.panes[2];
      if (!paneToClose) throw new Error("default terminal is missing");
      expect(() => repository.deletePane(paneToClose.id, initial.version)).toThrow(
        /layout write rejected/,
      );

      expect(repository.getWorkspace(project.id)).toEqual(initial);
    } finally {
      repository.close();
    }
  });

  it("cascades Workspace and Pane metadata when a Project is removed", () => {
    const filename = temporaryDatabase();
    const repository = new NaruRepository(filename);
    const project = repository.createProject("/tmp/naru-project", "naru-project");

    expect(repository.deleteProject(project.id)).toBe(true);
    repository.close();

    withRawDatabase(filename, (database) => {
      expect(rowCount(database, "project_groups")).toBe(0);
      expect(rowCount(database, "projects")).toBe(0);
      expect(rowCount(database, "workspaces")).toBe(0);
      expect(rowCount(database, "panes")).toBe(0);
    });
  });

  it("stores only validated Codex session IDs on Codex Panes", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const project = repository.createProject("/tmp/codex-session", "codex-session");
      const workspace = repository.getWorkspace(project.id);
      const codexPane = workspace.panes.find((pane) => pane.kind === "codex");
      const terminalPane = workspace.panes.find((pane) => pane.kind === "terminal");
      if (!codexPane || !terminalPane) throw new Error("default Panes are missing");
      const sessionId = "33333333-3333-4333-8333-333333333333";

      const initialUpdatedAt = codexPane.updatedAt;
      repository.setCodexSession(codexPane.id, sessionId, false);
      const identified = repository.getPaneContext(codexPane.id)?.pane;
      expect(identified).toMatchObject({
        codexSessionId: sessionId,
        codexSessionResumable: false,
      });
      expect((identified?.updatedAt ?? "") > initialUpdatedAt).toBe(true);
      repository.setCodexSession(codexPane.id, sessionId, true);
      const resumable = repository.getPaneContext(codexPane.id)?.pane;
      expect(resumable?.codexSessionResumable).toBe(true);
      expect((resumable?.updatedAt ?? "") > (identified?.updatedAt ?? "")).toBe(true);
      expect(() => repository.setCodexSession(codexPane.id, null, true)).toThrowError(
        expect.objectContaining({ code: "REQUEST_INVALID" }),
      );
      expect(() =>
        repository.setCodexSession(codexPane.id, "not-a-session-id", false),
      ).toThrowError(expect.objectContaining({ code: "REQUEST_INVALID" }));
      expect(() => repository.setCodexSession(terminalPane.id, sessionId, false)).toThrowError(
        expect.objectContaining({ code: "REQUEST_INVALID" }),
      );
    } finally {
      repository.close();
    }
  });

  it("marks a runtime stopped by the server without reporting a user-task failure on reopen", () => {
    const filename = temporaryDatabase();
    const repository = new NaruRepository(filename);
    const project = repository.createProject("/tmp/interrupted-codex", "interrupted-codex");
    const codexPane = repository
      .getWorkspace(project.id)
      .panes.find((pane) => pane.kind === "codex");
    if (!codexPane) throw new Error("default Codex Pane is missing");
    const runtimeId = randomUUID();
    const started = repository.beginPaneRuntime(codexPane.id, runtimeId);
    repository.setPaneActivityForRuntime(codexPane.id, runtimeId, "interaction-required");
    repository.close();

    const reopened = new NaruRepository(filename);
    try {
      const stoppedPane = reopened.getPaneContext(codexPane.id)?.pane;
      expect(stoppedPane).toMatchObject({
        status: "stopped",
        exitCode: null,
        activity: {
          state: "server-stopped",
          runtimeId,
          revision: started.activity.revision + 2,
        },
      });
      expect(Number.isNaN(Date.parse(stoppedPane?.lastExitedAt ?? ""))).toBe(false);
    } finally {
      reopened.close();
    }
  });

  it("does not rewrite Host-owned running Pane state when Naru reopens", () => {
    const filename = temporaryDatabase();
    const first = new NaruRepository(filename, { sessionOwner: "durable-host" });
    const project = first.createProject("/tmp/host-owned-runtime", "host-owned-runtime");
    const pane = first
      .getWorkspace(project.id)
      .panes.find((candidate) => candidate.kind === "terminal");
    if (pane === undefined) throw new Error("Host-owned fixture terminal is missing.");
    first.setPaneStatus(pane.id, "running");
    first.close();

    const hostOwned = new NaruRepository(filename, { sessionOwner: "durable-host" });
    expect(hostOwned.getPaneContext(pane.id)?.pane.status).toBe("running");
    hostOwned.close();

    const legacyOwned = new NaruRepository(filename, { sessionOwner: "legacy" });
    expect(legacyOwned.getPaneContext(pane.id)?.pane.status).toBe("stopped");
    expect(legacyOwned.getPaneContext(pane.id)?.pane.activity.state).toBe("server-stopped");
    legacyOwned.close();
  });

  it("persists only Pane-to-Session identity plus a crash-retry fence", () => {
    const repository = new NaruRepository(":memory:", { sessionOwner: "durable-host" });
    try {
      const project = repository.createProject("/tmp/durable-link", "durable-link");
      const pane = repository
        .getWorkspace(project.id)
        .panes.find((candidate) => candidate.kind === "terminal");
      if (pane === undefined) throw new Error("Durable link fixture terminal is missing.");

      const pending = repository.preparePaneSessionOperation(pane.id, "create");
      expect(repository.preparePaneSessionOperation(pane.id, "create")).toEqual(pending);
      expect(pending).toMatchObject({
        state: "pending",
        expectedSessionRevision: null,
        expectedRuntimeId: null,
      });

      const session = hostSessionView();
      repository.completePaneSessionOperation(
        pane.id,
        "create",
        pending.operationKey as string,
        session,
      );
      expect(repository.getPaneSessionLink(pane.id)).toMatchObject({
        sessionId: session.sessionId,
        state: "linked",
        expectedSessionRevision: null,
        expectedRuntimeId: null,
      });

      const stopping = repository.preparePaneSessionOperation(pane.id, "stop", {
        sessionRevision: session.sessionRevision,
        runtimeId: session.runtimeId as string,
      });
      expect(stopping).toMatchObject({
        expectedSessionRevision: session.sessionRevision,
        expectedRuntimeId: session.runtimeId,
      });
      repository.clearPaneSessionOperation(
        pane.id,
        "stop",
        stopping.operationKey as string,
        "RUNTIME_STALE",
      );
      expect(repository.getPaneSessionLink(pane.id)).toMatchObject({
        state: "linked",
        expectedSessionRevision: null,
        expectedRuntimeId: null,
        lastErrorCode: "RUNTIME_STALE",
      });

      expect(repository.deleteProject(project.id)).toBe(true);
      expect(repository.getPaneSessionLink(pane.id)).toBeUndefined();
    } finally {
      repository.close();
    }
  });

  it("makes runtime activity transitions generation-aware without hiding a current failure", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const project = repository.createProject("/tmp/runtime-generation", "runtime-generation");
      const pane = repository
        .getWorkspace(project.id)
        .panes.find((candidate) => candidate.kind === "codex");
      if (!pane) throw new Error("default Codex Pane is missing");
      const previousFailure = repository.setPaneActivity(pane.id, "failed");
      if (!previousFailure) throw new Error("previous failure event is missing");

      const previousRuntimeId = randomUUID();
      const previousStart = repository.beginPaneRuntime(pane.id, previousRuntimeId);
      expect(previousStart.activity).toMatchObject({
        state: "idle",
        runtimeId: previousRuntimeId,
        revision: previousFailure.activity.revision + 1,
      });
      expect(
        repository.setPaneActivityForRuntime(pane.id, previousRuntimeId, "running")?.activity.state,
      ).toBe("running");

      const currentRuntimeId = randomUUID();
      const currentStart = repository.beginPaneRuntime(pane.id, currentRuntimeId);
      expect(currentStart.activity).toMatchObject({
        state: "idle",
        runtimeId: currentRuntimeId,
        revision: previousStart.activity.revision + 2,
      });
      expect(repository.setPaneActivityForRuntime(pane.id, previousRuntimeId, "failed")).toBeNull();
      expect(
        repository.setPaneStatusForRuntime(
          pane.id,
          previousRuntimeId,
          "error",
          null,
          "PTY_SPAWN_FAILED",
        ),
      ).toBe(false);
      expect(
        repository.setCodexSessionForRuntime(pane.id, previousRuntimeId, randomUUID(), true),
      ).toBe(false);
      expect(repository.getPaneContext(pane.id)?.pane).toMatchObject({
        status: "running",
        codexSessionId: null,
        activity: currentStart.activity,
      });

      expect(
        repository.setPaneStatusForRuntime(
          pane.id,
          currentRuntimeId,
          "error",
          null,
          "PTY_SPAWN_FAILED",
        ),
      ).toBe(true);
      const currentFailure = repository.setPaneActivityForRuntime(
        pane.id,
        currentRuntimeId,
        "failed",
      );
      expect(currentFailure?.activity).toMatchObject({
        state: "failed",
        runtimeId: currentRuntimeId,
        revision: currentStart.activity.revision + 1,
      });
      expect(repository.getProjectActivity(project.id).state).toBe("failed");
    } finally {
      repository.close();
    }
  });

  it("persists Pane activity and aggregates projects with the approved priority", () => {
    const repository = new NaruRepository(temporaryDatabase());
    try {
      const project = repository.createProject("/tmp/activity-project", "activity-project");
      const panes = repository.getWorkspace(project.id).panes;
      const [main, quick, terminal] = panes;
      if (!main || !quick || !terminal) throw new Error("default panes are missing");

      const running = repository.setPaneActivity(main.id, "running");
      expect(running?.activity).toMatchObject({ state: "running" });
      expect(running?.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(repository.getProject(project.id)?.activity.state).toBe("running");

      repository.setPaneActivity(quick.id, "completed");
      expect(repository.getProject(project.id)?.activity.state).toBe("completed");
      repository.setPaneActivity(main.id, "canceled");
      expect(repository.getProject(project.id)?.activity.state).toBe("completed");
      repository.setPaneActivity(quick.id, "server-stopped");
      expect(repository.getProject(project.id)?.activity.state).toBe("server-stopped");
      repository.setPaneActivity(terminal.id, "failed");
      expect(repository.getProject(project.id)?.activity.state).toBe("failed");
      repository.setPaneActivity(main.id, "interaction-required");
      repository.setPaneActivity(quick.id, "interaction-required");
      expect(repository.getProject(project.id)?.activity).toMatchObject({
        state: "interaction-required",
        interactionRequiredCount: 2,
      });

      const firstCompleted = repository.setPaneActivity(main.id, "completed");
      if (!firstCompleted) throw new Error("first completed event is missing");
      repository.setPaneActivity(main.id, "running");
      const currentCompleted = repository.setPaneActivity(main.id, "completed");
      if (!currentCompleted) throw new Error("current completed event is missing");
      expect(repository.acknowledgeCompletedActivity(main.id, firstCompleted.eventId)).toBeNull();
      expect(repository.getPaneContext(main.id)?.pane.activity).toMatchObject({
        state: "completed",
        eventId: currentCompleted.eventId,
      });
      const acknowledged = repository.acknowledgeCompletedActivity(
        main.id,
        currentCompleted.eventId,
      );
      expect(acknowledged?.activity.state).toBe("idle");
      expect(repository.getPaneContext(main.id)?.pane.activity.state).toBe("idle");
      expect(repository.acknowledgeCompletedActivity(main.id, currentCompleted.eventId)).toBeNull();
    } finally {
      repository.close();
    }
  });
});

describe("database migrations", () => {
  it("upgrades legacy schema, preserves data and is safe to rerun", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 1));
      database
        .prepare(
          `INSERT INTO projects (id, name, real_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "11111111-1111-4111-8111-111111111111",
          "legacy",
          "/tmp/legacy",
          "2026-08-17T00:00:00.000Z",
          "2026-08-17T00:00:00.000Z",
        );
      database
        .prepare(
          `INSERT INTO workspaces (project_id, version, layout_json, active_pane_id, updated_at)
           VALUES (?, 0, NULL, NULL, ?)`,
        )
        .run("11111111-1111-4111-8111-111111111111", "2026-08-17T00:00:00.000Z");

      runDatabaseMigrations(database);
      runDatabaseMigrations(database);

      expect(
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
        { version: 7 },
        { version: 8 },
        { version: 9 },
        { version: 10 },
        { version: 11 },
        { version: 12 },
        { version: 13 },
        { version: 14 },
        { version: 15 },
        { version: 16 },
        { version: 17 },
        { version: 18 },
        { version: 19 },
        { version: 20 },
        { version: 21 },
      ]);
      expect(database.prepare("SELECT * FROM project_groups").get()).toMatchObject({
        id: "11111111-1111-4111-8111-111111111111",
        name: "legacy",
        kind: "standalone",
        git_common_dir: null,
        git_relative_path: null,
      });
      expect(database.prepare("SELECT group_id FROM projects").get()).toEqual({
        group_id: "11111111-1111-4111-8111-111111111111",
      });
      expect(database.prepare("SELECT schema_version FROM workspaces").get()).toEqual({
        schema_version: LAYOUT_SCHEMA_VERSION,
      });
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('panes') ORDER BY cid")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(
        expect.arrayContaining([
          "codex_session_id",
          "codex_session_resumable",
          "claude_session_id",
          "last_error_code",
          "last_exited_at",
          "activity_state",
          "activity_event_id",
          "activity_runtime_id",
          "activity_revision",
          "activity_updated_at",
          "view_state_json",
        ]),
      );
      const panesDefinition = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'panes'")
        .get() as { sql: string };
      expect(panesDefinition.sql).toContain("'canceled'");
      expect(panesDefinition.sql).toContain("'server-stopped'");
      expect(tableExists(database, "pane_session_links")).toBe(true);
      expect(tableExists(database, "push_project_clears")).toBe(true);
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('pane_session_links') ORDER BY cid")
          .all()
          .map((row) => (row as { name: string }).name),
      ).toEqual(
        expect.arrayContaining(["integration_binding_id", "integration_launch_runtime_id"]),
      );
      expect(
        database
          .prepare("SELECT name FROM pragma_table_info('pane_session_links') ORDER BY cid")
          .all()
          .map((row) => (row as { name: string }).name),
      ).not.toEqual(expect.arrayContaining(["runtime_id", "session_revision", "host_lifecycle"]));
    } finally {
      database.close();
    }
  });

  it("adds Claude panes without losing an active Host session link", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 16));
      const projectId = "11111111-1111-4111-8111-111111111111";
      const paneId = "22222222-2222-4222-8222-222222222222";
      const sessionId = "33333333-3333-4333-8333-333333333333";
      const timestamp = "2026-09-26T00:00:00.000Z";
      database
        .prepare(
          `INSERT INTO project_groups
        (id, name, kind, created_at, updated_at) VALUES (?, 'fixture', 'standalone', ?, ?)`,
        )
        .run(projectId, timestamp, timestamp);
      database
        .prepare(
          `INSERT INTO projects
        (id, name, real_path, group_id, created_at, updated_at)
        VALUES (?, 'fixture', '/tmp/fixture', ?, ?, ?)`,
        )
        .run(projectId, projectId, timestamp, timestamp);
      database
        .prepare(
          `INSERT INTO workspaces
        (project_id, schema_version, version, updated_at) VALUES (?, ?, 0, ?)`,
        )
        .run(projectId, LAYOUT_SCHEMA_VERSION, timestamp);
      database
        .prepare(
          `INSERT INTO panes
        (id, project_id, kind, title, launch_profile, status, activity_updated_at,
         created_at, updated_at) VALUES (?, ?, 'codex', 'Main Codex', 'codex-main',
         'running', ?, ?, ?)`,
        )
        .run(paneId, projectId, timestamp, timestamp, timestamp);
      database
        .prepare(
          `INSERT INTO pane_session_links
        (pane_id, session_id, state, created_at, updated_at)
        VALUES (?, ?, 'linked', ?, ?)`,
        )
        .run(paneId, sessionId, timestamp, timestamp);

      runDatabaseMigrations(database);

      expect(database.prepare("SELECT * FROM pragma_foreign_key_check").all()).toEqual([]);
      expect(
        database.prepare("SELECT pane_id, session_id, state FROM pane_session_links").get(),
      ).toEqual({ pane_id: paneId, session_id: sessionId, state: "linked" });
      expect(database.prepare("SELECT kind, status FROM panes WHERE id = ?").get(paneId)).toEqual({
        kind: "codex",
        status: "running",
      });
      expect(() =>
        database
          .prepare(
            `INSERT INTO panes
        (id, project_id, kind, title, launch_profile, status, activity_updated_at,
         created_at, updated_at) VALUES (?, ?, 'claude', 'Claude Code', 'claude-code',
         'stopped', ?, ?, ?)`,
          )
          .run("44444444-4444-4444-8444-444444444444", projectId, timestamp, timestamp, timestamp),
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("adds Files in schema v12 without losing schema v11 interruption state", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 1));
      database
        .prepare(
          `INSERT INTO projects (id, name, real_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run(
          "11111111-1111-4111-8111-111111111111",
          "schema-v11",
          "/tmp/schema-v11",
          "2026-08-21T00:00:00.000Z",
          "2026-08-21T00:00:00.000Z",
        );
      database
        .prepare(
          `INSERT INTO workspaces (project_id, version, layout_json, active_pane_id, updated_at)
           VALUES (?, 0, NULL, NULL, ?)`,
        )
        .run("11111111-1111-4111-8111-111111111111", "2026-08-21T00:00:00.000Z");
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 11));
      database
        .prepare(
          `INSERT INTO panes
            (id, project_id, kind, title, launch_profile, status, activity_state,
             activity_event_id, activity_updated_at, view_state_json, created_at, updated_at)
           VALUES (?, ?, 'codex', 'Main Codex', 'codex-main', 'stopped', 'canceled',
             ?, ?, ?, ?, ?)`,
        )
        .run(
          "22222222-2222-4222-8222-222222222222",
          "11111111-1111-4111-8111-111111111111",
          "33333333-3333-4333-8333-333333333333",
          "2026-08-21T00:01:00.000Z",
          '{"selectedDocumentPath":"docs/TASKS.md","navigationOpen":false}',
          "2026-08-21T00:00:00.000Z",
          "2026-08-21T00:01:00.000Z",
        );

      runDatabaseMigrations(database);

      expect(
        database
          .prepare(
            `SELECT kind, activity_state, activity_event_id, activity_runtime_id,
                    activity_revision, activity_updated_at, view_state_json
             FROM panes WHERE id = ?`,
          )
          .get("22222222-2222-4222-8222-222222222222"),
      ).toEqual({
        kind: "codex",
        activity_state: "canceled",
        activity_event_id: "33333333-3333-4333-8333-333333333333",
        activity_runtime_id: null,
        activity_revision: 0,
        activity_updated_at: "2026-08-21T00:01:00.000Z",
        view_state_json: '{"selectedDocumentPath":"docs/TASKS.md","navigationOpen":false}',
      });
      const panesDefinition = database
        .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'panes'")
        .get() as { sql: string };
      expect(panesDefinition.sql).toContain("'files'");
      expect(panesDefinition.sql).toContain("'server-stopped'");
    } finally {
      database.close();
    }
  });

  it("rolls back every change from a failed migration", () => {
    const database = new Database(":memory:");
    const baseline: DatabaseMigration = {
      version: 1,
      migrate(target) {
        target.exec("CREATE TABLE stable_record (id INTEGER PRIMARY KEY)");
      },
    };
    const failing: DatabaseMigration = {
      version: 2,
      migrate(target) {
        target.exec("CREATE TABLE partial_record (id INTEGER PRIMARY KEY)");
        throw new Error("intentional migration failure");
      },
    };

    try {
      runDatabaseMigrations(database, [baseline]);
      expect(() => runDatabaseMigrations(database, [baseline, failing])).toThrow(
        /intentional migration failure/,
      );

      expect(tableExists(database, "stable_record")).toBe(true);
      expect(tableExists(database, "partial_record")).toBe(false);
      expect(
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all(),
      ).toEqual([{ version: 1 }]);
    } finally {
      database.close();
    }
  });

  it("keeps pre-v5 Codex IDs but does not assume they are resumable", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 4));
      const now = "2026-08-19T00:00:00.000Z";
      database
        .prepare(
          `INSERT INTO projects (id, name, real_path, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run("project-id", "legacy", "/tmp/legacy", now, now);
      database
        .prepare(
          `INSERT INTO panes
            (id, project_id, kind, title, launch_profile, status, exit_code,
             codex_session_id, last_error_code, last_exited_at, created_at, updated_at)
           VALUES (?, ?, 'codex', 'Main Codex', 'codex-main', 'stopped', NULL,
                   ?, NULL, NULL, ?, ?)`,
        )
        .run("pane-id", "project-id", "33333333-3333-4333-8333-333333333333", now, now);

      runDatabaseMigrations(database);

      expect(
        database
          .prepare(
            `SELECT codex_session_id, codex_session_resumable
             FROM panes WHERE id = 'pane-id'`,
          )
          .get(),
      ).toEqual({
        codex_session_id: "33333333-3333-4333-8333-333333333333",
        codex_session_resumable: 0,
      });
    } finally {
      database.close();
    }
  });
});

function hostSessionView(): SessionView {
  const now = Date.now();
  return {
    sessionId: randomUUID(),
    lifecycle: "running",
    sessionRevision: 3,
    runtimeId: randomUUID(),
    terminal: { cols: 100, rows: 30 },
    controllerAttachmentId: null,
    controllerGeneration: 0,
    nextSequence: 0,
    command: { kind: "profile", profileId: "shell", rootId: "projects" },
    createdAtMs: now,
    updatedAtMs: now,
  };
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "naru-database-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "naru.sqlite");
}

function pushInput(index: number, expirationTime: number | null = null) {
  return {
    name: `Device ${index}`,
    endpoint: `https://push.example.test/device-${index}`,
    expirationTime,
    keys: {
      p256dh: Buffer.alloc(65, index).toString("base64url"),
      auth: Buffer.alloc(16, index).toString("base64url"),
    },
  };
}

function withRawDatabase(filename: string, run: (database: Database.Database) => void): void {
  const database = new Database(filename);
  try {
    database.pragma("foreign_keys = ON");
    run(database);
  } finally {
    database.close();
  }
}

function rowCount(database: Database.Database, table: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
  return row.count;
}

function tableExists(database: Database.Database, table: string): boolean {
  return (
    database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !==
    undefined
  );
}
