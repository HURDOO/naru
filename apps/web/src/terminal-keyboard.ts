import { applyCtrlToTerminalData } from "./mobile-terminal-input";

export const CODEX_SHIFT_ENTER_SEQUENCE = "\u001b[13;2u";
const TERMINAL_FOCUS_IN_SEQUENCE = "\u001b[I";
const TERMINAL_FOCUS_OUT_SEQUENCE = "\u001b[O";

interface KeyGesture {
  readonly type: string;
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
}

export function shouldUseBrowserClipboard(
  event: Pick<KeyGesture, "key" | "ctrlKey" | "metaKey" | "altKey">,
  hasSelection: boolean,
): boolean {
  if (event.altKey || (!event.ctrlKey && !event.metaKey)) return false;
  const key = event.key.toLowerCase();
  return key === "v" || (key === "c" && hasSelection);
}

export function ctrlSequenceForKeyboardEvent(event: KeyGesture): string | null {
  if (event.type !== "keydown" || event.metaKey || event.altKey || event.key.length !== 1) {
    return null;
  }
  const sequence = applyCtrlToTerminalData(event.key);
  return sequence === event.key ? null : sequence;
}

export function codexShiftEnterSequence(event: KeyGesture): string | null {
  return event.type === "keydown" &&
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey
    ? CODEX_SHIFT_ENTER_SEQUENCE
    : null;
}

export function isTerminalFocusReport(data: string, focusReportingEnabled: boolean): boolean {
  return (
    focusReportingEnabled &&
    (data === TERMINAL_FOCUS_IN_SEQUENCE || data === TERMINAL_FOCUS_OUT_SEQUENCE)
  );
}
