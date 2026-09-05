import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { access, open, readdir, realpath, stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, relative, sep } from "node:path";
import type {
  DocumentCatalog,
  DocumentContent,
  DocumentEntry,
  DocumentHeading,
  TaskItem,
  TasksOverview,
} from "@naru/contracts";
import { AppError } from "./errors.js";

export const MAX_DOCUMENT_BYTES = 1024 * 1024;
export const MAX_DOCUMENT_INDEX_BYTES = 64 * 1024;
export const MAX_DOCUMENTS = 256;
export const MAX_DOCUMENT_DEPTH = 8;
const MAX_HEADINGS = 256;

type DocumentWarning = DocumentContent["warnings"][number];

interface MarkdownStructure {
  readonly title: string;
  readonly summary: string;
  readonly headings: DocumentHeading[];
  readonly warnings: DocumentWarning[];
}

interface ResolvedDocument {
  readonly path: string;
  readonly realPath: string;
}

export class ProjectDocumentReader {
  async docsCatalog(projectPath: string): Promise<DocumentCatalog> {
    const projectRoot = await resolveProjectRoot(projectPath);
    const docsRoot = await resolveDocsRoot(projectRoot);
    if (docsRoot === null) return { status: "missing", documents: [] };

    const documents: DocumentEntry[] = [];
    const visitedDirectories = new Set<string>([docsRoot]);
    await this.#scanDirectory(
      projectRoot,
      docsRoot,
      docsRoot,
      "docs",
      0,
      visitedDirectories,
      documents,
    );
    documents.sort((left, right) => left.path.localeCompare(right.path, "en"));
    return { status: documents.length === 0 ? "empty" : "ready", documents };
  }

  async taskCandidates(projectPath: string): Promise<DocumentCatalog> {
    const projectRoot = await resolveProjectRoot(projectPath);
    const docsCatalog = await this.docsCatalog(projectRoot);
    const documents = docsCatalog.documents.filter((document) => isTasksPath(document.path));
    const rootTask = await this.#optionalRootTask(projectRoot);
    if (rootTask !== null) documents.unshift(rootTask);
    return { status: documents.length === 0 ? "missing" : "ready", documents };
  }

  async read(projectPath: string, documentPath: string): Promise<DocumentContent> {
    const projectRoot = await resolveProjectRoot(projectPath);
    const resolved = await resolveDocument(projectRoot, documentPath);
    const metadata = await documentMetadata(resolved.realPath);
    if (metadata.size > MAX_DOCUMENT_BYTES) {
      throw new AppError(
        "DOCS_FILE_TOO_LARGE",
        413,
        "이 문서는 안전하게 표시할 수 있는 크기 상한을 넘었습니다.",
      );
    }

    let source: string;
    try {
      source = await readUtf8(resolved.realPath, metadata.size);
    } catch (error) {
      throwDocumentFsError(error);
    }
    const structure = parseMarkdownStructure(source, resolved.path);
    const tasks = isTasksPath(resolved.path) ? parseTasks(source) : null;
    const warnings = [...structure.warnings];
    if (
      isTasksPath(resolved.path) &&
      tasks?.inProgress.length === 0 &&
      tasks?.pending.length === 0 &&
      tasks?.deferred.length === 0 &&
      tasks?.completed.length === 0
    ) {
      warnings.push("TASKS_NOT_RECOGNIZED");
    }
    return {
      path: resolved.path,
      title: structure.title,
      kind: isTasksPath(resolved.path) ? "tasks" : "markdown",
      modifiedAt: metadata.mtime.toISOString(),
      sizeBytes: metadata.size,
      tooLarge: false,
      summary: structure.summary,
      headings: structure.headings,
      revision: createHash("sha256").update(source).digest("hex"),
      source,
      warnings,
      tasks,
    };
  }

  async #scanDirectory(
    projectRoot: string,
    docsRoot: string,
    currentDirectory: string,
    displayDirectory: string,
    depth: number,
    visitedDirectories: Set<string>,
    documents: DocumentEntry[],
  ): Promise<void> {
    let entries;
    try {
      entries = await readdir(currentDirectory, { withFileTypes: true });
    } catch (error) {
      throwDocumentFsError(error);
    }
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));

    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const displayPath = `${displayDirectory}/${entry.name}`;
      let target: string;
      try {
        target = await realpath(join(currentDirectory, entry.name));
      } catch (error) {
        throwDocumentFsError(error);
      }
      assertWithin(projectRoot, target);
      assertWithin(docsRoot, target, true);

      let metadata;
      try {
        metadata = await stat(target);
      } catch (error) {
        throwDocumentFsError(error);
      }
      if (metadata.isDirectory()) {
        if (visitedDirectories.has(target)) continue;
        if (depth >= MAX_DOCUMENT_DEPTH) {
          throw new AppError(
            "DOCS_LIMIT_EXCEEDED",
            413,
            "문서 폴더의 중첩 깊이가 탐색 상한을 넘었습니다.",
          );
        }
        await requireReadable(target, true);
        visitedDirectories.add(target);
        await this.#scanDirectory(
          projectRoot,
          docsRoot,
          target,
          displayPath,
          depth + 1,
          visitedDirectories,
          documents,
        );
        continue;
      }
      if (!metadata.isFile() || extname(entry.name).toLowerCase() !== ".md") continue;
      if (documents.length >= MAX_DOCUMENTS) {
        throw new AppError("DOCS_LIMIT_EXCEEDED", 413, "문서 파일 수가 탐색 상한을 넘었습니다.");
      }
      await requireReadable(target, false);
      documents.push(await documentEntry(displayPath, target, metadata));
    }
  }

  async #optionalRootTask(projectRoot: string): Promise<DocumentEntry | null> {
    const candidate = join(projectRoot, "TASKS.md");
    let target: string;
    try {
      target = await realpath(candidate);
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return null;
      throwDocumentFsError(error);
    }
    assertWithin(projectRoot, target);
    const metadata = await documentMetadata(target);
    if (!metadata.isFile()) return null;
    await requireReadable(target, false);
    return documentEntry("TASKS.md", target, metadata);
  }
}

async function resolveProjectRoot(projectPath: string): Promise<string> {
  try {
    const root = await realpath(projectPath);
    const metadata = await stat(root);
    if (!metadata.isDirectory()) throw new Error("not a directory");
    return root;
  } catch (error) {
    throwDocumentFsError(error);
  }
}

async function resolveDocsRoot(projectRoot: string): Promise<string | null> {
  let docsRoot: string;
  try {
    docsRoot = await realpath(join(projectRoot, "docs"));
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return null;
    throwDocumentFsError(error);
  }
  assertWithin(projectRoot, docsRoot);
  const metadata = await documentMetadata(docsRoot);
  if (!metadata.isDirectory()) return null;
  await requireReadable(docsRoot, true);
  return docsRoot;
}

async function resolveDocument(projectRoot: string, input: string): Promise<ResolvedDocument> {
  const path = validateDocumentPath(input);
  const docsDocument = path.startsWith("docs/");
  if (!docsDocument && path !== "TASKS.md") {
    throw new AppError("DOCS_OUTSIDE_ROOT", 403, "프로젝트의 문서 범위 밖 파일은 열 수 없습니다.");
  }

  let target: string;
  try {
    target = await realpath(join(projectRoot, ...path.split("/")));
  } catch (error) {
    throwDocumentFsError(error);
  }
  assertWithin(projectRoot, target);
  if (docsDocument) {
    const docsRoot = await resolveDocsRoot(projectRoot);
    if (docsRoot === null) {
      throw new AppError("DOCS_FILE_MISSING", 404, "문서 폴더를 찾을 수 없습니다.");
    }
    assertWithin(docsRoot, target, true);
  }
  const metadata = await documentMetadata(target);
  if (!metadata.isFile()) {
    throw new AppError("DOCS_FILE_MISSING", 404, "문서 파일을 찾을 수 없습니다.");
  }
  await requireReadable(target, false);
  return { path, realPath: target };
}

function validateDocumentPath(input: string): string {
  if (
    input.length === 0 ||
    input.length > 2048 ||
    input.includes("\0") ||
    input.includes("\\") ||
    isAbsolute(input)
  ) {
    throw new AppError("REQUEST_INVALID", 400, "문서 경로 형식이 올바르지 않습니다.");
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new AppError("REQUEST_INVALID", 400, "문서 경로 형식이 올바르지 않습니다.");
  }
  if (extname(input).toLowerCase() !== ".md") {
    throw new AppError("DOCS_UNSUPPORTED_TYPE", 415, "Markdown 문서만 열 수 있습니다.");
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
  throw new AppError(
    "DOCS_OUTSIDE_ROOT",
    403,
    "프로젝트 문서 경계를 벗어나는 경로는 열 수 없습니다.",
  );
}

async function documentMetadata(path: string): Promise<Stats> {
  try {
    return await stat(path);
  } catch (error) {
    throwDocumentFsError(error);
  }
}

async function requireReadable(path: string, directory: boolean): Promise<void> {
  try {
    await access(path, directory ? constants.R_OK | constants.X_OK : constants.R_OK);
  } catch (error) {
    throwDocumentFsError(error);
  }
}

async function documentEntry(
  path: string,
  realPath: string,
  metadata: Stats,
): Promise<DocumentEntry> {
  const tooLarge = metadata.size > MAX_DOCUMENT_BYTES;
  const prefix = tooLarge
    ? ""
    : await readUtf8(realPath, Math.min(metadata.size, MAX_DOCUMENT_INDEX_BYTES));
  const structure = parseMarkdownStructure(prefix, path);
  return {
    path,
    title: structure.title,
    kind: isTasksPath(path) ? "tasks" : "markdown",
    modifiedAt: metadata.mtime.toISOString(),
    sizeBytes: metadata.size,
    tooLarge,
    summary: structure.summary,
    headings: structure.headings,
  };
}

async function readUtf8(path: string, byteLength: number): Promise<string> {
  if (byteLength === 0) return "";
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.allocUnsafe(byteLength);
    const { bytesRead } = await handle.read(buffer, 0, byteLength, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

export function parseMarkdownStructure(source: string, path = "document.md"): MarkdownStructure {
  const lines = source.split(/\r?\n/);
  const headings: DocumentHeading[] = [];
  const summaryLines: string[] = [];
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let collectingSummary = false;
  let summaryDone = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as "`" | "~";
      if (fence === null) fence = { marker, length: fenceMatch[1].length };
      else if (fence.marker === marker && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence !== null) continue;

    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (headingMatch?.[1] && headingMatch[2]) {
      if (headings.length < MAX_HEADINGS) {
        headings.push({
          depth: headingMatch[1].length,
          text: stripInlineMarkdown(headingMatch[2]).slice(0, 500),
          line: index + 1,
        });
      }
      if (collectingSummary) summaryDone = true;
      continue;
    }
    if (summaryDone) continue;
    const trimmed = line.trim();
    if (trimmed === "") {
      if (collectingSummary) summaryDone = true;
      continue;
    }
    if (!collectingSummary && isStructuralMarkdownLine(trimmed)) continue;
    collectingSummary = true;
    summaryLines.push(stripInlineMarkdown(trimmed));
  }

  const fallbackTitle = basename(path, extname(path)).replaceAll(/[-_]+/g, " ");
  return {
    title: headings.find((heading) => heading.depth === 1)?.text || fallbackTitle || "문서",
    summary: summaryLines.join(" ").replaceAll(/\s+/g, " ").trim().slice(0, 500),
    headings,
    warnings: fence === null ? [] : ["MARKDOWN_UNCLOSED_FENCE"],
  };
}

export function parseTasks(source: string): TasksOverview {
  const lines = source.split(/\r?\n/);
  const tasks: TaskItem[] = [];
  let postMvp = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const secondLevelHeading = line.match(/^##\s+(.+?)\s*#*\s*$/);
    if (!secondLevelHeading?.[1]) continue;
    const headingText = stripInlineMarkdown(secondLevelHeading[1]);
    if (/MVP\s*이후|post[- ]?MVP/i.test(headingText)) {
      postMvp = true;
      continue;
    }
    const taskHeading = headingText.match(/^(T\d+)[.:]?\s+(.+)$/i);
    if (!taskHeading?.[1] || !taskHeading[2]) continue;
    let end = index + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end] ?? "")) end += 1;
    const section = lines.slice(index + 1, end);
    const state = taskState(section);
    tasks.push({
      id: taskHeading[1].toUpperCase(),
      title: taskHeading[2].trim().slice(0, 500),
      status: state.status,
      next: state.next,
      scope: fieldValue(section, ["범위", "scope"]),
      prerequisites: fieldValue(section, ["선행 조건", "prerequisites"]),
      deliverables: fieldValue(section, ["산출물", "deliverables"]),
      completionCriteria: fieldList(section, ["완료 조건", "completion criteria"]),
      records: fieldList(section, ["검증 기록", "진행 기록", "verification", "progress"]),
      postMvp,
      line: index + 1,
    });
    index = end - 1;
  }

  const pending = tasks.filter((task) => task.status === "pending");
  const inProgress = tasks.filter((task) => task.status === "in_progress");
  const deferred = tasks.filter((task) => task.status === "deferred");
  const completed = tasks.filter((task) => task.status === "completed");
  return {
    inProgress,
    nextTask: pending.find((task) => task.next) ?? null,
    pending,
    deferred,
    completed,
    postMvp: tasks.filter(
      (task) => task.postMvp && task.status !== "completed" && task.status !== "deferred",
    ),
  };
}

function taskState(section: readonly string[]): Pick<TaskItem, "status" | "next"> {
  for (const line of section) {
    const match = line.match(/^\s*-\s*\[([ xX>~-])\]/);
    if (!match?.[1]) continue;
    if (match[1].toLowerCase() === "x") return { status: "completed", next: false };
    if (match[1] === "-") return { status: "in_progress", next: false };
    if (match[1] === "~") return { status: "deferred", next: false };
    return { status: "pending", next: match[1] === ">" };
  }
  return { status: "pending", next: false };
}

function fieldValue(section: readonly string[], labels: readonly string[]): string {
  for (const line of section) {
    const field = boldField(line);
    if (field && labels.some((label) => field.label.toLowerCase() === label.toLowerCase())) {
      return stripInlineMarkdown(field.value).slice(0, 4000);
    }
  }
  return "";
}

function fieldList(section: readonly string[], labels: readonly string[]): string[] {
  const output: string[] = [];
  let collecting = false;
  for (const line of section) {
    const field = boldField(line);
    if (field) {
      collecting = labels.some((label) =>
        field.label.toLowerCase().startsWith(label.toLowerCase()),
      );
      if (collecting && field.value.trim())
        output.push(stripInlineMarkdown(field.value).slice(0, 4000));
      continue;
    }
    if (!collecting) continue;
    const bullet = line.match(/^\s{2,}[-*]\s+(.+)$/);
    if (bullet?.[1] && output.length < 100) {
      output.push(stripInlineMarkdown(bullet[1]).slice(0, 4000));
    } else if (line.trim() !== "" && !/^\s+/.test(line)) {
      collecting = false;
    }
  }
  return output;
}

function boldField(line: string): { label: string; value: string } | null {
  const match = line.match(/^\s*-\s*(?:\[[ xX>~-]\]\s*)?\*\*(.+?)\*\*:\s*(.*)$/);
  return match?.[1] !== undefined && match[2] !== undefined
    ? { label: match[1].trim(), value: match[2].trim() }
    : null;
}

function stripInlineMarkdown(value: string): string {
  return value
    .replaceAll(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replaceAll(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replaceAll(/[`*_~]/g, "")
    .replaceAll(/<[^>]*>/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();
}

function isStructuralMarkdownLine(value: string): boolean {
  return /^(?:---|\*\*\*|___|>|[-*+]\s|\d+[.)]\s|\|)/.test(value);
}

function isTasksPath(path: string): boolean {
  return basename(path).toLowerCase() === "tasks.md";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function throwDocumentFsError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM")) {
    throw new AppError("DOCS_PERMISSION_DENIED", 403, "문서 파일이나 폴더를 읽을 권한이 없습니다.");
  }
  if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "ENOTDIR")) {
    throw new AppError("DOCS_FILE_MISSING", 404, "문서 파일을 찾을 수 없습니다.");
  }
  if (hasErrorCode(error, "ELOOP")) {
    throw new AppError("DOCS_OUTSIDE_ROOT", 403, "문서 심볼릭 링크를 안전하게 확인할 수 없습니다.");
  }
  throw error;
}
