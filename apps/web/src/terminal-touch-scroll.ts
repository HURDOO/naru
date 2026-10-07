import type { TerminalTouchSelectionController } from "./terminal-touch-selection";
import { scrollTerminalAt } from "./terminal-scroll";

const TOUCH_SCROLL_ACTIVATION_PX = 8;
const TOUCH_SELECTION_HOLD_MS = 500;
const TOUCH_SELECTION_EDGE_PX = 22;
const TOUCH_SELECTION_EDGE_INTERVAL_MS = 80;

export interface TerminalTouchScrollGesture {
  pointerId: number;
  axis: "pending" | "horizontal" | "vertical";
  startX: number;
  startY: number;
  lastY: number;
  remainderPixels: number;
}

export interface TerminalTouchScrollUpdate {
  gesture: TerminalTouchScrollGesture;
  lines: number;
  scrolling: boolean;
}

export interface TerminalScrollbarTouchDrag {
  pointerId: number;
  startClientY: number;
  startViewportY: number;
  maximumViewportY: number;
  thumbTravelPixels: number;
}

interface ScrollableTerminal {
  rows: number;
  readonly modes?: { readonly mouseTrackingMode: string };
  buffer: {
    active: {
      readonly type?: "normal" | "alternate";
      readonly baseY: number;
      readonly viewportY: number;
    };
  };
  focus(): void;
  scrollLines(amount: number): void;
  scrollToLine(line: number): void;
}

export function beginTerminalTouchScroll(
  pointerId: number,
  clientX: number,
  clientY: number,
): TerminalTouchScrollGesture {
  return {
    pointerId,
    axis: "pending",
    startX: clientX,
    startY: clientY,
    lastY: clientY,
    remainderPixels: 0,
  };
}

export function updateTerminalTouchScroll(
  gesture: TerminalTouchScrollGesture,
  pointerId: number,
  clientX: number,
  clientY: number,
  lineHeight: number,
): TerminalTouchScrollUpdate {
  if (pointerId !== gesture.pointerId || gesture.axis === "horizontal") {
    return { gesture, lines: 0, scrolling: false };
  }

  let axis: "pending" | "vertical" = gesture.axis;
  if (axis === "pending") {
    const totalX = clientX - gesture.startX;
    const totalY = clientY - gesture.startY;
    if (Math.hypot(totalX, totalY) < TOUCH_SCROLL_ACTIVATION_PX) {
      return { gesture, lines: 0, scrolling: false };
    }
    if (Math.abs(totalY) <= Math.abs(totalX)) {
      return {
        gesture: { ...gesture, axis: "horizontal", lastY: clientY },
        lines: 0,
        scrolling: false,
      };
    }
    axis = "vertical";
  }

  const safeLineHeight = Math.max(lineHeight, 1);
  const pixelDelta = gesture.lastY - clientY + gesture.remainderPixels;
  const lines = Math.trunc(pixelDelta / safeLineHeight);
  return {
    gesture: {
      ...gesture,
      axis,
      lastY: clientY,
      remainderPixels: pixelDelta - lines * safeLineHeight,
    },
    lines,
    scrolling: true,
  };
}

export function beginTerminalScrollbarTouchDrag(
  pointerId: number,
  clientY: number,
  viewportY: number,
  maximumViewportY: number,
  trackHeight: number,
  thumbHeight: number,
): TerminalScrollbarTouchDrag {
  const safeMaximum = Math.max(0, Math.trunc(maximumViewportY));
  return {
    pointerId,
    startClientY: clientY,
    startViewportY: clamp(Math.round(viewportY), 0, safeMaximum),
    maximumViewportY: safeMaximum,
    thumbTravelPixels: Math.max(trackHeight - thumbHeight, 1),
  };
}

export function lineForTerminalScrollbarTouchDrag(
  drag: TerminalScrollbarTouchDrag,
  pointerId: number,
  clientY: number,
): number | null {
  if (pointerId !== drag.pointerId) return null;
  const lineDelta =
    ((clientY - drag.startClientY) * drag.maximumViewportY) / drag.thumbTravelPixels;
  return clamp(Math.round(drag.startViewportY + lineDelta), 0, drag.maximumViewportY);
}

export function attachTerminalTouchScroll(
  screen: HTMLElement,
  terminal: ScrollableTerminal,
  selection?: TerminalTouchSelectionController,
  focusInput: () => void = () => terminal.focus(),
): () => void {
  let gesture: TerminalTouchScrollGesture | null = null;
  let selecting = false;
  let cancelSelectionOnTap = false;
  let longPressTimer: ReturnType<typeof setTimeout> | null = null;
  let selectionEdgeTimer: ReturnType<typeof setInterval> | null = null;
  let selectionEdgeDirection = 0;
  let lastSelectionPoint: { x: number; y: number } | null = null;
  screen.classList.add("naru-touch-scroll");
  const detachScrollbarTouchDrag = attachTerminalScrollbarTouchDrag(screen, terminal);

  const clearLongPress = (): void => {
    if (longPressTimer !== null) clearTimeout(longPressTimer);
    longPressTimer = null;
    delete screen.dataset.naruTouchLongPress;
  };

  const clearSelectionEdgeScroll = (): void => {
    if (selectionEdgeTimer !== null) clearInterval(selectionEdgeTimer);
    selectionEdgeTimer = null;
    selectionEdgeDirection = 0;
    lastSelectionPoint = null;
  };

  const updateSelectionEdgeScroll = (clientX: number, clientY: number): void => {
    lastSelectionPoint = { x: clientX, y: clientY };
    const bounds = screen.getBoundingClientRect();
    const edge =
      clientY < bounds.top + TOUCH_SELECTION_EDGE_PX
        ? -1
        : clientY > bounds.bottom - TOUCH_SELECTION_EDGE_PX
          ? 1
          : 0;
    if (edge === selectionEdgeDirection) return;
    if (selectionEdgeTimer !== null) clearInterval(selectionEdgeTimer);
    selectionEdgeTimer = null;
    selectionEdgeDirection = edge;
    if (selectionEdgeDirection === 0) return;
    selectionEdgeTimer = setInterval(() => {
      if (lastSelectionPoint) {
        scrollTerminalAt(
          screen,
          terminal,
          selectionEdgeDirection,
          lastSelectionPoint.x,
          lastSelectionPoint.y,
        );
        selection?.move(lastSelectionPoint.x, lastSelectionPoint.y);
      }
    }, TOUCH_SELECTION_EDGE_INTERVAL_MS);
  };

  const releasePointer = (pointerId: number): void => {
    try {
      if (screen.hasPointerCapture(pointerId)) screen.releasePointerCapture(pointerId);
    } catch {
      // A browser gesture such as pinch zoom can cancel capture first.
    }
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (
      event.pointerType !== "touch" ||
      !event.isPrimary ||
      isTerminalScrollbarTarget(event.target)
    ) {
      return;
    }
    gesture = beginTerminalTouchScroll(event.pointerId, event.clientX, event.clientY);
    selecting = selection?.active ?? false;
    cancelSelectionOnTap = false;
    if (selecting) {
      if (selection?.hasSelection()) {
        selecting = false;
        cancelSelectionOnTap = true;
      } else {
        selection?.begin(event.clientX, event.clientY);
      }
    } else if (selection?.canLongPress(event.clientX, event.clientY)) {
      clearLongPress();
      screen.dataset.naruTouchLongPress = "pending";
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        delete screen.dataset.naruTouchLongPress;
        if (!gesture || gesture.pointerId !== event.pointerId || gesture.axis !== "pending") return;
        selecting = true;
        cancelSelectionOnTap = false;
        selection.begin(gesture.startX, gesture.startY, true);
      }, TOUCH_SELECTION_HOLD_MS);
    }
    try {
      screen.setPointerCapture(event.pointerId);
    } catch {
      // Synthetic events and canceled browser gestures may not have an active pointer to capture.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    if (selecting) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      selection?.move(event.clientX, event.clientY);
      updateSelectionEdgeScroll(event.clientX, event.clientY);
      return;
    }
    const lineHeight = screen.getBoundingClientRect().height / Math.max(terminal.rows, 1);
    const update = updateTerminalTouchScroll(
      gesture,
      event.pointerId,
      event.clientX,
      event.clientY,
      lineHeight,
    );
    gesture = update.gesture;
    if (gesture.axis !== "pending") clearLongPress();
    if (!update.scrolling) return;
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    if (update.lines !== 0) {
      scrollTerminalAt(screen, terminal, update.lines, event.clientX, event.clientY);
    }
  };

  const finishPointer = (event: PointerEvent, canceled: boolean): void => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    clearLongPress();
    clearSelectionEdgeScroll();
    const wasScrolling = gesture.axis === "vertical";
    const wasSelecting = selecting;
    const shouldCancelSelection = cancelSelectionOnTap && !wasScrolling && !canceled;
    releasePointer(event.pointerId);
    gesture = null;
    selecting = false;
    cancelSelectionOnTap = false;
    if (wasSelecting) {
      selection?.finish();
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (wasScrolling) {
      if (event.cancelable) event.preventDefault();
      event.stopPropagation();
    } else if (!canceled) {
      if (shouldCancelSelection) selection?.cancel();
      focusInput();
    }
  };

  const onPointerUp = (event: PointerEvent): void => finishPointer(event, false);
  const onPointerCancel = (event: PointerEvent): void => finishPointer(event, true);
  const onLostPointerCapture = (event: PointerEvent): void => {
    if (gesture?.pointerId === event.pointerId) {
      clearLongPress();
      clearSelectionEdgeScroll();
      if (selecting) selection?.finish();
      gesture = null;
      selecting = false;
      cancelSelectionOnTap = false;
    }
  };

  screen.addEventListener("pointerdown", onPointerDown);
  screen.addEventListener("pointermove", onPointerMove);
  screen.addEventListener("pointerup", onPointerUp);
  screen.addEventListener("pointercancel", onPointerCancel);
  screen.addEventListener("lostpointercapture", onLostPointerCapture);

  return () => {
    clearLongPress();
    clearSelectionEdgeScroll();
    detachScrollbarTouchDrag();
    if (gesture) releasePointer(gesture.pointerId);
    gesture = null;
    cancelSelectionOnTap = false;
    screen.classList.remove("naru-touch-scroll");
    screen.removeEventListener("pointerdown", onPointerDown);
    screen.removeEventListener("pointermove", onPointerMove);
    screen.removeEventListener("pointerup", onPointerUp);
    screen.removeEventListener("pointercancel", onPointerCancel);
    screen.removeEventListener("lostpointercapture", onLostPointerCapture);
  };
}

function attachTerminalScrollbarTouchDrag(
  screen: HTMLElement,
  terminal: ScrollableTerminal,
): () => void {
  const scrollableElement = screen.closest<HTMLElement>(".xterm-scrollable-element");
  const scrollbar = scrollableElement?.querySelector<HTMLElement>(":scope > .scrollbar.vertical");
  const thumb = scrollbar?.querySelector<HTMLElement>(":scope > .slider");
  const ownerWindow = screen.ownerDocument.defaultView;
  if (!scrollbar || !thumb || !ownerWindow) return () => undefined;

  let drag: TerminalScrollbarTouchDrag | null = null;
  let lastLine: number | null = null;
  scrollbar.dataset.naruTouchScrollbar = "true";

  const suppressTouchDrag = (event: PointerEvent): void => {
    if (event.cancelable) event.preventDefault();
    event.stopPropagation();
    event.stopImmediatePropagation();
  };

  const releasePointer = (pointerId: number): void => {
    try {
      if (thumb.hasPointerCapture(pointerId)) thumb.releasePointerCapture(pointerId);
    } catch {
      // The window listeners keep the drag bounded if browser capture was already canceled.
    }
  };

  const finishDrag = (event?: PointerEvent): void => {
    if (!drag || (event && event.pointerId !== drag.pointerId)) return;
    if (event) suppressTouchDrag(event);
    const pointerId = drag.pointerId;
    drag = null;
    lastLine = null;
    releasePointer(pointerId);
    thumb.classList.remove("active");
    delete scrollbar.dataset.naruTouchScrollbarDragging;
  };

  const onPointerDown = (event: PointerEvent): void => {
    if (event.pointerType !== "touch" || !event.isPrimary) return;

    const trackBounds = scrollbar.getBoundingClientRect();
    const thumbBounds = thumb.getBoundingClientRect();
    const maximumViewportY = terminal.buffer.active.baseY;
    let viewportY = terminal.buffer.active.viewportY;

    if (event.clientY < thumbBounds.top || event.clientY > thumbBounds.bottom) {
      const thumbTravelPixels = Math.max(trackBounds.height - thumbBounds.height, 1);
      const centeredThumbTop = event.clientY - trackBounds.top - thumbBounds.height / 2;
      viewportY = clamp(
        Math.round((centeredThumbTop / thumbTravelPixels) * maximumViewportY),
        0,
        maximumViewportY,
      );
      terminal.scrollToLine(viewportY);
    }

    drag = beginTerminalScrollbarTouchDrag(
      event.pointerId,
      event.clientY,
      viewportY,
      maximumViewportY,
      trackBounds.height,
      thumbBounds.height,
    );
    lastLine = viewportY;
    thumb.classList.add("active");
    scrollbar.dataset.naruTouchScrollbarDragging = "true";
    suppressTouchDrag(event);
    try {
      thumb.setPointerCapture(event.pointerId);
    } catch {
      // Samsung Internet can reject capture; window-level listeners keep the grab active.
    }
  };

  const onPointerMove = (event: PointerEvent): void => {
    if (!drag || event.pointerId !== drag.pointerId) return;
    suppressTouchDrag(event);
    const line = lineForTerminalScrollbarTouchDrag(drag, event.pointerId, event.clientY);
    if (line === null || line === lastLine) return;
    lastLine = line;
    terminal.scrollToLine(line);
  };

  const onPointerUp = (event: PointerEvent): void => finishDrag(event);
  const onPointerCancel = (event: PointerEvent): void => finishDrag(event);
  const onWindowBlur = (): void => finishDrag();

  scrollbar.addEventListener("pointerdown", onPointerDown, {
    capture: true,
    passive: false,
  });
  ownerWindow.addEventListener("pointermove", onPointerMove, {
    capture: true,
    passive: false,
  });
  ownerWindow.addEventListener("pointerup", onPointerUp, { capture: true });
  ownerWindow.addEventListener("pointercancel", onPointerCancel, { capture: true });
  ownerWindow.addEventListener("blur", onWindowBlur);

  return () => {
    finishDrag();
    delete scrollbar.dataset.naruTouchScrollbar;
    delete scrollbar.dataset.naruTouchScrollbarDragging;
    scrollbar.removeEventListener("pointerdown", onPointerDown, true);
    ownerWindow.removeEventListener("pointermove", onPointerMove, true);
    ownerWindow.removeEventListener("pointerup", onPointerUp, true);
    ownerWindow.removeEventListener("pointercancel", onPointerCancel, true);
    ownerWindow.removeEventListener("blur", onWindowBlur);
  };
}

function isTerminalScrollbarTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(".scrollbar") !== null;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
