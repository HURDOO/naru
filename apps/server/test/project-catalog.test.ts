import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NaruRepository } from "../src/database.js";
import { GitMetadataAdapter } from "../src/git-metadata.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { ProjectCatalogService } from "../src/project-catalog.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectCatalogService", () => {
  it("discovers a worktree without creating state until the user connects it", async () => {
    const fixture = await createFixture();
    try {
      const repositoryPath = await createGitRepository(fixture.root, "repository");
      const linkedPath = join(fixture.root, "repository-feature");
      const primary = await fixture.catalog.register(repositoryPath, "Repository");
      runGit(repositoryPath, ["worktree", "add", "-b", "feature/sidebar", linkedPath]);

      const before = await fixture.catalog.list();
      expect(before).toHaveLength(1);
      expect(before[0]).toMatchObject({ name: "Repository", kind: "git" });
      expect(before[0]?.targets).toEqual([
        expect.objectContaining({
          registration: "connected",
          projectId: primary.id,
          label: "release",
        }),
        expect.objectContaining({
          registration: "discovered",
          label: "feature/sidebar",
          path: await realpath(linkedPath),
        }),
      ]);
      expect(fixture.repository.listProjects()).toHaveLength(1);

      const connected = await fixture.catalog.connect(before[0]!.id, await realpath(linkedPath));
      expect(fixture.repository.listProjects()).toHaveLength(2);
      expect(fixture.repository.getWorkspace(connected.id).projectId).toBe(connected.id);
      expect(fixture.repository.getWorkspace(primary.id).projectId).toBe(primary.id);
      const after = await fixture.catalog.list();
      expect(after[0]?.targets.map(({ registration }) => registration)).toEqual([
        "connected",
        "connected",
      ]);
    } finally {
      fixture.repository.close();
    }
  });

  it("merges existing registered worktrees without changing Project or Workspace IDs", async () => {
    const fixture = await createFixture();
    try {
      const repositoryPath = await createGitRepository(fixture.root, "repository");
      const linkedPath = join(fixture.root, "repository-feature");
      runGit(repositoryPath, ["worktree", "add", "-b", "feature/catalog", linkedPath]);
      const primary = fixture.repository.createProject(repositoryPath, "Repository");
      const linked = fixture.repository.createProject(await realpath(linkedPath), "Feature");
      const primaryWorkspace = fixture.repository.getWorkspace(primary.id);
      const linkedWorkspace = fixture.repository.getWorkspace(linked.id);

      const groups = await fixture.catalog.refresh();
      expect(groups).toHaveLength(1);
      expect(groups[0]?.targets).toHaveLength(2);
      expect(fixture.repository.getWorkspace(primary.id)).toEqual(primaryWorkspace);
      expect(fixture.repository.getWorkspace(linked.id)).toEqual(linkedWorkspace);
      expect(fixture.repository.listStoredProjectTargets().map(({ id }) => id)).toEqual(
        expect.arrayContaining([primary.id, linked.id]),
      );
    } finally {
      fixture.repository.close();
    }
  });

  it("preserves a registered subfolder cwd and discovers the same subfolder in linked worktrees", async () => {
    const fixture = await createFixture();
    try {
      const repositoryPath = await createGitRepository(fixture.root, "repository");
      const primarySubfolder = join(repositoryPath, "apps", "web");
      await mkdir(primarySubfolder, { recursive: true });
      await writeFile(join(primarySubfolder, "package.json"), "{}\n");
      runGit(repositoryPath, ["add", "apps/web/package.json"]);
      runGit(repositoryPath, [
        "-c",
        "user.name=Naru Test",
        "-c",
        "user.email=naru@example.invalid",
        "commit",
        "-m",
        "add web project",
      ]);

      const web = await fixture.catalog.register(primarySubfolder, "Web");
      await fixture.catalog.register(repositoryPath, "Repository root");
      const linkedPath = join(fixture.root, "repository-feature");
      runGit(repositoryPath, ["worktree", "add", "-b", "feature/web", linkedPath]);

      const groups = await fixture.catalog.list();
      expect(groups).toHaveLength(2);
      const webGroup = groups.find((group) =>
        group.targets.some(
          (target) => target.registration === "connected" && target.projectId === web.id,
        ),
      );
      expect(webGroup?.targets).toEqual([
        expect.objectContaining({
          registration: "connected",
          path: await realpath(primarySubfolder),
        }),
        expect.objectContaining({
          registration: "discovered",
          path: await realpath(join(linkedPath, "apps", "web")),
        }),
      ]);

      const discovered = webGroup?.targets.find((target) => target.registration === "discovered");
      if (!webGroup || !discovered) throw new Error("Expected linked web target.");
      const connected = await fixture.catalog.connect(webGroup.id, discovered.path);
      expect(connected.path).toBe(await realpath(join(linkedPath, "apps", "web")));
    } finally {
      fixture.repository.close();
    }
  });

  it("keeps a connected target identity across branch changes and missing paths", async () => {
    const fixture = await createFixture();
    try {
      const repositoryPath = await createGitRepository(fixture.root, "repository");
      const linkedPath = join(fixture.root, "repository-feature");
      await fixture.catalog.register(repositoryPath, "Repository");
      runGit(repositoryPath, ["worktree", "add", "-b", "feature/one", linkedPath]);
      const group = (await fixture.catalog.list())[0]!;
      const connected = await fixture.catalog.connect(group.id, await realpath(linkedPath));
      const workspace = fixture.repository.getWorkspace(connected.id);

      runGit(linkedPath, ["switch", "-c", "feature/two"]);
      const changed = await fixture.catalog.list();
      expect(findConnected(changed[0]!, connected.id)).toMatchObject({
        label: "feature/two",
        availability: "ready",
      });
      expect(fixture.repository.getWorkspace(connected.id)).toEqual(workspace);

      await rm(linkedPath, { recursive: true });
      const missing = await fixture.catalog.list();
      expect(findConnected(missing[0]!, connected.id)).toMatchObject({
        projectId: connected.id,
        availability: "missing",
        git: null,
      });
      expect(fixture.repository.getWorkspace(connected.id)).toEqual(workspace);
    } finally {
      fixture.repository.close();
    }
  });

  it("keeps non-Git folders standalone and rejects paths not currently discovered", async () => {
    const fixture = await createFixture();
    try {
      const plain = join(fixture.root, "plain");
      const unrelated = join(fixture.root, "unrelated");
      await mkdir(plain);
      await mkdir(unrelated);
      await fixture.catalog.register(plain, "Plain");
      const group = (await fixture.catalog.list())[0]!;
      expect(group).toMatchObject({ kind: "standalone" });
      expect(group.targets).toEqual([
        expect.objectContaining({ registration: "connected", git: null }),
      ]);

      await expect(fixture.catalog.connect(group.id, unrelated)).rejects.toMatchObject({
        code: "PROJECT_GROUP_MISSING",
      });
    } finally {
      fixture.repository.close();
    }
  });
});

interface Fixture {
  root: string;
  repository: NaruRepository;
  catalog: ProjectCatalogService;
}

async function createFixture(): Promise<Fixture> {
  const base = await mkdtemp(join(tmpdir(), "naru-project-catalog-"));
  temporaryDirectories.push(base);
  const root = join(base, "coding");
  await mkdir(root);
  const policy = await ProjectPathPolicy.create([root]);
  const repository = new NaruRepository(join(base, "naru.sqlite"));
  return {
    root,
    repository,
    catalog: new ProjectCatalogService(repository, new GitMetadataAdapter(policy)),
  };
}

async function createGitRepository(root: string, name: string): Promise<string> {
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

function findConnected(
  group: Awaited<ReturnType<ProjectCatalogService["list"]>>[number],
  projectId: string,
) {
  return group.targets.find(
    (target) => target.registration === "connected" && target.projectId === projectId,
  );
}
