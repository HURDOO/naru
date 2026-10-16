import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { LAYOUT_SCHEMA_VERSION, type LayoutNode, type Workspace } from "@naru/contracts";
import { viewPaneIds, viewSlots } from "@naru/domain";
import { DATABASE_MIGRATIONS, NaruRepository, runDatabaseMigrations } from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const PROJECT = "11111111-1111-4111-8111-111111111111";
const CLAUDE = "21111111-1111-4111-8111-111111111111";
const CODEX = "22222222-2222-4222-8222-222222222222";
const PROCESS_TERMINAL = "23333333-3333-4333-8333-333333333333";
const TERMINAL = "24444444-4444-4444-8444-444444444444";
const SPLIT_TOP = "31111111-1111-4111-8111-111111111111";
const SPLIT_ROOT = "32222222-2222-4222-8222-222222222222";
const SPLIT_BOTTOM = "33333333-3333-4333-8333-333333333333";

describe("workspace views migration (v21, AP-D031)", () => {
  it("keeps what each project shows as 내 배치 and adds 기본 without touching Panes", () => {
    const filename = temporaryDatabase();
    const database = new Database(filename);
    database.pragma("foreign_keys = ON");
    runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 20));
    seedVersion20Project(database);
    const panesBefore = database.prepare("SELECT * FROM panes ORDER BY id").all();
    const legacyBefore = database.prepare("SELECT * FROM workspaces").get();
    database.close();

    const repository = new NaruRepository(filename);
    try {
      const workspace = repository.getWorkspace(PROJECT);
      const [existing, standard] = workspace.views ?? [];
      expect(workspace.views).toHaveLength(2);

      expect(existing).toMatchObject({ name: "내 배치", kind: "user", version: 0 });
      // The collapsed Main Codex and the agent terminal stay out; the arrangement is kept.
      expect(existing!.layout).toEqual({
        type: "split",
        id: SPLIT_ROOT,
        direction: "vertical",
        ratio: 0.7,
        first: { type: "pane", paneId: CLAUDE },
        second: { type: "pane", paneId: TERMINAL },
      });
      // The active Pane was collapsed, so the first shown Pane is active.
      expect(existing!.activePaneId).toBe(CLAUDE);

      expect(standard).toMatchObject({ name: "기본", kind: "user" });
      expect(viewPaneIds(standard!.layout)).toEqual([CLAUDE, CODEX, TERMINAL]);
      expect(viewSlots(standard!.layout)).toEqual([]);
      expect(standard!.activePaneId).toBe(CLAUDE);

      // Panes and the project layout are unchanged; the new name column starts empty.
      expect(workspace.layout).toEqual(legacyLayout());
      expect(workspace.panes.map((pane) => pane.customTitle)).toEqual([null, null, null, null]);
      const reopened = new Database(filename, { readonly: true });
      expect(
        reopened
          .prepare("SELECT * FROM panes ORDER BY id")
          .all()
          .map((row) => {
            const { custom_title: customTitle, ...rest } = row as Record<string, unknown>;
            expect(customTitle).toBeNull();
            return rest;
          }),
      ).toEqual(panesBefore);
      expect(reopened.prepare("SELECT * FROM workspaces").get()).toEqual(legacyBefore);
      reopened.close();
    } finally {
      repository.close();
    }
  });

  it("leaves empty places in 기본 for Panes a project does not have", () => {
    const database = new Database(":memory:");
    database.pragma("foreign_keys = ON");
    try {
      runDatabaseMigrations(database, DATABASE_MIGRATIONS.slice(0, 20));
      seedProjectRow(database);
      database
        .prepare(
          `INSERT INTO workspaces (project_id, schema_version, version, layout_json, active_pane_id, updated_at)
           VALUES (?, ?, 3, NULL, NULL, ?)`,
        )
        .run(PROJECT, LAYOUT_SCHEMA_VERSION, NOW);
      runDatabaseMigrations(database);
      const views = database
        .prepare("SELECT name, layout_json, active_pane_id FROM workspace_views ORDER BY position")
        .all() as Array<{ name: string; layout_json: string | null; active_pane_id: null }>;
      expect(views.map((view) => view.name)).toEqual(["내 배치", "기본"]);
      expect(views[0]!.layout_json).toBeNull();
      const standard = JSON.parse(views[1]!.layout_json!) as Parameters<typeof viewSlots>[0];
      expect(viewSlots(standard).map((slot) => slot.pane)).toEqual([
        { kind: "claude", launchProfile: "claude-code" },
        { kind: "codex", launchProfile: "codex-main" },
        { kind: "terminal", launchProfile: "shell" },
      ]);
      expect(views[1]!.active_pane_id).toBeNull();
    } finally {
      database.close();
    }
  });
});

describe("workspace views (AP-D031)", () => {
  it("gives a new project the default workspace over the Panes it creates", () => {
    const repository = new NaruRepository(":memory:");
    try {
      const project = repository.createProject("/tmp/naru-views-fixture", "fixture");
      const workspace = repository.getWorkspace(project.id);
      expect(workspace.views?.map((view) => view.name)).toEqual(["기본"]);
      const standard = workspace.views![0]!;
      const byTitle = new Map(workspace.panes.map((pane) => [pane.title, pane.id]));
      // Codex instances start Main and Quick Codex: Claude keeps an empty place.
      expect(viewPaneIds(standard.layout)).toEqual([
        byTitle.get("Main Codex"),
        byTitle.get("Dev Terminal"),
      ]);
      expect(viewSlots(standard.layout).map((slot) => slot.pane.kind)).toEqual(["claude"]);
    } finally {
      repository.close();
    }
  });

  it("creates, saves and deletes workspaces with per-workspace versions", () => {
    const repository = new NaruRepository(":memory:");
    try {
      const project = repository.createProject("/tmp/naru-views-fixture", "fixture");
      const panes = repository.getWorkspace(project.id).panes;
      const [first, second] = panes;

      let workspace = repository.createWorkspaceView(project.id, {
        name: "리뷰 보기",
        layout: { type: "pane", paneId: first!.id },
        activePaneId: first!.id,
      });
      const created = workspace.views!.at(-1)!;
      expect(created).toMatchObject({ name: "리뷰 보기", version: 0 });

      workspace = repository.saveWorkspaceView(project.id, created.id, {
        version: 0,
        name: "리뷰",
        layout: {
          type: "split",
          id: SPLIT_TOP,
          direction: "horizontal",
          ratio: 0.4,
          first: { type: "pane", paneId: first!.id },
          second: { type: "pane", paneId: second!.id },
        },
        activePaneId: second!.id,
      });
      expect(workspace.views!.at(-1)).toMatchObject({
        name: "리뷰",
        version: 1,
        activePaneId: second!.id,
      });
      // Workspaces never change the project layout or its version.
      expect(workspace.version).toBe(0);

      expectAppError(
        () =>
          repository.saveWorkspaceView(project.id, created.id, {
            version: 0,
            name: "stale",
            layout: null,
            activePaneId: null,
          }),
        "LAYOUT_CONFLICT",
      );
      expectAppError(
        () =>
          repository.saveWorkspaceView(project.id, created.id, {
            version: 1,
            name: "twice",
            layout: {
              type: "split",
              id: SPLIT_TOP,
              direction: "horizontal",
              ratio: 0.5,
              first: { type: "pane", paneId: first!.id },
              second: { type: "pane", paneId: first!.id },
            },
            activePaneId: null,
          }),
        "REQUEST_INVALID",
      );
      expectAppError(
        () =>
          repository.saveWorkspaceView(project.id, created.id, {
            version: 1,
            name: "elsewhere",
            layout: { type: "pane", paneId: first!.id },
            activePaneId: second!.id,
          }),
        "REQUEST_INVALID",
      );
      expectAppError(
        () =>
          repository.saveWorkspaceView(project.id, PROJECT, {
            version: 0,
            name: "missing",
            layout: null,
            activePaneId: null,
          }),
        "WORKSPACE_VIEW_MISSING",
      );

      expectAppError(
        () => repository.deleteWorkspaceView(project.id, created.id, 0),
        "LAYOUT_CONFLICT",
      );
      workspace = repository.deleteWorkspaceView(project.id, created.id, 1);
      expect(workspace.views!.map((view) => view.name)).toEqual(["기본"]);
      // Removing a workspace keeps every Pane.
      expect(workspace.panes).toHaveLength(panes.length);
    } finally {
      repository.close();
    }
  });

  it("limits workspaces per project", () => {
    const repository = new NaruRepository(":memory:");
    try {
      const project = repository.createProject("/tmp/naru-views-fixture", "fixture");
      for (let index = 1; index < 32; index += 1) {
        repository.createWorkspaceView(project.id, {
          name: `보기 ${index}`,
          layout: null,
          activePaneId: null,
        });
      }
      expectAppError(
        () =>
          repository.createWorkspaceView(project.id, {
            name: "하나 더",
            layout: null,
            activePaneId: null,
          }),
        "REQUEST_INVALID",
      );
    } finally {
      repository.close();
    }
  });

  it("makes Panes inside a workspace and keeps the project layout complete", () => {
    const repository = new NaruRepository(":memory:");
    try {
      const project = repository.createProject("/tmp/naru-views-fixture", "fixture");
      const before = repository.getWorkspace(project.id);
      const standard = before.views![0]!;
      const slot = viewSlots(standard.layout)[0]!;

      const claude = repository.createWorkspaceViewPane(project.id, standard.id, {
        kind: "claude",
        launchProfile: "claude-code",
        viewVersion: standard.version,
        placement: { type: "slot", slotId: slot.id },
      });
      let workspace = repository.getWorkspace(project.id);
      let view = workspace.views![0]!;
      expect(viewSlots(view.layout)).toEqual([]);
      expect(viewPaneIds(view.layout)[0]).toBe(claude.id);
      expect(view).toMatchObject({ activePaneId: claude.id, version: standard.version + 1 });
      expect(claude).toMatchObject({ kind: "claude", title: "Claude Code 1", status: "stopped" });
      // The project layout gains the Pane collapsed; what it showed is unchanged.
      expect(workspace.panes).toHaveLength(before.panes.length + 1);
      expect(workspace.version).toBe(before.version + 1);
      expect(collapsedIn(workspace.layout, claude.id)).toBe(true);

      const terminal = repository.createWorkspaceViewPane(project.id, standard.id, {
        kind: "terminal",
        viewVersion: view.version,
        placement: { type: "split", targetPaneId: claude.id, direction: "vertical" },
      });
      workspace = repository.getWorkspace(project.id);
      view = workspace.views![0]!;
      expect(viewPaneIds(view.layout).slice(0, 2)).toEqual([claude.id, terminal.id]);

      expectAppError(
        () =>
          repository.createWorkspaceViewPane(project.id, standard.id, {
            kind: "terminal",
            viewVersion: standard.version,
            placement: { type: "root" },
          }),
        "LAYOUT_CONFLICT",
      );
      expectAppError(
        () =>
          repository.createWorkspaceViewPane(project.id, standard.id, {
            kind: "terminal",
            viewVersion: view.version,
            placement: { type: "root" },
          }),
        "REQUEST_INVALID",
      );
      expect(repository.getWorkspace(project.id).panes).toHaveLength(workspace.panes.length);

      const empty = repository
        .createWorkspaceView(project.id, {
          name: "빈 보기",
          layout: null,
          activePaneId: null,
        })
        .views!.at(-1)!;
      const alone = repository.createWorkspaceViewPane(project.id, empty.id, {
        kind: "docs",
        viewVersion: 0,
        placement: { type: "root" },
      });
      expect(repository.getWorkspace(project.id).views!.at(-1)!.layout).toEqual({
        type: "pane",
        paneId: alone.id,
      });
    } finally {
      repository.close();
    }
  });

  it("takes a deleted Pane out of every workspace", () => {
    const repository = new NaruRepository(":memory:");
    try {
      const project = repository.createProject("/tmp/naru-views-fixture", "fixture");
      const initial = repository.getWorkspace(project.id);
      const terminal = initial.panes.find((pane) => pane.kind === "terminal")!;
      const withView = repository.createWorkspaceView(project.id, {
        name: "터미널만",
        layout: { type: "pane", paneId: terminal.id },
        activePaneId: terminal.id,
      });

      const after = repository.deletePane(terminal.id, withView.version)!;
      for (const view of after.views!) {
        expect(viewPaneIds(view.layout)).not.toContain(terminal.id);
        expect(view.activePaneId).not.toBe(terminal.id);
      }
      expect(after.views![1]).toMatchObject({ layout: null, activePaneId: null, version: 1 });
      expect(after.views![0]!.version).toBe(1);
    } finally {
      repository.close();
    }
  });

  it("renames a Pane for the person and reports names for agent screens", () => {
    const repository = new NaruRepository(":memory:");
    try {
      const project = repository.createProject("/tmp/naru-views-fixture", "fixture");
      const [first, second] = repository.getWorkspace(project.id).panes;

      expect(repository.renamePane(first!.id, "로그인 담당")).toMatchObject({
        title: first!.title,
        customTitle: "로그인 담당",
      });
      expect(repository.customPaneTitles([first!.id, second!.id])).toEqual({
        [first!.id]: "로그인 담당",
      });
      expect(repository.renamePane(first!.id, null).customTitle).toBeNull();
      expect(repository.customPaneTitles([first!.id])).toEqual({});
      expect(repository.customPaneTitles([])).toEqual({});
      expectAppError(() => repository.renamePane(PROJECT, "없음"), "PANE_MISSING");
    } finally {
      repository.close();
    }
  });
});

const NOW = "2026-10-16T00:00:00.000Z";

function legacyLayout(): LayoutNode {
  return {
    type: "split",
    id: SPLIT_ROOT,
    direction: "vertical",
    ratio: 0.7,
    first: {
      type: "split",
      id: SPLIT_TOP,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: CLAUDE, collapsed: false },
      second: { type: "pane", paneId: CODEX, collapsed: true },
    },
    second: {
      type: "split",
      id: SPLIT_BOTTOM,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: PROCESS_TERMINAL, collapsed: true },
      second: { type: "pane", paneId: TERMINAL, collapsed: false },
    },
  };
}

function seedProjectRow(database: Database.Database): void {
  database
    .prepare(
      `INSERT INTO project_groups (id, name, kind, created_at, updated_at)
       VALUES (?, 'fixture', 'standalone', ?, ?)`,
    )
    .run(PROJECT, NOW, NOW);
  database
    .prepare(
      `INSERT INTO projects (id, name, real_path, group_id, created_at, updated_at)
       VALUES (?, 'fixture', '/tmp/naru-views-fixture', ?, ?, ?)`,
    )
    .run(PROJECT, PROJECT, NOW, NOW);
}

function seedVersion20Project(database: Database.Database): void {
  seedProjectRow(database);
  const pane = database.prepare(
    `INSERT INTO panes
      (id, project_id, kind, title, launch_profile, status, activity_updated_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'stopped', ?, ?, ?)`,
  );
  pane.run(CLAUDE, PROJECT, "claude", "Claude Code 1", "claude-code", NOW, NOW, NOW);
  pane.run(CODEX, PROJECT, "codex", "Main Codex", "codex-main", NOW, NOW, NOW);
  // An agent's dev server terminal is a shell too, created before the person's terminal.
  pane.run(PROCESS_TERMINAL, PROJECT, "terminal", "dev · agent", "shell", NOW, NOW, NOW);
  pane.run(TERMINAL, PROJECT, "terminal", "Dev Terminal", "shell", NOW, NOW, NOW);
  database
    .prepare(
      `INSERT INTO agent_shared_processes
        (id, project_id, purpose, command, ports_json, keep, pane_id, status, created_at, updated_at)
       VALUES (?, ?, 'dev', 'pnpm dev', '[]', 'run', ?, 'running', ?, ?)`,
    )
    .run("41111111-1111-4111-8111-111111111111", PROJECT, PROCESS_TERMINAL, NOW, NOW);
  database
    .prepare(
      `INSERT INTO workspaces (project_id, schema_version, version, layout_json, active_pane_id, updated_at)
       VALUES (?, ?, 7, ?, ?, ?)`,
    )
    .run(PROJECT, LAYOUT_SCHEMA_VERSION, JSON.stringify(legacyLayout()), CODEX, NOW);
}

function collapsedIn(layout: Workspace["layout"], paneId: string): boolean {
  if (layout === null) return false;
  if (layout.type === "pane") return layout.paneId === paneId && layout.collapsed;
  return collapsedIn(layout.first, paneId) || collapsedIn(layout.second, paneId);
}

function expectAppError(action: () => unknown, code: string): void {
  expect(action).toThrowError(expect.objectContaining({ code }));
}

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), "naru-views-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "naru.sqlite");
}
