import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  createDatabaseBackupFromFile,
  restoreDatabaseBackup,
  verifyDatabaseBackup,
} from "../src/database-backup.js";
import { DATABASE_MIGRATIONS, NaruRepository, runDatabaseMigrations } from "../src/database.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("database backup and restore", () => {
  it("creates a verified online backup and restores only into an empty target", () => {
    const root = temporaryDirectory();
    const dataDirectory = privateDirectory(root, "data");
    const backupDirectory = privateDirectory(root, "backups");
    const sourceFile = join(dataDirectory, "naru.sqlite");
    const repository = new NaruRepository(sourceFile);
    const project = repository.createProject("/tmp/naru-backup", "backup-project");
    repository.close();

    const backup = createDatabaseBackupFromFile(sourceFile, backupDirectory, "build-123");
    expect(verifyDatabaseBackup(backup.backupFile)).toMatchObject({
      buildId: "build-123",
      integrity: "ok",
      schemaVersion: DATABASE_MIGRATIONS.length,
    });

    const restoreDirectory = join(root, "restored");
    const restored = restoreDatabaseBackup(backup.backupFile, restoreDirectory);
    const restoredRepository = new NaruRepository(restored.databaseFile);
    expect(restoredRepository.listProjects()).toEqual([project]);
    restoredRepository.close();
    expect(() => restoreDatabaseBackup(backup.backupFile, restoreDirectory)).toThrow(
      /non-overwriting/,
    );

    appendFileSync(backup.backupFile, "tampered");
    expect(() => verifyDatabaseBackup(backup.backupFile)).toThrow(/does not match/);
  });

  it("backs up schema v2 before migration and restores a DB accepted by the previous build", () => {
    const root = temporaryDirectory();
    const dataDirectory = privateDirectory(root, "data");
    const sourceFile = join(dataDirectory, "naru.sqlite");
    const legacy = new Database(sourceFile);
    runDatabaseMigrations(legacy, DATABASE_MIGRATIONS.slice(0, 2));
    legacy
      .prepare(
        `INSERT INTO projects (id, name, real_path, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run("legacy-id", "legacy", "/tmp/legacy", "before", "before");
    legacy
      .prepare(
        `INSERT INTO workspaces
          (project_id, version, layout_json, active_pane_id, updated_at, schema_version)
         VALUES (?, 0, NULL, NULL, ?, 1)`,
      )
      .run("legacy-id", "before");
    legacy.close();

    const migrated = new NaruRepository(sourceFile);
    expect(migrated.isReady()).toBe(true);
    expect(migrated.listProjects()).toHaveLength(1);
    migrated.close();

    const automaticBackupDirectory = join(dataDirectory, "backups");
    const backupFile = readdirSync(automaticBackupDirectory)
      .filter((entry) => entry.endsWith(".sqlite"))
      .map((entry) => join(automaticBackupDirectory, entry))[0];
    expect(backupFile).toBeDefined();
    const manifest = verifyDatabaseBackup(backupFile as string);
    expect(manifest).toMatchObject({
      buildId: "schema-v2",
      schemaVersion: 2,
    });

    const rollback = restoreDatabaseBackup(backupFile as string, join(root, "rollback"));
    const previousBuildDatabase = new Database(rollback.databaseFile);
    expect(() =>
      runDatabaseMigrations(previousBuildDatabase, DATABASE_MIGRATIONS.slice(0, 2)),
    ).not.toThrow();
    expect(
      previousBuildDatabase.prepare("SELECT name FROM projects WHERE id = 'legacy-id'").get(),
    ).toEqual({ name: "legacy" });
    expect(
      previousBuildDatabase
        .prepare("SELECT COUNT(*) FROM pragma_table_info('panes') WHERE name = 'codex_session_id'")
        .pluck()
        .get(),
    ).toBe(0);
    previousBuildDatabase.close();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(realpathSync(tmpdir()), "naru-backup-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

function privateDirectory(parent: string, name: string): string {
  const directory = join(parent, name);
  mkdirSync(directory, { mode: 0o700 });
  return directory;
}
