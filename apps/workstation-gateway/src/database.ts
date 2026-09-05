import { chmodSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { assertPrivateRegularFile, ensurePrivateDirectory } from "./security.js";

const GATEWAY_DATABASE_VERSION = 1;
const MAX_PENDING_BOOTSTRAP_INTENTS = 64;
const MAX_PENDING_WEBAUTHN_CEREMONIES = 128;

export type BootstrapIntentKind = "bootstrap" | "recovery";
export type CeremonyKind = "registration" | "authentication";

export interface StoredBootstrapIntent {
  readonly intentId: string;
  readonly kind: BootstrapIntentKind;
  readonly origin: string;
  readonly expiresAt: number;
}

export interface StoredCeremony {
  readonly ceremonyId: string;
  readonly kind: CeremonyKind;
  readonly challengeDigest: string;
  readonly origin: string;
  readonly expiresAt: number;
  readonly bootstrapKind?: BootstrapIntentKind;
}

export interface StoredCredential {
  readonly credentialRecordId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array<ArrayBuffer>;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: number;
  readonly lastUsedAt?: number;
  readonly revokedAt?: number;
}

export interface NewCredential {
  readonly credentialRecordId: string;
  readonly credentialId: string;
  readonly publicKey: Uint8Array;
  readonly counter: number;
  readonly transports: readonly string[];
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: number;
}

export interface NewStoredSession {
  readonly sessionId: string;
  readonly tokenDigest: string;
  readonly csrfDigest: string;
  readonly subject: string;
  readonly credentialRecordId: string;
  readonly authTime: number;
  readonly createdAt: number;
  readonly lastSeenAt: number;
  readonly expiresAt: number;
}

export interface StoredSession extends NewStoredSession {
  readonly credentialId: string;
  readonly revokedAt?: number;
}

export interface CredentialRevocationResult {
  readonly credentialRevoked: boolean;
  readonly sessionIds: readonly string[];
}

interface BootstrapRow {
  intent_id: string;
  kind: string;
  origin: string;
  expires_at: number;
}

interface CeremonyRow {
  ceremony_id: string;
  kind: string;
  challenge_digest: string;
  origin: string;
  expires_at: number;
  bootstrap_kind: string | null;
}

interface CredentialRow {
  credential_record_id: string;
  credential_id: string;
  public_key: Buffer;
  counter: number;
  transports_json: string;
  device_type: string;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
}

interface SessionRow {
  session_id: string;
  token_digest: string;
  csrf_digest: string;
  subject: string;
  credential_record_id: string;
  credential_id: string;
  auth_time: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
}

export class GatewayRepository {
  readonly #database: Database.Database;
  #closed = false;

  constructor(path: string) {
    ensurePrivateDirectory(dirname(path));
    if (existsSync(path)) assertPrivateRegularFile(path);
    this.#database = new Database(path);
    chmodSync(path, 0o600);
    assertPrivateRegularFile(path);
    this.#database.pragma("journal_mode = DELETE");
    this.#database.pragma("foreign_keys = ON");
    this.#database.pragma("busy_timeout = 5000");
    this.#migrate();
  }

  ensureOwner(subject: string, userHandle: Uint8Array, now: number): Uint8Array<ArrayBuffer> {
    this.#assertOpen();
    const existing = this.#database
      .prepare("SELECT subject, user_handle FROM gateway_owner LIMIT 1")
      .get() as { subject: string; user_handle: Buffer } | undefined;
    if (existing !== undefined) {
      if (existing.subject !== subject) {
        throw new Error("Gateway owner subject does not match persisted private state.");
      }
      return ownedBytes(existing.user_handle);
    }
    this.#database
      .prepare("INSERT INTO gateway_owner (subject, user_handle, created_at) VALUES (?, ?, ?)")
      .run(subject, Buffer.from(userHandle), now);
    return ownedBytes(userHandle);
  }

  createBootstrapIntent(input: {
    intentId: string;
    codeDigest: string;
    kind: BootstrapIntentKind;
    origin: string;
    createdAt: number;
    expiresAt: number;
  }): void {
    this.#assertOpen();
    const create = this.#database.transaction(() => {
      this.#database
        .prepare("DELETE FROM bootstrap_intents WHERE consumed_at IS NOT NULL OR expires_at <= ?")
        .run(input.createdAt);
      const pending = this.#database
        .prepare("SELECT COUNT(*) AS count FROM bootstrap_intents WHERE consumed_at IS NULL")
        .get() as { count: number };
      if (pending.count >= MAX_PENDING_BOOTSTRAP_INTENTS) {
        throw new Error("Gateway bootstrap intent capacity was reached.");
      }
      this.#database
        .prepare(
          `INSERT INTO bootstrap_intents
            (intent_id, code_digest, kind, origin, created_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.intentId,
          input.codeDigest,
          input.kind,
          input.origin,
          input.createdAt,
          input.expiresAt,
        );
    });
    create();
  }

  consumeBootstrapIntent(
    codeDigest: string,
    origin: string,
    now: number,
  ): StoredBootstrapIntent | undefined {
    this.#assertOpen();
    const consume = this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT intent_id, kind, origin, expires_at
             FROM bootstrap_intents
            WHERE code_digest = ? AND consumed_at IS NULL`,
        )
        .get(codeDigest) as BootstrapRow | undefined;
      if (row === undefined) return undefined;
      const result = this.#database
        .prepare(
          `UPDATE bootstrap_intents
              SET consumed_at = ?
            WHERE intent_id = ? AND consumed_at IS NULL`,
        )
        .run(now, row.intent_id);
      if (result.changes !== 1) return undefined;
      if (row.origin !== origin || row.expires_at <= now) return undefined;
      return decodeBootstrap(row);
    });
    return consume();
  }

  createCeremony(input: {
    ceremonyId: string;
    kind: CeremonyKind;
    challengeDigest: string;
    origin: string;
    createdAt: number;
    expiresAt: number;
    bootstrapKind?: BootstrapIntentKind;
  }): void {
    this.#assertOpen();
    const create = this.#database.transaction(() => {
      this.#database
        .prepare("DELETE FROM webauthn_ceremonies WHERE consumed_at IS NOT NULL OR expires_at <= ?")
        .run(input.createdAt);
      const pending = this.#database
        .prepare("SELECT COUNT(*) AS count FROM webauthn_ceremonies WHERE consumed_at IS NULL")
        .get() as { count: number };
      if (pending.count >= MAX_PENDING_WEBAUTHN_CEREMONIES) {
        throw new Error("Gateway WebAuthn ceremony capacity was reached.");
      }
      this.#database
        .prepare(
          `INSERT INTO webauthn_ceremonies
            (ceremony_id, kind, challenge_digest, origin, created_at, expires_at, bootstrap_kind)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.ceremonyId,
          input.kind,
          input.challengeDigest,
          input.origin,
          input.createdAt,
          input.expiresAt,
          input.bootstrapKind ?? null,
        );
    });
    create();
  }

  consumeCeremony(
    ceremonyId: string,
    kind: CeremonyKind,
    origin: string,
    now: number,
  ): StoredCeremony | undefined {
    this.#assertOpen();
    const consume = this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          `SELECT ceremony_id, kind, challenge_digest, origin, expires_at, bootstrap_kind
             FROM webauthn_ceremonies
            WHERE ceremony_id = ? AND consumed_at IS NULL`,
        )
        .get(ceremonyId) as CeremonyRow | undefined;
      if (row === undefined) return undefined;
      const result = this.#database
        .prepare(
          `UPDATE webauthn_ceremonies
              SET consumed_at = ?
            WHERE ceremony_id = ? AND consumed_at IS NULL`,
        )
        .run(now, ceremonyId);
      if (result.changes !== 1) return undefined;
      if (row.kind !== kind || row.origin !== origin || row.expires_at <= now) return undefined;
      return decodeCeremony(row);
    });
    return consume();
  }

  countActiveCredentials(): number {
    this.#assertOpen();
    const row = this.#database
      .prepare("SELECT COUNT(*) AS count FROM passkey_credentials WHERE revoked_at IS NULL")
      .get() as { count: number };
    return row.count;
  }

  listActiveCredentials(): StoredCredential[] {
    this.#assertOpen();
    const rows = this.#database
      .prepare(
        `SELECT credential_record_id, credential_id, public_key, counter, transports_json,
                device_type, backed_up, created_at, last_used_at, revoked_at
           FROM passkey_credentials
          WHERE revoked_at IS NULL
          ORDER BY created_at, credential_record_id`,
      )
      .all() as CredentialRow[];
    return rows.map(decodeCredential);
  }

  getActiveCredentialByRawId(credentialId: string): StoredCredential | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT credential_record_id, credential_id, public_key, counter, transports_json,
                device_type, backed_up, created_at, last_used_at, revoked_at
           FROM passkey_credentials
          WHERE credential_id = ? AND revoked_at IS NULL`,
      )
      .get(credentialId) as CredentialRow | undefined;
    return row === undefined ? undefined : decodeCredential(row);
  }

  createCredential(input: NewCredential): void {
    this.#assertOpen();
    this.#database
      .prepare(
        `INSERT INTO passkey_credentials
          (credential_record_id, credential_id, public_key, counter, transports_json,
           device_type, backed_up, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.credentialRecordId,
        input.credentialId,
        Buffer.from(input.publicKey),
        input.counter,
        JSON.stringify(input.transports),
        input.deviceType,
        input.backedUp ? 1 : 0,
        input.createdAt,
      );
  }

  updateCredentialAfterAuthentication(input: {
    credentialRecordId: string;
    counter: number;
    deviceType: string;
    backedUp: boolean;
    now: number;
  }): boolean {
    this.#assertOpen();
    return (
      this.#database
        .prepare(
          `UPDATE passkey_credentials
              SET counter = ?, device_type = ?, backed_up = ?, last_used_at = ?
            WHERE credential_record_id = ? AND revoked_at IS NULL`,
        )
        .run(
          input.counter,
          input.deviceType,
          input.backedUp ? 1 : 0,
          input.now,
          input.credentialRecordId,
        ).changes === 1
    );
  }

  revokeCredential(credentialRecordId: string, now: number): CredentialRevocationResult {
    this.#assertOpen();
    const revoke = this.#database.transaction(() => {
      const credential = this.#database
        .prepare(
          `UPDATE passkey_credentials SET revoked_at = ?
            WHERE credential_record_id = ? AND revoked_at IS NULL`,
        )
        .run(now, credentialRecordId);
      if (credential.changes !== 1) {
        return { credentialRevoked: false, sessionIds: [] };
      }
      const sessions = this.#database
        .prepare(
          `SELECT session_id FROM browser_sessions
            WHERE credential_record_id = ? AND revoked_at IS NULL`,
        )
        .all(credentialRecordId) as { session_id: string }[];
      this.#database
        .prepare(
          `UPDATE browser_sessions SET revoked_at = ?
            WHERE credential_record_id = ? AND revoked_at IS NULL`,
        )
        .run(now, credentialRecordId);
      return {
        credentialRevoked: true,
        sessionIds: sessions.map((session) => session.session_id),
      };
    });
    return revoke();
  }

  createSession(input: NewStoredSession): void {
    this.#assertOpen();
    const create = this.#database.transaction(() => {
      this.#database
        .prepare("DELETE FROM browser_sessions WHERE revoked_at IS NOT NULL OR expires_at <= ?")
        .run(input.createdAt);
      this.#database
        .prepare(
          `INSERT INTO browser_sessions
            (session_id, token_digest, csrf_digest, subject, credential_record_id,
             auth_time, created_at, last_seen_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.sessionId,
          input.tokenDigest,
          input.csrfDigest,
          input.subject,
          input.credentialRecordId,
          input.authTime,
          input.createdAt,
          input.lastSeenAt,
          input.expiresAt,
        );
    });
    create();
  }

  getSessionByTokenDigest(tokenDigest: string): StoredSession | undefined {
    this.#assertOpen();
    const row = this.#database
      .prepare(
        `SELECT s.session_id, s.token_digest, s.csrf_digest, s.subject,
                s.credential_record_id, c.credential_id, s.auth_time, s.created_at,
                s.last_seen_at, s.expires_at, s.revoked_at
           FROM browser_sessions s
           JOIN passkey_credentials c ON c.credential_record_id = s.credential_record_id
          WHERE s.token_digest = ?`,
      )
      .get(tokenDigest) as SessionRow | undefined;
    return row === undefined ? undefined : decodeSession(row);
  }

  updateSessionActivity(sessionId: string, now: number): boolean {
    this.#assertOpen();
    return (
      this.#database
        .prepare(
          `UPDATE browser_sessions SET last_seen_at = ?
            WHERE session_id = ? AND revoked_at IS NULL`,
        )
        .run(now, sessionId).changes === 1
    );
  }

  updateSessionCsrf(sessionId: string, csrfDigest: string): boolean {
    this.#assertOpen();
    return (
      this.#database
        .prepare(
          `UPDATE browser_sessions SET csrf_digest = ?
            WHERE session_id = ? AND revoked_at IS NULL`,
        )
        .run(csrfDigest, sessionId).changes === 1
    );
  }

  revokeSessionByTokenDigest(tokenDigest: string, now: number): string | undefined {
    this.#assertOpen();
    const revoke = this.#database.transaction(() => {
      const row = this.#database
        .prepare(
          "SELECT session_id FROM browser_sessions WHERE token_digest = ? AND revoked_at IS NULL",
        )
        .get(tokenDigest) as { session_id: string } | undefined;
      if (row === undefined) return undefined;
      const result = this.#database
        .prepare(
          "UPDATE browser_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
        )
        .run(now, row.session_id);
      return result.changes === 1 ? row.session_id : undefined;
    });
    return revoke();
  }

  revokeSessionById(sessionId: string, now: number): boolean {
    this.#assertOpen();
    return (
      this.#database
        .prepare(
          "UPDATE browser_sessions SET revoked_at = ? WHERE session_id = ? AND revoked_at IS NULL",
        )
        .run(now, sessionId).changes === 1
    );
  }

  ping(): boolean {
    if (this.#closed) return false;
    return (this.#database.prepare("SELECT 1 AS ok").get() as { ok: number }).ok === 1;
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#database.close();
  }

  #migrate(): void {
    const version = this.#database.pragma("user_version", { simple: true }) as number;
    if (version > GATEWAY_DATABASE_VERSION) {
      throw new Error("Gateway database was created by a newer schema version.");
    }
    if (version === 0) {
      this.#database.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE gateway_owner (
          subject TEXT PRIMARY KEY NOT NULL,
          user_handle BLOB NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE bootstrap_intents (
          intent_id TEXT PRIMARY KEY NOT NULL,
          code_digest TEXT NOT NULL UNIQUE,
          kind TEXT NOT NULL CHECK (kind IN ('bootstrap', 'recovery')),
          origin TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER
        );
        CREATE TABLE webauthn_ceremonies (
          ceremony_id TEXT PRIMARY KEY NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('registration', 'authentication')),
          challenge_digest TEXT NOT NULL,
          origin TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          consumed_at INTEGER,
          bootstrap_kind TEXT CHECK (bootstrap_kind IN ('bootstrap', 'recovery'))
        );
        CREATE TABLE passkey_credentials (
          credential_record_id TEXT PRIMARY KEY NOT NULL,
          credential_id TEXT NOT NULL UNIQUE,
          public_key BLOB NOT NULL,
          counter INTEGER NOT NULL,
          transports_json TEXT NOT NULL,
          device_type TEXT NOT NULL,
          backed_up INTEGER NOT NULL CHECK (backed_up IN (0, 1)),
          created_at INTEGER NOT NULL,
          last_used_at INTEGER,
          revoked_at INTEGER
        );
        CREATE TABLE browser_sessions (
          session_id TEXT PRIMARY KEY NOT NULL,
          token_digest TEXT NOT NULL UNIQUE,
          csrf_digest TEXT NOT NULL,
          subject TEXT NOT NULL REFERENCES gateway_owner(subject),
          credential_record_id TEXT NOT NULL REFERENCES passkey_credentials(credential_record_id),
          auth_time INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          last_seen_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER
        );
        CREATE INDEX browser_sessions_credential
          ON browser_sessions(credential_record_id, revoked_at);
        PRAGMA user_version = 1;
        COMMIT;
      `);
    }
  }

  #assertOpen(): void {
    if (this.#closed) throw new Error("Gateway repository is closed.");
  }
}

function decodeBootstrap(row: BootstrapRow): StoredBootstrapIntent {
  if (row.kind !== "bootstrap" && row.kind !== "recovery") {
    throw new Error("Gateway bootstrap state is invalid.");
  }
  return { intentId: row.intent_id, kind: row.kind, origin: row.origin, expiresAt: row.expires_at };
}

function decodeCeremony(row: CeremonyRow): StoredCeremony {
  if (row.kind !== "registration" && row.kind !== "authentication") {
    throw new Error("Gateway ceremony state is invalid.");
  }
  const bootstrapKind = decodeOptionalBootstrapKind(row.bootstrap_kind);
  return {
    ceremonyId: row.ceremony_id,
    kind: row.kind,
    challengeDigest: row.challenge_digest,
    origin: row.origin,
    expiresAt: row.expires_at,
    ...(bootstrapKind === undefined ? {} : { bootstrapKind }),
  };
}

function decodeCredential(row: CredentialRow): StoredCredential {
  const transports = JSON.parse(row.transports_json) as unknown;
  if (!Array.isArray(transports) || !transports.every((value) => typeof value === "string")) {
    throw new Error("Gateway passkey transport state is invalid.");
  }
  return {
    credentialRecordId: row.credential_record_id,
    credentialId: row.credential_id,
    publicKey: ownedBytes(row.public_key),
    counter: row.counter,
    transports,
    deviceType: row.device_type,
    backedUp: row.backed_up === 1,
    createdAt: row.created_at,
    ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function decodeSession(row: SessionRow): StoredSession {
  return {
    sessionId: row.session_id,
    tokenDigest: row.token_digest,
    csrfDigest: row.csrf_digest,
    subject: row.subject,
    credentialRecordId: row.credential_record_id,
    credentialId: row.credential_id,
    authTime: row.auth_time,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at }),
  };
}

function decodeOptionalBootstrapKind(value: string | null): BootstrapIntentKind | undefined {
  if (value === null) return undefined;
  if (value === "bootstrap" || value === "recovery") return value;
  throw new Error("Gateway ceremony bootstrap state is invalid.");
}

function ownedBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength));
  copy.set(value);
  return copy;
}
