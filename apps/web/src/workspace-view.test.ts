import { describe, expect, it } from "vitest";
import {
  classifyWorkspaceViewport,
  defaultAdaptiveView,
  resolveWorkspaceView,
  stabilizeWorkspaceViewport,
  usesHoverProjectNavigation,
  usesOverlayProjectNavigation,
} from "./workspace-view.js";

describe("workspace viewport policy", () => {
  it.each([
    [{ width: 360, height: 780 }, "phone", "focus"],
    [{ width: 780, height: 360 }, "phone", "focus"],
    [{ width: 768, height: 900 }, "adaptive", "multi"],
    [{ width: 1_440, height: 900 }, "desktop", "multi"],
  ] as const)("maps %o to %s with a %s default", (viewport, viewportClass, mode) => {
    expect(classifyWorkspaceViewport(viewport)).toBe(viewportClass);
    expect(resolveWorkspaceView(viewport, null)).toBe(mode);
  });

  it("uses aspect and available width for an adaptive Fold default", () => {
    expect(defaultAdaptiveView({ width: 640, height: 900 })).toBe("focus");
    expect(defaultAdaptiveView({ width: 690, height: 830 })).toBe("multi");
    expect(defaultAdaptiveView({ width: 900, height: 640 })).toBe("multi");
  });

  it("honors a user preference only where both views remain usable", () => {
    expect(resolveWorkspaceView({ width: 768, height: 900 }, "focus")).toBe("focus");
    expect(resolveWorkspaceView({ width: 360, height: 780 }, "multi")).toBe("focus");
    expect(resolveWorkspaceView({ width: 1_440, height: 900 }, "focus")).toBe("multi");
  });

  it("keeps a Fold layout viewport stable while a soft-keyboard input is focused", () => {
    const fold = { width: 690, height: 830 };

    const opened = stabilizeWorkspaceViewport(fold, { width: 687, height: 420 }, true);
    expect(opened).toEqual({ viewport: fold, keyboardSession: fold });
    expect(
      stabilizeWorkspaceViewport(fold, { width: 692, height: 430 }, false, opened.keyboardSession),
    ).toEqual({ viewport: fold, keyboardSession: fold });
    expect(
      stabilizeWorkspaceViewport(fold, { width: 690, height: 830 }, true, opened.keyboardSession),
    ).toEqual({ viewport: { width: 690, height: 830 }, keyboardSession: null });

    expect(stabilizeWorkspaceViewport(fold, { width: 690, height: 420 }, false)).toEqual({
      viewport: { width: 690, height: 420 },
      keyboardSession: null,
    });
    expect(stabilizeWorkspaceViewport(fold, { width: 830, height: 420 }, true)).toEqual({
      viewport: { width: 830, height: 420 },
      keyboardSession: null,
    });
    expect(stabilizeWorkspaceViewport(fold, { width: 690, height: 900 }, true)).toEqual({
      viewport: { width: 690, height: 900 },
      keyboardSession: null,
    });
  });

  it.each([
    [{ width: 360, height: 780 }, true],
    [{ width: 600, height: 900 }, true],
    [{ width: 601, height: 900 }, false],
    [{ width: 768, height: 900 }, false],
    [{ width: 1_440, height: 900 }, false],
  ] as const)("uses overlay project navigation for %o: %s", (viewport, expected) => {
    expect(usesOverlayProjectNavigation(viewport)).toBe(expected);
  });

  it.each([
    [{ width: 1_440, height: 900 }, true, true],
    [{ width: 768, height: 900 }, true, true],
    [{ width: 768, height: 900 }, false, false],
    [{ width: 600, height: 900 }, true, false],
  ] as const)(
    "uses hover project navigation for %o with hover=%s: %s",
    (viewport, hoverCapable, expected) => {
      expect(usesHoverProjectNavigation(viewport, hoverCapable)).toBe(expected);
    },
  );
});
