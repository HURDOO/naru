import { describe, expect, it } from "vitest";
import { TerminalMouseEncoding } from "./terminal-mouse-encoding.js";

describe("TerminalMouseEncoding", () => {
  it("serializes SGR and pixel mouse modes independently of the screen contents", () => {
    const encoding = new TerminalMouseEncoding();
    expect(encoding.serialize()).toBe("\u001b[?1006;1016l");
    encoding.set([1003, 1006], true);
    expect(encoding.serialize()).toBe("\u001b[?1006;1016l\u001b[?1006h");
    encoding.set([1016], true);
    expect(encoding.serialize()).toBe("\u001b[?1006;1016l\u001b[?1016h");
    encoding.set([1016], false);
    expect(encoding.serialize()).toBe("\u001b[?1006;1016l");
    encoding.set([1006], true);
    encoding.reset();
    expect(encoding.serialize()).toBe("\u001b[?1006;1016l");
  });
});
