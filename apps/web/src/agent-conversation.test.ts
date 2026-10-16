import type { Instruction } from "@naru/contracts/naru-agent/v1";
import { describe, expect, it } from "vitest";
import { changeSummary, conversationBlocks, diffCounts, toolSummary } from "./agent-conversation";

const ME = "10000000-0000-4000-8000-000000000001";
const ORCHESTRATOR = "20000000-0000-4000-8000-000000000002";
const goal: Instruction = {
  id: "30000000-0000-4000-8000-000000000003",
  scope: { kind: "global" },
  author: { kind: "human" },
  channel: "naru-ui",
  originUserInstructionId: null,
  supersedesId: null,
  verbatim: "로그인을 passkey로 바꿔 줘.",
  forgottenAt: null,
  createdAt: "2026-10-16T01:40:00.000Z",
};
const delegation: Instruction = {
  ...goal,
  id: "40000000-0000-4000-8000-000000000004",
  scope: { kind: "agent", projectId: null, agentSessionId: ME },
  author: { kind: "agent", agentSessionId: ORCHESTRATOR },
  channel: "mcp",
  originUserInstructionId: goal.id,
  verbatim: "passkey 등록을 맡아 줘.",
  createdAt: "2026-10-16T01:42:00.000Z",
};
const direct: Instruction = {
  ...goal,
  id: "50000000-0000-4000-8000-000000000005",
  scope: { kind: "agent", projectId: null, agentSessionId: ME },
  verbatim: "비밀번호 로그인 화면도 지워 줘.",
  createdAt: "2026-10-16T02:46:00.000Z",
};
const context = { instructions: [delegation, direct], origins: [goal] };

describe("agent conversation", () => {
  it("turns a Naru wakeup into the request it carries and keeps the rest as one notice", () => {
    const wakeup = [
      "[Naru] New events since your last turn. Read details with the naru tools before acting;",
      "the latest user instruction wins over earlier plans.",
      `- #7 instruction.created subject=${delegation.id} actor=agent`,
      `- #8 task.updated subject=60000000-0000-4000-8000-000000000006 actor=agent status=running`,
    ].join("\n");
    const blocks = conversationBlocks(
      [{ type: "user", message: { role: "user", content: wakeup } }],
      context,
    );
    expect(blocks).toMatchObject([
      {
        kind: "request",
        source: { kind: "agent", agentSessionId: ORCHESTRATOR },
        text: "passkey 등록을 맡아 줘.",
        at: delegation.createdAt,
        origin: { id: goal.id },
      },
      { kind: "notice", text: "Naru 알림 · 작업 진행 중", details: ["작업 진행 중"] },
    ]);
  });

  it("reads Claude messages: requests by who said them, answers, thinking and grouped tools", () => {
    const blocks = conversationBlocks(
      [
        { type: "user", message: { content: [{ type: "text", text: direct.verbatim }] } },
        {
          type: "assistant",
          message: {
            content: [
              { type: "thinking", thinking: "구조부터 본다" },
              { type: "tool_use", id: "t1", name: "Read", input: { file_path: "src/a.ts" } },
              { type: "tool_use", id: "t2", name: "Grep", input: { pattern: "login" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "export {}" },
              { type: "tool_result", tool_use_id: "t2", content: "no match", is_error: true },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t3",
                name: "Edit",
                input: { file_path: "src/a.ts", old_string: "a\nb", new_string: "a\nb\nc" },
              },
              { type: "tool_use", id: "t4", name: "mcp__naru__report_progress", input: {} },
              { type: "text", text: "고쳤습니다." },
            ],
          },
        },
        // A native subagent's message belongs to its own transcript.
        {
          type: "assistant",
          parent_tool_use_id: "t9",
          message: { content: [{ type: "text", text: "x" }] },
        },
        { type: "user", message: { content: "<system-reminder>ignored</system-reminder>" } },
        { type: "user", message: { content: "알 수 없는 사람의 말" } },
      ],
      context,
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "request",
      "thinking",
      "tools",
      "answer",
      "request",
    ]);
    expect(blocks[0]).toMatchObject({
      source: { kind: "me", channel: "naru-ui" },
      at: direct.createdAt,
    });
    const tools = blocks[2];
    if (tools?.kind !== "tools") throw new Error("tools expected");
    expect(tools.calls.map((call) => [call.kind, call.title, call.failed])).toEqual([
      ["read", "src/a.ts", false],
      ["search", "login", true],
      ["edit", "src/a.ts", false],
      ["naru", "진행 보고", false],
    ]);
    expect(tools.calls[0]?.output).toBe("export {}");
    expect(toolSummary(tools.calls)).toBe(
      "파일 1개 읽음 · 검색 1번 · 파일 1개 수정 · Naru · 진행 보고",
    );
    expect(changeSummary(tools.calls)).toBe("+3 −2");
    expect(blocks[4]).toMatchObject({ source: { kind: "unknown" }, text: "알 수 없는 사람의 말" });
  });

  it("reads Codex turns with commands, file changes and read-only shell actions", () => {
    const blocks = conversationBlocks(
      [
        {
          id: "turn-1",
          startedAt: 1_760_580_000,
          status: "completed",
          items: [
            { type: "userMessage", content: [{ type: "text", text: "테스트 고쳐" }] },
            { type: "reasoning", summary: ["실패 원인 확인"] },
            {
              type: "commandExecution",
              id: "c1",
              command: "cat src/a.ts",
              commandActions: [{ type: "read", path: "src/a.ts" }],
              aggregatedOutput: "x",
              exitCode: 0,
              status: "completed",
            },
            {
              type: "commandExecution",
              id: "c2",
              command: "pnpm test",
              commandActions: [{ type: "unknown" }],
              exitCode: 1,
              durationMs: 4_000,
              status: "failed",
            },
            {
              type: "fileChange",
              id: "f1",
              status: "completed",
              changes: [
                { path: "src/a.ts", kind: { type: "update" }, diff: "--- a\n+++ b\n-x\n+y\n+z" },
              ],
            },
            { type: "agentMessage", text: "고쳤습니다." },
            { type: "contextCompaction", id: "k1" },
          ],
        },
      ],
      { instructions: [], origins: [] },
    );
    expect(blocks.map((block) => block.kind)).toEqual([
      "request",
      "thinking",
      "tools",
      "answer",
      "notice",
    ]);
    expect(blocks[0]).toMatchObject({
      source: { kind: "unknown" },
      at: "2025-10-16T02:00:00.000Z",
    });
    const tools = blocks[2];
    if (tools?.kind !== "tools") throw new Error("tools expected");
    expect(tools.calls.map((call) => [call.kind, call.title, call.failed])).toEqual([
      ["read", "src/a.ts", false],
      ["command", "pnpm test", true],
      ["edit", "src/a.ts", false],
    ]);
    expect(changeSummary(tools.calls)).toBe("+2 −1");
    expect(conversationBlocks([null, 3, "x", { items: "not a list" }], context)).toEqual([]);
  });

  it("counts diff lines without the file headers", () => {
    expect(diffCounts("--- a/x\n+++ b/x\n@@\n-old\n+new\n+more")).toEqual({ added: 2, removed: 1 });
    expect(diffCounts("")).toEqual({ added: null, removed: null });
  });
});
