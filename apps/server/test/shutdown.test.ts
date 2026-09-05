import { describe, expect, it, vi } from "vitest";
import { createGracefulShutdownHandler } from "../src/shutdown.js";

describe("graceful server shutdown", () => {
  it("closes once and records start and completion for duplicate signals", async () => {
    const events: Array<Record<string, unknown>> = [];
    const close = vi.fn(() => Promise.resolve());
    const shutdown = createGracefulShutdownHandler(
      {
        close,
        log: {
          info: (bindings) => events.push(bindings),
          error: (bindings) => events.push(bindings),
        },
      },
      { now: () => new Date("2026-08-18T18:00:00.000Z") },
    );

    await Promise.all([shutdown("SIGTERM"), shutdown("SIGINT")]);

    expect(close).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      {
        timestamp: "2026-08-18T18:00:00.000Z",
        event: "server.shutdown.started",
        signal: "SIGTERM",
      },
      {
        timestamp: "2026-08-18T18:00:00.000Z",
        event: "server.shutdown.completed",
        signal: "SIGTERM",
      },
    ]);
  });

  it("records a safe failure and selects a failing process exit code", async () => {
    const events: Array<Record<string, unknown>> = [];
    const exitCodes: number[] = [];
    const shutdown = createGracefulShutdownHandler(
      {
        close: () => Promise.reject(new Error("private shutdown detail")),
        log: {
          info: (bindings) => events.push(bindings),
          error: (bindings) => events.push(bindings),
        },
      },
      {
        now: () => new Date("2026-08-18T18:01:00.000Z"),
        setExitCode: (exitCode) => exitCodes.push(exitCode),
      },
    );

    await shutdown("SIGTERM");

    expect(exitCodes).toEqual([1]);
    expect(events.at(-1)).toMatchObject({
      event: "server.shutdown.failed",
      signal: "SIGTERM",
      errorType: "Error",
    });
    expect(JSON.stringify(events)).not.toContain("private shutdown detail");
  });
});
