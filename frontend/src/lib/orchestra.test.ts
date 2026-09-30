// Run with: npx tsx src/lib/orchestra.test.ts
//
// The frontend side of the orchestral registry. tests/test_orchestra_registry.py
// proves orchestraData.ts is exactly what the backend generates; this suite
// proves the lookups the pickers and the SCORE maker use read it correctly.
import assert from 'node:assert/strict';
import {
  describeInstrument,
  guessInstrument,
  inRange,
  instrumentForProgram,
  normalizeName,
  ORCHESTRA,
  ORCHESTRA_FAMILIES,
  orchestraByFamily,
  orchestraInstrument,
  pitchLabel,
  soundingPitch,
  transpositionLabel,
  writtenPitch,
} from './orchestra.ts';
import { GM_NAMES } from './gmInstruments.ts';

// ── score order ──────────────────────────────────────────────────────────────
assert.ok(ORCHESTRA.length >= 50, 'a full orchestra plus band and voices');
assert.deepEqual(ORCHESTRA.map((i) => i.order), ORCHESTRA.map((_, n) => n), 'records sit in score order');
const runs = ORCHESTRA.map((i) => i.family).filter((f, n, all) => n === 0 || all[n - 1] !== f);
assert.deepEqual(runs, ORCHESTRA_FAMILIES.map((f) => f.id), 'each family is one run, in family order');
assert.equal(new Set(ORCHESTRA.map((i) => i.id)).size, ORCHESTRA.length, 'ids are unique');
const groups = orchestraByFamily();
assert.equal(groups[0].family.label, 'Woodwinds');
assert.equal(groups.at(-1)!.family.label, 'Strings');
assert.deepEqual(
  groups.at(-1)!.instruments.map((i) => i.id),
  ['violin', 'viola', 'cello', 'contrabass'],
  'strings in score order',
);
assert.ok(
  orchestraByFamily((i) => !i.percussion).every((g) => g.instruments.every((i) => !i.percussion)),
  'the filter keeps only what it is asked for',
);

// ── programs name the GM sound they play ─────────────────────────────────────
const gm = (id: string) => GM_NAMES[orchestraInstrument(id)!.program];
assert.equal(gm('violin'), 'Violin');
assert.equal(gm('cello'), 'Cello');
assert.equal(gm('contrabass'), 'Contrabass');
assert.equal(gm('flute'), 'Flute');
assert.equal(gm('clarinet-bb'), 'Clarinet');
assert.equal(gm('horn'), 'French Horn');
assert.equal(gm('timpani'), 'Timpani');
assert.equal(gm('harp'), 'Orchestral Harp');
for (const inst of ORCHESTRA) {
  if (!inst.percussion) assert.equal(inst.bank, 0, `${inst.id} plays from the GM melodic bank`);
  else assert.equal(inst.bank, 128, `${inst.id} plays from a kit`);
}
assert.equal(instrumentForProgram(73)?.id, 'flute');
assert.equal(instrumentForProgram(71)?.id, 'clarinet-bb', 'the first clarinet in score order');
assert.equal(instrumentForProgram(0, 0, true)?.id, 'drum-kit');
assert.equal(instrumentForProgram(120), undefined);

// ── transposition and range, at sounding pitch ───────────────────────────────
const clarinet = orchestraInstrument('clarinet-bb')!;
assert.equal(clarinet.semitones, -2);
assert.equal(writtenPitch(clarinet, 62), 64, 'sounding D4 is written E4');
assert.equal(soundingPitch(clarinet, 64), 62);
assert.equal(transpositionLabel(clarinet), 'sounds a major second lower');
assert.equal(transpositionLabel(orchestraInstrument('horn')!), 'sounds a fifth lower');
assert.equal(transpositionLabel(orchestraInstrument('piccolo')!), 'sounds an octave higher');
assert.equal(transpositionLabel(orchestraInstrument('glockenspiel')!), 'sounds two octaves higher');
assert.equal(transpositionLabel(orchestraInstrument('violin')!), 'sounds as written');
const violin = orchestraInstrument('violin')!;
assert.ok(inRange(violin, 55) && !inRange(violin, 54), 'the violin stops at G3');
assert.equal(pitchLabel(60), 'C4');
assert.equal(pitchLabel(70), 'B♭4');
assert.equal(
  describeInstrument(clarinet),
  'Clarinet in B♭ · treble clef · sounds a major second lower · D3 to G6 · GM 72 Clarinet',
);
assert.match(describeInstrument(orchestraInstrument('piano')!), /grand staff/);
assert.match(describeInstrument(orchestraInstrument('snare-drum')!), /Orchestral kit, key 38$/);
assert.deepEqual(orchestraInstrument('viola')!.clefs, ['alto', 'treble']);
assert.deepEqual(orchestraInstrument('cello')!.clefs, ['bass', 'tenor', 'treble']);

// ── part names find their instrument ─────────────────────────────────────────
// The same cases as test_guess_from_part_names in tests/test_orchestra_registry.py:
// the backend and this module run one match over the same generated keys.
const CASES: [string, string][] = [
  ['Violin I', 'violin'],
  ['Violin II', 'violin'],
  ['Vln. 2', 'violin'],
  ['Viola', 'viola'],
  ['Violoncello', 'cello'],
  ['Double Bass', 'contrabass'],
  ['Bass Clarinet 1', 'bass-clarinet'],
  ['Clarinet in A', 'clarinet-a'],
  ['Clarinet in Bb 2', 'clarinet-bb'],
  ['Horn in F 3', 'horn'],
  ['Trumpet in C', 'trumpet-c'],
  ['Tenor Sax', 'tenor-sax'],
  ['Timp.', 'timpani'],
  ['Große Trommel', 'bass-drum'],
  ['Piano', 'piano'],
  ['drums', 'drum-kit'],
  ['vocals', 'voice'],
  ['Bass', 'bass-voice'],
];
for (const [text, want] of CASES) assert.equal(guessInstrument(text)?.id, want, text);
assert.equal(guessInstrument('Theremin'), undefined);
assert.equal(guessInstrument(''), undefined);
assert.equal(normalizeName('  Große   Trommel. '), 'gro e trommel');

console.log('orchestra: all tests passed');
