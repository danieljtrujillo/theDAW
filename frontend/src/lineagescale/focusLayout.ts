/**
 * focusLayout — where the boxes of a focus view go. A pure function over plain
 * data: no React, no DOM, no fetch, so it can be tested at the sizes that
 * broke the old view.
 *
 * THE RULE THIS MODULE EXISTS TO KEEP: nothing here ever spreads a data-sized
 * array into a call. `Math.min(...xs)` over 194,833 positions is exactly the
 * "Maximum call stack size exceeded" that killed the whole-library drawing —
 * a spread passes one argument per element, and the engine's argument limit is
 * tens of thousands, not hundreds of thousands. Every reduction below is a
 * plain `for` loop, and `boundsOfBoxes` is tested with 200,000 boxes.
 *
 * The shape: generation is a ROW. Sources (generation < 0) sit above the focus
 * (generation 0); derivatives (generation > 0) sit below it. Each row is laid
 * out left to right in the order the server sent — which is breadth-first,
 * nearest first — and centred on x = 0, so the focus is always near the middle
 * of its own row and the eye can follow one column down a family.
 */

/** A placed box: a node, or a group stand-in ("Covers (312)"). */
export interface LayoutBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The row this box sits in. */
  generation: number;
}

export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
  width: number;
  height: number;
}

/** One generation's row of boxes. */
export interface LayoutRow {
  generation: number;
  y: number;
  /** Nodes first, then the group stand-ins that hang off this row. */
  boxes: LayoutBox[];
}

export const NODE_W = 176;
export const NODE_H = 48;
/** Group stand-ins are the same size as nodes, so a row stays a row. */
export const GROUP_W = NODE_W;
export const GROUP_H = NODE_H;
/** Horizontal gap between two boxes in the same row. */
export const COL_GAP = 14;
/** Vertical gap between two rows — room for an edge and its label. */
export const ROW_GAP = 76;
/** Row pitch: the distance between generation g and generation g + 1. */
export const ROW_H = NODE_H + ROW_GAP;
/** Breathing room added around the whole drawing. */
export const PAD = 40;

export interface LayoutNodeInput {
  id: string;
  generation: number;
}

export interface LayoutGroupInput {
  id: string;
  parent_id: string;
  direction: 'up' | 'down';
}

export interface FocusLayoutInput {
  nodes: readonly LayoutNodeInput[];
  groups?: readonly LayoutGroupInput[];
}

export interface FocusLayout {
  rows: LayoutRow[];
  nodes: LayoutBox[];
  groups: LayoutBox[];
  nodeById: Map<string, LayoutBox>;
  groupById: Map<string, LayoutBox>;
  bounds: Bounds;
  /** Groups whose parent is not in `nodes`: unplaceable, so not placed. */
  skippedGroupIds: string[];
}

/** The empty drawing: a zero box at the origin, so callers never divide by a
 *  NaN width or feed `viewBox` an undefined. */
export const EMPTY_BOUNDS: Bounds = { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };

/**
 * The box that contains every box, plus `pad` on each side.
 *
 * LOOPS ONLY — see the header. This is the helper the 200,000-position test
 * points at, because it is the one place a spread would be tempting.
 */
export function boundsOfBoxes(boxes: readonly LayoutBox[], pad = PAD): Bounds {
  if (boxes.length === 0) return EMPTY_BOUNDS;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < boxes.length; i += 1) {
    const b = boxes[i];
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  minX -= pad;
  minY -= pad;
  maxX += pad;
  maxY += pad;
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

/** The middle of a box — where an edge starts and ends. */
export const centerOf = (b: LayoutBox): { x: number; y: number } => ({
  x: b.x + b.w / 2,
  y: b.y + b.h / 2,
});

/** The row a generation is drawn at. Negative generations are above zero. */
export const rowY = (generation: number): number => generation * ROW_H;

/**
 * Place a neighbourhood.
 *
 * A group stand-in belongs to the row one step further out than its parent:
 * a `down` group under a node in generation g is drawn in generation g + 1,
 * where that kind's children would have been if they had not been folded up.
 * A group whose parent was not sent is dropped rather than guessed at, and its
 * id is reported in `skippedGroupIds`.
 */
export function layoutFocus(input: FocusLayoutInput): FocusLayout {
  const groups = input.groups ?? [];

  // generation -> boxes, built in one pass per class so input order (the
  // server's breadth-first order) survives into the row.
  const byGeneration = new Map<number, LayoutBox[]>();
  const push = (generation: number, box: LayoutBox): void => {
    const row = byGeneration.get(generation);
    if (row) row.push(box);
    else byGeneration.set(generation, [box]);
  };

  const nodeById = new Map<string, LayoutBox>();
  const nodeGeneration = new Map<string, number>();
  const nodes: LayoutBox[] = [];
  for (let i = 0; i < input.nodes.length; i += 1) {
    const n = input.nodes[i];
    if (nodeById.has(n.id)) continue; // a repeated id is one box, not two
    const generation = Number.isFinite(n.generation) ? Math.trunc(n.generation) : 0;
    const box: LayoutBox = { id: n.id, x: 0, y: 0, w: NODE_W, h: NODE_H, generation };
    nodeById.set(n.id, box);
    nodeGeneration.set(n.id, generation);
    nodes.push(box);
    push(generation, box);
  }

  const groupById = new Map<string, LayoutBox>();
  const placedGroups: LayoutBox[] = [];
  const skippedGroupIds: string[] = [];
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    const parentGeneration = nodeGeneration.get(g.parent_id);
    if (parentGeneration === undefined || groupById.has(g.id)) {
      skippedGroupIds.push(g.id);
      continue;
    }
    const generation = parentGeneration + (g.direction === 'up' ? -1 : 1);
    const box: LayoutBox = { id: g.id, x: 0, y: 0, w: GROUP_W, h: GROUP_H, generation };
    groupById.set(g.id, box);
    placedGroups.push(box);
    push(generation, box);
  }

  // Rows, top (most negative generation) first.
  const generations: number[] = [];
  for (const generation of byGeneration.keys()) generations.push(generation);
  generations.sort((a, b) => a - b);

  const rows: LayoutRow[] = [];
  for (let r = 0; r < generations.length; r += 1) {
    const generation = generations[r];
    const boxes = byGeneration.get(generation) as LayoutBox[];
    const y = rowY(generation);

    let rowWidth = 0;
    for (let i = 0; i < boxes.length; i += 1) rowWidth += boxes[i].w + (i > 0 ? COL_GAP : 0);

    let x = -rowWidth / 2;
    for (let i = 0; i < boxes.length; i += 1) {
      const box = boxes[i];
      box.x = x;
      box.y = y;
      x += box.w + COL_GAP;
    }
    rows.push({ generation, y, boxes });
  }

  const all: LayoutBox[] = [];
  for (let i = 0; i < nodes.length; i += 1) all.push(nodes[i]);
  for (let i = 0; i < placedGroups.length; i += 1) all.push(placedGroups[i]);

  return {
    rows,
    nodes,
    groups: placedGroups,
    nodeById,
    groupById,
    bounds: boundsOfBoxes(all),
    skippedGroupIds,
  };
}

/**
 * The cubic path from one box to another, bending vertically because rows are
 * horizontal. Returned as an SVG `d` string; the caller decides the colour and
 * whether it is dashed.
 */
export function edgePath(from: LayoutBox, to: LayoutBox): string {
  const a = centerOf(from);
  const b = centerOf(to);
  // Start and end on the facing edge of each box, so the line does not run
  // under the box it comes from.
  const y1 = a.y < b.y ? from.y + from.h : from.y;
  const y2 = a.y < b.y ? to.y : to.y + to.h;
  const bend = Math.abs(y2 - y1) * 0.45;
  const c1 = a.y < b.y ? y1 + bend : y1 - bend;
  const c2 = a.y < b.y ? y2 - bend : y2 + bend;
  return `M ${a.x} ${y1} C ${a.x} ${c1}, ${b.x} ${c2}, ${b.x} ${y2}`;
}

/** The middle of an edge, where its kind label sits. */
export function edgeLabelPoint(from: LayoutBox, to: LayoutBox): { x: number; y: number } {
  const a = centerOf(from);
  const b = centerOf(to);
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}
