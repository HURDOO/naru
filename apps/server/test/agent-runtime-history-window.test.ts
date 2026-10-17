import { afterEach, describe, expect, it } from "vitest";
import type { Actor } from "@naru/contracts/naru-agent/v1";
import { AgentPlatformCore } from "../src/agent-platform/core.js";
import type { NaruMessage, RunnerMessage } from "../src/agent-runtime/channel-protocol.js";
import {
  fitHistoryTail,
  historyBefore,
  parseHistoryCursor,
} from "../src/agent-runtime/history-window.js";
import type { RunnerConnection } from "../src/agent-runtime/runtime-channel-server.js";
import { ManagedAgentSupervisor, SupervisorError } from "../src/agent-runtime/supervisor.js";
import { NaruRepository } from "../src/database.js";

const HUMAN: Actor = { kind: "human" };
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

describe("history read newest first (AP-D045)", () => {
  it("reads cursors forward, from the newest page and before a page", () => {
    expect(parseHistoryCursor(null)).toEqual({ kind: "forward", offset: 0 });
    expect(parseHistoryCursor("70")).toEqual({ kind: "forward", offset: 70 });
    expect(parseHistoryCursor("latest")).toEqual({ kind: "latest" });
    expect(parseHistoryCursor(historyBefore("70"))).toEqual({ kind: "before", offset: 70 });
    for (const bad of ["-1", "1.5", "before:", "before:x", "x"]) {
      expect(() => parseHistoryCursor(bad)).toThrow(/cursor/);
    }
  });

  it("keeps the newest items that fit a page, at least one", () => {
    const long = (index: number) => ({ index, text: "x".repeat(200 * 1024) });
    const items = [0, 1, 2, 3].map(long);
    expect(fitHistoryTail(items)).toEqual([long(2), long(3)]);
    expect(fitHistoryTail([{ index: 0 }, { index: 1 }])).toEqual([{ index: 0 }, { index: 1 }]);
    expect(fitHistoryTail([])).toEqual([]);
  });

  it("maps the runner's newest-first pages and falls back to reading forward", async () => {
    const f = fixture();
    // A Claude runner of this Naru answers newest-first cursors with the page's start.
    const claude = f.connect("claude", (cursor) =>
      cursor === "latest"
        ? { items: ["c", "d"], nextCursor: "70" }
        : cursor === "before:70"
          ? { items: ["a", "b"], nextCursor: "0" }
          : { items: ["a"], nextCursor: "50" },
    );
    expect(await f.supervisor.readHistoryWindow(claude, { kind: "latest" })).toEqual({
      items: ["c", "d"],
      cursor: "70",
      nextCursor: null,
      previousCursor: "70",
    });
    expect(await f.supervisor.readHistoryWindow(claude, { kind: "before", cursor: "70" })).toEqual({
      items: ["a", "b"],
      cursor: "0",
      nextCursor: null,
      previousCursor: null,
    });
    expect(await f.supervisor.readHistoryWindow(claude, { kind: "forward", cursor: "70" })).toEqual(
      { items: ["a"], cursor: "70", nextCursor: "50", previousCursor: null },
    );

    // A runner an earlier Naru started refuses the cursor: its first page comes, read forward.
    const older = f.connect("claude", (cursor) =>
      cursor === null || /^\d+$/u.test(cursor) ? { items: ["first"], nextCursor: "50" } : null,
    );
    expect(await f.supervisor.readHistoryWindow(older, { kind: "latest" })).toEqual({
      items: ["first"],
      cursor: null,
      nextCursor: "50",
      previousCursor: null,
    });
    expect(f.cursors(older)).toEqual(["latest", null]);

    // Codex reads forward only; nothing is asked of it that it cannot answer.
    const codex = f.connect("codex", () => ({ items: ["turn"], nextCursor: null }));
    expect(await f.supervisor.readHistoryWindow(codex, { kind: "latest" })).toEqual({
      items: ["turn"],
      cursor: null,
      nextCursor: null,
      previousCursor: null,
    });
    await expect(
      f.supervisor.readHistoryWindow(codex, { kind: "before", cursor: "70" }),
    ).rejects.toBeInstanceOf(SupervisorError);
    expect(f.cursors(codex)).toEqual([null]);
  });
});

/** A supervisor with runners whose history replies come from `answer`; null is a refusal. */
function fixture() {
  const repository = new NaruRepository(":memory:");
  cleanups.push(() => repository.close());
  const project = repository.createProject("/tmp/naru-history-window", "blog");
  const core = new AgentPlatformCore(repository.agentPlatform);
  const supervisor = new ManagedAgentSupervisor({
    core,
    launcher: { launch: () => Promise.resolve(), stop: () => Promise.resolve() },
    channelSocketPath: "/nonexistent/agent-runtime.sock",
    planFor: () => {
      throw new Error("unused");
    },
  });
  cleanups.push(() => supervisor.close());
  const sent = new Map<string, NaruMessage[]>();
  let ordinal = 0;
  const connect = (
    runtime: "claude" | "codex",
    answer: (cursor: string | null) => { items: unknown[]; nextCursor: string | null } | null,
  ): string => {
    const agentSessionId = core.registerAgentSession(
      {
        actor: HUMAN,
        idempotencyKey: `72000000-0000-4000-8000-${String(++ordinal).padStart(12, "0")}`,
      },
      {
        projectId: project.id,
        role: "worker",
        runtime,
        native: false,
        observation: "transcript",
        conversationWriter: "orchestrator",
      },
    ).id;
    const messages: NaruMessage[] = [];
    sent.set(agentSessionId, messages);
    const connection: RunnerConnection = {
      agentSessionId,
      send: (message) => {
        messages.push(message);
        if (message.type !== "history") return;
        const page = answer(message.cursor);
        const reply: RunnerMessage =
          page === null
            ? { type: "error", requestId: message.requestId, code: "HISTORY_FAILED" }
            : { type: "history", requestId: message.requestId, ...page };
        queueMicrotask(() => supervisor.message(connection, reply));
      },
      close: () => undefined,
    };
    supervisor.connected(connection, {
      type: "hello",
      version: 1,
      token: "t".repeat(43),
      started: true,
      runtimeSessionRef: `session-${ordinal}`,
      busy: false,
      pendingApprovals: [],
    });
    return agentSessionId;
  };
  const cursors = (agentSessionId: string) =>
    (sent.get(agentSessionId) ?? []).flatMap((message) =>
      message.type === "history" ? [message.cursor] : [],
    );
  return { supervisor, connect, cursors };
}
