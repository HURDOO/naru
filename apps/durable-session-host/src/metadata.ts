import { basename, join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import Database from "better-sqlite3";
import {
  BoundedIdentifierSchema,
  ControllerGenerationSchema,
  RuntimeIdSchema,
  RelativePathSchema,
  SessionIdSchema,
  SessionLifecycleSchema,
  SessionRevisionSchema,
  TerminalDescriptorSchema,
  TerminalSequenceSchema,
  UnixTimeMillisecondsSchema,
  type CommandSpecV0,
} from "@naru/contracts/durable-session/v0";
import type { DurableSessionState } from "@naru/domain/durable-session";
import { z } from "zod";
import type { Restartability } from "./command-policy.js";
import { assertPrivateRegularFile, ensurePrivateDirectory } from "./security.js";

const METADATA_SCHEMA_VERSION = 1;

const PersistedRuntimeSummarySchema = z.strictObject({
  runtimeId: RuntimeIdSchema,
  reason: z.enum([
    "natural-exit",
    "explicit-stop",
    "spawn-failed",
    "runtime-failed",
    "runtime-lost",
  ]),
  exitCode: z.number().int().nullable(),
  signal: z.number().int().nonnegative().nullable(),
});

const PersistedCommandSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("profile"),
    profileId: BoundedIdentifierSchema,
    rootId: BoundedIdentifierSchema,
    relativePath: RelativePathSchema,
    terminal: TerminalDescriptorSchema,
  }),
  z.strictObject({
    kind: z.literal("exec"),
    executableLabel: z.string().min(1).max(256),
    rootId: BoundedIdentifierSchema,
    relativePath: RelativePathSchema,
    terminal: TerminalDescriptorSchema,
  }),
]);

const PersistedSessionSchema = z.strictObject({
  version: z.literal(METADATA_SCHEMA_VERSION),
  sessionId: SessionIdSchema,
  lifecycle: SessionLifecycleSchema,
  sessionRevision: SessionRevisionSchema,
  runtimeId: RuntimeIdSchema.nullable(),
  terminal: TerminalDescriptorSchema,
  controllerGeneration: ControllerGenerationSchema,
  nextSequence: TerminalSequenceSchema,
  command: PersistedCommandSchema,
  restartability: z.enum(["profile-reference", "runtime-only"]),
  lastRuntime: PersistedRuntimeSummarySchema.nullable(),
  createdAtMs: UnixTimeMillisecondsSchema,
  updatedAtMs: UnixTimeMillisecondsSchema,
});

type PersistedSession = z.infer<typeof PersistedSessionSchema>;

export interface StoredSession {
  readonly state: DurableSessionState;
  readonly restartability: Restartability;
}

export interface MetadataRepository {
  loadAll(): readonly StoredSession[];
  save(session: StoredSession): void;
  delete(sessionId: string): void;
  ping(): boolean;
  close(): void;
}

export class SqliteMetadataRepository implements MetadataRepository {
  readonly #database: Database.Database;
  readonly databasePath: string;

  constructor(dataDirectory: string) {
    ensurePrivateDirectory(dataDirectory);
    this.databasePath = join(dataDirectory, "metadata.sqlite");
    const existed = existsSync(this.databasePath);
    if (existed) assertPrivateRegularFile(this.databasePath);
    this.#database = new Database(this.databasePath);
    try {
      if (!existed) chmodSync(this.databasePath, 0o600);
      assertPrivateRegularFile(this.databasePath);
      this.#database.pragma("foreign_keys = ON");
      this.#database.pragma("journal_mode = DELETE");
      this.#database.pragma("synchronous = FULL");
      this.#migrate();
    } catch (error) {
      this.#database.close();
      throw error;
    }
  }

  loadAll(): readonly StoredSession[] {
    const rows = this.#database
      .prepare("SELECT metadata_json FROM sessions ORDER BY created_at_ms, session_id")
      .all() as { readonly metadata_json: string }[];
    return rows.map((row) => decodePersistedSession(row.metadata_json));
  }

  save(session: StoredSession): void {
    const persisted = encodePersistedSession(session);
    this.#database
      .prepare(
        `INSERT INTO sessions (session_id, metadata_json, created_at_ms, updated_at_ms)
         VALUES (@sessionId, @metadataJson, @createdAtMs, @updatedAtMs)
         ON CONFLICT(session_id) DO UPDATE SET
           metadata_json = excluded.metadata_json,
           created_at_ms = excluded.created_at_ms,
           updated_at_ms = excluded.updated_at_ms`,
      )
      .run({
        sessionId: persisted.sessionId,
        metadataJson: JSON.stringify(persisted),
        createdAtMs: persisted.createdAtMs,
        updatedAtMs: persisted.updatedAtMs,
      });
  }

  delete(sessionId: string): void {
    this.#database.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  ping(): boolean {
    const result = this.#database.prepare("SELECT 1 AS healthy").get() as
      { readonly healthy: number } | undefined;
    return result?.healthy === 1;
  }

  close(): void {
    this.#database.close();
  }

  #migrate(): void {
    this.#database.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at_ms INTEGER NOT NULL
      );
    `);
    const current = this.#database
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { readonly version: number | null };
    const version = current.version ?? 0;
    if (version > METADATA_SCHEMA_VERSION) {
      throw new Error("DurableSession metadata schema is newer than this Host.");
    }
    if (version < 1) {
      this.#database.transaction(() => {
        this.#database.exec(`
          CREATE TABLE sessions (
            session_id TEXT PRIMARY KEY,
            metadata_json TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            updated_at_ms INTEGER NOT NULL
          );
          CREATE INDEX sessions_created_at_idx
            ON sessions(created_at_ms, session_id);
        `);
        this.#database
          .prepare("INSERT INTO schema_migrations (version, applied_at_ms) VALUES (?, ?)")
          .run(1, Date.now());
      })();
    }
  }
}

export class MemoryMetadataRepository implements MetadataRepository {
  readonly #sessions = new Map<string, PersistedSession>();
  #closed = false;

  loadAll(): readonly StoredSession[] {
    this.#assertOpen();
    return [...this.#sessions.values()].map((session) => decodePersistedSession(session));
  }

  save(session: StoredSession): void {
    this.#assertOpen();
    const persisted = encodePersistedSession(session);
    this.#sessions.set(persisted.sessionId, structuredClone(persisted));
  }

  delete(sessionId: string): void {
    this.#assertOpen();
    this.#sessions.delete(sessionId);
  }

  ping(): boolean {
    return !this.#closed;
  }

  close(): void {
    this.#closed = true;
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Metadata repository is closed.");
  }
}

function encodePersistedSession(session: StoredSession): PersistedSession {
  const { state } = session;
  const terminal = {
    ...state.terminal,
    ...(state.command.terminal.term === undefined ? {} : { term: state.command.terminal.term }),
  };
  const command =
    state.command.kind === "profile"
      ? {
          kind: "profile" as const,
          profileId: state.command.profileId,
          rootId: state.command.cwd.rootId,
          relativePath: state.command.cwd.relativePath,
          terminal,
        }
      : {
          kind: "exec" as const,
          executableLabel: safeExecutableLabel(state.command.executable),
          rootId: state.command.cwd.rootId,
          relativePath: state.command.cwd.relativePath,
          terminal,
        };
  return PersistedSessionSchema.parse({
    version: METADATA_SCHEMA_VERSION,
    sessionId: state.sessionId,
    lifecycle: state.lifecycle,
    sessionRevision: state.sessionRevision,
    runtimeId: state.runtimeId,
    terminal,
    controllerGeneration: state.controllerGeneration,
    nextSequence: state.runtimeId === null ? 0 : state.nextSequence,
    command,
    restartability: session.restartability,
    lastRuntime: state.lastRuntime,
    createdAtMs: state.createdAtMs,
    updatedAtMs: state.updatedAtMs,
  });
}

function decodePersistedSession(source: string | PersistedSession): StoredSession {
  let value: unknown = source;
  if (typeof source === "string") {
    try {
      value = JSON.parse(source) as unknown;
    } catch {
      throw new Error("DurableSession metadata contains invalid JSON.");
    }
  }
  const persisted = PersistedSessionSchema.parse(value);
  const command: CommandSpecV0 =
    persisted.command.kind === "profile"
      ? {
          kind: "profile",
          profileId: persisted.command.profileId,
          cwd: {
            rootId: persisted.command.rootId,
            relativePath: persisted.command.relativePath,
          },
          terminal: persisted.command.terminal,
        }
      : {
          kind: "exec",
          executable: `/__durable_session_unavailable__/${persisted.command.executableLabel}`,
          args: [],
          cwd: {
            rootId: persisted.command.rootId,
            relativePath: persisted.command.relativePath,
          },
          terminal: persisted.command.terminal,
          envPolicyId: "recovered-unavailable",
          resourcePolicyId: "recovered-unavailable",
        };
  const state: DurableSessionState = {
    sessionId: persisted.sessionId,
    command,
    lifecycle: persisted.lifecycle,
    sessionRevision: persisted.sessionRevision,
    runtimeId: persisted.runtimeId,
    terminal: { cols: persisted.terminal.cols, rows: persisted.terminal.rows },
    controllerAttachmentId: null,
    controllerGeneration: persisted.controllerGeneration,
    nextSequence: persisted.nextSequence,
    attachments: {},
    pendingControlRequests: {},
    activeControlOffer: null,
    lastRuntime: persisted.lastRuntime,
    createdAtMs: persisted.createdAtMs,
    updatedAtMs: persisted.updatedAtMs,
  };
  return { state, restartability: persisted.restartability };
}

function safeExecutableLabel(executable: string): string {
  const label = basename(executable) || "executable";
  return label.slice(0, 256) || "executable";
}
