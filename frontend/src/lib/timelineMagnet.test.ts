/**
 * Clip magnetism on the EDIT timeline, under plain node.
 *
 * Pins: that a clip's trailing edge sticks to a neighbour's start (the flush
 * butt-join the grid could never express); that the nearest candidate wins
 * even against the grid; that nothing outside the tolerance moves; that the
 * clip being dragged is never a target for itself; and that a tie resolves the
 * same way every time.
 *
 * Run: `npx tsx src/lib/timelineMagnet.test.ts` (or just `npm test`).
 */
import assert from 'node:assert/strict';
import { magnetStart, magnetTargetsFor } from './timelineMagnet';

const clip = (id: string, startSec: number, durationSec: number) => ({ id, startSec, durationSec });
const none = { clipEdges: [], cues: [] };

// -- target collection -------------------------------------------------------
{
  const t = magnetTargetsFor([clip('a', 0, 4), clip('b', 10, 2)], []);
  assert.deepEqual(t.clipEdges, [0, 4, 10, 12], 'both edges of every clip');
}
{
  const t = magnetTargetsFor([clip('a', 0, 4), clip('b', 10, 2)], ['a']);
  assert.deepEqual(t.clipEdges, [10, 12], 'the dragged clip is not its own target');
}
{
  const t = magnetTargetsFor([], [], [3, null, undefined, NaN, 7]);
  assert.deepEqual(t.cues, [3, 7], 'null/undefined/NaN cues are dropped');
}

// -- the butt-join: trailing edge onto a neighbour's start -------------------
{
  const targets = magnetTargetsFor([clip('next', 10, 2)], ['me']);
  assert.equal(magnetStart(5.9, 4, targets, 0.25, null), 6, 'end snaps flush to 10');
}
{
  const targets = magnetTargetsFor([clip('prev', 0, 4)], ['me']);
  assert.equal(magnetStart(4.1, 2, targets, 0.25, null), 4, 'start snaps flush to 4');
}

// -- nearest wins, grid included --------------------------------------------
{
  const targets = { clipEdges: [4.0], cues: [] };
  assert.equal(magnetStart(4.05, 1, targets, 0.5, 3.95), 4.0, 'closer edge beats grid');
  assert.equal(magnetStart(4.4, 1, targets, 0.5, 4.45), 4.45, 'closer grid beats edge');
}

// -- tolerance is a hard boundary -------------------------------------------
{
  const targets = { clipEdges: [4.0], cues: [] };
  assert.equal(magnetStart(9, 1, targets, 0.25, null), 9, 'far from everything: unmoved');
  assert.equal(magnetStart(9, 1, targets, 0.25, 8.75), 8.75, 'far from an edge still grids');
  assert.equal(magnetStart(5, 1, none, 0, 4.5), 4.5, 'zero tolerance disables magnetism');
}

// -- never negative ----------------------------------------------------------
{
  const targets = { clipEdges: [0], cues: [] };
  assert.equal(magnetStart(0.1, 4, targets, 0.5, null), 0, 'clamped at the timeline start');
}

// -- deterministic ties ------------------------------------------------------
{
  const targets = { clipEdges: [4.5, 5.5], cues: [] };
  assert.equal(magnetStart(5, 1, targets, 1, null), 4.5, 'ties resolve to the earlier edge');
  assert.equal(magnetStart(5, 1, targets, 1, null), 4.5, 'and do so repeatably');
}

// -- cues stick too ----------------------------------------------------------
{
  const targets = magnetTargetsFor([], [], [30]);
  assert.equal(magnetStart(29.9, 2, targets, 0.25, null), 30, 'start sticks to the playhead');
  assert.equal(magnetStart(28.1, 2, targets, 0.25, null), 28, 'end sticks to the playhead');
}

console.log('timelineMagnet tests passed');
