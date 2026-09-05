import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { scanRepository } from "./public-scan.mjs";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("public repository scanner", () => {
  it("scans the staged index blob instead of an unstaged worktree replacement", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "clean\n");
    git(root, "add", "README.md");
    writeFileSync(join(root, "README.md"), `${privateUserPath()}\n`);

    expect(scanRepository(root).findings).toEqual([]);
  });

  it("blocks sensitive content in the staged index", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), `${privateUserPath()}\n`);
    git(root, "add", "README.md");

    expect(scanRepository(root).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "private-user-path" })]),
    );
  });

  it("blocks sensitive content retained only in reachable history", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), `${privateUserPath()}\n`);
    git(root, "add", "README.md");
    git(root, "commit", "-m", "unsafe root");
    writeFileSync(join(root, "README.md"), "clean\n");
    git(root, "add", "README.md");
    git(root, "commit", "-m", "clean worktree");

    expect(scanRepository(root).findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "private-user-path" })]),
    );
  });

  it("checks local Markdown links against the indexed public inventory", () => {
    const root = repository();
    writeFileSync(join(root, "README.md"), "[missing](docs/missing.md)\n");
    git(root, "add", "README.md");

    expect(scanRepository(root).findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "missing-local-documentation-link" }),
      ]),
    );
  });

  it("applies an operator denylist without printing the matched literal", () => {
    const parent = temporaryDirectory();
    const root = repository(parent);
    const literal = ["private", "instance", "marker"].join("-");
    const denylist = join(parent, "denylist.txt");
    writeFileSync(join(root, "README.md"), `${literal}\n`);
    writeFileSync(denylist, `${literal}\n`);
    git(root, "add", "README.md");

    const findings = scanRepository(root, { denylistFile: denylist }).findings;
    expect(findings).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "private-denylist-match" })]),
    );
    expect(JSON.stringify(findings)).not.toContain(literal);
  });
});

function repository(parent = temporaryDirectory()): string {
  const root = mkdtempSync(join(parent, "repository-"));
  git(root, "init", "--quiet");
  git(root, "config", "user.name", "Public Scan Test");
  git(root, "config", "user.email", "public-scan@example.invalid");
  return root;
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "naru-public-scan-"));
  temporaryDirectories.push(directory);
  return directory;
}

function privateUserPath(): string {
  return ["", "Users", "private-person", "project"].join("/");
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}
