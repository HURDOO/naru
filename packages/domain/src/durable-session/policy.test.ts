import {
  DurableSessionCallerContextSchema,
  DurableSessionOperationRequestSchema,
  type DurableSessionCallerContext,
} from "@naru/contracts/durable-session/v0";
import { DURABLE_SESSION_V0_OPERATION_TEST_VECTORS } from "@naru/contracts/durable-session/v0/test-vectors";
import { describe, expect, it } from "vitest";
import { authorizeDurableSessionOperation, requiredCapabilitiesForOperation } from "./policy.js";
import { TEST_IDS } from "./test-support.js";

const allCapabilities = [
  "session:observe",
  "control:request",
  "control:preempt",
  "session:create:profile",
  "session:create:arbitrary",
  "session:start",
  "session:stop",
  "session:forget",
  "profile:use",
  "session:read-sensitive-metadata",
] as const;

function caller(overrides: Partial<DurableSessionCallerContext> = {}): DurableSessionCallerContext {
  return DurableSessionCallerContextSchema.parse({
    appId: "fixture-app",
    subject: "fixture-owner",
    capabilities: allCapabilities,
    sessionScope: { kind: "all" },
    profileScope: { kind: "all" },
    rootScope: { kind: "all" },
    expiresAtMs: 10_000,
    ...overrides,
  });
}

describe("DurableSession capability policy", () => {
  it("defines and enforces a granular capability set for all 22 operations", () => {
    for (const vector of DURABLE_SESSION_V0_OPERATION_TEST_VECTORS) {
      const request = DurableSessionOperationRequestSchema.parse(vector);
      const required = requiredCapabilitiesForOperation(request);
      expect(required.length).toBeGreaterThan(0);
      expect(authorizeDurableSessionOperation(caller(), request, 1_000)).toEqual({ allowed: true });

      const withoutFirst = caller({
        capabilities: allCapabilities.filter((capability) => capability !== required[0]),
      });
      const denied = authorizeDurableSessionOperation(withoutFirst, request, 1_000);
      expect(denied.allowed).toBe(false);
      if (!denied.allowed) expect(denied.error.code).toBe("CAPABILITY_REQUIRED");
    }
  });

  it("fails closed for expired caller, Session scope, profile scope, and root scope", () => {
    const getRequest = DurableSessionOperationRequestSchema.parse(
      DURABLE_SESSION_V0_OPERATION_TEST_VECTORS[2],
    );
    const createRequest = DurableSessionOperationRequestSchema.parse(
      DURABLE_SESSION_V0_OPERATION_TEST_VECTORS[0],
    );

    expect(
      authorizeDurableSessionOperation(caller({ expiresAtMs: 999 }), getRequest, 1_000),
    ).toMatchObject({ allowed: false, error: { code: "CAPABILITY_REQUIRED" } });
    expect(
      authorizeDurableSessionOperation(
        caller({ sessionScope: { kind: "ids", ids: [TEST_IDS.nextRuntime] } }),
        getRequest,
        1_000,
      ),
    ).toMatchObject({ allowed: false, error: { code: "CAPABILITY_REQUIRED" } });
    expect(
      authorizeDurableSessionOperation(
        caller({ profileScope: { kind: "ids", ids: ["other-profile"] } }),
        createRequest,
        1_000,
      ),
    ).toMatchObject({ allowed: false, error: { code: "COMMAND_POLICY_DENIED" } });
    expect(
      authorizeDurableSessionOperation(
        caller({ rootScope: { kind: "ids", ids: ["other-root"] } }),
        createRequest,
        1_000,
      ),
    ).toMatchObject({ allowed: false, error: { code: "ROOT_BOUNDARY_VIOLATION" } });
  });
});
