import { describe, expect, it } from "vitest";
import { loadTestServerSettings, parseSettings } from "./server.js";

const fixture = {
  browserOrigin: "https://naru.example.test:9443",
  listenerHost: "10.23.45.7",
  sourcePolicy: {
    mode: "private-ipv4-allowlist",
    allowedAddresses: ["10.23.45.7"],
    allowedCidrs: [],
  },
  tls: {
    approvedRoot: "/private/tmp/naru-fixture-tls",
    certificateFile: "/private/tmp/naru-fixture-tls/cert.pem",
    privateKeyFile: "/private/tmp/naru-fixture-tls/key.pem",
    serverNames: ["naru.example.test"],
    allowSymlinkReferences: true,
  },
  passwordHash: "scrypt$32768$8$1$fixture$fixture",
  sessionSecret: "abcdefghijklmnopqrstuvwxyz0123456789",
  claudeExecutable: "/private/tmp/naru-fixture/claude",
} as const;

describe("isolated password server settings", () => {
  it("accepts exact private source, Origin and matching TLS name", () => {
    expect(parseSettings(fixture)).toMatchObject({
      browserOrigin: fixture.browserOrigin,
      listenerHost: fixture.listenerHost,
    });
  });

  it("accepts one explicit project root only as a private operator setting", () => {
    expect(
      parseSettings({ ...fixture, exactProjectRoot: "/private/tmp/naru-fixture-project" }),
    ).toMatchObject({ exactProjectRoot: "/private/tmp/naru-fixture-project" });
  });

  it("accepts only a pair of worktree roots with an exact project setting", () => {
    const worktreeRoots = ["/private/tmp/coding/worktree", "/private/tmp/coding/worktrees"];
    expect(
      parseSettings({
        ...fixture,
        exactProjectRoot: "/private/tmp/coding/projects/fixture",
        worktreeRoots,
      }),
    ).toMatchObject({ worktreeRoots });
    expect(() => parseSettings({ ...fixture, worktreeRoots })).toThrow();
    expect(() =>
      parseSettings({
        ...fixture,
        exactProjectRoot: "/private/tmp/coding/projects/fixture",
        worktreeRoots: [worktreeRoots[0]],
      }),
    ).toThrow();
  });

  it("rejects unknown settings and mismatched certificate names", () => {
    expect(() => parseSettings({ ...fixture, bypassSourcePolicy: true })).toThrow();
    expect(() =>
      parseSettings({ ...fixture, tls: { ...fixture.tls, serverNames: ["other.example.test"] } }),
    ).toThrow();
  });

  it("refuses a non-isolated root before reading settings", () => {
    expect(() => loadTestServerSettings("/private/tmp/unrelated")).toThrow(
      "Refusing to use a non-isolated test root.",
    );
  });
});
