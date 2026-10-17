import { describe, expect, it } from "vitest";
import { MAX_CHANNEL_LINE_BYTES } from "../src/agent-runtime/channel-protocol.js";
import {
  fitHistoryPage,
  HISTORY_LINE_BYTES,
  HISTORY_PAGE_BYTES,
  historyMessage,
} from "../src/agent-runtime/history-page.js";

const screenshot = (bytes: number) => ({
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "A".repeat(bytes) },
});

describe("history pages (AP-D040)", () => {
  it("leaves out a screenshot's bytes and keeps more of a tool's output than the conversation shows", () => {
    const output = "line\n".repeat(5_000);
    const [claude] = fitHistoryPage([
      {
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tool-1", content: [screenshot(2_000_000)] },
            { type: "tool_result", tool_use_id: "tool-2", content: output },
            {
              type: "tool_result",
              tool_use_id: "tool-3",
              content: [{ type: "text", text: output }],
            },
          ],
        },
      },
    ]);
    const content = (claude as { message: { content: Record<string, unknown>[] } }).message.content;
    expect(content[0]).toEqual({
      type: "tool_result",
      tool_use_id: "tool-1",
      content: [{ type: "image" }],
    });
    // The conversation shows 4,000 characters; the page keeps 8,000 and marks the cut.
    expect(content[1]!.content).toBe(`${output.slice(0, 8_000)}\n…`);
    expect(content[2]!.content).toEqual([{ type: "text", text: `${output.slice(0, 8_000)}\n…` }]);
  });

  it("keeps what a person or agent said, tool inputs and diffs whole", () => {
    const answer = "y".repeat(50_000);
    const write = { file_path: "src/a.ts", content: "z\n".repeat(20_000) };
    const diff = "+a\n".repeat(10_000);
    const items = [
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: answer },
            { type: "tool_use", id: "tool-1", name: "Write", input: write },
          ],
        },
      },
      {
        id: "turn-1",
        items: [
          { type: "fileChange", id: "c1", changes: [{ path: "src/a.ts", diff }] },
          { type: "commandExecution", id: "c2", aggregatedOutput: "o".repeat(20_000) },
          { type: "userMessage", id: "c3", content: [{ type: "image", url: "data:image/png;x" }] },
        ],
      },
    ];
    const [claude, codex] = fitHistoryPage(items);
    expect(claude).toEqual(items[0]);
    expect(codex).toEqual({
      id: "turn-1",
      items: [
        items[1]!.items![0],
        { type: "commandExecution", id: "c2", aggregatedOutput: `${"o".repeat(8_000)}\n…` },
        { type: "userMessage", id: "c3", content: [{ type: "image" }] },
      ],
    });
  });

  it("fits as many items as a page holds, at least one, and cuts one too big alone", () => {
    const answer = (bytes: number) => ({ type: "assistant", text: "x".repeat(bytes) });
    const fitted = fitHistoryPage(Array.from({ length: 10 }, () => answer(100_000)));
    expect(fitted).toHaveLength(5);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(HISTORY_PAGE_BYTES);

    const [alone] = fitHistoryPage([answer(HISTORY_PAGE_BYTES + 1), answer(10)]);
    expect(alone).toEqual({ type: "assistant", text: `${"x".repeat(1_000)}\n…` });
    expect(fitHistoryPage([])).toEqual([]);
  });

  it("answers with an error instead of a line the channel would refuse", () => {
    expect(HISTORY_LINE_BYTES).toBe(MAX_CHANNEL_LINE_BYTES);
    expect(historyMessage("request-1", [{ type: "user" }], "5")).toEqual({
      type: "history",
      requestId: "request-1",
      items: [{ type: "user" }],
      nextCursor: "5",
    });
    expect(
      historyMessage("request-1", [{ text: "x".repeat(MAX_CHANNEL_LINE_BYTES) }], null),
    ).toEqual({ type: "error", requestId: "request-1", code: "HISTORY_TOO_LARGE" });
  });
});
