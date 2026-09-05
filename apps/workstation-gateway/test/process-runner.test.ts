import { describe, expect, it, vi } from "vitest";
import { NodeExternalCommandRunner } from "../src/ingress/process-runner.js";

describe("bounded external command runner", () => {
  it("uses direct argv execution and captures bounded output", async () => {
    const runner = new NodeExternalCommandRunner({ timeoutMs: 1_000, maxOutputBytes: 128 });
    await expect(runner.run("/usr/bin/printf", ["safe-%s", "fixture"])).resolves.toEqual({
      exitCode: 0,
      stdout: "safe-fixture",
      stderr: "",
    });
  });

  it("rejects relative executables, control characters, and excessive output", async () => {
    const runner = new NodeExternalCommandRunner({ timeoutMs: 1_000, maxOutputBytes: 8 });
    await expect(runner.run("tailscale", ["status"])).rejects.toThrow(/absolute/);
    await expect(runner.run("/usr/bin/printf", ["unsafe\nvalue"])).rejects.toThrow(/control/);
    await expect(runner.run("/usr/bin/printf", ["123456789"])).rejects.toThrow(/bounded limit/);
  });

  it("inherits the terminal classification required by the macOS App Store CLI", async () => {
    vi.stubEnv("TERM", "xterm-256color");
    try {
      await expect(
        new NodeExternalCommandRunner().run("/usr/bin/printenv", ["TERM"]),
      ).resolves.toEqual({
        exitCode: 0,
        stdout: "xterm-256color\n",
        stderr: "",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
