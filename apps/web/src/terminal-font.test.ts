import { describe, expect, it, vi } from "vitest";
import {
  areTerminalFontsReady,
  loadTerminalFontFaces,
  terminalFontFacesReady,
  TERMINAL_FONT_FAMILY,
  TERMINAL_FONT_SIZE,
  TERMINAL_LINE_HEIGHT,
} from "./terminal-font.js";

describe("terminal font loading", () => {
  it("loads both D2Coding weights with the terminal's text metrics", async () => {
    const load = vi.fn(() => Promise.resolve([]));

    await loadTerminalFontFaces({ load });

    expect(load.mock.calls).toEqual([
      ['400 13px "D2Coding"', "Naru 한글 Aa0"],
      ['700 13px "D2Coding"', "Naru 한글 Aa0"],
    ]);
    expect(TERMINAL_FONT_FAMILY.startsWith('"D2Coding"')).toBe(true);
    expect(TERMINAL_FONT_SIZE).toBe(13);
    expect(TERMINAL_LINE_HEIGHT).toBe(1.2);
  });

  it("requires both D2Coding weights before a terminal can be shown", () => {
    const check = vi
      .fn()
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true);

    expect(terminalFontFacesReady({ check })).toBe(false);
    expect(terminalFontFacesReady({ check })).toBe(true);
    expect(check.mock.calls).toEqual([
      ['400 13px "D2Coding"', "Naru 한글 Aa0"],
      ['700 13px "D2Coding"', "Naru 한글 Aa0"],
      ['400 13px "D2Coding"', "Naru 한글 Aa0"],
      ['700 13px "D2Coding"', "Naru 한글 Aa0"],
    ]);
    expect(areTerminalFontsReady()).toBe(true);
  });
});
