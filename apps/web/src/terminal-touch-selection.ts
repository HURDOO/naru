import type { Terminal } from "@xterm/xterm";

export interface TerminalTouchSelectionController {
  readonly active: boolean;
  canLongPress(clientX: number, clientY: number): boolean;
  hasSelection(): boolean;
  enter(): void;
  begin(clientX: number, clientY: number, longPress?: boolean): void;
  move(clientX: number, clientY: number): void;
  finish(): void;
  selectAll(): void;
  getSelection(): string;
  cancel(): void;
  dispose(): void;
}

interface BufferPoint {
  column: number;
  row: number;
}

interface BufferSpan {
  start: number;
  end: number;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const HANDLE_EDGE_PX = 22;

export function touchBufferPoint(
  clientX: number,
  clientY: number,
  bounds: Pick<DOMRect, "left" | "top" | "width" | "height">,
  cols: number,
  rows: number,
  viewportY: number,
): BufferPoint {
  const column = clamp(
    Math.floor(((clientX - bounds.left) / Math.max(bounds.width, 1)) * cols),
    0,
    cols - 1,
  );
  const viewportRow = clamp(
    Math.floor(((clientY - bounds.top) / Math.max(bounds.height, 1)) * rows),
    0,
    rows - 1,
  );
  return { column, row: viewportY + viewportRow };
}

export function touchSelectionSpan(
  anchor: BufferSpan,
  point: BufferPoint,
  cols: number,
): BufferSpan {
  const index = point.row * cols + point.column;
  if (index < anchor.start) return { start: index, end: anchor.end };
  if (index >= anchor.end) return { start: anchor.start, end: index + 1 };
  return anchor;
}

export function touchWordSpan(
  terminal: Pick<Terminal, "buffer" | "cols">,
  point: BufferPoint,
): BufferSpan | null {
  const line = terminal.buffer.active.getLine(point.row);
  if (!line) return null;
  let start = point.column;
  const cell = line.getCell(start);
  if (cell?.getWidth() === 0 && start > 0) start -= 1;
  const selected = line.getCell(start);
  const chars = selected?.getChars() ?? "";
  if (!chars || /^\s+$/u.test(chars)) return null;
  let end = Math.min(start + Math.max(selected?.getWidth() ?? 1, 1), terminal.cols);
  if (WORD_CHARACTER.test(chars)) {
    while (start > 0) {
      const previous = line.getCell(start - 1);
      const previousStart = previous?.getWidth() === 0 ? start - 2 : start - 1;
      if (previousStart < 0) break;
      const preceding = line.getCell(previousStart)?.getChars() ?? "";
      if (!WORD_CHARACTER.test(preceding)) break;
      start = previousStart;
    }
    while (end < terminal.cols) {
      const next = line.getCell(end);
      const nextChars = next?.getChars() ?? "";
      if (!WORD_CHARACTER.test(nextChars)) break;
      end += Math.max(next?.getWidth() ?? 1, 1);
    }
  }
  return { start: point.row * terminal.cols + start, end: point.row * terminal.cols + end };
}

export function attachTerminalTouchSelection(
  screen: HTMLElement,
  terminal: Terminal,
  onChange: (active: boolean) => void,
): TerminalTouchSelectionController {
  let active = false;
  let dragging: BufferSpan | null = null;
  let retainedSpan: BufferSpan | null = null;
  let handleDrag: { pointerId: number; edge: "start" | "end"; span: BufferSpan } | null = null;
  let edgeScrollTimer: ReturnType<typeof setInterval> | null = null;
  let lastHandlePoint: { x: number; y: number } | null = null;
  let focusAfterPaneTouch = false;
  const paneSurface = screen.closest<HTMLElement>(".pane-surface");
  const handles = screen.ownerDocument.createElement("div");
  handles.className = "terminal-selection-handles";
  const startHandle = screen.ownerDocument.createElement("button");
  const endHandle = screen.ownerDocument.createElement("button");
  for (const [handle, edge] of [
    [startHandle, "start"],
    [endHandle, "end"],
  ] as const) {
    handle.type = "button";
    handle.className = `terminal-selection-handle is-${edge}`;
    handle.setAttribute("aria-label", edge === "start" ? "선택 시작 조정" : "선택 끝 조정");
    handles.appendChild(handle);
  }
  screen.appendChild(handles);

  const currentSpan = (): BufferSpan | null => {
    const position = terminal.getSelectionPosition();
    if (!position) return null;
    // xterm 6 reports zero-based cells here, despite the 1-based wording in its typings.
    return {
      start: position.start.y * terminal.cols + position.start.x,
      end: position.end.y * terminal.cols + position.end.x,
    };
  };

  const selectedSpan = (): BufferSpan | null => currentSpan() ?? retainedSpan;

  const updateHandles = (): void => {
    const span = active ? selectedSpan() : null;
    handles.hidden = span === null;
    if (!span) return;
    const bounds = screen.getBoundingClientRect();
    const cellWidth = bounds.width / Math.max(terminal.cols, 1);
    const cellHeight = bounds.height / Math.max(terminal.rows, 1);
    const viewportY = terminal.buffer.active.viewportY;
    for (const [handle, index] of [
      [startHandle, span.start],
      [endHandle, span.end],
    ] as const) {
      const row = Math.floor(index / terminal.cols) - viewportY;
      handle.hidden = row < 0 || row >= terminal.rows;
      if (handle.hidden) continue;
      const column = index % terminal.cols;
      handle.style.left = `${column * cellWidth}px`;
      handle.style.top = `${row * cellHeight + cellHeight}px`;
    }
  };

  const publish = (): void => {
    updateHandles();
    onChange(active);
  };

  const selectSpan = (span: BufferSpan): void => {
    const start = Math.max(0, span.start);
    const end = Math.min(
      Math.max(span.end, start + 1),
      terminal.buffer.active.length * terminal.cols,
    );
    retainedSpan = { start, end };
    terminal.select(start % terminal.cols, Math.floor(start / terminal.cols), end - start);
    publish();
  };

  const pointAt = (clientX: number, clientY: number): BufferPoint =>
    touchBufferPoint(
      clientX,
      clientY,
      screen.getBoundingClientRect(),
      terminal.cols,
      terminal.rows,
      terminal.buffer.active.viewportY,
    );

  const stopEdgeScroll = (): void => {
    if (edgeScrollTimer !== null) clearInterval(edgeScrollTimer);
    edgeScrollTimer = null;
  };

  const moveHandle = (clientX: number, clientY: number): void => {
    if (!handleDrag) return;
    lastHandlePoint = { x: clientX, y: clientY };
    const point = pointAt(clientX, clientY);
    const index = point.row * terminal.cols + point.column;
    if (handleDrag.edge === "start") {
      selectSpan({ start: Math.min(index, handleDrag.span.end - 1), end: handleDrag.span.end });
    } else {
      selectSpan({
        start: handleDrag.span.start,
        end: Math.max(index + 1, handleDrag.span.start + 1),
      });
    }
  };

  const onHandlePointerDown = (event: PointerEvent): void => {
    const edge = event.currentTarget === startHandle ? "start" : "end";
    const span = selectedSpan();
    if (!span) return;
    event.preventDefault();
    event.stopPropagation();
    handleDrag = { pointerId: event.pointerId, edge, span };
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    } catch {
      // Window listeners cover browsers that reject pointer capture.
    }
  };

  const onHandleKeyDown = (event: KeyboardEvent): void => {
    const delta =
      event.key === "ArrowLeft"
        ? -1
        : event.key === "ArrowRight"
          ? 1
          : event.key === "ArrowUp"
            ? -terminal.cols
            : event.key === "ArrowDown"
              ? terminal.cols
              : 0;
    if (delta === 0) return;
    const span = selectedSpan();
    if (!span) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.currentTarget === startHandle) {
      selectSpan({ start: clamp(span.start + delta, 0, span.end - 1), end: span.end });
    } else {
      selectSpan({
        start: span.start,
        end: clamp(span.end + delta, span.start + 1, terminal.buffer.active.length * terminal.cols),
      });
    }
  };

  const onWindowPointerMove = (event: PointerEvent): void => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    if (event.cancelable) event.preventDefault();
    moveHandle(event.clientX, event.clientY);
    const bounds = screen.getBoundingClientRect();
    const edge =
      event.clientY < bounds.top + HANDLE_EDGE_PX
        ? -1
        : event.clientY > bounds.bottom - HANDLE_EDGE_PX
          ? 1
          : 0;
    stopEdgeScroll();
    if (edge !== 0) {
      edgeScrollTimer = setInterval(() => {
        terminal.scrollLines(edge);
        if (lastHandlePoint) moveHandle(lastHandlePoint.x, lastHandlePoint.y);
      }, 80);
    }
  };

  const onWindowPointerEnd = (event: PointerEvent): void => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    stopEdgeScroll();
    handleDrag = null;
    lastHandlePoint = null;
  };

  const onContextMenu = (event: MouseEvent): void => {
    if (active) event.preventDefault();
  };
  const onTouchEnd = (event: TouchEvent): void => {
    if (!active) return;
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const onPaneTouchStart = (event: TouchEvent): void => {
    if (!active || event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".terminal-selection-action-menu, .terminal-selection-handle")) return;
    if (screen.contains(target) && (selectedSpan() === null || dragging !== null)) return;
    const shouldRestoreInput = !target.closest(
      "button, input, textarea, select, a, [role='button']",
    );
    cancel();
    if (shouldRestoreInput) {
      focusAfterPaneTouch = true;
      terminal.focus();
    }
  };
  const onPaneTouchEnd = (): void => {
    if (!focusAfterPaneTouch) return;
    focusAfterPaneTouch = false;
    screen.ownerDocument.defaultView?.requestAnimationFrame(() => terminal.focus());
  };

  const selectionChange = terminal.onSelectionChange(() => {
    retainedSpan = currentSpan() ?? retainedSpan;
    publish();
  });
  const scrollChange = terminal.onScroll(updateHandles);
  startHandle.addEventListener("pointerdown", onHandlePointerDown);
  endHandle.addEventListener("pointerdown", onHandlePointerDown);
  startHandle.addEventListener("keydown", onHandleKeyDown);
  endHandle.addEventListener("keydown", onHandleKeyDown);
  screen.ownerDocument.defaultView?.addEventListener("pointermove", onWindowPointerMove, {
    capture: true,
    passive: false,
  });
  screen.ownerDocument.defaultView?.addEventListener("pointerup", onWindowPointerEnd, true);
  screen.ownerDocument.defaultView?.addEventListener("pointercancel", onWindowPointerEnd, true);
  screen.addEventListener("contextmenu", onContextMenu);
  screen.addEventListener("touchend", onTouchEnd, { capture: true, passive: false });
  paneSurface?.addEventListener("touchstart", onPaneTouchStart, { capture: true, passive: true });
  paneSurface?.addEventListener("touchend", onPaneTouchEnd, { capture: true, passive: true });
  handles.hidden = true;

  const cancel = (): void => {
    stopEdgeScroll();
    handleDrag = null;
    lastHandlePoint = null;
    dragging = null;
    retainedSpan = null;
    active = false;
    screen.classList.remove("naru-touch-select");
    terminal.clearSelection();
    publish();
  };

  return {
    get active() {
      return active;
    },
    canLongPress: (clientX, clientY) =>
      screen.ownerDocument.activeElement !== terminal.textarea ||
      touchWordSpan(terminal, pointAt(clientX, clientY)) !== null,
    hasSelection: () => selectedSpan() !== null,
    enter: () => {
      active = true;
      dragging = null;
      retainedSpan = null;
      terminal.clearSelection();
      terminal.blur();
      screen.classList.add("naru-touch-select");
      publish();
    },
    begin: (clientX, clientY, longPress = false) => {
      if (!active) {
        active = true;
        terminal.blur();
        screen.classList.add("naru-touch-select");
      }
      const point = pointAt(clientX, clientY);
      const index = point.row * terminal.cols + point.column;
      dragging = (longPress ? touchWordSpan(terminal, point) : null) ?? {
        start: index,
        end: index + 1,
      };
      selectSpan(dragging);
    },
    move: (clientX, clientY) => {
      if (!dragging) return;
      selectSpan(touchSelectionSpan(dragging, pointAt(clientX, clientY), terminal.cols));
    },
    finish: () => {
      dragging = null;
      publish();
    },
    selectAll: () => {
      if (!active) return;
      terminal.selectAll();
      retainedSpan = currentSpan();
      publish();
    },
    getSelection: () => (active ? terminal.getSelection() : ""),
    cancel,
    dispose: () => {
      cancel();
      selectionChange.dispose();
      scrollChange.dispose();
      startHandle.removeEventListener("pointerdown", onHandlePointerDown);
      endHandle.removeEventListener("pointerdown", onHandlePointerDown);
      startHandle.removeEventListener("keydown", onHandleKeyDown);
      endHandle.removeEventListener("keydown", onHandleKeyDown);
      screen.ownerDocument.defaultView?.removeEventListener(
        "pointermove",
        onWindowPointerMove,
        true,
      );
      screen.ownerDocument.defaultView?.removeEventListener("pointerup", onWindowPointerEnd, true);
      screen.ownerDocument.defaultView?.removeEventListener(
        "pointercancel",
        onWindowPointerEnd,
        true,
      );
      screen.removeEventListener("contextmenu", onContextMenu);
      screen.removeEventListener("touchend", onTouchEnd, true);
      paneSurface?.removeEventListener("touchstart", onPaneTouchStart, true);
      paneSurface?.removeEventListener("touchend", onPaneTouchEnd, true);
      handles.remove();
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
