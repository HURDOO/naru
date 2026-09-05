import { describe, expect, it } from "vitest";
import {
  fileConflictAssistantPrompt,
  renderResolvedSegments,
  threeWayMerge,
} from "./three-way-merge.js";

describe("threeWayMerge", () => {
  it("merges independent edits without writing conflict markers", () => {
    const result = threeWayMerge(
      "one\ntwo\nthree\nfour\n",
      "ONE\ntwo\nthree\nfour\n",
      "one\ntwo\nthree\nFOUR\n",
    );

    expect(result).toMatchObject({ status: "merged", conflicts: [] });
    expect(result.source).toBe("ONE\ntwo\nthree\nFOUR\n");
    expect(result.source).not.toContain("<<<<<<<");
  });

  it("recognizes identical and one-sided edits", () => {
    expect(threeWayMerge("base\n", "same\n", "same\n").source).toBe("same\n");
    expect(threeWayMerge("base\n", "base\n", "theirs\n").source).toBe("theirs\n");
    expect(threeWayMerge("base\n", "mine\n", "base\n").source).toBe("mine\n");
  });

  it("returns overlapping hunks and resolves each choice in memory", () => {
    const result = threeWayMerge(
      "before\nshared\nafter\n",
      "before\nmy change\nafter\n",
      "before\ntheir change\nafter\n",
    );

    expect(result.status).toBe("conflict");
    expect(result.source).toBeNull();
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]).toMatchObject({
      startLine: 2,
      endLine: 2,
      base: "shared\n",
      mine: "my change\n",
      theirs: "their change\n",
    });
    const id = result.conflicts[0]?.id ?? "missing";
    expect(renderResolvedSegments(result.segments, { [id]: "mine" })).toBe(
      "before\nmy change\nafter\n",
    );
    expect(renderResolvedSegments(result.segments, { [id]: "theirs" })).toBe(
      "before\ntheir change\nafter\n",
    );
    expect(renderResolvedSegments(result.segments, { [id]: "both" })).toBe(
      "before\nmy change\ntheir change\nafter\n",
    );
    expect(renderResolvedSegments(result.segments, {})).toBeNull();
  });

  it("treats competing insertions at the same position as a conflict", () => {
    const result = threeWayMerge("top\nbottom\n", "top\nmine\nbottom\n", "top\ntheirs\nbottom\n");
    expect(result.status).toBe("conflict");
    expect(result.conflicts[0]).toMatchObject({ base: "", mine: "mine\n", theirs: "theirs\n" });
  });
});

describe("fileConflictAssistantPrompt", () => {
  it("requires a conservative merge that preserves both sides", () => {
    const prompt = fileConflictAssistantPrompt(
      "notes.txt",
      "shared\n",
      "shared\nmy sentence\n",
      "shared\ncodex sentence\n",
    );

    expect(prompt).toContain("현재 디스크 파일을 최신 출발점");
    expect(prompt).toContain("내 초안 전체로 파일을 교체하지 마세요");
    expect(prompt).toContain("양쪽 모두 보존하세요");
    expect(prompt).toContain("한쪽 문장이나 코드를 편의상 삭제하지 마세요");
    expect(prompt).toContain("두 변경의 의미를 만족하는 결과로 합성하세요");
    expect(prompt).toContain("확신할 수 없으면 파일을 수정하지 말고");
    expect(prompt).toContain("base→내 초안 patch (사용자 의도)");
    expect(prompt).toContain("base→현재 디스크 patch (최신 외부 변경)");
    expect(prompt).toContain("notes.txt");
    expect(prompt).toContain("my sentence");
    expect(prompt).toContain("codex sentence");
  });
});
