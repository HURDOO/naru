import { createPublicKey, type KeyObject } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute } from "node:path";
import { WORKSTATION_GATEWAY_ASSERTION_HEADER } from "@naru/contracts/workstation-gateway/v1";
import type { GatewayPrincipalV1 } from "@naru/contracts/workstation-gateway/v1";
import {
  GatewayAssertionError,
  InMemoryGatewayReplayStore,
  verifyGatewayAssertion,
} from "@naru/gateway-verifier";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError } from "./errors.js";

const VERIFIER_KEYS_FILE_BYTES = 1024 * 1024;
const GatewayVerifierKeysFileSchema = z.strictObject({
  version: z.literal(1),
  keys: z
    .array(
      z.strictObject({
        keyId: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/),
        algorithm: z.literal("Ed25519"),
        publicKeyPem: z
          .string()
          .min(1)
          .max(16 * 1024),
      }),
    )
    .min(1)
    .max(16),
});

export interface GatewayManagedAuthSettings {
  readonly issuer: string;
  readonly audience: string;
  readonly ownerSubject: string;
  readonly origin: string;
  readonly verifierKeysFile: string;
  readonly verifierKeys: ReadonlyMap<string, KeyObject>;
}

export interface GatewayRequestIdentity {
  readonly mode: "gateway-managed";
  readonly subject: string;
  readonly principal: GatewayPrincipalV1;
}

export class GatewayRequestAuthenticator {
  readonly #replay = new InMemoryGatewayReplayStore();
  readonly #verified = new WeakMap<object, GatewayRequestIdentity>();

  constructor(private readonly settings: GatewayManagedAuthSettings) {}

  authenticate(request: FastifyRequest): GatewayRequestIdentity {
    const cached = this.#verified.get(request.raw);
    if (cached !== undefined) return cached;

    const assertion = request.headers[WORKSTATION_GATEWAY_ASSERTION_HEADER];
    if (typeof assertion !== "string" || assertion.length === 0) throw authenticationRequired();

    try {
      const verification = verifyGatewayAssertion(assertion, {
        expectedIssuer: this.settings.issuer,
        expectedAudience: this.settings.audience,
        expectedOrigin: this.settings.origin,
        resolveKey: (keyId) => this.settings.verifierKeys.get(keyId),
        replayStore: this.#replay,
      });
      if (verification.principal.sub !== this.settings.ownerSubject) {
        throw authenticationRequired();
      }
      const identity: GatewayRequestIdentity = {
        mode: "gateway-managed",
        subject: verification.principal.sub,
        principal: verification.principal,
      };
      this.#verified.set(request.raw, identity);
      return identity;
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (error instanceof GatewayAssertionError) throw authenticationRequired();
      throw error;
    }
  }
}

export function loadGatewayVerifierKeys(filename: string): ReadonlyMap<string, KeyObject> {
  if (!isAbsolute(filename)) {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE must be an absolute path.");
  }
  const metadata = lstatSync(filename);
  if (metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE must be a regular file, not a symlink.");
  }
  if ((metadata.mode & 0o077) !== 0) {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE permissions must be 0600 or stricter.");
  }
  if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE must be owned by the service user.");
  }
  if (metadata.size < 1 || metadata.size > VERIFIER_KEYS_FILE_BYTES) {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE has an invalid size.");
  }
  if (realpathSync(filename) !== filename) {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE path must be canonical.");
  }

  let source: unknown;
  try {
    source = JSON.parse(readFileSync(filename, "utf8")) as unknown;
  } catch {
    throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE must contain valid JSON.");
  }
  const parsed = GatewayVerifierKeysFileSchema.parse(source);
  const keys = new Map<string, KeyObject>();
  for (const candidate of parsed.keys) {
    if (keys.has(candidate.keyId)) {
      throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE contains a duplicate key ID.");
    }
    let key: KeyObject;
    try {
      key = createPublicKey(candidate.publicKeyPem);
    } catch {
      throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE contains an invalid public key.");
    }
    if (key.type !== "public" || key.asymmetricKeyType !== "ed25519") {
      throw new Error("NARU_GATEWAY_VERIFIER_KEYS_FILE keys must be Ed25519 public keys.");
    }
    keys.set(candidate.keyId, key);
  }
  return keys;
}

function authenticationRequired(): AppError {
  return new AppError("AUTH_REQUIRED", 401, "Gateway 인증이 필요합니다.");
}
