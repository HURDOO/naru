import { describe, expect, it } from "vitest";
import { LAYOUT_SCHEMA_VERSION, type LayoutNode, type SplitNode } from "@naru/contracts";
import {
  appendPane,
  collapsedPaneIds,
  isPaneCollapsed,
  migrateLayout,
  removePane,
  resizeSplit,
  setPaneCollapsed,
  splitPane,
  validateLayout,
  visibleLayout,
  visiblePaneIds,
} from "./index.js";

const paneA = "11111111-1111-4111-8111-111111111111";
const paneB = "22222222-2222-4222-8222-222222222222";
const paneC = "33333333-3333-4333-8333-333333333333";
const splitA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const splitB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("layout domain", () => {
  it("creates, splits, resizes and removes panes without dangling nodes", () => {
    const one = appendPane(null, paneA);
    const two = splitPane(one, paneA, paneB, "vertical", splitA);
    const three = splitPane(two, paneB, paneC, "horizontal");
    validateLayout(three, new Set([paneA, paneB, paneC]));

    const resized = resizeSplit(three, splitA, 0.65);
    expect(resized).toMatchObject({ type: "split", ratio: 0.65 });

    const removed = removePane(resized, paneB);
    validateLayout(removed, new Set([paneA, paneC]));
  });

  it("makes the last Pane removal rule explicit", () => {
    const one = appendPane(null, paneA);
    expect(removePane(one, paneA)).toBeNull();
    expect(removePane(null, paneA)).toBeNull();
  });

  it("rejects reducer operations that would create invalid trees", () => {
    const one = appendPane(null, paneA);
    const two = splitPane(one, paneA, paneB, "vertical", splitA);

    expect(() => splitPane(two, paneC, paneC, "horizontal", splitB)).toThrow(/does not exist/);
    expect(() => splitPane(two, paneA, paneB, "horizontal", splitB)).toThrow(/already exists/);
    expect(() => splitPane(two, paneA, paneC, "horizontal", splitA)).toThrow(/already exists/);
    expect(() => resizeSplit(two, splitB, 0.5)).toThrow(/does not exist/);
    expect(() => resizeSplit(two, splitA, Number.NaN)).toThrow(/between 0.1 and 0.9/);
    expect(() => resizeSplit(two, splitA, Number.POSITIVE_INFINITY)).toThrow(/between 0.1 and 0.9/);
  });

  it("rejects duplicate and unknown pane references", () => {
    const invalid: LayoutNode = {
      type: "split",
      id: splitA,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: paneA, collapsed: false },
      second: { type: "pane", paneId: paneA, collapsed: false },
    };

    expect(() => validateLayout(invalid, new Set([paneA]))).toThrow(/more than once/);
    expect(() =>
      validateLayout({ type: "pane", paneId: paneA, collapsed: false }, new Set([paneB])),
    ).toThrow(/unknown Pane/);
  });

  it("rejects duplicate split IDs, invalid ratios and excessive depth", () => {
    const duplicateSplit: LayoutNode = {
      type: "split",
      id: splitA,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: paneA, collapsed: false },
      second: {
        type: "split",
        id: splitA,
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", paneId: paneB, collapsed: false },
        second: { type: "pane", paneId: paneC, collapsed: false },
      },
    };
    expect(() => validateLayout(duplicateSplit, new Set([paneA, paneB, paneC]))).toThrow(
      /Split .* more than once/,
    );

    const invalidRatio: LayoutNode = {
      ...duplicateSplit,
      id: splitB,
      ratio: Number.NaN,
    };
    expect(() => validateLayout(invalidRatio, new Set([paneA, paneB, paneC]))).toThrow(
      /invalid ratio/,
    );
    const deepLayout: LayoutNode = {
      type: "split",
      id: splitA,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: paneA, collapsed: false },
      second: {
        type: "split",
        id: splitB,
        direction: "vertical",
        ratio: 0.5,
        first: { type: "pane", paneId: paneB, collapsed: false },
        second: { type: "pane", paneId: paneC, collapsed: false },
      },
    };
    expect(() => validateLayout(deepLayout, new Set([paneA, paneB, paneC]), 2)).toThrow(
      /maximum depth 2/,
    );
  });

  it("rejects cyclic or reused layout nodes", () => {
    const cyclic: SplitNode = {
      type: "split",
      id: splitA,
      direction: "horizontal",
      ratio: 0.5,
      first: { type: "pane", paneId: paneA, collapsed: false },
      second: { type: "pane", paneId: paneB, collapsed: false },
    };
    cyclic.second = cyclic;

    expect(() => validateLayout(cyclic, new Set([paneA]))).toThrow(/cycle or reused node/);
  });

  it("migrates and validates the current serialized layout schema", () => {
    const layout = { type: "pane" as const, paneId: paneA, collapsed: false };
    expect(migrateLayout(layout, LAYOUT_SCHEMA_VERSION)).toEqual(layout);
    expect(migrateLayout({ type: "pane", paneId: paneA }, 1)).toEqual(layout);
    expect(migrateLayout(null, LAYOUT_SCHEMA_VERSION)).toBeNull();
    expect(() => migrateLayout(layout, LAYOUT_SCHEMA_VERSION + 1)).toThrow(/Unsupported/);
    expect(() =>
      migrateLayout({ ...layout, paneId: "not-a-uuid" }, LAYOUT_SCHEMA_VERSION),
    ).toThrow();
  });

  it("projects collapsed leaves without changing their stored split position", () => {
    const original = splitPane(appendPane(null, paneA), paneA, paneB, "horizontal", splitA);
    const collapsed = setPaneCollapsed(original, paneA, true);

    expect(isPaneCollapsed(collapsed, paneA)).toBe(true);
    expect(collapsedPaneIds(collapsed)).toEqual([paneA]);
    expect(visiblePaneIds(collapsed)).toEqual([paneB]);
    expect(visibleLayout(collapsed)).toEqual({ type: "pane", paneId: paneB, collapsed: false });
    expect(setPaneCollapsed(collapsed, paneA, false)).toEqual(original);
    expect(() => setPaneCollapsed(collapsed, paneB, true)).toThrow(/last visible/i);
  });
});
