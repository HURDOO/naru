import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import Database from "better-sqlite3";

const BACKUP_FORMAT_VERSION = 1;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

export interface DatabaseInspection {
  integrity: "ok";
  schemaVersion: number;
  sizeBytes: number;
  sha256: string;
}

export interface DatabaseBackupManifest extends DatabaseInspection {
  formatVersion: number;
  createdAt: string;
  buildId: string;
  sourceFilename: string;
  backupFilename: string;
}

export interface DatabaseBackupResult {
  backupFile: string;
  manifestFile: string;
  manifest: DatabaseBackupManifest;
}

export function createDatabaseBackup(
  database: Database.Database,
  sourceFilename: string,
  backupDirectory: string,
  buildId: string,
  label = "backup",
): DatabaseBackupResult {
  assertAbsolutePath(sourceFilename, "database filename");
  assertAbsolutePath(backupDirectory, "backup directory");
  assertSafeIdentifier(buildId, "build ID");
  assertSafeIdentifier(label, "backup label");
  ensurePrivateDirectory(backupDirectory);

  const timestamp = new Date().toISOString().replaceAll(":", "-");
  const uniqueSuffix = randomUUID().slice(0, 8);
  const backupFilename = `naru-${label}-${timestamp}-${uniqueSuffix}.sqlite`;
  const backupFile = join(backupDirectory, backupFilename);
  const partialFile = `${backupFile}.partial`;

  let inspection: DatabaseInspection;
  try {
    database.prepare("VACUUM INTO ?").run(partialFile);
    chmodSync(partialFile, PRIVATE_FILE_MODE);
    inspection = inspectDatabaseFile(partialFile);
    renameSync(partialFile, backupFile);
  } catch (error) {
    rmSync(partialFile, { force: true });
    throw error;
  }

  const manifest: DatabaseBackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    createdAt: new Date().toISOString(),
    buildId,
    sourceFilename: basename(sourceFilename),
    backupFilename,
    ...inspection,
  };
  const manifestFile = `${backupFile}.manifest.json`;
  writePrivateJson(manifestFile, manifest);
  return { backupFile, manifestFile, manifest };
}

export function createDatabaseBackupFromFile(
  sourceFilename: string,
  backupDirectory: string,
  buildId: string,
  label = "backup",
): DatabaseBackupResult {
  assertRegularDatabaseFile(sourceFilename);
  const database = new Database(sourceFilename, { readonly: true, fileMustExist: true });
  try {
    database.pragma("busy_timeout = 5000");
    return createDatabaseBackup(database, sourceFilename, backupDirectory, buildId, label);
  } finally {
    database.close();
  }
}

export function createPreMigrationBackupIfNeeded(
  database: Database.Database,
  sourceFilename: string,
  targetSchemaVersion: number,
): DatabaseBackupResult | undefined {
  const currentSchemaVersion = readSchemaVersion(database);
  if (
    currentSchemaVersion >= targetSchemaVersion ||
    !databaseHasPersistentApplicationState(database)
  ) {
    return undefined;
  }

  return createDatabaseBackup(
    database,
    sourceFilename,
    join(dirname(sourceFilename), "backups"),
    `schema-v${currentSchemaVersion}`,
    `pre-migration-v${currentSchemaVersion}-to-v${targetSchemaVersion}`,
  );
}

export function inspectDatabaseFile(filename: string): DatabaseInspection {
  assertRegularDatabaseFile(filename);
  const database = new Database(filename, { readonly: true, fileMustExist: true });
  try {
    const integrity = database.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error("SQLite integrity_check failed.");
    return {
      integrity: "ok",
      schemaVersion: readSchemaVersion(database),
      sizeBytes: statSync(filename).size,
      sha256: sha256File(filename),
    };
  } finally {
    database.close();
  }
}

export function verifyDatabaseBackup(backupFile: string): DatabaseBackupManifest {
  const manifestFile = `${backupFile}.manifest.json`;
  if (!existsSync(manifestFile)) throw new Error("Database backup manifest is missing.");
  const manifest = parseBackupManifest(JSON.parse(readFileSync(manifestFile, "utf8")) as unknown);
  if (manifest.backupFilename !== basename(backupFile)) {
    throw new Error("Database backup manifest filename does not match.");
  }
  const inspection = inspectDatabaseFile(backupFile);
  if (
    inspection.sha256 !== manifest.sha256 ||
    inspection.sizeBytes !== manifest.sizeBytes ||
    inspection.schemaVersion !== manifest.schemaVersion
  ) {
    throw new Error("Database backup does not match its manifest.");
  }
  return manifest;
}

export function restoreDatabaseBackup(
  backupFile: string,
  targetDataDirectory: string,
): { databaseFile: string; manifest: DatabaseBackupManifest } {
  assertAbsolutePath(backupFile, "backup filename");
  assertAbsolutePath(targetDataDirectory, "target data directory");
  const manifest = verifyDatabaseBackup(backupFile);
  ensurePrivateDirectory(targetDataDirectory);

  const databaseFile = join(targetDataDirectory, "naru.sqlite");
  for (const candidate of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
    if (existsSync(candidate)) {
      throw new Error(
        "Restore target already contains a Naru database; restore is non-overwriting.",
      );
    }
  }

  const partialFile = `${databaseFile}.restore-${randomUUID()}`;
  try {
    copyFileSync(backupFile, partialFile, constants.COPYFILE_EXCL);
    chmodSync(partialFile, PRIVATE_FILE_MODE);
    inspectDatabaseFile(partialFile);
    renameSync(partialFile, databaseFile);
  } catch (error) {
    rmSync(partialFile, { force: true });
    throw error;
  }
  return { databaseFile, manifest };
}

export function readSchemaVersion(database: Database.Database): number {
  if (!hasTable(database, "schema_migrations")) return 0;
  return database
    .prepare("SELECT COALESCE(MAX(version), 0) FROM schema_migrations")
    .pluck()
    .get() as number;
}

function databaseHasPersistentApplicationState(database: Database.Database): boolean {
  const row = database
    .prepare(
      `SELECT COUNT(*) AS count
       FROM sqlite_master
       WHERE type = 'table'
         AND name NOT LIKE 'sqlite_%'
         AND name <> 'schema_migrations'`,
    )
    .get() as { count: number };
  return row.count > 0;
}

function hasTable(database: Database.Database, table: string): boolean {
  return (
    database
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .pluck()
      .get(table) === 1
  );
}

function parseBackupManifest(value: unknown): DatabaseBackupManifest {
  if (typeof value !== "object" || value === null) throw new Error("Invalid backup manifest.");
  const manifest = value as Partial<DatabaseBackupManifest>;
  if (
    manifest.formatVersion !== BACKUP_FORMAT_VERSION ||
    typeof manifest.createdAt !== "string" ||
    typeof manifest.buildId !== "string" ||
    typeof manifest.sourceFilename !== "string" ||
    typeof manifest.backupFilename !== "string" ||
    manifest.integrity !== "ok" ||
    !Number.isInteger(manifest.schemaVersion) ||
    typeof manifest.sizeBytes !== "number" ||
    !Number.isFinite(manifest.sizeBytes) ||
    manifest.sizeBytes < 0 ||
    typeof manifest.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(manifest.sha256)
  ) {
    throw new Error("Invalid backup manifest.");
  }
  return manifest as DatabaseBackupManifest;
}

function assertRegularDatabaseFile(filename: string): void {
  assertAbsolutePath(filename, "database filename");
  const metadata = lstatSync(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("Database must be a regular file, not a symbolic link.");
  }
}

function ensurePrivateDirectory(directory: string): void {
  const existed = existsSync(directory);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  if (!existed) chmodSync(directory, PRIVATE_DIRECTORY_MODE);
  const metadata = lstatSync(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Operations directory must be a regular directory, not a symbolic link.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("Operations directory permissions must be 0700 or stricter.");
  }
}

function writePrivateJson(filename: string, value: unknown): void {
  const partialFile = `${filename}.partial-${randomUUID()}`;
  try {
    writeFileSync(partialFile, `${JSON.stringify(value, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: PRIVATE_FILE_MODE,
    });
    renameSync(partialFile, filename);
  } catch (error) {
    rmSync(partialFile, { force: true });
    throw error;
  }
}

function sha256File(filename: string): string {
  return createHash("sha256").update(readFileSync(filename)).digest("hex");
}

function assertAbsolutePath(value: string, name: string): void {
  if (!isAbsolute(value)) throw new Error(`${name} must be an absolute path.`);
}

function assertSafeIdentifier(value: string, name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) {
    throw new Error(`${name} contains unsupported characters.`);
  }
}
