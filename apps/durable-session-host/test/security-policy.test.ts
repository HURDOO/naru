import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  deriveIntegrationBootstrapKey,
  DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV,
  verifyIntegrationBootstrap,
} from "@naru/durable-session-integration";
import { describe, expect, it } from "vitest";
import { HostAppRegistry } from "../src/app-registry.js";
import { HostCommandPolicy } from "../src/command-policy.js";
import { DurableSessionHostConfigSchema, readDurableSessionHostConfig } from "../src/config.js";
import { assertPrivateRegularFile } from "../src/security.js";
import {
  createHostFixture,
  execCommand,
  ownerCaller,
  profileCommand,
  TEST_CREDENTIAL,
} from "./support.js";

describe("DurableSession Host command and app policy", () => {
  it("resolves an allowlisted profile without accepting request-owned environment", () => {
    const fixture = createHostFixture();
    const policy = new HostCommandPolicy(fixture.config, { SHOULD_NOT_LEAK: "secret" });
    const launch = policy.resolve(profileCommand());

    const expectedCwd = realpathSync(join(fixture.root, "projects", "sample"));
    expect(launch.cwd).toBe(expectedCwd);
    expect(launch.environment).toEqual({
      FIXTURE_SAFE: "1",
      PWD: expectedCwd,
      TERM: "xterm-256color",
    });
    expect(launch.environment).not.toHaveProperty("SHOULD_NOT_LEAK");
  });

  it("rejects symlink escapes and executables outside the selected policy", () => {
    const fixture = createHostFixture();
    const outside = join(fixture.root, "outside");
    mkdirSync(outside, { mode: 0o700 });
    symlinkSync(outside, join(fixture.root, "projects", "escape"));
    const policy = new HostCommandPolicy(fixture.config, {});

    expect(() =>
      policy.resolve({
        ...profileCommand(),
        cwd: { rootId: "projects", relativePath: "escape" },
      }),
    ).toThrowError(expect.objectContaining({ code: "ROOT_BOUNDARY_VIOLATION" }));
    const disallowed = execCommand();
    if (disallowed.kind !== "exec") throw new Error("Fixture must be an exec command.");
    expect(() => policy.resolve({ ...disallowed, executable: "/bin/sh" })).toThrowError(
      expect.objectContaining({ code: "COMMAND_POLICY_DENIED" }),
    );
  });

  it("marks only safely reconstructable profile commands as restartable", () => {
    const fixture = createHostFixture();
    const policy = new HostCommandPolicy(fixture.config, {});

    expect(policy.restartability(profileCommand())).toBe("profile-reference");
    expect(
      policy.restartability({
        ...profileCommand(),
        integration: { kind: "fixture", config: { mode: "safe" } },
      }),
    ).toBe("runtime-only");
    expect(policy.restartability(execCommand("secret-argv"))).toBe("runtime-only");
  });

  it("injects a signed runtime-bound bootstrap only for an allowlisted generic integration", () => {
    const fixture = createHostFixture();
    const config = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      integrationPolicies: [
        {
          policyRef: "fixture-integration-v0",
          appId: "fixture-app",
          integrationKind: "fixture",
          profileIds: ["fixture"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    });
    const policy = new HostCommandPolicy(config, {});
    const sessionId = randomUUID();
    const runtimeId = randomUUID();
    const bindingId = randomUUID();
    const command = {
      ...profileCommand(),
      integration: {
        kind: "fixture",
        config: { policyRef: "fixture-integration-v0", bindingId },
      },
    } as const;

    policy.resolve(command, { mode: "validate", appId: "fixture-app" });
    const launch = policy.resolve(command, {
      mode: "runtime",
      appId: "fixture-app",
      subject: "fixture-owner",
      sessionId,
      runtimeId,
      issuedAtMs: 1_234,
      integrationBootstrapKey: deriveIntegrationBootstrapKey(TEST_CREDENTIAL),
    });
    const token = launch.environment[DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV];
    if (token === undefined) throw new Error("Fixture bootstrap was not injected.");

    expect(
      verifyIntegrationBootstrap(token, deriveIntegrationBootstrapKey(TEST_CREDENTIAL)),
    ).toEqual({
      version: 0,
      appId: "fixture-app",
      subject: "fixture-owner",
      sessionId,
      runtimeId,
      profileId: "fixture",
      cwd: command.cwd,
      integration: command.integration,
      issuedAtMs: 1_234,
    });
    expect(policy.restartability(command)).toBe("runtime-only");
  });

  it("rejects unknown apps, policy refs, extra config, and reserved environment injection", () => {
    const fixture = createHostFixture();
    const config = DurableSessionHostConfigSchema.parse({
      ...fixture.config,
      integrationPolicies: [
        {
          policyRef: "fixture-integration-v0",
          appId: "fixture-app",
          integrationKind: "fixture",
          profileIds: ["fixture"],
          configKeys: ["policyRef", "bindingId"],
        },
      ],
    });
    const policy = new HostCommandPolicy(config, {});
    const base = {
      ...profileCommand(),
      integration: {
        kind: "fixture",
        config: { policyRef: "fixture-integration-v0", bindingId: randomUUID() },
      },
    } as const;

    for (const command of [
      { ...base, integration: { ...base.integration, config: { policyRef: "missing" } } },
      {
        ...base,
        integration: {
          ...base.integration,
          config: { ...base.integration.config, unexpected: "not-allowlisted" },
        },
      },
    ]) {
      expect(() =>
        policy.resolve(command, { mode: "validate", appId: "fixture-app" }),
      ).toThrowError(expect.objectContaining({ code: "COMMAND_POLICY_DENIED" }));
    }
    expect(() => policy.resolve(base, { mode: "validate", appId: "other-app" })).toThrowError(
      expect.objectContaining({ code: "COMMAND_POLICY_DENIED" }),
    );

    expect(
      DurableSessionHostConfigSchema.safeParse({
        ...fixture.config,
        environmentPolicies: [
          {
            ...fixture.config.environmentPolicies[0],
            values: { [DURABLE_SESSION_INTEGRATION_BOOTSTRAP_ENV]: "injected" },
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("requires a private credential file and clamps delegated caller context", () => {
    const fixture = createHostFixture();
    const registry = new HostAppRegistry(fixture.config.appRegistrations);
    const caller = ownerCaller();

    expect(registry.authenticate("fixture-app", TEST_CREDENTIAL, caller, 1_001)).toBe(caller);
    expect(
      registry.authenticateOperation("fixture-app", TEST_CREDENTIAL, caller, 1_001)
        .integrationBootstrapKey,
    ).toEqual(deriveIntegrationBootstrapKey(TEST_CREDENTIAL));
    expect(() =>
      registry.authenticate("fixture-app", "wrong-credential-value-012345678901", caller, 1_001),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_REQUIRED" }));
    expect(() =>
      registry.authenticate(
        "fixture-app",
        TEST_CREDENTIAL,
        { ...caller, appId: "another-app" },
        1_001,
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_REQUIRED" }));
    expect(() =>
      registry.authenticate(
        "fixture-app",
        TEST_CREDENTIAL,
        { ...caller, expiresAtMs: 1_001 + 60_001 },
        1_001,
      ),
    ).toThrowError(expect.objectContaining({ code: "CAPABILITY_REQUIRED" }));

    chmodSync(fixture.credentialFile, 0o644);
    expect(() => assertPrivateRegularFile(fixture.credentialFile)).toThrow(/0600/);
    chmodSync(fixture.credentialFile, 0o600);
  });

  it("rejects malformed credential files without exposing their contents", () => {
    const fixture = createHostFixture();
    const badCredential = join(fixture.root, "credentials", "bad");
    writeFileSync(badCredential, "short", { mode: 0o600 });
    const registration = {
      ...fixture.config.appRegistrations[0]!,
      credentialFile: badCredential,
    };
    expect(() => new HostAppRegistry([registration])).toThrow(
      "Host app credential has an invalid format.",
    );
  });

  it("loads Host configuration only from a private regular file", () => {
    const fixture = createHostFixture();
    const configPath = join(fixture.root, "host-config.json");
    writeFileSync(configPath, JSON.stringify(fixture.config), { mode: 0o600 });
    expect(readDurableSessionHostConfig(configPath)).toEqual(fixture.config);

    chmodSync(configPath, 0o644);
    expect(() => readDurableSessionHostConfig(configPath)).toThrow(/0600/);
  });
});
