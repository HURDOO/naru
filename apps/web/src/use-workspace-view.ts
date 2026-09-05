import { useCallback, useEffect, useRef, useState } from "react";
import {
  classifyWorkspaceViewport,
  resolveWorkspaceView,
  stabilizeWorkspaceViewport,
  usesHoverProjectNavigation,
  usesOverlayProjectNavigation,
  type WorkspaceViewMode,
  type WorkspaceViewport,
} from "./workspace-view";

const VIEW_MODE_KEY = "naru-workspace-view-mode";
const HOVER_QUERY = "(hover: hover) and (pointer: fine)";

interface WorkspaceViewController {
  canChoose: boolean;
  hoverProjectNavigation: boolean;
  mode: WorkspaceViewMode;
  overlayNavigation: boolean;
  setMode: (mode: WorkspaceViewMode) => void;
}

export function useWorkspaceView(): WorkspaceViewController {
  const [viewport, setViewport] = useState<WorkspaceViewport>(readLayoutViewport);
  const keyboardSessionRef = useRef<WorkspaceViewport | null>(null);
  const [preference, setPreference] = useState<WorkspaceViewMode | null>(readPreference);
  const [hoverCapable, setHoverCapable] = useState(readHoverCapability);

  useEffect(() => {
    let animationFrame = 0;
    const changed = (): void => {
      cancelAnimationFrame(animationFrame);
      animationFrame = requestAnimationFrame(() => {
        const next = readLayoutViewport();
        setViewport((current) => {
          const stabilized = stabilizeWorkspaceViewport(
            current,
            next,
            hasFocusedTextInput(),
            keyboardSessionRef.current,
          );
          keyboardSessionRef.current = stabilized.keyboardSession;
          return stabilized.viewport;
        });
      });
    };
    window.addEventListener("resize", changed);
    screen.orientation?.addEventListener("change", changed);
    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener("resize", changed);
      screen.orientation?.removeEventListener("change", changed);
    };
  }, []);

  useEffect(() => {
    const query = window.matchMedia(HOVER_QUERY);
    const changed = (): void => setHoverCapable(query.matches);
    query.addEventListener("change", changed);
    return () => query.removeEventListener("change", changed);
  }, []);

  const viewportClass = classifyWorkspaceViewport(viewport);
  const setMode = useCallback((mode: WorkspaceViewMode): void => {
    localStorage.setItem(VIEW_MODE_KEY, mode);
    setPreference(mode);
  }, []);

  return {
    canChoose: viewportClass === "adaptive",
    hoverProjectNavigation: usesHoverProjectNavigation(viewport, hoverCapable),
    mode: resolveWorkspaceView(viewport, preference),
    overlayNavigation: usesOverlayProjectNavigation(viewport),
    setMode,
  };
}

export function useVisualViewportVariables(): void {
  useEffect(() => {
    const root = document.documentElement;
    const viewport = window.visualViewport;
    const update = (): void => {
      const width = viewport?.width ?? window.innerWidth;
      const height = viewport?.height ?? window.innerHeight;
      root.style.setProperty("--naru-viewport-width", `${Math.max(1, Math.round(width))}px`);
      root.style.setProperty("--naru-viewport-height", `${Math.max(1, Math.round(height))}px`);
      root.style.setProperty(
        "--naru-viewport-left",
        `${Math.max(0, Math.round(viewport?.offsetLeft ?? 0))}px`,
      );
      root.style.setProperty(
        "--naru-viewport-top",
        `${Math.max(0, Math.round(viewport?.offsetTop ?? 0))}px`,
      );
    };

    update();
    window.addEventListener("resize", update);
    viewport?.addEventListener("resize", update);
    viewport?.addEventListener("scroll", update);
    return () => {
      window.removeEventListener("resize", update);
      viewport?.removeEventListener("resize", update);
      viewport?.removeEventListener("scroll", update);
      root.style.removeProperty("--naru-viewport-width");
      root.style.removeProperty("--naru-viewport-height");
      root.style.removeProperty("--naru-viewport-left");
      root.style.removeProperty("--naru-viewport-top");
    };
  }, []);
}

function readLayoutViewport(): WorkspaceViewport {
  return { width: window.innerWidth, height: window.innerHeight };
}

function hasFocusedTextInput(): boolean {
  const active = document.activeElement;
  if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
    return !active.disabled && !active.readOnly;
  }
  return active instanceof HTMLElement && active.isContentEditable;
}

function readPreference(): WorkspaceViewMode | null {
  const stored = localStorage.getItem(VIEW_MODE_KEY);
  return stored === "focus" || stored === "multi" ? stored : null;
}

function readHoverCapability(): boolean {
  return window.matchMedia(HOVER_QUERY).matches;
}
