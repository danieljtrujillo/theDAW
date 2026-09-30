/**
 * The overview's density grid (lib/rollDensity): counts per cell across every
 * part, the per-part cache, the point a click lands on, and the paint.
 *
 *   cd frontend && npx tsx src/lib/rollDensity.test.ts
 */
import assert from 'node:assert/strict';
import { densityAlpha, densityPoint, densityRow, paintDensity, rollDensity } from './rollDensity.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const note = (id: string, pitch: number, step: number, length: number): PianoNote => ({ id, note: pitch, step, length, velocity: 90 });
const shape = { cols: 8, rows: 4, totalSteps: 64, lowNote: 60, highNote: 75 };

// Rows run from the top pitch down; the range folds evenly into them.
assert.equal(densityRow(75, shape), 0);
assert.equal(densityRow(60, shape), 3);
assert.equal(densityRow(200, shape), 0, 'above the range sits in the top row');

// Each note counts once in every column it sounds in, in its pitch's row; parts add up.
{
  const violins = [note('a', 75, 0, 8), note('b', 75, 0, 1)];
  const cellos = [note('c', 60, 32, 20), note('d', 90, 0, 4)];
  const d = rollDensity([{ notes: violins }, { notes: cellos }], shape);
  // 8 steps a column: note a covers column 0, b column 0, c columns 4..6.
  assert.equal(d.cells[0 * 8 + 0], 2);
  assert.equal(d.cells[0 * 8 + 1], 0, 'a note ending on a column line does not spill into the next');
  assert.deepEqual([...d.cells.slice(3 * 8, 4 * 8)], [0, 0, 0, 0, 1, 1, 1, 0]);
  assert.equal(d.cells.reduce((s, v) => s + v, 0), 5, 'the note outside the range is left out');
  assert.equal(d.max, 2);
}

// A part's counts are kept per note list: an edit to one part recounts it only, and the sum follows.
{
  const a = [note('a', 70, 0, 4)];
  const b = [note('b', 70, 0, 4)];
  const first = rollDensity([{ notes: a }, { notes: b }], shape);
  assert.equal(first.max, 2);
  const b2 = [...b, note('b2', 70, 0, 4)];
  const second = rollDensity([{ notes: a }, { notes: b2 }], shape);
  assert.equal(second.max, 3);
  const reshaped = rollDensity([{ notes: a }], { ...shape, cols: 4 });
  assert.equal(reshaped.cols, 4, 'a new shape recounts');
  assert.equal(reshaped.cells[densityRow(70, shape) * 4], 1);
}

// A click lands on a step across the length and a pitch down the range.
assert.deepEqual(densityPoint(300, 0, 600, 24, shape), { step: 32, pitch: 75 });
assert.deepEqual(densityPoint(0, 24, 600, 24, shape), { step: 0, pitch: 60 });
assert.deepEqual(densityPoint(-50, 12, 600, 24, shape).step, 0, 'clamped to the start');

// Strength: nothing for an empty cell, then 0.18 up to 1.
assert.equal(densityAlpha(0, 5), 0);
assert.equal(densityAlpha(5, 5), 1);
assert.ok(densityAlpha(1, 100) > 0.18 && densityAlpha(1, 100) < 0.5);

// The paint fills one rect per cell that holds notes.
{
  const d = rollDensity([{ notes: [note('a', 75, 0, 16), note('b', 60, 40, 2)] }], shape);
  const rects: number[][] = [];
  const ctx = {
    fillStyle: '' as string | CanvasGradient | CanvasPattern,
    strokeStyle: '' as string | CanvasGradient | CanvasPattern,
    globalAlpha: 1,
    lineWidth: 1,
    beginPath() {},
    rect() {},
    fill() {},
    stroke() {},
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push([x, y, w, h]);
    },
    clearRect() {},
    setTransform() {},
  };
  const drawn = paintDensity(ctx, d, 400, 24, [10, 20, 30]);
  assert.equal(drawn, 3);
  assert.deepEqual(rects[0], [0, 0, 50, 6]);
  assert.equal(ctx.fillStyle, 'rgba(10,20,30,1)');
}

console.log('rollDensity: ok');
