import { describe, expect, it } from "vitest";
import { applyCtrlToTerminalData, mobileTerminalKeySequence } from "./mobile-terminal-input";

describe("mobile terminal input", () => {
  it("encodes special and Ctrl+arrow keys", () => {
    expect(mobileTerminalKeySequence("escape", false)).toBe("\u001b");
    expect(mobileTerminalKeySequence("tab", false)).toBe("\t");
    expect(mobileTerminalKeySequence("enter", false)).toBe("\r");
    expect(mobileTerminalKeySequence("arrow-up", false)).toBe("\u001b[A");
    expect(mobileTerminalKeySequence("arrow-left", true)).toBe("\u001b[1;5D");
  });

  it("turns the next ASCII key into a Ctrl byte without corrupting composed text", () => {
    expect(applyCtrlToTerminalData("c")).toBe("\u0003");
    expect(applyCtrlToTerminalData("D")).toBe("\u0004");
    expect(applyCtrlToTerminalData("안녕하세요")).toBe("안녕하세요");
  });
});
