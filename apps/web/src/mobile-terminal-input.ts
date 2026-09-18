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

const arrowFinalBytes: Partial<Record<MobileTerminalKey, string>> = {
  "arrow-up": "A",
  "arrow-down": "B",
  "arrow-left": "D",
  "arrow-right": "C",
};

export function mobileTerminalKeySequence(
  key: MobileTerminalKey,
  ctrl: boolean,
  alt = false,
): string {
  const arrowFinalByte = arrowFinalBytes[key];
  if (arrowFinalByte !== undefined && (ctrl || alt)) {
    const modifier = 1 + (alt ? 2 : 0) + (ctrl ? 4 : 0);
    return `\u001b[1;${modifier}${arrowFinalByte}`;
  }
  const sequence = keySequences[key];
  return alt ? `\u001b${sequence}` : sequence;
}

export function applyCtrlToTerminalData(data: string): string {
  if (data.length !== 1) return data;
  const code = data.toUpperCase().charCodeAt(0);
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
}

export function applyMobileModifiersToTerminalData(
  data: string,
  ctrl: boolean,
  alt: boolean,
): string {
  const sequence = ctrl ? applyCtrlToTerminalData(data) : data;
  return alt ? `\u001b${sequence}` : sequence;
}
