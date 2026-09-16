// @vitest-environment jsdom

import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import {
  attachTerminalTouchSelection,
  touchBufferPoint,
  touchSelectionSpan,
  touchWordSpan,
} from "./terminal-touch-selection";

describe("terminal touch selection", () => {
  it("maps a touch to the visible absolute buffer cell and clamps screen edges", () => {
    const bounds = { left: 10, top: 20, width: 100, height: 60 };

    expect(touchBufferPoint(65, 65, bounds, 10, 3, 40)).toEqual({ column: 5, row: 42 });
    expect(touchBufferPoint(-10, 0, bounds, 10, 3, 40)).toEqual({ column: 0, row: 40 });
    expect(touchBufferPoint(500, 500, bounds, 10, 3, 40)).toEqual({ column: 9, row: 42 });
  });

  it("extends a seed across wrapped rows in either direction", () => {
    const seed = { start: 43, end: 47 };

    expect(touchSelectionSpan(seed, { column: 2, row: 6 }, 10)).toEqual({
      start: 43,
      end: 63,
    });
    expect(touchSelectionSpan(seed, { column: 8, row: 2 }, 10)).toEqual({
      start: 28,
      end: 47,
    });
    expect(touchSelectionSpan(seed, { column: 4, row: 4 }, 10)).toEqual(seed);
  });

  it("retains the selected span and dismisses it when xterm clears first", () => {
    const pane = document.createElement("section");
    pane.className = "pane-surface";
    const screen = document.createElement("div");
    pane.appendChild(screen);
    document.body.appendChild(pane);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }) as DOMRect;
    let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
    let selectionListener: () => void = () => undefined;
    let focusCount = 0;
    let blurCount = 0;
    const textarea = document.createElement("textarea");
    const terminal = {
      cols: 10,
      rows: 3,
      textarea,
      buffer: {
        active: {
          viewportY: 0,
          length: 5,
          getLine: () => undefined,
        },
      },
      getSelection: () => (selection ? "retained selection" : ""),
      getSelectionPosition: () => selection,
      onSelectionChange: (listener: () => void) => {
        selectionListener = listener;
        return { dispose: () => undefined };
      },
      onScroll: () => ({ dispose: () => undefined }),
      select: (column: number, row: number, length: number) => {
        selection = {
          start: { x: column, y: row },
          end: { x: column + length, y: row },
        };
        selectionListener();
      },
      clearSelection: () => {
        selection = null;
        selectionListener();
      },
      blur: () => {
        blurCount += 1;
      },
      focus: () => {
        focusCount += 1;
      },
      scrollLines: () => undefined,
    } as unknown as Terminal;
    const controller = attachTerminalTouchSelection(screen, terminal, () => undefined);

    controller.enter();
    controller.begin(15, 5);
    controller.finish();
    terminal.clearSelection();

    expect(controller.hasSelection()).toBe(true);
    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, "touches", { value: [{ clientX: 85, clientY: 5 }] });
    screen.dispatchEvent(touchStart);
    expect(controller.active).toBe(false);
    expect(blurCount).toBe(2);
    expect(focusCount).toBe(0);
    controller.dispose();
  });

  it("selects a Korean word by cell width and keeps an emoji intact", () => {
    const cells = [
      { chars: " ", width: 1 },
      { chars: "한", width: 2 },
      { chars: "", width: 0 },
      { chars: "글", width: 2 },
      { chars: "", width: 0 },
      { chars: "_", width: 1 },
      { chars: "A", width: 1 },
      { chars: "😀", width: 2 },
      { chars: "", width: 0 },
      { chars: " ", width: 1 },
    ];
    const terminal = {
      cols: 10,
      buffer: {
        active: {
          getLine: (row: number) =>
            row === 2
              ? {
                  getCell: (column: number) => {
                    const cell = cells[column];
                    return cell
                      ? { getChars: () => cell.chars, getWidth: () => cell.width }
                      : undefined;
                  },
                }
              : undefined,
        },
      },
    } as unknown as Pick<Terminal, "buffer" | "cols">;

    expect(touchWordSpan(terminal, { column: 2, row: 2 })).toEqual({ start: 21, end: 27 });
    expect(touchWordSpan(terminal, { column: 7, row: 2 })).toEqual({ start: 27, end: 29 });
    expect(touchWordSpan(terminal, { column: 0, row: 2 })).toBeNull();
  });

  it("keeps native copy data after the pane touch dismisses the visual selection", () => {
    const pane = document.createElement("section");
    pane.className = "pane-surface";
    const terminalElement = document.createElement("div");
    const textarea = document.createElement("textarea");
    const screen = document.createElement("div");
    terminalElement.append(textarea, screen);
    pane.appendChild(terminalElement);
    document.body.appendChild(pane);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }) as DOMRect;
    let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
    let selectionListener: () => void = () => undefined;
    const terminal = {
      cols: 10,
      rows: 3,
      element: terminalElement,
      textarea,
      buffer: {
        active: {
          viewportY: 0,
          length: 5,
          getLine: () => undefined,
        },
      },
      getSelection: () => (selection ? "native terminal selection" : ""),
      getSelectionPosition: () => selection,
      onSelectionChange: (listener: () => void) => {
        selectionListener = listener;
        return { dispose: () => undefined };
      },
      onScroll: () => ({ dispose: () => undefined }),
      select: (column: number, row: number, length: number) => {
        selection = {
          start: { x: column, y: row },
          end: { x: column + length, y: row },
        };
        selectionListener();
      },
      clearSelection: () => {
        selection = null;
        selectionListener();
      },
      blur: () => textarea.blur(),
      focus: () => textarea.focus(),
      scrollLines: () => undefined,
    } as unknown as Terminal;
    const copied = vi.fn();
    const setData = vi.fn();
    const controller = attachTerminalTouchSelection(screen, terminal, () => undefined, copied);

    controller.begin(15, 5);
    controller.finish();
    terminal.clearSelection();
    const xtermContextMenu = vi.fn(() => {
      textarea.value = "";
    });
    terminalElement.addEventListener("contextmenu", xtermContextMenu);
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.dispatchEvent(contextMenu);

    expect(contextMenu.defaultPrevented).toBe(false);
    expect(xtermContextMenu).not.toHaveBeenCalled();
    expect(textarea.value).toBe("native terminal selection");
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(textarea.value.length);
    expect(document.activeElement).toBe(textarea);

    const touchStart = new Event("touchstart", { bubbles: true, cancelable: true });
    Object.defineProperty(touchStart, "touches", { value: [{ clientX: 85, clientY: 5 }] });
    screen.dispatchEvent(touchStart);

    expect(controller.active).toBe(false);
    expect(textarea.value).toBe("");
    expect(document.activeElement).not.toBe(textarea);

    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    document.dispatchEvent(copy);

    expect(copy.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "native terminal selection");
    expect(copied).toHaveBeenCalledWith("copied");
    controller.dispose();
  });

  it("creates a native textarea selection when a focused blank cell is long-pressed", () => {
    const pane = document.createElement("section");
    pane.className = "pane-surface";
    const terminalElement = document.createElement("div");
    const textarea = document.createElement("textarea");
    const screen = document.createElement("div");
    terminalElement.append(textarea, screen);
    pane.appendChild(terminalElement);
    document.body.appendChild(pane);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 30, width: 100, height: 30 }) as DOMRect;
    let selection: { start: { x: number; y: number }; end: { x: number; y: number } } | null = null;
    let selectionListener: () => void = () => undefined;
    const terminal = {
      cols: 10,
      rows: 3,
      element: terminalElement,
      textarea,
      buffer: {
        active: {
          viewportY: 0,
          length: 5,
          getLine: () => undefined,
        },
      },
      getSelection: () => "",
      getSelectionPosition: () => selection,
      onSelectionChange: (listener: () => void) => {
        selectionListener = listener;
        return { dispose: () => undefined };
      },
      onScroll: () => ({ dispose: () => undefined }),
      select: (column: number, row: number, length: number) => {
        selection = {
          start: { x: column, y: row },
          end: { x: column + length, y: row },
        };
        selectionListener();
      },
      clearSelection: () => {
        selection = null;
        selectionListener();
      },
      blur: () => undefined,
      focus: () => undefined,
      scrollLines: () => undefined,
    } as unknown as Terminal;
    const copied = vi.fn();
    const setData = vi.fn();
    const controller = attachTerminalTouchSelection(screen, terminal, () => undefined, copied);

    textarea.focus();
    expect(controller.canLongPress(15, 5)).toBe(true);
    controller.begin(15, 5, true);
    controller.finish();
    const contextMenu = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.dispatchEvent(contextMenu);

    expect(contextMenu.defaultPrevented).toBe(false);
    expect(textarea.value).toBe("\u00a0");
    expect(textarea.selectionStart).toBe(0);
    expect(textarea.selectionEnd).toBe(1);

    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    document.dispatchEvent(copy);

    expect(copy.defaultPrevented).toBe(true);
    expect(setData).toHaveBeenCalledWith("text/plain", "");
    expect(copied).toHaveBeenCalledWith("empty");
    controller.dispose();
  });
});
