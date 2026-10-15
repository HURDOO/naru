import type { AgentTask } from "@naru/contracts/naru-agent/v1";
import { describe, expect, it } from "vitest";
import { taskLevels } from "./agent-task-graph";

function task(id: string, dependsOn: string[] = [], priority = 0): AgentTask {
  return {
    id,
    projectId: "10000000-0000-4000-8000-000000000000",
    planId: null,
    title: id,
    purpose: "",
    completionCriteria: [],
    status: "pending",
    priority,
    assigneeAgentSessionId: null,
    originInstructionId: "20000000-0000-4000-8000-000000000000",
    intentContractId: null,
    dependsOn,
    revision: 1,
    createdAt: `2026-10-15T00:00:0${id.length}.000Z`,
    updatedAt: "2026-10-15T00:00:00.000Z",
  };
}

const ids = (levels: AgentTask[][]) => levels.map((level) => level.map((item) => item.id));

describe("taskLevels", () => {
  it("places each task one level after its deepest dependency", () => {
    expect(
      ids(taskLevels([task("d", ["b", "c"]), task("b", ["a"]), task("c"), task("a")])),
    ).toEqual([["c", "a"], ["b"], ["d"]]);
  });

  it("orders a level by priority, then age", () => {
    expect(ids(taskLevels([task("a"), task("bb", [], 5), task("c")]))).toEqual([["bb", "a", "c"]]);
  });

  it("ignores dependencies outside the list and survives a cycle", () => {
    expect(ids(taskLevels([task("a", ["missing"])]))).toEqual([["a"]]);
    const levels = taskLevels([task("a", ["b"]), task("b", ["a"])]);
    expect(
      levels
        .flat()
        .map((item) => item.id)
        .sort(),
    ).toEqual(["a", "b"]);
  });

  it("returns no levels for no tasks", () => {
    expect(taskLevels([])).toEqual([]);
  });
});
