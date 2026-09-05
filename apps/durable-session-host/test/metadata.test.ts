import { chmodSync, lstatSync, readFileSync } from "node:fs";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import {
  createSessionState,
  reduceDurableSession,
  type DurableSessionState,
} from "@naru/domain/durable-session";
import { SqliteMetadataRepository } from "../src/metadata.js";
import { createHostFixture, execCommand, profileCommand, TEST_IDS } from "./support.js";

describe("DurableSession Host metadata repository", () => {
  it("persists redacted metadata without arbitrary argv or integration config", () => {
    const fixture = createHostFixture();
    const repository = new SqliteMetadataRepository(fixture.config.dataDirectory);
    const secretArgument = "T05_SECRET_ARG_SHOULD_NOT_PERSIST";
    const integrationValue = "T05_INTEGRATION_CONFIG_SHOULD_NOT_PERSIST";
    const state = runningState(execCommand(secretArgument));
    const integratedProfile = runningState(
      {
        ...profileCommand(),
        integration: { kind: "fixture", config: { opaque: integrationValue } },
      },
      TEST_IDS.session2,
      TEST_IDS.runtime2,
    );

    repository.save({ state, restartability: "runtime-only" });
    repository.save({ state: integratedProfile, restartability: "runtime-only" });
    const rawDatabase = readFileSync(repository.databasePath);
    expect(rawDatabase.includes(Buffer.from(secretArgument))).toBe(false);
    expect(rawDatabase.includes(Buffer.from(integrationValue))).toBe(false);
    expect(lstatSync(repository.databasePath).mode & 0o077).toBe(0);
    repository.close();

    const reopened = new SqliteMetadataRepository(fixture.config.dataDirectory);
    const [loaded] = reopened.loadAll();
    expect(loaded).toBeDefined();
    expect(loaded?.restartability).toBe("runtime-only");
    expect(loaded?.state.command).toMatchObject({
      kind: "exec",
      args: [],
      envPolicyId: "recovered-unavailable",
      resourcePolicyId: "recovered-unavailable",
    });
    expect(JSON.stringify(loaded)).not.toContain(secretArgument);
    reopened.close();
  });

  it("round-trips the safe profile/root/cwd reference needed for recovery", () => {
    const fixture = createHostFixture();
    const repository = new SqliteMetadataRepository(fixture.config.dataDirectory);
    const state = runningState(profileCommand());
    repository.save({ state, restartability: "profile-reference" });

    const [loaded] = repository.loadAll();
    expect(loaded).toMatchObject({
      restartability: "profile-reference",
      state: {
        sessionId: TEST_IDS.session1,
        lifecycle: "running",
        runtimeId: TEST_IDS.runtime1,
        command: {
          kind: "profile",
          profileId: "fixture",
          cwd: { rootId: "projects", relativePath: "sample" },
        },
      },
    });
    repository.close();
  });

  it("does not claim a terminal sequence whose screen state is memory-only", () => {
    const fixture = createHostFixture();
    const repository = new SqliteMetadataRepository(fixture.config.dataDirectory);
    const running = runningState(profileCommand());
    const sequenced = reduceDurableSession(running, {
      type: "recordOutput",
      expectedRuntimeId: TEST_IDS.runtime1,
      nowMs: 102,
    });
    if (!sequenced.ok) throw new Error("Fixture output transition failed.");
    const exited = reduceDurableSession(sequenced.state, {
      type: "runtimeExited",
      expectedRuntimeId: TEST_IDS.runtime1,
      exitCode: 0,
      signal: null,
      nowMs: 103,
    });
    if (!exited.ok) throw new Error("Fixture exit transition failed.");
    expect(exited.state.nextSequence).toBe(1);

    repository.save({ state: exited.state, restartability: "profile-reference" });
    expect(repository.loadAll()[0]?.state).toMatchObject({
      lifecycle: "exited",
      runtimeId: null,
      nextSequence: 0,
    });
    repository.close();
  });

  it("fails closed for corrupt metadata and an existing database with broad permissions", () => {
    const fixture = createHostFixture();
    const repository = new SqliteMetadataRepository(fixture.config.dataDirectory);
    repository.save({ state: runningState(profileCommand()), restartability: "profile-reference" });
    const databasePath = repository.databasePath;
    repository.close();

    const database = new Database(databasePath);
    database.prepare("UPDATE sessions SET metadata_json = ?").run('{"version":99}');
    database.close();
    const corrupt = new SqliteMetadataRepository(fixture.config.dataDirectory);
    expect(() => corrupt.loadAll()).toThrow();
    corrupt.close();

    chmodSync(databasePath, 0o644);
    expect(() => new SqliteMetadataRepository(fixture.config.dataDirectory)).toThrow(/0600/);
    chmodSync(databasePath, 0o600);
  });
});

function runningState(
  command: ReturnType<typeof profileCommand | typeof execCommand>,
  sessionId = TEST_IDS.session1,
  runtimeId = TEST_IDS.runtime1,
): DurableSessionState {
  const initial = createSessionState({
    sessionId,
    runtimeId,
    command,
    nowMs: 100,
  });
  const transition = reduceDurableSession(initial, {
    type: "spawnSucceeded",
    expectedSessionRevision: 0,
    expectedRuntimeId: runtimeId,
    nowMs: 101,
  });
  if (!transition.ok) throw new Error("Fixture lifecycle transition failed.");
  return transition.state;
}
