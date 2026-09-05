import { createHmac, timingSafeEqual } from "node:crypto";
import {
  IntegrationBootstrapClaimsV0Schema,
  type IntegrationBootstrapClaimsV0,
} from "@naru/contracts/durable-session/v0";

const TOKEN_PREFIX = "dsi0";
const KEY_DERIVATION_DOMAIN = "durable-session/integration-bootstrap/key/v0";
const SIGNING_DOMAIN = "durable-session/integration-bootstrap/token/v0";
const MAX_PAYLOAD_BYTES = 8 * 1024;
const MAX_TOKEN_CHARACTERS = 16 * 1024;

export const DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV =
  "DURABLE_SESSION_INTEGRATION_BOOTSTRAP_V0" as const;

export class IntegrationBootstrapError extends Error {
  constructor() {
    super("DurableSession integration bootstrap is invalid.");
    this.name = "IntegrationBootstrapError";
  }
}

/** Derives a protocol-specific key without reusing the app credential directly. */
export function deriveIntegrationBootstrapKey(appCredential: string): Buffer {
  if (appCredential.length < 32 || appCredential.length > 1_024 || /\s/.test(appCredential)) {
    throw new IntegrationBootstrapError();
  }
  return createHmac("sha256", Buffer.from(appCredential, "utf8"))
    .update(KEY_DERIVATION_DOMAIN, "utf8")
    .digest();
}

export function createIntegrationBootstrap(
  input: IntegrationBootstrapClaimsV0,
  key: Uint8Array,
): string {
  const claims = IntegrationBootstrapClaimsV0Schema.parse(input);
  const payload = Buffer.from(JSON.stringify(claims), "utf8");
  if (payload.byteLength > MAX_PAYLOAD_BYTES) throw new IntegrationBootstrapError();
  const encodedPayload = payload.toString("base64url");
  const signingInput = `${TOKEN_PREFIX}.${encodedPayload}`;
  const signature = signatureFor(signingInput, key).toString("base64url");
  const token = `${signingInput}.${signature}`;
  if (token.length > MAX_TOKEN_CHARACTERS) throw new IntegrationBootstrapError();
  return token;
}

export function verifyIntegrationBootstrap(
  token: string,
  key: Uint8Array,
): IntegrationBootstrapClaimsV0 {
  try {
    if (token.length < 1 || token.length > MAX_TOKEN_CHARACTERS) throw new Error();
    const segments = token.split(".");
    if (segments.length !== 3 || segments[0] !== TOKEN_PREFIX) throw new Error();
    const encodedPayload = segments[1];
    const encodedSignature = segments[2];
    if (encodedPayload === undefined || encodedSignature === undefined) throw new Error();
    const payload = canonicalBase64Url(encodedPayload, MAX_PAYLOAD_BYTES);
    const signature = canonicalBase64Url(encodedSignature, 32);
    if (signature.byteLength !== 32) throw new Error();
    const expected = signatureFor(`${TOKEN_PREFIX}.${encodedPayload}`, key);
    if (signature.byteLength !== expected.byteLength || !timingSafeEqual(signature, expected)) {
      throw new Error();
    }
    return IntegrationBootstrapClaimsV0Schema.parse(JSON.parse(payload.toString("utf8")));
  } catch {
    throw new IntegrationBootstrapError();
  }
}

function signatureFor(input: string, key: Uint8Array): Buffer {
  if (key.byteLength !== 32) throw new IntegrationBootstrapError();
  return createHmac("sha256", key)
    .update(SIGNING_DOMAIN, "utf8")
    .update("\0", "utf8")
    .update(input, "utf8")
    .digest();
}

function canonicalBase64Url(value: string, maximumBytes: number): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength > maximumBytes || decoded.toString("base64url") !== value) {
    throw new Error();
  }
  return decoded;
}
