/**
 * Pure note operations for editor clips.
 *
 * Every clip bounced from the piano roll carries its notes along as
 * `PianoNote[]` on a 16th-note step grid, so the assistant can re-quantize,
 * nudge, transpose and clean a clip without ever decoding audio. That makes
 * these functions the only thing standing between "make it tighter" and a
 * mangled clip, which is why the arithmetic is pinned here rather than trusted
 * to a UI slider.
 *
 * Run: `npx tsx src/lib/clipNotes/clipNotes.test.ts`
 */
import assert from 'node:assert/strict';
import type { PianoNote } from '../../state/pianoRollStore';
import {
  PPQ,
  STEPS_PER_BEAT,
  divisionToSteps,
  filterNotes,
  fixOverlaps,
  humanizeNotes,
  msToSteps,
  nudgeNotes,
  quantizeNotes,
  scaleVelocity,
  secToStep,
  stepToSec,
  stepsToMs,
  stepsToTicks,
  ticksToSteps,
  transposeNotes,
} from './index';

const n = (
  id: string,
  note: number,
  step: number,
  length: number,
  velocity = 100,
): PianoNote => ({ id, note, step, length, velocity });

const close = (actual: number, expected: number, what: string): void => {
  assert.ok(
    Math.abs(actual - expected) < 1e-9,
    `${what}: expected ${expected}, got ${actual}`,
  );
};

// ---------------------------------------------------------------- units

assert.equal(STEPS_PER_BEAT, 4, 'a step is a 16th, a beat is a quarter');
assert.equal(PPQ, 480);

close(stepToSec(4, 120), 0.5, 'four steps at 120 BPM is one beat');
close(secToStep(0.5, 120), 4, 'and back again');
close(stepToSec(0, 120), 0, 'step zero is second zero');
close(secToStep(stepToSec(7.25, 99), 99), 7.25, 'round trip at 99 BPM');

close(msToSteps(125, 120), 1, '125ms at 120 BPM is one 16th');
close(msToSteps(500, 120), 4, '500ms at 120 BPM is one beat');
close(msToSteps(-125, 120), -1, 'negative nudges stay negative');
close(stepsToMs(1, 120), 125, 'and the inverse');

close(ticksToSteps(480), 4, 'one quarter of ticks is one beat of steps');
close(ticksToSteps(120), 1, 'a 16th is 120 ticks');
close(stepsToTicks(4), 480, 'and the inverse');

close(divisionToSteps('1/1'), 16, 'a 4/4 bar');
close(divisionToSteps('1/2'), 8, '');
close(divisionToSteps('1/4'), 4, '');
close(divisionToSteps('1/8'), 2, '');
close(divisionToSteps('1/16'), 1, '');
close(divisionToSteps('1/32'), 0.5, '');
close(divisionToSteps('1/4T'), 8 / 3, 'triplets are fractional steps');
close(divisionToSteps('1/8T'), 4 / 3, '');
close(divisionToSteps('1/16T'), 2 / 3, '');
close(divisionToSteps('1/4D'), 6, 'dotted are 3/2');
close(divisionToSteps('1/8D'), 3, '');
close(divisionToSteps('1/16D'), 1.5, '');
close(divisionToSteps('1/64'), 0.25, 'a 64th is a quarter step');
close(divisionToSteps('1/32T'), 1 / 3, '');
close(divisionToSteps('1/16Q'), 4 / 5, 'quintuplet 16ths: five in a beat');
close(divisionToSteps('1/16S'), 4 / 7, 'septuplet 16ths: seven in a beat');
close(divisionToSteps('off'), 0, 'off has no grid');
{
  // A quintuplet run quantized to its own grid lands on it: 0, 0.8, 1.6, 2.4, 3.2 steps.
  const run = [0.05, 0.83, 1.58, 2.41, 3.22].map((step, i) => n(`q${i}`, 60, step, 0.5));
  const out = quantizeNotes(run, { grid: '1/16Q', strength: 1 });
  out.forEach((x, i) => close(x.step, i * 0.8, `quintuplet ${i}`));
}

// ------------------------------------------------------------- quantize

const loose = [n('a', 60, 0.4, 1), n('b', 62, 2.6, 1)];

const full = quantizeNotes(loose, { grid: '1/16' });
close(full[0].step, 0, 'strength 1 snaps all the way');
close(full[1].step, 3, '2.6 rounds up to 3');
assert.equal(full[0].id, 'a', 'ids survive');
assert.equal(full[1].id, 'b');
assert.notEqual(full[0], loose[0], 'new objects, not mutated ones');
close(loose[0].step, 0.4, 'the input is untouched');
close(loose[1].step, 2.6, '');

const none = quantizeNotes(loose, { grid: '1/16', strength: 0 });
close(none[0].step, 0.4, 'strength 0 moves nothing');
close(none[1].step, 2.6, '');

const half = quantizeNotes(loose, { grid: '1/16', strength: 0.5 });
close(half[0].step, 0.2, 'strength 0.5 goes halfway to the line');
close(half[1].step, 2.8, '');

// Swing pushes every second grid line late by swing * gridSteps / 2. A 1/8
// grid is 2 steps, so at full swing the lines are 0, 3, 4, 7, 8 ... — the
// offbeat lands a dotted 8th in, the hardest shuffle the control allows.
const swung = quantizeNotes(
  [n('a', 60, 0.2, 1), n('b', 60, 2.6, 1), n('c', 60, 4.2, 1)],
  { grid: '1/8', swing: 1 },
);
close(swung[0].step, 0, 'downbeats stay put');
close(swung[1].step, 3, 'the offbeat line moved late');
close(swung[2].step, 4, 'the next downbeat is still square');

const halfSwung = quantizeNotes([n('a', 60, 2.6, 1)], { grid: '1/8', swing: 0.5 });
close(halfSwung[0].step, 2.5, 'half swing is half as far late');

const negSwing = quantizeNotes([n('a', 60, 2.4, 1)], { grid: '1/8', swing: -1 });
close(negSwing[0].step, 1, 'negative swing drags the offbeat early');

const triplet = quantizeNotes([n('a', 60, 1.3, 1), n('b', 60, 2.5, 1)], {
  grid: '1/8T',
});
close(triplet[0].step, 4 / 3, '1.3 lands on the first 8th triplet');
close(triplet[1].step, 8 / 3, '2.5 lands on the second');

const ends = quantizeNotes([n('a', 60, 0.4, 1.2)], {
  grid: '1/16',
  quantizeEnds: true,
});
close(ends[0].step, 0, '');
close(ends[0].length, 2, 'the end snapped to step 2 as well');

const kept = quantizeNotes([n('a', 60, 0.4, 1.2)], { grid: '1/16' });
close(kept[0].length, 1.2, 'without quantizeEnds the length is left alone');

const squashed = quantizeNotes([n('a', 60, 0.1, 0.2)], {
  grid: '1/16',
  quantizeEnds: true,
});
close(squashed[0].length, 0.25, 'a note may never be quantized out of existence');

assert.deepEqual(quantizeNotes([], { grid: '1/16' }), [], 'empty in, empty out');
const off = quantizeNotes(loose, { grid: 'off' });
close(off[0].step, 0.4, 'grid off is a copy, not a move');
assert.notEqual(off[0], loose[0], 'still a copy');

// Regression: a clip authored at 99 BPM, already sitting on its own grid, must
// survive a re-quantize untouched. Step space is BPM-independent by
// construction — this pins that it stays that way.
const authored99: PianoNote[] = [
  n('r1', 60, 0, 2),
  n('r2', 64, 2, 2),
  n('r3', 67, 4, 4),
  n('r4', 72, 8, 8),
];
close(stepToSec(2, 99), (60 / 99) / 2, 'two steps at 99 BPM is half a beat');
for (const grid of ['1/16', '1/8'] as const) {
  assert.deepEqual(
    quantizeNotes(authored99, { grid, quantizeEnds: true }),
    authored99,
    `on-grid 99 BPM clip is unchanged at ${grid}`,
  );
}

// ---------------------------------------------------------------- nudge

const toNudge = [n('a', 60, 0, 1), n('b', 62, 4, 1)];

const bySteps = nudgeNotes(toNudge, { steps: 2 });
close(bySteps[0].step, 2, '');
close(bySteps[1].step, 6, '');
assert.equal(bySteps[0].id, 'a', 'ids survive');

const byMs = nudgeNotes(toNudge, { ms: 125, bpm: 120 });
close(byMs[0].step, 1, '125ms at 120 BPM is one step');
close(byMs[1].step, 5, '');

const byTicks = nudgeNotes(toNudge, { ticks: 240 });
close(byTicks[0].step, 2, '240 ticks is half a beat');

const clamped = nudgeNotes(toNudge, { steps: -2 });
close(clamped[0].step, 0, 'a note can never be pushed before the start');
close(clamped[1].step, 2, 'but the rest still move');
close(toNudge[0].step, 0, 'input untouched');

assert.deepEqual(nudgeNotes([], { steps: 1 }), [], 'empty in, empty out');
assert.throws(
  () => nudgeNotes(toNudge, { steps: 1, ms: 10, bpm: 120 }),
  /exactly one/,
  'two units at once is a caller bug, not a silent guess',
);
assert.throws(() => nudgeNotes(toNudge, {}), /exactly one/, 'and so is none');
assert.throws(
  () => nudgeNotes(toNudge, { ms: 10 }),
  /bpm/,
  'milliseconds mean nothing without a tempo',
);

// ------------------------------------------------------------ transpose

const pitches = [n('a', 60, 0, 1), n('b', 125, 1, 1), n('c', 2, 2, 1)];
const up = transposeNotes(pitches, 5);
assert.equal(up[0].note, 65);
assert.equal(up[1].note, 127, 'clamped at the top of the MIDI range');
assert.equal(up[2].note, 7);
const down = transposeNotes(pitches, -10);
assert.equal(down[0].note, 50);
assert.equal(down[2].note, 0, 'clamped at the bottom');
assert.equal(pitches[1].note, 125, 'input untouched');
assert.equal(up[0].id, 'a', 'ids survive');
assert.deepEqual(transposeNotes([], 5), []);
assert.deepEqual(transposeNotes(pitches, 0), pitches, 'zero is identity');

// ------------------------------------------------------------- velocity

const vels = [n('a', 60, 0, 1, 100), n('b', 60, 1, 1, 10), n('c', 60, 2, 1, 40)];

const halved = scaleVelocity(vels, { factor: 0.5 });
assert.equal(halved[0].velocity, 50);
assert.equal(halved[1].velocity, 5);
assert.equal(halved[0].id, 'a', 'ids survive');

const boosted = scaleVelocity(vels, { factor: 2 });
assert.equal(boosted[0].velocity, 127, 'never above 127');

const floored = scaleVelocity(vels, { offset: -200 });
assert.equal(floored[0].velocity, 1, 'never silent — 1 is the floor');

const shifted = scaleVelocity(vels, { offset: 12 });
assert.equal(shifted[2].velocity, 52);

const windowed = scaleVelocity(vels, { min: 40, max: 80 });
assert.equal(windowed[0].velocity, 80, 'squeezed down to the ceiling');
assert.equal(windowed[1].velocity, 40, 'and up to the floor');
assert.equal(windowed[2].velocity, 40, 'already inside the window');

const insane = scaleVelocity(vels, { min: -50, max: 900 });
assert.equal(insane[0].velocity, 100, 'a silly window still obeys MIDI');
assert.equal(insane[1].velocity, 10);

assert.equal(vels[0].velocity, 100, 'input untouched');
assert.deepEqual(scaleVelocity([], { factor: 2 }), []);
assert.deepEqual(scaleVelocity(vels, {}), vels, 'no options is identity');

// ------------------------------------------------------------- humanize

const tight = [
  n('a', 60, 0, 1, 100),
  n('b', 62, 4, 1, 100),
  n('c', 64, 8, 1, 100),
  n('d', 65, 12, 1, 100),
];

const seededA = humanizeNotes(tight, { seed: 1234 });
const seededB = humanizeNotes(tight, { seed: 1234 });
assert.deepEqual(seededA, seededB, 'the same seed gives the same clip');
const seededC = humanizeNotes(tight, { seed: 5678 });
assert.notDeepEqual(seededA, seededC, 'a different seed gives a different clip');
assert.notDeepEqual(seededA, tight, 'and it actually moved something');

for (const [i, note] of seededA.entries()) {
  assert.equal(note.id, tight[i].id, 'ids survive');
  assert.equal(note.note, tight[i].note, 'pitch is never humanized');
  assert.equal(note.length, tight[i].length, 'neither is length');
  assert.ok(
    Math.abs(note.step - tight[i].step) <= 0.1 + 1e-9,
    `timing stays inside the default +/-0.1 step: ${note.step}`,
  );
  assert.ok(
    Math.abs(note.velocity - 100) <= 8,
    `velocity stays inside the default +/-8: ${note.velocity}`,
  );
  assert.ok(Number.isInteger(note.velocity), 'velocity is a whole number');
}

const wide = humanizeNotes(tight, { seed: 7, timingSteps: 2, velocity: 40 });
for (const [i, note] of wide.entries()) {
  assert.ok(note.step >= 0, 'never before the start of the clip');
  assert.ok(
    Math.abs(note.step - tight[i].step) <= 2 + 1e-9,
    'timing stays inside the requested window',
  );
  assert.ok(note.velocity >= 1 && note.velocity <= 127, 'velocity stays legal');
}

const timingOnly = humanizeNotes(tight, { seed: 9, velocity: 0 });
for (const [i, note] of timingOnly.entries()) {
  assert.equal(note.velocity, tight[i].velocity, 'velocity 0 leaves it alone');
}
const velocityOnly = humanizeNotes(tight, { seed: 9, timingSteps: 0 });
for (const [i, note] of velocityOnly.entries()) {
  close(note.step, tight[i].step, 'timing 0 leaves it alone');
}

assert.equal(tight[0].step, 0, 'input untouched');
assert.deepEqual(humanizeNotes([], { seed: 1 }), []);
assert.deepEqual(
  humanizeNotes(tight, { seed: 1, timingSteps: 0, velocity: 0 }),
  tight,
  'zero amounts is identity',
);

// A note already at the start cannot be dragged negative by an early offset.
const atZero = humanizeNotes([n('a', 60, 0, 1, 100)], {
  seed: 42,
  timingSteps: 4,
});
assert.ok(atZero[0].step >= 0, 'clamped at zero');

// ------------------------------------------------------------- overlaps

const stacked: PianoNote[] = [
  n('a', 60, 0, 1, 80),
  n('b', 60, 0, 1, 100),
  n('c', 64, 0, 1, 90),
];
const deduped = fixOverlaps(stacked, { mode: 'dedupe' });
assert.equal(deduped.length, 2, 'the duplicate pitch+start pair collapsed');
assert.equal(deduped[0].id, 'b', 'and the loudest of the pair survived');
assert.equal(deduped[1].id, 'c', 'a different pitch is not a duplicate');
assert.equal(stacked.length, 3, 'input untouched');

const gapped: PianoNote[] = [
  n('a', 60, 0, 1),
  n('b', 64, 1, 1),
  n('c', 60, 4, 1),
  n('d', 60, 8, 2),
];
const legato = fixOverlaps(gapped, { mode: 'legato' });
close(legato[0].length, 4, 'extended to the next onset of the same pitch');
close(legato[1].length, 1, 'a lone pitch is left alone');
close(legato[2].length, 4, '');
close(legato[3].length, 2, 'the last note of a pitch keeps its length');
assert.equal(legato[0].id, 'a', 'ids survive');
close(gapped[0].length, 1, 'input untouched');

const overlapping: PianoNote[] = [
  n('a', 60, 0, 6),
  n('b', 60, 4, 1),
  n('c', 62, 0, 1),
];
const trimmed = fixOverlaps(overlapping, { mode: 'trim' });
close(trimmed[0].length, 4, 'the overlapping tail was cut at the next onset');
close(trimmed[1].length, 1, 'a note that does not overlap is untouched');
close(trimmed[2].length, 1, 'and a different pitch never overlaps');
const shortOnly = fixOverlaps([n('a', 60, 0, 1), n('b', 60, 4, 1)], {
  mode: 'trim',
});
close(shortOnly[0].length, 1, 'trim only ever shortens, it never extends');

const collided = fixOverlaps([n('a', 60, 0, 4), n('b', 60, 0, 4)], {
  mode: 'trim',
});
close(collided[0].length, 0.25, 'even a zero gap leaves a playable note');

assert.deepEqual(fixOverlaps([], { mode: 'legato' }), []);
assert.deepEqual(fixOverlaps([], { mode: 'trim' }), []);
assert.deepEqual(fixOverlaps([], { mode: 'dedupe' }), []);

// --------------------------------------------------------------- filter

const garbage: PianoNote[] = [
  n('keep1', 60, 0, 2, 90),
  n('short', 61, 2, 0.1, 90),
  n('quiet', 62, 3, 2, 3),
  n('keep2', 64, 5, 2, 80),
  n('low', 20, 7, 2, 90),
  n('high', 110, 9, 2, 90),
];

const byLength = filterNotes(garbage, { minLengthSteps: 0.5 });
assert.deepEqual(
  byLength.removed.map((x) => x.id),
  ['short'],
  'only the blip went',
);
assert.equal(byLength.kept.length, 5);
assert.equal(byLength.kept[0].id, 'keep1', 'input order is preserved');

const byVelocity = filterNotes(garbage, { minVelocity: 10 });
assert.deepEqual(byVelocity.removed.map((x) => x.id), ['quiet']);

const byPitch = filterNotes(garbage, { minPitch: 40, maxPitch: 100 });
assert.deepEqual(byPitch.removed.map((x) => x.id), ['low', 'high']);

const everything = filterNotes(garbage, {
  minLengthSteps: 0.5,
  minVelocity: 10,
  minPitch: 40,
  maxPitch: 100,
});
assert.deepEqual(everything.kept.map((x) => x.id), ['keep1', 'keep2']);
assert.equal(everything.removed.length, 4);

// A stray note miles from anything else is transcription noise.
const stray: PianoNote[] = [
  n('a', 60, 0, 1),
  n('b', 62, 2, 1),
  n('c', 64, 4, 1),
  n('far', 70, 200, 1),
];
const byGap = filterNotes(stray, { maxGapSteps: 16 });
assert.deepEqual(byGap.removed.map((x) => x.id), ['far']);
assert.equal(byGap.kept.length, 3);

// A note played *inside* a held one is not stranded, however long the held
// note has been ringing. The gap before a note is measured against the furthest
// end reached so far, not against whichever note happens to start last — a pad
// under a melody would otherwise make every melody note look isolated.
const sustained = filterNotes(
  [n('pad', 48, 0, 16), n('grace', 60, 1, 0.5), n('inside', 64, 8, 1)],
  { maxGapSteps: 2 },
);
assert.deepEqual(
  sustained.kept.map((x) => x.id),
  ['pad', 'grace', 'inside'],
  'nothing is stranded while the pad is still sounding',
);
assert.equal(sustained.removed.length, 0);

const underHeld = filterNotes([n('pad', 48, 0, 16), n('inside', 64, 8, 1)], {
  maxGapSteps: 2,
});
assert.deepEqual(underHeld.kept.map((x) => x.id), ['pad', 'inside']);

// Once the held note has finished, distance counts again.
const afterHeld = filterNotes(
  [n('pad', 48, 0, 16), n('grace', 60, 1, 0.5), n('late', 64, 200, 1)],
  { maxGapSteps: 2 },
);
assert.deepEqual(afterHeld.removed.map((x) => x.id), ['late']);

const lonely = filterNotes([n('only', 60, 40, 1)], { maxGapSteps: 4 });
assert.equal(lonely.kept.length, 1, 'a clip of one note has no neighbours to be far from');
assert.equal(lonely.removed.length, 0);

const nothing = filterNotes(garbage, {});
assert.equal(nothing.kept.length, garbage.length, 'no thresholds keeps everything');
assert.equal(nothing.removed.length, 0);
assert.notEqual(nothing.kept[0], garbage[0], 'and still hands back copies');

const empty = filterNotes([], { minVelocity: 10 });
assert.deepEqual(empty.kept, []);
assert.deepEqual(empty.removed, []);

assert.equal(garbage.length, 6, 'input untouched');

console.log('clipNotes: ok');
