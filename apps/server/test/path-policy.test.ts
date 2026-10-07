import { chmod, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProjectPathPolicy } from "../src/path-policy.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectPathPolicy", () => {
  it("accepts a real project below an approved root", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const root = join(base, "coding");
    const project = join(root, "project");
    await mkdir(project, { recursive: true });

    const policy = await ProjectPathPolicy.create([root]);
    await expect(policy.validate(project)).resolves.toEqual({
      realPath: await realpath(project),
      defaultName: "project",
    });
    expect(policy.approvedRootFor(await realpath(project))).toBe(await realpath(root));
    expect(policy.approvedRootFor(await realpath(root))).toBeUndefined();
  });

  it("allows only an explicitly opted-in exact root without admitting its sibling", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const project = join(base, "approved");
    const sibling = join(base, "sibling");
    await Promise.all([mkdir(project), mkdir(sibling)]);
    const escape = join(project, "escape");
    await symlink(sibling, escape);
    const canonicalProject = await realpath(project);
    const policy = await ProjectPathPolicy.create([canonicalProject], {
      allowExactRoots: [canonicalProject],
    });

    await expect(policy.validate(project)).resolves.toEqual({
      realPath: await realpath(project),
      defaultName: "approved",
    });
    await expect(policy.validate(sibling)).rejects.toMatchObject({
      code: "PROJECT_OUTSIDE_ROOT",
    });
    await expect(policy.validate(escape)).rejects.toMatchObject({
      code: "PROJECT_OUTSIDE_ROOT",
    });
    await expect(policy.validate(base)).rejects.toMatchObject({ code: "PROJECT_OUTSIDE_ROOT" });
  });

  it("keeps two sibling worktree roots strict-child while allowing one exact project", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const exactProject = join(base, "projects", "approved");
    const worktree = join(base, "worktree");
    const worktrees = join(base, "worktrees");
    const firstLinked = join(worktree, "linked-one");
    const secondLinked = join(worktrees, "linked-two");
    const sibling = join(base, "other", "unapproved");
    await Promise.all([
      mkdir(exactProject, { recursive: true }),
      mkdir(firstLinked, { recursive: true }),
      mkdir(secondLinked, { recursive: true }),
      mkdir(sibling, { recursive: true }),
    ]);

    const canonicalProject = await realpath(exactProject);
    const policy = await ProjectPathPolicy.create([canonicalProject, worktree, worktrees], {
      allowExactRoots: [canonicalProject],
    });
    await expect(policy.validate(exactProject)).resolves.toMatchObject({
      realPath: canonicalProject,
    });
    await expect(policy.validate(firstLinked)).resolves.toMatchObject({
      realPath: await realpath(firstLinked),
    });
    await expect(policy.validate(secondLinked)).resolves.toMatchObject({
      realPath: await realpath(secondLinked),
    });
    for (const rejected of [worktree, worktrees, sibling, base]) {
      await expect(policy.validate(rejected)).rejects.toMatchObject({
        code: "PROJECT_OUTSIDE_ROOT",
      });
    }
  });

  it("rejects an exact root that is not itself configured or canonical", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const project = join(base, "approved");
    const sibling = join(base, "sibling");
    const alias = join(base, "alias");
    await Promise.all([mkdir(project), mkdir(sibling)]);
    await symlink(project, alias);

    await expect(
      ProjectPathPolicy.create([project], { allowExactRoots: [sibling] }),
    ).rejects.toThrow("Exact project root");
    await expect(ProjectPathPolicy.create([project], { allowExactRoots: [alias] })).rejects.toThrow(
      "Exact project root",
    );
  });

  it("rejects a symlink that escapes the approved root", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const root = join(base, "coding");
    const outside = join(base, "private-project");
    const link = join(root, "escape");
    await mkdir(root, { recursive: true });
    await mkdir(outside);
    await symlink(outside, link);

    const policy = await ProjectPathPolicy.create([root]);
    await expect(policy.validate(link)).rejects.toMatchObject({ code: "PROJECT_OUTSIDE_ROOT" });
  });

  it("rejects a similarly-prefixed sibling and a dot-dot escape", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const root = join(base, "coding");
    const project = join(root, "project");
    const prefixedSibling = join(base, "coding-private");
    const outside = join(base, "outside");
    await Promise.all([
      mkdir(project, { recursive: true }),
      mkdir(prefixedSibling),
      mkdir(outside),
    ]);

    const policy = await ProjectPathPolicy.create([root]);
    await expect(policy.validate(prefixedSibling)).rejects.toMatchObject({
      code: "PROJECT_OUTSIDE_ROOT",
    });
    await expect(policy.validate([project, "..", "..", "outside"].join(sep))).rejects.toMatchObject(
      { code: "PROJECT_OUTSIDE_ROOT" },
    );
  });

  it("rejects relative and missing paths", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const root = join(base, "coding");
    await mkdir(root);
    const policy = await ProjectPathPolicy.create([root]);

    await expect(policy.validate("relative/project")).rejects.toMatchObject({
      code: "PROJECT_INVALID_PATH",
    });
    await expect(policy.validate(join(root, "missing"))).rejects.toMatchObject({
      code: "PROJECT_MISSING",
    });
  });

  it("reports an unreadable project as a permission error", async () => {
    const base = await mkdtemp(join(tmpdir(), "naru-path-"));
    temporaryDirectories.push(base);
    const root = join(base, "coding");
    const project = join(root, "private-project");
    await mkdir(project, { recursive: true });
    const policy = await ProjectPathPolicy.create([root]);

    await chmod(project, 0o000);
    try {
      await expect(policy.validate(project)).rejects.toMatchObject({
        code: "PROJECT_PERMISSION_DENIED",
      });
    } finally {
      await chmod(project, 0o700);
    }
  });
});
