import { KEYBOARD_HEIGHT_DROP_PX, KEYBOARD_WIDTH_JITTER_PX } from "./workspace-view";

export interface TerminalDimensions {
  cols: number;
  rows: number;
}

export interface TerminalHostGeometry {
  width: number;
  height: number;
}

interface TerminalColumnAnchor extends TerminalHostGeometry {
  cols: number;
}

export interface TerminalResizeState {
  stable: TerminalColumnAnchor | null;
  keyboardSession: TerminalColumnAnchor | null;
}

export interface TerminalResizeObservation {
  host: TerminalHostGeometry;
  proposed: TerminalDimensions;
  textInputFocused: boolean;
}

export interface TerminalResizeResolution {
  dimensions: TerminalDimensions;
  state: TerminalResizeState;
  keyboardSession: boolean;
}

export interface ScheduledTerminalResize {
  refresh: boolean;
}

export interface TerminalResizeScheduler {
  request(refresh?: boolean): void;
  flush(): void;
  dispose(): void;
}

export const TERMINAL_RESIZE_SETTLE_MS = 40;

export function initialTerminalResizeState(
  host: TerminalHostGeometry,
  dimensions: TerminalDimensions,
): TerminalResizeState {
  return {
    stable: { ...host, cols: dimensions.cols },
    keyboardSession: null,
  };
}

export function resolveTerminalResize(
  state: TerminalResizeState,
  observation: TerminalResizeObservation,
): TerminalResizeResolution {
  const baseline = state.keyboardSession ?? state.stable;
  if (baseline !== null) {
    const stableWidth =
      Math.abs(observation.host.width - baseline.width) <= KEYBOARD_WIDTH_JITTER_PX;
    const keyboardHeight = observation.host.height < baseline.height - KEYBOARD_HEIGHT_DROP_PX;
    if (
      stableWidth &&
      keyboardHeight &&
      (state.keyboardSession !== null || observation.textInputFocused)
    ) {
      const keyboardSession = state.keyboardSession ?? baseline;
      return {
        dimensions: { cols: keyboardSession.cols, rows: observation.proposed.rows },
        state: { stable: state.stable, keyboardSession },
        keyboardSession: true,
      };
    }
  }

  return {
    dimensions: observation.proposed,
    state: {
      stable: { ...observation.host, cols: observation.proposed.cols },
      keyboardSession: null,
    },
    keyboardSession: false,
  };
}

export function createTerminalResizeScheduler(
  apply: (request: ScheduledTerminalResize) => void,
  settleMs = TERMINAL_RESIZE_SETTLE_MS,
): TerminalResizeScheduler {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  let pending: ScheduledTerminalResize | null = null;

  const flush = (): void => {
    if (timeout !== null) clearTimeout(timeout);
    timeout = null;
    const request = pending;
    pending = null;
    if (request) apply(request);
  };

  return {
    request: (refresh = false) => {
      pending = { refresh: (pending?.refresh ?? false) || refresh };
      if (timeout !== null) clearTimeout(timeout);
      timeout = setTimeout(flush, settleMs);
    },
    flush,
    dispose: () => {
      if (timeout !== null) clearTimeout(timeout);
      timeout = null;
      pending = null;
    },
  };
}
