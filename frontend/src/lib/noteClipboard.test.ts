// noteClipboard: the piano roll's copy / cut / paste / duplicate arithmetic,
// tested without a DOM. Ids are injected so every expectation is exact.
import assert from 'node:assert/strict';
import { copyNotes, duplicateNotes, pasteNotes, type RollRange } from './noteClipboard.ts';
import { usePianoRollStore, type PianoNote } from '../state/pianoRollStore.ts';

const n = (over: Partial<PianoNote> & Pick<PianoNote, 'id'>): PianoNote => ({
  note: 60, step: 0, length: 2, velocity: 96, ...over,
});

const range: RollRange = { lowestNote: 48, highestNote: 72, totalSteps: 64 };

/** Deterministic ids: n0, n1, … */
const ids = () => {
  let i = 0;
  return () => `n${i++}`;
};

// ── copyNotes ────────────────────────────────────────────────────────────────
{
  const notes = [
    n({ id: 'a', step: 8, note: 64 }),
    n({ id: 'b', step: 4, note: 60, lane: 2 }),
    n({ id: 'c', step: 12, note: 67 }),
  ];

  const payload = copyNotes(notes, ['a', 'b']);
  assert.ok(payload, 'a non-empty selection copies');
  // The anchor is the EARLIEST selected note's step, and the payload is in step order.
  assert.equal(payload.anchorStep, 4);
  assert.deepEqual(payload.notes.map((x) => x.id), ['b', 'a']);
  // The payload is a snapshot: mutating the source list afterwards cannot reach it.
  assert.equal(payload.notes[0].lane, 2, 'the lane travels with the note');
  assert.notEqual(payload.notes[0], notes[1], 'the payload holds copies, not the store objects');

  // An empty selection, or one naming ids the roll does not have, is a no-op:
  // null, so a caller never clobbers a good clipboard with nothing.
  assert.equal(copyNotes(notes, []), null);
  assert.equal(copyNotes(notes, ['nope']), null);
  assert.equal(copyNotes([], ['a']), null);

  // Ties on step keep a stable order by pitch.
  const tied = copyNotes([n({ id: 'hi', step: 4, note: 67 }), n({ id: 'lo', step: 4, note: 60 })], ['hi', 'lo']);
  assert.deepEqual(tied?.notes.map((x) => x.id), ['lo', 'hi']);
}

// ── pasteNotes: relative timing, new ids, velocity and pitch ────────────────
{
  const payload = copyNotes(
    [n({ id: 'a', step: 4, note: 60, velocity: 40, length: 3 }), n({ id: 'b', step: 9, note: 64, velocity: 127, lane: 1 })],
    ['a', 'b'],
  );
  assert.ok(payload);

  const pasted = pasteNotes(payload, 20, range, ids());
  assert.equal(pasted.length, 2);
  // Relative timing preserved: the gap of 5 steps survives the move.
  assert.deepEqual(pasted.map((x) => x.step), [20, 25]);
  assert.deepEqual(pasted.map((x) => x.note), [60, 64]);
  assert.deepEqual(pasted.map((x) => x.velocity), [40, 127]);
  assert.deepEqual(pasted.map((x) => x.length), [3, 2]);
  assert.equal(pasted[1].lane, 1, 'the lane is preserved');
  assert.equal(pasted[0].lane, undefined, 'a note without a lane stays without one');
  // New ids every time, never the source ids.
  assert.deepEqual(pasted.map((x) => x.id), ['n0', 'n1']);
  assert.deepEqual(pasteNotes(payload, 20, range, ids()).map((x) => x.id), ['n0', 'n1']);
  assert.ok(pasted.every((x) => x.id !== 'a' && x.id !== 'b'));
  // Default ids are unique without an injected generator.
  const auto = pasteNotes(payload, 0, range);
  assert.equal(new Set(auto.map((x) => x.id)).size, 2);

  // The source objects are untouched by a paste.
  assert.equal(payload.notes[0].step, 4);

  // An empty clipboard pastes nothing.
  assert.deepEqual(pasteNotes({ notes: [], anchorStep: 0 }, 8, range), []);
}

// ── pasteNotes: clamped at both edges ───────────────────────────────────────
{
  const payload = copyNotes([n({ id: 'a', step: 10, note: 50 }), n({ id: 'b', step: 14, note: 70 })], ['a', 'b']);
  assert.ok(payload);

  // Left edge: a negative insertion point lands at step 0 AND keeps the spacing.
  const early = pasteNotes(payload, -6, range, ids());
  assert.deepEqual(early.map((x) => x.step), [0, 4]);

  // Right edge: the insertion point is held on the last step; a note that
  // would start at or past the roll's end is left out, never piled onto the
  // last step, and the length of one that runs past it is trimmed.
  const late = pasteNotes(payload, 70, range, ids());
  assert.deepEqual(late.map((x) => x.step), [63]);
  assert.deepEqual(late.map((x) => x.length), [1]);
  // A note that only partly overruns keeps its start and loses the overhang.
  const edge = pasteNotes(copyNotes([n({ id: 'a', step: 0, length: 8 })], ['a'])!, 60, range, ids());
  assert.deepEqual(edge.map((x) => [x.step, x.length]), [[60, 4]]);

  // Pitch is clamped into the roll's visible range at both ends.
  const pitched = pasteNotes(
    copyNotes([n({ id: 'a', note: 20 }), n({ id: 'b', note: 120, step: 1 })], ['a', 'b'])!,
    0,
    range,
    ids(),
  );
  assert.deepEqual(pitched.map((x) => x.note), [48, 72]);

  // A one-step grid still produces a legal note; the second starts past it.
  const tiny = pasteNotes(payload, 5, { lowestNote: 60, highestNote: 60, totalSteps: 1 }, ids());
  assert.deepEqual(tiny.map((x) => [x.step, x.length, x.note]), [[0, 1, 60]]);

  // With room to grow (the roll passes maxSteps), a paste past the end lands
  // whole, and only what starts past maxSteps is left out.
  const grown = pasteNotes(payload, 70, { ...range, maxSteps: 4096 }, ids());
  assert.deepEqual(grown.map((x) => [x.step, x.length]), [[70, 2], [74, 2]]);
  const capped = pasteNotes(payload, 4094, { ...range, maxSteps: 4096 }, ids());
  assert.deepEqual(capped.map((x) => [x.step, x.length]), [[4094, 2]], 'the note that would start at 4098 is left out');
}

// ── pasteNotes / duplicateNotes: a sub-step length pastes as it was copied ──
{
  const third = 2 / 3;
  const run = [0, 1, 2].map((i) => n({ id: `t${i}`, step: 8 + i * third, length: third, note: 60 + i }));
  const pasted = pasteNotes(copyNotes(run, ['t0', 't1', 't2'])!, 20, range, ids());
  assert.deepEqual(pasted.map((x) => x.length), [third, third, third], 'a 16th-triplet run keeps its lengths');
  assert.ok(Math.abs(pasted[2].step - (20 + 2 * third)) < 1e-9);
  // A duplicate lands at the run's real end (8 + 3 x 2/3 = 10), not a step later.
  const dup = duplicateNotes(run, ['t0', 't1', 't2'], range, ids());
  assert.equal(dup[0].step, 10);
  assert.deepEqual(dup.map((x) => x.length), [third, third, third]);
}

// ── duplicateNotes: lands after the selection's end ─────────────────────────
{
  const notes = [
    n({ id: 'a', step: 4, length: 2, note: 60 }),
    n({ id: 'b', step: 8, length: 3, note: 64 }),
    n({ id: 'c', step: 40, length: 2, note: 67 }),
  ];

  // The selection ends at 8 + 3 = 11, so the copy starts there and keeps its shape.
  const made = duplicateNotes(notes, ['a', 'b'], range, ids());
  assert.deepEqual(made.map((x) => [x.step, x.length, x.note]), [[11, 2, 60], [15, 3, 64]]);
  assert.deepEqual(made.map((x) => x.id), ['n0', 'n1']);

  // A single note duplicates directly after itself — the same place the note
  // menu's "Duplicate (after)" puts it.
  assert.deepEqual(duplicateNotes(notes, ['c'], range, ids()).map((x) => [x.step, x.length]), [[42, 2]]);

  // Empty selection → no-op.
  assert.deepEqual(duplicateNotes(notes, [], range), []);
  assert.deepEqual(duplicateNotes(notes, ['nope'], range), []);

  // The roll is not mutated by any of it.
  assert.deepEqual(notes.map((x) => x.step), [4, 8, 40]);
}

// ── The undo-step pins: a cut and a paste are ONE step each ─────────────────
// Against the real store, because the pin is about its history subscriber: a
// bulk write of `notes` snapshots the document once, so the whole set comes
// back on a single undo. The waits clear HISTORY_COALESCE_MS (300ms), which is
// what folds a continuous gesture into one step — without them the pins would
// be measuring the coalescer, not the write.
{
  const st = () => usePianoRollStore.getState();
  const settle = () => new Promise((r) => setTimeout(r, 350));
  const three: PianoNote[] = [
    n({ id: 'A', step: 0, note: 60 }),
    n({ id: 'B', step: 4, note: 64 }),
    n({ id: 'C', step: 8, note: 67 }),
  ];
  const rollRange = (): RollRange => ({
    lowestNote: st().lowestNote, highestNote: st().highestNote, totalSteps: st().totalSteps, maxSteps: 4096,
  });

  st().replaceAll(three.map((x) => ({ ...x })));
  await settle();
  assert.equal(st().notes.length, 3);

  // CUT = copy + delete in one write.
  const payload = copyNotes(st().notes, ['A', 'B', 'C']);
  assert.ok(payload);
  const beforeCut = st()._undo.length;
  const cut = new Set(payload.notes.map((x) => x.id));
  st().replaceAll(st().notes.filter((x) => !cut.has(x.id)));
  assert.deepEqual(st().notes, []);
  assert.equal(st()._undo.length, beforeCut + 1, 'a cut of three notes is exactly one undo step');
  st().undo();
  assert.deepEqual(st().notes.map((x) => x.id), ['A', 'B', 'C'], 'one undo brings the whole cut back');

  await settle();

  // PASTE = one write (appendNotes, as the roll's Ctrl/Cmd+V makes it), which
  // also selects the pasted block.
  const beforePaste = st()._undo.length;
  const pasted = pasteNotes(payload, 32, rollRange());
  assert.equal(pasted.length, 3);
  st().appendNotes(pasted);
  assert.equal(st().notes.length, 6);
  assert.equal(st()._undo.length, beforePaste + 1, 'a paste of three notes is exactly one undo step');
  assert.deepEqual([...st().selectedIds], pasted.map((p) => p.id), 'the paste is the selection');
  assert.equal(st().selectedNoteId, pasted[0].id);
  // Selecting the pasted note afterwards touches no tracked slice, so it adds no step.
  st().setSelectedNote(pasted[0].id);
  assert.equal(st()._undo.length, beforePaste + 1, 'selecting the paste adds no undo step');

  st().undo();
  assert.equal(st().notes.length, 3, 'one undo removes all three pasted notes');
  assert.equal(st().notes.some((x) => pasted.some((p) => p.id === x.id)), false);

  await settle();

  // A paste that runs past the roll's end, as the roll makes it: copy two
  // notes, paste at step 62 of a 64-step roll. The overflow used to pile onto
  // step 63; now both notes keep their spacing and the roll grows to the next
  // bar line, in the same one undo step.
  usePianoRollStore.setState({ totalSteps: 64 });
  await settle();
  const pair = copyNotes(st().notes, ['A', 'B'])!;
  const beforeGrow = st()._undo.length;
  const over = pasteNotes(pair, 62, rollRange());
  st().appendNotes(over);
  const landed = st().notes.filter((x) => over.some((o) => o.id === x.id));
  assert.deepEqual(landed.map((x) => [x.step, x.length]), [[62, 2], [66, 2]], 'no note piles onto the last step');
  assert.equal(st().totalSteps, 80, 'the roll grows to the bar line after the paste');
  assert.equal(st()._undo.length, beforeGrow + 1, 'the paste and the growth are one undo step');
  st().undo();
  assert.equal(st().totalSteps, 64, 'undo takes the growth back with the notes');
  assert.equal(st().notes.length, 3);
}

console.log('noteClipboard: ok');
