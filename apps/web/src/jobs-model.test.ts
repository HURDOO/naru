import type { AgentTask, Instruction, Run } from "@naru/contracts/naru-agent/v1";
import { describe, expect, it } from "vitest";
import type { AgentJob, AgentJobTask, AgentWorking } from "./api";
import {
  activityLine,
  elapsedLabel,
  jobFinishedAt,
  jobProgress,
  jobStage,
  orderedTasks,
  stageStates,
  stallAge,
  taskNow,
  taskStep,
  taskTrack,
} from "./jobs-model";

const PROJECT = "a0000000-0000-4000-8000-000000000001";
const id = (n: number) => `b0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const NOW = Date.parse("2026-10-16T02:00:00.000Z");

const goal: Instruction = {
  id: id(999),
  scope: { kind: "global" },
  author: { kind: "human" },
  channel: "naru-ui",
  originUserInstructionId: null,
  supersedesId: null,
  verbatim: "블로그에 태그 페이지를 만들어 줘",
  forgottenAt: null,
  createdAt: "2026-10-16T01:00:00.000Z",
};

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

function entry(
  value: AgentTask,
  patch: { reviews?: AgentJobTask["reviews"]; latestRun?: Run | null } = {},
): AgentJobTask {
  return { task: value, reviews: patch.reviews ?? {}, latestRun: patch.latestRun ?? null };
}

function job(tasks: readonly AgentJobTask[]): AgentJob {
  return { goal, projectIds: [PROJECT], delegatedAt: goal.createdAt, tasks };
}

const passed = {
  correctness: { verdict: "pass", at: "2026-10-16T01:50:00.000Z" },
  intent: { verdict: "pass", at: "2026-10-16T01:51:00.000Z" },
} as const;

function context(working: readonly AgentWorking[] = [], reviewersWorking: AgentWorking[] = []) {
  return {
    working: new Map(working.map((item) => [item.agentSessionId, item])),
    reviewersWorking,
    nameOf: (agentSessionId: string) => (agentSessionId === id(2) ? "작업자 1" : "리뷰어 1"),
    numberOf: (taskId: string) => (taskId === id(101) ? 1 : taskId === id(102) ? 2 : null),
    doneTaskIds: new Set<string>(),
    now: NOW,
  };
}

describe("job stage (AP-D034)", () => {
  it("is planning before any task, and done when every task is", () => {
    expect(jobStage(job([]))).toBe("plan");
    expect(jobStage(job([entry(task(1, { status: "done" }))]))).toBe("done");
  });

  it("stays at the earliest step an open task is at", () => {
    expect(
      jobStage(job([entry(task(1, { status: "done" })), entry(task(2, { status: "running" }))])),
    ).toBe("work");
    expect(jobStage(job([entry(task(1, { status: "review" }))]))).toBe("verify");
    expect(jobStage(job([entry(task(1, { status: "review" }), { reviews: passed })]))).toBe(
      "merge",
    );
  });

  it("ignores cancelled tasks in the count and the stage", () => {
    const value = job([
      entry(task(1, { status: "done" })),
      entry(task(2, { status: "cancelled" })),
    ]);
    expect(jobStage(value)).toBe("done");
    expect(jobProgress(value)).toEqual({ done: 1, total: 1 });
  });

  it("marks the steps before the current one done", () => {
    expect(stageStates("verify")).toEqual({
      handed: "done",
      plan: "done",
      work: "done",
      verify: "current",
      merge: "todo",
      done: "todo",
    });
    expect(stageStates("done").done).toBe("done");
  });

  it("knows when a finished job finished", () => {
    expect(jobFinishedAt(job([entry(task(1, { status: "running" }))]))).toBeNull();
    expect(
      jobFinishedAt(
        job([
          entry(task(1, { status: "done", updatedAt: "2026-10-16T01:40:00.000Z" })),
          entry(task(2, { status: "done", updatedAt: "2026-10-16T01:55:00.000Z" })),
        ]),
      ),
    ).toBe("2026-10-16T01:55:00.000Z");
  });
});

describe("task numbering and steps", () => {
  it("numbers tasks in the order they can run", () => {
    const later = task(1, { dependsOn: [id(102)] });
    const first = task(2);
    expect(orderedTasks(job([entry(later), entry(first)])).map((item) => item.task.id)).toEqual([
      id(102),
      id(101),
    ]);
  });

  it("tracks 작업 · 검증 · 병합 per task", () => {
    const states = (value: AgentJobTask) => taskTrack(value).map((step) => step.state);
    expect(states(entry(task(1, { status: "ready" })))).toEqual(["todo", "todo", "todo"]);
    expect(states(entry(task(1, { status: "running" })))).toEqual(["current", "todo", "todo"]);
    expect(states(entry(task(1, { status: "review" })))).toEqual(["done", "current", "todo"]);
    expect(states(entry(task(1, { status: "review" }), { reviews: passed }))).toEqual([
      "done",
      "done",
      "current",
    ]);
    expect(states(entry(task(1, { status: "done" })))).toEqual(["done", "done", "done"]);
    expect(states(entry(task(1, { status: "failed" })))).toEqual(["failed", "todo", "todo"]);
    expect(states(entry(task(1, { status: "cancelled" })))).toEqual(["todo", "todo", "todo"]);
    expect(taskStep(entry(task(1, { status: "blocked" }))).label).toBe("막힘");
  });
});

describe("the 지금 line", () => {
  const working: AgentWorking = {
    agentSessionId: id(2),
    turnStartedAt: "2026-10-16T01:58:00.000Z",
    activity: { tool: "Edit", target: "src/tags.ts", since: "2026-10-16T01:59:48.000Z" },
  };

  it("shows the assignee's live tool call", () => {
    const now = taskNow(
      entry(task(1, { status: "running", assigneeAgentSessionId: id(2) })),
      context([working]),
    );
    expect(now).toEqual({
      agentSessionId: id(2),
      who: "작업자 1",
      what: "Edit · src/tags.ts · 12초째",
      live: true,
    });
  });

  it("names the step a waiting task waits for", () => {
    const now = taskNow(
      entry(task(2, { status: "pending", assigneeAgentSessionId: id(2), dependsOn: [id(101)] })),
      context(),
    );
    expect(now.what).toBe("1번이 끝나면 시작합니다");
    const both = taskNow(entry(task(3, { dependsOn: [id(102), id(101)] })), context());
    expect(both.what).toBe("1·2번이 끝나면 시작합니다");
  });

  it("shows the latest run summary when no turn runs", () => {
    const run: Run = {
      id: id(300),
      taskId: id(101),
      agentSessionId: id(2),
      runtime: "claude",
      model: null,
      status: "running",
      attempt: 1,
      errorClass: null,
      summary: "태그 목록\n페이지까지 만들었습니다",
      startedAt: "2026-10-16T01:20:00.000Z",
      finishedAt: null,
    };
    const now = taskNow(
      entry(task(1, { status: "running", assigneeAgentSessionId: id(2) }), { latestRun: run }),
      context(),
    );
    expect(now).toEqual({
      agentSessionId: id(2),
      who: "작업자 1",
      what: "진행: 태그 목록 페이지까지 만들었습니다",
      live: false,
    });
  });

  it("counts reviews while it waits for them, and shows a reviewer working", () => {
    const reviewing = entry(task(1, { status: "review" }), {
      reviews: { correctness: passed.correctness },
    });
    expect(taskNow(reviewing, context()).what).toBe("리뷰 1/2 · 리뷰를 기다립니다");
    const reviewer: AgentWorking = { agentSessionId: id(3), turnStartedAt: null, activity: null };
    expect(taskNow(reviewing, context([], [reviewer]))).toEqual({
      agentSessionId: id(3),
      who: "리뷰어 1",
      what: "일하는 중",
      live: true,
    });
  });

  it("says nobody has it yet", () => {
    expect(taskNow(entry(task(1, { status: "ready" })), context()).what).toBe(
      "아직 맡은 에이전트가 없습니다",
    );
  });
});

describe("time labels", () => {
  it("counts a stall up from the last progress", () => {
    const stall = {
      stage: "person",
      since: "2026-10-16T01:40:00.000Z",
      cause: "no-review",
      taskId: null,
      minutes: 20,
      lastProgressAt: "2026-10-16T01:20:00.000Z",
    } as const;
    expect(stallAge(stall, NOW)).toBe("40분째 그대로");
    expect(stallAge({ ...stall, lastProgressAt: null }, NOW)).toBe("20분째 그대로");
  });

  it("counts up in seconds, minutes and hours", () => {
    expect(elapsedLabel("2026-10-16T01:59:58.000Z", NOW)).toBe("방금");
    expect(elapsedLabel("2026-10-16T01:08:00.000Z", NOW)).toBe("52분째");
    expect(elapsedLabel("2026-10-16T00:48:00.000Z", NOW)).toBe("1시간 12분째");
    expect(
      activityLine(
        {
          agentSessionId: id(2),
          turnStartedAt: "2026-10-16T01:00:00.000Z",
          activity: null,
        },
        NOW,
      ),
    ).toBe("일하는 중 · 1시간째");
  });
});
