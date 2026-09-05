import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseNetworkArguments } from "../src/ingress/network-cli.js";

describe("workstation network CLI arguments", () => {
  it("parses read-only plan and all-profile doctor commands", () => {
    expect(
      parseNetworkArguments([
        "plan",
        "--config",
        "fixture.json",
        "--profile",
        "tailscale-main",
        "--operation",
        "rollback",
        "--json",
      ]),
    ).toEqual({
      command: "plan",
      configPath: resolve("fixture.json"),
      profileId: "tailscale-main",
      operation: "rollback",
    });
    expect(parseNetworkArguments(["doctor", "--config", "fixture.json", "--json"])).toEqual({
      command: "doctor",
      configPath: resolve("fixture.json"),
      operation: "apply",
    });
  });

  it("requires reviewed digests only on state-changing commands", () => {
    const digest = "a".repeat(64);
    expect(
      parseNetworkArguments([
        "apply",
        "--config",
        "fixture.json",
        "--profile",
        "tailscale-main",
        "--approve-digest",
        digest,
        "--json",
      ]),
    ).toMatchObject({ command: "apply", approvedDigest: digest });
    expect(() =>
      parseNetworkArguments([
        "plan",
        "--config",
        "fixture.json",
        "--profile",
        "tailscale-main",
        "--approve-digest",
        digest,
        "--json",
      ]),
    ).toThrow(/read-only/);
  });

  it("rejects ambiguous, duplicate, and non-JSON invocation", () => {
    for (const args of [
      ["status", "--config", "fixture.json"],
      ["status", "--config", "fixture.json", "--profile", "one", "--json"],
      ["apply", "--config", "fixture.json", "--json"],
      ["plan", "--config", "fixture.json", "--profile", "one", "--json", "--json"],
      ["plan", "--config", "fixture.json", "--profile", "one", "--operation", "other", "--json"],
    ]) {
      expect(() => parseNetworkArguments(args)).toThrow();
    }
  });
});
