/**
 * djCuesStore — what the automatic seeder is and is not allowed to write.
 *
 * `seedCues` is the only writer that is not a user keypress, so every test
 * here is about ownership: it may move the cues this store placed, it may
 * fill empty slots, and it must never touch a track the user has edited.
 *
 * The case that brought this file into existence: a deck loads before its
 * duration is known, so the first seed runs with `duration: 0` and places a
 * phrase cue past the end of the track. The real duration arrives, the seeder
 * re-runs and returns `null` for that slot — and the store kept the old,
 * out-of-range cue, because "no time" read as "nothing to say" rather than
 * "clear it". A cue that seeks past the end of the file is worse than no cue.
 *
 * Run: `npx tsx src/state/djCuesStore.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

// zustand's `persist` reads `window.localStorage` once, at module-evaluation
// time, so jsdom has to be global BEFORE the store is imported.
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' });
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.localStorage = dom.window.localStorage;

const { useDjCuesStore, HOTCUE_SLOTS } = await import('./djCuesStore.ts');

delete g.window;

let passed = 0;
const test = (name: string, fn: () => void) => {
  useDjCuesStore.setState({ byEntry: {}, seeded: {}, userTouched: {} }, false);
  fn();
  passed++;
  console.log(`  ok ${name}`);
};

const cues = (id: string) => useDjCuesStore.getState().cuesFor(id);
const seed = (id: string, times: readonly (number | null | undefined)[]) =>
  useDjCuesStore.getState().seedCues(id, times);

console.log('djCuesStore');

test('a seed fills empty slots', () => {
  seed('t1', [1, 33, 65, 97]);
  assert.deepEqual(cues('t1'), [1, 33, 65, 97]);
  assert.equal(useDjCuesStore.getState().seeded.t1, true);
});

test('a re-seed with an explicit null clears the slot this store placed', () => {
  // First load: the duration is not known yet, so the seeder has nothing to
  // clamp against and puts cue 4 at 97s on a 40s track.
  seed('t2', [1, 33, 65, 97]);
  assert.deepEqual(cues('t2'), [1, 33, 65, 97]);
  // The duration lands; the seeder now says "there is no fourth phrase".
  seed('t2', [1, 33, null, null]);
  assert.deepEqual(cues('t2'), [1, 33, null, null], 'the out-of-range cues are gone');
});

test('a null for a slot the store never owned leaves the user cue alone', () => {
  useDjCuesStore.getState().setCue('t3', 0, 4);      // a human pad press
  useDjCuesStore.setState({ userTouched: {} }, false); // …from a previous session
  seed('t3', [null, 33, null, null]);
  assert.equal(cues('t3')[0], 4, 'the human cue survives');
  assert.equal(cues('t3')[1], 33);
});

test('a short seed list leaves the slots it says nothing about', () => {
  seed('t4', [1, 33, 65, 97]);
  seed('t4', [2, 34]);             // undefined, not null: no opinion
  assert.deepEqual(cues('t4'), [2, 34, 65, 97]);
});

test('an all-null re-seed empties a store-owned track', () => {
  seed('t5', [1, 33, 65, 97]);
  seed('t5', [null, null, null, null]);
  assert.deepEqual(cues('t5'), Array<number | null>(HOTCUE_SLOTS).fill(null));
  assert.equal(useDjCuesStore.getState().seeded.t5, true, 'the track is still ours to re-seed');
  // …and a later, better seed fills it again.
  seed('t5', [2, 34, null, null]);
  assert.deepEqual(cues('t5'), [2, 34, null, null]);
});

test('a user-touched track is never re-seeded, nulls included', () => {
  seed('t6', [1, 33, 65, 97]);
  useDjCuesStore.getState().clearCue('t6', 1);
  seed('t6', [null, null, null, null]);
  assert.deepEqual(cues('t6'), [1, null, 65, 97]);
});

test('a re-seed that changes nothing does not touch the store', () => {
  seed('t7', [1, 33, null, null]);
  const before = useDjCuesStore.getState().byEntry;
  seed('t7', [1, 33, null, null]);
  assert.equal(useDjCuesStore.getState().byEntry, before, 'same object: no re-render');
});

console.log(`\ndjCuesStore: ${passed} passed`);
