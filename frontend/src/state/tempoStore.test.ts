/**
 * Runs under plain node: the store is vanilla zustand with no persistence and
 * no DOM, and `beatClock` falls back to t = 0 with no AudioContext.
 *
 * The contract under test is as much about IDENTITY as about values —
 * `tempoMap.ts` caches its normalization on the array's identity, so an action
 * that edited the array in place would leave every conversion in the app
 * serving the map from before the edit.
 */
import assert from 'node:assert/strict';
import { INITIAL_TEMPO_EVENTS, subscribeTempoMap, useTempoStore } from './tempoStore.ts';
import { CLOCK_BPM_MAX, CLOCK_BPM_MIN, beatClock } from '../lib/beatClock.ts';
import { beatToTime, getTempoAtBeat, normalizeTempoMap, type TempoEvent } from '../lib/tempoMap.ts';

const store = useTempoStore;
const events = (): readonly TempoEvent[] => store.getState().events;
const shape = (): [number, number, string][] => events().map((e) => [e.beat, e.bpm, e.curve ?? 'step']);
const reset = (): void => store.setState({ events: INITIAL_TEMPO_EVENTS });

// A fresh store is one constant 120 bpm event at beat 0, and it is frozen all
// the way down — the array AND every event in it.
{
  assert.deepEqual(shape(), [[0, 120, 'step']]);
  assert.ok(Object.isFrozen(events()), 'the array is frozen');
  assert.ok(Object.isFrozen(events()[0]), 'the events are frozen');
  assert.throws(() => (events() as TempoEvent[]).push({ beat: 4, bpm: 90 }));
}

// setEvents sorts, dedupes (later wins), clamps to the CLOCK's range, drops
// junk, and never keeps the caller's array.
{
  const input: TempoEvent[] = [
    { beat: 16, bpm: 174 },
    { beat: 0, bpm: 9999 },          // clamped to 300
    { beat: 8, bpm: 1 },             // clamped to 20
    { beat: 16, bpm: 90, curve: 'linear' }, // same beat, later wins
    { beat: 4, bpm: 0 },             // junk: not a tempo
    { beat: Number.NaN, bpm: 120 },  // junk: not a position
    { beat: 32, bpm: -60 },          // junk: would run time backwards
  ];
  store.getState().setEvents(input);
  assert.deepEqual(shape(), [[0, 300, 'step'], [8, 20, 'step'], [16, 90, 'linear']]);
  assert.equal(CLOCK_BPM_MIN, 20);
  assert.equal(CLOCK_BPM_MAX, 300);
  assert.notEqual(events() as unknown, input as unknown, 'the store never holds the caller\'s array');
  input.push({ beat: 64, bpm: 100 });
  assert.equal(events().length, 3, 'and editing the caller\'s array afterwards changes nothing');
  // The result is a map `tempoMap.ts` accepts, and it hits the identity cache.
  assert.equal(normalizeTempoMap(events()), normalizeTempoMap(events()));
  assert.equal(getTempoAtBeat(events(), 0), 300);
  // An empty map is not a state a project can be in: it falls back to the seed.
  store.getState().setEvents([]);
  assert.deepEqual(shape(), [[0, 120, 'step']]);
  store.getState().setEvents([{ beat: 0, bpm: Number.POSITIVE_INFINITY }]);
  assert.deepEqual(shape(), [[0, 120, 'step']]);
}

// Every action REPLACES the array. Identity changes on a real edit, and the
// array from before the edit is untouched — the whole cache contract.
{
  reset();
  const before = events();
  store.getState().insertEvent(16, 90);
  assert.notEqual(events(), before, 'a real edit replaces the array');
  assert.deepEqual(before.map((e) => e.beat), [0], 'the previous array is unchanged');
  assert.ok(Object.isFrozen(events()));
  assert.deepEqual(shape(), [[0, 120, 'step'], [16, 90, 'step']]);
  // A no-op action does not replace it.
  const same = events();
  store.getState().removeEvent(999);
  assert.equal(events(), same, 'removing an event that is not there changes nothing');
  store.getState().moveEvent(999, 4);
  assert.equal(events(), same);
  store.getState().moveEvent(16, 16);
  assert.equal(events(), same);
  store.getState().setBpmAt(20, 90);
  assert.equal(events(), same, 'setting the tempo it already has changes nothing');
  store.getState().insertEvent(4, 0);
  assert.equal(events(), same, 'a bpm that is not a tempo is not an edit');
  store.getState().insertEvent(Number.NaN, 120);
  assert.equal(events(), same);
}

// insertEvent: a new change, or a replacement of the one already on that beat.
{
  reset();
  store.getState().insertEvent(8, 90, 'linear');
  store.getState().insertEvent(24, 174);
  assert.deepEqual(shape(), [[0, 120, 'step'], [8, 90, 'linear'], [24, 174, 'step']]);
  store.getState().insertEvent(8, 60); // replaces, curve included
  assert.deepEqual(shape(), [[0, 120, 'step'], [8, 60, 'step'], [24, 174, 'step']]);
  store.getState().insertEvent(9999, 128);
  assert.deepEqual(shape()[3], [9999, 128, 'step']);
  store.getState().insertEvent(4, 9999); // the clamp is the clock's, everywhere
  assert.deepEqual(shape()[1], [4, 300, 'step']);
}

// moveEvent keeps the tempo and the curve, re-sorts, and wins a collision.
{
  reset();
  store.getState().setEvents([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90, curve: 'linear' }, { beat: 16, bpm: 174 }]);
  store.getState().moveEvent(8, 20);
  assert.deepEqual(shape(), [[0, 120, 'step'], [16, 174, 'step'], [20, 90, 'linear']]);
  store.getState().moveEvent(20, 16); // onto an existing event: the mover wins
  assert.deepEqual(shape(), [[0, 120, 'step'], [16, 90, 'linear']]);
  store.getState().moveEvent(16, Number.NaN);
  assert.deepEqual(shape(), [[0, 120, 'step'], [16, 90, 'linear']], 'a junk destination is not a move');
}

// removeEvent drops one, and refuses to leave the project without a tempo.
{
  reset();
  store.getState().setEvents([{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90 }, { beat: 16, bpm: 174 }]);
  store.getState().removeEvent(8);
  assert.deepEqual(shape(), [[0, 120, 'step'], [16, 174, 'step']]);
  assert.ok(Object.isFrozen(events()) && Object.isFrozen(events()[0]));
  store.getState().removeEvent(0);
  assert.deepEqual(shape(), [[16, 174, 'step']], 'even the beat-0 event can go');
  const last = events();
  store.getState().removeEvent(16);
  assert.equal(events(), last, 'the last event is not removable');
}

// setBpmAt edits the event IN FORCE at that beat — it does not insert one, so
// the tempo before the beat is not silently split in two.
{
  reset();
  store.getState().setEvents([{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90, curve: 'linear' }]);
  store.getState().setBpmAt(20, 174);   // inside the second event's span
  assert.deepEqual(shape(), [[0, 120, 'step'], [16, 174, 'linear']], 'the curve survives');
  store.getState().setBpmAt(4, 60);     // inside the first event's span
  assert.deepEqual(shape(), [[0, 60, 'step'], [16, 174, 'linear']]);
  store.getState().setBpmAt(-100, 128); // before every event: the first one owns it
  assert.deepEqual(shape()[0], [0, 128, 'step']);
  store.getState().setBpmAt(0, 9999);
  assert.deepEqual(shape()[0], [0, 300, 'step']);
  store.getState().setBpmAt(0, Number.NaN);
  assert.deepEqual(shape()[0], [0, 300, 'step'], 'NaN is not a tempo');
}

// --- the wiring: the store's map is what beatClock runs on ------------------
{
  reset();
  beatClock.setMeterMap([{ bar: 0, meter: { num: 4, den: 4, groups: [] } }]);
  const off = subscribeTempoMap();
  // Subscribing pushes the current map at once, not on the next edit. The
  // events reach the clock verbatim — no seconds to strip, nothing out of
  // range, so the clock keeps the store's ARRAY and `tempoMap.ts`'s
  // identity cache keeps hitting. Pushing it again is therefore a true no-op,
  // which is the observable proof that the identity survived the trip.
  assert.deepEqual(beatClock.tempoMap, [{ beat: 0, bpm: 120, curve: 'step' }]);
  assert.equal(beatClock.bpm, 120);
  let clockEmits = 0;
  const offEmits = beatClock.subscribe(() => { clockEmits += 1; });
  beatClock.setTempoMap(events());
  assert.equal(clockEmits, 0, 'the store\'s own array, pushed again, changes nothing');
  offEmits();
  beatClock.setAnchor(0, 0);

  // An edit lands on the clock, and the clock's grid follows the MAP: 120 bpm
  // to beat 8 (4 s), then 60, so bar 3 (beat 12) is at 8 s, not 6.
  store.getState().insertEvent(8, 60);
  assert.deepEqual(beatClock.tempoMap.map((e) => [e.beat, e.bpm]), [[0, 120], [8, 60]]);
  beatClock.setAnchor(0, 0);
  assert.deepEqual([0, 1, 2, 3].map((b) => beatClock.timeOf(b)), [0, 2, 4, 8]);
  assert.equal(beatClock.nextGrid('bar', 4.1), 8);

  // A ramp reaches the clock the same way.
  store.getState().setEvents([{ beat: 0, bpm: 60, curve: 'linear' }, { beat: 16, bpm: 120 }]);
  beatClock.setAnchor(0, 0);
  const ramp = events();
  for (const beat of [4, 8, 12, 16]) {
    assert.ok(Math.abs(beatClock.timeOf(beat / 4) - beatToTime(ramp, beat)) < 1e-12, `bar at beat ${beat}`);
  }

  // Unsubscribed, the clock stops hearing about edits.
  off();
  const stale = beatClock.tempoMap;
  store.getState().setEvents([{ beat: 0, bpm: 174 }]);
  assert.deepEqual(beatClock.tempoMap, stale);
  // Leave the singleton clock as it was found.
  beatClock.setBpm(120, 'internal');
  reset();
}

console.log('tempoStore: ok');
