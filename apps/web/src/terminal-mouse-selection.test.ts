// @vitest-environment jsdom
import type { Terminal } from "@xterm/xterm";
import { describe, expect, it, vi } from "vitest";
import { attachTerminalTouchSelection } from "./terminal-touch-selection";

function fixture(mode = "any") {
  const pane = document.createElement("section");
  pane.className = "pane-surface";
  const screen = document.createElement("div");
  const textarea = document.createElement("textarea");
  pane.append(screen, textarea);
  document.body.append(pane);
  screen.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
  let value = "original 한글 😀";
  let selected = false;
  let changed = () => {};
  const terminal = {
    cols: 10,
    rows: 10,
    textarea,
    modes: { mouseTrackingMode: mode },
    buffer: { active: { type: "alternate", viewportY: 0, length: 10, getLine: () => undefined } },
    getSelection: () => (selected ? value : ""),
    getSelectionPosition: () =>
      selected ? { start: { x: 1, y: 2 }, end: { x: 5, y: 2 } } : undefined,
    onSelectionChange: (fn: () => void) => {
      changed = fn;
      return { dispose() {} };
    },
    onScroll: () => ({ dispose() {} }),
    select: vi.fn(() => {
      selected = true;
      changed();
    }),
    clearSelection: () => {
      selected = false;
      changed();
    },
    blur: vi.fn(),
    focus: vi.fn(),
    scrollLines: vi.fn(),
  };
  const onChange = vi.fn();
  const controller = attachTerminalTouchSelection(
    screen,
    terminal as unknown as Terminal,
    onChange,
  );
  const mouse = (type: string, x = 15, y = 25, extra: MouseEventInit = {}) => {
    const event = new MouseEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
      button: 0,
      ...extra,
    });
    screen.dispatchEvent(event);
    return event;
  };
  return {
    screen,
    terminal,
    controller,
    onChange,
    mouse,
    redraw: () => {
      value = "unrelated redraw";
      selected = false;
      changed();
    },
    dispose: () => {
      controller.dispose();
      pane.remove();
    },
  };
}

describe("mouse selection in tracking TUIs", () => {
  it("forwards plain and repeated clicks once without opening selection, including pointer jitter", () => {
    const f = fixture();
    const down = vi.fn();
    const up = vi.fn();
    f.screen.addEventListener("mousedown", down);
    f.screen.addEventListener("mouseup", up);
    for (const detail of [1, 2]) {
      f.mouse("mousedown", 15, 25, { detail, ctrlKey: true, buttons: 1 });
      expect(f.controller.active).toBe(false);
      expect(down).toHaveBeenCalledTimes(detail - 1);
      f.mouse("mousemove", 16, 26);
      expect(f.controller.active).toBe(false);
      f.mouse("mouseup", 16, 26, { detail, ctrlKey: true });
      expect(down).toHaveBeenCalledTimes(detail);
      expect(up).toHaveBeenCalledTimes(detail);
    }
    expect(down.mock.calls[0]?.[0]).toMatchObject({
      clientX: 15,
      clientY: 25,
      ctrlKey: true,
      buttons: 1,
    });
    expect(up.mock.calls[0]?.[0]).toMatchObject({
      clientX: 16,
      clientY: 26,
      ctrlKey: true,
      buttons: 0,
    });
    expect(f.terminal.select).not.toHaveBeenCalled();
    expect(f.onChange).not.toHaveBeenCalledWith(true);
    f.dispose();
  });

  it("does not forward a pending press after window blur or disposal", () => {
    const f = fixture();
    const down = vi.fn();
    f.screen.addEventListener("mousedown", down);
    f.mouse("mousedown");
    window.dispatchEvent(new Event("blur"));
    f.mouse("mouseup");
    expect(down).not.toHaveBeenCalled();
    expect(f.controller.active).toBe(false);
    f.mouse("mousedown");
    f.dispose();
    f.mouse("mouseup");
    expect(down).not.toHaveBeenCalled();
  });

  it("owns left drags and copies the selected text even after a repaint clears xterm", () => {
    const f = fixture();
    const down = vi.fn();
    f.screen.addEventListener("mousedown", down);
    expect(f.mouse("mousedown").defaultPrevented).toBe(true);
    expect(f.controller.active).toBe(false);
    f.mouse("mousemove", 65, 35);
    expect(f.controller.active).toBe(true);
    f.mouse("mouseup", 65, 35);
    expect(down).not.toHaveBeenCalled();
    expect(f.terminal.focus).toHaveBeenCalled();
    f.redraw();
    expect(f.controller.hasSelection()).toBe(true);
    expect(f.terminal.getSelectionPosition()).toBeDefined();
    expect(f.controller.getSelection()).toBe("original 한글 😀");
    const setData = vi.fn();
    const copy = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(copy, "clipboardData", { value: { setData } });
    f.terminal.textarea.dispatchEvent(copy);
    expect(setData).toHaveBeenCalledWith("text/plain", "original 한글 😀");
    f.controller.cancel();
    expect(f.controller.getSelection()).toBe("");
    expect(f.terminal.getSelectionPosition()).toBeUndefined();
    f.dispose();
  });

  it("preserves shell drags, Alt application input, right clicks, and empty clicks", () => {
    const normal = fixture("none");
    expect(normal.mouse("mousedown").defaultPrevented).toBe(false);
    normal.dispose();
    const f = fixture();
    expect(f.mouse("mousedown", 15, 25, { altKey: true }).defaultPrevented).toBe(false);
    expect(f.mouse("mousedown", 15, 25, { button: 2 }).defaultPrevented).toBe(false);
    f.mouse("mousedown");
    f.mouse("mouseup");
    expect(f.controller.active).toBe(false);
    f.dispose();
  });

  it("routes edge scrolling as wheel input and stops on release and disposal", () => {
    vi.useFakeTimers();
    const f = fixture();
    const wheel = vi.fn();
    f.screen.addEventListener("wheel", wheel);
    f.mouse("mousedown");
    f.mouse("mousemove", 50, -20);
    vi.advanceTimersByTime(160);
    expect(wheel).toHaveBeenCalledTimes(2);
    expect(wheel.mock.calls[0]?.[0]).toMatchObject({ deltaY: -1, clientY: 0 });
    expect(f.terminal.scrollLines).not.toHaveBeenCalled();
    f.mouse("mouseup");
    vi.advanceTimersByTime(160);
    expect(wheel).toHaveBeenCalledTimes(2);
    f.mouse("mousedown");
    f.mouse("mousemove", 50, 110);
    f.dispose();
    vi.advanceTimersByTime(160);
    expect(wheel).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });
});
