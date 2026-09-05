import { access, readFile, stat } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  decodeClipboardImageChunk,
  MacClipboardImageWriter,
  validateClipboardPng,
} from "../src/clipboard-image.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

describe("clipboard image bridge", () => {
  it("accepts bounded PNG input and rejects malformed or oversized dimensions", () => {
    expect(validateClipboardPng(onePixelPng)).toEqual({ width: 1, height: 1 });
    expect(() => validateClipboardPng(Uint8Array.from([1, 2, 3]))).toThrow(/PNG/);

    const tooWide = Buffer.from(onePixelPng);
    tooWide.writeUInt32BE(8193, 16);
    expect(() => validateClipboardPng(tooWide)).toThrow(/8192px/);
  });

  it("strictly decodes canonical base64 chunks", () => {
    expect(decodeClipboardImageChunk("YWJj")).toEqual(Buffer.from("abc"));
    expect(() => decodeClipboardImageChunk("not base64")).toThrow(/base64/);
    expect(() => decodeClipboardImageChunk("YR==")).toThrow(/base64/);
  });

  it("uses structured osascript arguments and removes the temporary image", async () => {
    let temporaryPath = "";
    const runner = vi.fn(async (executable: string, args: readonly string[]) => {
      expect(executable).toBe("/test/osascript");
      expect(args).toContain("set the clipboard to (read imageFile as «class PNGf»)");
      expect(args.at(-2)).toBe("--");
      temporaryPath = args.at(-1) ?? "";
      expect(await readFile(temporaryPath)).toEqual(onePixelPng);
      expect((await stat(temporaryPath)).mode & 0o777).toBe(0o600);
    });
    const writer = new MacClipboardImageWriter("/test/osascript", runner);

    await writer.writePng(onePixelPng);

    expect(runner).toHaveBeenCalledOnce();
    await expect(access(temporaryPath)).rejects.toThrow();
  });

  it("removes the temporary image when the clipboard command fails", async () => {
    let temporaryPath = "";
    const writer = new MacClipboardImageWriter("/test/osascript", (_executable, args) => {
      temporaryPath = args.at(-1) ?? "";
      return Promise.reject(new Error("fixture failure"));
    });

    await expect(writer.writePng(onePixelPng)).rejects.toThrow("fixture failure");
    await expect(access(temporaryPath)).rejects.toThrow();
  });
});
