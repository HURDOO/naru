import { describe, expect, it } from "vitest";
import { FileDraftRegistry, MAX_FILE_DRAFT_BYTES } from "../src/file-drafts.js";

const identity = {
  paneId: "11111111-1111-4111-8111-111111111111",
  projectId: "22222222-2222-4222-8222-222222222222",
};

describe("FileDraftRegistry", () => {
  it("keeps one memory-only draft per Files Pane with its immutable merge base", () => {
    const drafts = new FileDraftRegistry();
    const first = drafts.store(
      identity,
      "src/app.ts",
      {
        path: "src/app.ts",
        source: "base\n",
        revision: "a".repeat(64),
        sizeBytes: 5,
        modifiedAt: "2026-08-21T00:00:00.000Z",
        sensitive: false,
      },
      "mine\n",
    );

    expect(drafts.get(identity.paneId, identity.projectId)).toEqual(first);
    expect(first).toMatchObject({
      baseSource: "base\n",
      draftSource: "mine\n",
      assistantMerge: null,
    });

    const withAssistant = drafts.store(
      identity,
      "src/app.ts",
      {
        path: "src/app.ts",
        source: "base\n",
        revision: "a".repeat(64),
        sizeBytes: 5,
        modifiedAt: "2026-08-21T00:00:00.000Z",
        sensitive: false,
      },
      "mine\n",
      false,
      {
        paneId: "33333333-3333-4333-8333-333333333333",
        initialActivityEventId: null,
        current: {
          path: "src/app.ts",
          source: "theirs\n",
          revision: "b".repeat(64),
          sizeBytes: 7,
          modifiedAt: "2026-08-21T00:01:00.000Z",
          sensitive: false,
        },
        requestedAt: "2026-08-21T00:02:00.000Z",
      },
    );
    expect(withAssistant.assistantMerge).toMatchObject({
      paneId: "33333333-3333-4333-8333-333333333333",
      current: { source: "theirs\n" },
    });
    expect(drafts.get(identity.paneId, "33333333-3333-4333-8333-333333333333")).toBeUndefined();
    expect(drafts.clearPane(identity.paneId)).toBe(true);
  });

  it("does not persist oversized drafts and can clear every draft owned by a project", () => {
    const drafts = new FileDraftRegistry();
    expect(() =>
      drafts.store(identity, "large.txt", null, "x".repeat(MAX_FILE_DRAFT_BYTES + 1)),
    ).toThrowError(expect.objectContaining({ code: "FILE_TOO_LARGE" }));

    drafts.store(identity, "new.txt", null, "new");
    drafts.clearProject(identity.projectId);
    expect(drafts.get(identity.paneId, identity.projectId)).toBeUndefined();
  });
});
