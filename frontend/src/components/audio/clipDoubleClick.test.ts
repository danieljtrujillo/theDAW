import assert from 'node:assert/strict';
import {
  CLIP_CLICK_SLOP_PX,
  clipGesturePhase,
  planStemInsert,
  skippedAggregatesNote,
  stemClipPlacement,
} from './clipDoubleClick';

// --- Click vs drag ---------------------------------------------------------
{
  assert.equal(CLIP_CLICK_SLOP_PX, 4);

  // A press that never travels is a click.
  assert.equal(clipGesturePhase(0, 0), 'click');
  // The 1-3 px hand wobble between the two presses of a double-click: still a
  // click, so nothing is written and the clip stays under the pointer.
  assert.equal(clipGesturePhase(1, 0), 'click');
  assert.equal(clipGesturePhase(0, -3), 'click');
  assert.equal(clipGesturePhase(2, 2), 'click'); // hypot 2.83
  assert.equal(clipGesturePhase(-3, 2), 'click'); // hypot 3.61

  // At the threshold and beyond it is a drag: the op applies from here on.
  assert.equal(clipGesturePhase(4, 0), 'drag');
  assert.equal(clipGesturePhase(0, 4), 'drag');
  assert.equal(clipGesturePhase(-4, 0), 'drag');
  assert.equal(clipGesturePhase(3, 3), 'drag'); // hypot 4.24
  assert.equal(clipGesturePhase(40, 9), 'drag');

  // The band is a RADIUS, not a box: 2.8 px on both axes is 3.96 px of travel,
  // still a click, while a hair more crosses it.
  assert.equal(clipGesturePhase(2.8, 2.8), 'click'); // hypot 3.96
  assert.equal(clipGesturePhase(2.83, 2.83), 'drag'); // hypot 4.002

  // The threshold is a parameter, so a coarser pointer can ask for more travel.
  assert.equal(clipGesturePhase(6, 0, 10), 'click');
  assert.equal(clipGesturePhase(10, 0, 10), 'drag');
  // A zero threshold means every press is a drag (no click band at all).
  assert.equal(clipGesturePhase(0, 0, 0), 'drag');

  for (const bad of [Number.NaN, Infinity, -Infinity]) {
    assert.throws(() => clipGesturePhase(bad, 0), RangeError);
    assert.throws(() => clipGesturePhase(0, bad), RangeError);
    assert.throws(() => clipGesturePhase(0, 0, bad), RangeError);
  }
  assert.throws(() => clipGesturePhase(0, 0, -1), RangeError);
}

// --- Stem insert selection by role ----------------------------------------
{
  // No row carries a role (an old backend, or a run with no manifest): every
  // stem is inserted, exactly as before roles existed.
  const roleless = [{ name: 'vocals' }, { name: 'drums' }, { name: 'bass' }, { name: 'other' }];
  const all = planStemInsert(roleless);
  assert.deepEqual(all.insert.map((r) => r.name), ['vocals', 'drums', 'bass', 'other']);
  assert.deepEqual(all.skipped, []);

  // A 12-stem LARSNET run: `drums` is the sum of the kit parts, so inserting it
  // alongside them would put the kit on the timeline twice.
  const larsnet = [
    { name: 'vocals', role: 'part' },
    { name: 'bass', role: 'part' },
    { name: 'other', role: 'part' },
    { name: 'drums', role: 'aggregate' },
    { name: 'kick', role: 'part' },
    { name: 'snare', role: 'part' },
    { name: 'toms', role: 'part' },
    { name: 'hihat', role: 'part' },
    { name: 'cymbals', role: 'part' },
  ];
  const plan = planStemInsert(larsnet);
  assert.deepEqual(plan.insert.map((r) => r.name), [
    'vocals', 'bass', 'other', 'kick', 'snare', 'toms', 'hihat', 'cymbals',
  ]);
  assert.deepEqual(plan.skipped, ['drums']);

  // A 2-stem run is two parts (the backend only calls `no_vocals` an aggregate
  // when there is something besides the vocal for it to sum), so both land.
  const two = planStemInsert([{ name: 'vocals', role: 'part' }, { name: 'no_vocals', role: 'part' }]);
  assert.deepEqual(two.insert.map((r) => r.name), ['vocals', 'no_vocals']);
  assert.deepEqual(two.skipped, []);

  // Both kinds of aggregate in one run.
  const both = planStemInsert([
    { name: 'vocals', role: 'part' },
    { name: 'no_vocals', role: 'aggregate' },
    { name: 'drums', role: 'aggregate' },
    { name: 'kick', role: 'part' },
  ]);
  assert.deepEqual(both.insert.map((r) => r.name), ['vocals', 'kick']);
  assert.deepEqual(both.skipped, ['no_vocals', 'drums']);

  // Mixed: some rows described, some not. An undescribed row is not an
  // aggregate, so it is inserted.
  const mixed = planStemInsert([{ name: 'vocals' }, { name: 'drums', role: 'aggregate' }, { name: 'kick', role: 'part' }]);
  assert.deepEqual(mixed.insert.map((r) => r.name), ['vocals', 'kick']);
  assert.deepEqual(mixed.skipped, ['drums']);

  // Nothing but aggregates cannot happen upstream, but a plan that inserted
  // nothing would turn into "separation produced no stems": keep them all.
  const onlyAgg = planStemInsert([{ name: 'drums', role: 'aggregate' }, { name: 'no_vocals', role: 'aggregate' }]);
  assert.deepEqual(onlyAgg.insert.map((r) => r.name), ['drums', 'no_vocals']);
  assert.deepEqual(onlyAgg.skipped, []);

  assert.deepEqual(planStemInsert([]), { insert: [], skipped: [] });

  // The note for the existing status/log line.
  assert.equal(skippedAggregatesNote([]), '');
  assert.equal(skippedAggregatesNote(['drums']), 'skipped drums (aggregate)');
  assert.equal(skippedAggregatesNote(['no_vocals', 'drums']), 'skipped no_vocals, drums (aggregates)');
}

// --- Stem placement against the clip it came from --------------------------
{
  const parent = { startSec: 12, durationSec: 4, offsetIntoSource: 3 };

  // The stem is as long as the source, so the clip keeps the parent's window.
  assert.deepEqual(stemClipPlacement(parent, 30), { startSec: 12, offsetIntoSource: 3, durationSec: 4 });

  // A stem shorter than the parent's read head: the offset is pulled back to
  // 0.05 s before the end, and the length to what is left. (Compared with a
  // tolerance: 2 - 0.05 is not exact in binary, and the helper deliberately
  // does the same arithmetic the all-stems path already does, unrounded.)
  const short = stemClipPlacement(parent, 2);
  assert.equal(short.startSec, 12);
  assert.ok(Math.abs(short.offsetIntoSource - 1.95) < 1e-9, String(short.offsetIntoSource));
  assert.ok(Math.abs(short.durationSec - 0.05) < 1e-9, String(short.durationSec));

  // A stem with no length at all still yields a placeable clip.
  assert.deepEqual(stemClipPlacement(parent, 0), { startSec: 12, offsetIntoSource: 0, durationSec: 0.05 });

  // The parent's window is shorter than what is left of the stem: the clip
  // covers the parent's length, not the stem's.
  assert.deepEqual(
    stemClipPlacement({ startSec: 0, durationSec: 1, offsetIntoSource: 0 }, 9),
    { startSec: 0, offsetIntoSource: 0, durationSec: 1 },
  );

  // An explicit start overrides the parent's (the library path inserts at the
  // edit cursor, where there is no parent clip on the timeline).
  assert.deepEqual(
    stemClipPlacement({ startSec: 0, durationSec: 8, offsetIntoSource: 0 }, 8, 5.5),
    { startSec: 5.5, offsetIntoSource: 0, durationSec: 8 },
  );
  // A negative start is held at the head of the timeline.
  assert.equal(stemClipPlacement(parent, 30, -4).startSec, 0);

  for (const bad of [Number.NaN, Infinity]) {
    assert.throws(() => stemClipPlacement(parent, bad), RangeError);
    assert.throws(() => stemClipPlacement({ ...parent, startSec: bad }, 10), RangeError);
    assert.throws(() => stemClipPlacement({ ...parent, durationSec: bad }, 10), RangeError);
    assert.throws(() => stemClipPlacement({ ...parent, offsetIntoSource: bad }, 10), RangeError);
    assert.throws(() => stemClipPlacement(parent, 10, bad), RangeError);
  }
}

console.log('clipDoubleClick: ok');
