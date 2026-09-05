import { describe, expect, it } from "vitest";
import { canPromoteTerminalRestore, translatePreviewBottomOffset } from "./terminal-restore";

describe("staged terminal restore", () => {
  it("promotes only a current fully parsed renderer outside focus and IME composition", () => {
    const ready = {
      candidateReady: true,
      parsedSequence: 11,
      latestSequence: 11,
      restoreMatches: true,
      composing: false,
      inputFocused: false,
    };
    expect(canPromoteTerminalRestore(ready)).toBe(true);
    expect(canPromoteTerminalRestore({ ...ready, parsedSequence: 10 })).toBe(false);
    expect(canPromoteTerminalRestore({ ...ready, restoreMatches: false })).toBe(false);
    expect(canPromoteTerminalRestore({ ...ready, composing: true })).toBe(false);
    expect(canPromoteTerminalRestore({ ...ready, inputFocused: true })).toBe(false);
  });

  it("translates movement in the compact preview back to the bounded full scrollback", () => {
    expect(translatePreviewBottomOffset(800, 30, 30, 2_000)).toBe(800);
    expect(translatePreviewBottomOffset(800, 30, 20, 2_000)).toBe(790);
    expect(translatePreviewBottomOffset(1, 30, 0, 2_000)).toBe(0);
    expect(translatePreviewBottomOffset(1_990, 30, 60, 2_000)).toBe(2_000);
  });
});
