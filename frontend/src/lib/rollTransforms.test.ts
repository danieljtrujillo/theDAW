/**
 * Roll transforms: each one rewrites the selected notes and leaves every note
 * outside the selection as it was (the same object, in the same place).
 *
 * Run: `npx tsx src/lib/rollTransforms.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { scaleOf } from './motif';
import {
  augmentSelection,
  diminishSelection,
  fragmentSelection,
  invertSelection,
  retrogradeSelection,
  sequenceSelection,
  type RollNoteLike,
} from './rollTransforms';

interface Note extends RollNoteLike {
  velocity: number;
  lane?: number;
}

const mk = (id: string, note: number, step: number, length: number, lane?: number): Note => ({
  id,
  note,
  step,
  length,
  velocity: 90,
  tick: step * 240,
  ticks: length * 240,
  ...(lane !== undefined ? { lane } : {}),
});

// A bass line the selection never touches, and a melody: C4 E4 D4 G4 from step 4.
const bass1 = mk('b1', 36, 0, 16, 1);
const bass2 = mk('b2', 43, 16, 16, 1);
const notes: Note[] = [bass1, mk('m1', 60, 4, 4), mk('m2', 64, 8, 2), mk('m3', 62, 10, 2), bass2, mk('m4', 67, 12, 8)];
const frozen = JSON.stringify(notes);
const SEL = new Set(['m1', 'm2', 'm3', 'm4']);

const byId = (list: Note[]): Map<string, Note> => new Map(list.map((n) => [n.id, n]));
const sel = (list: Note[]): Array<[string, number, number, number]> =>
  list.filter((n) => n.id.startsWith('m')).map((n) => [n.id, n.note, n.step, n.length]);

function untouched(out: Note[], label: string): void {
  assert.equal(out[0], bass1, `${label}: the first bass note is the same object in the same place`);
  const outside = out.filter((n) => !SEL.has(n.id) && !n.id.includes('~'));
  assert.equal(outside.length, 2, `${label}: both bass notes are there`);
  assert.ok(outside[0] === bass1 && outside[1] === bass2, `${label}: the same objects, in their order`);
  assert.deepEqual(outside.map((n) => [n.note, n.step, n.length, n.lane]), [[36, 0, 16, 1], [43, 16, 16, 1]]);
  assert.equal(JSON.stringify(notes), frozen, `${label}: the input list is not changed`);
}

// ── invert ──────────────────────────────────────────────────────────────────
{
  const out = invertSelection(notes, SEL);
  untouched(out, 'invert');
  assert.deepEqual(sel(out), [['m1', 60, 4, 4], ['m2', 56, 8, 2], ['m3', 58, 10, 2], ['m4', 53, 12, 8]]);
  const dia = invertSelection(notes, SEL, { scale: scaleOf('C', 'major') });
  untouched(dia, 'invert diatonic');
  assert.deepEqual(sel(dia).map((r) => r[1]), [60, 57, 59, 53]);
  // Lane, velocity and id ride along; tick follows step.
  const m2 = byId(dia).get('m2');
  assert.equal(m2?.tick, 8 * 240);
  assert.equal(m2?.ticks, 2 * 240);
}

// ── retrograde ──────────────────────────────────────────────────────────────
{
  const out = retrogradeSelection(notes, SEL);
  untouched(out, 'retrograde');
  assert.deepEqual(sel(out), [['m1', 60, 16, 4], ['m2', 64, 14, 2], ['m3', 62, 12, 2], ['m4', 67, 4, 8]]);
  assert.deepEqual(sel(retrogradeSelection(out, SEL)), sel(notes), 'twice is the identity');
}

// ── augment / diminish ──────────────────────────────────────────────────────
{
  const out = augmentSelection(notes, SEL);
  untouched(out, 'augment');
  assert.deepEqual(sel(out), [['m1', 60, 4, 8], ['m2', 64, 12, 4], ['m3', 62, 16, 4], ['m4', 67, 20, 16]]);
  const dim = diminishSelection(notes, SEL);
  untouched(dim, 'diminish');
  assert.deepEqual(sel(dim), [['m1', 60, 4, 2], ['m2', 64, 6, 1], ['m3', 62, 7, 1], ['m4', 67, 8, 4]]);
  assert.deepEqual(sel(diminishSelection(out, SEL)), sel(notes));
}

// ── sequence ────────────────────────────────────────────────────────────────
{
  const out = sequenceSelection(notes, SEL, { steps: 1, interval: -1, scale: scaleOf('C', 'major') });
  untouched(out, 'sequence');
  assert.deepEqual(sel(out), [
    ['m1', 60, 4, 4], ['m2', 64, 8, 2], ['m3', 62, 10, 2], ['m4', 67, 12, 8],
    ['m1~seq1', 59, 20, 4], ['m2~seq1', 62, 24, 2], ['m3~seq1', 60, 26, 2], ['m4~seq1', 65, 28, 8],
  ]);
  assert.equal(out.length, notes.length + 4, 'the copies come after the list');
  assert.equal(out.slice(-4).every((n) => n.id.includes('~seq1')), true);
  const chrom = sequenceSelection(notes, SEL, { steps: 2, interval: 2 });
  assert.deepEqual(chrom.filter((n) => n.id.endsWith('~seq2')).map((n) => n.note), [64, 68, 66, 71]);
}

// ── fragment ────────────────────────────────────────────────────────────────
{
  const head = fragmentSelection(notes, SEL, { part: 'head', count: 2 });
  untouched(head, 'fragment head');
  assert.deepEqual(sel(head), [['m1', 60, 4, 4], ['m2', 64, 8, 2]]);
  assert.equal(head.length, notes.length - 2);
  const tail = fragmentSelection(notes, SEL, { part: 'tail', count: 2 });
  untouched(tail, 'fragment tail');
  assert.deepEqual(sel(tail), [['m3', 62, 4, 2], ['m4', 67, 6, 8]], 'the tail starts where the selection did');
}

// ── a partial selection, and an empty one ───────────────────────────────────
{
  const out = invertSelection(notes, ['m2', 'm3']);
  assert.equal(out[1], notes[1], 'an unselected melody note is the same object');
  assert.equal(out[5], notes[5]);
  assert.deepEqual(sel(out), [['m1', 60, 4, 4], ['m2', 64, 8, 2], ['m3', 66, 10, 2], ['m4', 67, 12, 8]]);
  const none = retrogradeSelection(notes, []);
  assert.deepEqual(none, notes);
  assert.ok(none.every((n, i) => n === notes[i]));
}

console.log('rollTransforms tests passed');
