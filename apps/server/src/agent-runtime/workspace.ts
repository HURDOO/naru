import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { AgentWorktree, Artifact } from "@naru/contracts/naru-agent/v1";
import {
  AgentPlatformError,
  type AgentPlatformCore,
  type CommandContext,
} from "../agent-platform/core.js";
import type { NaruRepository } from "../database.js";
import { AppError } from "../errors.js";
import { GitCommandError, type GitCommandRunner } from "../git-metadata.js";
import type { ProjectPathPolicy } from "../path-policy.js";

/** Git work stays under the agent socket's idle timeout so a slow command fails, not the call. */
export const AGENT_GIT_TIMEOUT_MS = 8_000;

export interface AgentWorkspaceOptions {
  readonly core: AgentPlatformCore;
  readonly repository: NaruRepository;
  readonly pathPolicy: ProjectPathPolicy;
  readonly git: GitCommandRunner;
  /** Registers a path as a Naru project (the catalog groups worktrees with their repository). */
  readonly registerProject: (realPath: string, name: string) => Promise<{ readonly id: string }>;
  /**
   * The person's own git config files (e.g. `~/.gitconfig`). Naru's git runs without them, so the
   * merge commit's identity is read from them; the project's own identity comes first.
   */
  readonly personGitConfigFiles?: readonly string[];
  /** Whether a Pane's session runs now; a worktree with one running stays (AP-D036). */
  readonly paneRunning?: (paneId: string) => boolean;
  /** Throws when the path is not a readable document or file inside the project. */
  readonly checkViewPath: (
    projectPath: string,
    kind: "files" | "docs",
    relativePath: string,
  ) => Promise<void>;
}

/**
 * Workspace and merge tools (AP-D004 L5/L6, AP-D016, AP-D019). Core decides who may act; this class
 * does the git and Naru project work. Naru never pushes. A merge commits on its own or not at all: a
 * conflict is aborted, so it never leaves conflicts in the person's checkout.
 */
export class AgentWorkspace {
  readonly #options: AgentWorkspaceOptions;

  constructor(options: AgentWorkspaceOptions) {
    this.#options = options;
  }

  /**
   * Creates `naru/<slug>-<task>` in a sibling worktree inside the approved roots, connects it as a
   * Naru project and records the branch on the task. A retry returns the same worktree.
   */
  async createWorktree(
    context: CommandContext,
    input: { readonly taskId: string; readonly slug: string },
  ): Promise<{ readonly projectId: string; readonly path: string; readonly branch: string }> {
    const { core, repository, pathPolicy } = this.#options;
    const task = core.authorizeWorktree(context.actor, input.taskId);
    const slug = worktreeSlug(input.slug);
    const suffix = task.id.slice(0, 8);
    const branch = `naru/${slug}-${suffix}`;
    const existing = core.findTaskWorktree(task.id, branch);
    if (existing !== null) {
      const project = repository.getProject(existing.projectId);
      if (project !== undefined) return { projectId: project.id, path: project.path, branch };
    }
    const parent = this.#project(task.projectId);
    const root = this.#approvedRoot(parent.path);
    const target = join(dirname(parent.path), `${basename(parent.path)}-${slug}-${suffix}`);
    // The parent path is canonical, so its sibling cannot escape through a symlink.
    if (pathPolicy.approvedRootFor(target) === undefined) {
      throw new AgentPlatformError(
        "AGENT_SCOPE_DENIED",
        "The worktree would be outside the approved project roots.",
      );
    }
    if (await exists(target)) {
      throw new AgentPlatformError("AGENT_INVALID_STATE", "The worktree directory already exists.");
    }
    await this.#git(parent.path, root, ["worktree", "add", "-b", branch, target, "HEAD"]);
    const validated = await translate(() => pathPolicy.validate(target));
    const project = await translate(() =>
      this.#options.registerProject(validated.realPath, `${parent.name} · ${slug}`),
    );
    core.recordWorktree(context, { taskId: task.id, worktreeProjectId: project.id, branch });
    return { projectId: project.id, path: validated.realPath, branch };
  }

  /**
   * Merges the task's branch into the branch checked out in the task's project with a merge commit
   * once the merge gate is open (AP-D019). Refuses a dirty checkout and a detached HEAD; a conflict
   * is aborted and refused, so the agents resolve it in the task's worktree.
   */
  async merge(context: CommandContext, input: { readonly taskId: string }): Promise<Artifact> {
    const { core } = this.#options;
    const { task, branch } = core.authorizeMerge(context.actor, input.taskId);
    const project = this.#project(task.projectId);
    const root = this.#approvedRoot(project.path);
    if (!/^[A-Za-z0-9._/-]+$/u.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      throw new AgentPlatformError("AGENT_INVALID_STATE", "The task branch name is not usable.");
    }
    const target = (
      await this.#git(project.path, root, ["symbolic-ref", "--quiet", "--short", "HEAD"], {
        refusal: "The project has no branch checked out (detached HEAD).",
      })
    ).trim();
    if (target === branch) {
      throw new AgentPlatformError(
        "AGENT_INVALID_STATE",
        "The project already has the task branch checked out.",
      );
    }
    const changes = await this.#git(project.path, root, [
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    if (changes.trim() !== "") {
      throw new AgentPlatformError(
        "AGENT_INVALID_STATE",
        `The project checkout of ${target} has uncommitted changes; ask the person first.`,
      );
    }
    const before = (await this.#git(project.path, root, ["rev-parse", "HEAD"])).trim();
    const title = task.title.replace(/\s+/gu, " ").trim().slice(0, 100);
    try {
      await this.#git(
        project.path,
        root,
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "--quiet",
          "-m",
          `Merge ${branch}: ${title}`,
          "-m",
          `Naru-Task: ${task.id}`,
          `refs/heads/${branch}`,
        ],
        { config: [...MERGE_CONFIG, ...(await this.#identity(project.path, root))] },
      );
    } catch (error) {
      throw await this.#refuseMerge(project.path, root, branch, target, error);
    }
    const commit = (await this.#git(project.path, root, ["rev-parse", "HEAD"])).trim();
    return core.recordMerge(context, {
      taskId: task.id,
      commit,
      summary:
        commit === before
          ? `${branch} was already in ${target}`
          : `${branch} → ${target} (merge commit)`,
    });
  }

  /**
   * Removes a merged task's worktree and branch when its job completes (AP-D030, AP-D036): only a
   * worktree Naru made, with nothing uncommitted or untracked, whose branch is in the merge commit
   * and whose project has no running Pane and no Agent Platform record. Anything else stays, with the reason.
   * Remote repositories are never touched.
   */
  async removeMergedWorktree(
    worktree: AgentWorktree,
    mergeCommit: string,
  ): Promise<WorktreeRemoval> {
    const { core, repository } = this.#options;
    const branch = worktree.branch;
    const kept = (reason: NonNullable<WorktreeRemoval["reason"]>): WorktreeRemoval => ({
      branch,
      removed: false,
      branchDeleted: false,
      reason,
    });
    const project = repository.getProject(worktree.projectId);
    const parent = repository.getProject(worktree.parentProjectId);
    if (project === undefined || parent === undefined) return kept("missing");
    if (!/^[A-Za-z0-9._/-]+$/u.test(branch) || branch.startsWith("-") || branch.includes("..")) {
      return kept("failed");
    }
    if (!/^[0-9a-f]{7,64}$/u.test(mergeCommit)) return kept("unmerged");
    // Every project has Pane records; one that runs (a terminal or agent in the worktree) counts.
    const running = this.#options.paneRunning ?? (() => false);
    if (
      repository.getWorkspace(project.id).panes.some((pane) => running(pane.id)) ||
      core.countProjectAgentRecords(project.id) > 0
    ) {
      return kept("in-use");
    }
    let root: string;
    try {
      root = this.#approvedRoot(parent.path);
      this.#approvedRoot(project.path);
    } catch {
      return kept("failed");
    }
    try {
      const changes = await this.#git(project.path, root, [
        "status",
        "--porcelain",
        "--untracked-files=all",
      ]);
      if (changes.trim() !== "") return kept("changes");
      const merged = await this.#git(parent.path, root, [
        "merge-base",
        "--is-ancestor",
        `refs/heads/${branch}`,
        mergeCommit,
      ]).then(
        () => true,
        () => false,
      );
      if (!merged) return kept("unmerged");
      // Without --force: git itself refuses a worktree that is not clean.
      await this.#git(parent.path, root, ["worktree", "remove", project.path]);
    } catch {
      return kept("failed");
    }
    const branchDeleted = await this.#git(parent.path, root, ["branch", "-d", branch]).then(
      () => true,
      () => false,
    );
    repository.deleteProject(project.id);
    return { branch, removed: true, branchDeleted, reason: null };
  }

  /**
   * A failed merge that stopped on conflicts is aborted, so the person's checkout is as it was; the
   * agents resolve the conflict in the task's worktree and get the result reviewed again.
   */
  async #refuseMerge(
    cwd: string,
    root: string,
    branch: string,
    target: string,
    error: unknown,
  ): Promise<unknown> {
    const merging = await this.#git(cwd, root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).then(
      () => true,
      () => false,
    );
    if (!merging) return error;
    const conflicted = (
      await this.#git(cwd, root, ["diff", "--name-only", "--diff-filter=U"]).catch(() => "")
    )
      .split("\n")
      .filter((line) => line !== "");
    const restored = await this.#git(cwd, root, ["merge", "--abort"]).then(
      () => true,
      () => false,
    );
    const files =
      conflicted.length === 0
        ? ""
        : ` (${conflicted.slice(0, 20).join(", ")}${conflicted.length > 20 ? ", …" : ""})`;
    return new AgentPlatformError(
      "AGENT_INVALID_STATE",
      restored
        ? `${branch} conflicts with ${target}${files}. Merge ${target} into the task branch in its ` +
            "worktree, resolve the conflicts, get it reviewed again, then merge."
        : `${branch} conflicts with ${target}${files} and the merge could not be undone; ask the ` +
            "person to look at the project checkout.",
    );
  }

  /** The merge commit's identity: the project's own, else the person's, else Naru's. */
  async #identity(cwd: string, root: string): Promise<readonly string[]> {
    const sources = [
      [],
      ...(this.#options.personGitConfigFiles ?? []).map((file) => ["--file", file]),
    ];
    for (const source of sources) {
      const read = (key: string) =>
        this.#git(cwd, root, ["config", ...source, "--get", key]).then(
          (value) => value.trim(),
          () => "",
        );
      const name = await read("user.name");
      const email = await read("user.email");
      if (name !== "" && email !== "") return [`user.name=${name}`, `user.email=${email}`];
    }
    return ["user.name=Naru", "user.email=naru@localhost"];
  }

  /** Opens a Files or Docs Pane for the person, titled so they know an agent opened it. */
  async openPane(
    context: CommandContext,
    input: {
      readonly projectId: string;
      readonly kind: "files" | "docs";
      readonly title: string;
      readonly path?: string;
    },
  ): Promise<{ readonly paneId: string; readonly projectId: string }> {
    const { core, repository } = this.#options;
    core.authorizePaneOpen(context.actor, input.projectId);
    const project = this.#project(input.projectId);
    if (input.path !== undefined) {
      if (input.kind === "docs" && !input.path.startsWith("docs/")) {
        throw new AgentPlatformError(
          "AGENT_SCOPE_DENIED",
          "A Docs Pane opens documents under docs/ only.",
        );
      }
      await translate(() => this.#options.checkViewPath(project.path, input.kind, input.path!));
    }
    const pane = await translate(() =>
      Promise.resolve().then(() =>
        repository.createAgentViewPane(
          project.id,
          input.kind,
          `${input.title} · agent`,
          input.path ?? null,
        ),
      ),
    );
    return { paneId: pane.id, projectId: project.id };
  }

  #project(projectId: string): {
    readonly id: string;
    readonly name: string;
    readonly path: string;
  } {
    const project = this.#options.repository.getProject(projectId);
    if (project === undefined) {
      throw new AgentPlatformError("AGENT_NOT_FOUND", "The project is no longer connected.");
    }
    return project;
  }

  #approvedRoot(path: string): string {
    const root = this.#options.pathPolicy.approvedRootFor(path);
    if (root === undefined) {
      throw new AgentPlatformError(
        "AGENT_SCOPE_DENIED",
        "The project is outside the approved project roots.",
      );
    }
    return root;
  }

  async #git(
    cwd: string,
    root: string,
    args: readonly string[],
    options: { readonly refusal?: string; readonly config?: readonly string[] } = {},
  ): Promise<string> {
    const config = (options.config ?? []).flatMap((entry) => ["-c", entry]);
    try {
      return (await this.#options.git.run(cwd, root, [...config, ...args])).toString("utf8");
    } catch (error) {
      if (error instanceof GitCommandError && error.reason === "exit") {
        throw new AgentPlatformError(
          "AGENT_INVALID_STATE",
          options.refusal ?? `git ${args[0]} failed: ${firstLine(error.stderr)}`,
        );
      }
      throw new AgentPlatformError(
        "AGENT_RUNTIME_UNAVAILABLE",
        `git ${args[0]} did not finish in time.`,
      );
    }
  }
}

/** What became of a merged task's worktree when its job completed (AP-D036). */
export interface WorktreeRemoval {
  readonly branch: string;
  readonly removed: boolean;
  /** `git branch -d` refuses a branch that is not merged into the checked-out branch. */
  readonly branchDeleted: boolean;
  /**
   * Why it stays: uncommitted or untracked work (`changes`), commits not in the merge
   * (`unmerged`), a Pane or Naru record in its project (`in-use`), already gone (`missing`), or git
   * refused (`failed`).
   */
  readonly reason: "changes" | "unmerged" | "in-use" | "missing" | "failed" | null;
}

/** Naru's own git never runs repository code: hooks would run in the server with its bare env. */
const MERGE_CONFIG = ["core.hooksPath=/dev/null"] as const;

/** Lowercase letters, digits and dashes; what is left of the agent's label, never empty. */
export function worktreeSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32)
    .replace(/-+$/u, "");
  return slug === "" ? "task" : slug;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function firstLine(stderr: Buffer): string {
  return (
    stderr
      .toString("utf8")
      .split("\n")
      .find((line) => line.trim() !== "")
      ?.trim() ?? ""
  );
}

/** Naru's own refusals (path policy, catalog) reach the agent as Agent Platform errors. */
async function translate<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AppError) {
      throw new AgentPlatformError(
        error.statusCode === 403 ? "AGENT_SCOPE_DENIED" : "AGENT_INVALID_STATE",
        error.message,
      );
    }
    throw error;
  }
}
