import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_DOCUMENT_BYTES,
  ProjectDocumentReader,
  parseMarkdownStructure,
  parseTasks,
} from "../src/project-documents.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("ProjectDocumentReader", () => {
  it("indexes nested Markdown and discovers root and docs task files", async () => {
    const project = await temporaryProject();
    await mkdir(join(project, "docs", "guides"), { recursive: true });
    await writeFile(
      join(project, "docs", "README.md"),
      "# Product docs\n\nA short **summary** for the reader.\n\n## Setup\n\nDetails.\n",
    );
    await writeFile(
      join(project, "docs", "guides", "TASKS.md"),
      "# Guide work\n\n## T01. Ship guide\n\n- [ ] **범위**: Write it.\n",
    );
    await writeFile(
      join(project, "TASKS.md"),
      "# Root work\n\n## T99. Root task\n\n- [-] **범위**: Track it.\n",
    );

    const reader = new ProjectDocumentReader();
    const docs = await reader.docsCatalog(project);
    expect(docs).toMatchObject({
      status: "ready",
      documents: [
        {
          path: "docs/guides/TASKS.md",
          title: "Guide work",
          kind: "tasks",
        },
        {
          path: "docs/README.md",
          title: "Product docs",
          kind: "markdown",
          summary: "A short summary for the reader.",
        },
      ],
    });
    expect(docs.documents[1]?.headings).toContainEqual({ depth: 2, text: "Setup", line: 5 });
    await expect(reader.taskCandidates(project)).resolves.toMatchObject({
      status: "ready",
      documents: [
        { path: "TASKS.md", kind: "tasks" },
        { path: "docs/guides/TASKS.md", kind: "tasks" },
      ],
    });

    const content = await reader.read(project, "docs/README.md");
    expect(content).toMatchObject({
      path: "docs/README.md",
      title: "Product docs",
      kind: "markdown",
      tooLarge: false,
      tasks: null,
      warnings: [],
    });
    expect(content.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(content.source).toContain("## Setup");
  });

  it("returns explicit missing and empty catalog states", async () => {
    const project = await temporaryProject();
    const reader = new ProjectDocumentReader();

    await expect(reader.docsCatalog(project)).resolves.toEqual({
      status: "missing",
      documents: [],
    });
    await expect(reader.taskCandidates(project)).resolves.toEqual({
      status: "missing",
      documents: [],
    });

    await mkdir(join(project, "docs"));
    await expect(reader.docsCatalog(project)).resolves.toEqual({ status: "empty", documents: [] });
  });

  it("rejects traversal, unsupported files, oversized content, and symlink escapes", async () => {
    const project = await temporaryProject();
    const outside = await temporaryProject();
    await mkdir(join(project, "docs"));
    await writeFile(join(project, "docs", "oversized.md"), Buffer.alloc(MAX_DOCUMENT_BYTES + 1));
    await writeFile(join(project, "docs", "plain.txt"), "not Markdown");
    await writeFile(join(outside, "secret.md"), "# Outside\n");
    await symlink(join(outside, "secret.md"), join(project, "docs", "outside.md"));
    const reader = new ProjectDocumentReader();

    await expect(reader.read(project, "../secret.md")).rejects.toMatchObject({
      code: "REQUEST_INVALID",
      statusCode: 400,
    });
    await expect(reader.read(project, "docs/plain.txt")).rejects.toMatchObject({
      code: "DOCS_UNSUPPORTED_TYPE",
      statusCode: 415,
    });
    await expect(reader.read(project, "docs/oversized.md")).rejects.toMatchObject({
      code: "DOCS_FILE_TOO_LARGE",
      statusCode: 413,
    });
    await expect(reader.read(project, "docs/outside.md")).rejects.toMatchObject({
      code: "DOCS_OUTSIDE_ROOT",
      statusCode: 403,
    });
    await expect(reader.docsCatalog(project)).rejects.toMatchObject({
      code: "DOCS_OUTSIDE_ROOT",
      statusCode: 403,
    });
  });
});

describe("Markdown document parsing", () => {
  it("ignores fenced headings and reports an unclosed fence", () => {
    const parsed = parseMarkdownStructure(
      "# Visible\n\nSummary paragraph.\n\n```md\n# Hidden\n",
      "docs/example.md",
    );
    expect(parsed).toMatchObject({
      title: "Visible",
      summary: "Summary paragraph.",
      headings: [{ depth: 1, text: "Visible", line: 1 }],
      warnings: ["MARKDOWN_UNCLOSED_FENCE"],
    });
  });

  it("classifies task state and extracts compact structured fields", () => {
    const overview = parseTasks(`# Work

## T01. Finished

- [x] **범위**: Done scope.
- **선행 조건**: None
- **검증 기록**:
  - Passed tests.

## T02. Active

- [-] **범위**: Current scope.
- **산출물**: A pane.
- **완료 조건**:
  - Keyboard works.
  - Mobile works.

## T03. Next

- [ ] **범위**: Backlog scope.

## T04. Deferred

- [~] **범위**: Paused scope.

## T05. Chosen next

- [>] **범위**: Next scope.

## MVP 이후 작업

## T06. Later

- [ ] **범위**: Future scope.
`);

    expect(overview.inProgress).toEqual([
      expect.objectContaining({ id: "T02", title: "Active", status: "in_progress" }),
    ]);
    expect(overview.nextTask).toMatchObject({ id: "T05", title: "Chosen next", next: true });
    expect(overview.pending.map((task) => task.id)).toEqual(["T03", "T05", "T06"]);
    expect(overview.deferred).toEqual([
      expect.objectContaining({
        id: "T04",
        status: "deferred",
        next: false,
        scope: "Paused scope.",
      }),
    ]);
    expect(overview.completed[0]).toMatchObject({
      id: "T01",
      scope: "Done scope.",
      prerequisites: "None",
      records: ["Passed tests."],
    });
    expect(overview.inProgress[0]).toMatchObject({
      deliverables: "A pane.",
      completionCriteria: ["Keyboard works.", "Mobile works."],
    });
    expect(overview.postMvp).toEqual([
      expect.objectContaining({ id: "T06", postMvp: true, status: "pending" }),
    ]);
  });

  it("does not infer a next task when no explicit next marker exists", () => {
    const overview = parseTasks(`# Work

## T01. Deferred

- [~] **범위**: Wait for a date.

## T02. First pending

- [ ] **범위**: First candidate.

## T03. Second pending

- [ ] **범위**: Second candidate.
`);

    expect(overview.inProgress).toEqual([]);
    expect(overview.deferred.map((task) => task.id)).toEqual(["T01"]);
    expect(overview.nextTask).toBeNull();
    expect(overview.pending.map((task) => task.id)).toEqual(["T02", "T03"]);
  });
});

async function temporaryProject(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "naru-documents-test-"));
  temporaryDirectories.push(directory);
  return directory;
}
