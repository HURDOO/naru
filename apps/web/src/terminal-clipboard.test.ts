import { describe, expect, it, vi } from "vitest";
import { readTerminalClipboard } from "./terminal-clipboard";

describe("terminal clipboard", () => {
  it("reads text and the first image from rich clipboard items", async () => {
    const image = new Blob([Uint8Array.of(1, 2, 3)], { type: "image/png" });
    const text = new Blob(["paste me"], { type: "text/plain" });
    const item: ClipboardItem = {
      presentationStyle: "unspecified",
      types: ["text/plain", "image/png"],
      getType: (type: string) => Promise.resolve(type === "image/png" ? image : text),
    };
    const payload = await readTerminalClipboard({
      read: () => Promise.resolve([item]),
      readText: vi.fn(),
    });

    expect(payload).toEqual({ image, text: "paste me" });
  });

  it("falls back to plain text when rich clipboard reads are unavailable", async () => {
    await expect(
      readTerminalClipboard({ readText: () => Promise.resolve("plain clipboard text") }),
    ).resolves.toEqual({ image: null, text: "plain clipboard text" });
  });

  it("falls back to readable text when a rich clipboard read is denied", async () => {
    await expect(
      readTerminalClipboard({
        read: async () => Promise.reject(new DOMException("denied", "NotAllowedError")),
        readText: () => Promise.resolve("permitted text"),
      }),
    ).resolves.toEqual({ image: null, text: "permitted text" });
  });

  it("keeps a rich image when the plain-text fallback is unavailable", async () => {
    const image = new Blob([Uint8Array.of(1)], { type: "image/png" });
    const item: ClipboardItem = {
      presentationStyle: "unspecified",
      types: ["image/png"],
      getType: () => Promise.resolve(image),
    };

    await expect(
      readTerminalClipboard({
        read: () => Promise.resolve([item]),
        readText: () => Promise.reject(new DOMException("no text", "NotFoundError")),
      }),
    ).resolves.toEqual({ image, text: "" });
  });

  it("preserves a rich clipboard permission error when no fallback data is readable", async () => {
    const denied = new DOMException("denied", "NotAllowedError");

    await expect(
      readTerminalClipboard({
        read: async () => Promise.reject(denied),
        readText: () => Promise.resolve(""),
      }),
    ).rejects.toBe(denied);
  });
});
