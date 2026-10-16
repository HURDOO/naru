import type { AgentEvent, AgentSession, AgentTask, Handoff } from "@naru/contracts/naru-agent/v1";
import { describe, expect, it } from "vitest";
import {
  agentActivity,
  agentIdentity,
  ago,
  inboxItems,
  layoutGraph,
  presenceOf,
  taskState,
  taskWaitingFor,
  timelineRows,
} from "./agent-model";
import type { AgentBoard } from "./api";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function agent(n: number, patch: Partial<AgentSession> = {}): AgentSession {
  return {
    id: id(n),
    projectId: PROJECT,
    role: "worker",
    runtime: "claude",
    runtimeSessionRef: null,
    parentAgentSessionId: null,
    native: false,
    observation: "transcript",
    conversationWriter: "orchestrator",
    humanHoldSince: null,
    status: "idle",
    paneId: null,
    launchMode: "runner",
    createdAt: `2026-10-16T01:0${n}:00.000Z`,
    updatedAt: `2026-10-16T01:0${n}:00.000Z`,
    ...patch,
  };
}

function task(n: number, patch: Partial<AgentTask> = {}): AgentTask {
  return {
    id: id(100 + n),
    projectId: PROJECT,
    planId: null,
    title: `작업 ${n}`,
    purpose: "",
    completionCriteria: [],
    status: "pending",
    priority: 0,
    assigneeAgentSessionId: null,
    originInstructionId: id(999),
    intentContractId: null,
    dependsOn: [],
    revision: 1,
    createdAt: `2026-10-16T01:1${n}:00.000Z`,
    updatedAt: `2026-10-16T01:1${n}:00.000Z`,
    ...patch,
  };
}

function handoff(patch: Partial<Handoff>): Handoff {
  return {
    id: id(500),
    projectId: PROJECT,
    kind: "product-decision",
    status: "open",
    requestedBy: { kind: "agent", agentSessionId: id(2) },
    payload: {
      reason: "분리할까요?",
      blockingTaskIds: [],
      independentWorkToContinue: [],
      options: [],
      recommendation: "분리",
      risks: [],
      preparedEnvironment: [],
      resumeCondition: "결정",
    },
    resolution: null,
    createdAt: "2026-10-16T01:30:00.000Z",
    resolvedAt: null,
    ...patch,
  };
}

const name = (projectId: string | null) => (projectId === PROJECT ? "alpha" : "전체");

describe("agent view model", () => {
  it("names agents stably by role and creation order", () => {
    const orchestrator = agent(1, { role: "project-orchestrator" });
    const first = agent(2);
    const second = agent(3);
    const all = [second, orchestrator, first];
    expect(agentIdentity(orchestrator, all, name)).toMatchObject({
      name: "alpha 오케스트레이터",
      glyph: "◆",
    });
    expect(agentIdentity(first, all, name).name).toBe("작업자 1");
    expect(agentIdentity(second, all, name).name).toBe("작업자 2");
    expect(
      agentIdentity(agent(4, { role: "main-orchestrator", projectId: null }), all, name).name,
    ).toBe("메인 오케스트레이터");
  });

  it("puts approvals first, then decisions oldest first, then intent contracts", () => {
    const worker = agent(2, { paneId: id(900) });
    const board: AgentBoard = {
      projects: [
        {
          projectId: PROJECT,
          intentContract: null,
          pendingIntentContract: {
            id: id(600),
            projectId: PROJECT,
            version: 1,
            status: "proposed",
            body: {
              principles: ["passkey"],
              allowedChoices: [],
              requireApprovalIf: [],
              forbidden: [],
            },
            sourceInstructionId: id(999),
            approvedByHandoffId: null,
            createdAt: "2026-10-16T01:00:00.000Z",
          },
          activePlan: null,
          tasks: [],
          openHandoffs: [],
          agents: [worker],
          processes: [],
          pendingApprovals: [
            { agentSessionId: worker.id, requestId: "r1", kind: "command", summary: "pnpm test" },
          ],
        },
      ],
      globalAgents: [],
      openHandoffs: [
        handoff({ id: id(502), createdAt: "2026-10-16T01:40:00.000Z" }),
        handoff({ id: id(501), kind: "manual-test", createdAt: "2026-10-16T01:20:00.000Z" }),
      ],
      globalPendingApprovals: [],
    };
    const items = inboxItems(board);
    expect(items.map((item) => item.key)).toEqual([
      `approval:${worker.id}:r1`,
      `handoff:${id(501)}`,
      `handoff:${id(502)}`,
      `contract:${id(600)}`,
    ]);
    expect(presenceOf(worker, true)).toBe("waiting");
    expect(agentActivity(worker, "waiting", items, [])).toBe("명령 실행 승인 기다림 · pnpm test");
  });

  it("marks tasks that wait for the person and lays the graph out by dependency", () => {
    const worker = agent(2);
    const a = task(1, { status: "done" });
    const b = task(2, { status: "running", dependsOn: [a.id], assigneeAgentSessionId: worker.id });
    const c = task(3, { status: "pending", dependsOn: [a.id] });
    const d = task(4, { dependsOn: [b.id, c.id] });
    const project = {
      pendingApprovals: [{ agentSessionId: worker.id, requestId: "r", kind: "command" }],
    };
    expect(taskWaitingFor(b, project, [])).toBe("approval");
    expect(taskState(b, "approval")).toMatchObject({ key: "waiting", label: "나를 기다림 · 승인" });
    expect(
      taskWaitingFor(c, { pendingApprovals: [] }, [
        handoff({ payload: { ...handoff({}).payload, blockingTaskIds: [c.id] } }),
      ]),
    ).toBe("decision");

    const layout = layoutGraph([d, c, b, a], {
      nodeWidth: 100,
      nodeHeight: 50,
      columnGap: 20,
      rowGap: 10,
    });
    expect(layout.levels).toBe(3);
    const at = (taskId: string) => layout.nodes.find((node) => node.task.id === taskId);
    expect(at(a.id)).toMatchObject({ level: 0, x: 0 });
    expect(at(d.id)).toMatchObject({ level: 2, x: 240 });
    expect(layout.edges.map((edge) => [edge.key, edge.kind])).toEqual(
      expect.arrayContaining([
        [`${a.id}->${b.id}`, "active"],
        [`${a.id}->${c.id}`, "done"],
        [`${b.id}->${d.id}`, "wait"],
      ]),
    );
    expect(layout).toMatchObject({ width: 340, height: 110 });
  });

  it("builds who-worked-when from runtime turns, holds, questions and merges", () => {
    const worker = agent(2, { status: "active" });
    const held = agent(3, { humanHoldSince: "2026-10-16T01:50:00.000Z" });
    const assigned = task(1, {
      status: "running",
      assigneeAgentSessionId: worker.id,
      createdAt: "2026-10-16T01:00:00.000Z",
      updatedAt: "2026-10-16T01:00:00.000Z",
    });
    let seq = 0;
    const event = (
      type: AgentEvent["type"],
      at: string,
      subjectId: string,
      data: AgentEvent["data"] = {},
      actor: AgentEvent["actor"] = { kind: "system" },
    ): AgentEvent => ({
      seq: ++seq,
      id: id(700 + seq),
      type,
      projectId: PROJECT,
      actor,
      subjectId,
      correlationId: null,
      data,
      createdAt: at,
    });
    const events = [
      event("agent_session.updated", "2026-10-16T01:10:00.000Z", worker.id, { status: "active" }),
      event("agent_session.updated", "2026-10-16T01:20:00.000Z", worker.id, { status: "idle" }),
      event(
        "handoff.requested",
        "2026-10-16T01:25:00.000Z",
        id(500),
        {},
        {
          kind: "agent",
          agentSessionId: worker.id,
        },
      ),
      event("agent_session.updated", "2026-10-16T01:40:00.000Z", worker.id, { status: "active" }),
    ];
    const end = Date.parse("2026-10-16T02:00:00.000Z");
    const rows = timelineRows(events, [worker, held], [assigned], {
      start: end - 3_600_000,
      end,
    });
    const workerRow = rows.find((row) => row.agent.id === worker.id)!;
    expect(workerRow.segments).toEqual([
      {
        start: Date.parse("2026-10-16T01:10:00.000Z"),
        end: Date.parse("2026-10-16T01:20:00.000Z"),
        kind: "work",
        label: "작업 1",
      },
      { start: Date.parse("2026-10-16T01:40:00.000Z"), end, kind: "work", label: "작업 1" },
    ]);
    expect(workerRow.marks).toEqual([{ at: Date.parse("2026-10-16T01:25:00.000Z"), kind: "ask" }]);
    const heldRow = rows.find((row) => row.agent.id === held.id)!;
    expect(heldRow.segments).toEqual([
      { start: Date.parse("2026-10-16T01:50:00.000Z"), end, kind: "mine", label: "내가 직접" },
    ]);
  });

  it("says how long ago in a compact form", () => {
    const now = Date.parse("2026-10-16T02:00:00.000Z");
    expect(ago("2026-10-16T01:59:30.000Z", now)).toBe("방금");
    expect(ago("2026-10-16T01:48:00.000Z", now)).toBe("12분");
    expect(ago("2026-10-15T23:00:00.000Z", now)).toBe("3시간");
  });
});
