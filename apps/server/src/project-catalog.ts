import type {
  ConnectedProjectTarget,
  GitHead,
  GitWorktreeMetadata,
  Project,
  ProjectActivity,
  ProjectGroup,
  ProjectTargetAvailability,
} from "@naru/contracts";
import { ProjectGroupSchema } from "@naru/contracts";
import { isAbsolute, relative, sep } from "node:path";
import type { NaruRepository, StoredProjectGroup, StoredProjectTarget } from "./database.js";
import { AppError } from "./errors.js";
import { GitMetadataError } from "./git-metadata.js";
import type {
  GitMetadataAdapter,
  GitProjectInspection,
  GitWorktreeInspection,
} from "./git-metadata.js";

interface InspectedTarget {
  target: StoredProjectTarget;
  inspection: GitProjectInspection | null;
  availability: ProjectTargetAvailability;
}

export class ProjectCatalogService {
  readonly #repository: NaruRepository;
  readonly #git: GitMetadataAdapter;

  constructor(repository: NaruRepository, git: GitMetadataAdapter) {
    this.#repository = repository;
    this.#git = git;
  }

  async refresh(): Promise<ProjectGroup[]> {
    const targets = this.#repository.listStoredProjectTargets();
    for (const target of targets) {
      let inspection: GitProjectInspection;
      try {
        inspection = await this.#git.inspect(target.path);
      } catch {
        continue;
      }
      if (inspection.kind === "non-git") {
        this.#repository.assignProjectToStandaloneGroup(target.id);
      } else {
        this.#repository.assignProjectToGitGroup(
          target.id,
          inspection.commonDirectory,
          projectRelativePath(inspection),
        );
      }
    }
    return this.list();
  }

  async list(): Promise<ProjectGroup[]> {
    const [groups, targets] = [
      this.#repository.listStoredProjectGroups(),
      this.#repository.listStoredProjectTargets(),
    ];
    const inspected = await Promise.all(targets.map((target) => this.#inspectTarget(target)));
    const inspectionsByProject = new Map(
      inspected.map((result) => [result.target.id, result] as const),
    );
    const connectedPaths = new Set(targets.map((target) => target.path));

    return Promise.all(
      groups.map(async (group) => {
        const groupTargets = targets.filter((target) => target.groupId === group.id);
        const connected = groupTargets.map((target) =>
          this.#connectedTarget(group, inspectionsByProject.get(target.id)!),
        );
        const discovered =
          group.kind === "git"
            ? await this.#discoveredTargets(group, inspected, connectedPaths)
            : [];
        return ProjectGroupSchema.parse({
          id: group.id,
          name: group.name,
          kind: group.kind,
          activity: aggregateActivity(groupTargets.map((target) => target.activity)),
          targets: [...sortConnectedTargets(connected), ...discovered],
          createdAt: group.createdAt,
          updatedAt: group.updatedAt,
        });
      }),
    );
  }

  async register(realPath: string, name: string): Promise<Project> {
    const inspection = await this.#requiredInspection(realPath);
    const project = this.#repository.createProject(realPath, name);
    if (inspection.kind !== "non-git") {
      this.#repository.assignProjectToGitGroup(
        project.id,
        inspection.commonDirectory,
        projectRelativePath(inspection),
      );
    }
    return this.#repository.getProject(project.id) as Project;
  }

  async connect(groupId: string, path: string): Promise<Project> {
    const group = this.#repository.getStoredProjectGroup(groupId);
    if (
      group === undefined ||
      group.kind !== "git" ||
      group.gitCommonDirectory === null ||
      group.gitRelativePath === null
    ) {
      throw new AppError("PROJECT_GROUP_MISSING", 404, "Git 프로젝트 그룹을 찾을 수 없습니다.");
    }
    if (this.#repository.listStoredProjectTargets().some((target) => target.path === path)) {
      throw new AppError("PROJECT_DUPLICATE", 409, "이미 연결된 프로젝트 작업공간입니다.");
    }

    const inspection = await this.#requiredInspection(path);
    const currentGroup = this.#repository.getStoredProjectGroup(groupId);
    if (
      inspection.kind !== "worktree" ||
      currentGroup === undefined ||
      currentGroup.gitCommonDirectory !== inspection.commonDirectory ||
      currentGroup.gitRelativePath !== projectRelativePath(inspection)
    ) {
      throw new AppError(
        "PROJECT_TARGET_NOT_DISCOVERED",
        409,
        "현재 Git 프로젝트에서 연결 가능한 worktree를 찾을 수 없습니다.",
      );
    }
    const worktree = inspection.worktrees.find(
      (candidate) => candidate.current && !candidate.prunable,
    );
    if (worktree === undefined) {
      throw new AppError(
        "PROJECT_TARGET_NOT_DISCOVERED",
        409,
        "현재 Git 프로젝트에서 연결 가능한 worktree를 찾을 수 없습니다.",
      );
    }
    if (
      this.#repository
        .listStoredProjectTargets()
        .some((target) => target.path === inspection.registeredPath)
    ) {
      throw new AppError("PROJECT_DUPLICATE", 409, "이미 연결된 프로젝트 작업공간입니다.");
    }
    const name = boundedTargetName(currentGroup.name, worktreeLabel(worktree));
    return this.#repository.createProject(inspection.registeredPath, name, currentGroup.id);
  }

  async #inspectTarget(target: StoredProjectTarget): Promise<InspectedTarget> {
    try {
      return { target, inspection: await this.#git.inspect(target.path), availability: "ready" };
    } catch (error) {
      return { target, inspection: null, availability: availabilityFrom(error) };
    }
  }

  #connectedTarget(group: StoredProjectGroup, inspected: InspectedTarget): ConnectedProjectTarget {
    const { target, inspection } = inspected;
    let git: ConnectedProjectTarget["git"] = null;
    let availability = inspected.availability;
    if (group.kind === "git" && inspection !== null) {
      if (inspection.kind === "bare" && inspection.commonDirectory === group.gitCommonDirectory) {
        git = { kind: "bare" };
      } else if (
        inspection.kind === "worktree" &&
        inspection.commonDirectory === group.gitCommonDirectory &&
        projectRelativePath(inspection) === group.gitRelativePath
      ) {
        const current = inspection.worktrees.find((worktree) => worktree.current);
        git = current === undefined ? null : gitWorktreeMetadata(current);
      }
      if (git === null) availability = "invalid";
    }
    return {
      registration: "connected",
      projectId: target.id,
      label: git === null ? target.name : gitLabel(git),
      path: target.path,
      availability,
      git,
      activity: target.activity,
      createdAt: target.createdAt,
      updatedAt: target.updatedAt,
    };
  }

  async #discoveredTargets(
    group: StoredProjectGroup,
    inspected: readonly InspectedTarget[],
    connectedPaths: ReadonlySet<string>,
  ): Promise<ProjectGroup["targets"]> {
    if (group.gitCommonDirectory === null || group.gitRelativePath === null) return [];
    const discovered = new Map<string, GitWorktreeInspection>();
    for (const result of inspected) {
      if (
        result.inspection?.kind !== "worktree" ||
        result.inspection.commonDirectory !== group.gitCommonDirectory
      ) {
        continue;
      }
      for (const worktree of result.inspection.worktrees) {
        if (worktree.prunable) continue;
        discovered.set(worktree.path, worktree);
      }
    }
    const candidates = await Promise.all(
      [...discovered.values()].map(async (worktree) => {
        try {
          const targetPath = await this.#git.resolveProjectPath(
            worktree.path,
            group.gitRelativePath!,
          );
          return connectedPaths.has(targetPath) ? null : { targetPath, worktree };
        } catch {
          return null;
        }
      }),
    );
    return candidates
      .filter(
        (candidate): candidate is { targetPath: string; worktree: GitWorktreeInspection } =>
          candidate !== null,
      )
      .sort((left, right) => compareWorktrees(left.worktree, right.worktree))
      .map(({ targetPath, worktree }) => ({
        registration: "discovered" as const,
        label: worktreeLabel(worktree),
        path: targetPath,
        availability: "ready" as const,
        git: gitWorktreeMetadata(worktree),
      }));
  }

  async #requiredInspection(path: string): Promise<GitProjectInspection> {
    try {
      return await this.#git.inspect(path);
    } catch (error) {
      throw gitAppError(error);
    }
  }
}

function projectRelativePath(
  inspection: Exclude<GitProjectInspection, { kind: "non-git" }>,
): string {
  if (inspection.kind === "bare") return "";
  const projectPath = relative(inspection.currentWorktreePath, inspection.registeredPath);
  if (isAbsolute(projectPath) || projectPath === ".." || projectPath.startsWith(`..${sep}`)) {
    throw new AppError("PROJECT_GIT_INVALID", 400, "Git 작업 폴더 경계를 확인할 수 없습니다.");
  }
  return projectPath;
}

function gitWorktreeMetadata(worktree: GitWorktreeInspection): GitWorktreeMetadata {
  return {
    kind: "worktree",
    role: worktree.role,
    head: worktree.head,
    locked: worktree.locked,
    prunable: worktree.prunable,
  };
}

function gitLabel(git: NonNullable<ConnectedProjectTarget["git"]>): string {
  return git.kind === "bare" ? "bare repository" : worktreeLabel(git);
}

function worktreeLabel(worktree: Pick<GitWorktreeMetadata, "head">): string {
  return headLabel(worktree.head);
}

function headLabel(head: GitHead): string {
  switch (head.kind) {
    case "branch":
      return head.name;
    case "detached":
      return `detached @ ${head.oid.slice(0, 7)}`;
    case "unborn":
      return `${head.name ?? "unborn"} · unborn`;
  }
}

function boundedTargetName(groupName: string, targetLabel: string): string {
  const name = `${groupName} · ${targetLabel}`;
  return name.length <= 120 ? name : `${name.slice(0, 119)}…`;
}

function sortConnectedTargets(
  targets: readonly ConnectedProjectTarget[],
): ConnectedProjectTarget[] {
  return [...targets].sort((left, right) => {
    const leftPrimary = left.git?.kind === "worktree" && left.git.role === "primary" ? 0 : 1;
    const rightPrimary = right.git?.kind === "worktree" && right.git.role === "primary" ? 0 : 1;
    return leftPrimary - rightPrimary || left.createdAt.localeCompare(right.createdAt);
  });
}

function compareWorktrees(left: GitWorktreeInspection, right: GitWorktreeInspection): number {
  const role = Number(left.role === "linked") - Number(right.role === "linked");
  return role || left.path.localeCompare(right.path);
}

function aggregateActivity(activities: readonly ProjectActivity[]): ProjectActivity {
  const state = activities.reduce<ProjectActivity["state"]>(
    (highest, activity) =>
      activityPriority(activity.state) > activityPriority(highest) ? activity.state : highest,
    "idle",
  );
  const updatedAt =
    activities
      .filter((activity) => activity.state === state && activity.updatedAt !== null)
      .map((activity) => activity.updatedAt!)
      .sort()
      .at(-1) ?? null;
  return {
    state,
    interactionRequiredCount: activities.reduce(
      (count, activity) => count + activity.interactionRequiredCount,
      0,
    ),
    updatedAt,
  };
}

function activityPriority(state: ProjectActivity["state"]): number {
  switch (state) {
    case "interaction-required":
      return 7;
    case "failed":
      return 6;
    case "completed":
      return 5;
    case "server-stopped":
      return 4;
    case "canceled":
      return 3;
    case "running":
      return 2;
    case "idle":
      return 1;
  }
}

function availabilityFrom(error: unknown): ProjectTargetAvailability {
  if (error instanceof AppError) {
    if (error.code === "PROJECT_MISSING") return "missing";
    if (error.code === "PROJECT_PERMISSION_DENIED") return "permission-denied";
    if (error.code === "PROJECT_OUTSIDE_ROOT") return "outside-root";
  }
  if (error instanceof GitMetadataError) {
    if (error.code === "missing") return "missing";
    if (error.code === "permission-denied") return "permission-denied";
    if (error.code === "outside-root") return "outside-root";
  }
  return "invalid";
}

function gitAppError(error: unknown): AppError {
  if (error instanceof AppError) return error;
  if (error instanceof GitMetadataError) {
    if (error.code === "outside-root") {
      return new AppError(
        "PROJECT_OUTSIDE_ROOT",
        403,
        "Git 저장소 또는 worktree가 허용된 프로젝트 루트 밖에 있습니다.",
      );
    }
    if (error.code === "permission-denied") {
      return new AppError(
        "PROJECT_PERMISSION_DENIED",
        403,
        "Git 저장소 metadata를 읽을 권한이 없습니다.",
      );
    }
    if (error.code === "missing") {
      return new AppError("PROJECT_MISSING", 404, "Git 저장소 경로를 찾을 수 없습니다.");
    }
    if (error.code === "invalid-output") {
      return new AppError("PROJECT_GIT_INVALID", 422, "Git 저장소 metadata가 올바르지 않습니다.");
    }
  }
  return new AppError(
    "PROJECT_GIT_UNAVAILABLE",
    503,
    "Git metadata를 지금 읽을 수 없습니다. 잠시 뒤 다시 시도해 주세요.",
  );
}
