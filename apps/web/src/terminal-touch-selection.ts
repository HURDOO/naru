import type { Terminal } from "@xterm/xterm";
import { scrollTerminalAt } from "./terminal-scroll";

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

export type TerminalNativeCopyResult = "copied" | "empty" | "unavailable";

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
const touchCopyOwners = new WeakMap<Document, object>();

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
  onNativeCopy?: (result: TerminalNativeCopyResult) => void,
): TerminalTouchSelectionController {
  let active = false;
  let dragging: BufferSpan | null = null;
  let retainedSpan: BufferSpan | null = null;
  let retainedText = "";
  let restoringHighlight = false;
  let handleDrag: { pointerId: number; edge: "start" | "end"; span: BufferSpan } | null = null;
  let edgeScrollTimer: ReturnType<typeof setInterval> | null = null;
  let edgeScrollDirection = 0;
  let lastHandlePoint: { x: number; y: number } | null = null;
  let focusAfterPaneTouch = false;
  let pointerType = "mouse";
  let mouseDrag: { x: number; y: number; moved: boolean; down: MouseEvent } | null = null;
  let forwardingClick = false;
  const touchCopyToken = {};
  const ownerDocument = screen.ownerDocument;
  const paneSurface = screen.closest<HTMLElement>(".pane-surface");
  const handles = ownerDocument.createElement("div");
  handles.className = "terminal-selection-handles";
  const startHandle = ownerDocument.createElement("button");
  const endHandle = ownerDocument.createElement("button");
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

  const selectionText = (): string => {
    // A TUI may repaint these cells after selection; retain what the user actually selected.
    return active ? retainedText : "";
  };

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
    retainedText = terminal.getSelection();
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
    edgeScrollDirection = 0;
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

  const updateEdgeScroll = (clientX: number, clientY: number): void => {
    const bounds = screen.getBoundingClientRect();
    const edge =
      clientY < bounds.top + HANDLE_EDGE_PX ? -1 : clientY > bounds.bottom - HANDLE_EDGE_PX ? 1 : 0;
    if (edge !== edgeScrollDirection) {
      stopEdgeScroll();
      edgeScrollDirection = edge;
    }
    if (edgeScrollDirection !== 0 && edgeScrollTimer === null) {
      edgeScrollTimer = setInterval(() => {
        if (!lastHandlePoint) return;
        scrollTerminalAt(
          screen,
          terminal,
          edgeScrollDirection,
          lastHandlePoint.x,
          lastHandlePoint.y,
        );
        if (handleDrag) moveHandle(lastHandlePoint.x, lastHandlePoint.y);
        else if (mouseDrag && dragging) {
          selectSpan(
            touchSelectionSpan(
              dragging,
              pointAt(lastHandlePoint.x, lastHandlePoint.y),
              terminal.cols,
            ),
          );
        }
      }, 80);
    }
  };

  const onWindowPointerMove = (event: PointerEvent): void => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    if (event.cancelable) event.preventDefault();
    moveHandle(event.clientX, event.clientY);
    updateEdgeScroll(event.clientX, event.clientY);
  };

  const onWindowPointerEnd = (event: PointerEvent): void => {
    if (!handleDrag || event.pointerId !== handleDrag.pointerId) return;
    stopEdgeScroll();
    handleDrag = null;
    lastHandlePoint = null;
  };

  const ownsTouchCopy = (): boolean => touchCopyOwners.get(ownerDocument) === touchCopyToken;

  const claimTouchCopy = (): void => {
    touchCopyOwners.set(ownerDocument, touchCopyToken);
  };

  const clearRetainedSelection = (): void => {
    retainedSpan = null;
    retainedText = "";
    if (ownsTouchCopy()) touchCopyOwners.delete(ownerDocument);
  };

  const onContextMenu = (event: MouseEvent): void => {
    const longPressPending = screen.dataset.naruTouchLongPress === "pending";
    if (!longPressPending && (!active || selectedSpan() === null)) return;
    const target = event.target;
    if (!(target instanceof Element) || !screen.contains(target)) return;
    // xterm's selection is not a DOM range, so Android cannot reliably attach ActionMode to it.
    // The app-owned toolbar is deterministic and avoids focusing the terminal textarea/IME.
    event.preventDefault();
    event.stopPropagation();
  };
  const onMouseDown = (event: MouseEvent): void => {
    if (forwardingClick) return;
    const target = event.target;
    if (!(target instanceof Element) || !screen.contains(target)) return;
    if (target.closest(".terminal-selection-handle")) return;
    if (pointerType === "mouse") {
      if (event.button !== 0) return;
      // Alt retains application-owned mouse interactions; ordinary shell selection uses xterm.
      if (event.altKey) {
        if (active) cancelSelection();
        return;
      }
      if (!active && (!terminal.modes || terminal.modes.mouseTrackingMode === "none")) return;
      event.preventDefault();
      event.stopPropagation();
      // Defer the press until click vs drag is known. Replaying a click through xterm keeps
      // negotiated mouse encoding and the controller fence, without sending a drag to the TUI.
      mouseDrag = { x: event.clientX, y: event.clientY, moved: false, down: event };
      terminal.focus();
      return;
    }
    if (!active && screen.dataset.naruTouchLongPress !== "pending") return;
    // Android may emit a compatibility mousedown after the touch gesture. xterm focuses its
    // textarea from that event, which can reopen the IME after the app selection is complete.
    event.preventDefault();
    event.stopPropagation();
  };
  const onPointerDown = (event: PointerEvent): void => {
    pointerType = event.pointerType;
  };
  const onMouseMove = (event: MouseEvent): void => {
    if (!mouseDrag) return;
    event.preventDefault();
    event.stopPropagation();
    if (!mouseDrag.moved) {
      if (Math.hypot(event.clientX - mouseDrag.x, event.clientY - mouseDrag.y) <= 3) return;
      mouseDrag.moved = true;
      beginSelection(mouseDrag.x, mouseDrag.y, mouseDrag.down.detail >= 2);
      terminal.focus();
    }
    if (!dragging) return;
    lastHandlePoint = { x: event.clientX, y: event.clientY };
    selectSpan(touchSelectionSpan(dragging, pointAt(event.clientX, event.clientY), terminal.cols));
    updateEdgeScroll(event.clientX, event.clientY);
  };
  const finishMouse = (): void => {
    if (!mouseDrag) return;
    mouseDrag = null;
    dragging = null;
    lastHandlePoint = null;
    stopEdgeScroll();
  };
  const onMouseUp = (event: MouseEvent): void => {
    if (!mouseDrag || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const gesture = mouseDrag;
    finishMouse();
    if (!gesture.moved && screen.isConnected) {
      if (active) cancelSelection();
      forwardingClick = true;
      try {
        screen.dispatchEvent(new MouseEvent("mousedown", gesture.down));
        screen.dispatchEvent(new MouseEvent("mouseup", event));
      } finally {
        forwardingClick = false;
      }
    }
  };
  const onCopy = (event: ClipboardEvent): void => {
    if (!ownsTouchCopy() || !active || selectedSpan() === null) return;
    const target = event.target;
    if (
      target instanceof Element &&
      target !== terminal.textarea &&
      target.closest("input, textarea, [contenteditable]:not([contenteditable='false'])")
    ) {
      return;
    }
    const value = selectionText();
    if (!event.clipboardData) {
      onNativeCopy?.("unavailable");
      return;
    }
    event.clipboardData.setData("text/plain", value);
    event.preventDefault();
    event.stopPropagation();
    onNativeCopy?.(value ? "copied" : "empty");
  };
  const onPaneTouchStart = (event: TouchEvent): void => {
    if (!active || event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".terminal-selection-handle")) return;
    if (target.closest(".terminal-selection-action-menu")) return;
    // Screen gestures are resolved by the touch-scroll controller: a short tap dismisses the
    // selection, while a vertical drag scrolls without losing it. Pane chrome still dismisses
    // immediately so its controls remain responsive.
    if (screen.contains(target)) return;
    const shouldRestoreInput = !target.closest(
      "button, input, textarea, select, a, [role='button']",
    );
    cancelSelection();
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
    if (!active) {
      retainedSpan = currentSpan();
      retainedText = terminal.getSelection();
    } else if (retainedSpan && !currentSpan() && !restoringHighlight) {
      // Mouse-tracking hover and TUI mode changes can clear xterm's selection even
      // though Naru still owns it. Restore only the highlight, not the saved copy text:
      // these buffer cells may already contain a newer repaint.
      restoringHighlight = true;
      try {
        terminal.select(
          retainedSpan.start % terminal.cols,
          Math.floor(retainedSpan.start / terminal.cols),
          retainedSpan.end - retainedSpan.start,
        );
      } finally {
        restoringHighlight = false;
      }
    }
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
  paneSurface?.addEventListener("contextmenu", onContextMenu, true);
  paneSurface?.addEventListener("mousedown", onMouseDown, true);
  screen.addEventListener("pointerdown", onPointerDown, true);
  ownerDocument.defaultView?.addEventListener("mousemove", onMouseMove, true);
  ownerDocument.defaultView?.addEventListener("mouseup", onMouseUp, true);
  ownerDocument.defaultView?.addEventListener("blur", finishMouse);
  ownerDocument.addEventListener("copy", onCopy, true);
  paneSurface?.addEventListener("touchstart", onPaneTouchStart, { capture: true, passive: true });
  paneSurface?.addEventListener("touchend", onPaneTouchEnd, { capture: true, passive: true });
  handles.hidden = true;

  const cancelSelection = (): void => {
    stopEdgeScroll();
    mouseDrag = null;
    handleDrag = null;
    lastHandlePoint = null;
    dragging = null;
    active = false;
    screen.classList.remove("naru-touch-select");
    terminal.clearSelection();
    if (terminal.textarea) {
      terminal.textarea.value = "";
      terminal.textarea.setSelectionRange(0, 0);
    }
    clearRetainedSelection();
    publish();
  };

  const beginSelection = (clientX: number, clientY: number, longPress = false): void => {
    if (!active) {
      clearRetainedSelection();
      active = true;
      terminal.blur();
      screen.classList.add("naru-touch-select");
    }
    claimTouchCopy();
    const point = pointAt(clientX, clientY);
    const index = point.row * terminal.cols + point.column;
    dragging = (longPress ? touchWordSpan(terminal, point) : null) ?? {
      start: index,
      end: index + 1,
    };
    selectSpan(dragging);
  };

  return {
    get active() {
      return active;
    },
    canLongPress: () => true,
    hasSelection: () => selectedSpan() !== null,
    enter: () => {
      clearRetainedSelection();
      active = true;
      dragging = null;
      claimTouchCopy();
      terminal.clearSelection();
      terminal.blur();
      screen.classList.add("naru-touch-select");
      publish();
    },
    begin: beginSelection,
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
      claimTouchCopy();
      terminal.selectAll();
      retainedSpan = currentSpan();
      retainedText = terminal.getSelection();
      publish();
    },
    getSelection: () => (active ? selectionText() : ""),
    cancel: () => cancelSelection(),
    dispose: () => {
      cancelSelection();
      clearRetainedSelection();
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
      paneSurface?.removeEventListener("contextmenu", onContextMenu, true);
      paneSurface?.removeEventListener("mousedown", onMouseDown, true);
      screen.removeEventListener("pointerdown", onPointerDown, true);
      ownerDocument.defaultView?.removeEventListener("mousemove", onMouseMove, true);
      ownerDocument.defaultView?.removeEventListener("mouseup", onMouseUp, true);
      ownerDocument.defaultView?.removeEventListener("blur", finishMouse);
      ownerDocument.removeEventListener("copy", onCopy, true);
      paneSurface?.removeEventListener("touchstart", onPaneTouchStart, true);
      paneSurface?.removeEventListener("touchend", onPaneTouchEnd, true);
      handles.remove();
    },
  };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
