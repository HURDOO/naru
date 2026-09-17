import type { Terminal } from "@xterm/xterm";

export interface TerminalTouchSelectionController {
  readonly active: boolean;
  canLongPress(clientX: number, clientY: number): boolean;
  hasSelection(): boolean;
  enter(): void;
  begin(clientX: number, clientY: number, longPress?: boolean): void;
  move(clientX: number, clientY: number): void;
  finish(clientX?: number, clientY?: number, forceNativeCopy?: boolean): void;
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

interface NativeTextareaState {
  readonly width: string;
  readonly height: string;
  readonly left: string;
  readonly top: string;
  readonly zIndex: string;
  readonly inputMode: string;
}

const WORD_CHARACTER = /[\p{L}\p{N}_]/u;
const HANDLE_EDGE_PX = 22;
const NATIVE_COPY_RETENTION_MS = 10_000;
const NATIVE_SELECTION_PLACEHOLDER = "\u00a0";
const nativeCopyOwners = new WeakMap<Document, object>();

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
  let handleDrag: { pointerId: number; edge: "start" | "end"; span: BufferSpan } | null = null;
  let edgeScrollTimer: ReturnType<typeof setInterval> | null = null;
  let lastHandlePoint: { x: number; y: number } | null = null;
  let focusAfterPaneTouch = false;
  let nativeCopyPrepared = false;
  let nativeCopyAnchor: { x: number; y: number } | null = null;
  let nativeTextareaState: NativeTextareaState | null = null;
  let nativeCopyRetentionTimer: ReturnType<typeof setTimeout> | null = null;
  const nativeCopyToken = {};
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
    const current = terminal.getSelection();
    if (current) {
      retainedText = current;
      return current;
    }
    if (retainedText) return retainedText;
    if (!active) return "";
    if (!retainedSpan) return "";
    selectSpan(retainedSpan);
    const restored = terminal.getSelection();
    if (restored) retainedText = restored;
    return restored;
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
    retainedText = terminal.getSelection() || retainedText;
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
    nativeCopyAnchor = { x: clientX, y: clientY };
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
    resetNativeCopyPreparation();
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
    if (!nativeCopyPrepared) prepareNativeCopy();
  };

  const ownsNativeCopy = (): boolean => nativeCopyOwners.get(ownerDocument) === nativeCopyToken;

  const claimNativeCopy = (): void => {
    nativeCopyOwners.set(ownerDocument, nativeCopyToken);
  };

  const clearNativeCopyRetention = (): void => {
    if (nativeCopyRetentionTimer !== null) clearTimeout(nativeCopyRetentionTimer);
    nativeCopyRetentionTimer = null;
  };

  const restoreNativeTextareaPosition = (): void => {
    const textarea = terminal.textarea;
    if (!textarea || nativeTextareaState === null) return;
    const { inputMode, ...style } = nativeTextareaState;
    if (ownerDocument.activeElement === textarea) textarea.blur();
    Object.assign(textarea.style, style);
    textarea.inputMode = inputMode;
    nativeTextareaState = null;
  };

  const releaseNativeCopy = (): void => {
    clearNativeCopyRetention();
    nativeCopyPrepared = false;
    nativeCopyAnchor = null;
    restoreNativeTextareaPosition();
    if (ownsNativeCopy()) nativeCopyOwners.delete(ownerDocument);
  };

  const clearRetainedSelection = (): void => {
    retainedSpan = null;
    retainedText = "";
    releaseNativeCopy();
  };

  const retainNativeCopyBriefly = (): void => {
    clearNativeCopyRetention();
    nativeCopyRetentionTimer = setTimeout(() => {
      if (active) return;
      clearRetainedSelection();
    }, NATIVE_COPY_RETENTION_MS);
  };

  const resetNativeCopyPreparation = (): void => {
    clearNativeCopyRetention();
    nativeCopyPrepared = false;
    claimNativeCopy();
  };

  const prepareNativeCopy = (clientX?: number, clientY?: number): void => {
    if (!active || selectedSpan() === null) return;
    const value = selectionText();
    const textarea = terminal.textarea;
    if (!textarea) return;
    const anchor =
      clientX === undefined || clientY === undefined
        ? nativeCopyAnchor
        : { x: clientX, y: clientY };
    if (anchor) {
      nativeCopyAnchor = anchor;
      if (nativeTextareaState === null) {
        nativeTextareaState = {
          width: textarea.style.width,
          height: textarea.style.height,
          left: textarea.style.left,
          top: textarea.style.top,
          zIndex: textarea.style.zIndex,
          inputMode: textarea.inputMode,
        };
      }
      const bounds = screen.getBoundingClientRect();
      textarea.style.width = "20px";
      textarea.style.height = "20px";
      textarea.style.left = `${anchor.x - bounds.left - 10}px`;
      textarea.style.top = `${anchor.y - bounds.top - 10}px`;
      textarea.style.zIndex = "1000";
    }
    const nativeSelection = value || NATIVE_SELECTION_PLACEHOLDER;
    // Keep the textarea editable so Android can open its native selection ActionMode, but ask
    // the IME not to appear when pointer-up focuses the hidden xterm input.
    textarea.inputMode = "none";
    textarea.value = nativeSelection;
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, nativeSelection.length);
    nativeCopyPrepared = true;
    claimNativeCopy();
  };
  const onContextMenu = (event: MouseEvent): void => {
    // xterm stores its selection outside the browser DOM. Mirror it into xterm's textarea and
    // leave the contextmenu default enabled so Android can show its native selection actions.
    if (!nativeCopyPrepared) prepareNativeCopy(event.clientX, event.clientY);
    if (nativeCopyPrepared) event.stopPropagation();
  };
  const onCopy = (event: ClipboardEvent): void => {
    if (!ownsNativeCopy() || (!active && !nativeCopyPrepared) || selectedSpan() === null) return;
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
    if (!active) clearRetainedSelection();
    else nativeCopyPrepared = false;
  };
  const onPaneTouchStart = (event: TouchEvent): void => {
    if (!active || event.touches.length !== 1) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest(".terminal-selection-handle")) return;
    // Screen gestures are resolved by the touch-scroll controller: a short tap dismisses the
    // selection, while a vertical drag scrolls without losing it. Pane chrome still dismisses
    // immediately so its controls remain responsive.
    if (screen.contains(target)) return;
    const shouldRestoreInput = !target.closest(
      "button, input, textarea, select, a, [role='button']",
    );
    cancelSelection(true);
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
    retainedText = terminal.getSelection() || retainedText;
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
  ownerDocument.addEventListener("copy", onCopy, true);
  paneSurface?.addEventListener("touchstart", onPaneTouchStart, { capture: true, passive: true });
  paneSurface?.addEventListener("touchend", onPaneTouchEnd, { capture: true, passive: true });
  handles.hidden = true;

  const cancelSelection = (preservePreparedCopy = false): void => {
    const preserveNativeCopy =
      preservePreparedCopy && nativeCopyPrepared && ownsNativeCopy() && retainedSpan !== null;
    stopEdgeScroll();
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
    if (preserveNativeCopy) retainNativeCopyBriefly();
    else clearRetainedSelection();
    publish();
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
      claimNativeCopy();
      terminal.clearSelection();
      terminal.blur();
      screen.classList.add("naru-touch-select");
      publish();
    },
    begin: (clientX, clientY, longPress = false) => {
      if (!active) {
        clearRetainedSelection();
        active = true;
        terminal.blur();
        screen.classList.add("naru-touch-select");
      }
      resetNativeCopyPreparation();
      nativeCopyAnchor = { x: clientX, y: clientY };
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
      nativeCopyAnchor = { x: clientX, y: clientY };
      selectSpan(touchSelectionSpan(dragging, pointAt(clientX, clientY), terminal.cols));
    },
    finish: (clientX, clientY, forceNativeCopy = false) => {
      dragging = null;
      if (clientX !== undefined && clientY !== undefined) {
        nativeCopyAnchor = { x: clientX, y: clientY };
      }
      publish();
      if (forceNativeCopy) nativeCopyPrepared = false;
      if (!nativeCopyPrepared) prepareNativeCopy();
    },
    selectAll: () => {
      if (!active) return;
      resetNativeCopyPreparation();
      terminal.selectAll();
      retainedSpan = currentSpan();
      retainedText = terminal.getSelection();
      publish();
    },
    getSelection: () => (active ? selectionText() : ""),
    cancel: () => cancelSelection(false),
    dispose: () => {
      cancelSelection(false);
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
      screen.removeEventListener("contextmenu", onContextMenu);
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
