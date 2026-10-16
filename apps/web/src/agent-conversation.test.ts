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

  it("shows the person's decisions on what this agent asked as their words (AP-D035)", () => {
    const asked = "70000000-0000-4000-8000-000000000007";
    const chose = "70000000-0000-4000-8000-000000000008";
    const contract = "80000000-0000-4000-8000-000000000008";
    const someoneElses = "70000000-0000-4000-8000-000000000009";
    const wakeup = [
      "[Naru] New events since your last turn. Read details with the naru tools before acting;",
      "the latest user instruction wins over earlier plans.",
      `- #9 intent_contract.approved subject=${contract} actor=human version=2`,
      `- #10 handoff.resolved subject=${asked} actor=human kind=product-decision chosenOption=설정 안`,
      `- #11 handoff.resolved subject=${chose} actor=human kind=product-decision chosenOption=새 메뉴`,
      `- #12 handoff.resolved subject=${someoneElses} actor=human kind=manual-test chosenOption=null`,
    ].join("\n");
    const decisions = [
      { kind: "contract", id: contract, version: 2, at: "2026-10-16T03:00:00.000Z" },
      {
        kind: "handoff",
        id: asked,
        question: "설정을 어디에 둘까요?",
        decision: "설정 안에 두고 이름은 보안으로",
        chosenOption: "설정 안",
        at: "2026-10-16T03:01:00.000Z",
      },
      {
        kind: "handoff",
        id: chose,
        question: "메뉴는?",
        decision: "새 메뉴",
        chosenOption: "새 메뉴",
        at: "2026-10-16T03:02:00.000Z",
      },
    ] as const;
    const turn = { type: "user", message: { role: "user", content: wakeup } };
    // A wakeup sent again does not repeat the person's words.
    const blocks = conversationBlocks([turn, turn], { ...context, decisions });
    expect(blocks).toMatchObject([
      {
        kind: "request",
        source: { kind: "me" },
        text: "이 계약으로 진행",
        at: "2026-10-16T03:00:00.000Z",
        answered: { kind: "contract", version: 2 },
      },
      {
        kind: "request",
        source: { kind: "me" },
        text: "설정 안에 두고 이름은 보안으로",
        answered: { kind: "question", question: "설정을 어디에 둘까요?", chosen: "설정 안" },
      },
      // Picking an option without more words: the option is what they said.
      { kind: "request", text: "새 메뉴", answered: { kind: "question", chosen: null } },
      // Another agent's question answered: only a notice here.
      { kind: "notice", details: ["사람 확인 완료"] },
      {
        kind: "notice",
        details: ["의도 계약 승인", "사람 확인 완료", "사람 확인 완료", "사람 확인 완료"],
      },
    ]);
    expect(blocks).toHaveLength(5);

    // The question the answer belongs to knows it was answered.
    const answeredQuestion = conversationBlocks(
      [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t1",
                name: "mcp__naru__request_human_handoff",
                input: { kind: "product-decision", reason: "설정을 어디에 둘까요?" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "t1", content: JSON.stringify({ id: asked }) },
            ],
          },
        },
        turn,
      ],
      { ...context, decisions },
    );
    expect(answeredQuestion[0]).toMatchObject({ kind: "ask", handoffId: asked, answered: true });
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
        {
          type: "user",
          message: {
            content:
              "설정 안에 둬.\n\n[Naru] Your question to the person is still open:\n- handoff x (product-decision): 어디에?\nIf the message above answers it, act on that answer and withdraw the question with cancel_handoff.",
          },
        },
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
    // Naru's open-question reminder rides on a person's turn but is not part of what they said.
    expect(blocks[4]).toMatchObject({ source: { kind: "unknown" }, text: "설정 안에 둬." });
    expect(blocks[5]).toMatchObject({ source: { kind: "unknown" }, text: "알 수 없는 사람의 말" });
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

  it("shows a question to the person in full, linked to the handoff Naru recorded", () => {
    const question = {
      kind: "product-decision",
      project_id: null,
      reason: "등록 화면을 어디에 둘까요?",
      blocking_task_ids: [],
      independent_work_to_continue: [],
      options: [
        { label: "설정 안에", description: "찾기 쉬움" },
        { label: "별도 페이지", description: "" },
      ],
      recommendation: "설정 안에",
      risks: [],
      prepared_environment: [],
      resume_condition: "결정",
    };
    const handoff = { id: "70000000-0000-4000-8000-000000000007", status: "open" };
    const claude = conversationBlocks(
      [
        {
          type: "assistant",
          message: {
            content: [
              { type: "tool_use", id: "t1", name: "mcp__naru__get_project_state", input: {} },
              {
                type: "tool_use",
                id: "t2",
                name: "mcp__naru__request_human_handoff",
                input: question,
              },
              { type: "tool_use", id: "t3", name: "Read", input: { file_path: "a.ts" } },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [{ type: "tool_result", tool_use_id: "t2", content: JSON.stringify(handoff) }],
          },
        },
      ],
      { instructions: [], origins: [] },
    );
    // The question breaks the gray tool rows and stands on its own.
    expect(claude.map((block) => block.kind)).toEqual(["tools", "ask", "tools"]);
    expect(claude[1]).toMatchObject({
      kind: "ask",
      handoffKind: "product-decision",
      reason: "등록 화면을 어디에 둘까요?",
      options: [
        { label: "설정 안에", description: "찾기 쉬움" },
        { label: "별도 페이지", description: "" },
      ],
      recommendation: "설정 안에",
      handoffId: handoff.id,
      failed: false,
    });

    const codex = conversationBlocks(
      [
        {
          id: "turn",
          items: [
            {
              type: "mcpToolCall",
              id: "m1",
              server: "naru",
              tool: "propose_design_change",
              arguments: question,
              status: "completed",
              result: { content: [{ type: "text", text: JSON.stringify({ result: handoff }) }] },
            },
          ],
        },
      ],
      { instructions: [], origins: [] },
    );
    expect(codex).toMatchObject([
      { kind: "ask", handoffKind: "design-deviation", handoffId: handoff.id },
    ]);

    // A runtime may shorten a long result; the id is still found.
    const shortened = conversationBlocks(
      [
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "t9",
                name: "mcp__naru__request_human_handoff",
                input: question,
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "t9",
                content: JSON.stringify({ ...handoff, payload: { reason: "x".repeat(400) } }).slice(
                  0,
                  120,
                ),
              },
            ],
          },
        },
      ],
      { instructions: [], origins: [] },
    );
    expect(shortened[0]).toMatchObject({ kind: "ask", handoffId: handoff.id });
  });

  it("counts diff lines without the file headers", () => {
    expect(diffCounts("--- a/x\n+++ b/x\n@@\n-old\n+new\n+more")).toEqual({ added: 2, removed: 1 });
    expect(diffCounts("")).toEqual({ added: null, removed: null });
  });
});
