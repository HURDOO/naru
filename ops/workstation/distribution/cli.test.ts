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
      "--exact-project-root",
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
        exactProjectRoots: [fixture.projectRoot],
      });
      expect(JSON.parse(output)).not.toHaveProperty("claudeExecutable");
      output = "";
      expect(
        await runDistributionCli([
          ...base.slice(0, -1),
          "--claude",
          fixture.codexExecutable,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(output)).toMatchObject({ claudeExecutable: fixture.codexExecutable });
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

  it("creates an isolated Claude app intent from an owner-only external Gateway binding", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const bindingFile = join(fixture.root, "external-gateway.json");
    const binding = {
      instanceId: "primary-u501-123456789abc",
      appId: "claude-lab",
      ownerSubject: "owner-u501-123456789abc",
      verifierKeysFile: join(fixture.root, "gateway-verifier.json"),
    };
    writeFileSync(bindingFile, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
    chmodSync(bindingFile, 0o600);
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
          "claude-lab",
          "--artifact",
          fixture.artifactRoot,
          "--origin",
          "https://naru.example.test",
          "--app-base-path",
          "/claude-lab",
          "--external-gateway",
          bindingFile,
          "--default-agent-pane-kind",
          "claude",
          "--project-root",
          fixture.projectRoot,
          "--shell",
          "/bin/zsh",
          "--codex",
          fixture.codexExecutable,
          "--claude",
          fixture.codexExecutable,
          "--json",
        ]),
      ).toBe(0);
      expect(JSON.parse(output)).toMatchObject({
        naruAppBasePath: "/claude-lab",
        externalGateway: binding,
        defaultAgentPaneKind: "claude",
      });
      chmodSync(bindingFile, 0o644);
      output = "";
      expect(
        await runDistributionCli([
          "intent",
          "--slug",
          "claude-lab",
          "--artifact",
          fixture.artifactRoot,
          "--origin",
          "https://naru.example.test",
          "--app-base-path",
          "/claude-lab",
          "--external-gateway",
          bindingFile,
          "--project-root",
          fixture.projectRoot,
          "--shell",
          "/bin/zsh",
          "--codex",
          fixture.codexExecutable,
          "--json",
        ]),
      ).toBe(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });

  it("turns the Agent Platform on in an intent that names the Claude Agent SDK", async () => {
    const fixture = createDistributionFixture({ packagedNodeRuntime: true });
    const sdk = join(fixture.root, "claude-agent-sdk", "sdk.mjs");
    let output = "";
    const stdout = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
      output += String(chunk);
      return true;
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const intent = (extra: readonly string[]) =>
      runDistributionCli([
        "intent",
        "--slug",
        "naru-next",
        "--artifact",
        fixture.artifactRoot,
        "--origin",
        "https://naru.example.test",
        "--project-root",
        fixture.projectRoot,
        "--shell",
        "/bin/zsh",
        "--codex",
        fixture.codexExecutable,
        ...extra,
        "--json",
      ]);
    try {
      expect(await intent(["--claude", fixture.codexExecutable, "--claude-agent-sdk", sdk])).toBe(
        0,
      );
      expect(JSON.parse(output)).toMatchObject({ agentPlatform: { claudeAgentSdkPath: sdk } });
      output = "";
      expect(await intent([])).toBe(0);
      expect(JSON.parse(output)).not.toHaveProperty("agentPlatform");
      // Managed Claude agents need the Claude CLI too.
      expect(await intent(["--claude-agent-sdk", sdk])).toBe(2);
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  });
});
