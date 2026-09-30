// Run with: npx tsx src/lineagescale/focusLayout.test.ts
//
// The layout is pure arithmetic, so its invariants can be stated exactly:
//
//   * a generation is a ROW — every box in one generation shares a y, sources
//     are above the focus and derivatives below, and two generations never
//     share a row;
//   * no two boxes overlap, so nothing can hide behind anything;
//   * the bounds contain every box (that is what a viewBox is for) and the
//     empty case is a real box, not NaN;
//   * a folded group sits one step further out than the node it hangs off, and
//     a group whose parent was not sent is reported rather than guessed at;
//   * AND THE ONE THAT MATTERS AT SCALE: the reduction to bounds is a loop.
//     `Math.min(...xs)` over 194,833 positions is the "Maximum call stack size
//     exceeded" this whole module exists to escape, so the helper is run over
//     200,000 boxes here and the source is checked for the spread.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  COL_GAP, EMPTY_BOUNDS, GROUP_H, NODE_H, NODE_W, PAD, ROW_H,
  boundsOfBoxes, centerOf, edgeLabelPoint, edgePath, layoutFocus, rowY,
  type LayoutBox,
} from './focusLayout.ts';

const node = (id: string, generation: number) => ({ id, generation });

/** Do two boxes share any area? Touching edges is not overlapping. */
const overlaps = (a: LayoutBox, b: LayoutBox): boolean =>
  a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

// ── the empty drawing ───────────────────────────────────────────────────────
{
  const layout = layoutFocus({ nodes: [] });
  assert.deepEqual(layout.bounds, EMPTY_BOUNDS);
  assert.equal(layout.rows.length, 0);
  assert.equal(layout.nodes.length, 0);
  for (const v of Object.values(layout.bounds)) {
    assert.ok(Number.isFinite(v), 'an empty layout still has finite bounds — a viewBox needs numbers');
  }
}

// ── generations are rows, sources above, derivatives below ──────────────────
{
  const layout = layoutFocus({
    nodes: [
      node('gp', -2),
      node('p1', -1), node('p2', -1),
      node('focus', 0),
      node('c1', 1), node('c2', 1), node('c3', 1),
      node('g1', 2),
    ],
  });

  const y = (id: string) => (layout.nodeById.get(id) as LayoutBox).y;

  assert.equal(y('focus'), 0, 'the focus is the origin row');
  assert.ok(y('p1') < y('focus'), 'a source is drawn ABOVE the focus');
  assert.ok(y('gp') < y('p1'), 'and its own source is above it again');
  assert.ok(y('c1') > y('focus'), 'a derivative is drawn BELOW the focus');
  assert.ok(y('g1') > y('c1'));

  assert.equal(y('p1'), y('p2'), 'one generation is one row');
  assert.equal(y('c1'), y('c2'));
  assert.equal(y('c2'), y('c3'));
  assert.equal(y('c1') - y('focus'), ROW_H, 'consecutive generations are one row pitch apart');
  assert.equal(rowY(-2), -2 * ROW_H);

  // Rows come back top-first, which is the order they are drawn in.
  assert.deepEqual(layout.rows.map((r) => r.generation), [-2, -1, 0, 1, 2]);

  // Every row is centred on x = 0, so a family reads as a column.
  for (const row of layout.rows) {
    let minX = Infinity;
    let maxX = -Infinity;
    for (const b of row.boxes) {
      if (b.x < minX) minX = b.x;
      if (b.x + b.w > maxX) maxX = b.x + b.w;
    }
    assert.ok(Math.abs(minX + maxX) < 1e-9, `row ${row.generation} is centred on 0`);
  }

  // Neighbours in a row are exactly COL_GAP apart — no overlap, no drift.
  const c1 = layout.nodeById.get('c1') as LayoutBox;
  const c2 = layout.nodeById.get('c2') as LayoutBox;
  assert.equal(c2.x - (c1.x + c1.w), COL_GAP);
  assert.equal(c1.w, NODE_W);
  assert.equal(c1.h, NODE_H);

  // Exhaustive: nothing overlaps anything.
  for (let i = 0; i < layout.nodes.length; i += 1) {
    for (let j = i + 1; j < layout.nodes.length; j += 1) {
      assert.ok(
        !overlaps(layout.nodes[i], layout.nodes[j]),
        `${layout.nodes[i].id} overlaps ${layout.nodes[j].id}`,
      );
    }
  }

  // Bounds contain every box, with the pad and nothing more.
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const b of layout.nodes) {
    if (b.x < minX) minX = b.x;
    if (b.y < minY) minY = b.y;
    if (b.x + b.w > maxX) maxX = b.x + b.w;
    if (b.y + b.h > maxY) maxY = b.y + b.h;
  }
  assert.equal(layout.bounds.minX, minX - PAD);
  assert.equal(layout.bounds.minY, minY - PAD);
  assert.equal(layout.bounds.maxX, maxX + PAD);
  assert.equal(layout.bounds.maxY, maxY + PAD);
  assert.equal(layout.bounds.width, layout.bounds.maxX - layout.bounds.minX);
  assert.equal(layout.bounds.height, layout.bounds.maxY - layout.bounds.minY);
}

// ── a repeated id is one box ────────────────────────────────────────────────
{
  const layout = layoutFocus({ nodes: [node('a', 0), node('a', 1), node('b', 1)] });
  assert.equal(layout.nodes.length, 2, 'the second copy of an id is dropped, not stacked');
  assert.equal((layout.nodeById.get('a') as LayoutBox).generation, 0, 'the first placement wins');
}

// ── folded groups sit one step further out than their parent ────────────────
{
  const layout = layoutFocus({
    nodes: [node('p', -1), node('focus', 0)],
    groups: [
      { id: 'g-down', parent_id: 'focus', direction: 'down' },
      { id: 'g-up', parent_id: 'focus', direction: 'up' },
      { id: 'g-orphan', parent_id: 'not-here', direction: 'down' },
    ],
  });

  const down = layout.groupById.get('g-down') as LayoutBox;
  const up = layout.groupById.get('g-up') as LayoutBox;
  assert.equal(down.generation, 1, 'a folded set of derivatives sits where they would have been');
  assert.equal(up.generation, -1, 'and a folded set of sources sits with the sources');
  assert.equal(down.y, ROW_H);
  assert.equal(down.h, GROUP_H);
  assert.deepEqual(layout.skippedGroupIds, ['g-orphan'], 'an unplaceable group is reported, not invented');
  assert.equal(layout.groupById.has('g-orphan'), false);

  // The 'up' group shares the sources' row and does not land on top of 'p'.
  const p = layout.nodeById.get('p') as LayoutBox;
  assert.equal(up.y, p.y);
  assert.ok(!overlaps(up, p));

  // Bounds cover groups as well as nodes.
  assert.ok(layout.bounds.maxY >= down.y + down.h + PAD - 1e-9);
}

// ── edge geometry: a line leaves a box and arrives at the other one ─────────
{
  const layout = layoutFocus({ nodes: [node('child', 1), node('parent', 0)] });
  const child = layout.nodeById.get('child') as LayoutBox;
  const parent = layout.nodeById.get('parent') as LayoutBox;

  const d = edgePath(child, parent);
  assert.ok(d.startsWith('M '), d);
  assert.ok(d.includes(' C '), 'a curve, so two lines between the same rows are distinguishable');
  for (const n of d.match(/-?\d+(\.\d+)?/g) ?? []) {
    assert.ok(Number.isFinite(Number(n)), `every coordinate is a number: ${d}`);
  }

  const mid = edgeLabelPoint(child, parent);
  assert.equal(mid.y, (centerOf(child).y + centerOf(parent).y) / 2, 'the label sits between the rows');
}

// ── 1,500 nodes: the contract's budget ceiling, laid out fast ───────────────
{
  const nodes = [];
  for (let i = 0; i < 1500; i += 1) nodes.push(node(`n${i}`, (i % 9) - 4));
  const started = Date.now();
  const layout = layoutFocus({ nodes });
  const elapsed = Date.now() - started;

  assert.equal(layout.nodes.length, 1500);
  assert.ok(elapsed < 250, `1,500 nodes laid out in ${elapsed}ms`);
  assert.ok(Number.isFinite(layout.bounds.width) && layout.bounds.width > 0);
  assert.equal(layout.rows.length, 9);

  // No overlap, checked structurally rather than by 1.1M pair comparisons:
  // each row's boxes are disjoint along x, and the rows are disjoint along y.
  const rowsByY = new Map<number, LayoutBox[]>();
  for (const b of layout.nodes) {
    const row = rowsByY.get(b.y);
    if (row) row.push(b);
    else rowsByY.set(b.y, [b]);
  }
  assert.equal(rowsByY.size, 9, 'nine generations, nine rows');
  for (const [, boxes] of rowsByY) {
    const sorted = boxes.slice().sort((a, b) => a.x - b.x);
    for (let i = 1; i < sorted.length; i += 1) {
      assert.ok(
        sorted[i].x >= sorted[i - 1].x + sorted[i - 1].w,
        'boxes in a row never overlap, however many there are',
      );
    }
  }
  const ys = Array.from(rowsByY.keys()).sort((a, b) => a - b);
  for (let i = 1; i < ys.length; i += 1) {
    assert.ok(ys[i] >= ys[i - 1] + NODE_H, 'rows never overlap either');
  }
}

// ── 200,000 boxes through the bounds helper: the stack-overflow guard ───────
{
  const many: LayoutBox[] = [];
  for (let i = 0; i < 200_000; i += 1) {
    many.push({ id: `p${i}`, x: i % 977, y: i % 1013, w: NODE_W, h: NODE_H, generation: 0 });
  }
  const started = Date.now();
  const bounds = boundsOfBoxes(many, 0);
  const elapsed = Date.now() - started;

  assert.equal(bounds.minX, 0);
  assert.equal(bounds.minY, 0);
  assert.equal(bounds.maxX, 976 + NODE_W);
  assert.equal(bounds.maxY, 1012 + NODE_H);
  assert.ok(elapsed < 500, `200,000 boxes reduced in ${elapsed}ms`);
}

// ── and the spread can never come back ──────────────────────────────────────
{
  const raw = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'focusLayout.ts'),
    'utf8',
  );
  // Comments are stripped first: the module's own header NAMES the bug, and a
  // check that cannot tell the warning from the crime is no check at all.
  const source = raw.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  assert.ok(
    source.includes('export function boundsOfBoxes'),
    'the stripper kept the code it is meant to check',
  );
  assert.ok(
    !/Math\.(min|max)\s*\(\s*\.\.\./.test(source),
    'Math.min(...positions) is the 194k-node crash: the reduction stays a loop',
  );
  assert.ok(
    !/Math\.(min|max)\.apply/.test(source),
    'and .apply(null, array) is the same crash wearing a different hat',
  );
}

console.log('focusLayout: all assertions passed');
