import assert from 'node:assert/strict';
import { QUALITY_TIERS, STEM_MODES, expectedRoles } from './stemModes';

// The wire values are the backend contract and never change.
assert.deepEqual(STEM_MODES.map((m) => m.value), [2, 4, 6, 12]);

// What the user actually gets back. The 12 mode is the liar: it runs the
// 6-stem split and replaces the drum mix with five drum parts, so ten files.
assert.deepEqual(STEM_MODES.map((m) => m.partCount), [2, 4, 6, 10]);

// Every mode's role list is exactly as long as it claims, and has no repeats.
for (const mode of STEM_MODES) {
  assert.equal(mode.roles.length, mode.partCount, `${mode.value}: roles length`);
  assert.equal(new Set(mode.roles).size, mode.roles.length, `${mode.value}: roles unique`);
  assert.ok(
    mode.roles.every((r) => r.length > 0 && r === r.toLowerCase()),
    `${mode.value}: roles are non-empty lower case`,
  );
}

// The exact roles, so a backend change that renames one fails here.
assert.deepEqual(expectedRoles(2), ['vocals', 'instrumental']);
assert.deepEqual(expectedRoles(4), ['vocals', 'drums', 'bass', 'other']);
assert.deepEqual(expectedRoles(6), ['vocals', 'drums', 'bass', 'guitar', 'piano', 'other']);
assert.deepEqual(expectedRoles(12), [
  'vocals',
  'bass',
  'guitar',
  'piano',
  'other',
  'kick',
  'snare',
  'toms',
  'hi-hat',
  'cymbals',
]);

// The detailed mode drops the drum mix rather than adding to it.
assert.ok(!expectedRoles(12).includes('drums'));

// A hint that omits a role would be the old lie again, so pin the tie.
for (const mode of STEM_MODES) {
  const hint = mode.hint.toLowerCase();
  for (const role of mode.roles) {
    assert.ok(hint.includes(role), `${mode.value}: hint names ${role}`);
  }
}

// Only the detailed mode carries the licence/normalisation notice.
assert.deepEqual(
  STEM_MODES.filter((m) => m.notice !== undefined).map((m) => m.value),
  [12],
);
const detailed = STEM_MODES[3];
assert.equal(detailed.label, 'Detailed · 10 parts');
assert.ok(detailed.notice?.includes('CC BY-NC 4.0'));
assert.ok(detailed.notice?.includes('LARSNET'));

// Labels do not promise twelve of anything.
assert.ok(STEM_MODES.every((m) => !m.label.includes('12')));

// Unknown wire values are a programming error, not a silent empty list.
for (const bad of [0, 3, 8, Number.NaN, Number.POSITIVE_INFINITY]) {
  assert.throws(() => expectedRoles(bad as 2), RangeError);
}

// The roles array is frozen: callers cannot corrupt the shared model.
assert.throws(() => {
  (expectedRoles(4) as string[]).push('nope');
});

// Quality tiers mirror the backend presets in backend/main.py's
// _QUALITY_PRESETS. Only the 4-stem family switches model.
assert.deepEqual(QUALITY_TIERS.map((q) => q.value), ['fast', 'balanced', 'hq']);
assert.deepEqual(QUALITY_TIERS.map((q) => q.label), ['Fast', 'Balanced', 'HQ']);
assert.deepEqual(QUALITY_TIERS.map((q) => q.hint), ['Fastest', 'Slower', 'Slowest']);

assert.equal(QUALITY_TIERS[0].detail.fourStem, 'htdemucs, shifts 0, overlap 0.25');
assert.equal(QUALITY_TIERS[1].detail.fourStem, 'htdemucs_ft, shifts 1, overlap 0.25');
assert.equal(QUALITY_TIERS[2].detail.fourStem, 'htdemucs_ft, shifts 2, overlap 0.5');

assert.equal(QUALITY_TIERS[0].detail.fixedModel, 'shifts 0, overlap 0.25');
assert.equal(QUALITY_TIERS[1].detail.fixedModel, 'shifts 1, overlap 0.25');
assert.equal(QUALITY_TIERS[2].detail.fixedModel, 'shifts 2, overlap 0.5');

// No tier claims a wall-clock time; those numbers were never measured.
for (const tier of QUALITY_TIERS) {
  const text = `${tier.label} ${tier.hint} ${tier.detail.fourStem} ${tier.detail.fixedModel}`;
  assert.ok(!/\b(min|sec|s a track|minutes|seconds)\b/i.test(text), `${tier.value}: no time estimate`);
  // The fixed-model families never name a model, only the passes/overlap knobs.
  assert.ok(!/htdemucs/.test(tier.detail.fixedModel), `${tier.value}: fixed-model detail names no model`);
}

console.log('stemModes: ok');
