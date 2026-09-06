import type { IncomingHttpHeaders } from "node:http";
import { WORKSTATION_GATEWAY_CSRF_HEADER } from "@naru/contracts/workstation-gateway/v1";

export const GATEWAY_BROWSER_LIMITS = {
  headerBytes: 16 * 1_024,
  headerCount: 64,
  headersTimeoutMs: 5_000,
  requestTimeoutMs: 30_000,
  keepAliveTimeoutMs: 5_000,
  requestsPerSocket: 100,
  authenticationAttemptsPerSource: 20,
  authenticationAttemptsGlobal: 100,
  authenticationWindowMs: 60_000,
  authenticationSourceBuckets: 256,
} as const;

const RESERVED_EXACT_HEADERS = new Set([
  "authorization",
  "expect",
  "forwarded",
  "remote-user",
  "x-real-ip",
  "x-ms-client-principal",
]);

const RESERVED_HEADER_PREFIXES = [
  "cf-access-",
  "x-amzn-oidc-",
  "x-auth-",
  "x-authenticated-",
  "x-consumer-",
  "x-forwarded-",
  "x-gateway-",
  "x-goog-authenticated-",
  "x-identity-",
  "x-ms-client-principal-",
  "x-oidc-",
  "x-original-",
  "x-pomerium-",
  "x-remote-",
  "x-ssl-client-",
  "x-tailscale-",
  "x-user-",
  "x-workstation-gateway-",
  "x-durable-session-",
  "x-capability-",
];

interface AuthenticationSourceBucket {
  readonly attempts: number[];
  lastSeenAt: number;
}

export class GatewayAuthenticationRateLimiter {
  readonly #sources = new Map<string, AuthenticationSourceBucket>();
  #globalAttempts: number[] = [];

  consume(remoteAddress: string | undefined, nowMs: number): boolean {
    this.#globalAttempts = activeAttempts(this.#globalAttempts, nowMs);
    if (this.#globalAttempts.length >= GATEWAY_BROWSER_LIMITS.authenticationAttemptsGlobal) {
      return false;
    }

    const key = remoteAddress ?? "[unknown-source]";
    let bucket = this.#sources.get(key);
    if (bucket === undefined) {
      this.#makeSourceRoom(nowMs);
      bucket = { attempts: [], lastSeenAt: nowMs };
      this.#sources.set(key, bucket);
    }
    const sourceAttempts = activeAttempts(bucket.attempts, nowMs);
    bucket.attempts.length = 0;
    bucket.attempts.push(...sourceAttempts);
    bucket.lastSeenAt = nowMs;
    if (bucket.attempts.length >= GATEWAY_BROWSER_LIMITS.authenticationAttemptsPerSource) {
      return false;
    }

    bucket.attempts.push(nowMs);
    this.#globalAttempts.push(nowMs);
    return true;
  }

  #makeSourceRoom(nowMs: number): void {
    for (const [key, bucket] of this.#sources) {
      if (activeAttempts(bucket.attempts, nowMs).length === 0) this.#sources.delete(key);
    }
    if (this.#sources.size < GATEWAY_BROWSER_LIMITS.authenticationSourceBuckets) return;

    let oldestKey: string | undefined;
    let oldestSeenAt = Number.POSITIVE_INFINITY;
    for (const [key, bucket] of this.#sources) {
      if (bucket.lastSeenAt < oldestSeenAt) {
        oldestKey = key;
        oldestSeenAt = bucket.lastSeenAt;
      }
    }
    if (oldestKey !== undefined) this.#sources.delete(oldestKey);
  }
}

export function hasReservedIdentityHeader(headers: IncomingHttpHeaders): boolean {
  return Object.keys(headers).some((header) => {
    const name = header.toLowerCase();
    if (name === WORKSTATION_GATEWAY_CSRF_HEADER) return false;
    return isReservedIdentityHeaderName(name);
  });
}

export function isReservedIdentityHeaderName(header: string): boolean {
  const name = header.toLowerCase();
  return (
    RESERVED_EXACT_HEADERS.has(name) ||
    RESERVED_HEADER_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

export function rawHeaderBytes(rawHeaders: readonly string[]): number {
  let bytes = 2;
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index] ?? "";
    const value = rawHeaders[index + 1] ?? "";
    bytes += Buffer.byteLength(name) + 2 + Buffer.byteLength(value) + 2;
  }
  return bytes;
}

function activeAttempts(attempts: readonly number[], nowMs: number): number[] {
  const start = nowMs - GATEWAY_BROWSER_LIMITS.authenticationWindowMs;
  return attempts.filter((attempt) => attempt > start);
}
