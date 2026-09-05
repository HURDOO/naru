import { describe, expect, it } from "vitest";
import { Observability, sanitizeLogFields, type StructuredLogEntry } from "../src/observability.js";

describe("structured observability", () => {
  it("redacts credentials, environment values, and terminal content recursively", () => {
    const sentinels = [
      "plain-password",
      "session-cookie",
      "csrf-value",
      "terminal-command",
      "terminal-output",
      "environment-secret",
      "error-secret",
    ];
    const sanitized = sanitizeLogFields({
      password: sentinels[0],
      headers: { cookie: sentinels[1], csrfToken: sentinels[2] },
      terminal: { input: sentinels[3], output: sentinels[4] },
      environment: { API_TOKEN: sentinels[5] },
      error: new Error(sentinels[6]),
      requestId: "request-safe",
    });
    const serialized = JSON.stringify(sanitized);

    for (const sentinel of sentinels) expect(serialized).not.toContain(sentinel);
    expect(sanitized).toMatchObject({
      password: "[Redacted]",
      headers: { cookie: "[Redacted]", csrfToken: "[Redacted]" },
      terminal: { input: "[Redacted]", output: "[Redacted]" },
      environment: "[Redacted]",
      error: { errorType: "Error" },
      requestId: "request-safe",
    });
  });

  it("emits timestamped events and content-free operational metrics", () => {
    const entries: StructuredLogEntry[] = [];
    const observability = new Observability((entry) => entries.push(entry));
    observability.increment("loginSuccesses");
    observability.increment("websocketTakeovers");
    observability.event("info", "lease.acquired", {
      requestId: "request-1",
      data: "never-log-terminal-data",
    });

    expect(entries).toHaveLength(1);
    expect(entries[0]?.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(entries[0]).toMatchObject({
      level: "info",
      event: "lease.acquired",
      requestId: "request-1",
      data: "[Redacted]",
    });
    expect(
      observability.metrics({ activePtys: 3, activeSessions: 1, activeWebSockets: 1 }),
    ).toEqual({
      counters: {
        httpErrors: 0,
        loginFailures: 0,
        loginRateLimited: 0,
        loginSuccesses: 1,
        ptyLaunchFailures: 0,
        websocketTakeovers: 1,
      },
      gauges: { activePtys: 3, activeSessions: 1, activeWebSockets: 1 },
    });
  });
});
