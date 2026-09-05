import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RESERVED_RUNTIME,
  assertRuntimeProfileIsolation,
  createNaruDevelopmentEnvironment,
  createRuntimeProfile,
  discoverRepositoryRoot,
  prepareRuntimeDirectories,
} from "./runtime-profile.js";

describe("workstation development runtime profile", () => {
  it("derives a deterministic profile from the current worktree", () => {
    const root = discoverRepositoryRoot();
    const first = createRuntimeProfile(root, { ownerUid: 501 });
    const second = createRuntimeProfile(root, { ownerUid: 501 });

    expect(second).toEqual(first);
    expect(first.repositoryRoot).toBe(root);
    expect(first.stateRoot).toContain(`${root}/.local/workstation-dev/`);
    expect(first.runtimeRoot).toMatch(/^\/private\/tmp\/naru-workstation-501\/[a-f0-9]{12}$/);
    expect(new Set(Object.values(first.ports)).size).toBe(3);
    expect(new Set(Object.values(first.labels)).size).toBe(3);
  });

  it("uses a different identity and resources for another worktree", () => {
    const fixtureRoot = createRepositoryFixture();
    const current = createRuntimeProfile(discoverRepositoryRoot(), { ownerUid: 501 });
    const other = createRuntimeProfile(fixtureRoot, { ownerUid: 501 });

    expect(other.profileId).not.toBe(current.profileId);
    expect(other.stateRoot).not.toBe(current.stateRoot);
    expect(other.runtimeRoot).not.toBe(current.runtimeRoot);
    expect(other.cookies).not.toEqual(current.cookies);
    expect(other.labels).not.toEqual(current.labels);
  });

  it("discovers a worktree root from a nested directory and .git file", () => {
    const fixtureRoot = createRepositoryFixture();
    const nested = join(fixtureRoot, "nested", "directory");
    mkdirSync(nested, { recursive: true });

    expect(discoverRepositoryRoot(nested)).toBe(fixtureRoot);
  });

  it("rejects production/shared listener, cookie and label collisions", () => {
    const profile = createRuntimeProfile(discoverRepositoryRoot(), { ownerUid: 501 });

    expect(() =>
      assertRuntimeProfileIsolation({
        ...profile,
        ports: { ...profile.ports, naruApi: RESERVED_RUNTIME.ports[0] },
      }),
    ).toThrow(/allocated range|reserved Naru port/);
    expect(() =>
      assertRuntimeProfileIsolation({
        ...profile,
        cookies: { ...profile.cookies, naru: RESERVED_RUNTIME.cookies[0] },
      }),
    ).toThrow(/shared Naru cookie/);
    expect(() =>
      assertRuntimeProfileIsolation({
        ...profile,
        labels: { ...profile.labels, naru: RESERVED_RUNTIME.labels[0] },
      }),
    ).toThrow(/Invalid development service label|production Naru/);
  });

  it("emits only isolated, exact Naru environment values", () => {
    const profile = createRuntimeProfile(discoverRepositoryRoot(), { ownerUid: 501 });
    const environment = createNaruDevelopmentEnvironment(profile);

    expect(environment).toMatchObject({
      NARU_AUTH_MODE: "app-managed",
      NARU_HOST: "127.0.0.1",
      NARU_PORT: String(profile.ports.naruApi),
      NARU_WEB_PORT: String(profile.ports.naruWeb),
      NARU_SESSION_COOKIE_NAME: profile.cookies.naru,
      NARU_DATA_DIR: profile.data.naru,
    });
    expect(environment.NARU_ALLOWED_ORIGINS?.split(",")).toEqual([
      profile.origins.naruWeb,
      profile.origins.naruApi,
    ]);
    expect(environment).not.toHaveProperty("NARU_PASSWORD_HASH");
    expect(environment).not.toHaveProperty("NARU_SESSION_SECRET");
  });

  it("prepares private state and socket directories without following symlinks", () => {
    const fixtureRoot = createRepositoryFixture();
    const profile = createRuntimeProfile(fixtureRoot, { ownerUid: currentUid() });

    prepareRuntimeDirectories(profile);

    for (const directory of [
      profile.stateRoot,
      ...Object.values(profile.data),
      ...Object.values(profile.credentials),
      profile.runtimeRoot,
    ]) {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
    }

    const symlinkFixture = createRepositoryFixture();
    const outside = mkdtempSync("/private/tmp/naru-profile-symlink-target-");
    symlinkSync(outside, join(symlinkFixture, ".local"), "dir");
    const unsafeProfile = createRuntimeProfile(symlinkFixture, { ownerUid: currentUid() });
    expect(() => prepareRuntimeDirectories(unsafeProfile)).toThrow(/symbolic link/);
  });
});

function createRepositoryFixture(): string {
  const root = mkdtempSync("/private/tmp/naru-worktree-profile-test-");
  writeFileSync(join(root, ".git"), "gitdir: /private/tmp/fake-git-dir\n");
  writeFileSync(join(root, "package.json"), '{"name":"naru-fixture","private":true}\n');
  return realpathSync(root);
}

function currentUid(): number {
  return process.getuid?.() ?? 0;
}
