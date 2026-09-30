/**
 * An EDIT MIDI clip's notes on a viewport-culled canvas (lib/clipNotesCanvas):
 * the layout in seconds on the clip's own clock, the paint drawing only the
 * notes in the visible span, trims at the clip's edges, and the geometry the
 * DOM notes had (row, height, strength by velocity).
 *
 *   cd frontend && npx tsx src/lib/clipNotesCanvas.test.ts
 */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { clipNoteLayout, paintClipNotes } from './clipNotesCanvas.ts';
import { stepClock } from './rollTempo.ts';
import type { PianoNote } from '../state/pianoRollStore.ts';
import type { Paint2D } from './rollCanvas.ts';

class Recorder implements Paint2D {
  fillStyle: string | CanvasGradient | CanvasPattern = '';
  strokeStyle: string | CanvasGradient | CanvasPattern = '';
  globalAlpha = 1;
  lineWidth = 1;
  rects: { x: number; y: number; w: number; h: number; alpha: number }[] = [];
  beginPath() {}
  rect() {}
  fill() {}
  stroke() {}
  fillRect(x: number, y: number, w: number, h: number) {
    this.rects.push({ x, y, w, h, alpha: this.globalAlpha });
  }
  clearRect() {
    this.rects = [];
  }
  setTransform() {}
}

const note = (id: string, pitch: number, step: number, length: number, velocity = 127): PianoNote => ({ id, note: pitch, step, length, velocity });

// 120 BPM: a 16th is 0.125 s.
const clock = stepClock(120, undefined);
const notes = [note('a', 60, 0, 4), note('b', 64, 8, 4, 1), note('c', 67, 32, 8)];
const layout = clipNoteLayout(notes, clock, 0);
assert.ok(layout);
assert.deepEqual([layout.lo, layout.hi], [59, 68], 'a semitone of headroom on each side');
assert.deepEqual(layout.index.query(0, 10).map((n) => [n.id, n.step, n.length]), [['a', 0, 0.5], ['b', 1, 0.5], ['c', 4, 1]]);
assert.equal(clipNoteLayout(notes, clock, 0), layout, 'kept per list, clock and trim');
assert.notEqual(clipNoteLayout(notes, clock, 0.5), layout, 'a new trim lays out again');
assert.equal(clipNoteLayout([], clock, 0), null);

// The whole clip in view: every note, at the DOM version's geometry.
{
  const ctx = new Recorder();
  const drawn = paintClipNotes(ctx, layout, { zoom: 100, clipDur: 6, fromPx: 0, toPx: 600, height: 90, color: '#ff0000', selected: false });
  assert.equal(drawn, 3);
  const rows = layout.hi - layout.lo;
  const rowPx = 90 / (rows + 1);
  const { alpha, ...box } = ctx.rects[0];
  assert.deepEqual(box, { x: 0, y: (68 - 60) * rowPx, w: 50, h: rowPx - 0.45 });
  assert.ok(Math.abs(alpha - 0.82) < 1e-9, 'full velocity: 0.42 + 0.4');
  assert.ok(Math.abs(ctx.rects[1].alpha - (0.42 + (1 / 127) * 0.4)) < 1e-9, 'strength by velocity');
  assert.equal(ctx.fillStyle, '#ff0000');
}

// Only the visible span draws: a window over the middle of the clip draws the note there alone.
{
  const ctx = new Recorder();
  const drawn = paintClipNotes(ctx, layout, { zoom: 100, clipDur: 6, fromPx: 300, toPx: 600, height: 90, color: '#fff', selected: true });
  assert.equal(drawn, 1);
  assert.equal(ctx.rects[0].x, 400, 'drawn at clip px (the canvas transform shifts the window)');
  assert.equal(paintClipNotes(new Recorder(), layout, { zoom: 100, clipDur: 6, fromPx: 600, toPx: 600, height: 90, color: '#fff', selected: false }), 0, 'an empty window draws nothing');
}

// A clip trimmed to 2 s draws the played part of each note only; a trim into the source shifts every note.
{
  const ctx = new Recorder();
  assert.equal(paintClipNotes(ctx, layout, { zoom: 100, clipDur: 0.25, fromPx: 0, toPx: 25, height: 90, color: '#fff', selected: false }), 1);
  assert.deepEqual(ctx.rects.map((r) => [r.x, r.w]), [[0, 25]], 'a clip cut at 0.25 s draws the first note to its end and no other');
  const trimmed = clipNoteLayout(notes, clock, 1);
  assert.ok(trimmed);
  const t = new Recorder();
  paintClipNotes(t, trimmed, { zoom: 100, clipDur: 5, fromPx: 0, toPx: 500, height: 90, color: '#fff', selected: false });
  assert.deepEqual(t.rects.map((r) => r.x), [0, 300], 'the note under the trim draws from the clip edge');
}

// A tempo map: a note inside a slower bar draws where it plays.
{
  const slow = stepClock(120, [{ beat: 0, bpm: 120 }, { beat: 4, bpm: 60 }]);
  const l = clipNoteLayout(notes, slow, 0);
  assert.ok(l);
  const c = l.index.query(0, 100).find((n) => n.id === 'c');
  assert.ok(c && Math.abs(c.step - (2 + 4 * 1)) < 1e-6, 'step 32 is beat 8: 2 s to beat 4, then 1 s a beat');
}

// A long part: 40,000 notes over forty minutes, scrolled across a 1920px view at 20px a second.
{
  const long: PianoNote[] = [];
  for (let i = 0; i < 40_000; i += 1) long.push(note(`n${i}`, 48 + (i % 24), i * 0.8, 1 + (i % 3)));
  const l = clipNoteLayout(long, clock, 0);
  assert.ok(l);
  const dur = (40_000 * 0.8 + 4) * 0.125;
  let max = 0;
  let most = 0;
  const ctx = new Recorder();
  for (let x = 0; x < dur * 20; x += 1920 / 4) {
    const s = performance.now();
    const drawn = paintClipNotes(ctx, l, { zoom: 20, clipDur: dur, fromPx: x, toPx: x + 1920, height: 60, color: '#fff', selected: false });
    max = Math.max(max, performance.now() - s);
    most = Math.max(most, drawn);
  }
  console.log(`  40,000-note clip, 1920px windows: most drawn ${most}, slowest paint ${max.toFixed(3)} ms`);
  assert.ok(most < 1500, 'a window draws the notes in it, not the clip');
}

console.log('clipNotesCanvas: ok');
