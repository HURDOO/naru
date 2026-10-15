import type { AgentEvent } from "@naru/contracts/naru-agent/v1";
import { describe, expect, it } from "vitest";
import { agentEvents, mergeEvents } from "./agent-events";

const AGENT = "30000000-0000-4000-8000-000000000001";
const OTHER = "30000000-0000-4000-8000-000000000002";

function event(seq: number, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    seq,
    id: `40000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    type: "task.updated",
    projectId: null,
    actor: { kind: "system" },
    subjectId: "50000000-0000-4000-8000-000000000000",
    correlationId: null,
    data: {},
    createdAt: "2026-10-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("mergeEvents", () => {
  it("appends only newer events and keeps the newest within the cap", () => {
    const current = [event(1), event(2)];
    expect(mergeEvents(current, [event(2), event(3), event(4)], 3).map((item) => item.seq)).toEqual(
      [2, 3, 4],
    );
    expect(mergeEvents(current, [], 3)).toBe(current);
  });
});

describe("agentEvents", () => {
  it("keeps the agent's own actions and events about it", () => {
    const events = [
      event(1, { actor: { kind: "agent", agentSessionId: AGENT } }),
      event(2, { subjectId: AGENT, type: "agent_session.updated" }),
      event(3, { actor: { kind: "agent", agentSessionId: OTHER } }),
      event(4),
    ];
    expect(agentEvents(events, AGENT).map((item) => item.seq)).toEqual([1, 2]);
  });
});
