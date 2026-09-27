// Run with: npx tsx src/components/audio/PianoRoll.selection.test.ts
//
// The roll's selection gestures, end to end from a pointer position to what the
// store ends up holding: a marquee drag, a Shift marquee, the modifier clicks,
// select-all, the arrow nudge, Delete, the clipboard call site, and the
// velocity lane's drag and its keyboard nudge.
//
// It drives the REAL store and the REAL helpers in lib/rollSelection, in the
// order and with the arguments PianoRoll.tsx uses. It does NOT mount the
// component: PianoRoll's module graph reaches `state/playerStore`, which reads
// `import.meta.env` at module scope, and that is Vite-only — a node test cannot
// import it at all. What this file cannot reach, therefore, is the JSX wiring
// itself (which handler is on which element); that is what the browser pass on
// the dev server covers, and it is recorded in the ticket's report.
//
// The undo-step counts use the same `beginBlock()` reset as
// state/pianoRollHistory.test.ts: the recorder folds changes closer than 300 ms
// and a test run is faster than that, so each block starts from a reset clock.
import assert from 'node:assert/strict';
import {
  gridPointAt,
  marqueeRect,
  notesInMarquee,
  velocityNudgeWrites,
  velocityTargets,
  yToVelocity,
  VELOCITY_LANE_HEIGHT,
  type RollGeometry,
} from '../../lib/rollSelection.ts';
import { copyNotes, duplicateNotes } from '../../lib/noteClipboard.ts';
import { MAX_ROLL_STEPS, usePianoRollStore, type PianoNote } from '../../state/pianoRollStore.ts';

const st = () => usePianoRollStore.getState();
const ids = () => [...st().selectedIds];

/** The grid's own constants (PianoRoll.tsx NOTE_HEIGHT, a mid zoom). */
const STEP_PX = 16;
const GEO: RollGeometry = { stepPx: STEP_PX, noteHeight: 12, highestNote: 72 };
/** The y of a note row, mid-row, in the geometry above. */
const rowY = (midi: number): number => (GEO.highestNote - midi) * GEO.noteHeight + 6;
const colX = (step: number): number => step * STEP_PX + STEP_PX / 2;

const note = (id: string, midi: number, step: number, length = 2, velocity = 90): PianoNote =>
  ({ id, note: midi, step, length, velocity });

/** Seeds notes, a known range and length, and nothing selected. */
const load = (notes: PianoNote[]) => {
  st().importNotes(notes.map((n) => ({ ...n })));
  usePianoRollStore.setState({ totalSteps: 64, lowestNote: 21, highestNote: 108 });
};

/** Reset the coalesce clock so a block's first edit starts a fresh undo step. */
const beginBlock = () => {
  const s = st();
  usePianoRollStore.setState({
    _undo: [
      {
        notes: s.notes,
        bpm: s.bpm,
        tempoMap: s.tempoMap,
        totalSteps: s.totalSteps,
        lowestNote: s.lowestNote,
        highestNote: s.highestNote,
        meterMap: s.meterMap,
        pickupSteps: s.pickupSteps,
        lanes: s.lanes,
        bends: s.bends,
      },
    ],
    _redo: [],
  });
  st().undo();
  assert.equal(st()._undo.length, 0, 'a block starts with an empty undo stack');
};

/** The marquee gesture as PianoRoll.tsx performs it: press, drag, release. */
const marqueeDrag = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  shift = false,
): void => {
  const rect = marqueeRect(gridPointAt(from.x, from.y, GEO), gridPointAt(to.x, to.y, GEO));
  const hits = notesInMarquee(st().notes, rect);
  if (shift) st().addToSelection(hits);
  else st().setSelection(hits);
};

/** The modifier half of a note click (PianoRoll.tsx `modifierSelect`). */
const modifierSelect = (mods: { shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean }, id: string): boolean => {
  if (mods.ctrlKey || mods.metaKey) {
    st().toggleSelection(id);
    return true;
  }
  if (mods.shiftKey) {
    st().addToSelection([id]);
    return true;
  }
  return false;
};

// ── A marquee selects what it overlaps, in either direction ──────────────────
{
  // C4 and E4 in the first bar, G4 further along.
  load([note('c', 60, 0, 4), note('e', 64, 2, 2), note('g', 67, 12, 4)]);
  marqueeDrag({ x: colX(0), y: rowY(67) }, { x: colX(3), y: rowY(59) });
  assert.deepEqual(ids(), ['c', 'e'], 'a band over the first two notes takes both');

  // The same band dragged up and to the left is the same selection.
  marqueeDrag({ x: colX(3), y: rowY(59) }, { x: colX(0), y: rowY(67) });
  assert.deepEqual(ids(), ['c', 'e']);

  // A band in the gap after them selects nothing, and a plain marquee replaces.
  marqueeDrag({ x: colX(6), y: rowY(67) }, { x: colX(9), y: rowY(59) });
  assert.deepEqual(ids(), [], 'an empty band clears the selection');

  // Shift EXTENDS instead of replacing.
  marqueeDrag({ x: colX(0), y: rowY(60) }, { x: colX(3), y: rowY(60) });
  assert.deepEqual(ids(), ['c']);
  marqueeDrag({ x: colX(12), y: rowY(67) }, { x: colX(15), y: rowY(67) }, true);
  assert.deepEqual(ids(), ['c', 'g'], 'Shift adds the second band to the first');

  // A band that misses every note under Shift leaves the selection intact.
  marqueeDrag({ x: colX(30), y: rowY(30) }, { x: colX(40), y: rowY(28) }, true);
  assert.deepEqual(ids(), ['c', 'g']);
}

// ── Modifier clicks ──────────────────────────────────────────────────────────
{
  load([note('c', 60, 0, 4), note('e', 64, 2, 2), note('g', 67, 12, 4)]);
  st().setSelectedNote('c');
  assert.equal(modifierSelect({ shiftKey: true }, 'e'), true);
  assert.deepEqual(ids(), ['c', 'e'], 'Shift-click adds');
  assert.equal(modifierSelect({ ctrlKey: true }, 'e'), true);
  assert.deepEqual(ids(), ['c'], 'Ctrl-click on a selected note takes it out');
  assert.equal(modifierSelect({ metaKey: true }, 'g'), true);
  assert.deepEqual(ids(), ['c', 'g'], 'and Cmd-click on an unselected one puts it in');
  assert.equal(modifierSelect({}, 'g'), false, 'a plain click is left to the caller');
  assert.deepEqual(ids(), ['c', 'g'], 'and changes nothing on its own');
}

// ── The second-click delete only fires on the ONE selected note ──────────────
//
// PianoRoll.tsx records `wasSelected` at the press as "this note is the whole
// selection", so a click inside a marquee selection collapses onto that note
// instead of deleting a note the band merely swept over.
{
  load([note('c', 60, 0, 4), note('e', 64, 2, 2)]);
  const pressed = (id: string) => {
    const picked = st().selectedIds;
    return picked.size === 1 && picked.has(id);
  };
  st().setSelectedNote('c');
  assert.equal(pressed('c'), true, 'the only selected note deletes on the second click');
  marqueeDrag({ x: colX(0), y: rowY(67) }, { x: colX(3), y: rowY(59) });
  assert.deepEqual(ids(), ['c', 'e']);
  assert.equal(pressed('c'), false, 'a note inside a multi-selection does not');
  st().setSelectedNote('c');
  assert.equal(pressed('c'), true, 'collapsing onto it arms it again');
}

// ── Ctrl/Cmd+A, the arrow nudge and Delete ───────────────────────────────────
{
  load([note('c', 60, 0, 4), note('e', 64, 2, 2), note('g', 67, 12, 4)]);
  st().selectAll();
  assert.deepEqual(ids(), ['c', 'e', 'g']);

  beginBlock();
  st().nudgeSelected(1, 0);
  assert.deepEqual(st().notes.map((n) => n.step), [1, 3, 13], 'the whole selection moves one step');
  assert.equal(st()._undo.length, 1, 'and a nudge is one undo step');
  st().nudgeSelected(0, 12);
  assert.deepEqual(st().notes.map((n) => n.note), [72, 76, 79], 'Shift+Up is an octave');
  st().undo();
  st().undo();
  assert.deepEqual(st().notes.map((n) => [n.step, n.note]), [[0, 60], [2, 64], [12, 67]], 'both come back');

  // Delete takes the whole selection in one write of `notes`.
  st().selectAll();
  beginBlock();
  const s = st();
  s.replaceAll(s.notes.filter((n) => !s.selectedIds.has(n.id)));
  assert.deepEqual(st().notes, [], 'every selected note goes');
  assert.equal(st()._undo.length, 1, 'in one undo step');
  assert.deepEqual(ids(), [], 'and the selection goes with them');
  st().undo();
  assert.equal(st().notes.length, 3);
}

// ── The clipboard call site now sees the real selection ──────────────────────
//
// T21 built the helpers around a set of ids while the roll could only select
// one note; this is the pin that the marquee's set reaches them.
{
  load([note('c', 60, 0, 4), note('e', 64, 2, 2), note('g', 67, 12, 4)]);
  marqueeDrag({ x: colX(0), y: rowY(67) }, { x: colX(3), y: rowY(59) });
  const payload = copyNotes(st().notes, st().selectedIds);
  assert.deepEqual(payload?.notes.map((n) => n.id), ['c', 'e'], 'a copy takes both, not just the primary');
  assert.equal(payload?.anchorStep, 0);

  const range = { lowestNote: st().lowestNote, highestNote: st().highestNote, totalSteps: st().totalSteps, maxSteps: MAX_ROLL_STEPS };
  const added = duplicateNotes(st().notes, st().selectedIds, range);
  assert.equal(added.length, 2, 'and a duplicate copies both');
  assert.deepEqual(added.map((n) => n.note), [60, 64]);
  // The block lands in one write (appendNotes), which selects it, the earliest
  // of it the primary.
  beginBlock();
  st().appendNotes(added);
  assert.equal(st()._undo.length, 1, 'a duplicate is one undo step');
  assert.deepEqual(st().notes.map((n) => n.id), ['c', 'e', 'g', ...added.map((n) => n.id)]);
  assert.deepEqual(ids(), added.map((n) => n.id), 'the copy is the selection');
  assert.equal(st().selectedNoteId, added[0].id, 'and its earliest note the primary');
  // So a second Ctrl/Cmd+D copies the copy and marches forward.
  const again = duplicateNotes(st().notes, st().selectedIds, { ...range, totalSteps: st().totalSteps });
  assert.ok(again[0].step > added[0].step, 'the second duplicate lands after the first');
  st().appendNotes(again);
  assert.deepEqual(ids(), again.map((n) => n.id));
  assert.equal(st().selectedNoteId, again[0].id);
}

// ── The velocity lane: a press, a sweep, and the keyboard nudge ──────────────
{
  const H = VELOCITY_LANE_HEIGHT;
  // A press writes the notes under the pointer's step.
  load([note('c', 60, 0, 4, 90), note('e', 64, 0, 4, 90), note('g', 67, 8, 4, 40)]);
  const writeAt = (fromStep: number, toStep: number, y: number) => {
    const s = st();
    const targets = velocityTargets(s.notes, fromStep, toStep, s.selectedIds);
    if (targets.length > 0) s.setVelocity(targets, yToVelocity(y, H));
  };

  beginBlock();
  writeAt(1, 1, 0); // the top of the strip
  assert.deepEqual(st().notes.map((n) => n.velocity), [127, 127, 40], 'a chord under the pointer moves together');
  assert.equal(st()._undo.length, 1);

  // With one of them selected, the sweep writes only that one.
  st().setSelectedNote('e');
  writeAt(1, 1, H); // the floor
  assert.deepEqual(st().notes.map((n) => n.velocity), [127, 1, 40], 'a selection isolates a voice');

  // A sweep that skips pixels still catches everything it crossed.
  st().clearSelection();
  writeAt(1, 11, H / 2);
  const half = yToVelocity(H / 2, H);
  assert.deepEqual(st().notes.map((n) => n.velocity), [half, half, half], 'the sweep caught all three');

  // The arrow keys move every selected note by the same amount, so a shape holds.
  st().setVelocity(['c', 'e', 'g'], 100);
  st().updateNote('g', { velocity: 60 });
  st().setSelection(['c', 'e', 'g']);
  const nudge = (by: number) => {
    const s = st();
    for (const w of velocityNudgeWrites(s.notes, s.selectedIds, by)) s.setVelocity(w.ids, w.velocity);
  };
  nudge(10);
  assert.deepEqual(st().notes.map((n) => n.velocity), [110, 110, 70], 'the gap between them is unchanged');
  nudge(-10);
  assert.deepEqual(st().notes.map((n) => n.velocity), [100, 100, 60]);
  // At the ceiling the loud ones stop and the quiet one keeps climbing.
  nudge(30);
  assert.deepEqual(st().notes.map((n) => n.velocity), [127, 127, 90]);
  // Nothing selected is nothing written.
  st().clearSelection();
  const before = st().notes;
  nudge(10);
  assert.equal(st().notes, before, 'the same array, so no undo step');
}

console.log('PianoRoll.selection: ok');
