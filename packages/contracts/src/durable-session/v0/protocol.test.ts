import { describe, expect, it } from "vitest";
import { DurableSessionV0 } from "../../index.js";
import {
  DURABLE_SESSION_V0_EVENT_TEST_VECTORS,
  DURABLE_SESSION_V0_OPERATION_TEST_VECTORS,
  DURABLE_SESSION_V0_REDACTION_MARKERS,
  DURABLE_SESSION_V0_TEST_IDS,
} from "./test-vectors.js";
import {
  CommandSpecV0Schema,
  DurableSessionEventSchema,
  DurableSessionJournalEventSchema,
  DurableSessionOperationRequestSchema,
  DurableSessionOperationResponseSchema,
  DURABLE_SESSION_LIMITS,
  PublicOperationNameSchema,
} from "./index.js";

const ids = DURABLE_SESSION_V0_TEST_IDS;

describe("DurableSession v0 public contracts", () => {
  it("accepts one strict fixture for every public operation", () => {
    const operations = DURABLE_SESSION_V0_OPERATION_TEST_VECTORS.map(
      (vector) => DurableSessionOperationRequestSchema.parse(vector).operation,
    );

    expect(operations).toHaveLength(22);
    expect(new Set(operations).size).toBe(22);
    for (const operation of operations) {
      expect(PublicOperationNameSchema.parse(operation)).toBe(operation);
    }
  });

  it("exports the same protocol through the collision-free root namespace", () => {
    expect(DurableSessionV0.DurableSessionOperationRequestSchema).toBe(
      DurableSessionOperationRequestSchema,
    );
  });

  it("rejects unknown fields, unknown operations, and unsupported versions", () => {
    const valid = DURABLE_SESSION_V0_OPERATION_TEST_VECTORS[2];

    expect(
      DurableSessionOperationRequestSchema.safeParse({ ...valid, credential: "must-not-pass" })
        .success,
    ).toBe(false);
    expect(
      DurableSessionOperationRequestSchema.safeParse({ ...valid, operation: "restartEverything" })
        .success,
    ).toBe(false);
    expect(DurableSessionOperationRequestSchema.safeParse({ ...valid, version: 1 }).success).toBe(
      false,
    );
  });

  it("keeps arbitrary environment values, traversal, secrets, and oversize data out", () => {
    const command = {
      kind: "exec",
      executable: "/usr/bin/env",
      args: [],
      envPolicyId: "safe-env",
      resourcePolicyId: "safe-resource",
      cwd: { rootId: "fixture-root", relativePath: "project" },
      terminal: { cols: 80, rows: 24 },
    } as const;

    expect(CommandSpecV0Schema.safeParse({ ...command, env: { TOKEN: "inline" } }).success).toBe(
      false,
    );
    expect(
      CommandSpecV0Schema.safeParse({
        ...command,
        cwd: { rootId: "fixture-root", relativePath: "../outside" },
      }).success,
    ).toBe(false);
    expect(
      CommandSpecV0Schema.safeParse({
        ...command,
        integration: { kind: "fixture", config: { nested: { apiToken: "inline" } } },
      }).success,
    ).toBe(false);
    expect(
      DurableSessionOperationRequestSchema.safeParse({
        ...DURABLE_SESSION_V0_OPERATION_TEST_VECTORS[18],
        data: "x".repeat(DURABLE_SESSION_LIMITS.terminalDataCharacters + 1),
      }).success,
    ).toBe(false);
  });

  it("separates ephemeral terminal traffic from the durable event journal", () => {
    for (const vector of DURABLE_SESSION_V0_EVENT_TEST_VECTORS) {
      expect(DurableSessionEventSchema.parse(vector)).toEqual(vector);
    }

    const terminalOutput = {
      version: 0,
      eventId: ids.event,
      sessionId: ids.session,
      occurredAtMs: 1_780_000_000_000,
      type: "terminal.output",
      runtimeId: ids.runtime,
      sequence: 1,
      data: DURABLE_SESSION_V0_REDACTION_MARKERS.forbiddenTranscript,
    } as const;

    expect(DurableSessionEventSchema.safeParse(terminalOutput).success).toBe(true);
    expect(DurableSessionJournalEventSchema.safeParse(terminalOutput).success).toBe(false);
  });

  it("keeps failure responses strict and free of arbitrary diagnostic payloads", () => {
    const failure = {
      version: 0,
      requestId: ids.request,
      ok: false,
      error: { code: "COMMAND_POLICY_DENIED", message: "Command policy denied the request." },
    } as const;

    expect(DurableSessionOperationResponseSchema.parse(failure)).toEqual(failure);
    expect(
      DurableSessionOperationResponseSchema.safeParse({
        ...failure,
        error: {
          ...failure.error,
          transcript: DURABLE_SESSION_V0_REDACTION_MARKERS.forbiddenTranscript,
          secret: DURABLE_SESSION_V0_REDACTION_MARKERS.forbiddenSecret,
        },
      }).success,
    ).toBe(false);
  });
});
