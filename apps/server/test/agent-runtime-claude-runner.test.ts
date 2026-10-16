import { describe, expect, it } from "vitest";
import type { AgentRuntimeEvent } from "../src/agent-runtime/adapter.js";
import {
  approvalSummary,
  ClaudeRunner,
  type ClaudeRunnerPlan,
  resumableRef,
} from "../src/agent-runtime/claude/runner.js";
import type {
  ClaudeCanUseTool,
  ClaudePermissionResult,
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
  environment: { HOME: "/fixture/home" },
};

/** Scripted SDK: one result per user message; markers in the text trigger approvals, children, failure. */
function fakeSdk(options: { crashAfterTurns?: number } = {}) {
  const calls: {
    options?: Record<string, unknown>;
    history?: unknown;
    results: ClaudePermissionResult[];
  } = { results: [] };
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
                ...(text.includes("SESSION")
                  ? {
                      suggestions: [
                        {
                          type: "addRules",
                          rules: [{ toolName: "Bash", ruleContent: "fixture:*" }],
                          behavior: "allow",
                          destination: "localSettings",
                        },
                      ],
                    }
                  : {}),
              },
            );
            calls.results.push(decision);
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
      settingSources: ["user", "project", "local"],
      strictMcpConfig: true,
      extraArgs: { name: "naru-000000000001" },
      forwardSubagentText: true,
    });
    // No mode from Naru: Claude starts in the person's own mode (AP-D023).
    expect(calls.options).not.toHaveProperty("permissionMode");
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

  it("starts a new conversation when the one to resume was never saved", async () => {
    const saved = (count: number | Error): ClaudeSdkPort => ({
      query: () => {
        throw new Error("not used");
      },
      getSessionMessages: (sessionId, options) => {
        expect({ sessionId, ...options }).toEqual({ sessionId: "session-resumed", limit: 1 });
        return count instanceof Error
          ? Promise.reject(count)
          : Promise.resolve(Array.from({ length: count }, () => ({})));
      },
    });
    // An agent that never had a turn: Claude named the conversation but saved nothing.
    await expect(resumableRef(saved(0), "session-resumed")).resolves.toBeNull();
    await expect(resumableRef(saved(1), "session-resumed")).resolves.toBe("session-resumed");
    // A failed read is no evidence that nothing was saved.
    await expect(resumableRef(saved(new Error("fixture")), "session-resumed")).resolves.toBe(
      "session-resumed",
    );
    await expect(resumableRef(saved(0), null)).resolves.toBeNull();
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

  it("allows the rest of the session only with the SDK's own proposal, scoped to the session", async () => {
    const { port, calls } = fakeSdk();
    const runner = new ClaudeRunner(port, PLAN);
    const events: AgentRuntimeEvent[] = [];
    runner.onEvent((event) => events.push(event));
    runner.start();
    runner.sendTurn("APPROVE SESSION");
    await until(events, (event) => event.type === "approval-requested");
    const offered = events.find((event) => event.type === "approval-requested");
    expect(offered).toMatchObject({ sessionAllow: true });
    runner.respondApproval((offered as { requestId: string }).requestId, "approve-session");
    await until(events, (event) => event.type === "turn-ended");
    // The rule the SDK proposed, but never written to the person's settings files.
    expect(calls.results.at(-1)).toEqual({
      behavior: "allow",
      updatedPermissions: [
        {
          type: "addRules",
          rules: [{ toolName: "Bash", ruleContent: "fixture:*" }],
          behavior: "allow",
          destination: "session",
        },
      ],
    });

    // Without a proposal there is nothing to extend: a plain approval.
    runner.sendTurn("APPROVE once");
    await until(
      events,
      (event) =>
        event.type === "approval-requested" &&
        (event as { requestId: string }).requestId !== (offered as { requestId: string }).requestId,
    );
    const plain = events.filter((event) => event.type === "approval-requested").at(-1);
    expect(plain).not.toHaveProperty("sessionAllow");
    runner.respondApproval((plain as { requestId: string }).requestId, "approve-session");
    await until(events, (event) => event.type === "turn-ended" && calls.results.length === 2);
    expect(calls.results.at(-1)).toEqual({ behavior: "allow" });
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
