import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, lstat, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import type {
  ProjectDirectoryListing,
  ProjectFileContent,
  ProjectFileEntry,
  SaveProjectFileRequest,
} from "@naru/contracts";
import { AppError } from "./errors.js";

export const MAX_PROJECT_FILE_BYTES = 1024 * 1024;
export const MAX_DIRECTORY_ENTRIES = 512;

const EXCLUDED_DIRECTORY_NAMES = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".vite",
  ".turbo",
  ".pnpm-store",
]);

export class ProjectFileService {
  async list(projectPath: string, inputPath = ""): Promise<ProjectDirectoryListing> {
    const root = await projectRoot(projectPath);
    const path = validateRelativePath(inputPath, true);
    assertNotProtected(path);
    const directory = await existingTarget(root, path);
    if (directory.symlink) {
      throw new AppError("FILE_PROTECTED", 403, "심볼릭 링크 디렉터리는 탐색할 수 없습니다.");
    }
    if (!directory.metadata.isDirectory()) {
      throw new AppError("FILE_MISSING", 404, "요청한 프로젝트 폴더를 찾을 수 없습니다.");
    }
    await requireAccess(directory.realPath, true);

    let entries;
    try {
      entries = await readdir(directory.realPath, { withFileTypes: true });
    } catch (error) {
      throwFileSystemError(error);
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) {
      throw new AppError(
        "FILE_LIMIT_EXCEEDED",
        413,
        "이 폴더의 항목 수가 한 번에 표시할 수 있는 상한을 넘었습니다.",
      );
    }

    const mapped = await Promise.all(
      entries
        .filter((entry) => !entry.name.startsWith(".naru-save-"))
        .map((entry) => this.#entry(root, path, entry.name)),
    );
    mapped.sort((left, right) => {
      if (left.kind === "directory" && right.kind !== "directory") return -1;
      if (left.kind !== "directory" && right.kind === "directory") return 1;
      return left.name.localeCompare(right.name, "en");
    });
    return { path, entries: mapped };
  }

  async read(
    projectPath: string,
    inputPath: string,
    allowSensitive = false,
  ): Promise<ProjectFileContent> {
    const root = await projectRoot(projectPath);
    const path = validateRelativePath(inputPath);
    assertNotProtected(path);
    if (isSensitivePath(path) && !allowSensitive) sensitiveConfirmationRequired();
    const target = await existingTarget(root, path);
    if (target.symlink) {
      throw new AppError("FILE_PROTECTED", 403, "심볼릭 링크 파일은 이 단계에서 열 수 없습니다.");
    }
    const bytes = await readRegularBytes(target.realPath);
    return content(path, bytes, target.metadata);
  }

  async readForRevision(
    projectPath: string,
    inputPath: string,
    expectedRevision: string | null,
    allowSensitive = false,
  ): Promise<ProjectFileContent | null> {
    const root = await projectRoot(projectPath);
    const path = validateRelativePath(inputPath);
    assertNotProtected(path);
    if (isSensitivePath(path) && !allowSensitive) sensitiveConfirmationRequired();
    const target = await optionalTarget(root, path);
    if (expectedRevision === null) {
      if (target !== null) conflict();
      return null;
    }
    if (target === null || target.symlink) conflict();
    const bytes = await readRegularBytes(target.realPath);
    const current = content(path, bytes, target.metadata);
    if (current.revision !== expectedRevision) conflict();
    return current;
  }

  async save(projectPath: string, input: SaveProjectFileRequest): Promise<ProjectFileContent> {
    const root = await projectRoot(projectPath);
    const path = validateRelativePath(input.path);
    assertNotProtected(path);
    if (isSensitivePath(path) && !input.allowSensitive) sensitiveConfirmationRequired();
    const bytes = Buffer.from(input.source, "utf8");
    if (bytes.byteLength > MAX_PROJECT_FILE_BYTES) tooLarge();
    assertText(bytes);

    const parentPath = dirname(path) === "." ? "" : dirname(path).split(sep).join("/");
    const parent = await existingTarget(root, parentPath);
    if (parent.symlink || !parent.metadata.isDirectory()) {
      throw new AppError(
        "FILE_OUTSIDE_ROOT",
        403,
        "안전하게 확인된 프로젝트 폴더에만 저장할 수 있습니다.",
      );
    }
    await requireAccess(parent.realPath, true, true);
    const targetPath = join(parent.realPath, basename(path));
    const current = await optionalTargetAtCanonicalParent(root, targetPath);

    if (current === null) {
      if (input.expectedRevision !== null) conflict();
      await createExclusiveFile(targetPath, bytes);
    } else {
      if (input.expectedRevision === null || current.symlink) conflict();
      const currentBytes = await readRegularBytes(current.realPath);
      if (revision(currentBytes) !== input.expectedRevision) conflict();
      await replaceAtomically(
        root,
        targetPath,
        bytes,
        input.expectedRevision,
        current.metadata.mode,
      );
    }

    return this.read(projectPath, path, input.allowSensitive);
  }

  async #entry(root: string, parentPath: string, name: string): Promise<ProjectFileEntry> {
    const path = parentPath === "" ? name : `${parentPath}/${name}`;
    const targetPath = join(root, ...path.split("/"));
    let metadata: Stats;
    try {
      metadata = await lstat(targetPath);
    } catch (error) {
      throwFileSystemError(error);
    }

    if (metadata.isSymbolicLink()) {
      return {
        path,
        name,
        kind: "symlink",
        sizeBytes: null,
        modifiedAt: metadata.mtime.toISOString(),
        sensitive: isSensitivePath(path),
        protected: isProtectedPath(path),
        excluded: false,
        symlinkStatus: await symlinkStatus(root, targetPath),
      };
    }
    const kind = metadata.isDirectory() ? "directory" : "file";
    return {
      path,
      name,
      kind,
      sizeBytes: metadata.isFile() ? metadata.size : null,
      modifiedAt: metadata.mtime.toISOString(),
      sensitive: isSensitivePath(path),
      protected: isProtectedPath(path),
      excluded: kind === "directory" && EXCLUDED_DIRECTORY_NAMES.has(name),
      symlinkStatus: null,
    };
  }
}

async function projectRoot(projectPath: string): Promise<string> {
  try {
    const root = await realpath(projectPath);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throwFileSystemError(error);
  }
}

interface ExistingTarget {
  readonly realPath: string;
  readonly metadata: Stats;
  readonly symlink: boolean;
}

async function existingTarget(root: string, path: string): Promise<ExistingTarget> {
  const candidate = path === "" ? root : join(root, ...path.split("/"));
  const target = await optionalTargetAtCanonicalParent(root, candidate);
  if (target === null) {
    throw new AppError("FILE_MISSING", 404, "프로젝트 파일이나 폴더를 찾을 수 없습니다.");
  }
  return target;
}

async function optionalTarget(root: string, path: string): Promise<ExistingTarget | null> {
  const candidate = join(root, ...path.split("/"));
  return optionalTargetAtCanonicalParent(root, candidate);
}

async function optionalTargetAtCanonicalParent(
  root: string,
  candidate: string,
): Promise<ExistingTarget | null> {
  let metadata: Stats;
  try {
    metadata = await lstat(candidate);
  } catch (error) {
    if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) return null;
    throwFileSystemError(error);
  }
  const symlink = metadata.isSymbolicLink();
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch (error) {
    if (symlink && (hasCode(error, "ENOENT") || hasCode(error, "ELOOP"))) {
      throw new AppError("FILE_OUTSIDE_ROOT", 403, "깨진 심볼릭 링크는 열 수 없습니다.");
    }
    throwFileSystemError(error);
  }
  assertWithin(root, resolved, pathEquals(candidate, root));
  return { realPath: resolved, metadata, symlink };
}

function validateRelativePath(input: string, allowRoot = false): string {
  if (
    input.length > 2048 ||
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input) ||
    (!allowRoot && input.length === 0)
  ) {
    invalidPath();
  }
  if (input === "") return "";
  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    invalidPath();
  }
  return segments.join("/");
}

function assertWithin(root: string, candidate: string, allowSame = false): void {
  const segment = relative(root, candidate);
  if (
    (allowSame && segment === "") ||
    (segment !== "" && segment !== ".." && !segment.startsWith(`..${sep}`) && !isAbsolute(segment))
  ) {
    return;
  }
  throw new AppError("FILE_OUTSIDE_ROOT", 403, "프로젝트 경계를 벗어나는 파일은 열 수 없습니다.");
}

async function readRegularBytes(path: string): Promise<Buffer> {
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | noFollowFlag());
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new AppError("FILE_MISSING", 404, "regular file만 열 수 있습니다.");
    }
    if (metadata.size > MAX_PROJECT_FILE_BYTES) tooLarge();
    const bytes = await handle.readFile();
    assertText(bytes);
    return bytes;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throwFileSystemError(error);
    throw error;
  } finally {
    await handle?.close();
  }
}

function content(path: string, bytes: Buffer, metadata: Stats): ProjectFileContent {
  return {
    path,
    source: decodeText(bytes),
    revision: revision(bytes),
    sizeBytes: bytes.byteLength,
    modifiedAt: metadata.mtime.toISOString(),
    sensitive: isSensitivePath(path),
  };
}

async function createExclusiveFile(targetPath: string, bytes: Buffer): Promise<void> {
  let handle;
  let created = false;
  let complete = false;
  try {
    handle = await open(
      targetPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    created = true;
    await handle.writeFile(bytes);
    await handle.sync();
    complete = true;
  } catch (error) {
    if (hasCode(error, "EEXIST")) conflict();
    throwFileSystemError(error);
  } finally {
    await handle?.close();
    if (created && !complete) await unlink(targetPath).catch(() => undefined);
  }
}

async function replaceAtomically(
  root: string,
  targetPath: string,
  bytes: Buffer,
  expectedRevision: string,
  mode: number,
): Promise<void> {
  const temporaryPath = join(dirname(targetPath), `.naru-save-${randomUUID()}.tmp`);
  let handle;
  let published = false;
  try {
    handle = await open(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    await handle.writeFile(bytes);
    await handle.chmod(mode & 0o777);
    await handle.sync();
    await handle.close();
    handle = undefined;

    const latest = await optionalTargetAtCanonicalParent(root, targetPath);
    if (latest === null || latest.symlink) conflict();
    const latestBytes = await readRegularBytes(latest.realPath);
    if (revision(latestBytes) !== expectedRevision) conflict();
    await rename(temporaryPath, targetPath);
    published = true;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throwFileSystemError(error);
  } finally {
    await handle?.close();
    if (!published) await unlink(temporaryPath).catch(() => undefined);
  }
}

async function requireAccess(path: string, directory: boolean, write = false): Promise<void> {
  try {
    let mode = constants.R_OK;
    if (directory) mode |= constants.X_OK;
    if (write) mode |= constants.W_OK;
    await access(path, mode);
  } catch (error) {
    throwFileSystemError(error);
  }
}

function assertText(bytes: Uint8Array): void {
  if (bytes.includes(0)) binary();
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    binary();
  }
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return binary();
  }
}

function revision(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isProtectedPath(path: string): boolean {
  return path.split("/").some((segment) => segment === ".git" || segment.startsWith(".naru-save-"));
}

function assertNotProtected(path: string): void {
  if (isProtectedPath(path)) {
    throw new AppError("FILE_PROTECTED", 403, "Git 내부 파일과 Naru 임시 파일은 열 수 없습니다.");
  }
}

export function isSensitivePath(path: string): boolean {
  const name = basename(path).toLowerCase();
  return (
    name === ".env" ||
    name.startsWith(".env.") ||
    name === ".npmrc" ||
    name === ".pypirc" ||
    name === "credentials" ||
    name === "credentials.json" ||
    name === "secrets.json" ||
    /\.(?:pem|key|p12|pfx|mobileprovision)$/i.test(name)
  );
}

async function symlinkStatus(
  root: string,
  targetPath: string,
): Promise<"inside" | "outside" | "broken"> {
  try {
    const resolved = await realpath(targetPath);
    const segment = relative(root, resolved);
    return segment !== "" &&
      segment !== ".." &&
      !segment.startsWith(`..${sep}`) &&
      !isAbsolute(segment)
      ? "inside"
      : "outside";
  } catch {
    return "broken";
  }
}

function noFollowFlag(): number {
  return "O_NOFOLLOW" in constants ? constants.O_NOFOLLOW : 0;
}

function pathEquals(left: string, right: string): boolean {
  return left === right;
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function invalidPath(): never {
  throw new AppError("REQUEST_INVALID", 400, "프로젝트 상대 경로 형식이 올바르지 않습니다.");
}

function sensitiveConfirmationRequired(): never {
  throw new AppError(
    "FILE_SENSITIVE_CONFIRMATION_REQUIRED",
    409,
    "이 파일은 민감한 내용을 포함할 수 있어 명시적으로 확인한 뒤 열어야 합니다.",
  );
}

function conflict(): never {
  throw new AppError(
    "FILE_CONFLICT",
    409,
    "파일이 열린 뒤 디스크에서 변경되었습니다. 내 초안을 보존한 채 충돌을 해결해 주세요.",
  );
}

function tooLarge(): never {
  throw new AppError("FILE_TOO_LARGE", 413, "파일이 1 MiB 편집 상한을 넘었습니다.");
}

function binary(): never {
  throw new AppError(
    "FILE_BINARY",
    415,
    "binary 또는 유효하지 않은 UTF-8 파일은 편집할 수 없습니다.",
  );
}

function throwFileSystemError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (hasCode(error, "EACCES") || hasCode(error, "EPERM")) {
    throw new AppError("FILE_PERMISSION_DENIED", 403, "파일이나 폴더를 읽거나 쓸 권한이 없습니다.");
  }
  if (hasCode(error, "ENOENT") || hasCode(error, "ENOTDIR")) {
    throw new AppError("FILE_MISSING", 404, "프로젝트 파일이나 폴더를 찾을 수 없습니다.");
  }
  if (hasCode(error, "ELOOP")) {
    throw new AppError("FILE_OUTSIDE_ROOT", 403, "심볼릭 링크를 안전하게 확인할 수 없습니다.");
  }
  throw error;
}
