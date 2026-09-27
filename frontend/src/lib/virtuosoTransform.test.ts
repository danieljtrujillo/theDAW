// Run with: node node_modules/tsx/dist/cli.mjs src/lib/virtuosoTransform.test.ts
//
// virtuosoTransform imports arpEngine, and arpEngine's audio imports reach a
// Vite `?url` asset import that Node cannot resolve. A resolve hook answers
// those with an empty string before the modules load.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { register } from 'node:module';
import type { PianoNote } from '../state/pianoRollStore.ts';
import type { Meter } from './colony.ts';
import type { ChordSpan, GrooveTemplate, SectionSpec, Voicing } from './virtuosoTransform.ts';

const assetStub = `export async function resolve(s, c, next) { return s.endsWith('?url') ? { url: 'data:text/javascript,export default ""', shortCircuit: true } : next(s, c); }`;
register(`data:text/javascript,${encodeURIComponent(assetStub)}`);

const {
  accAlberti,
  accArpeggio,
  accentGroups,
  accOctaves,
  accStride,
  accSustain,
  buildSong,
  harmonize,
  harmonyDescription,
  HARMONY_BORROW_FROM,
  humanize,
  polyrhythm,
  ragtimeStride,
  renderSection,
  renderVirtuoso,
  runsAndFlourishes,
  syncopate,
  ROLES,
  STYLE_NAMES,
  ZERO_AMOUNTS,
} = await import('./virtuosoTransform.ts');
const { ArpPlayerEngine, MusicalScale, ragOffsetSteps } = await import('./arpEngine.ts');

// --- 4/4 outputs captured before the meter map existed ---------------------- //

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const C_MAJOR = [0, 2, 4, 5, 7, 9, 11];

/** Three bars of 16ths, about half of them struck, some on 32nd offsets, some doubled a third below. */
function phrase(seed: number): PianoNote[] {
  const r = mulberry32(seed);
  const out: PianoNote[] = [];
  for (let s = 0; s < 48; s += 1) {
    if (r() > 0.5) continue;
    const note = (5 + Math.floor(r() * 2)) * 12 + C_MAJOR[Math.floor(r() * 7)];
    const step = r() < 0.15 ? s + 0.5 : s;
    out.push({ id: `p${out.length}`, note, step, length: 1 + Math.floor(r() * 4), velocity: 60 + Math.floor(r() * 50) });
    if (r() < 0.2) out.push({ id: `p${out.length}`, note: note - 4, step, length: 2, velocity: 70 });
  }
  return out;
}

const tuples = (notes: readonly { note: number; step: number; length: number; velocity: number }[]): number[][] =>
  notes.map((n) => [n.note, n.step, n.length, n.velocity]);
const digest = (notes: readonly { note: number; step: number; length: number; velocity: number }[]): string =>
  `${notes.length}:${createHash('sha256').update(JSON.stringify(tuples(notes))).digest('hex').slice(0, 24)}`;

const OPTS = { key: 'C', mode: 'major' };
const GROOVE: GrooveTemplate = {
  name: 'fixture',
  timing: Array.from({ length: 16 }, (_, i) => (((i * 7) % 5) - 2) / 10),
  accent: Array.from({ length: 16 }, (_, i) => ((i * 5) % 16) / 15),
};
const VOICING: Voicing = { bass: 36, voices: [48, 52, 55] };
const LADDER = Array.from({ length: 64 }, (_, i) => 33 + i).filter((m) => C_MAJOR.includes(m % 12));
const TRIADS = [[0, 4, 7], [9, 0, 4], [5, 9, 0], [7, 11, 2]];
const SPANS: ChordSpan[] = TRIADS.map((triad, b) => ({ triad, start: 16 + b * 16, len: 16 }));
const SOME = { ...ZERO_AMOUNTS, harmony: 0.3, ragtime: 0.3, runs: 0.3, rhythm: 0.3, humanize: 0.3 };

function captureToday(): Record<string, string> {
  const src = phrase(20260913);
  const out: Record<string, string> = { input: digest(src) };
  for (const a of [0.35, 1]) {
    out[`polyrhythm ${a}`] = digest(polyrhythm(src, a, OPTS, 3));
    out[`humanize ${a}`] = digest(humanize(src, a, 5));
    out[`humanize groove ${a}`] = digest(humanize(src, a, 5, GROOVE));
    out[`ragtimeStride ${a}`] = digest(ragtimeStride(src, a, OPTS, 2));
    out[`runs ${a}`] = digest(runsAndFlourishes(src, a, OPTS, 4));
    out[`runs chromatic ${a}`] = digest(runsAndFlourishes(src, a, { ...OPTS, chromatic: true }, 4));
    out[`harmonize ${a}`] = digest(harmonize(src, a, OPTS, 6));
  }
  out.renderVirtuoso = digest(
    renderVirtuoso(src, { ...ZERO_AMOUNTS, harmony: 0.4, ragtime: 0.6, runs: 0.7, rhythm: 0.5, humanize: 0.45 }, OPTS, 9, GROOVE),
  );
  const acc = { accSustain, accArpeggio, accAlberti, accStride, accOctaves };
  for (const [name, fn] of Object.entries(acc)) out[name] = digest(fn(VOICING, 32, 80));
  for (const role of ROLES) {
    for (const chorusTexture of ['stride', 'octaves'] as const) {
      const notes = renderSection(role, SPANS, { voicing: null, cursor: 74 }, { ladder: LADDER, chorusTexture, seed: 2 });
      out[`renderSection ${role} ${chorusTexture}`] = digest(notes);
    }
  }
  for (const style of STYLE_NAMES) {
    out[`buildSong ${style}`] = digest(buildSong(src, { key: 'D', mode: 'dorian', style, amounts: SOME, bpm: 132, targetSec: 40 }).notes);
    const sections = ROLES.map((role, i) => ({ role, bars: 1 + (i % 3) }));
    out[`buildSong ${style} sections`] = digest(
      buildSong(src, { key: 'C', mode: 'minor', style, amounts: ZERO_AMOUNTS, bpm: 96, sections, groove: GROOVE }).notes,
    );
  }
  out['buildSong default'] = digest(buildSong(src, { key: 'C', mode: 'minor', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 120 }).notes);
  const arp = new ArpPlayerEngine();
  out['arp renderProgression'] = digest(arp.renderProgression().map((n) => ({ ...n, note: n.midi })));
  arp.setConfig({ steps: 5, patternType: 'looped', patternId: 7, arpRepeat: 3, chords: [0, 3, 4, 1, 5] });
  out['arp renderProgression looped'] = digest(arp.renderProgression().map((n) => ({ ...n, note: n.midi })));
  return out;
}

// Note count and a hash of [note, step, length, velocity] per note, captured
// from the transforms before they took a meter map. The buildSong digests were
// captured again once chord degrees counted from the key's tonic, a minor mode's
// cadential V took the leading tone, and a chord tone leaving its register moved
// by an octave; every other digest stayed the same. The five 'buildSong <style>'
// digests were captured once more when harmonize's counter notes took their
// melody note's own length: only the LENGTHS of counter notes under sub-16th
// melody notes changed (1 step became 0.667, 0.5 or 0.333, 0.5 became 0.25, and
// a humanized 1.5 became 1); every note's pitch, step and velocity is unchanged.
// renderVirtuoso and every buildSong digest were captured again when humanize's
// length change took half a note's own length for a note under a 16th: only
// lengths changed (a 0.5-step note humanize lengthened became 0.75 in place of
// 1, a shortened 0.667 became 0.334 in place of the 0.25 floor), compared note
// by note against the previous build's output.
// 'harmonize 1' was captured again when a lowered third stopped clashing with
// the melody: compared note by note with the previous build, two counter notes
// changed and nothing else. At step 14 a B (71) under a sounding C (72) is the
// diatonic C again, and at step 15 an E (64) under a sounding F (65) is the F.
const FIXTURES: Record<string, string> = {
  input: '25:b1ec0ffc70a86b37af9cb6e7',
  'polyrhythm 0.35': '25:e611c06845901cd3be920cfc',
  'humanize 0.35': '25:54bd3cdcb11e7fca9d17377b',
  'humanize groove 0.35': '25:d519f532176b6ee42837aa24',
  'ragtimeStride 0.35': '35:159a4fe588d18a871839ee7b',
  'runs 0.35': '41:8c588298096919b43e2691ee',
  'runs chromatic 0.35': '37:f5611cfe00c22c8615cb057e',
  'harmonize 0.35': '32:e6f55e8692ec5fc5483196e3',
  'polyrhythm 1': '25:7a27bd58b95d65b2470e772d',
  'humanize 1': '25:a9018508535e978edc61283b',
  'humanize groove 1': '25:e2ddb1bfd93be2bc067375bd',
  'ragtimeStride 1': '39:e783ab510ddcab64e12d8182',
  'runs 1': '95:18aeac70e431b83a881eb2e7',
  'runs chromatic 1': '87:d136961088e33c44e5a1b546',
  'harmonize 1': '44:8f64f15a557341d9eb14dbc1',
  renderVirtuoso: '98:1bb1a34f8e3481b302ed5a40',
  accSustain: '4:8266445a9a3b6b8614559cf0',
  accArpeggio: '8:b22ac046619609734aecdacd',
  accAlberti: '8:cc406571a99a243117c57f25',
  accStride: '8:096cc0e79f96901e64003143',
  accOctaves: '8:19cbaa85281767c157a2d689',
  'renderSection intro stride': '68:be051a38427367599484e8e8',
  'renderSection intro octaves': '68:be051a38427367599484e8e8',
  'renderSection theme stride': '68:f9ea578b812d30b3138aaa9e',
  'renderSection theme octaves': '68:f9ea578b812d30b3138aaa9e',
  'renderSection build stride': '97:9a89a0c350b5e37bafdc0ffe',
  'renderSection build octaves': '97:9a89a0c350b5e37bafdc0ffe',
  'renderSection chorus stride': '124:78c9bf800728eab52f7f491e',
  'renderSection chorus octaves': '112:588703a4e49aa23f7fae8f26',
  'renderSection interlude stride': '52:0e5c4ea0709106ba58aa6b7d',
  'renderSection interlude octaves': '52:0e5c4ea0709106ba58aa6b7d',
  'renderSection solo stride': '204:adff54e4ae40fe5f33544a9f',
  'renderSection solo octaves': '204:adff54e4ae40fe5f33544a9f',
  'renderSection climax stride': '260:f3e22b0a65b24d6f7537acd9',
  'renderSection climax octaves': '260:f3e22b0a65b24d6f7537acd9',
  'renderSection outro stride': '48:748d418055dda730911b43ac',
  'renderSection outro octaves': '48:748d418055dda730911b43ac',
  'buildSong romantic': '528:f2aca0d9de2d06a3cdf40e8b',
  'buildSong romantic sections': '436:a9272268720f395b38e58769',
  'buildSong baroque': '670:7cbb03d702d6d64d43735aa7',
  'buildSong baroque sections': '436:252c517b6e5b1ade7f8c43da',
  'buildSong mussorgsky': '770:277e2e66eec33e9555b7dff9',
  'buildSong mussorgsky sections': '436:f9c999cd10a0078c7ebd0d26',
  'buildSong flamenco': '900:9c66866d270f9aa27f26a979',
  'buildSong flamenco sections': '436:1bf1fe7257deb14c7110e61c',
  'buildSong ragtime': '593:966d15a9aa14db640e232e7b',
  'buildSong ragtime sections': '439:903b44200d9a49f9c2c78817',
  'buildSong default': '1265:b754a6aabf3190e54d41d7b3',
  'arp renderProgression': '104:969c285a5c4fa70b17afef59',
  'arp renderProgression looped': '125:a71e91c7fafa6d3c59992cca',
};

{
  const now = captureToday();
  assert.deepEqual(Object.keys(now).sort(), Object.keys(FIXTURES).sort());
  for (const [name, want] of Object.entries(FIXTURES)) assert.equal(now[name], want, `4/4 output changed: ${name}`);
}

// --- meter maps ---------------------------------------------------------------- //

const M44: Meter = { num: 4, den: 4, groups: [] };
const M78: Meter = { num: 7, den: 8, groups: [3, 2, 2] };
const M516: Meter = { num: 5, den: 16, groups: [] };
const IN_44 = { ...OPTS, meterMap: [{ bar: 0, meter: M44 }] };
const IN_78 = { ...OPTS, meterMap: [{ bar: 0, meter: M78 }] };
const IN_516 = { ...OPTS, meterMap: [{ bar: 0, meter: M516 }] };

/** One 16th on every step, each with its own pitch so an output note maps back to its input. Pitch is 30 + step, so stay under 98 steps. */
const everyStep = (steps: number, velocity = 80): PianoNote[] =>
  Array.from({ length: steps }, (_, s) => ({ id: `s${s}`, note: 30 + s, step: s, length: 1, velocity }));
const byPitch = (notes: PianoNote[]): Map<number, PianoNote> => new Map(notes.map((n) => [n.note, n]));

// An explicit 4/4 map gives the captured outputs.
{
  const src = phrase(20260913);
  assert.equal(digest(polyrhythm(src, 1, IN_44, 3)), FIXTURES['polyrhythm 1']);
  assert.equal(digest(humanize(src, 1, 5, undefined, IN_44)), FIXTURES['humanize 1']);
  assert.equal(digest(humanize(src, 1, 5, GROOVE, IN_44)), FIXTURES['humanize groove 1']);
  assert.equal(digest(ragtimeStride(src, 1, IN_44, 2)), FIXTURES['ragtimeStride 1']);
  assert.equal(digest(runsAndFlourishes(src, 1, IN_44, 4)), FIXTURES['runs 1']);
  const song = buildSong(src, { key: 'D', mode: 'dorian', style: 'ragtime', amounts: SOME, bpm: 132, targetSec: 40, meterMap: IN_44.meterMap });
  assert.equal(digest(song.notes), FIXTURES['buildSong ragtime']);
  assert.deepEqual(song.meterMap, IN_44.meterMap);
}

// polyrhythm: 7/8 3+2+2 and 5/16 accent their group and bar starts, and the
// push lands only on odd 16ths counted from the bar start.
{
  const cases: Array<[typeof IN_78, number, number[]]> = [[IN_78, 14, [0, 6, 10]], [IN_516, 5, [0]]];
  for (const [opts, len, accented] of cases) {
    const src = everyStep(Math.min(len * 8, 90));
    const out = byPitch(polyrhythm(src, 1, opts, 3));
    let evenFromZero = 0;
    for (const n of src) {
      const got = out.get(n.note)!;
      const at = n.step % len;
      assert.equal(got.velocity, accented.includes(at) ? 114 : 70, `polyrhythm velocity at step ${n.step} in ${len}-step bars`);
      if (got.step === n.step) continue;
      assert.equal(got.step, n.step + 1);
      assert.equal(at % 2, 1, `polyrhythm pushed step ${n.step}, an even 16th of its bar`);
      if (n.step % 2 === 0) evenFromZero += 1;
    }
    if (len === 5) assert.ok(evenFromZero > 0, 'under 5/16 the push reaches 16ths that are even counted from step 0');
  }
}

// humanize: the bar start +12, the pulse +6 (group starts in 7/8, none in
// 5/16), and the off-16th lay-back counted from the bar start. The random parts
// follow the note index, so the difference from the unmetered run is exactly
// the metrical part.
{
  const cases: Array<[typeof IN_78, number, number[]]> = [[IN_78, 14, [6, 10]], [IN_516, 5, []]];
  for (const [opts, len, pulse] of cases) {
    const src = everyStep(Math.min(len * 8, 90));
    const plain = humanize(src, 1, 5);
    const metered = humanize(src, 1, 5, undefined, opts);
    src.forEach((n, i) => {
      const at = n.step % len;
      const accent = at === 0 ? 12 : pulse.includes(at) ? 6 : 0;
      const accent44 = n.step % 16 === 0 ? 12 : n.step % 4 === 0 ? 6 : 0;
      assert.equal(metered[i].velocity - plain[i].velocity, accent - accent44, `humanize accent at step ${n.step} in ${len}-step bars`);
      const laid = (at % 2 === 1 ? 1 : -1) - (n.step % 2 === 1 ? 1 : -1);
      const drift = metered[i].step - plain[i].step;
      assert.ok(Math.abs(drift - laid * 0.4 * 0.14) <= 0.0011, `humanize lay-back at step ${n.step} in ${len}-step bars: ${drift}`);
    });
  }
}

// ragtimeStride: stabs accented on every group start, the oom-pah on the bar's
// pulse, in every bar.
{
  const cases: Array<[typeof IN_78, number, number[][], number[][]]> = [
    [IN_78, 14, [[0, 116], [3, 92], [6, 116], [10, 116]], [[0, 104], [2, 74], [4, 74], [6, 96], [8, 74], [10, 104], [12, 74]]],
    [IN_516, 5, [[0, 116], [3, 92]], [[0, 104], [2, 74], [4, 74]]],
  ];
  for (const [opts, len, stabsWant, leftWant] of cases) {
    const src = everyStep(len * 3).map((n) => ({ ...n, note: 60 + (n.step % 12) }));
    const out = ragtimeStride(src, 1, opts, 2);
    for (let bar = 0; bar < 3; bar += 1) {
      const start = bar * len;
      const inBar = out.filter((n) => n.step >= start && n.step < start + len);
      const stabs = inBar.filter((n) => n.length === 1.5).map((n) => [n.step - start, n.velocity]);
      assert.deepEqual(stabs, stabsWant, `stabs in bar ${bar} of ${len}-step bars`);
      const left = [...new Map(inBar.filter((n) => n.length === 2).map((n) => [n.step - start, n.velocity])).entries()];
      assert.deepEqual(left, leftWant, `left hand in bar ${bar} of ${len}-step bars`);
    }
  }
  // The chorus stabs in a section follow the same pattern.
  const spans78: ChordSpan[] = TRIADS.slice(0, 2).map((triad, b) => ({ triad, start: b * 14, len: 14, meter: M78 }));
  const chorus = renderSection('chorus', spans78, { voicing: null, cursor: 74 }, { ladder: LADDER, chorusTexture: 'stride', seed: 2, meter: IN_78 });
  const hits = [...new Set(chorus.filter((n) => n.length === 1.5).map((n) => `${n.step}:${n.velocity}`))];
  assert.deepEqual(hits, ['0:116', '3:96', '6:116', '10:116', '14:116', '17:96', '20:116', '24:116']);
}

// syncopate: deterministic, the identity at 0, only strong onsets move, and
// every note keeps its end.
{
  const src = everyStep(28);
  const weights78 = [4, 1, 2, 1, 2, 1, 3, 1, 2, 1, 3, 1, 2, 1];
  assert.deepEqual(tuples(syncopate(src, 0.5, IN_78, 4)), tuples(syncopate(src, 0.5, IN_78, 4)));
  assert.deepEqual(syncopate(src, 0, IN_78, 4), src);
  const moved = (out: Map<number, PianoNote>): PianoNote[] => src.filter((n) => out.get(n.note)!.step !== n.step);
  const full = byPitch(syncopate(src, 1, IN_78, 4));
  const half = byPitch(syncopate(src, 0.5, IN_78, 4));
  // Weight 2 and up, less step 0, which has no position before it: 13 candidates.
  assert.equal(moved(full).length, 13);
  assert.equal(moved(half).length, 7);
  for (const out of [full, half]) {
    for (const n of src) {
      const got = out.get(n.note)!;
      assert.equal(got.step + got.length, n.step + n.length, `syncopate keeps the end of step ${n.step}`);
      if (got.step === n.step) continue;
      assert.ok(weights78[n.step % 14] >= 2, `syncopate moved step ${n.step}, a weak position`);
      assert.equal(got.step, n.step - 1, 'half an 8th back is the 16th before');
    }
  }
  // Strongest first: at 0.5 the bar start and all four group starts move.
  for (const s of [14, 6, 10, 20, 24]) assert.equal(half.get(30 + s)!.step, s - 1);
  // A humanized onset still counts as on its beat and keeps its offset; a 32nd off the grid never moves.
  const loose = syncopate([{ id: 'a', note: 60, step: 4.1, length: 1, velocity: 80 }, { id: 'b', note: 62, step: 8.5, length: 1, velocity: 80 }], 1, IN_44);
  assert.deepEqual(tuples(loose), [[60, 3.1, 2, 80], [62, 8.5, 1, 80]]);
}

// accentGroups: group and bar starts up by 30 at amount 1, the rest down by 10, clamped.
{
  const src = everyStep(28);
  const starts = [0, 6, 10];
  accentGroups(src, 1, IN_78).forEach((n, i) => assert.equal(n.velocity, starts.includes(i % 14) ? 110 : 70));
  accentGroups(src, 0.5, IN_78).forEach((n, i) => assert.equal(n.velocity, starts.includes(i % 14) ? 95 : 75));
  assert.deepEqual(accentGroups(src, 0, IN_78), src);
  const edges = accentGroups([{ id: 'a', note: 60, step: 14, length: 1, velocity: 120 }, { id: 'b', note: 61, step: 1, length: 1, velocity: 5 }], 1, IN_78);
  assert.deepEqual(edges.map((n) => n.velocity), [127, 1]);
  assert.equal(accentGroups([{ id: 'c', note: 60, step: 5.9, length: 1, velocity: 80 }], 1, IN_78)[0].velocity, 110);
}

// buildSong: a 7/8 section comes back in the map, sections without a meter
// follow the roll's map, and bar 0 starts after the pickup.
{
  const src = phrase(20260913);
  const base = { key: 'C', mode: 'major', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 120 } as const;
  const song = buildSong(src, { ...base, sections: [{ role: 'theme', bars: 2 }, { role: 'chorus', bars: 2, meter: M78 }, { role: 'outro', bars: 2 }] });
  assert.deepEqual(song.meterMap, [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 4, meter: M44 }]);
  const inRoll = buildSong(src, { ...base, sections: [{ role: 'theme', bars: 2 }, { role: 'outro', bars: 2 }], meterMap: [{ bar: 0, meter: M516 }, { bar: 1, meter: M78 }] });
  assert.deepEqual(inRoll.meterMap, [{ bar: 0, meter: M516 }, { bar: 1, meter: M78 }]);
  const pickedUp = buildSong(src, { ...base, sections: [{ role: 'theme', bars: 2 }], pickupSteps: 4 });
  assert.ok(Math.min(...pickedUp.notes.map((n) => n.step)) >= 3.5, 'the song starts after the pickup');
  assert.ok(buildSong(src, { ...base, amounts: { ...ZERO_AMOUNTS, sync: 1, accent: 1 }, sections: [{ role: 'chorus', bars: 2, meter: M78 }] }).notes.length > 0);
}

// --- cadences: chord degrees count from the key's tonic ----------------------- //

const NAMES = 'C C# D D# E F F# G G# A A# B'.split(' ');
const ALL_MODES = ['ionian', 'dorian', 'phrygian', 'lydian', 'mixolydian', 'aeolian', 'locrian', 'major', 'minor', 'melodic', 'harmonic'];
// The minor modes whose 7th sits a whole step under the tonic. A cadential V
// there takes the leading tone, and in Phrygian the natural 2nd as its fifth.
const SUBTONIC_MODES = new Set(['dorian', 'phrygian', 'aeolian', 'minor']);
const pcSet = (pcs: Iterable<number>): number[] => [...new Set([...pcs].map((p) => ((p % 12) + 12) % 12))].sort((a, b) => a - b);

/** The chord struck at `at`: the notes starting there that hold 12 steps or more, as its lowest pitch class and its pitch-class set. */
function chordOn(notes: readonly PianoNote[], at: number, label: string): { root: number; pcs: number[] } {
  const held = notes.filter((n) => Math.abs(n.step - at) < 0.2 && n.length >= 12);
  assert.ok(held.length >= 3, `${label}: a sustained chord at step ${at}`);
  const low = held.reduce((lo, n) => (n.note < lo.note ? n : lo));
  return { root: low.note % 12, pcs: pcSet(held.map((n) => n.note)) };
}
const startingIn = (notes: readonly PianoNote[], start: number, end: number): PianoNote[] =>
  notes.filter((n) => n.step >= start - 0.2 && n.step < end - 0.2);

// Every key and mode: one three-bar outro plays I, V, I, each bar one held
// chord, and rubato moves only the last bar, so the V holds steps 16-32 and the
// last chord starts at 32. The last chord is the key's own tonic triad, the V
// sits on the 5th degree, and a minor mode's V is a major triad with the leading
// tone. Every note over the V bar comes from its scale, and with the Harmony and
// Ragtime sliders up (Ragtime rewrites the V bar with this seed) no lowered tone
// sounds against it.
{
  const src = phrase(20260913);
  const sections: SectionSpec[] = [{ role: 'outro', bars: 3 }];
  const RUN_FORMS: SectionSpec[][] = [[{ role: 'solo', bars: 3 }], [{ role: 'build', bars: 2 }, { role: 'outro', bars: 1 }]];
  for (const key of NAMES) {
    const k = NAMES.indexOf(key);
    for (const mode of ALL_MODES) {
      const label = `${key} ${mode}`;
      const scale = new MusicalScale({ key, mode }).notes;
      const triadAt = (deg: number): number[] => pcSet(scale[deg].triad.notes.map((t) => NAMES.indexOf(t.note)));
      const minor = SUBTONIC_MODES.has(mode);
      const lowered = minor ? pcSet(mode === 'phrygian' ? [k + 10, k + 1] : [k + 10]) : [];
      const raise = (p: number): number => (p === (k + 10) % 12 && minor ? k + 11 : p === (k + 1) % 12 && mode === 'phrygian' ? k + 2 : p);
      const vScale = pcSet(scale.map((s) => raise(NAMES.indexOf(s.note))));

      const song = buildSong(src, { key, mode, style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 120, sections }).notes;
      const last = chordOn(song, 32, label);
      assert.equal(last.root, k, `${label}: the last chord's root is the key`);
      assert.deepEqual(last.pcs, triadAt(0), `${label}: the last chord is the tonic triad`);
      const five = chordOn(song, 16, label);
      assert.equal(five.root, NAMES.indexOf(scale[4].note), `${label}: the V's root is the 5th degree`);
      assert.deepEqual(five.pcs, minor ? pcSet([k + 7, k + 11, k + 2]) : triadAt(4), `${label}: the cadential V`);
      for (const n of startingIn(song, 16, 32)) assert.ok(vScale.includes(n.note % 12), `${label}: ${NAMES[n.note % 12]} at step ${n.step} is outside the V bar's scale`);

      const shaped = buildSong(src, { key, mode, style: 'romantic', amounts: { ...ZERO_AMOUNTS, harmony: 1, ragtime: 1 }, bpm: 120, sections }).notes;
      assert.ok(startingIn(shaped, 16, 32).some((n) => n.length === 1.5), `${label}: Ragtime rewrote the V bar`);
      for (const n of startingIn(shaped, 16, 32)) assert.ok(!lowered.includes(n.note % 12), `${label}: ${NAMES[n.note % 12]} at step ${n.step} sounds against the raised V`);

      // A solo's runs and a build's closing run over the V bar move in its
      // scale up to their last note, the chromatic step into the next one. The
      // V bar ends where the last held chord starts.
      for (const form of RUN_FORMS) {
        const notes = buildSong(src, { key, mode, style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 120, sections: form }).notes;
        const tonicAt = Math.max(...notes.filter((n) => n.length >= 12).map((n) => n.step));
        const bar = startingIn(notes, 16, tonicAt);
        const close = Math.max(...bar.map((n) => n.step));
        for (const n of bar) {
          if (n.step < close - 0.15) assert.ok(vScale.includes(n.note % 12), `${label} ${form[0].role}: ${NAMES[n.note % 12]} at step ${n.step} is outside the V bar's scale`);
        }
      }
    }
  }
}

// Which Vs are cadential, in A minor: the V that closes the intro (a half
// cadence) takes G sharp, and so does the V before the final tonic, while a V
// inside a section keeps the mode's own E minor. One eight-bar outro has rubato
// only in its last bar, so its held chords start on the bar lines.
{
  const src = phrase(20260913);
  const opts = { key: 'A', mode: 'minor', style: 'romantic', amounts: ZERO_AMOUNTS, bpm: 120 } as const;
  const half = buildSong(src, { ...opts, sections: [{ role: 'intro', bars: 2 }, { role: 'outro', bars: 3 }] }).notes;
  const outroAt = Math.min(...half.filter((n) => n.length >= 12).map((n) => n.step));
  const introV = startingIn(half, 16, outroAt);
  assert.ok(introV.some((n) => n.note % 12 === 8), "the intro's half cadence has G sharp");
  assert.ok(!introV.some((n) => n.note % 12 === 7), "no G natural in the intro's half cadence");
  const inner = buildSong(src, { ...opts, sections: [{ role: 'outro', bars: 8 }] }).notes;
  assert.deepEqual(chordOn(inner, 48, 'A minor bar 3'), { root: 4, pcs: [4, 7, 11] }, 'a V inside a section is E minor');
  assert.deepEqual(chordOn(inner, 96, 'A minor bar 6'), { root: 4, pcs: [4, 8, 11] }, 'the V before the final tonic is E major');
}

// Voice-leading: a bass that walks down by tritones comes back up an octave and
// keeps its pitch class. Eight interlude bars alternate F# diminished and C
// major, the I and V of F# Locrian; each bar holds its own chord over its root.
{
  const triads = [[6, 9, 0], [0, 4, 7]];
  const spans: ChordSpan[] = Array.from({ length: 8 }, (_, b) => ({ triad: triads[b % 2], start: b * 16, len: 16 }));
  const notes = renderSection('interlude', spans, { voicing: null, cursor: 74 }, { ladder: LADDER, chorusTexture: 'octaves', seed: 2 });
  for (const sp of spans) {
    const chord = chordOn(notes, sp.start, `interlude bar at ${sp.start}`);
    assert.equal(chord.root, sp.triad[0], `the bass at step ${sp.start} is the chord's root`);
    assert.deepEqual(chord.pcs, pcSet(sp.triad), `the chord at step ${sp.start}`);
    const low = Math.min(...notes.filter((n) => n.step === sp.start && n.length >= 12).map((n) => n.note));
    assert.ok(low >= 24 && low <= 52, `the bass at step ${sp.start} stays in its register: ${low}`);
  }
}

// harmonize: a note inside a scale span takes its third from the span's scale,
// and a line above C7 or below A1 gets the third below it.
{
  const A_HARMONIC = [0, 2, 4, 5, 8, 9, 11];
  const note = (n: number, step = 0): PianoNote => ({ id: `h${n}`, note: n, step, length: 2, velocity: 90 });
  const added = (out: PianoNote[], src: PianoNote[]): number[] => out.filter((n) => !src.some((s) => s.note === n.note && s.step === n.step)).map((n) => n.note);
  const inSpan = [note(71, 0), note(71, 16)];
  const spanned = harmonize(inSpan, 1, { key: 'A', mode: 'minor', scaleSpans: [{ start: 0, end: 16, pcs: A_HARMONIC }] });
  assert.deepEqual(added(spanned, inSpan), [68, 67], 'B takes G sharp below it inside the span and G after it');
  for (const [top, third] of [[108, 105], [100, 96], [31, 28], [26, 23]]) {
    assert.deepEqual(added(harmonize([note(top)], 0.5, OPTS), [note(top)]), [third], `the third below MIDI ${top} in C major`);
  }
}

// runsAndFlourishes: a run into a scale span moves in the span's scale once inside it.
{
  const A_HARMONIC = [0, 2, 4, 5, 8, 9, 11];
  const anchors: PianoNote[] = [
    { id: 'a', note: 69, step: 0, length: 1, velocity: 90 },
    { id: 'b', note: 81, step: 16, length: 1, velocity: 90 },
  ];
  const run = runsAndFlourishes(anchors, 1, { key: 'A', mode: 'minor', scaleSpans: [{ start: 12, end: 28, pcs: A_HARMONIC }] }).filter((n) => n.id !== 'a' && n.id !== 'b');
  assert.ok(run.length > 8, 'the gap is filled');
  assert.ok(run.some((n) => n.note % 12 === 8), 'the run climbs through G sharp');
  assert.ok(!run.some((n) => n.note % 12 === 7), 'no G natural in a run into the raised bar');
  // A run that starts before the span keeps the key's own scale until the span
  // starts: coming down from A5 it passes G natural, and G sharp waits for step 12.
  const down: PianoNote[] = [
    { id: 'a', note: 81, step: 0, length: 1, velocity: 90 },
    { id: 'b', note: 69, step: 16, length: 1, velocity: 90 },
  ];
  const fall = runsAndFlourishes(down, 1, { key: 'A', mode: 'minor', scaleSpans: [{ start: 12, end: 28, pcs: A_HARMONIC }] }).filter((n) => n.id !== 'a' && n.id !== 'b');
  const before = fall.filter((n) => n.step < 12);
  assert.ok(before.some((n) => n.note % 12 === 7), 'the run passes G natural before the span');
  for (const n of before) assert.notEqual(n.note % 12, 8, `no G sharp at step ${n.step}, before the span`);
  for (const n of fall.filter((f) => f.step >= 12 && f.step < Math.max(...fall.map((x) => x.step)))) assert.notEqual(n.note % 12, 7, `no G natural at step ${n.step}, inside the span`);
}

// The arpeggiator's rag counts odd 16ths from each bar start.
{
  for (let s = 0; s < 64; s += 1) assert.equal(ragOffsetSteps(s, 0.3), s % 2 === 1 ? 0.3 : 0, `rag at step ${s} with no meter`);
  const meter = { meterMap: [{ bar: 0, meter: M78 }, { bar: 1, meter: M516 }] };
  // One 14-step bar, then 5-step bars from step 14.
  for (let s = 0; s < 64; s += 1) {
    const at = s < 14 ? s : (s - 14) % 5;
    assert.equal(ragOffsetSteps(s, 0.3, meter), at % 2 === 1 ? 0.3 : 0, `rag at step ${s} after a 7/8 bar`);
  }
  assert.equal(ragOffsetSteps(20, 0.3, meter), 0.3, 'step 20 is even from step 0 and odd from its bar start at 19');
  // A 3-step pickup is the end of a 4/4 bar: its steps are that bar's 16ths 13, 14 and 15.
  assert.deepEqual([0, 1, 2, 3, 4].map((s) => ragOffsetSteps(s, 0.3, { pickupSteps: 3 })), [0.3, 0, 0.3, 0, 0.3]);
}

// virtuosoStore: state saved before sync, accent and section meters loads with
// 0 and no meter; then Build Song, a section meter removed, and a meter change
// in the roll, in the order the UI produces them.
{
  const saved = new Map<string, string>([
    [
      'thedaw-virtuoso-v1',
      JSON.stringify({
        state: {
          amounts: { harmony: 0, ragtime: 0, runs: 0.2, rhythm: 0, humanize: 0.1 },
          key: 'D',
          mode: 'dorian',
          style: 'baroque',
          sections: [{ role: 'theme', bars: 2 }, { role: 'solo', bars: 2, meter: { num: 7, den: 9, groups: [] } }],
          groove: null,
        },
        version: 0,
      }),
    ],
  ]);
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (k: string) => saved.get(k) ?? null,
      setItem: (k: string, v: string) => void saved.set(k, v),
      removeItem: (k: string) => void saved.delete(k),
    },
  });
  if (typeof window === 'undefined') Object.defineProperty(globalThis, 'window', { configurable: true, value: globalThis });
  const { useVirtuosoStore } = await import('../state/virtuosoStore.ts');
  const { usePianoRollStore } = await import('../state/pianoRollStore.ts');
  const v = useVirtuosoStore.getState();
  assert.deepEqual(v.amounts, { harmony: 0, ragtime: 0, runs: 0.2, rhythm: 0, humanize: 0.1, sync: 0, accent: 0 });
  assert.deepEqual(v.sections, [{ role: 'theme', bars: 2 }, { role: 'solo', bars: 2 }]);

  const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 200));
  const roll = usePianoRollStore.getState;
  roll().importNotes(phrase(7));
  v.captureSource();
  v.setSectionMeter(1, M78);
  v.buildSong();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }]);
  useVirtuosoStore.getState().setSectionMeter(1, null);
  await settle();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M44 }], 'a removed section meter does not linger through the last song');
  roll().setMeterMap([{ bar: 0, meter: M516 }]);
  useVirtuosoStore.getState().setSectionBars(0, 3);
  await settle();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M516 }], 'a meter set in the roll during song mode is followed');
  useVirtuosoStore.getState().setSectionMeter(0, M78);
  await settle();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M78 }, { bar: 3, meter: M516 }]);
  useVirtuosoStore.getState().resetToSource();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M516 }], 'reset puts the source back under its own map');

  // The review's sequence: a 4/4 roll, section 1 = 7/8, SONG, BEATS- on bars 5-, SONG, section 1 = Roll.
  // The roll edit after the song is kept; the bars section 1 wrote go back to the roll's 4/4.
  const { setBeats } = await import('./meterFace.ts');
  const M34 = { num: 3, den: 4, groups: [] };
  roll().applyMeter({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
  useVirtuosoStore.setState({ sections: null, style: 'romantic' });
  useVirtuosoStore.getState().captureSource();
  useVirtuosoStore.getState().setSectionMeter(0, M78);
  const firstBars = useVirtuosoStore.getState().effectiveSections()[0].bars;
  useVirtuosoStore.getState().buildSong();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M78 }, { bar: firstBars, meter: M44 }]);
  const edit = setBeats(roll().meterMap, 1, 3);
  roll().applyMeter({ meterMap: edit.meterMap }, false);
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M78 }, { bar: firstBars, meter: M34 }]);
  useVirtuosoStore.getState().buildSong();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M78 }, { bar: firstBars, meter: M34 }]);
  useVirtuosoStore.getState().setSectionMeter(0, null);
  await settle();
  assert.deepEqual(roll().meterMap, [{ bar: 0, meter: M44 }, { bar: firstBars, meter: M34 }], "section 1's bars follow the roll again once its meter is gone");
  useVirtuosoStore.getState().resetToSource();
}

// The UI's order: notes in the roll, CAPTURE, the Rachmaninoff style (minor),
// FORM cut to one three-bar outro, key D, Harmony and Ragtime up, SONG. The
// roll then ends on D minor after an A major V with C sharp and no C natural.
{
  const { useVirtuosoStore } = await import('../state/virtuosoStore.ts');
  const { usePianoRollStore } = await import('../state/pianoRollStore.ts');
  const v = useVirtuosoStore.getState;
  const roll = usePianoRollStore.getState;
  roll().applyMeter({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
  roll().importNotes(phrase(11));
  v().captureSource();
  v().setStyle('romantic');
  assert.equal(v().mode, 'minor');
  while (v().effectiveSections().length > 1) v().removeSection(1);
  v().setSectionRole(0, 'outro');
  v().setSectionBars(0, 3);
  v().setKey('D');
  v().setAmount('harmony', 1);
  v().setAmount('ragtime', 1);
  v().buildSong();
  const notes = roll().notes;
  const last = chordOn(notes, 32, 'D minor in the roll');
  assert.equal(last.root, 2, 'the song ends on D');
  assert.deepEqual(last.pcs, [2, 5, 9], 'the last chord is D minor');
  const five = startingIn(notes, 16, 32);
  assert.equal(five.reduce((lo, n) => (n.note < lo.note ? n : lo)).note % 12, 9, 'the V bar stands on A');
  assert.ok(five.some((n) => n.note % 12 === 1), 'the V has C sharp');
  assert.ok(!five.some((n) => n.note % 12 === 0), 'no C natural sounds in the V bar');
  v().resetToSource();
}

// HARMONY on a fast run, the way the Virtuoso panel runs it: the roll holds
// the run, the panel captures it, HARMONY goes to full, and the render lands
// back in the roll (replaceAll). Every counter note takes its melody note's own
// length, so the counter run stays detached like the melody. Harmonize used to
// raise each counter note to a full 16th, and every transform's note builder
// raised a note under a 64th (0.25 steps) to a 64th, so a 16th-triplet run and
// a 128th-note run each came back with every counter note overlapping the next.
for (const [name, len, ticks] of [['16th triplets', 2 / 3, 160], ['128th notes', 1 / 8, 30]] as const) {
  const { useVirtuosoStore } = await import('../state/virtuosoStore.ts');
  const { usePianoRollStore } = await import('../state/pianoRollStore.ts');
  const roll = usePianoRollStore.getState;
  const melody: PianoNote[] = Array.from({ length: 24 }, (_, i) => ({
    id: `t${i}`, note: [72, 74, 76][i % 3], step: i * len, length: len, velocity: 96,
  }));
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  useVirtuosoStore.setState({ amounts: { ...ZERO_AMOUNTS }, songMode: false, sections: null, groove: null, key: 'C', mode: 'major' });
  roll().replaceAll(melody);
  useVirtuosoStore.getState().captureSource();
  useVirtuosoStore.getState().setAmount('harmony', 1);
  const byTick = new Map<number, { note: number; tick: number; ticks: number }[]>();
  for (const n of roll().notes) {
    const at = byTick.get(n.tick!) ?? [];
    at.push({ note: n.note, tick: n.tick!, ticks: n.ticks! });
    byTick.set(n.tick!, at);
  }
  const counter = [...byTick.values()]
    .map((at) => at.reduce((lo, n) => (n.note < lo.note ? n : lo)))
    .sort((a, b) => a.tick - b.tick);
  assert.equal(roll().notes.length, 48, `${name}: every melody note gets a counter note at full HARMONY`);
  assert.equal(counter.length, 24);
  for (const n of counter) assert.equal(n.ticks, ticks, `${name}: a counter note keeps its melody note's ${ticks} ticks`);
  for (let i = 1; i < counter.length; i += 1) {
    assert.ok(counter[i - 1].tick + counter[i - 1].ticks <= counter[i].tick, `${name}: counter note ${i - 1} ends before counter note ${i} starts`);
  }
  useVirtuosoStore.getState().resetToSource();
}

// HUMANIZE on a 128th-note run, the way the Virtuoso panel runs it: the roll
// holds the run, the panel captures it, HUMANIZE goes up, and the render lands
// back in the roll. A note humanize lengthens or shortens changes by half its
// own length at most, so every 30-tick note comes back between 15 and 45 ticks.
// Humanize used to add or take a fixed 0.5 steps and floor at 0.25 steps, so a
// shortened note came back a 64th (60 ticks) and a lengthened one 0.625 steps
// (150 ticks), running over the next four notes.
for (const amount of [0.6, 1]) {
  const { useVirtuosoStore } = await import('../state/virtuosoStore.ts');
  const { usePianoRollStore } = await import('../state/pianoRollStore.ts');
  const roll = usePianoRollStore.getState;
  const len = 1 / 8;
  const melody: PianoNote[] = Array.from({ length: 24 }, (_, i) => ({
    id: `h${i}`, note: [72, 74, 76][i % 3], step: i * len, length: len, velocity: 96,
  }));
  roll().applyMeter({ meterMap: [{ bar: 0, meter: { num: 4, den: 4, groups: [] } }], pickupSteps: 0 });
  useVirtuosoStore.setState({ amounts: { ...ZERO_AMOUNTS }, songMode: false, sections: null, groove: null, key: 'C', mode: 'major' });
  roll().replaceAll(melody);
  useVirtuosoStore.getState().captureSource();
  useVirtuosoStore.getState().setAmount('humanize', amount);
  const ticks = roll().notes.map((n) => n.ticks!);
  assert.equal(ticks.length, 24, `HUMANIZE ${amount}: every note stays in the roll`);
  assert.ok(ticks.some((t) => t !== 30), `HUMANIZE ${amount}: some note length moves, so the jitter runs (${ticks.join(',')})`);
  for (const t of ticks) assert.ok(t >= 15 && t <= 45, `HUMANIZE ${amount}: a 30-tick note comes back ${t} ticks, outside half its length`);
  useVirtuosoStore.getState().resetToSource();
}

// HARMONY past 0.66, the way the Virtuoso panel runs it: the roll holds a
// melody over held chord tones, the panel captures it, the Harmony slider goes
// to 90, and the render lands back in the roll. Past 0.66 about three in ten
// thirds drop a semitone; each one used to drop whatever sounded with it, so a
// lowered B landed under a sounding C and an E under a sounding F, a semitone
// against the melody. No added note may sit a semitone, major seventh or minor
// ninth from a melody note sounding with it, where the diatonic third did not.
{
  const { useVirtuosoStore } = await import('../state/virtuosoStore.ts');
  const { usePianoRollStore } = await import('../state/pianoRollStore.ts');
  const roll = usePianoRollStore.getState;
  const semitone = (a: number, b: number): boolean => [1, 11].includes((((a - b) % 12) + 12) % 12);
  let lowered = 0;
  let clashes = 0;
  for (let seed = 1; seed <= 40; seed += 1) {
    const src = phrase(seed * 101);
    roll().applyMeter({ meterMap: [{ bar: 0, meter: M44 }], pickupSteps: 0 });
    useVirtuosoStore.setState({ amounts: { ...ZERO_AMOUNTS }, songMode: false, sections: null, groove: null, key: 'C', mode: 'major' });
    roll().replaceAll(src);
    useVirtuosoStore.getState().captureSource();
    useVirtuosoStore.getState().setAmount('harmony', 0.9);
    const key = (n: { note: number; step: number }) => `${n.note}@${n.step}`;
    const own = new Set(src.map(key));
    const added = roll().notes.filter((n) => !own.has(key(n)));
    for (const a of added) {
      if (C_MAJOR.includes(a.note % 12)) continue;
      lowered += 1;
      const sounding = src.filter((m) => m.step < a.step + a.length - 1e-9 && m.step + m.length > a.step + 1e-9);
      if (sounding.some((m) => semitone(m.note, a.note))) clashes += 1;
    }
    useVirtuosoStore.getState().resetToSource();
  }
  assert.ok(lowered > 0, 'past 0.66 some thirds still take a borrowed tone');
  assert.equal(clashes, 0, `${clashes} lowered thirds clash with the melody`);
  // At or under 0.66 every added note is diatonic.
  const plain = phrase(7);
  const under = harmonize(plain, 0.66, OPTS, 3).filter((n) => !plain.some((m) => m.note === n.note && m.step === n.step));
  assert.ok(under.length > 0 && under.every((n) => C_MAJOR.includes(n.note % 12)), 'no borrowed tone at 0.66');
}

// The Harmony slider's tooltip names each range at harmonize's own threshold,
// and says what the slider does where it stands. It used to say only "Harmony amount".
{
  assert.equal(HARMONY_BORROW_FROM, 0.66);
  const lines = (amount: number): string[] => harmonyDescription(amount).split('\n');
  const ranges = lines(0);
  assert.ok(ranges.includes('0: off.'));
  assert.ok(ranges.some((l) => l.startsWith('1 to 66: ')), 'the scale-third range ends at 66');
  assert.ok(ranges.some((l) => l.startsWith('67 to 100: ') && l.includes('semitone')), 'the borrowed-tone range starts at 67');
  assert.equal(ranges.at(-1), 'Now 0: off, the melody plays alone.');
  assert.equal(lines(0.4).at(-1), 'Now 40: a scale third under about 40 in 100 top notes.');
  assert.equal(lines(0.66).at(-1), 'Now 66: a scale third under about 66 in 100 top notes.');
  // The clash guard keeps many candidate drops on the scale third, so the line
  // gives three in ten as a ceiling, never as the share the user will hear.
  assert.equal(
    lines(0.9).at(-1),
    'Now 90: a third under about 90 in 100 top notes, up to about three in ten of them a semitone lower where that does not clash with the melody.',
  );
}

console.log('virtuosoTransform: ok');
