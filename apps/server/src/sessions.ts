import { createHmac, randomBytes } from "node:crypto";

export interface Session {
  csrfToken: string;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
}

export interface CreatedSession extends Session {
  token: string;
}

export class SessionStore {
  readonly #sessions = new Map<string, Session>();
  readonly #secret: string;
  readonly #absoluteTtlMs: number;
  readonly #idleTtlMs: number;

  constructor(secret: string, absoluteTtlMs = 8 * 60 * 60 * 1000, idleTtlMs = 60 * 60 * 1000) {
    this.#secret = secret;
    this.#absoluteTtlMs = absoluteTtlMs;
    this.#idleTtlMs = idleTtlMs;
  }

  create(now = Date.now()): CreatedSession {
    const token = randomBytes(32).toString("base64url");
    const session: Session = {
      csrfToken: randomBytes(24).toString("base64url"),
      createdAt: now,
      lastSeenAt: now,
      expiresAt: now + this.#absoluteTtlMs,
    };
    this.#sessions.set(this.#digest(token), session);
    return { token, ...session };
  }

  get(token: string | undefined, now = Date.now()): Session | undefined {
    if (!token) return undefined;
    const key = this.#digest(token);
    const session = this.#sessions.get(key);
    if (!session) return undefined;
    if (now >= session.expiresAt || now - session.lastSeenAt >= this.#idleTtlMs) {
      this.#sessions.delete(key);
      return undefined;
    }
    session.lastSeenAt = now;
    return session;
  }

  delete(token: string | undefined): void {
    if (token) this.#sessions.delete(this.#digest(token));
  }

  count(now = Date.now()): number {
    for (const [key, session] of this.#sessions) {
      if (now >= session.expiresAt || now - session.lastSeenAt >= this.#idleTtlMs) {
        this.#sessions.delete(key);
      }
    }
    return this.#sessions.size;
  }

  #digest(token: string): string {
    return createHmac("sha256", this.#secret).update(token).digest("base64url");
  }
}

export class LoginRateLimiter {
  readonly #attempts = new Map<string, number[]>();

  constructor(
    private readonly limit = 5,
    private readonly windowMs = 60_000,
  ) {}

  canAttempt(key: string, now = Date.now()): boolean {
    const active = this.#activeAttempts(key, now);
    return active.length < this.limit;
  }

  recordFailure(key: string, now = Date.now()): void {
    const active = this.#activeAttempts(key, now);
    active.push(now);
    this.#attempts.set(key, active);
  }

  clear(key: string): void {
    this.#attempts.delete(key);
  }

  #activeAttempts(key: string, now: number): number[] {
    const start = now - this.windowMs;
    const active = (this.#attempts.get(key) ?? []).filter((attempt) => attempt > start);
    if (active.length === 0) this.#attempts.delete(key);
    else this.#attempts.set(key, active);
    return active;
  }
}
