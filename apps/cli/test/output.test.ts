import type { DurableSessionOperationResult } from "@naru/contracts/durable-session/v0";
import { describe, expect, it } from "vitest";
import { createCliWriter } from "../src/output.js";

const TOKEN = "fixture-resume-token-must-not-appear-000000000000";
const TRANSCRIPT = "fixture-terminal-transcript-must-not-appear";

describe("Session CLI machine output", () => {
  it("redacts attachment resume tokens", () => {
    const output: string[] = [];
    const writer = createCliWriter({
      json: true,
      stdout: (value) => output.push(value),
      stderr() {},
    });
    const result: DurableSessionOperationResult = {
      operation: "openAttachment",
      attachment: {
        sessionId: "10000000-0000-4000-8000-000000000001",
        attachmentId: "30000000-0000-4000-8000-000000000001",
        runtimeId: "20000000-0000-4000-8000-000000000001",
        role: "observer",
        controllerGeneration: 0,
        attachmentResumeToken: TOKEN,
        resumeExpiresAtMs: 2_000,
        appId: "fixture-app",
        subject: "fixture-owner",
      },
    };

    writer.success("attach", result);

    expect(output.join("")).not.toContain(TOKEN);
    expect(JSON.parse(output.join(""))).toMatchObject({
      version: 1,
      command: "attach",
      ok: true,
      result: { attachment: { role: "observer" } },
    });
  });

  it("redacts serialized terminal state and integration payload", () => {
    const output: string[] = [];
    const writer = createCliWriter({
      json: true,
      stdout: (value) => output.push(value),
      stderr() {},
    });
    writer.success("attach", {
      operation: "requestSnapshot",
      snapshot: {
        sessionId: "10000000-0000-4000-8000-000000000001",
        attachmentId: "30000000-0000-4000-8000-000000000001",
        runtimeId: "20000000-0000-4000-8000-000000000001",
        sequence: 4,
        terminal: { cols: 80, rows: 24 },
        serializedState: TRANSCRIPT,
      },
    });
    writer.success("watch", {
      operation: "waitForEvents",
      events: [
        {
          version: 0,
          eventId: "40000000-0000-4000-8000-000000000001",
          sessionId: "10000000-0000-4000-8000-000000000001",
          occurredAtMs: 1,
          type: "integration.event",
          runtimeId: null,
          integrationKind: "fixture",
          eventKind: "safe-summary",
          payload: { marker: TRANSCRIPT },
        },
      ],
      cursor: null,
      timedOut: false,
    });

    expect(output.join("")).not.toContain(TRANSCRIPT);
    expect(output.join("")).toContain('"terminalState":"redacted"');
    expect(output.join("")).toContain('"payload":"redacted"');
  });
});
