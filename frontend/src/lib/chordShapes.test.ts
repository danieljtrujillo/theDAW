/**
 * node:assert script for the chord-shape generator, the curated table and the
 * chordtrack helpers. Run with: npx tsx src/lib/chordShapes.test.ts
 */
import assert from 'node:assert/strict';

import {
  applyCapo,
  bestShapes,
  chordLabel,
  findShapes,
  fretString,
  makeChordSpec,
  pcName,
  type ChordShape,
  type ChordSpec,
} from './chordShapes.ts';
import { chordAt, chordIndexAt, kindColor, toChordSpec, type ChordTrack } from './chordTrack.ts';
import { curatedEntries, curatedTunings, intervalKey, lookup } from './curatedShapes.ts';

const GUITAR = [40, 45, 50, 55, 59, 64];
const BASS = [28, 33, 38, 43];
const UKULELE = [67, 60, 64, 69];

const KINDS: Record<string, number[]> = {
  major: [0, 4, 7],
  minor: [0, 3, 7],
  'dominant-seventh': [0, 4, 7, 10],
  'minor-seventh': [0, 3, 7, 10],
  'major-seventh': [0, 4, 7, 11],
  'suspended-fourth': [0, 5, 7],
  diminished: [0, 3, 6],
};

const mod12 = (n: number) => ((n % 12) + 12) % 12;

function soundingPcs(shape: ChordShape, tuning: number[]): number[] {
  const out: number[] = [];
  shape.frets.forEach((f, i) => {
    if (f >= 0) out.push(mod12(tuning[i] + f));
  });
  return out;
}

function lowestPc(shape: ChordShape, tuning: number[]): number {
  let best = Infinity;
  shape.frets.forEach((f, i) => {
    if (f >= 0) best = Math.min(best, tuning[i] + f);
  });
  return mod12(best);
}

function isReentrant(tuning: number[]): boolean {
  return tuning.some((m, i) => i > 0 && m <= tuning[i - 1]);
}

/** Shared invariants for any shape (curated or generated) of `chord` on `tuning`. */
function checkShape(shape: ChordShape, chord: ChordSpec, tuning: number[], where: string, opts: { minStrings: number }) {
  const pcs = new Set(chord.pitchClasses.map(mod12));
  assert.equal(shape.frets.length, tuning.length, `${where}: one fret per string`);
  assert.equal(shape.fingers.length, tuning.length, `${where}: one finger slot per string`);
  const sounding = soundingPcs(shape, tuning);
  assert.ok(sounding.length >= opts.minStrings, `${where}: at least ${opts.minStrings} strings sound (${fretString(shape.frets)})`);
  for (const pc of sounding) assert.ok(pcs.has(pc), `${where}: pc ${pc} not in chord (${fretString(shape.frets)})`);
  const present = new Set(sounding);
  assert.ok(present.has(mod12(chord.rootPc)), `${where}: root missing (${fretString(shape.frets)})`);
  for (const third of [3, 4]) {
    const pc = mod12(chord.rootPc + third);
    if (pcs.has(pc)) assert.ok(present.has(pc), `${where}: third missing (${fretString(shape.frets)})`);
  }
  if (!isReentrant(tuning)) {
    const wantBass = chord.bassPc >= 0 ? mod12(chord.bassPc) : mod12(chord.rootPc);
    assert.equal(lowestPc(shape, tuning), wantBass, `${where}: lowest string is not the bass (${fretString(shape.frets)})`);
  }
  const fretted = shape.frets.filter((f) => f > 0);
  if (fretted.length > 0) {
    const stretch = Math.max(...fretted) - Math.min(...fretted);
    assert.ok(stretch <= 3, `${where}: stretch ${stretch} exceeds a 4-fret window (${fretString(shape.frets)})`);
    assert.ok(Math.max(...fretted) <= 12, `${where}: above fret 12 (${fretString(shape.frets)})`);
    if (Math.max(...fretted) > 4) assert.equal(shape.baseFret, Math.min(...fretted), `${where}: baseFret`);
    else assert.equal(shape.baseFret, 1, `${where}: open-position baseFret`);
  } else {
    assert.equal(shape.baseFret, 1, `${where}: all-open baseFret`);
  }
  // Fingers: 0 on open/muted strings, 1..4 on fretted strings.
  shape.frets.forEach((f, i) => {
    if (f <= 0) assert.equal(shape.fingers[i], 0, `${where}: finger on open/mute string ${i}`);
    else assert.ok(shape.fingers[i] >= 1 && shape.fingers[i] <= 4, `${where}: finger out of range on string ${i}`);
  });
  if (shape.barre) {
    assert.ok(shape.barre.from < shape.barre.to, `${where}: barre range`);
    for (let i = shape.barre.from; i <= shape.barre.to; i += 1) {
      assert.ok(shape.frets[i] >= shape.barre.fret, `${where}: string ${i} inside the barre sits below it`);
    }
  }
}

// ---------------------------------------------------------------------------
// 1. Curated open shapes win on guitar-standard
// ---------------------------------------------------------------------------
{
  const cases: [string, ChordSpec, string][] = [
    ['C', makeChordSpec(0, KINDS.major), 'x32010'],
    ['G', makeChordSpec(7, KINDS.major), '320003'],
    ['D', makeChordSpec(2, KINDS.major), 'xx0232'],
    ['Em', makeChordSpec(4, KINDS.minor), '022000'],
    ['Am', makeChordSpec(9, KINDS.minor), 'x02210'],
    ['E7', makeChordSpec(4, KINDS['dominant-seventh']), '020100'],
    ['F', makeChordSpec(5, KINDS.major), '133211'],
    ['Bm', makeChordSpec(11, KINDS.minor), 'x24432'],
  ];
  for (const [name, chord, expected] of cases) {
    const shapes = bestShapes('guitar-standard', GUITAR, chord);
    assert.ok(shapes.length > 0, `${name}: shapes returned`);
    assert.equal(fretString(shapes[0].frets), expected, `${name}: first shape is the curated one`);
    assert.equal(shapes[0].curated, true, `${name}: flagged curated`);
    assert.equal(shapes[0].score, 0, `${name}: curated score 0`);
    // No duplicate frets across curated + generated.
    const keys = shapes.map((s) => s.frets.join(','));
    assert.equal(new Set(keys).size, keys.length, `${name}: deduped by frets`);
    // Generated shapes follow after the curated ones.
    let seenGenerated = false;
    for (const s of shapes) {
      if (!s.curated) seenGenerated = true;
      else assert.equal(seenGenerated, false, `${name}: curated shapes come first`);
    }
  }
  // Pitch-class order / spelling does not matter for the lookup.
  const cScrambled: ChordSpec = { rootPc: 12, pitchClasses: [7, 16, 0], bassPc: -1 };
  assert.equal(intervalKey(cScrambled), '0:0,4,7');
  assert.equal(fretString(lookup('guitar-standard', cScrambled)[0].frets), 'x32010');
  // Slash chords never take a curated root-position shape.
  assert.deepEqual(lookup('guitar-standard', { rootPc: 0, pitchClasses: [0, 4, 7], bassPc: 4 }), []);
  // Unknown tuning -> nothing curated.
  assert.deepEqual(lookup('bass-standard', makeChordSpec(4, KINDS.major)), []);
  // lookup hands out copies.
  const a = lookup('guitar-standard', makeChordSpec(0, KINDS.major))[0];
  a.frets[0] = 99;
  assert.equal(lookup('guitar-standard', makeChordSpec(0, KINDS.major))[0].frets[0], -1);
  console.log('curated guitar shapes ok');
}

// ---------------------------------------------------------------------------
// 2. Every curated shape actually spells its chord
// ---------------------------------------------------------------------------
{
  const tunings: Record<string, number[]> = { 'guitar-standard': GUITAR, 'ukulele-standard': UKULELE };
  assert.deepEqual(curatedTunings().sort(), Object.keys(tunings).sort());
  let count = 0;
  for (const [tuningId, tuning] of Object.entries(tunings)) {
    const entries = curatedEntries(tuningId);
    assert.ok(entries.length > 0, `${tuningId}: curated entries`);
    for (const entry of entries) {
      const chord: ChordSpec = {
        rootPc: entry.rootPc,
        pitchClasses: entry.intervals.map((iv) => mod12(entry.rootPc + iv)),
        bassPc: -1,
      };
      const fifth = mod12(entry.rootPc + 7);
      for (const shape of entry.shapes) {
        count += 1;
        const where = `${tuningId} ${entry.key} ${fretString(shape.frets)}`;
        checkShape(shape, chord, tuning, where, { minStrings: tuning.length >= 5 ? 3 : 2 });
        assert.equal(shape.curated, true, where);
        // Every chord tone except possibly the fifth is present.
        const present = new Set(soundingPcs(shape, tuning));
        for (const pc of chord.pitchClasses) {
          if (pc === fifth && chord.pitchClasses.length >= 4) continue;
          assert.ok(present.has(pc), `${where}: chord tone ${pc} missing`);
        }
      }
    }
  }
  // 24 hand-written guitar + 4 barre templates x 10 positions (r 1..10) minus
  // the F (133211) and Bm (x24432) duplicates, plus 12 ukulele.
  assert.equal(count, 24 + (4 * 10 - 2) + 12, `curated table populated (${count} shapes)`);
  // E-shape / A-shape barre templates exist for a root with no open shape (e.g. Ab major, C# minor).
  const ab = lookup('guitar-standard', makeChordSpec(8, KINDS.major));
  assert.equal(ab.length, 1, 'Ab major: E-shape only (its A-shape would pass fret 12)');
  assert.equal(fretString(ab[0].frets), '466544', 'Ab: E-shape at fret 4 first (lower)');
  assert.deepEqual(ab[0].barre, { fret: 4, from: 0, to: 5 });
  assert.equal(ab[0].baseFret, 4);
  const csm = lookup('guitar-standard', makeChordSpec(1, KINDS.minor));
  assert.equal(fretString(csm[0].frets), 'x46654', 'C#m: A-shape at fret 4 before E-shape at fret 9');
  console.log(`curated table spells its chords (${count} shapes)`);
}

// ---------------------------------------------------------------------------
// 3. Generated shapes: 7 kinds x 12 roots on guitar / bass / ukulele
// ---------------------------------------------------------------------------
{
  const instruments: [string, number[], number][] = [
    ['guitar', GUITAR, 3],
    ['bass', BASS, 2],
    ['ukulele', UKULELE, 2],
  ];
  let total = 0;
  for (const [name, tuning, minStrings] of instruments) {
    for (const [kind, intervals] of Object.entries(KINDS)) {
      for (let root = 0; root < 12; root += 1) {
        const chord = makeChordSpec(root, intervals);
        const shapes = findShapes(chord, tuning);
        const where = `${name} ${pcName(root, false)} ${kind}`;
        assert.ok(shapes.length > 0, `${where}: at least one generated shape`);
        assert.ok(shapes.length <= 3, `${where}: default top 3`);
        for (let i = 1; i < shapes.length; i += 1) {
          assert.ok(shapes[i - 1].score <= shapes[i].score, `${where}: sorted by score`);
        }
        for (const shape of shapes) {
          total += 1;
          assert.equal(shape.curated, false, `${where}: generated flag`);
          checkShape(shape, chord, tuning, where, { minStrings });
        }
      }
    }
  }
  // Memoised results are copies, not the cached array.
  const first = findShapes(makeChordSpec(0, KINDS.major), GUITAR);
  first.length = 0;
  assert.ok(findShapes(makeChordSpec(0, KINDS.major), GUITAR).length > 0, 'memo survives caller mutation');
  // top option honoured.
  assert.ok(findShapes(makeChordSpec(0, KINDS.major), GUITAR, { top: 1 }).length === 1);
  // N.C. -> nothing.
  assert.deepEqual(findShapes({ rootPc: 0, pitchClasses: [], bassPc: -1 }, GUITAR), []);
  console.log(`generated shapes hold their invariants (${total} shapes)`);
}

// ---------------------------------------------------------------------------
// 4. Bass: E major sits on the open E string
// ---------------------------------------------------------------------------
{
  const shapes = bestShapes('bass-standard', BASS, makeChordSpec(4, KINDS.major));
  assert.ok(shapes.length > 0, 'bass E shapes');
  const best = shapes[0];
  assert.equal(best.frets[0], 0, `bass E: lowest string open E (${fretString(best.frets)})`);
  assert.ok(best.frets.filter((f) => f >= 0).length >= 2, 'bass E: >= 2 strings');
  assert.equal(best.curated, false, 'bass has no curated table');
  // Slash chord: bass note wins over the root on a non-reentrant tuning.
  const slash = findShapes({ rootPc: 0, pitchClasses: [0, 4, 7], bassPc: 4 }, GUITAR);
  assert.ok(slash.length > 0, 'C/E shapes exist');
  for (const s of slash) assert.equal(lowestPc(s, GUITAR), 4, `C/E lowest is E (${fretString(s.frets)})`);
  console.log('bass + slash bass ok');
}

// ---------------------------------------------------------------------------
// 5. Ukulele curated
// ---------------------------------------------------------------------------
{
  const c = bestShapes('ukulele-standard', UKULELE, makeChordSpec(0, KINDS.major));
  assert.equal(fretString(c[0].frets), '0003');
  assert.equal(c[0].curated, true);
  const g = bestShapes('ukulele-standard', UKULELE, makeChordSpec(7, KINDS.major));
  assert.equal(fretString(g[0].frets), '0232');
  const bb = bestShapes('ukulele-standard', UKULELE, makeChordSpec(10, KINDS.major));
  assert.equal(fretString(bb[0].frets), '3211');
  assert.deepEqual(bb[0].barre, { fret: 1, from: 2, to: 3 });
  console.log('ukulele curated ok');
}

// ---------------------------------------------------------------------------
// 6. Capo
// ---------------------------------------------------------------------------
{
  // C with a capo at 3 is played as an A shape behind the capo.
  const shapes = bestShapes('guitar-standard', GUITAR, makeChordSpec(0, KINDS.major), 3);
  assert.equal(fretString(shapes[0].frets), 'x02220', 'C @ capo 3 -> A shape');
  // The shape sounds C major once the capo (3 semitones) is added back.
  const sounding = new Set(shapes[0].frets.map((f, i) => (f < 0 ? -1 : mod12(GUITAR[i] + f + 3))).filter((x) => x >= 0));
  assert.deepEqual([...sounding].sort((x, y) => x - y), [0, 4, 7]);
  // G with capo 2 -> F shape? No: G - 2 = F, curated F barre is 133211.
  const g2 = bestShapes('guitar-standard', GUITAR, makeChordSpec(7, KINDS.major), 2);
  assert.equal(fretString(g2[0].frets), '133211');
  // capo 0 is the identity.
  assert.equal(
    fretString(bestShapes('guitar-standard', GUITAR, makeChordSpec(0, KINDS.major), 0)[0].frets),
    'x32010',
  );
  // applyCapo re-expresses an absolute shape relative to the capo.
  const f = lookup('guitar-standard', makeChordSpec(5, KINDS.major))[0]; // 133211 barre fret 1
  const shifted = applyCapo({ ...f, frets: f.frets.map((x) => (x > 0 ? x + 2 : x)), barre: { fret: 3, from: 0, to: 5 } }, 2);
  assert.ok(shifted, 'applyCapo returns a shape');
  assert.equal(fretString(shifted!.frets), '133211');
  assert.deepEqual(shifted!.barre, { fret: 1, from: 0, to: 5 });
  assert.equal(applyCapo(f, 2), null, 'a fret below the capo is unplayable');
  const openC = lookup('guitar-standard', makeChordSpec(0, KINDS.major))[0];
  assert.equal(applyCapo(openC, 0), openC, 'capo 0 is identity');
  console.log('capo ok');
}

// ---------------------------------------------------------------------------
// 7. Names and labels
// ---------------------------------------------------------------------------
{
  assert.equal(pcName(10, false), 'A#');
  assert.equal(pcName(10, true), 'Bb');
  assert.equal(pcName(-2, false), 'A#');
  assert.equal(pcName(13, true), 'Db');
  const c = lookup('guitar-standard', makeChordSpec(0, KINDS.major))[0];
  assert.equal(chordLabel('C major', c), 'C major, x32010');
  const f = lookup('guitar-standard', makeChordSpec(5, KINDS.major))[0];
  assert.equal(chordLabel('F major', f), 'F major, 133211 (barre fret 1)');
  const ab = lookup('guitar-standard', makeChordSpec(8, KINDS.major))[0];
  assert.equal(chordLabel('Ab', ab), 'Ab, 466544 (barre fret 4)');
  assert.equal(fretString([-1, 8, 10, 10, 9, 8]), 'x-8-10-10-9-8');
  console.log('labels ok');
}

// ---------------------------------------------------------------------------
// 8. chordTrack helpers
// ---------------------------------------------------------------------------
{
  const span = (id: number, startSec: number, endSec: number, symbol: string, rootPc: number, kind: string, pcs: number[]) => ({
    id,
    startSec,
    endSec,
    startBeat: startSec * 2,
    endBeat: endSec * 2,
    measure: 1 + Math.floor(startSec / 2),
    symbol,
    root: rootPc >= 0 ? pcName(rootPc, false) : '',
    rootPc,
    kind,
    bassPc: -1,
    pitchClasses: pcs,
    confidence: 1,
  });
  const track: ChordTrack = {
    schema: 'gantasmo.chordtrack',
    schemaVersion: 1,
    generator: 'test',
    generatedAtUtc: '2026-01-01T00:00:00Z',
    source: { entryId: 'e', method: 'harmony', sourceArtifactId: 'x' },
    timing: { bpm: 120, beats: [0, 0.5, 1, 1.5], downbeats: [0, 2], beatsPerBar: 4, durationSec: 8 },
    key: { tonic: 'C', mode: 'major', confidence: 1 },
    chords: [
      span(0, 0, 2, 'C', 0, 'major', [0, 4, 7]),
      span(1, 2, 4, 'G7', 7, 'dominant-seventh', [7, 11, 2, 5]),
      span(2, 4, 6, 'Am', 9, 'minor', [9, 0, 4]),
      span(3, 6, 8, 'N.C.', -1, 'none', []),
    ],
    stats: { chordCount: 4, distinctSymbols: 4, meanConfidence: 1 },
  };
  assert.equal(chordIndexAt(track, -0.1), -1);
  assert.equal(chordIndexAt(track, 0), 0);
  assert.equal(chordIndexAt(track, 1.999), 0);
  assert.equal(chordIndexAt(track, 2), 1);
  assert.equal(chordIndexAt(track, 5.5), 2);
  assert.equal(chordIndexAt(track, 7), 3);
  assert.equal(chordIndexAt(track, 99), 3);
  assert.equal(chordIndexAt({ chords: [] }, 1), -1);
  assert.equal(chordIndexAt(track, Number.NaN), -1);
  assert.equal(chordAt(track, 3)?.symbol, 'G7');
  assert.equal(chordAt(track, -1), null);
  assert.equal(chordAt(track, 99)?.symbol, 'N.C.', 'last span stays current past its end');

  assert.equal(kindColor('major'), '#34d399');
  assert.equal(kindColor('minor'), '#38bdf8');
  assert.equal(kindColor('dominant-seventh'), '#fbbf24');
  assert.equal(kindColor('dominant'), '#fbbf24');
  assert.equal(kindColor('minor-seventh'), '#fbbf24');
  assert.equal(kindColor('major-seventh'), '#fbbf24');
  assert.equal(kindColor('diminished'), '#fb7185');
  assert.equal(kindColor('diminished-seventh'), '#fb7185');
  assert.equal(kindColor('half-diminished'), '#fb7185');
  assert.equal(kindColor('augmented'), '#fb7185');
  assert.equal(kindColor('power'), '#d4d4d8');
  assert.equal(kindColor('suspended-fourth'), '#d4d4d8');
  assert.equal(kindColor('none'), '#a1a1aa');
  assert.equal(kindColor(''), '#a1a1aa');

  assert.deepEqual(toChordSpec(track.chords[1]), { rootPc: 7, pitchClasses: [7, 11, 2, 5], bassPc: -1 });
  assert.deepEqual(toChordSpec(track.chords[3]), { rootPc: 0, pitchClasses: [], bassPc: -1 });
  assert.deepEqual(toChordSpec({ rootPc: 0, pitchClasses: [0, 4, 7], bassPc: 4 }), { rootPc: 0, pitchClasses: [0, 4, 7], bassPc: 4 });
  // A chordtrack span feeds the generator directly.
  const g7 = bestShapes('guitar-standard', GUITAR, toChordSpec(track.chords[1]));
  assert.equal(fretString(g7[0].frets), '320001');
  assert.deepEqual(bestShapes('guitar-standard', GUITAR, toChordSpec(track.chords[3])), [], 'N.C. has no shapes');
  console.log('chordTrack helpers ok');
}

console.log('chordShapes / curatedShapes / chordTrack tests passed');
