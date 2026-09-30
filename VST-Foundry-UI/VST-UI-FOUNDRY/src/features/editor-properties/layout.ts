import type { CanvasState, UIElement } from "../../types";

export type Alignment = "left" | "centerH" | "right" | "top" | "centerV" | "bottom" | "centerBoth" | "distributeH" | "distributeV";
type Point = { x: number; y: number };
type Bounds = { left: number; top: number; width: number; height: number };

function childContainerInset(element: UIElement): number {
  return element.type === "Group" ? 2 : 0;
}

function ancestorsOf(element: UIElement, elements: UIElement[]): UIElement[] | null {
  const ancestors: UIElement[] = [];
  const visited = new Set([element.id]);
  let parentId = element.groupId;
  while (parentId) {
    const parent = elements.find((candidate) => candidate.id === parentId);
    if (!parent || visited.has(parent.id)) return null;
    ancestors.push(parent);
    visited.add(parent.id);
    parentId = parent.groupId;
  }
  return ancestors;
}

export function isElementLocked(element: UIElement, elements: UIElement[]): boolean {
  const ancestors = ancestorsOf(element, elements);
  return !!element.isLocked || ancestors === null || ancestors.some((parent) => parent.isLocked);
}

function transformPoint(point: Point, element: UIElement): Point {
  const radians = (element.rotation ?? 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const centeredX = (point.x - element.width / 2) * (element.flipX ? -1 : 1);
  const centeredY = (point.y - element.height / 2) * (element.flipY ? -1 : 1);
  return {
    x: element.x + element.width / 2 + centeredX * cosine - centeredY * sine,
    y: element.y + element.height / 2 + centeredX * sine + centeredY * cosine,
  };
}

function boundsOf(element: UIElement, ancestors: UIElement[]): Bounds {
  const corners = [
    { x: 0, y: 0 }, { x: element.width, y: 0 },
    { x: 0, y: element.height }, { x: element.width, y: element.height },
  ].map((point) => ancestors.reduce((current, parent) => {
    const inset = childContainerInset(parent);
    return transformPoint({ x: current.x + inset, y: current.y + inset }, parent);
  }, transformPoint(point, element)));
  const left = Math.min(...corners.map((point) => point.x));
  const top = Math.min(...corners.map((point) => point.y));
  return {
    left, top,
    width: Math.max(...corners.map((point) => point.x)) - left,
    height: Math.max(...corners.map((point) => point.y)) - top,
  };
}

function localDelta(delta: Point, ancestors: UIElement[]): Point {
  return [...ancestors].reverse().reduce((current, parent) => {
    const radians = (parent.rotation ?? 0) * Math.PI / 180;
    const cosine = Math.cos(radians);
    const sine = Math.sin(radians);
    return {
      x: (current.x * cosine + current.y * sine) * (parent.flipX ? -1 : 1),
      y: (-current.x * sine + current.y * cosine) * (parent.flipY ? -1 : 1),
    };
  }, delta);
}

export function getAlignmentUpdates(
  selection: UIElement[], elements: UIElement[], canvas: Pick<CanvasState, "width" | "height">, alignment: Alignment,
): Record<string, Partial<UIElement>> {
  const selectedIds = new Set(selection.map((element) => element.id));
  const roots = selection.filter((element) => {
    const ancestors = ancestorsOf(element, elements);
    return ancestors !== null && !ancestors.some((parent) => selectedIds.has(parent.id));
  });
  const updates: Record<string, Partial<UIElement>> = {};
  const items = roots.map((element) => {
    const ancestors = ancestorsOf(element, elements) ?? [];
    return { element, ancestors, bounds: boundsOf(element, roots.length === 1 ? [] : ancestors) };
  });
  if (items.length === 0) return updates;

  const move = (item: typeof items[number], delta: Point) => {
    if (isElementLocked(item.element, elements)) return;
    const local = roots.length === 1 ? delta : localDelta(delta, item.ancestors);
    if (Math.abs(local.x) < 1e-9 && Math.abs(local.y) < 1e-9) return;
    updates[item.element.id] = { x: item.element.x + local.x, y: item.element.y + local.y };
  };

  if (alignment === "distributeH" || alignment === "distributeV") {
    if (items.length < 3) return updates;
    const horizontal = alignment === "distributeH";
    const position = (item: typeof items[number]) => horizontal ? item.bounds.left : item.bounds.top;
    const size = (item: typeof items[number]) => horizontal ? item.bounds.width : item.bounds.height;
    const sorted = [...items].sort((first, second) => position(first) - position(second));
    let startIndex = 0;
    for (let endIndex = 1; endIndex < sorted.length; endIndex++) {
      if (endIndex !== sorted.length - 1 && !isElementLocked(sorted[endIndex].element, elements)) continue;
      const segment = sorted.slice(startIndex, endIndex + 1);
      const start = position(segment[0]);
      const end = position(segment[segment.length - 1]) + size(segment[segment.length - 1]);
      const gap = (end - start - segment.reduce((total, item) => total + size(item), 0)) / (segment.length - 1);
      let cursor = start;
      segment.forEach((item, index) => {
        if (index > 0 && index < segment.length - 1) {
          const distance = cursor - position(item);
          move(item, horizontal ? { x: distance, y: 0 } : { x: 0, y: distance });
        }
        cursor += size(item) + gap;
      });
      startIndex = endIndex;
    }
    return updates;
  }

  const parent = items[0].ancestors[0];
  const container = parent ? {
    width: Math.max(0, parent.width - 2 * childContainerInset(parent)),
    height: Math.max(0, parent.height - 2 * childContainerInset(parent)),
  } : canvas;
  const lockedItems = items.filter((item) => isElementLocked(item.element, elements));
  const anchors = lockedItems.length > 0 ? lockedItems : items;
  const left = roots.length === 1 ? 0 : Math.min(...anchors.map((item) => item.bounds.left));
  const top = roots.length === 1 ? 0 : Math.min(...anchors.map((item) => item.bounds.top));
  const right = roots.length === 1 ? container.width : Math.max(...anchors.map((item) => item.bounds.left + item.bounds.width));
  const bottom = roots.length === 1 ? container.height : Math.max(...anchors.map((item) => item.bounds.top + item.bounds.height));
  const centerX = roots.length === 1 ? container.width / 2 : anchors.reduce((sum, item) => sum + item.bounds.left + item.bounds.width / 2, 0) / anchors.length;
  const centerY = roots.length === 1 ? container.height / 2 : anchors.reduce((sum, item) => sum + item.bounds.top + item.bounds.height / 2, 0) / anchors.length;
  items.forEach((item) => {
    const delta = { x: 0, y: 0 };
    switch (alignment) {
      case "left": delta.x = left - item.bounds.left; break;
      case "right": delta.x = right - item.bounds.left - item.bounds.width; break;
      case "top": delta.y = top - item.bounds.top; break;
      case "bottom": delta.y = bottom - item.bounds.top - item.bounds.height; break;
      case "centerH": delta.x = centerX - item.bounds.left - item.bounds.width / 2; break;
      case "centerV": delta.y = centerY - item.bounds.top - item.bounds.height / 2; break;
      case "centerBoth":
        delta.x = centerX - item.bounds.left - item.bounds.width / 2;
        delta.y = centerY - item.bounds.top - item.bounds.height / 2;
        break;
    }
    move(item, delta);
  });
  return updates;
}
