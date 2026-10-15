import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore, AgentPlatformError } from "../src/agent-platform/core.js";
import { AgentWorkspace, worktreeSlug } from "../src/agent-runtime/workspace.js";
import { NaruRepository } from "../src/database.js";
import { GitMetadataAdapter, SystemGitCommandRunner } from "../src/git-metadata.js";
import { ProjectPathPolicy } from "../src/path-policy.js";
import { ProjectCatalogService } from "../src/project-catalog.js";
import { ProjectFileService } from "../src/project-files.js";

const HUMAN: Actor = { kind: "human" };
const agent = (agentSessionId: string): Actor => ({ kind: "agent", agentSessionId });
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

/** git with no user or system config, as Naru runs it; commits carry a fixture identity. */
function git(cwd: string, ...args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd,
    env: {
      PATH: "/usr/bin:/bin",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
    encoding: "utf8",
  }).trim();
}

async function fixture(
  options: { readonly rootIsRepository?: boolean; readonly personGitConfig?: string } = {},
) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "naru-agent-workspace-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const repositoryPath = join(root, "app");
  mkdirSync(join(repositoryPath, "docs"), { recursive: true });
  writeFileSync(join(repositoryPath, "README.md"), "app\n");
  writeFileSync(join(repositoryPath, "docs", "plan.md"), "# plan\n");
  git(repositoryPath, "init", "--quiet", "--initial-branch=main");
  git(repositoryPath, "add", ".");
  git(repositoryPath, "commit", "--quiet", "-m", "initial");
  const pathPolicy = await ProjectPathPolicy.create(
    [options.rootIsRepository === true ? repositoryPath : root],
    options.rootIsRepository === true ? { allowExactRoots: [repositoryPath] } : {},
  );
  const repository = new NaruRepository(":memory:");
  cleanups.push(() => repository.close());
  const project = repository.createProject(repositoryPath, "app");
  const core = new AgentPlatformCore(repository.agentPlatform);
  let ordinal = 0;
  const ctx = (actor: Actor) => ({
    actor,
    idempotencyKey: `60000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
  });
  const register = (role: "project-orchestrator" | "worker" | "reviewer", projectId = project.id) =>
    core.registerAgentSession(ctx(HUMAN), {
      projectId,
      role,
      runtime: "claude",
      native: false,
      observation: "transcript",
      conversationWriter: "orchestrator",
    }).id;
  const orchestrator = register("project-orchestrator");
  const worker = register("worker");
  const reviewer = register("reviewer");
  const goal = core.createHumanInstruction(ctx(HUMAN), {
    scope: { kind: "project", projectId: project.id },
    verbatim: "로그인 화면과 API를 나눠 만든다.",
  }).id;
  const task = (title: string) =>
    core.createTask(ctx(agent(orchestrator)), {
      projectId: project.id,
      title,
      purpose: "",
      completionCriteria: ["tests pass"],
      originInstructionId: goal,
      assigneeAgentSessionId: worker,
    }).id;
  const catalog = new ProjectCatalogService(repository, new GitMetadataAdapter(pathPolicy));
  const workspace = new AgentWorkspace({
    core,
    repository,
    pathPolicy,
    git: new SystemGitCommandRunner(undefined, 8_000),
    registerProject: (realPath, name) => catalog.register(realPath, name),
    ...(options.personGitConfig === undefined
      ? {}
      : { personGitConfigFiles: [join(root, "missing.gitconfig"), options.personGitConfig] }),
    checkViewPath: async (projectPath, _kind, relativePath) => {
      await new ProjectFileService().read(projectPath, relativePath, true);
    },
  });
  const pass = (taskId: string) => {
    for (const kind of ["correctness", "intent"] as const) {
      core.submitReview(ctx(agent(reviewer)), { taskId, kind, verdict: "pass", findings: "ok" });
    }
  };
  return {
    root,
    repositoryPath,
    repository,
    core,
    projectId: project.id,
    orchestrator,
    worker,
    reviewer,
    register,
    ctx,
    task,
    workspace,
    pass,
  };
}

async function expectCode(action: Promise<unknown>, code: AgentPlatformError["code"]) {
  const error = await action.then(
    () => null,
    (failure: unknown) => failure,
  );
  expect(error).toBeInstanceOf(AgentPlatformError);
  expect((error as AgentPlatformError).code).toBe(code);
  return error as AgentPlatformError;
}

describe("Agent workspace tools (AP-D004 L5/L6, AP-D016)", () => {
  it("creates a task worktree in the approved roots and connects it as a project", async () => {
    const f = await fixture();
    const taskId = f.task("로그인 화면");
    await expectCode(
      f.workspace.createWorktree(f.ctx(agent(f.worker)), { taskId, slug: "login" }),
      "AGENT_ROLE_DENIED",
    );

    const context = f.ctx(agent(f.orchestrator));
    const created = await f.workspace.createWorktree(context, {
      taskId,
      slug: "Login Screen!",
    });
    const branch = `naru/login-screen-${taskId.slice(0, 8)}`;
    expect(created.branch).toBe(branch);
    expect(created.path).toBe(join(f.root, `app-login-screen-${taskId.slice(0, 8)}`));
    expect(git(created.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(f.repository.getProject(created.projectId)?.path).toBe(created.path);
    expect(f.core.getTaskDetail(HUMAN, taskId).artifacts).toMatchObject([
      { kind: "branch", reference: branch },
    ]);
    // A retried call returns the same worktree instead of failing on the existing branch.
    await expect(
      f.workspace.createWorktree(context, { taskId, slug: "Login Screen!" }),
    ).resolves.toEqual(created);

    // The parent project's agents may work in the worktree; other projects' agents may not.
    expect(
      f.core.startSharedProcess(f.ctx(agent(f.worker)), {
        projectId: created.projectId,
        purpose: "dev",
        command: "true",
        ports: [],
        keep: "keep",
      }).projectId,
    ).toBe(created.projectId);
    const other = f.repository.createProject(join(f.root, "elsewhere"), "elsewhere");
    const stranger = f.register("worker", other.id);
    expect(() =>
      f.core.startSharedProcess(f.ctx(agent(stranger)), {
        projectId: created.projectId,
        purpose: "dev",
        command: "true",
        ports: [],
        keep: "keep",
      }),
    ).toThrow(AgentPlatformError);
  });

  it("refuses a worktree outside the approved roots", async () => {
    const f = await fixture({ rootIsRepository: true });
    const taskId = f.task("API");
    await expectCode(
      f.workspace.createWorktree(f.ctx(agent(f.orchestrator)), { taskId, slug: "api" }),
      "AGENT_SCOPE_DENIED",
    );
    expect(git(f.repositoryPath, "branch", "--list", "naru/*")).toBe("");
  });

  it("merges a reviewed branch with a merge commit and never touches a dirty checkout", async () => {
    const configDirectory = mkdtempSync(join(tmpdir(), "naru-person-git-"));
    cleanups.push(() => rmSync(configDirectory, { recursive: true, force: true }));
    const personGitConfig = join(configDirectory, "gitconfig");
    writeFileSync(personGitConfig, "[user]\n\tname = Person\n\temail = person@example.test\n");
    const f = await fixture({ personGitConfig });
    // Naru's git never runs repository hooks.
    const marker = join(f.root, "hook-ran");
    writeFileSync(
      join(f.repositoryPath, ".git", "hooks", "post-merge"),
      `#!/bin/sh\ntouch ${marker}\n`,
      {
        mode: 0o755,
      },
    );
    const first = f.task("로그인 화면");
    const second = f.task("세션 API");
    const one = await f.workspace.createWorktree(f.ctx(agent(f.orchestrator)), {
      taskId: first,
      slug: "login",
    });
    const two = await f.workspace.createWorktree(f.ctx(agent(f.orchestrator)), {
      taskId: second,
      slug: "session",
    });
    writeFileSync(join(one.path, "login.ts"), "export {};\n");
    git(one.path, "add", ".");
    git(one.path, "commit", "--quiet", "-m", "login");
    writeFileSync(join(two.path, "session.ts"), "export {};\n");
    git(two.path, "add", ".");
    git(two.path, "commit", "--quiet", "-m", "session");

    const closed = await expectCode(
      f.workspace.merge(f.ctx(agent(f.orchestrator)), { taskId: first }),
      "AGENT_INVALID_STATE",
    );
    expect(closed.message).toContain("missing-correctness-review");
    f.pass(first);
    await expectCode(
      f.workspace.merge(f.ctx(agent(f.worker)), { taskId: first }),
      "AGENT_ROLE_DENIED",
    );

    writeFileSync(join(f.repositoryPath, "README.md"), "edited by the person\n");
    const dirty = await expectCode(
      f.workspace.merge(f.ctx(agent(f.orchestrator)), { taskId: first }),
      "AGENT_INVALID_STATE",
    );
    expect(dirty.message).toContain("uncommitted changes");
    git(f.repositoryPath, "checkout", "--quiet", "--", "README.md");

    const merged = await f.workspace.merge(f.ctx(agent(f.orchestrator)), { taskId: first });
    const head = git(f.repositoryPath, "rev-parse", "HEAD");
    expect(merged).toMatchObject({ kind: "commit", reference: head });
    expect(git(f.repositoryPath, "rev-list", "--merges", "--count", "HEAD")).toBe("1");
    expect(git(f.repositoryPath, "rev-parse", "HEAD^2")).toBe(git(one.path, "rev-parse", "HEAD"));
    expect(git(f.repositoryPath, "log", "-1", "--format=%an <%ae>|%s|%b")).toBe(
      `Person <person@example.test>|Merge ${one.branch}: 로그인 화면|Naru-Task: ${first}`,
    );
    expect(existsSync(marker)).toBe(false);

    // The second branch started from the old main: it merges with its own merge commit.
    f.pass(second);
    await f.workspace.merge(f.ctx(agent(f.orchestrator)), { taskId: second });
    expect(git(f.repositoryPath, "rev-list", "--merges", "--count", "HEAD")).toBe("2");
    expect(existsSync(join(f.repositoryPath, "login.ts"))).toBe(true);
    expect(existsSync(join(f.repositoryPath, "session.ts"))).toBe(true);

    // A conflict is aborted: the person's checkout stays as it was and the agents resolve it.
    const third = f.task("소개 문구");
    const three = await f.workspace.createWorktree(f.ctx(agent(f.orchestrator)), {
      taskId: third,
      slug: "intro",
    });
    writeFileSync(join(three.path, "README.md"), "agent intro\n");
    git(three.path, "commit", "--quiet", "-am", "intro");
    writeFileSync(join(f.repositoryPath, "README.md"), "person intro\n");
    git(f.repositoryPath, "commit", "--quiet", "-am", "person edit");
    const before = git(f.repositoryPath, "rev-parse", "HEAD");
    f.pass(third);
    const conflict = await expectCode(
      f.workspace.merge(f.ctx(agent(f.orchestrator)), { taskId: third }),
      "AGENT_INVALID_STATE",
    );
    expect(conflict.message).toContain(`${three.branch} conflicts with main (README.md)`);
    expect(git(f.repositoryPath, "rev-parse", "HEAD")).toBe(before);
    expect(git(f.repositoryPath, "status", "--porcelain")).toBe("");
    expect(existsSync(join(f.repositoryPath, ".git", "MERGE_HEAD"))).toBe(false);
  });

  it("names Naru on a merge commit when neither the project nor the person has a git identity", async () => {
    const f = await fixture();
    const only = f.task("문서");
    const tree = await f.workspace.createWorktree(f.ctx(agent(f.orchestrator)), {
      taskId: only,
      slug: "docs",
    });
    writeFileSync(join(tree.path, "docs", "plan.md"), "# plan\n\n- one\n");
    git(tree.path, "commit", "--quiet", "-am", "plan");
    f.pass(only);
    await f.workspace.merge(f.ctx(agent(f.orchestrator)), { taskId: only });
    expect(git(f.repositoryPath, "log", "-1", "--format=%an <%ae>")).toBe("Naru <naru@localhost>");
  });

  it("opens a Files or Docs Pane marked as opened by an agent", async () => {
    const f = await fixture();
    await expectCode(
      f.workspace.openPane(f.ctx(agent(f.worker)), {
        projectId: f.projectId,
        kind: "docs",
        title: "계획",
        path: "README.md",
      }),
      "AGENT_SCOPE_DENIED",
    );
    await expect(
      f.workspace.openPane(f.ctx(agent(f.worker)), {
        projectId: f.projectId,
        kind: "files",
        title: "없는 파일",
        path: "missing.ts",
      }),
    ).rejects.toThrow();
    const opened = await f.workspace.openPane(f.ctx(agent(f.worker)), {
      projectId: f.projectId,
      kind: "files",
      title: "README",
      path: "README.md",
    });
    const pane = f.repository
      .getWorkspace(f.projectId)
      .panes.find((candidate) => candidate.id === opened.paneId);
    expect(pane).toMatchObject({
      kind: "files",
      title: "README · agent",
      viewState: { selectedDocumentPath: "README.md" },
    });
    expect(existsSync(join(f.repositoryPath, "README.md"))).toBe(true);
  });

  it("lets orchestrators interrupt workers only while no person holds them", async () => {
    const f = await fixture();
    expect(() => f.core.authorizeInterrupt(agent(f.worker), f.reviewer)).toThrow(
      AgentPlatformError,
    );
    expect(() => f.core.authorizeInterrupt(agent(f.orchestrator), f.orchestrator)).toThrow(
      AgentPlatformError,
    );
    expect(f.core.authorizeInterrupt(agent(f.orchestrator), f.worker).id).toBe(f.worker);
    f.core.setHumanHold(f.ctx(HUMAN), {
      agentSessionId: f.worker,
      held: true,
      reason: "takeover",
    });
    try {
      f.core.authorizeInterrupt(agent(f.orchestrator), f.worker);
      expect.unreachable();
    } catch (error) {
      expect((error as AgentPlatformError).code).toBe("AGENT_HELD_BY_HUMAN");
    }
  });
});

describe("worktreeSlug", () => {
  it("keeps lowercase letters, digits and dashes", () => {
    expect(worktreeSlug("Login Screen!")).toBe("login-screen");
    expect(worktreeSlug("../../etc")).toBe("etc");
    expect(worktreeSlug("한글만")).toBe("task");
    expect(worktreeSlug("a".repeat(50))).toHaveLength(32);
  });
});
