export type MobileTerminalKey =
  "escape" | "tab" | "enter" | "arrow-up" | "arrow-down" | "arrow-left" | "arrow-right";

const keySequences: Record<MobileTerminalKey, string> = {
  escape: "\u001b",
  tab: "\t",
  enter: "\r",
  "arrow-up": "\u001b[A",
  "arrow-down": "\u001b[B",
  "arrow-left": "\u001b[D",
  "arrow-right": "\u001b[C",
};

const ctrlArrowSequences: Partial<Record<MobileTerminalKey, string>> = {
  "arrow-up": "\u001b[1;5A",
  "arrow-down": "\u001b[1;5B",
  "arrow-left": "\u001b[1;5D",
  "arrow-right": "\u001b[1;5C",
};

export function mobileTerminalKeySequence(key: MobileTerminalKey, ctrl: boolean): string {
  return ctrl ? (ctrlArrowSequences[key] ?? keySequences[key]) : keySequences[key];
}

export function applyCtrlToTerminalData(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}
