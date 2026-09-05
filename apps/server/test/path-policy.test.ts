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
