import { chmod, mkdir, mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_PROJECT_FILE_BYTES, ProjectFileService } from "../src/project-files.js";

describe("ProjectFileService", () => {
  it("lists one directory level with protected, excluded, sensitive, and symlink metadata", async () => {
    const project = await temporaryProject();
    const outside = await temporaryProject();
    await mkdir(join(project, "src"));
    await mkdir(join(project, "node_modules"));
    await mkdir(join(project, ".git"));
    await writeFile(join(project, "src", "app.ts"), "export const value = 1;\n");
    await writeFile(join(project, ".env"), "TOKEN=fake\n");
    await symlink(join(outside, "secret.txt"), join(project, "outside-link"));

    const listing = await new ProjectFileService().list(project);
    expect(listing.path).toBe("");
    expect(listing.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "src", kind: "directory", excluded: false }),
        expect.objectContaining({ path: "node_modules", kind: "directory", excluded: true }),
        expect.objectContaining({ path: ".git", protected: true }),
        expect.objectContaining({ path: ".env", sensitive: true }),
        expect.objectContaining({ path: "outside-link", kind: "symlink", symlinkStatus: "broken" }),
      ]),
    );
  });

  it("reads UTF-8 text, requires sensitive confirmation, and rejects unsafe file types", async () => {
    const project = await temporaryProject();
    const outside = await temporaryProject();
    await writeFile(join(project, "README.md"), "# Hello\n");
    await writeFile(join(project, ".env"), "TOKEN=fake\n");
    await writeFile(join(project, "binary.bin"), Buffer.from([0, 1, 2]));
    await writeFile(join(project, "large.txt"), Buffer.alloc(MAX_PROJECT_FILE_BYTES + 1, 65));
    await writeFile(join(outside, "secret.txt"), "outside\n");
    await symlink(join(outside, "secret.txt"), join(project, "escape.txt"));
    const files = new ProjectFileService();

    const content = await files.read(project, "README.md");
    expect(content.source).toBe("# Hello\n");
    expect(content.revision).toMatch(/^[a-f0-9]{64}$/);
    await expect(files.read(project, ".env")).rejects.toMatchObject({
      code: "FILE_SENSITIVE_CONFIRMATION_REQUIRED",
    });
    await expect(files.read(project, ".env", true)).resolves.toMatchObject({ sensitive: true });
    await expect(files.read(project, "binary.bin")).rejects.toMatchObject({ code: "FILE_BINARY" });
    await expect(files.read(project, "large.txt")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await expect(files.read(project, "escape.txt")).rejects.toMatchObject({
      code: "FILE_OUTSIDE_ROOT",
    });
    await expect(files.read(project, "../secret.txt")).rejects.toMatchObject({
      code: "REQUEST_INVALID",
    });
  });

  it("creates and atomically replaces files only at the expected revision", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "src"));
    const files = new ProjectFileService();

    const created = await files.save(project, {
      path: "src/new.ts",
      source: "one\n",
      expectedRevision: null,
      allowSensitive: false,
    });
    await chmod(join(project, "src", "new.ts"), 0o640);
    const saved = await files.save(project, {
      path: "src/new.ts",
      source: "two\n",
      expectedRevision: created.revision,
      allowSensitive: false,
    });
    expect(saved.source).toBe("two\n");
    expect((await stat(join(project, "src", "new.ts"))).mode & 0o777).toBe(0o640);
    expect(await readFile(join(project, "src", "new.ts"), "utf8")).toBe("two\n");

    await writeFile(join(project, "src", "new.ts"), "external\n");
    await expect(
      files.save(project, {
        path: "src/new.ts",
        source: "mine\n",
        expectedRevision: saved.revision,
        allowSensitive: false,
      }),
    ).rejects.toMatchObject({ code: "FILE_CONFLICT" });
    expect(await readFile(join(project, "src", "new.ts"), "utf8")).toBe("external\n");
  });
});

async function temporaryProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "naru-project-files-test-"));
}
