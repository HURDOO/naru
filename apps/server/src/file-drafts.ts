import type { FileAssistantMerge, FileDraft, ProjectFileContent } from "@naru/contracts";
import { AppError } from "./errors.js";
import { MAX_PROJECT_FILE_BYTES } from "./project-files.js";

export const MAX_FILE_DRAFTS = 64;
export const MAX_FILE_DRAFT_BYTES = MAX_PROJECT_FILE_BYTES;
export const MAX_TOTAL_FILE_DRAFT_BYTES = 16 * 1024 * 1024;

interface DraftIdentity {
  readonly paneId: string;
  readonly projectId: string;
}

export class FileDraftRegistry {
  readonly #drafts = new Map<string, FileDraft>();

  get(paneId: string, projectId: string): FileDraft | undefined {
    const draft = this.#drafts.get(paneId);
    return draft?.projectId === projectId ? draft : undefined;
  }

  store(
    identity: DraftIdentity,
    path: string,
    base: ProjectFileContent | null,
    draftSource: string,
    sensitive = base?.sensitive ?? false,
    assistantMerge: FileAssistantMerge | null = null,
  ): FileDraft {
    const draftBytes = Buffer.byteLength(draftSource, "utf8");
    if (draftBytes > MAX_FILE_DRAFT_BYTES) {
      throw new AppError("FILE_TOO_LARGE", 413, "메모리 초안이 1 MiB 편집 상한을 넘었습니다.");
    }

    const previous = this.#drafts.get(identity.paneId);
    const projectedCount = previous === undefined ? this.#drafts.size + 1 : this.#drafts.size;
    const candidateBytes =
      Buffer.byteLength(base?.source ?? "", "utf8") +
      draftBytes +
      Buffer.byteLength(assistantMerge?.current.source ?? "", "utf8");
    const projectedBytes = this.#totalBytes() - draftSize(previous) + candidateBytes;
    if (projectedCount > MAX_FILE_DRAFTS || projectedBytes > MAX_TOTAL_FILE_DRAFT_BYTES) {
      throw new AppError(
        "FILE_LIMIT_EXCEEDED",
        413,
        "열린 파일 초안이 메모리 보존 상한을 넘었습니다. 일부 Files Pane을 저장하거나 닫아 주세요.",
      );
    }

    const draft: FileDraft = {
      paneId: identity.paneId,
      projectId: identity.projectId,
      path,
      baseRevision: base?.revision ?? null,
      baseSource: base?.source ?? "",
      draftSource,
      sensitive,
      assistantMerge,
      updatedAt: new Date().toISOString(),
    };
    this.#drafts.set(identity.paneId, draft);
    return draft;
  }

  clearPane(paneId: string): boolean {
    return this.#drafts.delete(paneId);
  }

  clearProject(projectId: string): void {
    for (const [paneId, draft] of this.#drafts) {
      if (draft.projectId === projectId) this.#drafts.delete(paneId);
    }
  }

  clear(): void {
    this.#drafts.clear();
  }

  #totalBytes(): number {
    let result = 0;
    for (const draft of this.#drafts.values()) result += draftSize(draft);
    return result;
  }
}

function draftSize(draft: FileDraft | undefined): number {
  return draft === undefined
    ? 0
    : Buffer.byteLength(draft.baseSource, "utf8") +
        Buffer.byteLength(draft.draftSource, "utf8") +
        Buffer.byteLength(draft.assistantMerge?.current.source ?? "", "utf8");
}
