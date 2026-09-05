export type WorkspaceViewMode = "focus" | "multi";
export type WorkspaceViewportClass = "phone" | "adaptive" | "desktop";

export interface WorkspaceViewport {
  width: number;
  height: number;
}

export interface WorkspaceViewportStabilization {
  viewport: WorkspaceViewport;
  keyboardSession: WorkspaceViewport | null;
}

export const KEYBOARD_WIDTH_JITTER_PX = 8;
export const KEYBOARD_HEIGHT_DROP_PX = 80;

export function stabilizeWorkspaceViewport(
  current: WorkspaceViewport,
  next: WorkspaceViewport,
  textInputFocused: boolean,
  keyboardSession: WorkspaceViewport | null = null,
): WorkspaceViewportStabilization {
  const baseline = keyboardSession ?? current;
  const stableWidth = Math.abs(next.width - baseline.width) <= KEYBOARD_WIDTH_JITTER_PX;
  const keyboardHeight = next.height < baseline.height - KEYBOARD_HEIGHT_DROP_PX;

  if (keyboardSession && stableWidth && keyboardHeight) {
    return { viewport: baseline, keyboardSession: baseline };
  }
  if (textInputFocused && stableWidth && keyboardHeight) {
    return { viewport: baseline, keyboardSession: baseline };
  }
  return { viewport: next, keyboardSession: null };
}

export function classifyWorkspaceViewport({
  width,
  height,
}: WorkspaceViewport): WorkspaceViewportClass {
  if (width <= 600 || height <= 500) return "phone";
  if (width <= 1_100) return "adaptive";
  return "desktop";
}

export function defaultAdaptiveView({ width, height }: WorkspaceViewport): WorkspaceViewMode {
  return width >= 680 || width / height >= 0.8 ? "multi" : "focus";
}

export function usesOverlayProjectNavigation({ width }: WorkspaceViewport): boolean {
  return width <= 600;
}

export function usesHoverProjectNavigation(
  viewport: WorkspaceViewport,
  hoverCapable: boolean,
): boolean {
  return hoverCapable && !usesOverlayProjectNavigation(viewport);
}

export function resolveWorkspaceView(
  viewport: WorkspaceViewport,
  preference: WorkspaceViewMode | null,
): WorkspaceViewMode {
  const viewportClass = classifyWorkspaceViewport(viewport);
  if (viewportClass === "phone") return "focus";
  if (viewportClass === "desktop") return "multi";
  return preference ?? defaultAdaptiveView(viewport);
}
