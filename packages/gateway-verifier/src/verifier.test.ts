import { generateKeyPairSync } from "node:crypto";
import type { GatewayPrincipalV1 } from "@naru/contracts/workstation-gateway/v1";
import { describe, expect, it } from "vitest";
import {
  GatewayAssertionError,
  InMemoryGatewayReplayStore,
  createGatewayAssertion,
  parseGatewayAssertion,
  verifyGatewayAssertion,
  type GatewayAssertionVerifierOptions,
} from "./index.js";

const NOW = 1_780_000_030;
const KEY_ID = "fixture-ed25519-key";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const otherKey = generateKeyPairSync("ed25519");
const principal: GatewayPrincipalV1 = {
  version: 1,
  iss: "gateway-instance-fixture",
  aud: "fixture-app",
  sub: "fixture-owner",
  authTime: NOW - 20,
  methods: ["passkey"],
  userVerified: true,
  origin: "https://fixture.invalid",
  ingressProfile: "fixture-profile",
  credentialRef: "fixture-app-reference",
  issuedAt: NOW - 1,
  expiresAt: NOW + 30,
  assertionId: "fixture-assertion-1",
};

function verifierOptions(
  overrides: Partial<GatewayAssertionVerifierOptions> = {},
): GatewayAssertionVerifierOptions {
  return {
    expectedIssuer: principal.iss,
    expectedAudience: principal.aud,
    expectedOrigin: principal.origin,
    resolveKey: (keyId) => (keyId === KEY_ID ? publicKey : undefined),
    replayStore: new InMemoryGatewayReplayStore(),
    now: () => NOW,
    ...overrides,
  };
}

function expectCode(action: () => unknown, code: GatewayAssertionError["code"]): void {
  try {
    action();
    throw new Error("Expected Gateway assertion verification to fail.");
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayAssertionError);
    expect((error as GatewayAssertionError).code).toBe(code);
  }
}

describe("Gateway assertion verifier", () => {
  it("verifies a signed app-scoped principal and consumes its assertion ID once", () => {
    const assertion = createGatewayAssertion(principal, KEY_ID, privateKey);
    const options = verifierOptions();
    expect(parseGatewayAssertion(assertion).principal).toEqual(principal);
    expect(verifyGatewayAssertion(assertion, options)).toEqual({ keyId: KEY_ID, principal });
    expectCode(() => verifyGatewayAssertion(assertion, options), "ASSERTION_REPLAYED");
  });

  it("rejects malformed, unknown-key, invalid-signature, and tampered assertions", () => {
    const assertion = createGatewayAssertion(principal, KEY_ID, privateKey);
    expectCode(
      () => verifyGatewayAssertion("not-an-assertion", verifierOptions()),
      "ASSERTION_MALFORMED",
    );
    expectCode(
      () =>
        verifyGatewayAssertion(
          createGatewayAssertion(principal, "unknown-key", privateKey),
          verifierOptions(),
        ),
      "ASSERTION_KEY_UNKNOWN",
    );
    expectCode(
      () =>
        verifyGatewayAssertion(
          assertion,
          verifierOptions({ resolveKey: () => otherKey.publicKey }),
        ),
      "ASSERTION_SIGNATURE_INVALID",
    );
    const segments = assertion.split(".");
    const tamperedPayload = Buffer.from(
      JSON.stringify({ ...principal, aud: "other-app" }),
      "utf8",
    ).toString("base64url");
    const tampered = [segments[0], segments[1], tamperedPayload, segments[3]].join(".");
    expectCode(
      () => verifyGatewayAssertion(tampered, verifierOptions()),
      "ASSERTION_SIGNATURE_INVALID",
    );
  });

  it("rejects wrong identity bindings and invalid time windows", () => {
    const assertion = createGatewayAssertion(principal, KEY_ID, privateKey);
    expectCode(
      () => verifyGatewayAssertion(assertion, verifierOptions({ expectedIssuer: "other-gateway" })),
      "ASSERTION_ISSUER_MISMATCH",
    );
    expectCode(
      () => verifyGatewayAssertion(assertion, verifierOptions({ expectedAudience: "other-app" })),
      "ASSERTION_AUDIENCE_MISMATCH",
    );
    expectCode(
      () =>
        verifyGatewayAssertion(
          assertion,
          verifierOptions({ expectedOrigin: "https://other.invalid" }),
        ),
      "ASSERTION_ORIGIN_MISMATCH",
    );
    expectCode(
      () =>
        verifyGatewayAssertion(assertion, verifierOptions({ now: () => principal.issuedAt - 10 })),
      "ASSERTION_NOT_YET_VALID",
    );
    expectCode(
      () =>
        verifyGatewayAssertion(assertion, verifierOptions({ now: () => principal.expiresAt + 5 })),
      "ASSERTION_EXPIRED",
    );
    expectCode(
      () => verifyGatewayAssertion(assertion, verifierOptions({ maxPrincipalTtlSeconds: 10 })),
      "ASSERTION_TTL_INVALID",
    );
  });

  it("fails closed when an unexpired replay cache reaches capacity and prunes expiry", () => {
    const replayStore = new InMemoryGatewayReplayStore(1);
    expect(replayStore.claim("first", NOW + 10, NOW)).toBe("accepted");
    expect(replayStore.claim("second", NOW + 10, NOW)).toBe("capacity-exceeded");
    expect(replayStore.claim("first", NOW + 10, NOW)).toBe("replayed");
    expect(replayStore.claim("second", NOW + 20, NOW + 10)).toBe("accepted");
    expect(replayStore.size).toBe(1);
  });

  it("keeps replay claims through the accepted clock-skew window", () => {
    const assertion = createGatewayAssertion(principal, KEY_ID, privateKey);
    const replayStore = new InMemoryGatewayReplayStore();
    verifyGatewayAssertion(assertion, verifierOptions({ replayStore }));
    expectCode(
      () =>
        verifyGatewayAssertion(
          assertion,
          verifierOptions({ replayStore, now: () => principal.expiresAt + 4 }),
        ),
      "ASSERTION_REPLAYED",
    );
  });

  it("fails closed on an invalid verifier or replay-store clock", () => {
    const assertion = createGatewayAssertion(principal, KEY_ID, privateKey);
    expect(() =>
      verifyGatewayAssertion(assertion, verifierOptions({ now: () => Number.NaN })),
    ).toThrow(/verifier clock/);
    expect(() => new InMemoryGatewayReplayStore().claim("fixture", NOW + 1, Number.NaN)).toThrow(
      /replay clock/,
    );
  });
});
