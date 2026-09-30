// noteEvents: spans to edges, in the order MIDI needs them — off before on at
// the same tick, deterministic below that, and un-migrated notes handled.
import assert from 'node:assert/strict';
import { DEFAULT_NOTE_CHANNEL, noteEvents } from './noteEvents.ts';
import { PPQ, tickOfStep, withTicks, type PianoNote } from '../state/pianoRollStore.ts';

/** [tick, type, note] — the shape every ordering assertion reads. */
const shape = (notes: readonly PianoNote[], stepsPerBeat?: number) =>
  noteEvents(notes, stepsPerBeat).map((e) => [e.tick, e.type, e.note]);

const n = (id: string, note: number, tick: number, ticks: number, extra: Partial<PianoNote> = {}): PianoNote =>
  withTicks({ id, note, velocity: 100, step: tick / 240, length: ticks / 240, tick, ticks, ...extra });

// One note is one pair, at its own ticks.
{
  assert.deepEqual(noteEvents([n('a', 60, 480, 240)]), [
    { tick: 480, type: 'on', note: 60, velocity: 100, channel: DEFAULT_NOTE_CHANNEL, id: 'a' },
    { tick: 720, type: 'off', note: 60, velocity: 0, channel: DEFAULT_NOTE_CHANNEL, id: 'a' },
  ]);
  assert.deepEqual(noteEvents([]), []);
}

// THE ordering rule: a note that ends exactly where the next starts releases
// FIRST, so a one-voice-per-pitch synth does not kill the note that just began.
{
  assert.deepEqual(shape([n('second', 60, 960, 960), n('first', 60, 0, 960)]), [
    [0, 'on', 60],
    [960, 'off', 60],
    [960, 'on', 60],
    [1920, 'off', 60],
  ]);
  // The same holds across pitches and out of input order.
  assert.deepEqual(shape([n('hi', 72, 240, 240), n('lo', 48, 0, 240), n('mid', 60, 240, 480)]), [
    [0, 'on', 48],
    [240, 'off', 48],
    [240, 'on', 60],
    [240, 'on', 72],
    [480, 'off', 72],
    [720, 'off', 60],
  ]);
}

// Below tick and edge the order is pitch, then channel, then id — so two runs
// over the same notes are byte-identical.
{
  const notes = [
    n('z', 64, 0, 240, { channel: 3 }),
    n('a', 64, 0, 240, { channel: 1 }),
    n('m', 60, 0, 240, { channel: 9 }),
  ];
  const once = noteEvents(notes).map((e) => `${e.tick}${e.type}${e.note}${e.channel}${e.id}`);
  assert.deepEqual(once, noteEvents([...notes].reverse()).map((e) => `${e.tick}${e.type}${e.note}${e.channel}${e.id}`));
  assert.deepEqual(noteEvents(notes).filter((e) => e.type === 'on').map((e) => [e.note, e.channel, e.id]), [
    [60, 9, 'm'],
    [64, 1, 'a'],
    [64, 3, 'z'],
  ]);
}

// Channel and expression: the model's 1-16, expression on the ON edge only.
{
  const [on, off] = noteEvents([n('e', 60, 0, 240, { channel: 11, expr: { pressure: 0.25, timbre: 1 } })]);
  assert.deepEqual([on.channel, off.channel], [11, 11]);
  assert.deepEqual(on.expr, { pressure: 0.25, timbre: 1 });
  assert.equal('expr' in off, false, 'a release carries no expression');
  // A note with no channel of its own plays on the default one.
  assert.equal(noteEvents([n('p', 60, 0, 240)])[0].channel, DEFAULT_NOTE_CHANNEL);
  // Velocity is playable on the ON edge and zero on the OFF edge.
  const loud = noteEvents([withTicks({ id: 'v', note: 60, step: 0, length: 1, velocity: 900 })]);
  assert.deepEqual([loud[0].velocity, loud[1].velocity], [127, 0]);
  const quiet = noteEvents([withTicks({ id: 'q', note: 60, step: 0, length: 1, velocity: 0 })]);
  assert.equal(quiet[0].velocity, 1, '0 is a note-off, never a note-on');
}

// Un-migrated notes — a paste, a fresh import, an older helper's output — are
// migrated on the way through, at whatever grid their steps were counted on.
{
  assert.deepEqual(shape([{ id: 'raw', note: 60, step: 2, length: 2, velocity: 90 }]), [
    [480, 'on', 60],
    [960, 'off', 60],
  ]);
  // A triplet grid: step 3 is one beat, so the note starts at PPQ.
  assert.deepEqual(shape([{ id: 'trip', note: 60, step: 3, length: 3, velocity: 90 }], 3), [
    [PPQ, 'on', 60],
    [PPQ * 2, 'off', 60],
  ]);
  // A note whose step was rewritten under stale ticks follows the step.
  assert.deepEqual(shape([{ id: 'stale', note: 60, step: 8, length: 1, velocity: 90, tick: 605, ticks: 60 }]), [
    [tickOfStep(8), 'on', 60],
    [tickOfStep(9), 'off', 60],
  ]);
  // Nothing is ever zero length: a release always comes after its own attack.
  const [a, b] = noteEvents([{ id: 'tiny', note: 60, step: 0, length: 0, velocity: 90, tick: 0, ticks: 0 }]);
  assert.ok(b.tick > a.tick, 'an off never lands on its own on');
}

console.log('noteEvents: ok');
