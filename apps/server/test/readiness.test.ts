import { describe, expect, it } from "vitest";
import type { AppManagedConfig } from "../src/config.js";
import { configurationReadiness, readinessStatus } from "../src/readiness.js";

const config: AppManagedConfig = {
  authMode: "app-managed",
  environment: "test",
  host: "127.0.0.1",
  port: 4174,
  allowedOrigins: new Set(["http://127.0.0.1:5173"]),
  projectRoots: ["/safe/project-root"],
  passwordHash: "configured-hash",
  sessionSecret: "a-session-secret-that-is-at-least-32-chars",
  sessionCookieName: "naru_test_session",
  dataDir: "/safe/data",
  secureCookie: false,
  sessionRuntime: { owner: "legacy" },
};

describe("readiness policy", () => {
  it("separates required configuration from database readiness", () => {
    expect(configurationReadiness(config)).toBe("ok");
    expect(configurationReadiness({ ...config, projectRoots: [] })).toBe("failed");
    expect(configurationReadiness({ ...config, sessionCookieName: "invalid name" })).toBe("failed");
    expect(configurationReadiness({ ...config, host: "10.23.45.10" })).toBe("failed");
    expect(
      configurationReadiness({
        ...config,
        host: "10.23.45.10",
        allowedClientIps: new Set(["10.23.45.42"]),
      }),
    ).toBe("ok");
    expect(configurationReadiness({ ...config, secureCookie: true })).toBe("failed");
    expect(
      configurationReadiness({
        ...config,
        secureCookie: true,
        tls: {
          stateDirectory: "/safe/tls",
          serverNames: ["naru.example.test"],
          reloadIntervalMs: 10_000,
        },
      }),
    ).toBe("ok");
    expect(readinessStatus({ configuration: "failed", database: "ok" })).toBe("not_ready");
    expect(readinessStatus({ configuration: "ok", database: "failed" })).toBe("not_ready");
    expect(readinessStatus({ configuration: "ok", database: "ok", tls: "failed" })).toBe(
      "not_ready",
    );
    expect(readinessStatus({ configuration: "ok", database: "ok" })).toBe("ready");
  });
});
