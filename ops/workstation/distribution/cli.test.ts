import { describe, expect, it, vi } from "vitest";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDistributionArguments, runDistributionCli } from "./cli.js";
import {
  createDistributionFixture,
  createPrivateIngressDistributionFixture,
} from "./test-support.js";

describe("T14 Workstation CLI auth command", () => {
  it("parses additive apply and read-only status commands", () => {
    expect(
      parseDistributionArguments([
        "plan",
        "--intent",
        "/private/tmp/workstation-intent.json",
        "--operation",
        "apply",
        "--json",
      ]),
    ).toMatchObject({ command: "plan", operation: "install" });
    expect(
      parseDistributionArguments([
        "apply",
        "--intent",
        "/private/tmp/workstation-intent.json",
        "--approve-digest",
        "a".repeat(64),
        "--json",
      ]),
    ).toMatchObject({ command: "apply" });
    expect(
      parseDistributionArguments([
        "status",
        "--intent",
        "/private/tmp/workstation-intent.json",
        "--json",
      ]),
    ).toMatchObject({ command: "status" });
  });

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
      expect(JSON.parse(output)).toMatchObject({
        naruAppBasePath: "/naru",
        nodeExecutable: fixture.nodeExecutable,
      });
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

  it("creates v2 intent from one owner-only private ingress file without CLI topology flags", async () => {
    const fixture = createPrivateIngressDistributionFixture({ packagedNodeRuntime: true });
    const ingressFile = join(fixture.root, "private-ingress.json");
    writeFileSync(ingressFile, `${JSON.stringify(fixture.intent.ingress)}\n`, { mode: 0o600 });
    chmodSync(ingressFile, 0o600);
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(
        await runDistributionCli([
          "intent",
          "--slug",
          "private-fixture",
          "--artifact",
          fixture.artifactRoot,
          "--private-ingress",
          ingressFile,
          "--project-root",
          fixture.projectRoot,
          "--shell",
          "/bin/zsh",
          "--codex",
          fixture.codexExecutable,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        version: 2,
        naruAppBasePath: "/naru",
        canonicalBrowserOrigin: fixture.intent.canonicalBrowserOrigin,
        ingress: { kind: "direct-private-tls" },
      });
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
