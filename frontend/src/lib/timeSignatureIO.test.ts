/**
 * The `.tasmo` / DAW-import meter conversions, pinned without the module graph
 * that makes `projectImport.ts` unimportable under tsx (it reaches a Vite `?url`
 * import through the MIDI synth).
 *
 * A `.tasmo` stores the meter as a `[num, den]` pair; the editor holds
 * `{ num, den }`. A document with no pair, or one the editor cannot bar out, is
 * 4/4 — never clamped into some other meter, which would re-bar the song.
 *
 * Run: `npx tsx src/lib/timeSignatureIO.test.ts`
 */
import assert from 'node:assert/strict';
import { meterFromTasmo, meterToTasmo, validTimeSignature } from './timeSignatureIO';

/* ── meterFromTasmo ──────────────────────────────────────────────────────── */
assert.deepEqual(meterFromTasmo([7, 8]), { num: 7, den: 8 }, '[7,8] is 7/8');
assert.deepEqual(meterFromTasmo(undefined), { num: 4, den: 4 }, 'no field is 4/4');
assert.deepEqual(meterFromTasmo(null), { num: 4, den: 4 }, 'a null field is 4/4');
assert.deepEqual(meterFromTasmo([5, 3]), { num: 4, den: 4 }, 'a non-power-of-two denominator is refused');
assert.deepEqual(meterFromTasmo([]), { num: 4, den: 4 }, 'an empty pair is 4/4');
assert.deepEqual(meterFromTasmo([7]), { num: 4, den: 4 }, 'half a pair is 4/4');
assert.deepEqual(meterFromTasmo([0, 4]), { num: 4, den: 4 }, 'zero beats is refused');
assert.deepEqual(meterFromTasmo([3.5, 4]), { num: 4, den: 4 }, 'fractional beats are refused');

/* ── meterToTasmo ────────────────────────────────────────────────────────── */
assert.deepEqual(meterToTasmo({ num: 7, den: 8 }), [7, 8]);

/* ── round trip: every meter the editor accepts survives save → open ─────── */
for (const den of [1, 2, 4, 8, 16, 32]) {
  for (const num of [1, 3, 4, 5, 7, 12, 32]) {
    assert.deepEqual(meterFromTasmo(meterToTasmo({ num, den })), { num, den }, `${num}/${den} round-trips`);
  }
}

/* ── the validator the store re-exports lives here ───────────────────────── */
assert.deepEqual(validTimeSignature(6, 8), { num: 6, den: 8 });
assert.equal(validTimeSignature(33, 4), null);
assert.equal(validTimeSignature(4, 6), null);

console.log('timeSignatureIO: ok');
