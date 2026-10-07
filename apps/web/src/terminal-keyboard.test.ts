import { describe, expect, it } from "vitest";
import {
  CODEX_SHIFT_ENTER_SEQUENCE,
  codexShiftEnterSequence,
  ctrlSequenceForKeyboardEvent,
  isTerminalFocusReport,
  isTerminalMouseReport,
  latchedModifierSequenceForKeyboardEvent,
  shouldUseBrowserClipboard,
} from "./terminal-keyboard";

const keydown = {
  type: "keydown",
  key: "c",
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
};

it("distinguishes negotiated mouse reports from typing and focus reports", () => {
  expect(isTerminalMouseReport("\u001b[<64;30;12M", "any")).toBe(true);
  expect(isTerminalMouseReport("\u001b[<0;30;12m", "drag")).toBe(true);
  expect(isTerminalMouseReport("\u001b[<64;30;12M", "none")).toBe(false);
  expect(isTerminalMouseReport("\u001b[I", "any")).toBe(false);
  expect(isTerminalMouseReport("hello", "any")).toBe(false);
});

describe("terminal keyboard boundary", () => {
  it("leaves paste and selected-copy shortcuts to the browser", () => {
    expect(shouldUseBrowserClipboard({ ...keydown, key: "v", ctrlKey: true }, false)).toBe(true);
    expect(shouldUseBrowserClipboard({ ...keydown, key: "V", metaKey: true }, false)).toBe(true);
    expect(shouldUseBrowserClipboard({ ...keydown, ctrlKey: true }, true)).toBe(true);
    expect(shouldUseBrowserClipboard({ ...keydown, ctrlKey: true }, false)).toBe(false);
  });

  it("encodes a latched mobile Ctrl key before xterm handles keydown", () => {
    expect(ctrlSequenceForKeyboardEvent(keydown)).toBe("\u0003");
    expect(ctrlSequenceForKeyboardEvent({ ...keydown, type: "keyup" })).toBeNull();
    expect(ctrlSequenceForKeyboardEvent({ ...keydown, key: "한" })).toBeNull();
  });

  it("encodes latched mobile Alt and Ctrl+Alt keys before xterm handles keydown", () => {
    expect(latchedModifierSequenceForKeyboardEvent(keydown, false, true)).toBe("\u001bc");
    expect(latchedModifierSequenceForKeyboardEvent(keydown, true, true)).toBe("\u001b\u0003");
    expect(
      latchedModifierSequenceForKeyboardEvent({ ...keydown, type: "keyup" }, false, true),
    ).toBeNull();
    expect(
      latchedModifierSequenceForKeyboardEvent({ ...keydown, altKey: true }, false, true),
    ).toBeNull();
  });

  it("encodes Codex Shift+Enter with the enhanced-key CSI-u sequence", () => {
    expect(codexShiftEnterSequence({ ...keydown, key: "Enter", shiftKey: true })).toBe(
      CODEX_SHIFT_ENTER_SEQUENCE,
    );
    expect(codexShiftEnterSequence({ ...keydown, key: "Enter" })).toBeNull();
  });

  it("distinguishes application focus reports from user input", () => {
    expect(isTerminalFocusReport("\u001b[I", true)).toBe(true);
    expect(isTerminalFocusReport("\u001b[O", true)).toBe(true);
    expect(isTerminalFocusReport("\u001b[I", false)).toBe(false);
    expect(isTerminalFocusReport("ordinary input", true)).toBe(false);
  });
});
