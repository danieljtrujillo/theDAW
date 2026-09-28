/**
 * The interval index (lib/noteIndex) against brute force: range queries, rect
 * queries, hit tests with a drawn minimum, traversal order, bad values, the
 * already-sorted fast path, and the per-list cache.
 *
 *   cd frontend && npx tsx src/lib/noteIndex.test.ts
 */
import assert from 'node:assert/strict';
import { buildNoteIndex, noteIndexOf, type IndexedNote } from './noteIndex.ts';

interface N extends IndexedNote {
  id: string;
}

// A seeded generator, so a failure replays.
let seed = 12345;
const rand = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};

const make = (count: number, span: number): N[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    step: Math.round(rand() * span * 4) / 4,
    length: rand() < 0.1 ? 0 : Math.round(rand() * 32 * 4) / 4,
    note: 30 + Math.floor(rand() * 60),
  }));

const ids = (xs: readonly N[]) => xs.map((n) => n.id).sort();

// Range queries: every note with start <= to and end >= from, in start order.
{
  const notes = make(3000, 2000);
  const index = buildNoteIndex(notes);
  assert.equal(index.size, 3000);
  for (let k = 0; k < 300; k += 1) {
    const from = rand() * 2100 - 50;
    const to = from + rand() * 200;
    const got = index.query(from, to);
    const want = notes.filter((n) => n.step <= to && n.step + n.length >= from);
    assert.deepEqual(ids(got), ids(want), `query ${from}..${to}`);
    for (let i = 1; i < got.length; i += 1) assert.ok(got[i - 1].step <= got[i].step, 'in start order');
  }
  assert.deepEqual(index.query(10, 5), [], 'an empty range finds nothing');
}

// Rect queries: the same, inside a pitch range, pitch by pitch from the top.
{
  const notes = make(2000, 1000);
  const index = buildNoteIndex(notes);
  for (let k = 0; k < 200; k += 1) {
    const from = rand() * 1000;
    const to = from + rand() * 100;
    const lo = 30 + Math.floor(rand() * 60);
    const hi = lo + Math.floor(rand() * 20);
    const got: N[] = [];
    const count = index.queryRect(from, to, lo, hi, (n) => got.push(n));
    const want = notes.filter((n) => n.note >= lo && n.note <= hi && n.step <= to && n.step + n.length >= from);
    assert.equal(count, want.length);
    assert.deepEqual(ids(got), ids(want), `rect ${from}..${to} ${lo}..${hi}`);
    for (let i = 1; i < got.length; i += 1) assert.ok(got[i - 1].note >= got[i].note, 'pitch by pitch from the top');
  }
}

// Hit tests: start <= at < max(end, start + min), the latest in the list on top.
{
  const notes = make(1500, 400);
  const index = buildNoteIndex(notes);
  for (let k = 0; k < 2000; k += 1) {
    const at = rand() * 420;
    const pitch = 30 + Math.floor(rand() * 60);
    const min = rand() < 0.5 ? 0 : rand() * 2;
    const hits = notes
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.note === pitch && n.step <= at && at < Math.max(n.step + n.length, n.step + min));
    const want = hits.length ? hits[hits.length - 1].n : null;
    assert.equal(index.hitTest(at, pitch, min)?.id ?? null, want?.id ?? null, `hit ${at} ${pitch} min ${min}`);
  }
  // A per-note minimum, capped at the reach given.
  const two: N[] = [
    { id: 'short', step: 0, length: 0.1, note: 60 },
    { id: 'wide', step: 4, length: 0.1, note: 60 },
  ];
  const idx = buildNoteIndex(two);
  const minOf = (n: N) => (n.id === 'wide' ? 1 : 0.25);
  assert.equal(idx.hitTest(0.2, 60, 1, minOf)?.id, 'short');
  assert.equal(idx.hitTest(0.3, 60, 1, minOf), null, 'past its own minimum');
  assert.equal(idx.hitTest(4.9, 60, 1, minOf)?.id, 'wide');
  assert.equal(idx.hitTest(4.9, 61, 1, minOf), null, 'another pitch');
  // Overlapping notes: the later one wins.
  const stack = buildNoteIndex<N>([
    { id: 'under', step: 0, length: 8, note: 64 },
    { id: 'over', step: 2, length: 2, note: 64 },
  ]);
  assert.equal(stack.hitTest(3, 64)?.id, 'over');
  assert.equal(stack.hitTest(5, 64)?.id, 'under');
}

// A hit test whose per-note minimum asks another index (a drawn width that
// depends on a second list) answers as it does alone: each walk keeps its own
// stack, so the inner walk cannot overwrite the outer one's pending nodes.
{
  const outer = make(4000, 300);
  const inner = buildNoteIndex(make(4000, 300));
  const outerIdx = buildNoteIndex(outer);
  const minOf = (n: N) => (inner.hitTest(n.step, n.note, 1) ? 1 : 0.5);
  for (let k = 0; k < 500; k += 1) {
    const at = rand() * 310;
    const pitch = 30 + Math.floor(rand() * 60);
    const hits = outer
      .map((n, i) => ({ n, i }))
      .filter(({ n }) => n.note === pitch && n.step <= at && at < Math.max(n.step + n.length, n.step + minOf(n)));
    const want = hits.length ? hits[hits.length - 1].n : null;
    assert.equal(outerIdx.hitTest(at, pitch, 1, minOf)?.id ?? null, want?.id ?? null, `nested hit ${at} ${pitch}`);
  }
}

// Traversal: start, then pitch, then list order; step off either end is null.
{
  const notes: N[] = [
    { id: 'c', step: 4, length: 1, note: 60 },
    { id: 'a', step: 0, length: 1, note: 64 },
    { id: 'b', step: 0, length: 1, note: 67 },
    { id: 'd', step: 4, length: 1, note: 60 },
  ];
  const index = buildNoteIndex(notes);
  const order: string[] = [];
  for (let n = index.first(); n; n = index.step(n, 1)) order.push(n.id);
  assert.deepEqual(order, ['a', 'b', 'c', 'd']);
  assert.equal(index.step(notes[1], -1), null);
  assert.equal(index.step({ id: 'x', step: 0, length: 1, note: 60 }, 1), null, 'a note not in the index');
  assert.deepEqual(index.pitchRange, { low: 60, high: 67 });
}

// Bad values read as 0 and an empty index answers everything with nothing.
{
  const index = buildNoteIndex<N>([
    { id: 'nan', step: Number.NaN, length: Number.NaN, note: 60 },
    { id: 'ok', step: 2, length: 2, note: 60 },
  ]);
  assert.deepEqual(ids(index.query(0, 0)), ['nan']);
  assert.equal(index.maxLength, 2);
  const empty = buildNoteIndex<N>([]);
  assert.deepEqual(empty.query(0, 100), []);
  assert.equal(empty.hitTest(0, 60), null);
  assert.equal(empty.first(), null);
  assert.equal(empty.pitchRange, null);
}

// Sorted input takes the fast path and answers the same.
{
  const notes = make(2000, 800).sort((a, b) => a.step - b.step || a.note - b.note);
  const index = buildNoteIndex(notes);
  const want = notes.filter((n) => n.step <= 300 && n.step + n.length >= 250);
  assert.deepEqual(ids(index.query(250, 300)), ids(want));
}

// One index per list, shared; a new list gets a new one.
{
  const notes = make(10, 10);
  assert.equal(noteIndexOf(notes), noteIndexOf(notes));
  assert.notEqual(noteIndexOf(notes), noteIndexOf([...notes]));
}

console.log('noteIndex: ok');
