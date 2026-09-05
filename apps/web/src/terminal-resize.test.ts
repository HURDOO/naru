import { describe, expect, it, vi } from "vitest";
import {
  createTerminalResizeScheduler,
  initialTerminalResizeState,
  resolveTerminalResize,
} from "./terminal-resize.js";

describe("terminal resize policy", () => {
  it("keeps columns stable across a focused keyboard height drop and width jitter", () => {
    const initial = initialTerminalResizeState({ width: 640, height: 500 }, { cols: 80, rows: 30 });
    const opened = resolveTerminalResize(initial, {
      host: { width: 637, height: 260 },
      proposed: { cols: 79, rows: 12 },
      textInputFocused: true,
    });

    expect(opened.dimensions).toEqual({ cols: 80, rows: 12 });
    expect(opened.keyboardSession).toBe(true);

    const transientBlur = resolveTerminalResize(opened.state, {
      host: { width: 642, height: 250 },
      proposed: { cols: 81, rows: 11 },
      textInputFocused: false,
    });
    expect(transientBlur.dimensions).toEqual({ cols: 80, rows: 11 });
    expect(transientBlur.keyboardSession).toBe(true);

    const closed = resolveTerminalResize(transientBlur.state, {
      host: { width: 640, height: 500 },
      proposed: { cols: 80, rows: 30 },
      textInputFocused: true,
    });
    expect(closed.dimensions).toEqual({ cols: 80, rows: 30 });
    expect(closed.keyboardSession).toBe(false);
  });

  it("accepts real width changes such as a pinned sidebar", () => {
    const initial = initialTerminalResizeState({ width: 640, height: 500 }, { cols: 80, rows: 30 });
    const resized = resolveTerminalResize(initial, {
      host: { width: 412, height: 500 },
      proposed: { cols: 50, rows: 30 },
      textInputFocused: false,
    });

    expect(resized.dimensions).toEqual({ cols: 50, rows: 30 });
    expect(resized.keyboardSession).toBe(false);
  });

  it("ends a keyboard session when a real width change arrives", () => {
    const initial = initialTerminalResizeState({ width: 640, height: 500 }, { cols: 80, rows: 30 });
    const keyboard = resolveTerminalResize(initial, {
      host: { width: 638, height: 260 },
      proposed: { cols: 79, rows: 12 },
      textInputFocused: true,
    });
    const sidebar = resolveTerminalResize(keyboard.state, {
      host: { width: 412, height: 260 },
      proposed: { cols: 50, rows: 12 },
      textInputFocused: true,
    });

    expect(sidebar.dimensions).toEqual({ cols: 50, rows: 12 });
    expect(sidebar.keyboardSession).toBe(false);
  });
});

describe("terminal resize scheduler", () => {
  it("coalesces animation events and preserves a pending refresh", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const scheduler = createTerminalResizeScheduler(apply);

    scheduler.request();
    vi.advanceTimersByTime(40);
    scheduler.request(true);
    vi.advanceTimersByTime(79);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ refresh: true });

    scheduler.dispose();
    vi.useRealTimers();
  });

  it("can flush the latest request and cancels disposed work", () => {
    vi.useFakeTimers();
    const apply = vi.fn();
    const scheduler = createTerminalResizeScheduler(apply);

    scheduler.request();
    scheduler.flush();
    expect(apply).toHaveBeenCalledOnce();
    scheduler.request();
    scheduler.dispose();
    vi.runAllTimers();
    expect(apply).toHaveBeenCalledOnce();

    vi.useRealTimers();
  });
});
