import { describe, expect, it } from "vitest";
import {
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
});
