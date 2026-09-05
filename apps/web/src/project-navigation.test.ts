import type { ProjectGroup } from "@naru/contracts";
import { describe, expect, it } from "vitest";
import { resolveProjectGroupEntry } from "./project-navigation.js";

const firstProjectId = "11111111-1111-4111-8111-111111111111";
const secondProjectId = "22222222-2222-4222-8222-222222222222";

describe("project group entry policy", () => {
  it("opens a closed sidebar without selecting when multiple targets are connected", () => {
    expect(resolveProjectGroupEntry(group([firstProjectId, secondProjectId]), null, false)).toEqual(
      {
        kind: "open-target-picker",
        focusProjectId: firstProjectId,
      },
    );
    expect(
      resolveProjectGroupEntry(group([firstProjectId, secondProjectId]), secondProjectId, false),
    ).toEqual({ kind: "open-target-picker", focusProjectId: secondProjectId });
  });

  it("selects directly when the sidebar is already open", () => {
    expect(
      resolveProjectGroupEntry(group([firstProjectId, secondProjectId]), secondProjectId, true),
    ).toEqual({ kind: "select-target", projectId: secondProjectId });
  });

  it("uses the current connected count instead of discovered or removed targets", () => {
    expect(resolveProjectGroupEntry(group([firstProjectId], true), null, false)).toEqual({
      kind: "select-target",
      projectId: firstProjectId,
    });
    expect(resolveProjectGroupEntry(group([firstProjectId, secondProjectId]), null, false)).toEqual(
      {
        kind: "open-target-picker",
        focusProjectId: firstProjectId,
      },
    );
    expect(resolveProjectGroupEntry(group([]), null, false)).toEqual({ kind: "none" });
  });
});

function group(projectIds: readonly string[], includeDiscovered = false): ProjectGroup {
  const timestamp = "2026-08-21T00:00:00.000Z";
  return {
    id: "33333333-3333-4333-8333-333333333333",
    name: "Editor",
    kind: "git",
    activity: { state: "idle", interactionRequiredCount: 0, updatedAt: null },
    targets: [
      ...projectIds.map((projectId, index) => ({
        registration: "connected" as const,
        projectId,
        label: index === 0 ? "main" : `feature/${index}`,
        path: `/Users/example/projects/editor-${index}`,
        availability: "ready" as const,
        git: {
          kind: "worktree" as const,
          role: index === 0 ? ("primary" as const) : ("linked" as const),
          head: {
            kind: "branch" as const,
            name: index === 0 ? "main" : `feature/${index}`,
            oid: String(index + 1).repeat(40),
          },
          locked: false,
          prunable: false,
        },
        activity: { state: "idle" as const, interactionRequiredCount: 0, updatedAt: null },
        createdAt: timestamp,
        updatedAt: timestamp,
      })),
      ...(includeDiscovered
        ? [
            {
              registration: "discovered" as const,
              label: "feature/discovered",
              path: "/Users/example/projects/editor-discovered",
              availability: "ready" as const,
              git: {
                kind: "worktree" as const,
                role: "linked" as const,
                head: {
                  kind: "branch" as const,
                  name: "feature/discovered",
                  oid: "d".repeat(40),
                },
                locked: false,
                prunable: false,
              },
            },
          ]
        : []),
    ],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
