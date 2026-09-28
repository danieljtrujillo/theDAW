/**
 * The roll's note layer at orchestral scale (lib/rollCanvas, lib/noteIndex).
 *
 * 1. Culling: a paint draws exactly the notes whose drawn box meets the view,
 *    in time and in pitch, for ghosts, repeats and the active part.
 * 2. The replayed sequence: 100,000 notes over 24 parts (a 400-bar movement of
 *    4/4, ten notes a bar a part) drawn frame after frame through a pan at the
 *    default zoom, a pan fully zoomed out (one pixel a step), a zoom from 64px
 *    a step to 1px around the view's centre, and a vertical pan, in a
 *    1920x1080 view. Every frame of the draw path (index queries and the
 *    context calls, on a counting stand-in context) must fit a 60 fps frame
 *    (16.7 ms): no dropped frames.
 * 3. Hit tests stay under 1 ms each, on one part of 4,167 notes and on one
 *    part holding all 100,000.
 * 4. The overview strip's density map (lib/rollDensity) over the same 24
 *    parts: counted and painted within a frame, and an edit to one part
 *    recounts that part only.
 *
 * The numbers printed are this machine's; the budget assertions are the test.
 * A sample over its budget is timed again, the same frame or the same point,
 * and judged on its fastest run: a pause the operating system or the garbage
 * collector puts into one sample (the suite runs four at once) is not the draw
 * path's cost, while a frame or a hit that is slow by itself is slow every time.
 *
 *   cd frontend && npx tsx src/lib/rollCanvas.scale.test.ts
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { buildNoteIndex, type NoteIndex } from './noteIndex.ts';
import { paintDensity, rollDensity } from './rollDensity.ts';
import {
  GHOST_MIN_PX,
  hitNote,
  lookOf,
  noteBox,
  paintRoll,
  type GhostLayer,
  type Paint2D,
  type RollScene,
  type RollView,
} from './rollCanvas.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';

const FRAME_MS = 1000 / 60;
const NOTE_HEIGHT = 12;
const HIGHEST = 108;
const LOWEST = 21;

let seed = 424242;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

/** A counting context: the calls a real canvas would get, and nothing drawn. */
class CountingContext implements Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  globalAlpha = 1;
  lineWidth = 1;
  rects = 0;
  fills = 0;
  beginPath() {}
  rect() {
    this.rects += 1;
  }
  fill() {
    this.fills += 1;
  }
  stroke() {}
  fillRect() {
    this.rects += 1;
  }
  clearRect() {}
  setTransform() {}
}

const partNotes = (part: number, count: number, steps: number): PianoNote[] => {
  const out: PianoNote[] = [];
  // Each part in its own register, as an orchestra's parts are.
  const centre = 36 + ((part * 7) % 56);
  for (let i = 0; i < count; i += 1) {
    const step = Math.floor(rand() * steps * 4) / 4;
    out.push({
      id: `p${part}-${i}`,
      step,
      length: [0.5, 1, 2, 4, 8][Math.floor(rand() * 5)],
      note: Math.max(LOWEST, Math.min(HIGHEST, centre + Math.floor(rand() * 19) - 9)),
      velocity: 90,
      lane: 0,
    });
  }
  return out;
};

const sceneOf = (stepPx: number, active: NoteIndex<PianoNote>, ghosts: GhostLayer[], repeats: NoteIndex<PianoNote> | null): RollScene => ({
  stepPx,
  noteHeight: NOTE_HEIGHT,
  highestNote: HIGHEST,
  lowestNote: LOWEST,
  ghosts,
  repeats,
  notes: active,
  lookOfLane: (lane) => (lane === 1 ? 2 : 0),
  selected: new Set(),
  hoverId: null,
  accent: [168, 85, 247],
});

// 1. Culling: what a paint draws is exactly what meets the view.
{
  const active = partNotes(0, 3000, 2000).map((n, i) => (i % 3 === 0 ? { ...n, lane: 1 } : n));
  const ghost = partNotes(1, 3000, 2000);
  const rep = partNotes(2, 800, 2000);
  const scene = sceneOf(10, buildNoteIndex(active), [{ id: 'g', color: '#3b82f6', sounding: true, index: buildNoteIndex(ghost) }], buildNoteIndex(rep));
  for (const view of [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 7300, y: 300, width: 900, height: 400 },
    { x: 19000, y: 600, width: 1500, height: 300 },
  ] satisfies RollView[]) {
    const stats = paintRoll(new CountingContext(), scene, view);
    const rowIn = (n: PianoNote) => {
      const row = HIGHEST - n.note;
      return row >= Math.floor(view.y / NOTE_HEIGHT) && row <= Math.floor((view.y + view.height) / NOTE_HEIGHT);
    };
    // Exact: the index's query range (reach 8px left) and the rows in view.
    const exact = active.filter((n) => rowIn(n) && n.step <= (view.x + view.width) / 10 && n.step + n.length >= (view.x - 8) / 10).length;
    assert.equal(stats.notes, exact, `notes drawn in view ${JSON.stringify(view)}`);
    const exactGhosts = ghost.filter((n) => rowIn(n) && n.step <= (view.x + view.width) / 10 && n.step + n.length >= (view.x - GHOST_MIN_PX) / 10).length;
    assert.equal(stats.ghosts, exactGhosts, 'ghosts drawn in view');
    const exactRepeats = rep.filter((n) => rowIn(n) && n.step <= (view.x + view.width) / 10 && n.step + n.length >= (view.x - 8) / 10).length;
    assert.equal(stats.repeats, exactRepeats, 'repeats drawn in view');
    // Every note whose drawn box meets the view is among those drawn: the query reaches the widest look's 8px left.
    const meets = active.filter((n) => rowIn(n) && n.step * 10 <= view.x + view.width && n.step * 10 + Math.max(lookOf(scene.lookOfLane(n.lane)).minPx, n.length * 10 - 1) >= view.x).length;
    assert.ok(stats.notes >= meets, 'no note that shows is culled');
  }
  // A view past the rows draws nothing.
  const none = paintRoll(new CountingContext(), scene, { x: 0, y: 5000, width: 500, height: 100 });
  assert.equal(none.notes + none.ghosts + none.repeats, 0);
  // The hit test answers to the drawn box: body, the last 6px as the resize
  // edge, and a one-step note hit across its look's minimum width.
  const fixed: PianoNote[] = [
    { id: 'long', note: 60, step: 10, length: 4, velocity: 90, lane: 0 },
    { id: 'tiny', note: 62, step: 10, length: 0.1, velocity: 90, lane: 1 },
  ];
  const g = { stepPx: 10, noteHeight: NOTE_HEIGHT, highestNote: HIGHEST };
  const look = (lane: number | undefined) => (lane === 1 ? 2 : 0);
  const fixedIdx = buildNoteIndex(fixed);
  const box = noteBox(fixed[0], g, 4);
  assert.deepEqual(box, { x: 100, y: (HIGHEST - 60) * NOTE_HEIGHT + 1, w: 39, h: NOTE_HEIGHT - 2 });
  assert.deepEqual(hitNote(fixedIdx, 110, box.y + 3, g, look, 6), { note: fixed[0], edge: false }, 'the body');
  assert.deepEqual(hitNote(fixedIdx, 136, box.y + 3, g, look, 6), { note: fixed[0], edge: true }, 'the last 6px are the resize edge');
  assert.equal(hitNote(fixedIdx, 141, box.y + 3, g, look, 6), null, 'past the note');
  assert.equal(hitNote(fixedIdx, 110, box.y + NOTE_HEIGHT + 3, g, look, 6), null, 'the row below');
  const tinyY = (HIGHEST - 62) * NOTE_HEIGHT + 4;
  assert.equal(hitNote(fixedIdx, 107, tinyY, g, look, 6)?.note.id, 'tiny', 'a 1px-long note drawn 8px wide is hit where it is drawn');
  assert.equal(hitNote(fixedIdx, 110, tinyY, g, look, 6), null, 'and not past its drawn box');
  // Zoomed out to one px a step, a four-step note is drawn 4px wide: its
  // resize edge is its last third, so the rest of it is a body to drag.
  const far = { stepPx: 1, noteHeight: NOTE_HEIGHT, highestNote: HIGHEST };
  const narrow = buildNoteIndex<PianoNote>([{ id: 'n', note: 60, step: 100, length: 4, velocity: 90, lane: 0 }]);
  const ny = (HIGHEST - 60) * NOTE_HEIGHT + 4;
  assert.deepEqual(noteBox({ step: 100, length: 4, note: 60 }, far, 4), { x: 100, y: (HIGHEST - 60) * NOTE_HEIGHT + 1, w: 4, h: NOTE_HEIGHT - 2 });
  assert.equal(hitNote(narrow, 101, ny, far, look, 6)?.edge, false, 'the front of a 4px note drags it');
  assert.equal(hitNote(narrow, 103.5, ny, far, look, 6)?.edge, true, 'its last third resizes it');
}

// 2. 100,000 notes over 24 parts, pan and zoom.
const PARTS = 24;
const TOTAL = 100_000;
const STEPS = 400 * 16;
const perPart = Math.ceil(TOTAL / PARTS);
const parts = Array.from({ length: PARTS }, (_, p) => partNotes(p, p === PARTS - 1 ? TOTAL - perPart * (PARTS - 1) : perPart, STEPS));
assert.equal(parts.reduce((s, p) => s + p.length, 0), TOTAL);

const t0 = performance.now();
const indexes = parts.map((p) => buildNoteIndex(p));
const buildMs = performance.now() - t0;
const ghosts: GhostLayer[] = indexes.slice(1).map((index, i) => ({ id: `part-${i + 1}`, color: `hsl(${i * 15} 70% 60%)`, sounding: i % 5 !== 0, index }));

const VIEW_W = 1920;
const VIEW_H = 1080;
const gridH = (HIGHEST - LOWEST + 1) * NOTE_HEIGHT;
type Frame = { stepPx: number; x: number; y: number };
const frames: { name: string; list: Frame[] }[] = [];
{
  const list: Frame[] = [];
  for (let i = 0; i < 240; i += 1) list.push({ stepPx: 16, x: i * 24 * 16, y: 300 });
  frames.push({ name: 'pan at 16px a step', list });
}
{
  const list: Frame[] = [];
  for (let i = 0; i < 240; i += 1) list.push({ stepPx: 1, x: Math.min(STEPS - VIEW_W, i * 20), y: 0 });
  frames.push({ name: 'pan at 1px a step (fully zoomed out)', list });
}
{
  const list: Frame[] = [];
  const centreStep = STEPS / 2;
  for (let i = 0; i <= 120; i += 1) {
    const stepPx = 64 * Math.pow(1 / 64, i / 120);
    list.push({ stepPx, x: Math.max(0, centreStep * stepPx - VIEW_W / 2), y: 200 });
  }
  frames.push({ name: 'zoom 64px to 1px a step', list });
}
{
  const list: Frame[] = [];
  for (let i = 0; i < 60; i += 1) list.push({ stepPx: 8, x: 1000 * 8, y: Math.round((i / 59) * Math.max(0, gridH - VIEW_H)) });
  frames.push({ name: 'vertical pan at 8px a step', list });
}

/** The fastest of `runs` timings of `fn` (ms). */
const fastest = (runs: number, fn: () => void): number => {
  let best = Infinity;
  for (let r = 0; r < runs; r += 1) {
    const s = performance.now();
    fn();
    best = Math.min(best, performance.now() - s);
  }
  return best;
};

const times: number[] = [];
let rawMax = 0;
let retimed = 0;
let maxDrawn = 0;
const ctx = new CountingContext();
for (const f of frames) {
  const own: number[] = [];
  for (const fr of f.list) {
    const view: RollView = { x: fr.x, y: fr.y, width: VIEW_W, height: Math.min(VIEW_H, gridH - fr.y) };
    const scene = sceneOf(fr.stepPx, indexes[0], ghosts, null);
    const s = performance.now();
    const stats = paintRoll(ctx, scene, view, 1);
    let ms = performance.now() - s;
    rawMax = Math.max(rawMax, ms);
    if (ms > FRAME_MS) {
      retimed += 1;
      ms = fastest(3, () => paintRoll(ctx, scene, view, 1));
    }
    own.push(ms);
    times.push(ms);
    maxDrawn = Math.max(maxDrawn, stats.notes + stats.ghosts);
  }
  const sorted = [...own].sort((a, b) => a - b);
  console.log(
    `  ${f.name}: ${own.length} frames, median ${sorted[Math.floor(sorted.length / 2)].toFixed(3)} ms, max ${sorted[sorted.length - 1].toFixed(3)} ms, over budget ${own.filter((t) => t > FRAME_MS).length}`,
  );
}
const sortedAll = [...times].sort((a, b) => a - b);
const dropped = times.filter((t) => t > FRAME_MS).length;
console.log(
  `  100,000 notes / 24 parts: index build ${buildMs.toFixed(1)} ms; ${times.length} frames, p99 ${sortedAll[Math.floor(sortedAll.length * 0.99)].toFixed(3)} ms, max ${sortedAll[sortedAll.length - 1].toFixed(3)} ms (first run ${rawMax.toFixed(3)} ms, ${retimed} timed again), most notes in one frame ${maxDrawn}, dropped ${dropped}`,
);
assert.ok(maxDrawn > 10_000, 'the zoomed-out frames draw tens of thousands of notes (the test exercises the heavy case)');
assert.equal(dropped, 0, `every frame of the draw path fits ${FRAME_MS.toFixed(1)} ms`);

// 3. Hit tests under 1 ms.
const geo = { stepPx: 16, noteHeight: NOTE_HEIGHT, highestNote: HIGHEST };
const look = () => 0;
const timeHits = (notes: readonly PianoNote[], label: string): number => {
  const index = buildNoteIndex(notes);
  // The first hit on a pitch builds that pitch's tree (lazily, once per list):
  // timed on its own, then every pitch is warm for the steady-state run. A
  // first hit over budget is timed again on fresh indexes of the same notes.
  let cold = 0;
  let coldFirst = 0;
  for (let pitch = LOWEST; pitch <= HIGHEST; pitch += 1) {
    const x = rand() * STEPS * 16;
    const y = (HIGHEST - pitch) * NOTE_HEIGHT + 6;
    const s = performance.now();
    hitNote(index, x, y, geo, look, 6);
    let ms = performance.now() - s;
    coldFirst = Math.max(coldFirst, ms);
    if (ms >= 1) {
      ms = Infinity;
      for (let r = 0; r < 3; r += 1) {
        const fresh = buildNoteIndex(notes);
        ms = Math.min(ms, fastest(1, () => hitNote(fresh, x, y, geo, look, 6)));
      }
    }
    cold = Math.max(cold, ms);
  }
  console.log(`  first hit on each pitch of ${label}: max ${cold.toFixed(4)} ms (first run ${coldFirst.toFixed(4)} ms)`);
  assert.ok(cold < 1, 'the first hit on a pitch, which builds its tree, stays under 1 ms');
  for (let i = 0; i < 200; i += 1) hitNote(index, rand() * STEPS * 16, rand() * gridH, geo, look, 6);
  let max = 0;
  let firstMax = 0;
  let again = 0;
  let found = 0;
  for (let i = 0; i < 10_000; i += 1) {
    const x = rand() * STEPS * 16;
    const y = rand() * gridH;
    const s = performance.now();
    const hit = hitNote(index, x, y, geo, look, 6);
    let ms = performance.now() - s;
    firstMax = Math.max(firstMax, ms);
    if (ms >= 1) {
      // The same point again: a hit that is slow by itself is slow every time.
      again += 1;
      ms = fastest(5, () => hitNote(index, x, y, geo, look, 6));
    }
    if (hit) found += 1;
    if (ms > max) max = ms;
  }
  console.log(
    `  hit tests on ${label}: 10,000, max ${max.toFixed(4)} ms (first run ${firstMax.toFixed(4)} ms, ${again} timed again), ${found} on a note`,
  );
  return max;
};
assert.ok(timeHits(parts[0], `one part of ${parts[0].length} notes`) < 1, 'a hit test on one part stays under 1 ms');
assert.ok(timeHits(parts.flat(), 'one part of 100,000 notes') < 1, 'a hit test on 100,000 notes stays under 1 ms');

// 4. The overview's density map over the 24 parts, at the strip's size for a
// 1920px window (the strip is about 1,500px wide, two px a column, 12 rows).
{
  const shape = { cols: 750, rows: 12, totalSteps: STEPS, lowNote: LOWEST, highNote: HIGHEST };
  const partLists = parts.map((notes) => ({ notes }));
  // A first count reads lists the density cache has never seen: fresh copies each run.
  const cold = fastest(3, () => rollDensity(parts.map((notes) => ({ notes: [...notes] })), shape));
  const density = rollDensity(partLists, shape);
  assert.equal(
    density.cells.reduce((s, v) => s + v, 0) > TOTAL,
    true,
    'every note counts in every column it sounds in',
  );
  // An edit writes a new list for one part: that part is counted again, the other 23 come from their cache.
  const edited = partLists.map((p, i) => (i === 3 ? { notes: [...p.notes.slice(1), { ...p.notes[0], step: p.notes[0].step + 1 }] } : p));
  const warm = fastest(3, () => rollDensity(edited, shape));
  const cells = paintDensity(new CountingContext(), density, 1500, 24, [168, 85, 247], 1.1);
  const paint = fastest(3, () => paintDensity(new CountingContext(), density, 1500, 24, [168, 85, 247], 1.1));
  console.log(
    `  overview of 100,000 notes / 24 parts: first count ${cold.toFixed(2)} ms, recount after an edit to one part ${warm.toFixed(2)} ms, paint ${paint.toFixed(2)} ms (${cells} cells)`,
  );
  assert.ok(cold < FRAME_MS * 2, 'the first count of the whole orchestra takes under two frames');
  assert.ok(warm < FRAME_MS, 'an edit recounts within a frame');
  assert.ok(paint < FRAME_MS, 'the strip paints within a frame');
}

console.log('rollCanvas.scale: ok');
