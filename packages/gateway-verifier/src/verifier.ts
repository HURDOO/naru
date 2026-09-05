import { sign, verify, type KeyObject } from "node:crypto";
import {
  GatewayPrincipalV1Schema,
  type GatewayPrincipalV1,
} from "@naru/contracts/workstation-gateway/v1";

export const GATEWAY_ASSERTION_PREFIX = "naru-gw-v1" as const;

export const GATEWAY_ASSERTION_LIMITS = {
  assertionCharacters: 32_768,
  keyIdCharacters: 128,
  payloadBytes: 16_384,
  signatureBytes: 64,
  clockSkewSeconds: 5,
  principalTtlSeconds: 60,
  replayEntries: 10_000,
} as const;

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const KEY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/;

export type GatewayVerificationKey = KeyObject | string | Buffer;
export type GatewayVerificationKeyResolver = (keyId: string) => GatewayVerificationKey | undefined;

export type GatewayReplayClaimResult = "accepted" | "replayed" | "capacity-exceeded";

export interface GatewayAssertionReplayStore {
  claim(key: string, expiresAt: number, now: number): GatewayReplayClaimResult;
}

export interface GatewayAssertionParts {
  readonly keyId: string;
  readonly encodedPayload: string;
  readonly payloadBytes: Buffer;
  readonly signature: Buffer;
  readonly principal: GatewayPrincipalV1;
}

export interface GatewayAssertionVerifierOptions {
  readonly expectedIssuer: string;
  readonly expectedAudience: string;
  readonly expectedOrigin: string;
  readonly resolveKey: GatewayVerificationKeyResolver;
  readonly replayStore: GatewayAssertionReplayStore;
  readonly now?: () => number;
  readonly clockSkewSeconds?: number;
  readonly maxPrincipalTtlSeconds?: number;
}

export interface GatewayAssertionVerification {
  readonly keyId: string;
  readonly principal: GatewayPrincipalV1;
}

export type GatewayAssertionErrorCode =
  | "ASSERTION_MALFORMED"
  | "ASSERTION_KEY_UNKNOWN"
  | "ASSERTION_SIGNATURE_INVALID"
  | "ASSERTION_ISSUER_MISMATCH"
  | "ASSERTION_AUDIENCE_MISMATCH"
  | "ASSERTION_ORIGIN_MISMATCH"
  | "ASSERTION_NOT_YET_VALID"
  | "ASSERTION_EXPIRED"
  | "ASSERTION_TTL_INVALID"
  | "ASSERTION_REPLAYED"
  | "ASSERTION_REPLAY_CACHE_FULL";

export class GatewayAssertionError extends Error {
  constructor(readonly code: GatewayAssertionErrorCode) {
    super(publicMessage(code));
    this.name = "GatewayAssertionError";
  }
}

export class InMemoryGatewayReplayStore implements GatewayAssertionReplayStore {
  readonly #claims = new Map<string, number>();

  constructor(private readonly capacity: number = GATEWAY_ASSERTION_LIMITS.replayEntries) {
    if (!Number.isSafeInteger(capacity) || capacity < 1) {
      throw new Error("Gateway replay capacity must be a positive safe integer.");
    }
  }

  claim(key: string, expiresAt: number, now: number): GatewayReplayClaimResult {
    assertEpochSeconds(now, "replay clock");
    assertEpochSeconds(expiresAt, "replay expiry");
    this.#prune(now);
    if (this.#claims.has(key)) return "replayed";
    if (this.#claims.size >= this.capacity) return "capacity-exceeded";
    this.#claims.set(key, expiresAt);
    return "accepted";
  }

  get size(): number {
    return this.#claims.size;
  }

  #prune(now: number): void {
    for (const [key, expiresAt] of this.#claims) {
      if (expiresAt <= now) this.#claims.delete(key);
    }
  }
}

export function createGatewayAssertion(
  principalInput: GatewayPrincipalV1,
  keyId: string,
  privateKey: GatewayVerificationKey,
): string {
  const principal = GatewayPrincipalV1Schema.parse(principalInput);
  assertKeyId(keyId);
  const encodedPayload = Buffer.from(JSON.stringify(principal), "utf8").toString("base64url");
  const signature = sign(null, gatewayAssertionSigningInput(keyId, encodedPayload), privateKey);
  if (signature.byteLength !== GATEWAY_ASSERTION_LIMITS.signatureBytes) {
    throw new Error("Gateway assertion signing key must be Ed25519.");
  }
  return [
    GATEWAY_ASSERTION_PREFIX,
    encodeKeyId(keyId),
    encodedPayload,
    signature.toString("base64url"),
  ].join(".");
}

export function parseGatewayAssertion(assertion: string): GatewayAssertionParts {
  try {
    if (assertion.length < 1 || assertion.length > GATEWAY_ASSERTION_LIMITS.assertionCharacters) {
      throw malformed();
    }
    const segments = assertion.split(".");
    if (segments.length !== 4 || segments[0] !== GATEWAY_ASSERTION_PREFIX) throw malformed();
    const encodedKeyId = requiredSegment(segments[1]);
    const encodedPayload = requiredSegment(segments[2]);
    const encodedSignature = requiredSegment(segments[3]);
    const keyId = decodeKeyId(encodedKeyId);
    const payloadBytes = decodeBase64Url(encodedPayload, GATEWAY_ASSERTION_LIMITS.payloadBytes);
    const signature = decodeBase64Url(
      encodedSignature,
      GATEWAY_ASSERTION_LIMITS.signatureBytes,
      GATEWAY_ASSERTION_LIMITS.signatureBytes,
    );
    const payload = JSON.parse(payloadBytes.toString("utf8")) as unknown;
    const principal = GatewayPrincipalV1Schema.parse(payload);
    return { keyId, encodedPayload, payloadBytes, signature, principal };
  } catch (error) {
    if (error instanceof GatewayAssertionError) throw error;
    throw malformed();
  }
}

export function verifyGatewayAssertion(
  assertion: string,
  options: GatewayAssertionVerifierOptions,
): GatewayAssertionVerification {
  const parts = parseGatewayAssertion(assertion);
  const key = options.resolveKey(parts.keyId);
  if (key === undefined) throw new GatewayAssertionError("ASSERTION_KEY_UNKNOWN");

  let signatureValid: boolean;
  try {
    signatureValid = verify(
      null,
      gatewayAssertionSigningInput(parts.keyId, parts.encodedPayload),
      key,
      parts.signature,
    );
  } catch {
    throw new GatewayAssertionError("ASSERTION_SIGNATURE_INVALID");
  }
  if (!signatureValid) throw new GatewayAssertionError("ASSERTION_SIGNATURE_INVALID");

  const principal = parts.principal;
  if (principal.iss !== options.expectedIssuer) {
    throw new GatewayAssertionError("ASSERTION_ISSUER_MISMATCH");
  }
  if (principal.aud !== options.expectedAudience) {
    throw new GatewayAssertionError("ASSERTION_AUDIENCE_MISMATCH");
  }
  if (principal.origin !== options.expectedOrigin) {
    throw new GatewayAssertionError("ASSERTION_ORIGIN_MISMATCH");
  }

  const now = (options.now ?? epochSeconds)();
  assertEpochSeconds(now, "verifier clock");
  const clockSkewSeconds = options.clockSkewSeconds ?? GATEWAY_ASSERTION_LIMITS.clockSkewSeconds;
  const maxPrincipalTtlSeconds =
    options.maxPrincipalTtlSeconds ?? GATEWAY_ASSERTION_LIMITS.principalTtlSeconds;
  assertBoundedSeconds(clockSkewSeconds, "clock skew");
  assertBoundedSeconds(maxPrincipalTtlSeconds, "principal TTL", 1);
  if (principal.issuedAt > now + clockSkewSeconds) {
    throw new GatewayAssertionError("ASSERTION_NOT_YET_VALID");
  }
  if (principal.expiresAt <= now - clockSkewSeconds) {
    throw new GatewayAssertionError("ASSERTION_EXPIRED");
  }
  if (principal.expiresAt - principal.issuedAt > maxPrincipalTtlSeconds) {
    throw new GatewayAssertionError("ASSERTION_TTL_INVALID");
  }

  const replayKey = [principal.iss, principal.aud, principal.assertionId].join("\0");
  const replay = options.replayStore.claim(replayKey, principal.expiresAt + clockSkewSeconds, now);
  if (replay === "replayed") throw new GatewayAssertionError("ASSERTION_REPLAYED");
  if (replay === "capacity-exceeded") {
    throw new GatewayAssertionError("ASSERTION_REPLAY_CACHE_FULL");
  }
  return { keyId: parts.keyId, principal };
}

export function gatewayAssertionSigningInput(keyId: string, encodedPayload: string): Buffer {
  assertKeyId(keyId);
  if (!BASE64URL_PATTERN.test(encodedPayload)) throw malformed();
  return Buffer.from(`${GATEWAY_ASSERTION_PREFIX}\0${keyId}\0${encodedPayload}`, "utf8");
}

function encodeKeyId(keyId: string): string {
  return Buffer.from(keyId, "utf8").toString("base64url");
}

function decodeKeyId(encoded: string): string {
  const decoded = decodeBase64Url(encoded, GATEWAY_ASSERTION_LIMITS.keyIdCharacters);
  const keyId = decoded.toString("utf8");
  if (Buffer.from(keyId, "utf8").compare(decoded) !== 0) throw malformed();
  assertKeyId(keyId);
  return keyId;
}

function assertKeyId(keyId: string): void {
  if (
    keyId.length < 1 ||
    keyId.length > GATEWAY_ASSERTION_LIMITS.keyIdCharacters ||
    !KEY_ID_PATTERN.test(keyId)
  ) {
    throw malformed();
  }
}

function decodeBase64Url(encoded: string, maxBytes: number, exactBytes?: number): Buffer {
  if (!BASE64URL_PATTERN.test(encoded)) throw malformed();
  const decoded = Buffer.from(encoded, "base64url");
  if (decoded.toString("base64url") !== encoded) throw malformed();
  if (decoded.byteLength < 1 || decoded.byteLength > maxBytes) throw malformed();
  if (exactBytes !== undefined && decoded.byteLength !== exactBytes) throw malformed();
  return decoded;
}

function requiredSegment(segment: string | undefined): string {
  if (segment === undefined || segment.length === 0) throw malformed();
  return segment;
}

function malformed(): GatewayAssertionError {
  return new GatewayAssertionError("ASSERTION_MALFORMED");
}

function epochSeconds(): number {
  return Math.floor(Date.now() / 1_000);
}

function assertBoundedSeconds(value: number, label: string, minimum = 0): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > 24 * 60 * 60) {
    throw new Error(`Gateway ${label} must be a bounded number of seconds.`);
  }
}

function assertEpochSeconds(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Gateway ${label} must be a non-negative safe integer.`);
  }
}

function publicMessage(code: GatewayAssertionErrorCode): string {
  switch (code) {
    case "ASSERTION_MALFORMED":
      return "Gateway assertion is malformed.";
    case "ASSERTION_KEY_UNKNOWN":
      return "Gateway assertion signing key is not trusted.";
    case "ASSERTION_SIGNATURE_INVALID":
      return "Gateway assertion signature is invalid.";
    case "ASSERTION_ISSUER_MISMATCH":
      return "Gateway assertion issuer does not match.";
    case "ASSERTION_AUDIENCE_MISMATCH":
      return "Gateway assertion audience does not match.";
    case "ASSERTION_ORIGIN_MISMATCH":
      return "Gateway assertion Origin does not match.";
    case "ASSERTION_NOT_YET_VALID":
      return "Gateway assertion is not valid yet.";
    case "ASSERTION_EXPIRED":
      return "Gateway assertion has expired.";
    case "ASSERTION_TTL_INVALID":
      return "Gateway assertion lifetime is invalid.";
    case "ASSERTION_REPLAYED":
      return "Gateway assertion was already used.";
    case "ASSERTION_REPLAY_CACHE_FULL":
      return "Gateway assertion replay cache is unavailable.";
  }
}
