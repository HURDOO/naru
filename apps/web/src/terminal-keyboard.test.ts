import { describe, expect, it } from "vitest";
import {
  CODEX_SHIFT_ENTER_SEQUENCE,
  codexShiftEnterSequence,
  ctrlSequenceForKeyboardEvent,
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

  it("encodes Codex Shift+Enter with the enhanced-key CSI-u sequence", () => {
    expect(codexShiftEnterSequence({ ...keydown, key: "Enter", shiftKey: true })).toBe(
      CODEX_SHIFT_ENTER_SEQUENCE,
    );
    expect(codexShiftEnterSequence({ ...keydown, key: "Enter" })).toBeNull();
  });
});
