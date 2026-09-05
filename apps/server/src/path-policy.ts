import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { AppError } from "./errors.js";

export interface ValidatedProjectPath {
  realPath: string;
  defaultName: string;
}

export class ProjectPathPolicy {
  readonly #roots: readonly string[];

  private constructor(roots: readonly string[]) {
    this.#roots = roots;
  }

  static async create(configuredRoots: readonly string[]): Promise<ProjectPathPolicy> {
    const roots = await Promise.all(
      configuredRoots.map(async (root) => {
        const resolved = await realpath(resolve(root));
        const metadata = await stat(resolved);
        if (!metadata.isDirectory()) throw new Error(`Project root is not a directory: ${root}`);
        return resolved;
      }),
    );
    return new ProjectPathPolicy(roots);
  }

  async validate(input: string): Promise<ValidatedProjectPath> {
    if (!isAbsolute(input)) {
      throw new AppError("PROJECT_INVALID_PATH", 400, "프로젝트 경로는 절대 경로여야 합니다.");
    }

    let candidate: string;
    try {
      candidate = await realpath(input);
      const metadata = await stat(candidate);
      if (!metadata.isDirectory()) {
        throw new AppError("PROJECT_INVALID_PATH", 400, "프로젝트 경로가 디렉터리가 아닙니다.");
      }
      await access(candidate, constants.R_OK | constants.X_OK);
    } catch (error) {
      if (error instanceof AppError) throw error;
      if (isPermissionError(error)) {
        throw new AppError(
          "PROJECT_PERMISSION_DENIED",
          403,
          "프로젝트 경로를 읽을 권한이 없습니다.",
        );
      }
      throw new AppError("PROJECT_MISSING", 404, "프로젝트 경로를 찾거나 읽을 수 없습니다.");
    }

    const withinRoot = this.approvedRootFor(candidate) !== undefined;

    if (!withinRoot) {
      throw new AppError(
        "PROJECT_OUTSIDE_ROOT",
        403,
        "승인된 프로젝트 루트 밖의 경로는 등록할 수 없습니다.",
      );
    }

    return { realPath: candidate, defaultName: basename(candidate) };
  }

  approvedRootFor(candidate: string): string | undefined {
    return this.#roots.find((root) => {
      const segment = relative(root, candidate);
      return (
        segment !== "" &&
        segment !== ".." &&
        !segment.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
        !isAbsolute(segment)
      );
    });
  }
}

function isPermissionError(error: unknown): boolean {
  return (
    error instanceof Error && "code" in error && (error.code === "EACCES" || error.code === "EPERM")
  );
}
