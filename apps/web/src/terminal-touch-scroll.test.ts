// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import {
  attachTerminalTouchScroll,
  beginTerminalScrollbarTouchDrag,
  beginTerminalTouchScroll,
  lineForTerminalScrollbarTouchDrag,
  updateTerminalTouchScroll,
} from "./terminal-touch-scroll";

describe("terminal touch scroll", () => {
  it("keeps a tap pending below the movement threshold", () => {
    const gesture = beginTerminalTouchScroll(4, 20, 100);
    const update = updateTerminalTouchScroll(gesture, 4, 23, 104, 10);

    expect(update).toEqual({ gesture, lines: 0, scrolling: false });
  });

  it("turns a downward finger drag into upward scrollback lines", () => {
    const gesture = beginTerminalTouchScroll(7, 40, 100);
    const first = updateTerminalTouchScroll(gesture, 7, 41, 126, 10);
    const second = updateTerminalTouchScroll(first.gesture, 7, 41, 145, 10);

    expect(first.lines).toBe(-2);
    expect(first.scrolling).toBe(true);
    expect(second.lines).toBe(-2);
    expect(second.gesture.remainderPixels).toBe(-5);
  });

  it("turns an upward finger drag into downward scrollback lines", () => {
    const gesture = beginTerminalTouchScroll(2, 40, 100);
    const update = updateTerminalTouchScroll(gesture, 2, 39, 75, 10);

    expect(update.lines).toBe(2);
    expect(update.gesture.remainderPixels).toBe(5);
    expect(update.scrolling).toBe(true);
  });

  it("locks a horizontal gesture without scrolling later diagonal movement", () => {
    const gesture = beginTerminalTouchScroll(9, 20, 100);
    const horizontal = updateTerminalTouchScroll(gesture, 9, 40, 104, 10);
    const diagonal = updateTerminalTouchScroll(horizontal.gesture, 9, 42, 70, 10);

    expect(horizontal.gesture.axis).toBe("horizontal");
    expect(diagonal.lines).toBe(0);
    expect(diagonal.scrolling).toBe(false);
  });

  it("ignores movement from a different pointer", () => {
    const gesture = beginTerminalTouchScroll(3, 20, 100);
    const update = updateTerminalTouchScroll(gesture, 8, 20, 40, 10);

    expect(update).toEqual({ gesture, lines: 0, scrolling: false });
  });

  it("keeps one scrollbar grab active across many touch moves", () => {
    const drag = beginTerminalScrollbarTouchDrag(12, 240, 240, 300, 600, 60);

    expect(lineForTerminalScrollbarTouchDrag(drag, 12, 222)).toBe(230);
    expect(lineForTerminalScrollbarTouchDrag(drag, 12, 186)).toBe(210);
    expect(lineForTerminalScrollbarTouchDrag(drag, 12, 132)).toBe(180);
    expect(lineForTerminalScrollbarTouchDrag(drag, 12, 294)).toBe(270);
  });

  it("clamps a scrollbar drag and ignores a different pointer", () => {
    const drag = beginTerminalScrollbarTouchDrag(16, 100, 20, 80, 200, 40);

    expect(lineForTerminalScrollbarTouchDrag(drag, 16, -100)).toBe(0);
    expect(lineForTerminalScrollbarTouchDrag(drag, 16, 400)).toBe(80);
    expect(lineForTerminalScrollbarTouchDrag(drag, 99, 120)).toBeNull();
  });

  it("scrolls an existing selection and reserves a stationary tap for dismissal", () => {
    const screen = document.createElement("div");
    document.body.appendChild(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    const scrollLines = vi.fn();
    const focusInput = vi.fn();
    const cancel = vi.fn();
    const terminal = {
      rows: 10,
      buffer: { active: { baseY: 100, viewportY: 50 } },
      focus: vi.fn(),
      scrollLines,
      scrollToLine: vi.fn(),
    };
    const selection = {
      active: true,
      hasSelection: () => true,
      canLongPress: () => true,
      enter: vi.fn(),
      begin: vi.fn(),
      move: vi.fn(),
      finish: vi.fn(),
      selectAll: vi.fn(),
      getSelection: () => "selected",
      cancel,
      dispose: vi.fn(),
    };
    const detach = attachTerminalTouchScroll(screen, terminal, selection, focusInput);

    screen.dispatchEvent(touchPointer("pointerdown", 1, 50, 40));
    screen.dispatchEvent(touchPointer("pointermove", 1, 50, 70));
    screen.dispatchEvent(touchPointer("pointerup", 1, 50, 70));

    expect(scrollLines).toHaveBeenCalledWith(-3);
    expect(cancel).not.toHaveBeenCalled();
    expect(focusInput).not.toHaveBeenCalled();

    screen.dispatchEvent(touchPointer("pointerdown", 2, 50, 40));
    screen.dispatchEvent(touchPointer("pointerup", 2, 50, 40));

    expect(cancel).toHaveBeenCalledOnce();
    expect(focusInput).toHaveBeenCalledOnce();
    detach();
    screen.remove();
  });

  it("marks only a stationary long press as pending for native menu suppression", () => {
    const screen = document.createElement("div");
    document.body.appendChild(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    const terminal = {
      rows: 10,
      buffer: { active: { baseY: 100, viewportY: 50 } },
      focus: vi.fn(),
      scrollLines: vi.fn(),
      scrollToLine: vi.fn(),
    };
    const selection = {
      active: false,
      hasSelection: () => false,
      canLongPress: () => true,
      enter: vi.fn(),
      begin: vi.fn(),
      move: vi.fn(),
      finish: vi.fn(),
      selectAll: vi.fn(),
      getSelection: () => "",
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    const detach = attachTerminalTouchScroll(screen, terminal, selection);

    screen.dispatchEvent(touchPointer("pointerdown", 1, 50, 40));
    expect(screen.dataset.naruTouchLongPress).toBe("pending");
    screen.dispatchEvent(touchPointer("pointerup", 1, 50, 40));
    expect(screen.dataset.naruTouchLongPress).toBeUndefined();

    screen.dispatchEvent(touchPointer("pointerdown", 2, 50, 40));
    expect(screen.dataset.naruTouchLongPress).toBe("pending");
    screen.dispatchEvent(touchPointer("pointermove", 2, 50, 70));
    expect(screen.dataset.naruTouchLongPress).toBeUndefined();
    screen.dispatchEvent(touchPointer("pointerup", 2, 50, 70));

    detach();
    screen.remove();
  });

  it("keeps edge auto-scroll running through repeated touch jitter", () => {
    vi.useFakeTimers();
    const screen = document.createElement("div");
    document.body.appendChild(screen);
    screen.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 100, bottom: 100, width: 100, height: 100 }) as DOMRect;
    const scrollLines = vi.fn();
    const terminal = {
      rows: 10,
      buffer: { active: { baseY: 100, viewportY: 50 } },
      focus: vi.fn(),
      scrollLines,
      scrollToLine: vi.fn(),
    };
    const selection = {
      active: true,
      hasSelection: () => false,
      canLongPress: () => true,
      enter: vi.fn(),
      begin: vi.fn(),
      move: vi.fn(),
      finish: vi.fn(),
      selectAll: vi.fn(),
      getSelection: () => "",
      cancel: vi.fn(),
      dispose: vi.fn(),
    };
    const detach = attachTerminalTouchScroll(screen, terminal, selection);

    screen.dispatchEvent(touchPointer("pointerdown", 1, 50, 50));
    screen.dispatchEvent(touchPointer("pointermove", 1, 50, 90));
    vi.advanceTimersByTime(40);
    screen.dispatchEvent(touchPointer("pointermove", 1, 51, 91));
    vi.advanceTimersByTime(40);
    screen.dispatchEvent(touchPointer("pointermove", 1, 50, 90));
    vi.advanceTimersByTime(40);
    expect(scrollLines).toHaveBeenCalledWith(1);
    screen.dispatchEvent(touchPointer("pointerup", 1, 50, 90));

    scrollLines.mockClear();
    screen.dispatchEvent(touchPointer("pointerdown", 2, 50, 50));
    screen.dispatchEvent(touchPointer("pointermove", 2, 50, 10));
    vi.advanceTimersByTime(40);
    screen.dispatchEvent(touchPointer("pointermove", 2, 49, 9));
    vi.advanceTimersByTime(40);
    screen.dispatchEvent(touchPointer("pointermove", 2, 50, 10));
    vi.advanceTimersByTime(40);
    expect(scrollLines).toHaveBeenCalledWith(-1);
    screen.dispatchEvent(touchPointer("pointerup", 2, 50, 10));

    detach();
    screen.remove();
    vi.useRealTimers();
  });
});

function touchPointer(
  type: "pointerdown" | "pointermove" | "pointerup",
  pointerId: number,
  clientX: number,
  clientY: number,
): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    pointerId: { value: pointerId },
    pointerType: { value: "touch" },
    isPrimary: { value: true },
    clientX: { value: clientX },
    clientY: { value: clientY },
  });
  return event;
}
