import { spawn } from "node:child_process";
import { lstat, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitHead, GitWorktreeMetadata } from "@naru/contracts";
import { GitHeadSchema } from "@naru/contracts";
import { AppError } from "./errors.js";
import type { ProjectPathPolicy } from "./path-policy.js";

const DEFAULT_GIT_EXECUTABLE = "/usr/bin/git";
const GIT_COMMAND_TIMEOUT_MS = 3_000;
const GIT_COMMAND_MAX_OUTPUT_BYTES = 1024 * 1024;
const GIT_POINTER_MAX_BYTES = 4096;
const GIT_WORKTREE_MAX_COUNT = 256;

export type GitMetadataFailureCode =
  | "command-failed"
  | "command-timeout"
  | "output-too-large"
  | "invalid-output"
  | "outside-root"
  | "permission-denied"
  | "missing";

export class GitMetadataError extends Error {
  readonly code: GitMetadataFailureCode;

  constructor(code: GitMetadataFailureCode, message: string) {
    super(message);
    this.name = "GitMetadataError";
    this.code = code;
  }
}

export interface GitWorktreeInspection extends GitWorktreeMetadata {
  path: string;
  current: boolean;
}

export type RejectedGitWorktreeReason =
  "missing" | "permission-denied" | "outside-root" | "invalid" | "duplicate";

export interface RejectedGitWorktree {
  role: GitWorktreeMetadata["role"];
  reason: RejectedGitWorktreeReason;
  locked: boolean;
  prunable: boolean;
}

export type GitProjectInspection =
  | {
      kind: "non-git";
      registeredPath: string;
    }
  | {
      kind: "bare";
      registeredPath: string;
      commonDirectory: string;
    }
  | {
      kind: "worktree";
      registeredPath: string;
      currentWorktreePath: string;
      gitDirectory: string;
      commonDirectory: string;
      worktrees: readonly GitWorktreeInspection[];
      rejectedWorktrees: readonly RejectedGitWorktree[];
    };

export interface GitCommandRunner {
  run(cwd: string, approvedRoot: string, args: readonly string[]): Promise<Buffer>;
}

export interface RawGitWorktree {
  path: string;
  oid: string | null;
  branch: string | null;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

export class GitMetadataAdapter {
  readonly #pathPolicy: ProjectPathPolicy;
  readonly #runner: GitCommandRunner;

  constructor(
    pathPolicy: ProjectPathPolicy,
    runner: GitCommandRunner = new SystemGitCommandRunner(),
  ) {
    this.#pathPolicy = pathPolicy;
    this.#runner = runner;
  }

  async inspect(input: string): Promise<GitProjectInspection> {
    const registered = await this.#pathPolicy.validate(input);
    const approvedRoot = this.#pathPolicy.approvedRootFor(registered.realPath);
    if (approvedRoot === undefined) {
      throw new GitMetadataError("outside-root", "Git 프로젝트가 허용 루트 밖에 있습니다.");
    }
    await this.#preflightControlDirectory(registered.realPath, approvedRoot);

    let bareOutput: Buffer;
    try {
      bareOutput = await this.#runner.run(registered.realPath, approvedRoot, [
        "rev-parse",
        "--is-bare-repository",
      ]);
    } catch (error) {
      if (error instanceof GitCommandError && error.isNotRepository()) {
        return { kind: "non-git", registeredPath: registered.realPath };
      }
      throw mapCommandError(error);
    }

    const bare = decodeTerminatedOutput(bareOutput, "bare repository state");
    if (bare === "true") {
      const commonDirectory = await this.#readValidatedPath(
        registered.realPath,
        approvedRoot,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git common directory",
      );
      return { kind: "bare", registeredPath: registered.realPath, commonDirectory };
    }
    if (bare !== "false") {
      throw invalidOutput("Git returned an unknown bare repository state.");
    }

    const [currentWorktreePath, gitDirectory, commonDirectory] = await Promise.all([
      this.#readValidatedPath(
        registered.realPath,
        approvedRoot,
        ["rev-parse", "--path-format=absolute", "--show-toplevel"],
        "Git worktree root",
      ),
      this.#readValidatedPath(
        registered.realPath,
        approvedRoot,
        ["rev-parse", "--path-format=absolute", "--git-dir"],
        "Git directory",
      ),
      this.#readValidatedPath(
        registered.realPath,
        approvedRoot,
        ["rev-parse", "--path-format=absolute", "--git-common-dir"],
        "Git common directory",
      ),
    ]);
    const porcelain = await this.#run(registered.realPath, approvedRoot, [
      "worktree",
      "list",
      "--porcelain",
      "-z",
    ]);

    const records = parseGitWorktreePorcelain(porcelain);
    const worktrees: GitWorktreeInspection[] = [];
    const rejectedWorktrees: RejectedGitWorktree[] = [];
    const canonicalPaths = new Set<string>();

    for (const [index, record] of records.entries()) {
      const role = index === 0 ? "primary" : "linked";
      if (record.bare) throw invalidOutput("A non-bare repository listed a bare worktree.");
      const metadata: GitWorktreeMetadata = {
        kind: "worktree",
        role,
        head: headFromRecord(record),
        locked: record.locked,
        prunable: record.prunable,
      };

      try {
        const validated = await this.#pathPolicy.validate(record.path);
        if (canonicalPaths.has(validated.realPath)) {
          rejectedWorktrees.push({
            role,
            reason: "duplicate",
            locked: record.locked,
            prunable: record.prunable,
          });
          continue;
        }
        canonicalPaths.add(validated.realPath);
        worktrees.push({
          ...metadata,
          path: validated.realPath,
          current: validated.realPath === currentWorktreePath,
        });
      } catch (error) {
        rejectedWorktrees.push({
          role,
          reason: rejectedReason(error),
          locked: record.locked,
          prunable: record.prunable,
        });
      }
    }

    if (!worktrees.some((worktree) => worktree.current)) {
      throw invalidOutput("Git did not list the current worktree inside the approved root.");
    }

    return {
      kind: "worktree",
      registeredPath: registered.realPath,
      currentWorktreePath,
      gitDirectory,
      commonDirectory,
      worktrees,
      rejectedWorktrees,
    };
  }

  async resolveProjectPath(worktreeRoot: string, projectRelativePath: string): Promise<string> {
    if (
      isAbsolute(projectRelativePath) ||
      projectRelativePath === ".." ||
      projectRelativePath.startsWith(`..${sep}`)
    ) {
      throw invalidOutput("Git project relative path escapes its worktree.");
    }
    let root: string;
    let target: string;
    try {
      root = (await this.#pathPolicy.validate(worktreeRoot)).realPath;
      target = (await this.#pathPolicy.validate(resolve(worktreeRoot, projectRelativePath)))
        .realPath;
    } catch (error) {
      throw metadataPathError(error, "Git project path");
    }
    const relativeTarget = relative(root, target);
    if (
      isAbsolute(relativeTarget) ||
      relativeTarget === ".." ||
      relativeTarget.startsWith(`..${sep}`)
    ) {
      throw invalidOutput("Git project path escapes its worktree.");
    }
    return target;
  }

  async #readValidatedPath(
    cwd: string,
    approvedRoot: string,
    args: readonly string[],
    label: string,
  ): Promise<string> {
    const output = await this.#run(cwd, approvedRoot, args);
    const path = decodeTerminatedOutput(output, label);
    try {
      return (await this.#pathPolicy.validate(path)).realPath;
    } catch (error) {
      throw metadataPathError(error, label);
    }
  }

  async #preflightControlDirectory(registeredPath: string, approvedRoot: string): Promise<void> {
    let candidate = registeredPath;
    while (candidate !== approvedRoot) {
      const marker = join(candidate, ".git");
      let metadata: Awaited<ReturnType<typeof lstat>>;
      try {
        metadata = await lstat(marker);
      } catch (error) {
        if (hasFileSystemCode(error, "ENOENT")) {
          const parent = dirname(candidate);
          if (parent === candidate) return;
          candidate = parent;
          continue;
        }
        throw fileSystemMetadataError(error, "Git control marker");
      }

      let gitDirectory: string;
      if (metadata.isDirectory()) {
        gitDirectory = await this.#validateMetadataDirectory(marker, "Git directory");
      } else if (metadata.isFile()) {
        const pointer = await readGitPointer(marker, "gitdir: ");
        gitDirectory = await this.#validateMetadataDirectory(
          resolve(candidate, pointer),
          "Git directory",
        );
      } else {
        throw invalidOutput("Git control marker is not a regular file or directory.");
      }

      const commonPointer = join(gitDirectory, "commondir");
      try {
        const commonMetadata = await lstat(commonPointer);
        if (!commonMetadata.isFile()) {
          throw invalidOutput("Git common directory pointer is not a regular file.");
        }
      } catch (error) {
        if (hasFileSystemCode(error, "ENOENT")) return;
        if (error instanceof GitMetadataError) throw error;
        throw fileSystemMetadataError(error, "Git common directory pointer");
      }
      const commonPath = await readGitPointer(commonPointer);
      await this.#validateMetadataDirectory(
        resolve(gitDirectory, commonPath),
        "Git common directory",
      );
      return;
    }
  }

  async #validateMetadataDirectory(path: string, label: string): Promise<string> {
    try {
      return (await this.#pathPolicy.validate(path)).realPath;
    } catch (error) {
      throw metadataPathError(error, label);
    }
  }

  async #run(cwd: string, approvedRoot: string, args: readonly string[]): Promise<Buffer> {
    try {
      return await this.#runner.run(cwd, approvedRoot, args);
    } catch (error) {
      throw mapCommandError(error);
    }
  }
}

export class SystemGitCommandRunner implements GitCommandRunner {
  readonly #executable: string;
  readonly #timeoutMs: number;

  constructor(executable = DEFAULT_GIT_EXECUTABLE, timeoutMs = GIT_COMMAND_TIMEOUT_MS) {
    this.#executable = executable;
    this.#timeoutMs = timeoutMs;
  }

  run(cwd: string, approvedRoot: string, args: readonly string[]): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.#executable, ["--no-pager", ...args], {
        cwd,
        env: gitEnvironment(approvedRoot),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let termination: "timeout" | "output-too-large" | null = null;
      let settled = false;

      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (error) reject(error);
        else resolve(Buffer.concat(stdout));
      };
      const stopFor = (reason: "timeout" | "output-too-large"): void => {
        if (termination !== null) return;
        termination = reason;
        child.kill("SIGKILL");
      };
      const collect = (target: Buffer[], chunk: Buffer, stream: "stdout" | "stderr"): void => {
        if (stream === "stdout") stdoutBytes += chunk.byteLength;
        else stderrBytes += chunk.byteLength;
        if (stdoutBytes + stderrBytes > GIT_COMMAND_MAX_OUTPUT_BYTES) {
          stopFor("output-too-large");
          return;
        }
        target.push(chunk);
      };

      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk, "stdout"));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk, "stderr"));
      const timeout = setTimeout(() => stopFor("timeout"), this.#timeoutMs);
      timeout.unref();
      child.once("error", (error) =>
        finish(new GitCommandError("spawn", null, Buffer.alloc(0), error)),
      );
      child.once("close", (code) => {
        if (termination === "timeout") {
          finish(new GitCommandError("timeout", code, Buffer.concat(stderr)));
          return;
        }
        if (termination === "output-too-large") {
          finish(new GitCommandError("output-too-large", code, Buffer.concat(stderr)));
          return;
        }
        if (code !== 0) {
          finish(new GitCommandError("exit", code, Buffer.concat(stderr)));
          return;
        }
        finish();
      });
    });
  }
}

export function parseGitWorktreePorcelain(output: Buffer): readonly RawGitWorktree[] {
  const fields = splitNullTerminated(output);
  const records: RawGitWorktree[] = [];
  let current: RawGitWorktree | null = null;

  for (const fieldBuffer of fields) {
    if (fieldBuffer.byteLength === 0) {
      if (current !== null) {
        records.push(current);
        if (records.length > GIT_WORKTREE_MAX_COUNT) {
          throw invalidOutput("Git returned too many worktrees.");
        }
        current = null;
      }
      continue;
    }
    const field = decodeUtf8(fieldBuffer, "worktree field");
    if (field.startsWith("worktree ")) {
      if (current !== null) throw invalidOutput("Git worktree records were not separated.");
      const path = field.slice("worktree ".length);
      if (path.length === 0) throw invalidOutput("Git returned an empty worktree path.");
      current = {
        path,
        oid: null,
        branch: null,
        detached: false,
        bare: false,
        locked: false,
        prunable: false,
      };
      continue;
    }
    if (current === null) throw invalidOutput("Git worktree output did not start with a path.");
    if (field.startsWith("HEAD ")) {
      if (current.oid !== null) throw invalidOutput("Git returned duplicate HEAD fields.");
      current.oid = field.slice("HEAD ".length);
    } else if (field.startsWith("branch ")) {
      if (current.branch !== null) throw invalidOutput("Git returned duplicate branch fields.");
      current.branch = field.slice("branch ".length);
    } else if (field === "detached") {
      current.detached = true;
    } else if (field === "bare") {
      current.bare = true;
    } else if (field === "locked" || field.startsWith("locked ")) {
      current.locked = true;
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      current.prunable = true;
    }
  }
  if (current !== null) throw invalidOutput("Git worktree output was not NUL terminated.");
  if (records.length === 0) throw invalidOutput("Git did not return any worktrees.");
  return records;
}

function headFromRecord(record: RawGitWorktree): GitHead {
  if (record.oid === null) throw invalidOutput("Git worktree output omitted HEAD.");
  const branch = record.branch === null ? null : branchName(record.branch);
  if (record.detached && branch !== null) {
    throw invalidOutput("Git marked one worktree as both branch and detached.");
  }
  const zeroOid = /^(?:0{40}|0{64})$/.test(record.oid);
  const candidate: GitHead = zeroOid
    ? { kind: "unborn", name: branch }
    : record.detached
      ? { kind: "detached", oid: record.oid }
      : branch !== null
        ? { kind: "branch", name: branch, oid: record.oid }
        : (() => {
            throw invalidOutput("Git worktree output omitted branch state.");
          })();
  const parsed = GitHeadSchema.safeParse(candidate);
  if (!parsed.success) throw invalidOutput("Git returned an invalid HEAD object ID or branch.");
  return parsed.data;
}

function branchName(reference: string): string {
  const prefix = "refs/heads/";
  if (!reference.startsWith(prefix) || reference.length === prefix.length) {
    throw invalidOutput("Git returned a non-local branch reference.");
  }
  return reference.slice(prefix.length);
}

function gitEnvironment(approvedRoot: string): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_CEILING_DIRECTORIES: approvedRoot,
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function decodeTerminatedOutput(output: Buffer, label: string): string {
  if (output.byteLength === 0 || output.at(-1) !== 0x0a) {
    throw invalidOutput(`Git ${label} output was not newline terminated.`);
  }
  const withoutLineFeed = output.subarray(0, -1);
  const value = decodeUtf8(withoutLineFeed, label);
  if (value.length === 0 || value.includes("\0")) {
    throw invalidOutput(`Git ${label} output was empty or malformed.`);
  }
  return value;
}

function splitNullTerminated(output: Buffer): readonly Buffer[] {
  if (output.byteLength === 0 || output.at(-1) !== 0) {
    throw invalidOutput("Git worktree output was not NUL terminated.");
  }
  const fields: Buffer[] = [];
  let start = 0;
  for (let index = 0; index < output.byteLength; index += 1) {
    if (output[index] !== 0) continue;
    fields.push(output.subarray(start, index));
    start = index + 1;
  }
  return fields;
}

function decodeUtf8(value: Buffer, label: string): string {
  const decoded = value.toString("utf8");
  if (!Buffer.from(decoded, "utf8").equals(value)) {
    throw invalidOutput(`Git ${label} was not valid UTF-8.`);
  }
  return decoded;
}

async function readGitPointer(path: string, prefix = ""): Promise<string> {
  let value: Buffer;
  try {
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.size === 0 || metadata.size > GIT_POINTER_MAX_BYTES) {
      throw invalidOutput("Git pointer file is empty, oversized, or not regular.");
    }
    value = await readFile(path);
  } catch (error) {
    if (error instanceof GitMetadataError) throw error;
    throw fileSystemMetadataError(error, "Git pointer file");
  }
  let decoded = decodeUtf8(value, "pointer file");
  if (decoded.endsWith("\n")) decoded = decoded.slice(0, -1);
  if (decoded.endsWith("\r")) decoded = decoded.slice(0, -1);
  if (decoded.includes("\n") || decoded.includes("\r") || decoded.includes("\0")) {
    throw invalidOutput("Git pointer file contains multiple lines or NUL bytes.");
  }
  if (!decoded.startsWith(prefix) || decoded.length === prefix.length) {
    throw invalidOutput("Git pointer file has an invalid format.");
  }
  return decoded.slice(prefix.length);
}

function fileSystemMetadataError(error: unknown, label: string): GitMetadataError {
  if (hasFileSystemCode(error, "EACCES") || hasFileSystemCode(error, "EPERM")) {
    return new GitMetadataError("permission-denied", `${label} is not readable.`);
  }
  if (hasFileSystemCode(error, "ENOENT")) {
    return new GitMetadataError("missing", `${label} is missing.`);
  }
  return new GitMetadataError("invalid-output", `${label} is invalid.`);
}

function hasFileSystemCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function rejectedReason(error: unknown): RejectedGitWorktreeReason {
  if (error instanceof AppError) {
    if (error.code === "PROJECT_MISSING") return "missing";
    if (error.code === "PROJECT_PERMISSION_DENIED") return "permission-denied";
    if (error.code === "PROJECT_OUTSIDE_ROOT") return "outside-root";
  }
  return "invalid";
}

function metadataPathError(error: unknown, label: string): GitMetadataError {
  if (error instanceof AppError) {
    if (error.code === "PROJECT_OUTSIDE_ROOT") {
      return new GitMetadataError("outside-root", `${label} is outside the approved project root.`);
    }
    if (error.code === "PROJECT_PERMISSION_DENIED") {
      return new GitMetadataError("permission-denied", `${label} is not readable.`);
    }
    if (error.code === "PROJECT_MISSING") {
      return new GitMetadataError("missing", `${label} is missing.`);
    }
  }
  return new GitMetadataError("invalid-output", `${label} is invalid.`);
}

function mapCommandError(error: unknown): GitMetadataError {
  if (error instanceof GitMetadataError) return error;
  if (error instanceof GitCommandError) {
    if (error.reason === "timeout") {
      return new GitMetadataError("command-timeout", "Git metadata inspection timed out.");
    }
    if (error.reason === "output-too-large") {
      return new GitMetadataError("output-too-large", "Git metadata output exceeded its limit.");
    }
  }
  return new GitMetadataError("command-failed", "Git metadata inspection failed.");
}

function invalidOutput(message: string): GitMetadataError {
  return new GitMetadataError("invalid-output", message);
}

export class GitCommandError extends Error {
  readonly reason: "spawn" | "exit" | "timeout" | "output-too-large";
  readonly exitCode: number | null;
  readonly stderr: Buffer;

  constructor(
    reason: GitCommandError["reason"],
    exitCode: number | null,
    stderr: Buffer,
    cause?: unknown,
  ) {
    super("Git command failed.", cause === undefined ? undefined : { cause });
    this.name = "GitCommandError";
    this.reason = reason;
    this.exitCode = exitCode;
    this.stderr = stderr;
  }

  isNotRepository(): boolean {
    if (this.reason !== "exit") return false;
    const message = this.stderr.toString("utf8");
    return message.includes("not a git repository");
  }
}
