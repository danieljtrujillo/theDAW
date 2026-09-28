/**
 * Motif cells: extraction reads intervals, durations and metric positions;
 * each transform on a known cell gives the exact notes; diatonic inversion
 * stays in its scale; retrograde twice and augment-then-diminish are the
 * identity; liquidation ends on one note; metric realization lands on the
 * group starts of 7/8.
 *
 * Run: `npx tsx src/lib/motif.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  applyChain,
  augment,
  createThemeRegistry,
  describeCell,
  diminish,
  extractCell,
  extractCells,
  fragment,
  inScale,
  invert,
  invertDiatonic,
  liquidate,
  realizeCell,
  recallTheme,
  registerTheme,
  retrograde,
  scaleOf,
  sequence,
  toDegree,
  fromDegree,
  transpose,
  transposeDiatonic,
  type MotifCell,
} from './motif';
import type { MeterSegment } from './meterMap';

const Q = 960;
const E = 480;
const pitches = (c: MotifCell): number[] => c.notes.map((n) => n.note);
const timing = (c: MotifCell): Array<[number, number]> => c.notes.map((n) => [n.at, n.ticks]);

// C4 quarter, E4 eighth, D4 eighth, G4 half: one 4/4 bar.
const CELL = extractCell([
  { note: 60, tick: 0, ticks: Q },
  { note: 64, tick: Q, ticks: E },
  { note: 62, tick: Q + E, ticks: E },
  { note: 67, tick: 2 * Q, ticks: 2 * Q },
]);
const C_MAJOR = scaleOf('C', 'major');

// ── extraction ──────────────────────────────────────────────────────────────
{
  assert.equal(CELL.length, 4 * Q);
  assert.deepEqual(pitches(CELL), [60, 64, 62, 67]);
  const d = describeCell(CELL);
  assert.deepEqual(d.intervals, [4, -2, 5]);
  assert.deepEqual(d.durations, [Q, E, E, 2 * Q]);
  assert.deepEqual(d.iois, [Q, E, E, 2 * Q]);
  assert.deepEqual(
    d.metric.map((m) => [m.bar, m.pulse, m.frac, m.accent]),
    [[0, 0, 0, 'bar'], [0, 1, 0, 'pulse'], [0, 1, 0.5, 'off'], [0, 2, 0, 'pulse']],
  );
  // Steps fill in for ticks, and the cell starts at its first note.
  const late = extractCell([{ note: 72, step: 8, length: 4 }, { note: 74, step: 12, length: 4 }]);
  assert.deepEqual(timing(late), [[0, Q], [Q, Q]]);
  assert.equal(late.place?.tick, 2 * Q);
}

// ── scale degrees ───────────────────────────────────────────────────────────
{
  assert.deepEqual(toDegree(60, C_MAJOR), { deg: 35, alt: 0 });
  assert.deepEqual(toDegree(61, C_MAJOR), { deg: 35, alt: 1 });
  assert.equal(fromDegree(36, 0, C_MAJOR), 62);
  assert.equal(scaleOf('Bb').tonic, 10);
  assert.equal(scaleOf('f#', 'minor').tonic, 6);
}

// ── each transform on the known cell ────────────────────────────────────────
{
  assert.deepEqual(pitches(transpose(CELL, 2)), [62, 66, 64, 69]);
  assert.deepEqual(timing(transpose(CELL, 2)), timing(CELL));
  assert.deepEqual(pitches(transposeDiatonic(CELL, 1, C_MAJOR)), [62, 65, 64, 69]);
  assert.deepEqual(pitches(transposeDiatonic(CELL, -7, C_MAJOR)), [48, 52, 50, 55], 'seven steps is an octave');
  // A chromatic note keeps its alteration: C#4 up a step in C major is D#4.
  assert.deepEqual(pitches(transposeDiatonic(extractCell([{ note: 61, tick: 0, ticks: Q }]), 1, C_MAJOR)), [63]);

  assert.deepEqual(pitches(invert(CELL)), [60, 56, 58, 53], 'about the first note');
  assert.deepEqual(pitches(invert(CELL, 62)), [64, 60, 62, 57]);
  assert.deepEqual(pitches(invertDiatonic(CELL, C_MAJOR)), [60, 57, 59, 53]);

  const r = retrograde(CELL);
  assert.deepEqual(pitches(r), [67, 62, 64, 60]);
  assert.deepEqual(timing(r), [[0, 2 * Q], [2 * Q, E], [2 * Q + E, E], [3 * Q, Q]]);
  assert.equal(r.length, 4 * Q);

  const a = augment(CELL);
  assert.deepEqual(timing(a), [[0, 2 * Q], [2 * Q, Q], [3 * Q, Q], [4 * Q, 4 * Q]]);
  assert.equal(a.length, 8 * Q);
  const dm = diminish(CELL);
  assert.deepEqual(timing(dm), [[0, E], [E, 240], [E + 240, 240], [Q, Q]]);
  assert.equal(dm.length, 2 * Q);
  assert.deepEqual(timing(augment(CELL, 3)).map(([at]) => at), [0, 3 * Q, 3 * Q + 3 * E, 6 * Q]);

  const head = fragment(CELL, 'head', 2);
  assert.deepEqual(pitches(head), [60, 64]);
  assert.deepEqual(timing(head), [[0, Q], [Q, E]]);
  assert.equal(head.length, Q + E, 'a head ends where the next onset starts');
  const tail = fragment(CELL, 'tail', 2);
  assert.deepEqual(pitches(tail), [62, 67]);
  assert.deepEqual(timing(tail), [[0, E], [E, 2 * Q]]);
  assert.equal(tail.length, 2 * Q + E);
  assert.equal(tail.place?.tick, Q + E, 'a tail keeps its place in the bar');
  // A chord is one onset.
  const chordCell = extractCell([
    { note: 60, tick: 0, ticks: Q },
    { note: 64, tick: 0, ticks: Q },
    { note: 67, tick: Q, ticks: Q },
  ]);
  assert.deepEqual(pitches(fragment(chordCell, 'head', 1)), [60, 64]);

  const seq = sequence(CELL, 2, -1, C_MAJOR);
  assert.deepEqual(pitches(seq), [60, 64, 62, 67, 59, 62, 60, 65, 57, 60, 59, 64]);
  assert.deepEqual(seq.notes.map((n) => n.at), [0, Q, Q + E, 2 * Q, 4 * Q, 5 * Q, 5 * Q + E, 6 * Q, 8 * Q, 9 * Q, 9 * Q + E, 10 * Q]);
  assert.equal(seq.length, 12 * Q);
  const chromSeq = sequence(CELL, 1, 3);
  assert.deepEqual(pitches(chromSeq), [60, 64, 62, 67, 63, 67, 65, 70]);
}

// ── diatonic inversion stays in the scale ───────────────────────────────────
{
  for (const [tonic, mode] of [['D', 'major'], ['A', 'minor'], ['A', 'harmonic_minor'], ['Eb', 'dorian']] as const) {
    const sc = scaleOf(tonic, mode);
    const ladder: number[] = [];
    for (let m = 48; m < 84; m += 1) if (inScale(m, sc)) ladder.push(m);
    const cell = extractCell([3, 7, 5, 10, 8, 12, 4].map((i, k) => ({ note: ladder[i], tick: k * E, ticks: E })));
    for (const axis of [cell.notes[0].note, cell.notes[3].note]) {
      const inv = invertDiatonic(cell, sc, axis);
      assert.ok(inv.notes.every((n) => inScale(n.note, sc)), `${tonic} ${mode} about ${axis}`);
      assert.deepEqual(invertDiatonic(inv, sc, axis), cell, 'inverting twice about the same axis is the identity');
    }
  }
}

// ── identities ──────────────────────────────────────────────────────────────
{
  assert.deepEqual(retrograde(retrograde(CELL)), CELL);
  assert.deepEqual(diminish(augment(CELL)), CELL);
  assert.deepEqual(diminish(augment(CELL, 3), 3), CELL);
  // A rest at the end is part of the cell and survives both.
  const rested: MotifCell = { ...CELL, length: 5 * Q };
  assert.deepEqual(retrograde(retrograde(rested)), rested);
  assert.equal(retrograde(rested).notes[0].at, Q, 'the rest comes first backwards');
}

// ── liquidation ─────────────────────────────────────────────────────────────
{
  const stages = liquidate(CELL, 4, { scale: C_MAJOR });
  assert.equal(stages.length, 4);
  assert.deepEqual(pitches(stages[0]), [60, 62, 60, 62], 'the leaps become steps');
  assert.deepEqual(timing(stages[0]), timing(CELL), 'with the rhythm kept');
  assert.deepEqual(pitches(stages[1]), [60, 62], 'then the head');
  assert.deepEqual(timing(stages[2]), [[0, Q], [Q, E]]);
  assert.deepEqual(pitches(stages[2]), [60, 60], 'then the head rhythm on one pitch');
  assert.equal(stages[3].notes.length, 1, 'and last a single note');
  assert.equal(stages[3].notes[0].note, 60);
  assert.equal(stages[3].notes[0].ticks, Q + E);
  const toTarget = liquidate(CELL, 2, { scale: C_MAJOR, target: 55 });
  assert.equal(toTarget.length, 2);
  assert.deepEqual(pitches(toTarget[0]), [60, 62], 'two stages: the head first');
  assert.deepEqual(pitches(toTarget[1]), [55], 'then the target');
  assert.deepEqual(pitches(liquidate(CELL, 1)[0]), [60]);
  // Without a scale a leap becomes a whole tone, a step stays a step.
  assert.deepEqual(pitches(liquidate(extractCell([
    { note: 60, tick: 0, ticks: E }, { note: 67, tick: E, ticks: E }, { note: 66, tick: Q, ticks: E },
  ]), 4)[0]), [60, 62, 61]);
}

// ── realization, in ticks and in 7/8's groups ───────────────────────────────
{
  assert.deepEqual(
    realizeCell(CELL, 4 * Q).map((n) => [n.note, n.tick, n.ticks]),
    [[60, 4 * Q, Q], [64, 5 * Q, E], [62, 5 * Q + E, E], [67, 6 * Q, 2 * Q]],
  );
  const M223: MeterSegment[] = [{ bar: 0, meter: { num: 7, den: 8, groups: [2, 2, 3] } }];
  const M322: MeterSegment[] = [{ bar: 0, meter: { num: 7, den: 8, groups: [3, 2, 2] } }];
  const bar78 = 7 * E;
  const quarters = extractCell([0, 1, 2].map((i) => ({ note: 60 + i * 2, tick: i * Q, ticks: Q })));
  // 2+2+3: the third quarter fills the long group.
  assert.deepEqual(
    realizeCell(quarters, 0, { meterMap: M223, align: 'metric' }).map((n) => [n.tick, n.ticks]),
    [[0, Q], [Q, Q], [2 * Q, 3 * E]],
  );
  // 3+2+2 from the second bar: the long group comes first.
  assert.deepEqual(
    realizeCell(quarters, bar78, { meterMap: M322, align: 'metric' }).map((n) => [n.tick, n.ticks]),
    [[bar78, 3 * E], [bar78 + 3 * E, Q], [bar78 + 5 * E, Q]],
  );
  // The eighth after a group start stays half a pulse in.
  assert.deepEqual(
    realizeCell(CELL, 0, { meterMap: M322, align: 'metric' }).map((n) => [n.tick, n.ticks]),
    [[0, 3 * E], [3 * E, E], [4 * E, E], [5 * E, 5 * E]],
  );
  // A cell heard in 7/8 3+2+2 reads its group starts and goes back to 4/4 on the beats.
  const heard = extractCell(
    [{ note: 67, tick: bar78, ticks: 3 * E }, { note: 65, tick: bar78 + 3 * E, ticks: Q }, { note: 64, tick: bar78 + 5 * E, ticks: Q }],
    { meterMap: M322 },
  );
  assert.deepEqual(describeCell(heard).metric.map((m) => [m.bar, m.pulse, m.accent]), [[1, 0, 'bar'], [1, 1, 'pulse'], [1, 2, 'pulse']]);
  assert.deepEqual(realizeCell(heard, 0, { align: 'metric' }).map((n) => [n.tick, n.ticks]), [[0, Q], [Q, Q], [2 * Q, Q]]);
  // In ticks mode the 7/8 cell keeps its own lengths.
  assert.deepEqual(realizeCell(heard, 0).map((n) => [n.tick, n.ticks]), [[0, 3 * E], [3 * E, Q], [5 * E, Q]]);
}

// ── cells from a longer line ────────────────────────────────────────────────
{
  const line = [
    { note: 60, tick: 0, ticks: Q }, { note: 62, tick: Q, ticks: Q }, { note: 64, tick: 2 * Q, ticks: 2 * Q },
    { note: 65, tick: 4 * Q, ticks: Q }, { note: 67, tick: 5 * Q, ticks: Q },
    { note: 69, tick: 7 * Q, ticks: Q }, { note: 71, tick: 7 * Q + E, ticks: E },
  ];
  assert.deepEqual(extractCells(line).map(pitches), [[60, 62, 64], [65, 67], [69, 71]], 'by bar and rest');
  assert.deepEqual(extractCells(line, { split: 'rest' }).map(pitches), [[60, 62, 64, 65, 67], [69, 71]]);
  assert.deepEqual(extractCells(line, { split: 'bar' })[1].place?.tick, 4 * Q);
}

// ── themes ──────────────────────────────────────────────────────────────────
{
  let reg = createThemeRegistry();
  reg = registerTheme(reg, { name: 'first', cells: [CELL], key: { tonic: 'C', mode: 'major' }, home: 'first_group' });
  reg = registerTheme(reg, { name: 'second', cells: [fragment(CELL, 'head', 2), fragment(CELL, 'tail', 2)], key: { tonic: 'G', mode: 'major' }, home: 'second_group' });
  assert.deepEqual(Object.keys(reg.themes), ['first', 'second']);
  assert.deepEqual(pitches(recallTheme(reg, 'first')), [60, 64, 62, 67]);
  // To G: the nearest tonic is a fourth down.
  assert.deepEqual(pitches(recallTheme(reg, 'first', [{ op: 'toKey', tonic: 'G', mode: 'major' }])), [55, 59, 57, 62]);
  // To A minor keeps each degree: C E D G become A C B E.
  assert.deepEqual(pitches(recallTheme(reg, 'first', [{ op: 'toKey', tonic: 'A', mode: 'minor' }])), [57, 60, 59, 64]);
  // After toKey, a diatonic step moves in the new key.
  assert.deepEqual(
    pitches(recallTheme(reg, 'first', [{ op: 'toKey', tonic: 'G', mode: 'major' }, { op: 'transposeDiatonic', steps: 1 }])),
    [57, 60, 59, 64],
  );
  // Joined cells play end to end.
  const second = recallTheme(reg, 'second');
  assert.deepEqual(second.notes.map((n) => n.at), [0, Q, Q + E, Q + 2 * E]);
  assert.deepEqual(pitches(recallTheme(reg, 'second', [], { cell: 1 })), [62, 67]);
  // A chain: retrograde inversion, augmented.
  const chain = applyChain(CELL, [{ op: 'invertDiatonic' }, { op: 'retrograde' }, { op: 'augment' }], C_MAJOR);
  assert.deepEqual(pitches(chain), [53, 59, 57, 60]);
  assert.equal(chain.length, 8 * Q);
  const liq = applyChain(CELL, [{ op: 'liquidate', steps: 4, stage: 3 }], C_MAJOR);
  assert.deepEqual(pitches(liq), [60, 60]);
  assert.throws(() => recallTheme(reg, 'third'), /no theme/);
  assert.throws(() => registerTheme(reg, { name: 'x', cells: [], key: { tonic: 'C', mode: 'major' }, home: 'A' }), /no cells/);
}

console.log('motif tests passed');
