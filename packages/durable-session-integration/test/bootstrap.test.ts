import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createIntegrationBootstrap,
  deriveIntegrationBootstrapKey,
  IntegrationBootstrapError,
  verifyIntegrationBootstrap,
} from "../src/index.js";

const CREDENTIAL = "fixture-app-credential-0123456789abcdef";

function claims() {
  return {
    version: 0 as const,
    appId: "fixture-app",
    subject: "fixture-owner",
    sessionId: randomUUID(),
    runtimeId: randomUUID(),
    profileId: "fixture-profile",
    cwd: { rootId: "projects", relativePath: "sample" },
    integration: {
      kind: "fixture",
      config: { policyRef: "fixture-policy", bindingId: randomUUID() },
    },
    issuedAtMs: 1_000,
  };
}

describe("generic DurableSession integration bootstrap", () => {
  it("round-trips bounded runtime-bound claims", () => {
    const input = claims();
    const token = createIntegrationBootstrap(input, deriveIntegrationBootstrapKey(CREDENTIAL));

    expect(verifyIntegrationBootstrap(token, deriveIntegrationBootstrapKey(CREDENTIAL))).toEqual(
      input,
    );
    expect(token).not.toContain(input.sessionId);
  });

  it("rejects tampering, the wrong app key, and oversized payloads without echoing data", () => {
    const key = deriveIntegrationBootstrapKey(CREDENTIAL);
    const token = createIntegrationBootstrap(claims(), key);
    const tampered = `${token.slice(0, -1)}${token.endsWith("A") ? "B" : "A"}`;

    for (const attempt of [
      () => verifyIntegrationBootstrap(tampered, key),
      () =>
        verifyIntegrationBootstrap(
          token,
          deriveIntegrationBootstrapKey("other-app-credential-0123456789abcdef"),
        ),
      () =>
        createIntegrationBootstrap(
          {
            ...claims(),
            integration: {
              kind: "fixture",
              config: { policyRef: "fixture-policy", opaque: "x".repeat(9 * 1024) },
            },
          },
          key,
        ),
    ]) {
      expect(attempt).toThrow(IntegrationBootstrapError);
    }
  });
});
