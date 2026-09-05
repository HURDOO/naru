import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GitMetadataAdapter,
  GitMetadataError,
  SystemGitCommandRunner,
  parseGitWorktreePorcelain,
  type GitCommandRunner,
} from "../src/git-metadata.js";
import { ProjectPathPolicy } from "../src/path-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitMetadataAdapter", () => {
  it("distinguishes non-Git folders and bare repositories", async () => {
    const fixture = await createFixture();
    const plain = join(fixture.root, "plain");
    const bare = join(fixture.root, "archive.git");
    await mkdir(plain);
    runGit(fixture.root, ["init", "--bare", "--initial-branch=main", bare]);

    await expect(fixture.adapter.inspect(plain)).resolves.toEqual({
      kind: "non-git",
      registeredPath: await realpath(plain),
    });
    await expect(fixture.adapter.inspect(bare)).resolves.toEqual({
      kind: "bare",
      registeredPath: await realpath(bare),
      commonDirectory: await realpath(bare),
    });
  });

  it("detects primary and linked worktrees without treating primary as branch main", async () => {
    const fixture = await createFixture();
    const repository = await createRepository(fixture.root, "repo; no shell");
    const subdirectory = join(repository, "packages", "server");
    const linked = join(fixture.root, "linked\nworktree");
    await mkdir(subdirectory, { recursive: true });
    runGit(repository, ["worktree", "add", "-b", "feature/sidebar", linked]);

    const inspection = await fixture.adapter.inspect(subdirectory);
    expect(inspection).toMatchObject({
      kind: "worktree",
      registeredPath: await realpath(subdirectory),
      currentWorktreePath: await realpath(repository),
      rejectedWorktrees: [],
    });
    if (inspection.kind !== "worktree") throw new Error("Expected worktree inspection.");
    expect(inspection.worktrees).toHaveLength(2);
    expect(inspection.worktrees[0]).toMatchObject({
      path: await realpath(repository),
      role: "primary",
      current: true,
    });
    expect(inspection.worktrees[0]?.head).toMatchObject({ kind: "branch", name: "release" });
    expect(inspection.worktrees[1]).toMatchObject({
      path: await realpath(linked),
      role: "linked",
      current: false,
    });
    expect(inspection.worktrees[1]?.head).toMatchObject({
      kind: "branch",
      name: "feature/sidebar",
    });

    runGit(linked, ["switch", "--detach"]);
    const detached = await fixture.adapter.inspect(linked);
    if (detached.kind !== "worktree") throw new Error("Expected worktree inspection.");
    expect(detached.worktrees.find((worktree) => worktree.current)?.head).toMatchObject({
      kind: "detached",
    });
  });

  it("reports an unborn branch without inventing an object ID", async () => {
    const fixture = await createFixture();
    const repository = join(fixture.root, "unborn");
    await mkdir(repository);
    runGit(repository, ["init", "--initial-branch=main"]);

    const inspection = await fixture.adapter.inspect(repository);
    if (inspection.kind !== "worktree") throw new Error("Expected worktree inspection.");
    expect(inspection.worktrees).toEqual([
      expect.objectContaining({
        role: "primary",
        current: true,
        head: { kind: "unborn", name: "main" },
      }),
    ]);
  });

  it("resolves project-relative folders without allowing a symlink to leave the worktree", async () => {
    const fixture = await createFixture();
    const repository = await createRepository(fixture.root, "repository");
    const project = join(repository, "apps", "web");
    const outside = join(fixture.root, "outside-project");
    const escaped = join(repository, "apps", "escaped");
    await mkdir(project, { recursive: true });
    await mkdir(outside);
    await symlink(outside, escaped);

    await expect(fixture.adapter.resolveProjectPath(repository, "apps/web")).resolves.toBe(
      await realpath(project),
    );
    await expect(
      fixture.adapter.resolveProjectPath(repository, "apps/escaped"),
    ).rejects.toMatchObject({ code: "invalid-output" });
  });

  it("redacts and rejects missing, outside-root and symlink-escape worktrees", async () => {
    const fixture = await createFixture();
    const repository = await createRepository(fixture.root, "repository");
    const missing = join(fixture.root, "missing-worktree");
    const outside = join(fixture.base, "outside-worktree");
    const escapedLink = join(fixture.root, "escaped-worktree");
    const escapedTarget = join(fixture.base, "escaped-target");
    runGit(repository, ["worktree", "add", "-b", "feature/missing", missing]);
    runGit(repository, ["worktree", "add", "-b", "feature/outside", outside]);
    runGit(repository, ["worktree", "add", "-b", "feature/escaped", escapedLink]);
    await rm(missing, { recursive: true });
    await rm(escapedLink, { recursive: true });
    await mkdir(escapedTarget);
    await symlink(escapedTarget, escapedLink);

    const inspection = await fixture.adapter.inspect(repository);
    if (inspection.kind !== "worktree") throw new Error("Expected worktree inspection.");
    expect(inspection.worktrees).toHaveLength(1);
    expect(inspection.rejectedWorktrees.map(({ reason }) => reason).sort()).toEqual([
      "missing",
      "outside-root",
      "outside-root",
    ]);
    expect(inspection.rejectedWorktrees.filter(({ prunable }) => prunable)).toHaveLength(2);
    expect(JSON.stringify(inspection.rejectedWorktrees)).not.toContain(missing);
    expect(JSON.stringify(inspection.rejectedWorktrees)).not.toContain(outside);
    expect(JSON.stringify(inspection.rejectedWorktrees)).not.toContain(escapedLink);
    expect(JSON.stringify(inspection.rejectedWorktrees)).not.toContain(escapedTarget);
  });

  it("uses cwd and fixed arguments instead of putting project paths in the command", async () => {
    const fixture = await createFixture();
    const repository = await createRepository(fixture.root, "repo;$(touch should-not-run)");
    const recordingRunner = new RecordingRunner(new SystemGitCommandRunner());
    const adapter = new GitMetadataAdapter(fixture.policy, recordingRunner);

    await expect(adapter.inspect(repository)).resolves.toMatchObject({ kind: "worktree" });
    expect(recordingRunner.calls.length).toBeGreaterThan(0);
    expect(recordingRunner.calls.every((call) => call.cwd === repository)).toBe(true);
    expect(recordingRunner.calls.flatMap((call) => call.args)).not.toContain(repository);
  });

  it("rejects a linked worktree whose common Git directory is outside the approved root", async () => {
    const fixture = await createFixture();
    const repository = await createRepository(fixture.base, "outside-repository");
    const linked = join(fixture.root, "inside-worktree");
    runGit(repository, ["worktree", "add", "-b", "feature/inside", linked]);
    const recordingRunner = new RecordingRunner(new SystemGitCommandRunner());

    await expect(
      new GitMetadataAdapter(fixture.policy, recordingRunner).inspect(linked),
    ).rejects.toMatchObject({ code: "outside-root" });
    expect(recordingRunner.calls).toEqual([]);
  });

  it("rejects duplicate canonical worktree paths from Git metadata", async () => {
    const fixture = await createFixture();
    const repository = join(fixture.root, "repository");
    const gitDirectory = join(repository, ".git");
    const alias = join(fixture.root, "repository-alias");
    await mkdir(gitDirectory, { recursive: true });
    await symlink(repository, alias);
    const runner = new ScriptedRunner(
      new Map([
        ["rev-parse\0--is-bare-repository", line("false")],
        ["rev-parse\0--path-format=absolute\0--show-toplevel", line(repository)],
        ["rev-parse\0--path-format=absolute\0--git-dir", line(gitDirectory)],
        ["rev-parse\0--path-format=absolute\0--git-common-dir", line(gitDirectory)],
        [
          "worktree\0list\0--porcelain\0-z",
          porcelain([
            [repository, "a".repeat(40), "branch refs/heads/release"],
            [alias, "b".repeat(40), "branch refs/heads/duplicate"],
          ]),
        ],
      ]),
    );

    const inspection = await new GitMetadataAdapter(fixture.policy, runner).inspect(repository);
    if (inspection.kind !== "worktree") throw new Error("Expected worktree inspection.");
    expect(inspection.worktrees).toHaveLength(1);
    expect(inspection.rejectedWorktrees).toEqual([
      { role: "linked", reason: "duplicate", locked: false, prunable: false },
    ]);
  });
});

describe("parseGitWorktreePorcelain", () => {
  it("parses NUL-delimited paths and ignores lock reasons", () => {
    expect(
      parseGitWorktreePorcelain(
        Buffer.from(
          `worktree /tmp/path\nwith-newline\0HEAD ${"a".repeat(
            40,
          )}\0branch refs/heads/feature/test\0locked private reason\0\0`,
        ),
      ),
    ).toEqual([
      {
        path: "/tmp/path\nwith-newline",
        oid: "a".repeat(40),
        branch: "refs/heads/feature/test",
        detached: false,
        bare: false,
        locked: true,
        prunable: false,
      },
    ]);
  });

  it("fails closed for non-NUL and non-UTF-8 output", () => {
    expect(() => parseGitWorktreePorcelain(Buffer.from("worktree /tmp/repo\n"))).toThrow(
      GitMetadataError,
    );
    expect(() =>
      parseGitWorktreePorcelain(
        Buffer.concat([Buffer.from("worktree "), Buffer.from([0xff]), Buffer.from([0, 0])]),
      ),
    ).toThrow(GitMetadataError);
  });

  it("bounds the number of worktrees before catalog expansion", () => {
    const records = Array.from(
      { length: 257 },
      (_, index) =>
        [`/tmp/worktree-${index}`, "a".repeat(40), `branch refs/heads/feature-${index}`] as const,
    );
    expect(() => parseGitWorktreePorcelain(porcelain(records))).toThrow("too many worktrees");
  });
});

interface Fixture {
  base: string;
  root: string;
  policy: ProjectPathPolicy;
  adapter: GitMetadataAdapter;
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "naru-git-metadata-"));
  temporaryDirectories.push(base);
  const root = join(base, "coding");
  await mkdir(root);
  const policy = await ProjectPathPolicy.create([root]);
  return { base, root, policy, adapter: new GitMetadataAdapter(policy) };
}

async function createRepository(root: string, name: string): Promise<string> {
  const repository = join(root, name);
  await mkdir(repository);
  runGit(repository, ["init", "--initial-branch=release"]);
  await writeFile(join(repository, "README.md"), "fixture\n");
  runGit(repository, ["add", "README.md"]);
  runGit(repository, [
    "-c",
    "user.name=Naru Test",
    "-c",
    "user.email=naru@example.invalid",
    "commit",
    "-m",
    "initial",
  ]);
  return realpath(repository);
}

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync("/usr/bin/git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      PATH: "/usr/bin:/bin",
      LANG: "C",
      LC_ALL: "C",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

class RecordingRunner implements GitCommandRunner {
  readonly calls: Array<{ cwd: string; approvedRoot: string; args: readonly string[] }> = [];
  readonly #delegate: GitCommandRunner;

  constructor(delegate: GitCommandRunner) {
    this.#delegate = delegate;
  }

  run(cwd: string, approvedRoot: string, args: readonly string[]): Promise<Buffer> {
    this.calls.push({ cwd, approvedRoot, args: [...args] });
    return this.#delegate.run(cwd, approvedRoot, args);
  }
}

class ScriptedRunner implements GitCommandRunner {
  readonly #outputs: ReadonlyMap<string, Buffer>;

  constructor(outputs: ReadonlyMap<string, Buffer>) {
    this.#outputs = outputs;
  }

  run(_cwd: string, _approvedRoot: string, args: readonly string[]): Promise<Buffer> {
    const output = this.#outputs.get(args.join("\0"));
    if (output === undefined) throw new Error(`Unexpected Git arguments: ${args.join(" ")}`);
    return Promise.resolve(output);
  }
}

function line(value: string): Buffer {
  return Buffer.from(`${value}\n`);
}

function porcelain(records: ReadonlyArray<readonly [string, string, string]>): Buffer {
  return Buffer.from(
    `${records
      .map(([path, oid, state]) => `worktree ${path}\0HEAD ${oid}\0${state}\0`)
      .join("\0")}\0`,
  );
}
