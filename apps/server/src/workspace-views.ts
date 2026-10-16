import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import {
  WORKSPACE_VIEW_LAYOUT_SCHEMA_VERSION,
  WorkspaceViewLayoutNodeSchema,
  type WorkspaceView,
  type WorkspaceViewLayoutNode,
} from "@naru/contracts";
import {
  defaultViewLayout,
  firstViewPaneId,
  migrateLayout,
  viewContainsPane,
  viewFromProjectLayout,
} from "@naru/domain";
import type { DatabaseMigration } from "./database.js";

/** The names AP-D029 gives the two workspaces every existing project starts with. */
export const EXISTING_LAYOUT_VIEW_NAME = "내 배치";
export const DEFAULT_VIEW_NAME = "기본";

interface WorkspaceViewRow {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  position: number;
  schema_version: number;
  layout_json: string | null;
  active_pane_id: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}

/** The Panes a default workspace can use; agent and shared-process Panes never qualify. */
export interface DefaultViewCandidate {
  readonly id: string;
  readonly kind: string;
  readonly launchProfile: string;
}

/**
 * v21 (AP-D031): workspaces as named arrangements of a project's Panes, and the person's own Pane
 * names. Every existing project keeps what it shows now as "내 배치" and gains "기본"; no Pane is
 * created, started or changed.
 */
export const WORKSPACE_VIEWS_MIGRATION: DatabaseMigration = {
  version: 21,
  migrate(database) {
    database.exec(`
      CREATE TABLE workspace_views (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        schema_version INTEGER NOT NULL CHECK (schema_version > 0),
        layout_json TEXT,
        active_pane_id TEXT,
        version INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX workspace_views_project ON workspace_views(project_id, position);

      ALTER TABLE panes ADD COLUMN custom_title TEXT;
    `);

    const store = new WorkspaceViewStore(database);
    const now = new Date().toISOString();
    const projects = database
      .prepare(
        `SELECT w.project_id, w.schema_version, w.layout_json, w.active_pane_id
           FROM workspaces w JOIN projects p ON p.id = w.project_id
          ORDER BY p.created_at, p.id`,
      )
      .all() as Array<{
      project_id: string;
      schema_version: number;
      layout_json: string | null;
      active_pane_id: string | null;
    }>;
    for (const project of projects) {
      const shown = viewFromProjectLayout(
        project.layout_json === null
          ? null
          : migrateLayout(JSON.parse(project.layout_json) as unknown, project.schema_version),
      );
      const active =
        project.active_pane_id !== null && viewContainsPane(shown, project.active_pane_id)
          ? project.active_pane_id
          : firstViewPaneId(shown);
      store.insert({
        projectId: project.project_id,
        name: EXISTING_LAYOUT_VIEW_NAME,
        layout: shown,
        activePaneId: active,
        now,
      });
      store.insertDefault(project.project_id, store.defaultCandidates(project.project_id), now);
    }
  },
};

/** SQL mapping for `workspace_views`. Callers validate layouts against the project's Panes. */
export class WorkspaceViewStore {
  readonly #database: Database.Database;

  constructor(database: Database.Database) {
    this.#database = database;
  }

  list(projectId: string): WorkspaceView[] {
    return (
      this.#database
        .prepare(
          "SELECT * FROM workspace_views WHERE project_id = ? ORDER BY position, created_at, id",
        )
        .all(projectId) as WorkspaceViewRow[]
    ).map(mapView);
  }

  get(projectId: string, viewId: string): WorkspaceView | undefined {
    const row = this.#database
      .prepare("SELECT * FROM workspace_views WHERE project_id = ? AND id = ?")
      .get(projectId, viewId) as WorkspaceViewRow | undefined;
    return row === undefined ? undefined : mapView(row);
  }

  count(projectId: string): number {
    return this.#database
      .prepare("SELECT COUNT(*) FROM workspace_views WHERE project_id = ?")
      .pluck()
      .get(projectId) as number;
  }

  insert(input: {
    readonly projectId: string;
    readonly name: string;
    readonly layout: WorkspaceViewLayoutNode | null;
    readonly activePaneId: string | null;
    readonly now: string;
  }): string {
    const id = randomUUID();
    const position = this.#database
      .prepare("SELECT COALESCE(MAX(position) + 1, 0) FROM workspace_views WHERE project_id = ?")
      .pluck()
      .get(input.projectId) as number;
    this.#database
      .prepare(
        `INSERT INTO workspace_views
          (id, project_id, kind, name, position, schema_version, layout_json, active_pane_id,
           version, created_at, updated_at)
         VALUES (?, ?, 'user', ?, ?, ?, ?, ?, 0, ?, ?)`,
      )
      .run(
        id,
        input.projectId,
        input.name,
        position,
        WORKSPACE_VIEW_LAYOUT_SCHEMA_VERSION,
        input.layout === null ? null : JSON.stringify(input.layout),
        input.activePaneId,
        input.now,
        input.now,
      );
    return id;
  }

  /** The default workspace (AP-D027) over the project's own Panes, with places for missing ones. */
  insertDefault(
    projectId: string,
    candidates: readonly DefaultViewCandidate[],
    now: string,
  ): string {
    const first = (kind: string, launchProfile: string) =>
      candidates.find((pane) => pane.kind === kind && pane.launchProfile === launchProfile)?.id ??
      null;
    const layout = defaultViewLayout({
      claude: first("claude", "claude-code"),
      codex: first("codex", "codex-main"),
      terminal: first("terminal", "shell"),
    });
    return this.insert({
      projectId,
      name: DEFAULT_VIEW_NAME,
      layout,
      activePaneId: firstViewPaneId(layout),
      now,
    });
  }

  /** The project's Panes in creation order, without agents' shared-process terminals. */
  defaultCandidates(projectId: string): DefaultViewCandidate[] {
    return this.#database
      .prepare(
        `SELECT id, kind, launch_profile AS launchProfile FROM panes
          WHERE project_id = ?
            AND id NOT IN (
              SELECT pane_id FROM agent_shared_processes WHERE pane_id IS NOT NULL
            )
          ORDER BY created_at, rowid`,
      )
      .all(projectId) as DefaultViewCandidate[];
  }

  /** Writes a new state if the stored version still matches; false when someone changed it. */
  update(
    projectId: string,
    viewId: string,
    expectedVersion: number,
    next: {
      readonly name: string;
      readonly layout: WorkspaceViewLayoutNode | null;
      readonly activePaneId: string | null;
    },
    now: string,
  ): boolean {
    return (
      this.#database
        .prepare(
          `UPDATE workspace_views
              SET name = ?, schema_version = ?, layout_json = ?, active_pane_id = ?,
                  version = version + 1, updated_at = ?
            WHERE project_id = ? AND id = ? AND version = ?`,
        )
        .run(
          next.name,
          WORKSPACE_VIEW_LAYOUT_SCHEMA_VERSION,
          next.layout === null ? null : JSON.stringify(next.layout),
          next.activePaneId,
          now,
          projectId,
          viewId,
          expectedVersion,
        ).changes === 1
    );
  }

  delete(projectId: string, viewId: string, expectedVersion: number): boolean {
    return (
      this.#database
        .prepare("DELETE FROM workspace_views WHERE project_id = ? AND id = ? AND version = ?")
        .run(projectId, viewId, expectedVersion).changes === 1
    );
  }
}

function mapView(row: WorkspaceViewRow): WorkspaceView {
  if (row.kind !== "user") throw new Error(`Unknown workspace kind ${row.kind}.`);
  if (row.schema_version !== WORKSPACE_VIEW_LAYOUT_SCHEMA_VERSION) {
    throw new Error(`Unsupported workspace layout schema version ${row.schema_version}.`);
  }
  return {
    id: row.id,
    kind: "user",
    name: row.name,
    layout:
      row.layout_json === null
        ? null
        : WorkspaceViewLayoutNodeSchema.parse(JSON.parse(row.layout_json) as unknown),
    activePaneId: row.active_pane_id,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
