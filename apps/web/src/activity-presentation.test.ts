import { describe, expect, it } from "vitest";
import { ACTIVITY_PRESENTATION, activityLabel } from "./activity-presentation";

describe("activity presentation", () => {
  it.each([
    ["canceled", "−", "사용자 취소"],
    ["server-stopped", "■", "서버 중지"],
    ["failed", "×", "실패"],
  ] as const)("presents %s as a distinct accessible state", (state, glyph, label) => {
    expect(ACTIVITY_PRESENTATION[state]).toEqual({ glyph, label });
    expect(activityLabel(state)).toBe(label);
  });
});
