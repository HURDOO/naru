import { describe, expect, it } from "vitest";
import { historyEntries } from "./agent-history";

describe("agent history entries", () => {
  it("reads Claude session messages and Codex turns without guessing unknown items", () => {
    const claude = [
      { type: "user", message: { role: "user", content: "결제 흐름을 끝내 줘" } },
      {
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "text", text: "시작합니다." },
            { type: "tool_use", name: "Bash", input: { command: "pnpm test" } },
          ],
        },
      },
      { type: "system", subtype: "init" },
    ];
    const codex = [
      {
        id: "turn-1",
        status: "completed",
        items: [
          { type: "userMessage", content: [{ type: "text", text: "테스트 고쳐" }] },
          { type: "reasoning", summary: [] },
          { type: "commandExecution", command: "pnpm test" },
          { type: "mcpToolCall", server: "naru", tool: "report_progress" },
          { type: "agentMessage", text: "고쳤습니다." },
        ],
      },
    ];
    expect(historyEntries(claude)).toEqual([
      { role: "user", text: "결제 흐름을 끝내 줘" },
      { role: "assistant", text: "시작합니다." },
      { role: "tool", text: "도구 사용: Bash" },
    ]);
    expect(historyEntries(codex)).toEqual([
      { role: "user", text: "테스트 고쳐" },
      { role: "tool", text: "명령 실행: pnpm test" },
      { role: "tool", text: "도구 사용: naru/report_progress" },
      { role: "assistant", text: "고쳤습니다." },
    ]);
    expect(historyEntries([null, 3, "x", { items: "not a list" }])).toEqual([]);
  });
});
