import { describe, expect, it, vi } from "vitest";
import { parseDistributionArguments, runDistributionCli } from "./cli.js";
import { createDistributionFixture } from "./test-support.js";

describe("T14 Workstation CLI auth command", () => {
  it.each(["bootstrap", "recover"] as const)("parses local auth %s", (operation) => {
    expect(
      parseDistributionArguments([
        "auth",
        operation,
        "--intent",
        "/private/tmp/workstation-intent.json",
        "--json",
      ]),
    ).toMatchObject({ command: "auth", authOperation: operation, json: true });
  });

  it("rejects missing subcommands and unrelated approval arguments", () => {
    expect(() =>
      parseDistributionArguments([
        "auth",
        "--intent",
        "/private/tmp/workstation-intent.json",
        "--json",
      ]),
    ).toThrow(/bootstrap or recover/);
    expect(() =>
      parseDistributionArguments([
        "auth",
        "bootstrap",
        "--intent",
        "/private/tmp/workstation-intent.json",
        "--approve-digest",
        "a".repeat(64),
        "--json",
      ]),
    ).toThrow(/does not accept/);
  });

  it("derives Node from a packaged artifact and rejects an external override", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const base = [
      "intent",
      "--slug",
      "fixture",
      "--artifact",
      fixture.artifactRoot,
      "--origin",
      "https://fixture.tailnet.ts.net",
      "--project-root",
      fixture.projectRoot,
      "--shell",
      "/bin/zsh",
      "--codex",
      fixture.codexExecutable,
      "--json",
    ];
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await runDistributionCli(base)).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ nodeExecutable: fixture.nodeExecutable });
      expect(
        await runDistributionCli([
          ...base.slice(0, -1),
          "--node",
          fixture.nodeExecutable,
          "--json",
        ]),
      ).toBe(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
