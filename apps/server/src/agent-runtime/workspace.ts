import { access } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Artifact } from "@naru/contracts/naru-agent/v1";
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
  /** Throws when the path is not a readable document or file inside the project. */
  readonly checkViewPath: (
    projectPath: string,
    kind: "files" | "docs",
    relativePath: string,
  ) => Promise<void>;
}

/**
 * Workspace and merge tools (AP-D004 L5/L6, AP-D016). Core decides who may act; this class does the
 * git and Naru project work. Naru never pushes and merges only by fast-forward, so a merge cannot
 * leave conflicts in the person's checkout.
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
   * Fast-forwards the branch checked out in the task's project to the task's branch once the merge
   * gate is open. Refuses a dirty checkout, a detached HEAD and a branch that diverged.
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
    await this.#git(project.path, root, ["merge", "--ff-only", "--quiet", `refs/heads/${branch}`], {
      refusal:
        `${branch} cannot fast-forward ${target}. Rebase the task branch onto ${target} in its ` +
        "worktree, get it reviewed again, then merge.",
    });
    const commit = (await this.#git(project.path, root, ["rev-parse", "HEAD"])).trim();
    return core.recordMerge(context, {
      taskId: task.id,
      commit,
      summary: `${branch} → ${target} (fast-forward)`,
    });
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
    options: { readonly refusal?: string } = {},
  ): Promise<string> {
    try {
      return (await this.#options.git.run(cwd, root, args)).toString("utf8");
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
