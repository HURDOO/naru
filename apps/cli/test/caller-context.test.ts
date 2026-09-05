import type { DurableSessionOperationRequest } from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import type { CliConnectionOptions } from "../src/arguments.js";
import {
  callerContextForInteractiveSession,
  callerContextForRequest,
} from "../src/caller-context.js";

const SESSION_ID = "10000000-0000-4000-8000-000000000001";
const connection: CliConnectionOptions = {
  socketPath: "/private/tmp/fixture.sock",
  appId: "fixture-app",
  credentialFile: "/private/tmp/fixture.credential",
  subject: "fixture-owner",
  callerTtlMs: 10_000,
};

describe("Session CLI caller delegation", () => {
  it("keeps wait authorization alive through the requested long-poll response", () => {
    const request: DurableSessionOperationRequest = {
      version: 0,
      requestId: "70000000-0000-4000-8000-000000000001",
      operation: "waitForEvents",
      sessionId: SESSION_ID,
      limit: 100,
      timeoutMs: 30_000,
    };

    expect(callerContextForRequest(connection, request, 1_000)).toMatchObject({
      capabilities: ["session:observe"],
      sessionScope: { kind: "ids", ids: [SESSION_ID] },
      expiresAtMs: 36_000,
    });
  });

  it("delegates preempt only for the explicit control command", () => {
    expect(
      callerContextForInteractiveSession(
        connection,
        { name: "attach", sessionId: SESSION_ID },
        1_000,
      ).capabilities,
    ).toEqual(["session:observe", "control:request"]);
    expect(
      callerContextForInteractiveSession(
        connection,
        { name: "control", sessionId: SESSION_ID },
        1_000,
      ).capabilities,
    ).toEqual(["session:observe", "control:request", "control:preempt"]);
  });
});
