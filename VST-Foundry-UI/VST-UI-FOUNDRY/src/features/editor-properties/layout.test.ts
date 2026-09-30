import { describe, expect, it } from "vitest";
import type { UIElement } from "../../types";
import { getAlignmentUpdates, isElementLocked } from "./layout";

const canvas = { width: 800, height: 600 };
const element = (id: string, updates: Partial<UIElement> = {}): UIElement => ({
  id, name: id, type: "Button", x: 20, y: 10, width: 40, height: 20, ...updates,
});

describe("editor alignment geometry", () => {
  it("preserves the root canvas centering contract", () => {
    const root = element("root");
    expect(getAlignmentUpdates([root], [root], canvas, "centerBoth")).toEqual({ root: { x: 380, y: 290 } });
  });

  it("converts nested group coordinates back to local positions", () => {
    const outer = element("outer", { type: "Group", x: 100, y: 80 });
    const inner = element("inner", { type: "Group", groupId: outer.id, x: 30, y: 40 });
    const child = element("child", { groupId: inner.id, x: 10 });
    const root = element("root", { x: 50 });
    const updates = getAlignmentUpdates([child, root], [outer, inner, child, root], canvas, "left");
    expect(updates.child).toEqual({ x: -84, y: 10 });
    expect(updates.root).toBeUndefined();
  });

  it("converts canvas deltas through rotated and mirrored parent groups", () => {
    const group = element("group", { type: "Group", x: 100, y: 100, width: 200, height: 200, rotation: 90, flipX: true });
    const child = element("child", { groupId: group.id, x: 10, y: 20, width: 20, height: 20 });
    const root = element("root", { x: 100 });
    const updates = getAlignmentUpdates([child, root], [group, child, root], canvas, "left");
    expect(updates.child.x).toBeCloseTo(10);
    expect(updates.child.y).toBeCloseTo(178);
  });

  it("moves a selected group once when its child is also selected", () => {
    const group = element("group", { type: "Group", x: 100 });
    const child = element("child", { groupId: group.id });
    const updates = getAlignmentUpdates([group, child], [group, child], canvas, "left");
    expect(updates).toEqual({ group: { x: 0, y: 10 } });
  });

  it("uses locked elements as alignment anchors and honors ancestor locks", () => {
    const locked = element("locked", { isLocked: true, x: 200 });
    const movable = element("movable", { x: 100 });
    expect(getAlignmentUpdates([locked, movable], [locked, movable], canvas, "right")).toEqual({ movable: { x: 200, y: 10 } });
    const child = element("child", { groupId: locked.id });
    expect(isElementLocked(child, [locked, child])).toBe(true);
    expect(getAlignmentUpdates([child], [locked, child], canvas, "left")).toEqual({});
  });

  it("does not guess a coordinate space for missing or cyclic parents", () => {
    const orphan = element("orphan", { groupId: "missing" });
    const cyclic = element("cyclic", { groupId: "cyclic" });
    expect(getAlignmentUpdates([orphan], [orphan], canvas, "left")).toEqual({});
    expect(getAlignmentUpdates([cyclic], [cyclic], canvas, "left")).toEqual({});
  });

  it.each(["distributeH", "distributeV"] as const)("distributes mixed coordinate selections with unequal sizes (%s)", (alignment) => {
    const group = element("group", { type: "Group", x: 100, y: 100 });
    const first = element("first", { x: 0, y: 0, width: 20, height: 20 });
    const middle = element("middle", { groupId: group.id, x: -70, y: -70, width: 30, height: 30 });
    const last = element("last", { x: 100, y: 100, width: 20, height: 20 });
    const updates = getAlignmentUpdates([first, middle, last], [group, first, middle, last], canvas, alignment);
    expect(updates).toEqual({ middle: alignment === "distributeH" ? { x: -57, y: -70 } : { x: -70, y: -57 } });
  });

  it("distributes between locked anchors without moving them or endpoints", () => {
    const items = [
      element("first", { x: 0, width: 10 }), element("middle", { x: 15, width: 10 }),
      element("locked", { x: 100, width: 10, isLocked: true }), element("last", { x: 200, width: 10 }),
    ];
    expect(getAlignmentUpdates(items, items, canvas, "distributeH")).toEqual({ middle: { x: 50, y: 10 } });
  });

  it.each(["centerH", "centerV"] as const)("centers on a locked anchor without repeated drift (%s)", (alignment) => {
    const locked = element("locked", { isLocked: true, x: 200, y: 200 });
    const movable = element("movable", { x: 0, y: 0 });
    const selection = [locked, movable];
    const updates = getAlignmentUpdates(selection, selection, canvas, alignment);
    expect(updates).toEqual({ movable: alignment === "centerH" ? { x: 200, y: 0 } : { x: 0, y: 200 } });
    const aligned = selection.map((item) => ({ ...item, ...updates[item.id] }));
    expect(getAlignmentUpdates(aligned, aligned, canvas, alignment)).toEqual({});
  });

  it("uses only locked centers when multiple unequal anchors are selected", () => {
    const selection = [
      element("firstAnchor", { isLocked: true, x: 200, y: 180 }),
      element("secondAnchor", { isLocked: true, x: 300, y: 280, width: 80, height: 60 }),
      element("movable", { x: 0, y: 0, width: 20, height: 40 }),
    ];
    const updates = getAlignmentUpdates(selection, selection, canvas, "centerBoth");
    expect(updates).toEqual({ movable: { x: 270, y: 230 } });
    const aligned = selection.map((item) => ({ ...item, ...updates[item.id] }));
    expect(getAlignmentUpdates(aligned, aligned, canvas, "centerBoth")).toEqual({});
  });

  it.each([
    { alignment: "left", start: 0, expected: { x: 200, y: 0 } },
    { alignment: "right", start: 400, expected: { x: 200, y: 400 } },
    { alignment: "top", start: 0, expected: { x: 0, y: 180 } },
    { alignment: "bottom", start: 400, expected: { x: 400, y: 180 } },
  ] as const)("uses fixed locked edges for $alignment", ({ alignment, start, expected }) => {
    const locked = element("locked", { isLocked: true, x: 200, y: 180 });
    const movable = element("movable", { x: start, y: start });
    const selection = [locked, movable];
    const updates = getAlignmentUpdates(selection, selection, canvas, alignment);
    expect(updates).toEqual({ movable: expected });
    const aligned = selection.map((item) => ({ ...item, ...updates[item.id] }));
    expect(getAlignmentUpdates(aligned, aligned, canvas, alignment)).toEqual({});
  });

  it("preserves average-center alignment when no selected items are locked", () => {
    const selection = [
      element("first", { x: 0, y: 0 }),
      element("second", { x: 200, y: 200, width: 80, height: 60 }),
    ];
    const updates = getAlignmentUpdates(selection, selection, canvas, "centerBoth");
    expect(updates).toEqual({ first: { x: 110, y: 110 }, second: { x: 90, y: 90 } });
    const aligned = selection.map((item) => ({ ...item, ...updates[item.id] }));
    expect(getAlignmentUpdates(aligned, aligned, canvas, "centerBoth")).toEqual({});
  });

  it.each([
    { alignment: "left", expected: { x: 0, y: 10 } },
    { alignment: "top", expected: { x: 20, y: 0 } },
    { alignment: "right", expected: { x: 156, y: 10 } },
    { alignment: "bottom", expected: { x: 20, y: 76 } },
    { alignment: "centerBoth", expected: { x: 78, y: 38 } },
  ] as const)("aligns within the group's inner border for $alignment", ({ alignment, expected }) => {
    const group = element("group", { type: "Group", width: 200, height: 100 });
    const child = element("child", { groupId: group.id });
    const updates = getAlignmentUpdates([child], [group, child], canvas, alignment);
    expect(updates).toEqual({ child: expected });
    const aligned = { ...child, ...updates.child };
    expect(getAlignmentUpdates([aligned], [group, aligned], canvas, alignment)).toEqual({});
    expect(2 + aligned.x + aligned.width).toBeLessThanOrEqual(group.width - 2);
    expect(2 + aligned.y + aligned.height).toBeLessThanOrEqual(group.height - 2);
  });

  it.each([
    { alignment: "right", expected: { x: 166, y: 10 } },
    { alignment: "bottom", expected: { x: 20, y: 66 } },
  ] as const)("contains a rotated child inside the group's $alignment border", ({ alignment, expected }) => {
    const group = element("group", { type: "Group", width: 200, height: 100, rotation: 90, flipX: true });
    const child = element("child", { groupId: group.id, rotation: 90 });
    const updates = getAlignmentUpdates([child], [group, child], canvas, alignment);
    expect(updates.child.x).toBeCloseTo(expected.x);
    expect(updates.child.y).toBeCloseTo(expected.y);
    const aligned = { ...child, ...updates.child };
    expect(getAlignmentUpdates([aligned], [group, aligned], canvas, alignment)).toEqual({});
  });

  it.each([false, true])("applies each nested group inset before its rotation and flip (flipY=%s)", (flipY) => {
    const outer = element("outer", { type: "Group", x: 100, y: 80, width: 200, height: 160, rotation: 90 });
    const inner = element("inner", { type: "Group", groupId: outer.id, x: 30, y: 20, width: 80, height: 60, rotation: 90, flipY });
    const child = element("child", { groupId: inner.id, x: 10, y: 8, width: 20, height: 12 });
    const locked = element("locked", { isLocked: true, x: 150, y: 200, width: 20, height: 12 });
    const updates = getAlignmentUpdates([child, locked], [outer, inner, child, locked], canvas, "centerBoth");
    expect(updates.locked).toBeUndefined();
    expect(updates.child.x).toBeCloseTo(96);
    expect(updates.child.y).toBeCloseTo(flipY ? 96 : -52);
    const aligned = { ...child, ...updates.child };
    expect(266 - aligned.x - aligned.width).toBeCloseTo(locked.x);
    expect(flipY ? 104 + aligned.y : 160 - aligned.y - aligned.height).toBeCloseTo(locked.y);
    expect(getAlignmentUpdates([aligned, locked], [outer, inner, aligned, locked], canvas, "centerBoth")).toEqual({});
  });
});
