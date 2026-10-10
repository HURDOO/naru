import { existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import type {
  CreatePaneRequest,
  ErrorCode,
  LayoutNode,
  Pane,
  PaneActivityState,
  PaneKind,
  PaneStatus,
  PaneViewState,
  Passkey,
  Project,
  ProjectActivity,
  CreatePushSubscriptionRequest,
  NaruPushSubscription,
  PushNotificationPayload,
  SaveWorkspaceRequest,
  UpdatePaneViewStateRequest,
  Workspace,
} from "@naru/contracts";
import {
  ClaudeSessionIdSchema,
  CodexSessionIdSchema,
  LAYOUT_SCHEMA_VERSION,
  PaneViewStateSchema,
  PUSH_INACTIVITY_DELAY_MINUTES,
} from "@naru/contracts";
import type { DurableSessionErrorCode, SessionView } from "@naru/contracts/durable-session/v0";
import { migrateLayout, removePane, splitPane, validateLayout } from "@naru/domain";
import { AppError } from "./errors.js";
import { createPreMigrationBackupIfNeeded } from "./database-backup.js";

interface ProjectRow {
  id: string;
  name: string;
  real_path: string;
  group_id: string | null;
  created_at: string;
  updated_at: string;
}

interface ProjectGroupRow {
  id: string;
  name: string;
  kind: "standalone" | "git";
  git_common_dir: string | null;
  git_relative_path: string | null;
  created_at: string;
  updated_at: string;
}

export interface StoredProjectGroup {
  id: string;
  name: string;
  kind: "standalone" | "git";
  gitCommonDirectory: string | null;
  gitRelativePath: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredProjectTarget extends Project {
  groupId: string;
}

interface WorkspaceRow {
  project_id: string;
  schema_version: number;
  version: number;
  layout_json: string | null;
  active_pane_id: string | null;
  updated_at: string;
}

interface PaneRow {
  id: string;
  project_id: string;
  kind: PaneKind;
  title: string;
  launch_profile: string;
  status: PaneStatus;
  exit_code: number | null;
  codex_session_id: string | null;
  codex_session_resumable: 0 | 1;
  claude_session_id: string | null;
  last_error_code: ErrorCode | null;
  last_exited_at: string | null;
  activity_state: PaneActivityState;
  activity_event_id: string | null;
  activity_runtime_id: string | null;
  activity_revision: number;
  activity_updated_at: string;
  view_state_json: string;
  created_at: string;
  updated_at: string;
}

export type PaneSessionOperation = "create" | "start" | "stop" | "forget";
export type PaneSessionLinkState = "pending" | "linked" | "missing";

interface PaneSessionLinkRow {
  pane_id: string;
  session_id: string | null;
  state: PaneSessionLinkState;
  pending_operation: PaneSessionOperation | null;
  operation_key: string | null;
  expected_session_revision: number | null;
  expected_runtime_id: string | null;
  last_error_code: DurableSessionErrorCode | null;
  integration_binding_id: string | null;
  integration_launch_runtime_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaneSessionLink {
  readonly paneId: string;
  readonly sessionId: string | null;
  readonly state: PaneSessionLinkState;
  readonly pendingOperation: PaneSessionOperation | null;
  readonly operationKey: string | null;
  readonly expectedSessionRevision: number | null;
  readonly expectedRuntimeId: string | null;
  readonly lastErrorCode: DurableSessionErrorCode | null;
  readonly integrationBindingId: string | null;
  readonly integrationLaunchRuntimeId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface NaruRepositoryOptions {
  readonly sessionOwner?: "legacy" | "durable-host";
  readonly defaultAgentPaneKind?: "codex" | "claude";
}

interface PasskeyRow {
  id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports_json: string;
  device_type: Passkey["deviceType"];
  backed_up: 0 | 1;
  name: string;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  endpoint_fingerprint: string;
  p256dh: string;
  auth: string;
  name: string;
  expiration_time: number | null;
  created_at: string;
  updated_at: string;
}

export interface PushSubscriptionDeliveryRecord extends NaruPushSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PasskeyCredentialRecord extends Passkey {
  credentialId: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
}

export interface PaneContext {
  pane: Pane;
  projectPath: string;
}

export interface PaneActivityChange {
  readonly eventId: string;
  readonly projectId: string;
  readonly paneId: string;
  readonly runtimeId: string | null;
  readonly activity: Pane["activity"];
  readonly projectActivity: ProjectActivity;
}

export interface DatabaseMigration {
  readonly version: number;
  readonly migrate: (database: Database.Database) => void;
}

export const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    version: 1,
    migrate(database) {
      database.exec(`
        CREATE TABLE projects (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          real_path TEXT NOT NULL UNIQUE,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE workspaces (
          project_id TEXT PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
          version INTEGER NOT NULL DEFAULT 0,
          layout_json TEXT,
          active_pane_id TEXT,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE panes (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'codex')),
          title TEXT NOT NULL,
          launch_profile TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'exited', 'error')),
          exit_code INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE INDEX panes_project_id ON panes(project_id);
      `);
    },
  },
  {
    version: 2,
    migrate(database) {
      database.exec(
        `ALTER TABLE workspaces
         ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1 CHECK (schema_version > 0)`,
      );
    },
  },
  {
    version: 3,
    migrate(database) {
      database.exec(`
        ALTER TABLE panes ADD COLUMN codex_session_id TEXT;
        ALTER TABLE panes ADD COLUMN last_error_code TEXT;
        ALTER TABLE panes ADD COLUMN last_exited_at TEXT;
      `);
    },
  },
  {
    version: 4,
    migrate(database) {
      database.exec(`
        CREATE TABLE passkey_user (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          webauthn_user_id BLOB NOT NULL UNIQUE CHECK (length(webauthn_user_id) = 32),
          created_at TEXT NOT NULL
        );

        CREATE TABLE passkeys (
          id TEXT PRIMARY KEY,
          credential_id TEXT NOT NULL UNIQUE,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL CHECK (counter >= 0),
          transports_json TEXT NOT NULL,
          device_type TEXT NOT NULL CHECK (device_type IN ('singleDevice', 'multiDevice')),
          backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          last_used_at TEXT
        );
      `);
    },
  },
  {
    version: 5,
    migrate(database) {
      database.exec(`
        ALTER TABLE panes
        ADD COLUMN codex_session_resumable INTEGER NOT NULL DEFAULT 0
          CHECK (codex_session_resumable IN (0, 1));
      `);
    },
  },
  {
    version: 6,
    migrate(database) {
      database.exec(`
        CREATE TABLE panes_v6 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'codex', 'docs', 'tasks')),
          title TEXT NOT NULL,
          launch_profile TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'exited', 'error', 'ready')),
          exit_code INTEGER,
          codex_session_id TEXT,
          codex_session_resumable INTEGER NOT NULL DEFAULT 0
            CHECK (codex_session_resumable IN (0, 1)),
          last_error_code TEXT,
          last_exited_at TEXT,
          view_state_json TEXT NOT NULL
            DEFAULT '{"selectedDocumentPath":null,"navigationOpen":true}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO panes_v6
          (id, project_id, kind, title, launch_profile, status, exit_code,
           codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
           view_state_json, created_at, updated_at)
        SELECT id, project_id, kind, title, launch_profile, status, exit_code,
               codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
               '{"selectedDocumentPath":null,"navigationOpen":true}', created_at, updated_at
        FROM panes
        ORDER BY rowid;

        DROP TABLE panes;
        ALTER TABLE panes_v6 RENAME TO panes;
        CREATE INDEX panes_project_id ON panes(project_id);
      `);
    },
  },
  {
    version: 7,
    migrate(database) {
      database.exec(`
        ALTER TABLE panes
        ADD COLUMN activity_state TEXT NOT NULL DEFAULT 'idle'
          CHECK (activity_state IN ('idle', 'running', 'interaction-required', 'completed', 'failed'));
        ALTER TABLE panes ADD COLUMN activity_event_id TEXT;
        ALTER TABLE panes ADD COLUMN activity_updated_at TEXT;
        UPDATE panes SET activity_updated_at = updated_at;
      `);

      const workspaces = database
        .prepare("SELECT project_id, schema_version, layout_json FROM workspaces")
        .all() as Array<Pick<WorkspaceRow, "project_id" | "schema_version" | "layout_json">>;
      const update = database.prepare(
        "UPDATE workspaces SET schema_version = ?, layout_json = ? WHERE project_id = ?",
      );
      for (const workspace of workspaces) {
        if (workspace.schema_version === LAYOUT_SCHEMA_VERSION) continue;
        const layout =
          workspace.layout_json === null
            ? null
            : migrateLayout(JSON.parse(workspace.layout_json) as unknown, workspace.schema_version);
        update.run(
          LAYOUT_SCHEMA_VERSION,
          layout === null ? null : JSON.stringify(layout),
          workspace.project_id,
        );
      }
    },
  },
  {
    version: 8,
    migrate(database) {
      database.exec(`
        CREATE TABLE push_subscriptions (
          id TEXT PRIMARY KEY,
          endpoint TEXT NOT NULL UNIQUE,
          endpoint_fingerprint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          name TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 64),
          expiration_time INTEGER,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE push_deliveries (
          subscription_id TEXT NOT NULL REFERENCES push_subscriptions(id) ON DELETE CASCADE,
          event_id TEXT NOT NULL,
          project_id TEXT NOT NULL,
          pane_id TEXT NOT NULL,
          runtime_id TEXT NOT NULL,
          event_kind TEXT NOT NULL
            CHECK (event_kind IN ('completed', 'interaction-required', 'failed')),
          attempted_at TEXT NOT NULL,
          delivered_at TEXT,
          PRIMARY KEY (subscription_id, event_id)
        );
        CREATE INDEX push_deliveries_attempted_at ON push_deliveries(attempted_at);
      `);
    },
  },
  {
    version: 9,
    migrate(database) {
      database.exec(`
        CREATE TABLE push_preferences (
          singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
          inactivity_delay_minutes INTEGER NOT NULL
            CHECK (inactivity_delay_minutes BETWEEN ${PUSH_INACTIVITY_DELAY_MINUTES.min}
              AND ${PUSH_INACTIVITY_DELAY_MINUTES.max})
        );

        INSERT INTO push_preferences (singleton, inactivity_delay_minutes)
        VALUES (1, ${PUSH_INACTIVITY_DELAY_MINUTES.default});
      `);
    },
  },
  {
    version: 10,
    migrate(database) {
      database.exec(`
        CREATE TABLE project_groups (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('standalone', 'git')),
          git_common_dir TEXT,
          git_relative_path TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (kind = 'standalone' AND git_common_dir IS NULL AND git_relative_path IS NULL)
            OR
            (kind = 'git' AND git_common_dir IS NOT NULL AND git_relative_path IS NOT NULL)
          )
        );

        CREATE UNIQUE INDEX project_groups_git_identity
        ON project_groups(git_common_dir, git_relative_path)
        WHERE kind = 'git';

        INSERT INTO project_groups
          (id, name, kind, git_common_dir, git_relative_path, created_at, updated_at)
        SELECT id, name, 'standalone', NULL, NULL, created_at, updated_at
        FROM projects
        ORDER BY created_at, id;

        ALTER TABLE projects
        ADD COLUMN group_id TEXT REFERENCES project_groups(id) ON DELETE RESTRICT;
        UPDATE projects SET group_id = id;
        CREATE INDEX projects_group_id ON projects(group_id);

        CREATE TRIGGER projects_group_id_required_insert
        BEFORE INSERT ON projects
        WHEN NEW.group_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'projects.group_id is required');
        END;

        CREATE TRIGGER projects_group_id_required_update
        BEFORE UPDATE OF group_id ON projects
        WHEN NEW.group_id IS NULL
        BEGIN
          SELECT RAISE(ABORT, 'projects.group_id is required');
        END;
      `);
    },
  },
  {
    version: 11,
    migrate(database) {
      database.exec(`
        CREATE TABLE panes_v11 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'codex', 'docs', 'tasks')),
          title TEXT NOT NULL,
          launch_profile TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'exited', 'error', 'ready')),
          exit_code INTEGER,
          codex_session_id TEXT,
          codex_session_resumable INTEGER NOT NULL DEFAULT 0
            CHECK (codex_session_resumable IN (0, 1)),
          last_error_code TEXT,
          last_exited_at TEXT,
          activity_state TEXT NOT NULL DEFAULT 'idle'
            CHECK (activity_state IN (
              'idle', 'running', 'interaction-required', 'completed', 'canceled',
              'server-stopped', 'failed'
            )),
          activity_event_id TEXT,
          activity_updated_at TEXT,
          view_state_json TEXT NOT NULL
            DEFAULT '{"selectedDocumentPath":null,"navigationOpen":true}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO panes_v11
          (id, project_id, kind, title, launch_profile, status, exit_code,
           codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
           activity_state, activity_event_id, activity_updated_at, view_state_json,
           created_at, updated_at)
        SELECT id, project_id, kind, title, launch_profile, status, exit_code,
               codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
               activity_state, activity_event_id, activity_updated_at, view_state_json,
               created_at, updated_at
        FROM panes
        ORDER BY rowid;

        DROP TABLE panes;
        ALTER TABLE panes_v11 RENAME TO panes;
        CREATE INDEX panes_project_id ON panes(project_id);
      `);
    },
  },
  {
    version: 12,
    migrate(database) {
      database.exec(`
        CREATE TABLE panes_v12 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'codex', 'files', 'docs', 'tasks')),
          title TEXT NOT NULL,
          launch_profile TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'exited', 'error', 'ready')),
          exit_code INTEGER,
          codex_session_id TEXT,
          codex_session_resumable INTEGER NOT NULL DEFAULT 0
            CHECK (codex_session_resumable IN (0, 1)),
          last_error_code TEXT,
          last_exited_at TEXT,
          activity_state TEXT NOT NULL DEFAULT 'idle'
            CHECK (activity_state IN (
              'idle', 'running', 'interaction-required', 'completed', 'canceled',
              'server-stopped', 'failed'
            )),
          activity_event_id TEXT,
          activity_updated_at TEXT,
          view_state_json TEXT NOT NULL
            DEFAULT '{"selectedDocumentPath":null,"navigationOpen":true,"expandedDirectories":[]}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        INSERT INTO panes_v12
          (id, project_id, kind, title, launch_profile, status, exit_code,
           codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
           activity_state, activity_event_id, activity_updated_at, view_state_json,
           created_at, updated_at)
        SELECT id, project_id, kind, title, launch_profile, status, exit_code,
               codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
               activity_state, activity_event_id, activity_updated_at, view_state_json,
               created_at, updated_at
        FROM panes
        ORDER BY rowid;

        DROP TABLE panes;
        ALTER TABLE panes_v12 RENAME TO panes;
        CREATE INDEX panes_project_id ON panes(project_id);
      `);
    },
  },
  {
    version: 13,
    migrate(database) {
      database.exec(`
        ALTER TABLE panes ADD COLUMN activity_runtime_id TEXT;
        ALTER TABLE panes
        ADD COLUMN activity_revision INTEGER NOT NULL DEFAULT 0
          CHECK (activity_revision >= 0);
      `);
    },
  },
  {
    version: 14,
    migrate(database) {
      database.exec(`
        CREATE TABLE pane_session_links (
          pane_id TEXT PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
          session_id TEXT UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'missing')),
          pending_operation TEXT
            CHECK (pending_operation IN ('create', 'start', 'stop', 'forget')),
          operation_key TEXT UNIQUE,
          expected_session_revision INTEGER
            CHECK (expected_session_revision IS NULL OR expected_session_revision >= 0),
          expected_runtime_id TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK (
            (state = 'pending' AND pending_operation IS NOT NULL AND operation_key IS NOT NULL)
            OR (
              state IN ('linked', 'missing') AND pending_operation IS NULL
              AND operation_key IS NULL AND expected_session_revision IS NULL
              AND expected_runtime_id IS NULL
            )
          ),
          CHECK (pending_operation = 'create' OR session_id IS NOT NULL),
          CHECK (
            (pending_operation = 'create' AND expected_session_revision IS NULL
              AND expected_runtime_id IS NULL)
            OR (pending_operation = 'start' AND expected_session_revision IS NOT NULL
              AND expected_runtime_id IS NULL)
            OR (pending_operation = 'stop' AND expected_session_revision IS NOT NULL
              AND expected_runtime_id IS NOT NULL)
            OR (pending_operation = 'forget' AND expected_session_revision IS NOT NULL
              AND expected_runtime_id IS NULL)
            OR pending_operation IS NULL
          ),
          CHECK (state != 'linked' OR session_id IS NOT NULL)
        );

        CREATE INDEX pane_session_links_state ON pane_session_links(state);
      `);
    },
  },
  {
    version: 15,
    migrate(database) {
      database.exec(`
        ALTER TABLE pane_session_links ADD COLUMN integration_binding_id TEXT;
        CREATE UNIQUE INDEX pane_session_links_integration_binding
          ON pane_session_links(integration_binding_id)
          WHERE integration_binding_id IS NOT NULL;
      `);
    },
  },
  {
    version: 16,
    migrate(database) {
      database.exec(`
        ALTER TABLE pane_session_links ADD COLUMN integration_launch_runtime_id TEXT;
      `);
    },
  },
  {
    version: 17,
    migrate(database) {
      database.exec(`
        CREATE TEMP TABLE retained_pane_session_links AS SELECT * FROM pane_session_links;
        DROP TABLE pane_session_links;
        CREATE TABLE panes_v17 (
          id TEXT PRIMARY KEY,
          project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('terminal', 'codex', 'claude', 'files', 'docs', 'tasks')),
          title TEXT NOT NULL,
          launch_profile TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('stopped', 'running', 'exited', 'error', 'ready')),
          exit_code INTEGER,
          codex_session_id TEXT,
          codex_session_resumable INTEGER NOT NULL DEFAULT 0
            CHECK (codex_session_resumable IN (0, 1)),
          last_error_code TEXT,
          last_exited_at TEXT,
          activity_state TEXT NOT NULL DEFAULT 'idle'
            CHECK (activity_state IN (
              'idle', 'running', 'interaction-required', 'completed', 'canceled',
              'server-stopped', 'failed'
            )),
          activity_event_id TEXT,
          activity_updated_at TEXT,
          view_state_json TEXT NOT NULL
            DEFAULT '{"selectedDocumentPath":null,"navigationOpen":true,"expandedDirectories":[]}',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          activity_runtime_id TEXT,
          activity_revision INTEGER NOT NULL DEFAULT 0 CHECK (activity_revision >= 0)
        );
        INSERT INTO panes_v17 SELECT * FROM panes ORDER BY rowid;
        DROP TABLE panes;
        ALTER TABLE panes_v17 RENAME TO panes;
        CREATE INDEX panes_project_id ON panes(project_id);
        CREATE TABLE pane_session_links (
          pane_id TEXT PRIMARY KEY REFERENCES panes(id) ON DELETE CASCADE,
          session_id TEXT UNIQUE,
          state TEXT NOT NULL CHECK (state IN ('pending', 'linked', 'missing')),
          pending_operation TEXT CHECK (pending_operation IN ('create', 'start', 'stop', 'forget')),
          operation_key TEXT UNIQUE,
          expected_session_revision INTEGER
            CHECK (expected_session_revision IS NULL OR expected_session_revision >= 0),
          expected_runtime_id TEXT,
          last_error_code TEXT,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          integration_binding_id TEXT,
          integration_launch_runtime_id TEXT,
          CHECK (
            (state = 'pending' AND pending_operation IS NOT NULL AND operation_key IS NOT NULL)
            OR (state IN ('linked', 'missing') AND pending_operation IS NULL
              AND operation_key IS NULL AND expected_session_revision IS NULL
              AND expected_runtime_id IS NULL)
          ),
          CHECK (pending_operation = 'create' OR session_id IS NOT NULL),
          CHECK (
            (pending_operation = 'create' AND expected_session_revision IS NULL
              AND expected_runtime_id IS NULL)
            OR (pending_operation = 'start' AND expected_session_revision IS NOT NULL
              AND expected_runtime_id IS NULL)
            OR (pending_operation = 'stop' AND expected_session_revision IS NOT NULL
              AND expected_runtime_id IS NOT NULL)
            OR (pending_operation = 'forget' AND expected_session_revision IS NOT NULL
              AND expected_runtime_id IS NULL)
            OR pending_operation IS NULL
          ),
          CHECK (state != 'linked' OR session_id IS NOT NULL)
        );
        INSERT INTO pane_session_links SELECT * FROM retained_pane_session_links;
        DROP TABLE retained_pane_session_links;
        CREATE INDEX pane_session_links_state ON pane_session_links(state);
        CREATE UNIQUE INDEX pane_session_links_integration_binding
          ON pane_session_links(integration_binding_id)
          WHERE integration_binding_id IS NOT NULL;
      `);
    },
  },
  {
    version: 18,
    migrate(database) {
      database.exec(`
        ALTER TABLE panes ADD COLUMN claude_session_id TEXT;
      `);
    },
  },
];

export function runDatabaseMigrations(
  database: Database.Database,
  migrations: readonly DatabaseMigration[] = DATABASE_MIGRATIONS,
): void {
  validateMigrations(migrations);

  database.transaction(() => {
    database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      )
    `);

    const appliedVersions = new Set(
      (
        database.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
          version: number;
        }>
      ).map(({ version }) => version),
    );
    const newestKnownVersion = migrations.at(-1)?.version ?? 0;
    const unknownVersion = [...appliedVersions].find((version) => version > newestKnownVersion);
    if (unknownVersion !== undefined) {
      throw new Error(`Database schema version ${unknownVersion} is newer than this build.`);
    }

    for (const migration of migrations) {
      if (appliedVersions.has(migration.version)) continue;
      migration.migrate(database);
      database
        .prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
    }
  })();
}

export class NaruRepository {
  readonly #database: Database.Database;
  readonly #defaultAgentPaneKind: "codex" | "claude";

  constructor(filename: string, options: NaruRepositoryOptions = {}) {
    this.#defaultAgentPaneKind = options.defaultAgentPaneKind ?? "codex";
    const existingDatabase =
      filename !== ":memory:" && existsSync(filename) && statSync(filename).size > 0;
    this.#database = new Database(filename);
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("journal_mode = WAL");
    this.#database.pragma("busy_timeout = 5000");
    if (existingDatabase) {
      createPreMigrationBackupIfNeeded(
        this.#database,
        filename,
        DATABASE_MIGRATIONS.at(-1)?.version ?? 0,
      );
    }
    this.#migrate();
    if ((options.sessionOwner ?? "legacy") === "legacy") this.#markOrphanedPanesServerStopped();
  }

  static openDataDirectory(
    dataDirectory: string,
    options: NaruRepositoryOptions = {},
  ): NaruRepository {
    mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
    return new NaruRepository(join(dataDirectory, "naru.sqlite"), options);
  }

  close(): void {
    this.#database.close();
  }

  isReady(): boolean {
    try {
      const databaseResponded = this.#database.prepare("SELECT 1").pluck().get() === 1;
      const currentVersion = this.#database
        .prepare("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
        .pluck()
        .get() as number;
      return databaseResponded && currentVersion === (DATABASE_MIGRATIONS.at(-1)?.version ?? 0);
    } catch {
      return false;
    }
  }

  getOrCreatePasskeyUserId(): Uint8Array<ArrayBuffer> {
    return this.#database
      .transaction(() => {
        const existing = this.#database
          .prepare("SELECT webauthn_user_id FROM passkey_user WHERE singleton = 1")
          .pluck()
          .get() as Buffer | undefined;
        if (existing !== undefined) return Uint8Array.from(existing);

        const userId = randomBytes(32);
        this.#database
          .prepare(
            "INSERT INTO passkey_user (singleton, webauthn_user_id, created_at) VALUES (1, ?, ?)",
          )
          .run(userId, new Date().toISOString());
        return Uint8Array.from(userId);
      })
      .immediate();
  }

  listPasskeys(): Passkey[] {
    return (
      this.#database.prepare("SELECT * FROM passkeys ORDER BY created_at, id").all() as PasskeyRow[]
    ).map(mapPasskey);
  }

  listPasskeyCredentials(): PasskeyCredentialRecord[] {
    return (
      this.#database.prepare("SELECT * FROM passkeys ORDER BY created_at, id").all() as PasskeyRow[]
    ).map(mapPasskeyCredential);
  }

  getPasskeyByCredentialId(credentialId: string): PasskeyCredentialRecord | undefined {
    const row = this.#database
      .prepare("SELECT * FROM passkeys WHERE credential_id = ?")
      .get(credentialId) as PasskeyRow | undefined;
    return row === undefined ? undefined : mapPasskeyCredential(row);
  }

  createPasskey(input: {
    name: string;
    credentialId: string;
    publicKey: Uint8Array;
    counter: number;
    transports: readonly string[];
    deviceType: Passkey["deviceType"];
    backedUp: boolean;
  }): Passkey {
    const now = new Date().toISOString();
    const id = randomUUID();
    try {
      this.#database
        .prepare(
          `INSERT INTO passkeys
            (id, credential_id, public_key, counter, transports_json, device_type, backed_up,
             name, created_at, updated_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .run(
          id,
          input.credentialId,
          Buffer.from(input.publicKey),
          input.counter,
          JSON.stringify(input.transports),
          input.deviceType,
          input.backedUp ? 1 : 0,
          input.name,
          now,
          now,
        );
    } catch (error) {
      if (isUniqueConstraint(error, "passkeys.credential_id")) {
        throw new AppError("PASSKEY_DUPLICATE", 409, "이미 등록된 패스키입니다.");
      }
      throw error;
    }
    return mapPasskey(
      this.#database.prepare("SELECT * FROM passkeys WHERE id = ?").get(id) as PasskeyRow,
    );
  }

  updatePasskeyAfterAuthentication(
    id: string,
    counter: number,
    deviceType: Passkey["deviceType"],
    backedUp: boolean,
  ): boolean {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE passkeys
         SET counter = MAX(counter, ?), device_type = ?, backed_up = ?,
             last_used_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(counter, deviceType, backedUp ? 1 : 0, now, now, id);
    return result.changes > 0;
  }

  updatePasskeyName(id: string, name: string): Passkey {
    const result = this.#database
      .prepare("UPDATE passkeys SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new AppError("PASSKEY_MISSING", 404, "패스키를 찾을 수 없습니다.");
    }
    return mapPasskey(
      this.#database.prepare("SELECT * FROM passkeys WHERE id = ?").get(id) as PasskeyRow,
    );
  }

  deletePasskey(id: string): boolean {
    return this.#database.prepare("DELETE FROM passkeys WHERE id = ?").run(id).changes > 0;
  }

  listPushSubscriptions(): NaruPushSubscription[] {
    this.#deleteExpiredPushSubscriptions();
    return (
      this.#database
        .prepare("SELECT * FROM push_subscriptions ORDER BY created_at, id")
        .all() as PushSubscriptionRow[]
    ).map(mapPushSubscription);
  }

  getPushInactivityDelayMinutes(): number {
    return this.#database
      .prepare("SELECT inactivity_delay_minutes FROM push_preferences WHERE singleton = 1")
      .pluck()
      .get() as number;
  }

  updatePushInactivityDelayMinutes(inactivityDelayMinutes: number): number {
    this.#database
      .prepare("UPDATE push_preferences SET inactivity_delay_minutes = ? WHERE singleton = 1")
      .run(inactivityDelayMinutes);
    return this.getPushInactivityDelayMinutes();
  }

  listActivePushSubscriptionRecords(): PushSubscriptionDeliveryRecord[] {
    this.#deleteExpiredPushSubscriptions();
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1_000).toISOString();
    this.#database.prepare("DELETE FROM push_deliveries WHERE attempted_at < ?").run(cutoff);
    return (
      this.#database
        .prepare("SELECT * FROM push_subscriptions ORDER BY created_at, id")
        .all() as PushSubscriptionRow[]
    ).map(mapPushSubscriptionDeliveryRecord);
  }

  upsertPushSubscription(input: CreatePushSubscriptionRequest): NaruPushSubscription {
    return this.#database
      .transaction(() => {
        this.#deleteExpiredPushSubscriptions();
        const existing = this.#database
          .prepare("SELECT id, created_at FROM push_subscriptions WHERE endpoint = ?")
          .get(input.endpoint) as Pick<PushSubscriptionRow, "id" | "created_at"> | undefined;
        const count = this.#database
          .prepare("SELECT COUNT(*) FROM push_subscriptions")
          .pluck()
          .get() as number;
        if (existing === undefined && count >= 10) {
          throw new AppError(
            "PUSH_SUBSCRIPTION_LIMIT",
            409,
            "알림 기기는 최대 10개까지 등록할 수 있습니다.",
          );
        }

        const id = existing?.id ?? randomUUID();
        const createdAt = existing?.created_at ?? new Date().toISOString();
        const updatedAt = new Date().toISOString();
        this.#database
          .prepare(
            `INSERT INTO push_subscriptions
              (id, endpoint, endpoint_fingerprint, p256dh, auth, name, expiration_time,
               created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(endpoint) DO UPDATE SET
               endpoint_fingerprint = excluded.endpoint_fingerprint,
               p256dh = excluded.p256dh,
               auth = excluded.auth,
               name = excluded.name,
               expiration_time = excluded.expiration_time,
               updated_at = excluded.updated_at`,
          )
          .run(
            id,
            input.endpoint,
            pushEndpointFingerprint(input.endpoint),
            input.keys.p256dh,
            input.keys.auth,
            input.name,
            input.expirationTime,
            createdAt,
            updatedAt,
          );
        return mapPushSubscription(
          this.#database
            .prepare("SELECT * FROM push_subscriptions WHERE endpoint = ?")
            .get(input.endpoint) as PushSubscriptionRow,
        );
      })
      .immediate();
  }

  updatePushSubscriptionName(id: string, name: string): NaruPushSubscription {
    const result = this.#database
      .prepare("UPDATE push_subscriptions SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, new Date().toISOString(), id);
    if (result.changes === 0) {
      throw new AppError("PUSH_SUBSCRIPTION_MISSING", 404, "알림 기기를 찾을 수 없습니다.");
    }
    return mapPushSubscription(
      this.#database
        .prepare("SELECT * FROM push_subscriptions WHERE id = ?")
        .get(id) as PushSubscriptionRow,
    );
  }

  deletePushSubscription(id: string): boolean {
    return (
      this.#database.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(id).changes > 0
    );
  }

  reservePushDelivery(subscriptionId: string, payload: PushNotificationPayload): boolean {
    const result = this.#database
      .prepare(
        `INSERT OR IGNORE INTO push_deliveries
          (subscription_id, event_id, project_id, pane_id, runtime_id, event_kind,
           attempted_at, delivered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
      )
      .run(
        subscriptionId,
        payload.eventId,
        payload.projectId,
        payload.paneId,
        payload.runtimeId,
        payload.eventKind,
        new Date().toISOString(),
      );
    return result.changes === 1;
  }

  markPushDeliverySent(subscriptionId: string, eventId: string): void {
    this.#database
      .prepare(
        "UPDATE push_deliveries SET delivered_at = ? WHERE subscription_id = ? AND event_id = ?",
      )
      .run(new Date().toISOString(), subscriptionId, eventId);
  }

  listProjects(): Project[] {
    const rows = this.#database
      .prepare("SELECT * FROM projects ORDER BY name COLLATE NOCASE, created_at")
      .all() as ProjectRow[];
    return rows.map((row) => mapProject(row, this.getProjectActivity(row.id)));
  }

  listStoredProjectGroups(): StoredProjectGroup[] {
    return (
      this.#database
        .prepare("SELECT * FROM project_groups ORDER BY name COLLATE NOCASE, created_at, id")
        .all() as ProjectGroupRow[]
    ).map(mapStoredProjectGroup);
  }

  getStoredProjectGroup(groupId: string): StoredProjectGroup | undefined {
    const row = this.#database.prepare("SELECT * FROM project_groups WHERE id = ?").get(groupId) as
      ProjectGroupRow | undefined;
    return row === undefined ? undefined : mapStoredProjectGroup(row);
  }

  findStoredGitProjectGroup(
    commonDirectory: string,
    relativePath: string,
  ): StoredProjectGroup | undefined {
    const row = this.#database
      .prepare(
        `SELECT * FROM project_groups
         WHERE kind = 'git' AND git_common_dir = ? AND git_relative_path = ?`,
      )
      .get(commonDirectory, relativePath) as ProjectGroupRow | undefined;
    return row === undefined ? undefined : mapStoredProjectGroup(row);
  }

  listStoredProjectTargets(): StoredProjectTarget[] {
    const rows = this.#database
      .prepare("SELECT * FROM projects ORDER BY created_at, id")
      .all() as ProjectRow[];
    return rows.map((row) => mapStoredProjectTarget(row, this.getProjectActivity(row.id)));
  }

  getStoredProjectTarget(projectId: string): StoredProjectTarget | undefined {
    const row = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      ProjectRow | undefined;
    return row === undefined
      ? undefined
      : mapStoredProjectTarget(row, this.getProjectActivity(row.id));
  }

  getProject(projectId: string): Project | undefined {
    const row = this.#database.prepare("SELECT * FROM projects WHERE id = ?").get(projectId) as
      ProjectRow | undefined;
    return row === undefined ? undefined : mapProject(row, this.getProjectActivity(row.id));
  }

  createProject(realPath: string, name: string, groupId?: string): Project {
    const now = new Date().toISOString();
    const project: Project = {
      id: randomUUID(),
      name,
      path: realPath,
      activity: idleProjectActivity(),
      createdAt: now,
      updatedAt: now,
    };
    const defaultWorkspace = createDefaultWorkspace(project.id, now, this.#defaultAgentPaneKind);

    const transaction = this.#database.transaction(() => {
      const projectGroupId = groupId ?? project.id;
      if (groupId === undefined) {
        this.#database
          .prepare(
            `INSERT INTO project_groups
              (id, name, kind, git_common_dir, git_relative_path, created_at, updated_at)
             VALUES (?, ?, 'standalone', NULL, NULL, ?, ?)`,
          )
          .run(project.id, project.name, project.createdAt, project.updatedAt);
      } else if (this.getStoredProjectGroup(groupId) === undefined) {
        throw new AppError("PROJECT_GROUP_MISSING", 404, "프로젝트 그룹을 찾을 수 없습니다.");
      }
      this.#database
        .prepare(
          `INSERT INTO projects
            (id, name, real_path, group_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          project.id,
          project.name,
          project.path,
          projectGroupId,
          project.createdAt,
          project.updatedAt,
        );
      for (const pane of defaultWorkspace.panes) this.#insertPane(pane);
      this.#database
        .prepare(
          `INSERT INTO workspaces
            (project_id, schema_version, version, layout_json, active_pane_id, updated_at)
           VALUES (?, ?, 0, ?, ?, ?)`,
        )
        .run(
          project.id,
          LAYOUT_SCHEMA_VERSION,
          JSON.stringify(defaultWorkspace.layout),
          defaultWorkspace.activePaneId,
          now,
        );
    });

    try {
      transaction();
      return this.getProject(project.id) as Project;
    } catch (error) {
      if (isUniqueConstraint(error, "projects.real_path")) {
        throw new AppError("PROJECT_DUPLICATE", 409, "이미 등록된 프로젝트입니다.");
      }
      throw error;
    }
  }

  deleteProject(projectId: string): boolean {
    return this.#database
      .transaction(() => {
        const groupId = this.#database
          .prepare("SELECT group_id FROM projects WHERE id = ?")
          .pluck()
          .get(projectId) as string | undefined;
        if (groupId === undefined) return false;
        const result = this.#database.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
        this.#deleteEmptyProjectGroup(groupId);
        return result.changes > 0;
      })
      .immediate();
  }

  updateProjectName(projectId: string, name: string): Project {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, now, projectId);
    if (result.changes === 0) {
      throw new AppError("PROJECT_MISSING", 404, "프로젝트를 찾을 수 없습니다.");
    }
    return this.getProject(projectId) as Project;
  }

  updateProjectGroupName(groupId: string, name: string): StoredProjectGroup {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare("UPDATE project_groups SET name = ?, updated_at = ? WHERE id = ?")
      .run(name, now, groupId);
    if (result.changes === 0) {
      throw new AppError("PROJECT_GROUP_MISSING", 404, "프로젝트 그룹을 찾을 수 없습니다.");
    }
    return this.getStoredProjectGroup(groupId) as StoredProjectGroup;
  }

  assignProjectToGitGroup(
    projectId: string,
    commonDirectory: string,
    relativePath: string,
  ): StoredProjectGroup {
    return this.#database
      .transaction(() => {
        const target = this.#requiredStoredProjectTarget(projectId);
        const currentGroup = this.#requiredStoredProjectGroup(target.groupId);
        const existing = this.#database
          .prepare(
            `SELECT * FROM project_groups
             WHERE kind = 'git' AND git_common_dir = ? AND git_relative_path = ?`,
          )
          .get(commonDirectory, relativePath) as ProjectGroupRow | undefined;
        const now = new Date().toISOString();
        let destinationId: string;

        if (existing !== undefined) {
          destinationId = existing.id;
        } else if (this.#projectGroupTargetCount(currentGroup.id) === 1) {
          destinationId = currentGroup.id;
          this.#database
            .prepare(
              `UPDATE project_groups
               SET kind = 'git', git_common_dir = ?, git_relative_path = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(commonDirectory, relativePath, now, destinationId);
        } else {
          destinationId = randomUUID();
          this.#database
            .prepare(
              `INSERT INTO project_groups
                (id, name, kind, git_common_dir, git_relative_path, created_at, updated_at)
               VALUES (?, ?, 'git', ?, ?, ?, ?)`,
            )
            .run(destinationId, target.name, commonDirectory, relativePath, now, now);
        }

        if (target.groupId !== destinationId) {
          this.#database
            .prepare("UPDATE projects SET group_id = ?, updated_at = ? WHERE id = ?")
            .run(destinationId, now, projectId);
          this.#database
            .prepare("UPDATE project_groups SET updated_at = ? WHERE id = ?")
            .run(now, destinationId);
          this.#deleteEmptyProjectGroup(target.groupId);
        }
        return this.#requiredStoredProjectGroup(destinationId);
      })
      .immediate();
  }

  assignProjectToStandaloneGroup(projectId: string): StoredProjectGroup {
    return this.#database
      .transaction(() => {
        const target = this.#requiredStoredProjectTarget(projectId);
        const currentGroup = this.#requiredStoredProjectGroup(target.groupId);
        if (currentGroup.kind === "standalone") return currentGroup;
        const now = new Date().toISOString();
        if (this.#projectGroupTargetCount(currentGroup.id) === 1) {
          this.#database
            .prepare(
              `UPDATE project_groups
               SET kind = 'standalone', git_common_dir = NULL, git_relative_path = NULL,
                   updated_at = ?
               WHERE id = ?`,
            )
            .run(now, currentGroup.id);
          return this.#requiredStoredProjectGroup(currentGroup.id);
        }

        const groupId = randomUUID();
        this.#database
          .prepare(
            `INSERT INTO project_groups
              (id, name, kind, git_common_dir, git_relative_path, created_at, updated_at)
             VALUES (?, ?, 'standalone', NULL, NULL, ?, ?)`,
          )
          .run(groupId, target.name, now, now);
        this.#database
          .prepare("UPDATE projects SET group_id = ?, updated_at = ? WHERE id = ?")
          .run(groupId, now, projectId);
        return this.#requiredStoredProjectGroup(groupId);
      })
      .immediate();
  }

  getWorkspace(projectId: string): Workspace {
    const project = this.getProject(projectId);
    if (!project) throw new AppError("PROJECT_MISSING", 404, "프로젝트를 찾을 수 없습니다.");

    const workspace = this.#database
      .prepare("SELECT * FROM workspaces WHERE project_id = ?")
      .get(projectId) as WorkspaceRow;
    const paneRows = this.#database
      .prepare("SELECT * FROM panes WHERE project_id = ? ORDER BY created_at, rowid")
      .all(projectId) as PaneRow[];
    const panes = paneRows.map(mapPane);
    const layout = parseLayout(workspace.layout_json, workspace.schema_version);
    const paneIds = new Set(panes.map((pane) => pane.id));
    validateLayout(layout, paneIds);
    if (workspace.active_pane_id !== null && !paneIds.has(workspace.active_pane_id)) {
      throw new Error(`Workspace references unknown active Pane ${workspace.active_pane_id}.`);
    }

    return {
      projectId,
      schemaVersion: workspace.schema_version,
      version: workspace.version,
      layout,
      activePaneId: workspace.active_pane_id,
      panes,
      updatedAt: workspace.updated_at,
    };
  }

  createPane(projectId: string, input: CreatePaneRequest): Pane {
    return this.#database
      .transaction(() => {
        const workspace = this.getWorkspace(projectId);
        assertWorkspaceVersion(workspace.version, input.workspaceVersion);
        const now = new Date().toISOString();
        const paneNumber = workspace.panes.filter((pane) => pane.kind === input.kind).length + 1;
        const pane = createPaneRecord(
          projectId,
          input.kind,
          input.title ?? defaultPaneTitle(input.kind, paneNumber),
          paneLaunchProfile(input),
          now,
          input.kind === "files" || input.kind === "docs" || input.kind === "tasks"
            ? (input.selectedDocumentPath ?? null)
            : null,
        );
        const layout = splitForNewPane(
          workspace.layout,
          input.targetPaneId,
          pane.id,
          input.direction,
        );
        assertWorkspaceState(
          layout,
          pane.id,
          new Set([...workspace.panes.map((existing) => existing.id), pane.id]),
        );

        this.#insertPane(pane);
        const result = this.#database
          .prepare(
            `UPDATE workspaces
           SET version = version + 1, layout_json = ?, active_pane_id = ?, updated_at = ?
           WHERE project_id = ? AND version = ?`,
          )
          .run(JSON.stringify(layout), pane.id, now, projectId, input.workspaceVersion);
        assertWorkspaceUpdated(result.changes);
        return pane;
      })
      .immediate();
  }

  saveWorkspace(projectId: string, input: SaveWorkspaceRequest): Workspace {
    this.#database
      .transaction(() => {
        const workspace = this.getWorkspace(projectId);
        assertWorkspaceVersion(workspace.version, input.version);
        assertWorkspaceState(
          input.layout,
          input.activePaneId,
          new Set(workspace.panes.map((pane) => pane.id)),
        );
        const now = new Date().toISOString();
        const result = this.#database
          .prepare(
            `UPDATE workspaces
           SET version = version + 1, layout_json = ?, active_pane_id = ?, updated_at = ?
           WHERE project_id = ? AND version = ?`,
          )
          .run(
            input.layout === null ? null : JSON.stringify(input.layout),
            input.activePaneId,
            now,
            projectId,
            input.version,
          );
        assertWorkspaceUpdated(result.changes);
      })
      .immediate();
    return this.getWorkspace(projectId);
  }

  deletePane(paneId: string, workspaceVersion: number): Workspace | undefined {
    const projectId = this.#database
      .transaction(() => {
        const context = this.getPaneContext(paneId);
        if (!context) return undefined;
        const workspace = this.getWorkspace(context.pane.projectId);
        assertWorkspaceVersion(workspace.version, workspaceVersion);
        const layout = removePane(workspace.layout, paneId);
        const nextActivePaneId =
          workspace.activePaneId === paneId ? firstPaneFromLayout(layout) : workspace.activePaneId;
        const remainingPaneIds = new Set(
          workspace.panes.filter((pane) => pane.id !== paneId).map((pane) => pane.id),
        );
        assertWorkspaceState(layout, nextActivePaneId, remainingPaneIds);
        const now = new Date().toISOString();

        this.#database.prepare("DELETE FROM panes WHERE id = ?").run(paneId);
        const result = this.#database
          .prepare(
            `UPDATE workspaces
           SET version = version + 1, layout_json = ?, active_pane_id = ?, updated_at = ?
           WHERE project_id = ? AND version = ?`,
          )
          .run(
            layout === null ? null : JSON.stringify(layout),
            nextActivePaneId,
            now,
            context.pane.projectId,
            workspaceVersion,
          );
        assertWorkspaceUpdated(result.changes);
        return context.pane.projectId;
      })
      .immediate();
    return projectId === undefined ? undefined : this.getWorkspace(projectId);
  }

  getPaneSessionLink(paneId: string): PaneSessionLink | undefined {
    const row = this.#database
      .prepare("SELECT * FROM pane_session_links WHERE pane_id = ?")
      .get(paneId) as PaneSessionLinkRow | undefined;
    return row === undefined ? undefined : mapPaneSessionLink(row);
  }

  listPaneSessionLinks(): PaneSessionLink[] {
    return (
      this.#database
        .prepare("SELECT * FROM pane_session_links ORDER BY created_at, pane_id")
        .all() as PaneSessionLinkRow[]
    ).map(mapPaneSessionLink);
  }

  getPaneSessionLinkByIntegrationBinding(bindingId: string): PaneSessionLink | undefined {
    const row = this.#database
      .prepare("SELECT * FROM pane_session_links WHERE integration_binding_id = ?")
      .get(bindingId) as PaneSessionLinkRow | undefined;
    return row === undefined ? undefined : mapPaneSessionLink(row);
  }

  claimIntegrationLaunch(bindingId: string, sessionId: string, runtimeId: string): boolean {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE pane_session_links
         SET integration_launch_runtime_id = ?, updated_at = ?
         WHERE integration_binding_id = ?
           AND integration_launch_runtime_id IS NULL
           AND (
             (
               state = 'pending'
               AND pending_operation IN ('create', 'start')
               AND (session_id IS NULL OR session_id = ?)
             )
             OR (state = 'linked' AND session_id = ?)
           )`,
      )
      .run(runtimeId, now, bindingId, sessionId, sessionId);
    return result.changes === 1;
  }

  preparePaneSessionOperation(
    paneId: string,
    operation: PaneSessionOperation,
    expected: { readonly sessionRevision: number; readonly runtimeId?: string } | null = null,
    integrationBindingId?: string,
  ): PaneSessionLink {
    return this.#database
      .transaction(() => {
        const context = this.getPaneContext(paneId);
        if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
        if (
          context.pane.kind !== "terminal" &&
          context.pane.kind !== "codex" &&
          context.pane.kind !== "claude"
        ) {
          throw new AppError("REQUEST_INVALID", 400, "이 Pane은 Session을 소유하지 않습니다.");
        }
        const existing = this.getPaneSessionLink(paneId);
        if (existing?.pendingOperation === operation) return existing;
        if (existing?.pendingOperation !== null && existing?.pendingOperation !== undefined) {
          throw new AppError(
            "REQUEST_INVALID",
            409,
            "Pane Session 전환이 아직 완료되지 않았습니다.",
          );
        }
        if (operation !== "create" && (existing === undefined || existing.sessionId === null)) {
          throw new AppError("PTY_NOT_RUNNING", 409, "Pane에 연결된 Session이 없습니다.");
        }
        if (operation === "create" && existing?.sessionId !== undefined) {
          throw new AppError("REQUEST_INVALID", 409, "Pane에 이미 Session이 연결되어 있습니다.");
        }
        assertPaneSessionExpectation(operation, expected);
        const now = new Date().toISOString();
        const operationKey = randomUUID();
        if (existing === undefined) {
          this.#database
            .prepare(
              `INSERT INTO pane_session_links
                (pane_id, session_id, state, pending_operation, operation_key,
                 expected_session_revision, expected_runtime_id, last_error_code,
                 integration_binding_id, created_at, updated_at)
               VALUES (?, NULL, 'pending', ?, ?, ?, ?, NULL, ?, ?, ?)`,
            )
            .run(
              paneId,
              operation,
              operationKey,
              expected?.sessionRevision ?? null,
              expected?.runtimeId ?? null,
              integrationBindingId ?? null,
              now,
              now,
            );
        } else {
          this.#database
            .prepare(
              `UPDATE pane_session_links
               SET state = 'pending', pending_operation = ?, operation_key = ?,
                   expected_session_revision = ?, expected_runtime_id = ?,
                   last_error_code = NULL,
                   integration_binding_id = COALESCE(?, integration_binding_id), updated_at = ?
               WHERE pane_id = ?`,
            )
            .run(
              operation,
              operationKey,
              expected?.sessionRevision ?? null,
              expected?.runtimeId ?? null,
              integrationBindingId ?? null,
              now,
              paneId,
            );
        }
        return this.getPaneSessionLink(paneId) as PaneSessionLink;
      })
      .immediate();
  }

  completePaneSessionOperation(
    paneId: string,
    operation: PaneSessionOperation,
    operationKey: string,
    session: SessionView,
  ): PaneSessionLink {
    return this.#database
      .transaction(() => {
        const now = new Date().toISOString();
        const result = this.#database
          .prepare(
            `UPDATE pane_session_links
             SET session_id = ?, state = 'linked', pending_operation = NULL, operation_key = NULL,
                 expected_session_revision = NULL, expected_runtime_id = NULL,
                 last_error_code = NULL,
                 updated_at = ?
             WHERE pane_id = ? AND pending_operation = ? AND operation_key = ?`,
          )
          .run(session.sessionId, now, paneId, operation, operationKey);
        if (result.changes === 0) {
          throw new AppError("REQUEST_INVALID", 409, "Pane Session 전환 상태가 변경되었습니다.");
        }
        this.#applyHostSessionView(paneId, session);
        return this.getPaneSessionLink(paneId) as PaneSessionLink;
      })
      .immediate();
  }

  syncPaneSession(paneId: string, session: SessionView): PaneSessionLink {
    return this.#database
      .transaction(() => {
        const existing = this.getPaneSessionLink(paneId);
        if (existing?.sessionId !== session.sessionId) {
          throw new AppError("REQUEST_INVALID", 409, "Pane Session identity가 일치하지 않습니다.");
        }
        if (existing.pendingOperation !== null) {
          throw new AppError(
            "REQUEST_INVALID",
            409,
            "Pane Session 전환이 아직 완료되지 않았습니다.",
          );
        }
        const now = new Date().toISOString();
        this.#database
          .prepare(
            `UPDATE pane_session_links
             SET state = 'linked', last_error_code = NULL, updated_at = ?
             WHERE pane_id = ?`,
          )
          .run(now, paneId);
        this.#applyHostSessionView(paneId, session);
        return this.getPaneSessionLink(paneId) as PaneSessionLink;
      })
      .immediate();
  }

  completePaneSessionForget(paneId: string, operationKey: string): void {
    const result = this.#database
      .prepare(
        `DELETE FROM pane_session_links
         WHERE pane_id = ? AND pending_operation = 'forget' AND operation_key = ?`,
      )
      .run(paneId, operationKey);
    if (result.changes === 0) {
      throw new AppError("REQUEST_INVALID", 409, "Pane Session 전환 상태가 변경되었습니다.");
    }
  }

  markPaneSessionMissing(paneId: string, errorCode: DurableSessionErrorCode): PaneSessionLink {
    return this.#database
      .transaction(() => {
        const now = new Date().toISOString();
        const result = this.#database
          .prepare(
            `UPDATE pane_session_links
             SET state = 'missing', pending_operation = NULL, operation_key = NULL,
                 expected_session_revision = NULL, expected_runtime_id = NULL,
                 last_error_code = ?, updated_at = ?
             WHERE pane_id = ?`,
          )
          .run(errorCode, now, paneId);
        if (result.changes === 0) {
          throw new AppError("PANE_MISSING", 404, "Pane Session 연결을 찾을 수 없습니다.");
        }
        this.#database
          .prepare(
            `UPDATE panes
             SET status = 'stopped', exit_code = NULL, activity_runtime_id = NULL,
                 last_exited_at = ?, updated_at = ?
             WHERE id = ?`,
          )
          .run(now, now, paneId);
        return this.getPaneSessionLink(paneId) as PaneSessionLink;
      })
      .immediate();
  }

  clearPaneSessionOperation(
    paneId: string,
    operation: PaneSessionOperation,
    operationKey: string,
    errorCode: DurableSessionErrorCode,
  ): void {
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE pane_session_links
         SET state = CASE WHEN session_id IS NULL THEN 'missing' ELSE 'linked' END,
             pending_operation = NULL, operation_key = NULL,
             expected_session_revision = NULL, expected_runtime_id = NULL,
             last_error_code = ?, updated_at = ?
         WHERE pane_id = ? AND pending_operation = ? AND operation_key = ?`,
      )
      .run(errorCode, now, paneId, operation, operationKey);
    if (result.changes === 0) {
      throw new AppError("REQUEST_INVALID", 409, "Pane Session 전환 상태가 변경되었습니다.");
    }
  }

  deletePaneSessionLink(paneId: string): void {
    this.#database.prepare("DELETE FROM pane_session_links WHERE pane_id = ?").run(paneId);
  }

  assertPaneDeletion(paneId: string, workspaceVersion: number): void {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    const workspace = this.getWorkspace(context.pane.projectId);
    assertWorkspaceVersion(workspace.version, workspaceVersion);
    const layout = removePane(workspace.layout, paneId);
    const nextActivePaneId =
      workspace.activePaneId === paneId ? firstPaneFromLayout(layout) : workspace.activePaneId;
    const remainingPaneIds = new Set(
      workspace.panes.filter((pane) => pane.id !== paneId).map((pane) => pane.id),
    );
    assertWorkspaceState(layout, nextActivePaneId, remainingPaneIds);
  }

  getPaneContext(paneId: string): PaneContext | undefined {
    const row = this.#database
      .prepare(
        `SELECT panes.*, projects.real_path
         FROM panes JOIN projects ON projects.id = panes.project_id
         WHERE panes.id = ?`,
      )
      .get(paneId) as (PaneRow & { real_path: string }) | undefined;
    if (!row) return undefined;
    return { pane: mapPane(row), projectPath: row.real_path };
  }

  setPaneStatus(
    paneId: string,
    status: PaneStatus,
    exitCode: number | null = null,
    lastErrorCode: ErrorCode | null = null,
    lastExitedAt?: string,
  ): void {
    this.#database
      .prepare(
        `UPDATE panes
         SET status = ?, exit_code = ?, last_error_code = ?,
             last_exited_at = COALESCE(?, last_exited_at), updated_at = ?
         WHERE id = ?`,
      )
      .run(status, exitCode, lastErrorCode, lastExitedAt ?? null, new Date().toISOString(), paneId);
  }

  setPaneStatusForRuntime(
    paneId: string,
    runtimeId: string,
    status: PaneStatus,
    exitCode: number | null = null,
    lastErrorCode: ErrorCode | null = null,
    lastExitedAt?: string,
  ): boolean {
    const result = this.#database
      .prepare(
        `UPDATE panes
         SET status = ?, exit_code = ?, last_error_code = ?,
             last_exited_at = COALESCE(?, last_exited_at), updated_at = ?
         WHERE id = ? AND activity_runtime_id = ?`,
      )
      .run(
        status,
        exitCode,
        lastErrorCode,
        lastExitedAt ?? null,
        new Date().toISOString(),
        paneId,
        runtimeId,
      );
    return result.changes === 1;
  }

  setCodexSession(paneId: string, sessionId: string | null, resumable: boolean): void {
    if (sessionId !== null && !CodexSessionIdSchema.safeParse(sessionId).success) {
      throw new AppError("REQUEST_INVALID", 400, "Codex session ID 형식이 올바르지 않습니다.");
    }
    if (sessionId === null && resumable) {
      throw new AppError(
        "REQUEST_INVALID",
        400,
        "Session ID가 없으면 Codex 작업을 재개 가능으로 표시할 수 없습니다.",
      );
    }
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (context.pane.kind !== "codex") {
      throw new AppError("REQUEST_INVALID", 400, "Codex Pane에만 session ID를 저장할 수 있습니다.");
    }
    const updatedAt = timestampAfter(context.pane.updatedAt);
    this.#database
      .prepare(
        `UPDATE panes
         SET codex_session_id = ?, codex_session_resumable = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(sessionId, resumable ? 1 : 0, updatedAt, paneId);
  }

  setCodexSessionForRuntime(
    paneId: string,
    runtimeId: string,
    sessionId: string | null,
    resumable: boolean,
  ): boolean {
    if (sessionId !== null && !CodexSessionIdSchema.safeParse(sessionId).success) {
      throw new AppError("REQUEST_INVALID", 400, "Codex session ID 형식이 올바르지 않습니다.");
    }
    if (sessionId === null && resumable) {
      throw new AppError(
        "REQUEST_INVALID",
        400,
        "Session ID가 없으면 Codex 작업을 재개 가능으로 표시할 수 없습니다.",
      );
    }
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (context.pane.kind !== "codex") {
      throw new AppError("REQUEST_INVALID", 400, "Codex Pane에만 session ID를 저장할 수 있습니다.");
    }
    const updatedAt = timestampAfter(context.pane.updatedAt);
    const result = this.#database
      .prepare(
        `UPDATE panes
         SET codex_session_id = ?, codex_session_resumable = ?, updated_at = ?
         WHERE id = ? AND activity_runtime_id = ?`,
      )
      .run(sessionId, resumable ? 1 : 0, updatedAt, paneId, runtimeId);
    return result.changes === 1;
  }

  /** Remember the latest Claude conversation reported by the Pane's current runtime. */
  setClaudeSessionForRuntime(paneId: string, runtimeId: string, sessionId: string): boolean {
    if (!ClaudeSessionIdSchema.safeParse(sessionId).success) return false;
    const context = this.getPaneContext(paneId);
    if (context?.pane.kind !== "claude" || context.pane.claudeSessionId === sessionId) return false;
    const result = this.#database
      .prepare(
        `UPDATE panes SET claude_session_id = ?, updated_at = ?
         WHERE id = ? AND kind = 'claude' AND activity_runtime_id = ?`,
      )
      .run(sessionId, timestampAfter(context.pane.updatedAt), paneId, runtimeId);
    return result.changes === 1;
  }

  clearClaudeSession(paneId: string): void {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (context.pane.kind !== "claude") {
      throw new AppError("REQUEST_INVALID", 400, "Claude Pane에서만 새 대화를 시작할 수 있습니다.");
    }
    this.#database
      .prepare("UPDATE panes SET claude_session_id = NULL, updated_at = ? WHERE id = ?")
      .run(timestampAfter(context.pane.updatedAt), paneId);
  }

  beginPaneRuntime(paneId: string, runtimeId: string): PaneActivityChange {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    const eventId = randomUUID();
    const updatedAt = new Date().toISOString();
    this.#database
      .prepare(
        `UPDATE panes
         SET status = 'running', exit_code = NULL, last_error_code = NULL,
             activity_state = 'idle', activity_event_id = ?, activity_runtime_id = ?,
             activity_revision = activity_revision + 1, activity_updated_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(eventId, runtimeId, updatedAt, updatedAt, paneId);
    return {
      eventId,
      projectId: context.pane.projectId,
      paneId,
      runtimeId,
      activity: {
        state: "idle",
        eventId,
        runtimeId,
        revision: context.pane.activity.revision + 1,
        updatedAt,
      },
      projectActivity: this.getProjectActivity(context.pane.projectId),
    };
  }

  setPaneActivity(paneId: string, state: PaneActivityState): PaneActivityChange | null {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (context.pane.activity.state === state) return null;
    return this.#writePaneActivity(context, state, context.pane.activity.runtimeId);
  }

  setPaneActivityForRuntime(
    paneId: string,
    runtimeId: string,
    state: PaneActivityState,
  ): PaneActivityChange | null {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (context.pane.activity.runtimeId !== runtimeId || context.pane.activity.state === state) {
      return null;
    }
    return this.#writePaneActivity(context, state, runtimeId, runtimeId);
  }

  acknowledgeCompletedActivity(paneId: string, eventId: string): PaneActivityChange | null {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (context.pane.activity.state !== "completed" || context.pane.activity.eventId !== eventId) {
      return null;
    }
    return this.#writePaneActivity(context, "idle", context.pane.activity.runtimeId);
  }

  getProjectActivity(projectId: string): ProjectActivity {
    const rows = this.#database
      .prepare(
        `SELECT activity_state, activity_updated_at
         FROM panes WHERE project_id = ?`,
      )
      .all(projectId) as Array<Pick<PaneRow, "activity_state" | "activity_updated_at">>;
    if (rows.length === 0) return idleProjectActivity();

    const state = rows.reduce<PaneActivityState>(
      (highest, row) =>
        activityPriority(row.activity_state) > activityPriority(highest)
          ? row.activity_state
          : highest,
      "idle",
    );
    const updatedAt =
      rows
        .filter((row) => row.activity_state === state)
        .map((row) => row.activity_updated_at)
        .sort()
        .at(-1) ?? null;
    return {
      state,
      interactionRequiredCount: rows.filter((row) => row.activity_state === "interaction-required")
        .length,
      updatedAt,
    };
  }

  updatePaneViewState(paneId: string, input: UpdatePaneViewStateRequest): Pane {
    const context = this.getPaneContext(paneId);
    if (!context) throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    if (
      context.pane.kind !== "files" &&
      context.pane.kind !== "docs" &&
      context.pane.kind !== "tasks"
    ) {
      throw new AppError(
        "REQUEST_INVALID",
        400,
        "Files 또는 문서 Pane에서만 탐색 보기 상태를 저장할 수 있습니다.",
      );
    }
    const viewState = PaneViewStateSchema.parse({ ...context.pane.viewState, ...input });
    this.#database
      .prepare("UPDATE panes SET view_state_json = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(viewState), new Date().toISOString(), paneId);
    return this.getPaneContext(paneId)?.pane as Pane;
  }

  #insertPane(pane: Pane): void {
    this.#database
      .prepare(
        `INSERT INTO panes
          (id, project_id, kind, title, launch_profile, status, exit_code,
           codex_session_id, codex_session_resumable, last_error_code, last_exited_at,
           activity_state, activity_event_id, activity_runtime_id, activity_revision,
           activity_updated_at, view_state_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        pane.id,
        pane.projectId,
        pane.kind,
        pane.title,
        pane.launchProfile,
        pane.status,
        pane.exitCode,
        pane.codexSessionId,
        pane.codexSessionResumable ? 1 : 0,
        pane.lastErrorCode,
        pane.lastExitedAt,
        pane.activity.state,
        pane.activity.eventId,
        pane.activity.runtimeId,
        pane.activity.revision,
        pane.activity.updatedAt,
        JSON.stringify(pane.viewState),
        pane.createdAt,
        pane.updatedAt,
      );
  }

  #deleteExpiredPushSubscriptions(now = Date.now()): void {
    this.#database
      .prepare(
        "DELETE FROM push_subscriptions WHERE expiration_time IS NOT NULL AND expiration_time <= ?",
      )
      .run(now);
  }

  #markOrphanedPanesServerStopped(): void {
    this.#database.transaction(() => {
      const now = new Date().toISOString();
      const interrupted = this.#database
        .prepare("SELECT id FROM panes WHERE status = 'running'")
        .all() as Array<{ id: string }>;
      this.#database
        .prepare(
          `UPDATE panes
           SET status = 'stopped', exit_code = NULL, last_error_code = NULL,
               last_exited_at = ?, updated_at = ?
           WHERE status = 'running'`,
        )
        .run(now, now);
      const markStopped = this.#database.prepare(
        `UPDATE panes
         SET activity_state = 'server-stopped', activity_event_id = ?, activity_updated_at = ?,
             activity_revision = activity_revision + 1, updated_at = ?
         WHERE id = ?`,
      );
      for (const pane of interrupted) markStopped.run(randomUUID(), now, now, pane.id);
    })();
  }

  #applyHostSessionView(paneId: string, session: SessionView): void {
    const status: PaneStatus =
      session.lifecycle === "failed"
        ? "error"
        : session.lifecycle === "exited"
          ? "exited"
          : session.lifecycle === "stopped"
            ? "stopped"
            : "running";
    const now = new Date().toISOString();
    const result = this.#database
      .prepare(
        `UPDATE panes
         SET status = ?,
             exit_code = CASE WHEN ? = 'exited' THEN exit_code ELSE NULL END,
             last_error_code = NULL,
             last_exited_at = CASE WHEN ? IN ('stopped', 'exited', 'error') THEN ? ELSE NULL END,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(status, status, status, now, now, paneId);
    if (result.changes === 0) {
      throw new AppError("PANE_MISSING", 404, "Pane을 찾을 수 없습니다.");
    }
  }

  #writePaneActivity(
    context: PaneContext,
    state: PaneActivityState,
    runtimeId: string | null,
    expectedRuntimeId?: string,
  ): PaneActivityChange | null {
    const eventId = randomUUID();
    const updatedAt = new Date().toISOString();
    const result =
      expectedRuntimeId === undefined
        ? this.#database
            .prepare(
              `UPDATE panes
               SET activity_state = ?, activity_event_id = ?,
                   activity_revision = activity_revision + 1, activity_updated_at = ?, updated_at = ?
               WHERE id = ?`,
            )
            .run(state, eventId, updatedAt, updatedAt, context.pane.id)
        : this.#database
            .prepare(
              `UPDATE panes
               SET activity_state = ?, activity_event_id = ?,
                   activity_revision = activity_revision + 1, activity_updated_at = ?, updated_at = ?
               WHERE id = ? AND activity_runtime_id = ?`,
            )
            .run(state, eventId, updatedAt, updatedAt, context.pane.id, expectedRuntimeId);
    if (result.changes !== 1) return null;
    return {
      eventId,
      projectId: context.pane.projectId,
      paneId: context.pane.id,
      runtimeId,
      activity: {
        state,
        eventId,
        runtimeId,
        revision: context.pane.activity.revision + 1,
        updatedAt,
      },
      projectActivity: this.getProjectActivity(context.pane.projectId),
    };
  }

  #requiredStoredProjectTarget(projectId: string): StoredProjectTarget {
    const target = this.getStoredProjectTarget(projectId);
    if (target === undefined) {
      throw new AppError("PROJECT_MISSING", 404, "프로젝트를 찾을 수 없습니다.");
    }
    return target;
  }

  #requiredStoredProjectGroup(groupId: string): StoredProjectGroup {
    const group = this.getStoredProjectGroup(groupId);
    if (group === undefined) {
      throw new AppError("PROJECT_GROUP_MISSING", 404, "프로젝트 그룹을 찾을 수 없습니다.");
    }
    return group;
  }

  #projectGroupTargetCount(groupId: string): number {
    return this.#database
      .prepare("SELECT COUNT(*) FROM projects WHERE group_id = ?")
      .pluck()
      .get(groupId) as number;
  }

  #deleteEmptyProjectGroup(groupId: string): void {
    this.#database
      .prepare(
        `DELETE FROM project_groups
         WHERE id = ?
           AND NOT EXISTS (SELECT 1 FROM projects WHERE group_id = project_groups.id)`,
      )
      .run(groupId);
  }

  #migrate(): void {
    runDatabaseMigrations(this.#database);
  }
}

function mapProject(row: ProjectRow, activity: ProjectActivity): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.real_path,
    activity,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapStoredProjectTarget(row: ProjectRow, activity: ProjectActivity): StoredProjectTarget {
  if (row.group_id === null) throw new Error(`Project ${row.id} has no project group.`);
  return { ...mapProject(row, activity), groupId: row.group_id };
}

function mapStoredProjectGroup(row: ProjectGroupRow): StoredProjectGroup {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    gitCommonDirectory: row.git_common_dir,
    gitRelativePath: row.git_relative_path,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPasskey(row: PasskeyRow): Passkey {
  return {
    id: row.id,
    name: row.name,
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastUsedAt: row.last_used_at,
  };
}

function mapPasskeyCredential(row: PasskeyRow): PasskeyCredentialRecord {
  return {
    ...mapPasskey(row),
    credentialId: row.credential_id,
    publicKey: Uint8Array.from(row.public_key),
    counter: row.counter,
    transports: JSON.parse(row.transports_json) as string[],
  };
}

function mapPushSubscription(row: PushSubscriptionRow): NaruPushSubscription {
  return {
    id: row.id,
    name: row.name,
    endpointFingerprint: row.endpoint_fingerprint,
    expirationTime: row.expiration_time,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPushSubscriptionDeliveryRecord(
  row: PushSubscriptionRow,
): PushSubscriptionDeliveryRecord {
  return {
    ...mapPushSubscription(row),
    endpoint: row.endpoint,
    p256dh: row.p256dh,
    auth: row.auth,
  };
}

function pushEndpointFingerprint(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}

function mapPane(row: PaneRow): Pane {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    launchProfile: row.launch_profile,
    status: row.status,
    exitCode: row.exit_code,
    codexSessionId: row.codex_session_id,
    codexSessionResumable: row.codex_session_resumable === 1,
    claudeSessionId: row.claude_session_id,
    lastErrorCode: row.last_error_code,
    lastExitedAt: row.last_exited_at,
    activity: {
      state: row.activity_state,
      eventId: row.activity_event_id,
      runtimeId: row.activity_runtime_id,
      revision: row.activity_revision,
      updatedAt: row.activity_updated_at,
    },
    viewState: parsePaneViewState(row.view_state_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPaneSessionLink(row: PaneSessionLinkRow): PaneSessionLink {
  return {
    paneId: row.pane_id,
    sessionId: row.session_id,
    state: row.state,
    pendingOperation: row.pending_operation,
    operationKey: row.operation_key,
    expectedSessionRevision: row.expected_session_revision,
    expectedRuntimeId: row.expected_runtime_id,
    lastErrorCode: row.last_error_code,
    integrationBindingId: row.integration_binding_id,
    integrationLaunchRuntimeId: row.integration_launch_runtime_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function assertPaneSessionExpectation(
  operation: PaneSessionOperation,
  expected: { readonly sessionRevision: number; readonly runtimeId?: string } | null,
): void {
  const valid =
    operation === "create"
      ? expected === null
      : operation === "stop"
        ? expected !== null && expected.runtimeId !== undefined
        : expected !== null && expected.runtimeId === undefined;
  if (!valid) {
    throw new AppError("REQUEST_INVALID", 409, "Pane Session fence가 올바르지 않습니다.");
  }
}

function parsePaneViewState(serialized: string): PaneViewState {
  return PaneViewStateSchema.parse(JSON.parse(serialized) as unknown);
}

function parseLayout(serialized: string | null, schemaVersion: number): LayoutNode | null {
  if (serialized === null) return null;
  return migrateLayout(JSON.parse(serialized) as unknown, schemaVersion);
}

function firstPaneFromLayout(layout: LayoutNode | null): string | null {
  if (layout === null) return null;
  return layout.type === "pane" ? layout.paneId : firstPaneFromLayout(layout.first);
}

function createDefaultWorkspace(
  projectId: string,
  now: string,
  agentKind: "codex" | "claude",
): { panes: [Pane, Pane, Pane]; layout: LayoutNode; activePaneId: string } {
  const mainAgent =
    agentKind === "claude"
      ? createPaneRecord(projectId, "claude", "Claude Code 1", "claude-code", now)
      : createPaneRecord(projectId, "codex", "Main Codex", "codex-main", now);
  const secondAgent =
    agentKind === "claude"
      ? createPaneRecord(projectId, "claude", "Claude Code 2", "claude-code", now)
      : createPaneRecord(projectId, "codex", "Quick Codex", "codex-quick", now);
  const devTerminal = createPaneRecord(projectId, "terminal", "Dev Terminal", "shell", now);
  const layout: LayoutNode = {
    type: "split",
    id: randomUUID(),
    direction: "vertical",
    ratio: 0.64,
    first: {
      type: "split",
      id: randomUUID(),
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: mainAgent.id, collapsed: false },
      second: { type: "pane", paneId: secondAgent.id, collapsed: false },
    },
    second: { type: "pane", paneId: devTerminal.id, collapsed: false },
  };
  validateLayout(layout, new Set([mainAgent.id, secondAgent.id, devTerminal.id]));
  return {
    panes: [mainAgent, secondAgent, devTerminal],
    layout,
    activePaneId: mainAgent.id,
  };
}

function createPaneRecord(
  projectId: string,
  kind: PaneKind,
  title: string,
  launchProfile: string,
  now: string,
  selectedDocumentPath: string | null = null,
): Pane {
  return {
    id: randomUUID(),
    projectId,
    kind,
    title,
    launchProfile,
    status: kind === "files" || kind === "docs" || kind === "tasks" ? "ready" : "stopped",
    exitCode: null,
    codexSessionId: null,
    codexSessionResumable: false,
    lastErrorCode: null,
    lastExitedAt: null,
    activity: { state: "idle", eventId: null, runtimeId: null, revision: 0, updatedAt: now },
    viewState: { selectedDocumentPath, navigationOpen: true, expandedDirectories: [] },
    createdAt: now,
    updatedAt: now,
  };
}

function defaultPaneTitle(kind: PaneKind, paneNumber: number): string {
  switch (kind) {
    case "codex":
      return `Codex ${paneNumber}`;
    case "claude":
      return `Claude Code ${paneNumber}`;
    case "terminal":
      return `Terminal ${paneNumber}`;
    case "files":
      return paneNumber === 1 ? "Files" : `Files ${paneNumber}`;
    case "docs":
      return paneNumber === 1 ? "Docs" : `Docs ${paneNumber}`;
    case "tasks":
      return paneNumber === 1 ? "Tasks" : `Tasks ${paneNumber}`;
  }
}

function paneLaunchProfile(input: CreatePaneRequest): string {
  switch (input.kind) {
    case "codex":
      return input.launchProfile ?? "codex-main";
    case "claude":
      return input.launchProfile ?? "claude-code";
    case "terminal":
      return input.launchProfile ?? "shell";
    case "files":
      return "files-editor";
    case "docs":
      return "docs-readonly";
    case "tasks":
      return "tasks-readonly";
  }
}

function idleProjectActivity(): ProjectActivity {
  return { state: "idle", interactionRequiredCount: 0, updatedAt: null };
}

function activityPriority(state: PaneActivityState): number {
  switch (state) {
    case "interaction-required":
      return 7;
    case "failed":
      return 6;
    case "completed":
      return 5;
    case "server-stopped":
      return 4;
    case "canceled":
      return 3;
    case "running":
      return 2;
    case "idle":
      return 1;
  }
}

function splitForNewPane(
  layout: LayoutNode | null,
  targetPaneId: string | null,
  newPaneId: string,
  direction: "horizontal" | "vertical",
): LayoutNode {
  if (layout === null) {
    if (targetPaneId !== null) {
      throw new AppError(
        "REQUEST_INVALID",
        400,
        "빈 작업공간에는 분할 대상 Pane을 지정할 수 없습니다.",
      );
    }
    return { type: "pane", paneId: newPaneId, collapsed: false };
  }
  if (targetPaneId === null) {
    throw new AppError("REQUEST_INVALID", 400, "분할할 Pane을 선택해 주세요.");
  }
  try {
    return splitPane(layout, targetPaneId, newPaneId, direction);
  } catch {
    throw new AppError("REQUEST_INVALID", 400, "분할 대상 Pane이 현재 레이아웃에 없습니다.");
  }
}

function assertWorkspaceState(
  layout: LayoutNode | null,
  activePaneId: string | null,
  paneIds: ReadonlySet<string>,
): void {
  try {
    validateLayout(layout, paneIds);
  } catch {
    throw new AppError("REQUEST_INVALID", 400, "유효하지 않은 작업공간 레이아웃입니다.");
  }
  if (activePaneId !== null && !paneIds.has(activePaneId)) {
    throw new AppError("REQUEST_INVALID", 400, "활성 Pane이 현재 레이아웃에 없습니다.");
  }
  if (paneIds.size > 0 && activePaneId === null) {
    throw new AppError("REQUEST_INVALID", 400, "활성 Pane을 선택해 주세요.");
  }
}

function assertWorkspaceVersion(actual: number, expected: number): void {
  if (actual !== expected) throwLayoutConflict();
}

function assertWorkspaceUpdated(changes: number): void {
  if (changes !== 1) throwLayoutConflict();
}

function throwLayoutConflict(): never {
  throw new AppError(
    "LAYOUT_CONFLICT",
    409,
    "작업공간이 다른 요청에서 변경되었습니다. 최신 상태를 불러온 뒤 다시 시도해 주세요.",
  );
}

function isUniqueConstraint(error: unknown, field: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    error.code.startsWith("SQLITE_CONSTRAINT") &&
    error.message.includes(field)
  );
}

function validateMigrations(migrations: readonly DatabaseMigration[]): void {
  let previousVersion = 0;
  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("Database migrations must have unique, ascending positive versions.");
    }
    previousVersion = migration.version;
  }
}

function timestampAfter(previous: string): string {
  const previousMs = Date.parse(previous);
  return new Date(
    Number.isFinite(previousMs) ? Math.max(Date.now(), previousMs + 1) : Date.now(),
  ).toISOString();
}
