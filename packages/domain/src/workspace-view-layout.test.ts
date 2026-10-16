import type { LayoutNode, WorkspaceViewLayoutNode } from "@naru/contracts";
import { WorkspaceViewLayoutNodeSchema } from "@naru/contracts";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VIEW_SLOTS,
  defaultViewLayout,
  fillViewSlot,
  insertIntoView,
  removePaneFromView,
  removeSlotFromView,
  resizeViewSplit,
  validateViewLayout,
  viewFromProjectLayout,
  viewPaneIds,
  viewPaneNode,
  viewSlotNode,
  viewSlots,
} from "./workspace-view-layout.js";

const a = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const b = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const c = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function ids(): () => string {
  let next = 0;
  return () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`;
}

describe("workspace view layouts (AP-D031)", () => {
  it("builds the default workspace with places for missing Panes", () => {
    const layout = defaultViewLayout({ claude: a, codex: null, terminal: c }, ids());

    expect(WorkspaceViewLayoutNodeSchema.parse(layout)).toEqual(layout);
    expect(layout).toMatchObject({
      type: "split",
      direction: "vertical",
      ratio: 0.64,
      first: {
        type: "split",
        direction: "horizontal",
        ratio: 0.5,
        first: { type: "pane", paneId: a },
        second: { type: "slot", pane: DEFAULT_VIEW_SLOTS.codex },
      },
      second: { type: "pane", paneId: c },
    });
    expect(viewPaneIds(layout)).toEqual([a, c]);
    expect(viewSlots(layout).map((slot) => slot.pane.kind)).toEqual(["codex"]);
    validateViewLayout(layout, new Set([a, c]));
  });

  it("keeps what a project layout shows and leaves collapsed Panes out", () => {
    const project: LayoutNode = {
      type: "split",
      id: "11111111-1111-4111-8111-111111111111",
      direction: "horizontal",
      ratio: 0.3,
      first: { type: "pane", paneId: a, collapsed: false },
      second: {
        type: "split",
        id: "22222222-2222-4222-8222-222222222222",
        direction: "vertical",
        ratio: 0.7,
        first: { type: "pane", paneId: b, collapsed: true },
        second: { type: "pane", paneId: c, collapsed: false },
      },
    };

    expect(viewFromProjectLayout(project)).toEqual({
      type: "split",
      id: "11111111-1111-4111-8111-111111111111",
      direction: "horizontal",
      ratio: 0.3,
      first: { type: "pane", paneId: a },
      second: { type: "pane", paneId: c },
    });
    expect(viewFromProjectLayout(null)).toBeNull();
    expect(viewFromProjectLayout({ type: "pane", paneId: a, collapsed: true })).toBeNull();
  });

  it("inserts beside a Pane or a place, fills places and removes without touching others", () => {
    const newId = ids();
    const start = insertIntoView(null, viewPaneNode(a), null, "horizontal");
    expect(start).toEqual({ type: "pane", paneId: a });

    const slot = viewSlotNode(DEFAULT_VIEW_SLOTS.terminal, newId());
    const withSlot = insertIntoView(start, slot, { type: "pane", paneId: a }, "vertical", newId());
    const withB = insertIntoView(
      withSlot,
      viewPaneNode(b),
      { type: "slot", slotId: slot.id },
      "horizontal",
      newId(),
    );
    expect(viewPaneIds(withB)).toEqual([a, b]);

    const filled = fillViewSlot(withB, slot.id, c);
    expect(viewPaneIds(filled)).toEqual([a, c, b]);
    expect(viewSlots(filled)).toEqual([]);
    expect(viewSlots(withB)).toHaveLength(1);

    const withoutC = removePaneFromView(filled, c);
    expect(viewPaneIds(withoutC)).toEqual([a, b]);
    expect(removePaneFromView(removePaneFromView(withoutC, a), b)).toBeNull();
    expect(viewPaneIds(removeSlotFromView(withB, slot.id))).toEqual([a, b]);
  });

  it("rejects a Pane twice, missing targets and unknown splits", () => {
    const layout = defaultViewLayout({ claude: a, codex: b, terminal: null }, ids());
    expect(() =>
      insertIntoView(layout, viewPaneNode(a), { type: "pane", paneId: b }, "vertical"),
    ).toThrow("already");
    expect(() => insertIntoView(layout, viewPaneNode(c), null, "vertical")).toThrow("target");
    expect(() =>
      insertIntoView(layout, viewPaneNode(c), { type: "pane", paneId: c }, "vertical"),
    ).toThrow("not in the workspace");
    expect(() => fillViewSlot(layout, viewSlots(layout)[0]!.id, a)).toThrow("already");
    expect(() => resizeViewSplit(layout, c, 0.5)).toThrow("does not exist");
    expect(() => resizeViewSplit(layout, (layout as { id: string }).id, 0.95)).toThrow("between");
    expect(resizeViewSplit(layout, (layout as { id: string }).id, 0.4)).toMatchObject({
      ratio: 0.4,
    });
  });

  it("validates Panes against the project and ids across the tree", () => {
    const layout = defaultViewLayout({ claude: a, codex: b, terminal: c }, ids());
    expect(() => validateViewLayout(layout, new Set([a, b]))).toThrow("unknown Pane");

    const twice: WorkspaceViewLayoutNode = {
      type: "split",
      id: "11111111-1111-4111-8111-111111111111",
      direction: "horizontal",
      ratio: 0.5,
      first: viewPaneNode(a),
      second: viewPaneNode(a),
    };
    expect(() => validateViewLayout(twice, new Set([a]))).toThrow("twice");

    const reusedId: WorkspaceViewLayoutNode = {
      type: "split",
      id: "11111111-1111-4111-8111-111111111111",
      direction: "horizontal",
      ratio: 0.5,
      first: viewPaneNode(a),
      second: viewSlotNode(DEFAULT_VIEW_SLOTS.claude, "11111111-1111-4111-8111-111111111111"),
    };
    expect(() => validateViewLayout(reusedId, new Set([a]))).toThrow("reuses");

    let deep: WorkspaceViewLayoutNode = viewPaneNode(a);
    const newId = ids();
    for (let depth = 0; depth < 12; depth += 1) {
      deep = {
        type: "split",
        id: newId(),
        direction: "vertical",
        ratio: 0.5,
        first: deep,
        second: viewSlotNode(DEFAULT_VIEW_SLOTS.terminal, newId()),
      };
    }
    expect(() => validateViewLayout(deep, new Set([a]))).toThrow("depth");
    validateViewLayout(null, new Set([a]));
  });
});
