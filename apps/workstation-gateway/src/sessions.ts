import { createHmac, randomBytes, randomUUID } from "node:crypto";
import type { WorkstationGatewayConfig } from "./config.js";
import type { CredentialRevocationResult, GatewayRepository, StoredSession } from "./database.js";
import { secretEqual } from "./security.js";

export interface GatewayClock {
  nowMs(): number;
}

export class SystemGatewayClock implements GatewayClock {
  nowMs(): number {
    return Date.now();
  }
}

export interface AuthenticatedGatewaySession {
  readonly sessionId: string;
  readonly subject: string;
  readonly credentialRecordId: string;
  readonly credentialId: string;
  readonly authTime: number;
  readonly expiresAt: number;
  readonly idleExpiresAt: number;
}

export interface CreatedGatewaySession extends AuthenticatedGatewaySession {
  readonly token: string;
  readonly csrfToken: string;
}

export class GatewaySessionStore {
  readonly #absoluteTtlMs: number;
  readonly #idleTtlMs: number;

  constructor(
    private readonly repository: GatewayRepository,
    private readonly digestKey: Buffer,
    config: Pick<WorkstationGatewayConfig, "sessionAbsoluteTtlMs" | "sessionIdleTtlMs">,
    private readonly clock: GatewayClock = new SystemGatewayClock(),
  ) {
    this.#absoluteTtlMs = config.sessionAbsoluteTtlMs;
    this.#idleTtlMs = config.sessionIdleTtlMs;
  }

  create(input: {
    subject: string;
    credentialRecordId: string;
    credentialId: string;
    authTime: number;
  }): CreatedGatewaySession {
    const now = this.clock.nowMs();
    const token = randomBytes(32).toString("base64url");
    const csrfToken = randomBytes(24).toString("base64url");
    const stored = {
      sessionId: randomUUID(),
      tokenDigest: this.#digest("session", token),
      csrfDigest: this.#digest("csrf", csrfToken),
      subject: input.subject,
      credentialRecordId: input.credentialRecordId,
      authTime: input.authTime,
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.#absoluteTtlMs,
    };
    this.repository.createSession(stored);
    return {
      token,
      csrfToken,
      sessionId: stored.sessionId,
      subject: stored.subject,
      credentialRecordId: stored.credentialRecordId,
      credentialId: input.credentialId,
      authTime: stored.authTime,
      expiresAt: stored.expiresAt,
      idleExpiresAt: now + this.#idleTtlMs,
    };
  }

  authenticate(token: string | undefined): AuthenticatedGatewaySession | undefined {
    if (token === undefined || token.length < 32 || token.length > 1_024) return undefined;
    const now = this.clock.nowMs();
    const stored = this.repository.getSessionByTokenDigest(this.#digest("session", token));
    if (stored === undefined || stored.revokedAt !== undefined) return undefined;
    const idleExpiresAt = stored.lastSeenAt + this.#idleTtlMs;
    if (now >= stored.expiresAt || now >= idleExpiresAt) {
      this.repository.revokeSessionById(stored.sessionId, now);
      return undefined;
    }
    if (!this.repository.updateSessionActivity(stored.sessionId, now)) return undefined;
    return this.#view(stored, Math.min(stored.expiresAt, now + this.#idleTtlMs));
  }

  rotateCsrf(session: AuthenticatedGatewaySession): string {
    const csrfToken = randomBytes(24).toString("base64url");
    if (!this.repository.updateSessionCsrf(session.sessionId, this.#digest("csrf", csrfToken))) {
      throw new Error("Gateway browser session disappeared during CSRF rotation.");
    }
    return csrfToken;
  }

  verifyCsrf(token: string | undefined, candidate: string | undefined): boolean {
    if (token === undefined || candidate === undefined || candidate.length > 1_024) return false;
    const stored = this.repository.getSessionByTokenDigest(this.#digest("session", token));
    return stored !== undefined && secretEqual(stored.csrfDigest, this.#digest("csrf", candidate));
  }

  revoke(token: string | undefined): string | undefined {
    if (token === undefined || token.length > 1_024) return undefined;
    return this.repository.revokeSessionByTokenDigest(
      this.#digest("session", token),
      this.clock.nowMs(),
    );
  }

  revokeCredential(credentialRecordId: string): CredentialRevocationResult {
    return this.repository.revokeCredential(credentialRecordId, this.clock.nowMs());
  }

  #view(stored: StoredSession, idleExpiresAt: number): AuthenticatedGatewaySession {
    return {
      sessionId: stored.sessionId,
      subject: stored.subject,
      credentialRecordId: stored.credentialRecordId,
      credentialId: stored.credentialId,
      authTime: stored.authTime,
      expiresAt: stored.expiresAt,
      idleExpiresAt,
    };
  }

  #digest(purpose: "session" | "csrf", value: string): string {
    return createHmac("sha256", this.digestKey)
      .update(purpose)
      .update("\0")
      .update(value)
      .digest("base64url");
  }
}
