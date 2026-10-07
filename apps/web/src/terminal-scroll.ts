interface ScrollTarget {
  readonly modes?: { readonly mouseTrackingMode: string };
  buffer: { active: { readonly type?: "normal" | "alternate" } };
  scrollLines(amount: number): void;
}

/** Wheel reports still pass through xterm onData and the attachment's controller fence. */
export function scrollTerminalAt(
  screen: HTMLElement,
  terminal: ScrollTarget,
  lines: number,
  clientX: number,
  clientY: number,
): void {
  if (
    terminal.buffer.active.type !== "alternate" ||
    !terminal.modes ||
    terminal.modes.mouseTrackingMode === "none"
  ) {
    terminal.scrollLines(lines);
    return;
  }
  const bounds = screen.getBoundingClientRect();
  for (let i = 0; i < Math.min(Math.abs(lines), 24); i++) {
    screen.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: Math.max(bounds.left, Math.min(clientX, bounds.right - 1)),
        clientY: Math.max(bounds.top, Math.min(clientY, bounds.bottom - 1)),
        deltaY: Math.sign(lines),
        deltaMode: WheelEvent.DOM_DELTA_LINE,
      }),
    );
  }
}
