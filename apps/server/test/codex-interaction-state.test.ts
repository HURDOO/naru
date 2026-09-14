import { describe, expect, it } from "vitest";
import { CodexInteractionState } from "../src/codex-interaction-state.js";
import type { CodexInteractionSnapshot } from "../src/integrations/codex/events.js";

const CWD = "/fixture/project";
const FIRST = "11111111-1111-4111-8111-111111111111";
const SECOND = "22222222-2222-4222-8222-222222222222";

function fixture() {
  const snapshots: CodexInteractionSnapshot[] = [];
  const state = new CodexInteractionState(CWD, (snapshot) => snapshots.push(snapshot));
  state.start();
  return { state, snapshots, latest: () => snapshots.at(-1)! };
}

function bind(state: CodexInteractionState, sessionId = FIRST, requestId = 1): void {
  state.observeClient({
    id: requestId,
    method: "thread/start",
    params: { ephemeral: false, threadSource: "user" },
  });
  state.observeServer({
    id: requestId,
    result: {
      thread: {
        id: sessionId,
        cwd: CWD,
        parentThreadId: null,
        ephemeral: false,
        status: { type: "idle" },
      },
    },
  });
}

// Matches the experimental 0.154.0 app-server Guardian notification envelope.
// Its reviewId identifies a review, not a JSON-RPC request awaiting the user.
function autoReview(status: "inProgress" | "approved" | "denied" | "timedOut" | "aborted"): {
  method: string;
  params: Record<string, unknown>;
} {
  const started = status === "inProgress";
  return {
    method: started ? "item/autoApprovalReview/started" : "item/autoApprovalReview/completed",
    params: {
      threadId: FIRST,
      turnId: "turn-1",
      reviewId: "review-1",
      targetItemId: "item-1",
      startedAtMs: 1,
      ...(started ? {} : { completedAtMs: 2, decisionSource: "agent" }),
      action: {
        type: "command",
        command: "fixture command is not retained",
        cwd: CWD,
        source: "shell",
      },
      review: { status },
    },
  };
}

describe("Codex interaction relay metadata state", () => {
  it.each(["approved", "denied", "timedOut", "aborted"] as const)(
    "keeps an automatic approval review running through %s without a user request",
    (status) => {
      const { state, latest, snapshots } = fixture();
      bind(state);
      state.observeServer({
        method: "turn/started",
        params: { threadId: FIRST, turn: { id: "turn-1" } },
      });
      const emittedBeforeReview = snapshots.length;
      state.observeServer(autoReview("inProgress"));
      state.observeServer({
        method: "autoApprovalReview/strictReviewRequired",
        params: { threadId: FIRST, turnId: "turn-1", startedAtMs: 1 },
      });
      expect(latest()).toMatchObject({ phase: "running", pending: [] });
      state.observeServer(autoReview(status));
      expect(latest()).toMatchObject({ phase: "running", pending: [] });
      expect(snapshots).toHaveLength(emittedBeforeReview);
      expect(JSON.stringify(snapshots)).not.toContain("fixture command");
    },
  );

  it("preserves other human requests across an auto-review and shows a later manual approval", () => {
    const { state, latest } = fixture();
    bind(state);
    state.observeServer({
      method: "turn/started",
      params: { threadId: FIRST, turn: { id: "turn-1" } },
    });
    for (const [id, method] of [
      ["question-1", "item/tool/requestUserInput"],
      ["mcp-1", "mcpServer/elicitation/request"],
      ["approval-1", "item/fileChange/requestApproval"],
    ] as const) {
      state.observeServer({
        id,
        method,
        params: { threadId: FIRST, turnId: "turn-1" },
      });
    }
    const pending = latest().pending;
    state.observeServer(autoReview("inProgress"));
    state.observeServer(autoReview("approved"));
    expect(latest().pending).toEqual(pending);
    state.observeServer({
      id: 71,
      method: "item/permissions/requestApproval",
      params: { threadId: FIRST, turnId: "turn-1" },
    });
    expect(latest().pending).toEqual([
      ...pending,
      { requestId: 71, turnId: "turn-1", kind: "permissions" },
    ]);
    state.observeServer({
      method: "serverRequest/resolved",
      params: { threadId: FIRST, requestId: 71 },
    });
    expect(latest()).toMatchObject({ phase: "running", pending });
  });

  it("clears approval on resolved, before a long command completes", () => {
    const { state, latest, snapshots } = fixture();
    bind(state);
    state.observeClient({ id: 2, method: "turn/start", params: { threadId: FIRST } });
    expect(latest().phase).toBe("running");
    state.observeServer({
      method: "turn/started",
      params: { threadId: FIRST, turn: { id: "turn-1" } },
    });
    state.observeServer({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: FIRST,
        turnId: "turn-1",
        command: "secret content is ignored",
      },
    });
    expect(latest().pending).toEqual([{ requestId: 7, turnId: "turn-1", kind: "command" }]);
    state.observeClient({ id: 7, result: { decision: "accept" } });
    expect(latest().pending).toHaveLength(1);
    state.observeServer({
      method: "serverRequest/resolved",
      params: { threadId: FIRST, requestId: 7 },
    });
    expect(latest().pending).toHaveLength(0);
    expect(latest().phase).toBe("running");
    state.observeServer({
      method: "item/completed",
      params: { threadId: FIRST, item: { id: "item-1" } },
    });
    expect(latest().phase).toBe("running");
    expect(JSON.stringify(snapshots)).not.toContain("secret content");
  });

  it("keeps independent async questions pending across turn completion", () => {
    const { state, latest } = fixture();
    bind(state);
    state.observeServer({
      method: "turn/started",
      params: { threadId: FIRST, turn: { id: "turn-1" } },
    });
    for (const [id, method] of [
      ["ask-1", "item/tool/requestUserInput"],
      ["ask-2", "item/tool/requestUserInput"],
      [3, "mcpServer/elicitation/request"],
    ] as const) {
      state.observeServer({
        id,
        method,
        params: { threadId: FIRST, turnId: "turn-1", isBlocking: false },
      });
    }
    state.observeServer({
      method: "turn/completed",
      params: {
        threadId: FIRST,
        turn: { id: "turn-1", status: "completed" },
      },
    });
    expect(latest().phase).toBe("completed");
    expect(latest().pending).toHaveLength(3);
    state.observeServer({
      method: "serverRequest/resolved",
      params: { threadId: FIRST, requestId: "ask-1" },
    });
    expect(latest().pending.map((item) => item.requestId)).toEqual(["ask-2", 3]);
    state.observeServer({
      method: "serverRequest/resolved",
      params: { threadId: FIRST, requestId: 3 },
    });
    expect(latest().pending.map((item) => item.requestId)).toEqual(["ask-2"]);
  });

  it("binds the latest selected thread and ignores delayed old-thread events", () => {
    const { state, latest } = fixture();
    bind(state);
    state.observeServer({
      id: "old",
      method: "item/tool/requestUserInput",
      params: { threadId: FIRST, turnId: "old-turn" },
    });
    state.observeClient({ id: 2, method: "thread/start", params: {} });
    state.observeClient({ id: 3, method: "thread/resume", params: { threadId: SECOND } });
    state.observeServer({
      id: 2,
      result: {
        thread: {
          id: FIRST,
          cwd: CWD,
          parentThreadId: null,
          status: { type: "idle" },
        },
      },
    });
    expect(latest().sessionId).toBe(FIRST);
    state.observeServer({
      id: 3,
      result: {
        thread: {
          id: SECOND,
          cwd: CWD,
          parentThreadId: null,
          status: { type: "idle" },
        },
      },
    });
    expect(latest().sessionId).toBe(SECOND);
    expect(latest().pending).toHaveLength(0);
    state.observeServer({
      id: "late",
      method: "item/permissions/requestApproval",
      params: { threadId: FIRST },
    });
    state.observeServer({
      method: "turn/completed",
      params: {
        threadId: FIRST,
        turn: { id: "old-turn", status: "completed" },
      },
    });
    expect(latest()).toMatchObject({ sessionId: SECOND, phase: "idle", pending: [] });
  });

  it("does not let a TUI ephemeral system thread erase a pending user approval", () => {
    const { state, latest } = fixture();
    bind(state);
    state.observeServer({
      id: 7,
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: FIRST,
        turnId: "turn-1",
      },
    });
    state.observeClient({
      id: 8,
      method: "thread/start",
      params: {
        ephemeral: true,
        threadSource: "system",
        cwd: CWD,
      },
    });
    state.observeServer({
      id: 8,
      result: {
        thread: {
          id: SECOND,
          cwd: CWD,
          parentThreadId: null,
          ephemeral: true,
          status: { type: "idle" },
        },
      },
    });
    state.observeServer({
      method: "turn/started",
      params: { threadId: SECOND, turn: { id: "title-turn" } },
    });
    state.observeServer({
      method: "turn/completed",
      params: {
        threadId: SECOND,
        turn: { id: "title-turn", status: "completed" },
      },
    });
    expect(latest()).toMatchObject({ sessionId: FIRST, pending: [{ requestId: 7 }] });
  });

  it("keeps primary resume correlation when a picker channel uses the same JSON-RPC id", () => {
    const { state, latest } = fixture();
    bind(state);
    state.observeClient({ id: 9, method: "thread/resume", params: { threadId: SECOND } }, 1);
    state.observeClient({ id: 9, method: "thread/list", params: {} }, 2);
    state.observeServer({ id: 9, result: { data: [] } }, 2);
    state.closeChannel(2);
    state.observeServer(
      {
        id: 9,
        result: {
          thread: {
            id: SECOND,
            cwd: CWD,
            parentThreadId: null,
            ephemeral: false,
            status: { type: "idle" },
          },
        },
      },
      1,
    );
    expect(latest()).toMatchObject({ sessionId: SECOND, identity: "bound", phase: "idle" });
  });

  it("does not let an old turn or a delayed start response undo a newer turn state", () => {
    const { state, latest } = fixture();
    bind(state);
    state.observeServer({
      method: "turn/completed",
      params: {
        threadId: FIRST,
        turn: { id: "old-turn", status: "completed" },
      },
    });
    state.observeClient({ id: 2, method: "turn/start", params: { threadId: FIRST } });
    state.observeServer({
      method: "turn/completed",
      params: {
        threadId: FIRST,
        turn: { id: "old-turn", status: "completed" },
      },
    });
    expect(latest().phase).toBe("running");
    state.observeServer({
      method: "turn/started",
      params: { threadId: FIRST, turn: { id: "new-turn" } },
    });
    state.observeServer({
      method: "turn/completed",
      params: {
        threadId: FIRST,
        turn: { id: "new-turn", status: "completed" },
      },
    });
    state.observeServer({ id: 2, result: { turn: { id: "new-turn" } } });
    expect(latest()).toMatchObject({ turnId: "new-turn", phase: "completed" });
  });

  it("fails closed when identity or request tracking exceeds bounds", () => {
    const { state } = fixture();
    state.observeClient({ id: 1, method: "thread/start", params: {} });
    expect(() =>
      state.observeServer({
        id: 1,
        result: {
          thread: {
            id: FIRST,
            cwd: "/different",
            parentThreadId: null,
          },
        },
      }),
    ).toThrow(/identity/);
  });
});
