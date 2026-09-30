/**
 * The roll's key: named, cleaned, read from notes, and as a scale.
 *
 *   cd frontend && npx tsx src/lib/rollKey.test.ts
 */
import assert from 'node:assert/strict';
import { cleanRollKey, estimateRollKey, parseRollKey, rollKeyName, rollKeyScale, tonicPitchClass } from './rollKey.ts';

// ── names ───────────────────────────────────────────────────────────────────
assert.deepEqual(parseRollKey('C major'), { tonic: 'C', mode: 'major' });
assert.deepEqual(parseRollKey('f# minor'), { tonic: 'F#', mode: 'minor' });
assert.deepEqual(parseRollKey('Bb'), { tonic: 'Bb', mode: 'major' });
assert.deepEqual(parseRollKey('e'), { tonic: 'E', mode: 'minor' }, 'a lowercase letter alone is minor');
assert.deepEqual(parseRollKey('E♭ Major'), { tonic: 'Eb', mode: 'major' });
assert.equal(parseRollKey('D dorian'), null, 'a mode the roll has no key for');
assert.equal(parseRollKey(''), null);
assert.equal(parseRollKey(undefined), null);
assert.equal(cleanRollKey({ tonic: 'H', mode: 'major' }), null);
assert.equal(cleanRollKey({ tonic: 'C', mode: 'lydian' }), null);
assert.equal(cleanRollKey('C major'), null, 'only the object form');
assert.equal(rollKeyName({ tonic: 'F#', mode: 'minor' }), 'F# minor');
assert.equal(tonicPitchClass('Cb'), 11);
assert.equal(tonicPitchClass('B#'), 0);
assert.equal(tonicPitchClass('X'), null);

// ── scales ──────────────────────────────────────────────────────────────────
assert.deepEqual(rollKeyScale({ tonic: 'D', mode: 'major' }), { tonic: 2, steps: [0, 2, 4, 5, 7, 9, 11] });
assert.deepEqual(rollKeyScale({ tonic: 'A', mode: 'minor' }).steps, [0, 2, 3, 5, 7, 8, 10], 'natural minor');

// ── read from the notes ─────────────────────────────────────────────────────
const line = (pitches: number[], ticks = 960) => pitches.map((note) => ({ note, ticks }));
assert.deepEqual(estimateRollKey([]), { tonic: 'C', mode: 'major' }, 'no notes: C major');
assert.deepEqual(estimateRollKey(line([60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60])), { tonic: 'C', mode: 'major' });
assert.deepEqual(estimateRollKey(line([67, 69, 71, 72, 74, 76, 78, 79, 74, 71, 67])), { tonic: 'G', mode: 'major' });
assert.deepEqual(estimateRollKey(line([57, 59, 60, 62, 64, 65, 68, 69, 64, 60, 57])), { tonic: 'A', mode: 'minor' }, 'A harmonic minor');
assert.deepEqual(estimateRollKey(line([61, 63, 64, 66, 68, 69, 72, 73, 68, 64, 61])), { tonic: 'C#', mode: 'minor' }, 'a minor key spelled with sharps');
assert.deepEqual(estimateRollKey(line([58, 60, 62, 63, 65, 67, 69, 70, 65, 62, 58])), { tonic: 'Bb', mode: 'major' }, 'a major key spelled with flats');
// Length weighs: a long D and A over a short run.
assert.equal(estimateRollKey([{ note: 62, ticks: 7680 }, { note: 69, ticks: 7680 }, { note: 66, ticks: 3840 }, { note: 60, ticks: 60 }]).tonic, 'D');
// Steps stand in for ticks.
assert.deepEqual(estimateRollKey([60, 64, 67, 72].map((note) => ({ note, length: 4 }))), { tonic: 'C', mode: 'major' });

console.log('rollKey: ok');
