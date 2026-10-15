import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "../src/agent-runtime/adapter.js";
import {
  approvalSummary,
  ClaudeRunner,
  type ClaudeRunnerPlan,
} from "../src/agent-runtime/claude/runner.js";
import type {
  ClaudeCanUseTool,
  ClaudeSdkMessage,
  ClaudeSdkPort,
} from "../src/agent-runtime/claude/sdk-port.js";

const PLAN: ClaudeRunnerPlan = {
  executable: "/fixture/claude",
  cwd: "/fixture/project",
  model: "claude-opus-5-5",
  resumeRef: null,
  nativeName: "naru-000000000001",
  settings: { hooks: {} },
  mcpServers: { naru: { command: "/fixture/node", args: [], env: {} } },
  instructions: "fixture role guidance",
  permissionMode: "default",
  environment: { HOME: "/fixture/home" },
};

/** Scripted SDK: one result per user message; markers in the text trigger approvals, children, failure. */
function fakeSdk(options: { crashAfterTurns?: number } = {}) {
  const calls: { options?: Record<string, unknown>; history?: unknown } = {};
  let interrupted = false;
  const port: ClaudeSdkPort = {
    query({ prompt, options: queryOptions }) {
      calls.options = queryOptions;
      const canUseTool = queryOptions.canUseTool as ClaudeCanUseTool;
      const sessionId = (queryOptions.resume as string | undefined) ?? "session-fixture-1";
      async function* run(): AsyncGenerator<ClaudeSdkMessage> {
        // Like the real SDK: a resumed conversation is named before any prompt, `init` after.
        if (queryOptions.resume !== undefined) {
          yield { type: "system", subtype: "commands_changed", session_id: sessionId };
        }
        let turns = 0;
        for await (const message of prompt) {
          if (turns === 0) yield { type: "system", subtype: "init", session_id: sessionId };
          const text = message.message.content;
          if (text.includes("CHILD")) {
            yield { type: "system", subtype: "task_started", task_id: "suggest", ambient: true };
            yield { type: "system", subtype: "task_started", task_id: "child-1" };
            yield {
              type: "system",
              subtype: "task_notification",
              task_id: "child-1",
              status: "completed",
            };
          }
          if (text.includes("APPROVE")) {
            const decision = await canUseTool(
              "Bash",
              { command: "fixture" },
              {
                signal: new AbortController().signal,
              },
            );
            yield { type: "assistant", decision: decision.behavior };
          }
          if (text.includes("SLOW")) await new Promise((resolve) => setTimeout(resolve, 30));
          turns += 1;
          if (options.crashAfterTurns !== undefined && turns > options.crashAfterTurns) {
            throw new Error("fixture crash");
          }
          yield text.includes("FAIL") || interrupted
            ? { type: "result", subtype: "error_during_execution", is_error: true }
            : { type: "result", subtype: "success", is_error: false };
          interrupted = false;
        }
      }
      const iterator = run();
      return Object.assign(iterator, {
        interrupt: () => {
          interrupted = true;
          return Promise.resolve(undefined);
        },
      });
    },
    getSessionMessages(sessionId, historyOptions) {
      calls.history = { sessionId, ...historyOptions };
      const offset = historyOptions.offset ?? 0;
      return Promise.resolve(
        offset === 0 ? Array.from({ length: 50 }, (_, index) => ({ index })) : [{ index: 50 }],
      );
    },
  };
  return { port, calls };
}

async function until(
  events: AgentRuntimeEvent[],
  predicate: (event: AgentRuntimeEvent) => boolean,
) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("event not observed");
}

describe("approvalSummary", () => {
  it("names the tool with its command or path, shortened", () => {
    expect(approvalSummary("Bash", { command: "pnpm test" })).toBe("Bash: pnpm test");
    expect(approvalSummary("Write", { file_path: "src/a.ts", content: "x" })).toBe(
      "Write: src/a.ts",
    );
    expect(approvalSummary("WebSearch", { query: "q" })).toBe("WebSearch");
    expect(approvalSummary("Bash", { command: "x".repeat(400) })).toHaveLength(300);
  });
});

describe("Claude SDK runner", () => {
  it("passes the Naru launch plan to the SDK and reports turns without transcript content", async () => {
    const { port, calls } = fakeSdk();
    const runner = new ClaudeRunner(port, PLAN);
    const events: AgentRuntimeEvent[] = [];
    runner.onEvent((event) => events.push(event));
    runner.start();
    runner.sendTurn("first CHILD");
    await until(events, (event) => event.type === "turn-ended");
    expect(calls.options).toMatchObject({
      pathToClaudeCodeExecutable: "/fixture/claude",
      cwd: "/fixture/project",
      model: "claude-opus-5-5",
      settingSources: ["project", "local"],
      strictMcpConfig: true,
      extraArgs: { name: "naru-000000000001" },
      forwardSubagentText: true,
    });
    expect(runner.runtimeSessionRef).toBe("session-fixture-1");
    // The turn starts when Naru hands over the input; the SDK reports the conversation after that.
    expect(events).toEqual([
      { type: "turn-started", turnId: null },
      { type: "conversation-ready", runtimeSessionRef: "session-fixture-1" },
      { type: "child-started", childRef: "child-1", parentRef: "session-fixture-1" },
      { type: "child-ended", childRef: "child-1" },
      { type: "turn-ended", turnId: null, outcome: "completed" },
    ]);
    expect(JSON.stringify(events)).not.toContain("first");
    await runner.stop();
    expect(events.at(-1)).toEqual({ type: "exited", reason: "stopped" });
  });

  it("confirms a resumed conversation before any turn (switching back from the TUI)", async () => {
    const { port } = fakeSdk();
    const runner = new ClaudeRunner(port, { ...PLAN, resumeRef: "session-resumed" });
    const events: AgentRuntimeEvent[] = [];
    runner.onEvent((event) => events.push(event));
    runner.start();
    await until(events, (event) => event.type === "conversation-ready");
    expect(events).toEqual([{ type: "conversation-ready", runtimeSessionRef: "session-resumed" }]);
    runner.sendTurn("first after resume");
    await until(events, (event) => event.type === "turn-ended");
    // `init` with the same conversation is not reported twice.
    expect(events.filter((event) => event.type === "conversation-ready")).toHaveLength(1);
    await runner.stop();
  });

  it("holds a tool call for a Naru approval and reports failures and interrupts honestly", async () => {
    const { port } = fakeSdk();
    const runner = new ClaudeRunner(port, { ...PLAN, resumeRef: "session-resumed" });
    const events: AgentRuntimeEvent[] = [];
    runner.onEvent((event) => events.push(event));
    runner.start();
    runner.sendTurn("APPROVE this");
    await until(events, (event) => event.type === "approval-requested");
    const request = events.find((event) => event.type === "approval-requested");
    // The person sees what is asked (AP-D017), shortened; nothing is stored.
    expect(request).toMatchObject({ kind: "command" });
    expect((request as { summary?: string }).summary).toMatch(/^Bash/u);
    expect(runner.busy).toBe(true);
    expect(runner.respondApproval((request as { requestId: string }).requestId, "approve")).toBe(
      true,
    );
    expect(runner.respondApproval((request as { requestId: string }).requestId, "approve")).toBe(
      false,
    );
    await until(events, (event) => event.type === "turn-ended");

    runner.sendTurn("this will FAIL");
    await until(events, (event) => event.type === "turn-ended" && event.outcome === "failed");
    runner.sendTurn("SLOW work");
    await runner.interrupt();
    await until(events, (event) => event.type === "turn-ended" && event.outcome === "interrupted");
    expect(runner.runtimeSessionRef).toBe("session-resumed");
    await runner.stop();
  });

  it("denies pending approvals on stop and never reports a crashed turn as completed", async () => {
    const { port } = fakeSdk({ crashAfterTurns: 0 });
    const runner = new ClaudeRunner(port, PLAN);
    const events: AgentRuntimeEvent[] = [];
    runner.onEvent((event) => events.push(event));
    runner.start();
    runner.sendTurn("crash now");
    await until(events, (event) => event.type === "exited");
    expect(events.filter((event) => event.type === "turn-ended")).toEqual([
      { type: "turn-ended", turnId: null, outcome: "interrupted" },
    ]);
    expect(events.at(-1)).toEqual({ type: "exited", reason: "crashed" });
    expect(() => runner.sendTurn("after exit")).toThrow(/stopped/);
  });

  it("pages history from the SDK instead of storing it", async () => {
    const { port, calls } = fakeSdk();
    const runner = new ClaudeRunner(port, PLAN);
    expect(await runner.readHistory(null)).toEqual({ items: [], nextCursor: null });
    const events: AgentRuntimeEvent[] = [];
    runner.onEvent((event) => events.push(event));
    runner.start();
    // A new conversation is named with the first prompt.
    runner.sendTurn("history");
    await until(events, (event) => event.type === "conversation-ready");
    const first = await runner.readHistory(null);
    expect(first.items).toHaveLength(50);
    expect(first.nextCursor).toBe("50");
    const second = await runner.readHistory(first.nextCursor);
    expect(second).toEqual({ items: [{ index: 50 }], nextCursor: null });
    expect(calls.history).toMatchObject({
      sessionId: "session-fixture-1",
      dir: "/fixture/project",
      offset: 50,
    });
    await expect(runner.readHistory("-1")).rejects.toThrow(/cursor/);
    await runner.stop();
  });
});
