/**
 * djCueSeed — the DJ tab's automatic hot-cue placement (DJ-3).
 *
 * The user's report was "i dont see cue points": nothing in the app ever
 * created one. `djCuesStore` only ever had writers behind the hotcue pads and
 * the MIDI map, so a freshly analyzed track showed four empty pads and a bare
 * waveform. `seedCues` is the pure half of the fix — given what analysis
 * actually returns (a flat `beats` list and a `bpm`; NO downbeats, NO
 * sections) plus the rhythm module's downbeats when they happen to be cached,
 * it picks the four positions a DJ would drop by hand: the top of the track
 * and the starts of the 16 / 32 / 48-bar phrases after it.
 *
 * Run: `npx tsx src/lib/djCueSeed.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import { seedCues } from './djCueSeed';
import { buildBeatgrid } from './beatgrid';

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ok ${name}`);
};

const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
/** 16 bars of 4/4 at 120bpm = 64 beats = 32s. */
const PHRASE = 16 * 4 * BEAT;

const beatsFrom = (start: number, count: number, step = BEAT): number[] =>
  Array.from({ length: count }, (_, i) => start + i * step);

console.log('djCueSeed');

/* ── no bpm means no grid, and a guessed cue is worse than none ── */

test('returns null without a bpm', () => {
  assert.equal(seedCues({ beats: beatsFrom(0.25, 400), bpm: null, duration: 200 }), null);
  assert.equal(seedCues({ beats: beatsFrom(0.25, 400), bpm: 0, duration: 200 }), null);
});

test('returns null with no beats and no downbeats', () => {
  assert.equal(seedCues({ beats: [], bpm: BPM, duration: 200 }), null);
  assert.equal(seedCues({ beats: null, bpm: BPM, duration: 200 }), null);
});

/* ── beats-only: what every DJ track actually has today ── */

test('cue 1 is the first beat when there are no downbeats', () => {
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200 });
  assert.ok(out);
  assert.equal(out[0], 0.25);
});

test('cues 2-4 are the 16 / 32 / 48-bar phrase starts off the first beat', () => {
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200 });
  assert.ok(out);
  assert.deepEqual(out, [0.25, 0.25 + PHRASE, 0.25 + 2 * PHRASE, 0.25 + 3 * PHRASE]);
  assert.equal(out.length, 4);
});

test('every cue lands inside the track', () => {
  // 40s track: the 32- and 48-bar phrases fall off the end.
  const out = seedCues({ beats: beatsFrom(0, 80), bpm: BPM, duration: 40 });
  assert.ok(out);
  for (const t of out) {
    if (t == null) continue;
    assert.ok(t >= 0, `${t} >= 0`);
    assert.ok(t < 40, `${t} < duration`);
  }
});

test('a phrase past the end is dropped, not clamped onto the last cue', () => {
  // 40s at 120bpm: the 16-bar phrase (32s) fits; the 32- and 48-bar ones do
  // not. Clamping them to `duration - beatLen` put cue 3 AND cue 4 on 39.5 —
  // two pads seeking the same spot and two markers stacked on the waveform.
  // A phrase the track does not reach has no cue.
  const out = seedCues({ beats: beatsFrom(0, 80), bpm: BPM, duration: 40 });
  assert.ok(out);
  assert.equal(out[0], 0);
  assert.equal(out[1], PHRASE);
  assert.equal(out[2], null, `the 32-bar phrase is past the end: ${JSON.stringify(out)}`);
  assert.equal(out[3], null, `the 48-bar phrase is past the end: ${JSON.stringify(out)}`);
  const placed = out.filter((t): t is number => t != null);
  assert.equal(new Set(placed).size, placed.length, `duplicate cues: ${JSON.stringify(out)}`);
});

test('a bar start the grid places past the end is dropped too', () => {
  // The rhythm cache can carry a bar line at (or past) the very end of the
  // file; it is not a legal seek target either.
  // 49 bar starts, the last one 0.1s from the end of a 40s file — that is
  // the one cue 4 reads (index 48 = the 48-bar phrase).
  const bars = Array.from({ length: 49 }, (_, i) => (i === 48 ? 39.9 : i * 0.1));
  const out = seedCues({ beats: beatsFrom(0, 80), bpm: BPM, duration: 40, bars });
  assert.ok(out);
  assert.equal(out[2], bars[32]);
  assert.equal(out[3], null, JSON.stringify(out));
});

test('an unknown duration still seeds (nothing to clamp against)', () => {
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 0 });
  assert.ok(out);
  assert.equal(out[3], 0.25 + 3 * PHRASE);
});

/* ── rhythm module downbeats/bars win when the cache has them ── */

test('cue 1 is the first downbeat when rhythm data is present', () => {
  const downbeats = beatsFrom(1.5, 80, 4 * BEAT); // one per bar
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200, downbeats });
  assert.ok(out);
  assert.equal(out[0], 1.5);
});

test('phrase cues come off the downbeat list, not arithmetic', () => {
  // A deliberately uneven downbeat list: arithmetic off beats[0] cannot
  // produce these, so this pins that the real bar starts are what is used.
  const downbeats = Array.from({ length: 64 }, (_, i) => 1.5 + i * 2 + (i % 3) * 0.01);
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200, downbeats });
  assert.ok(out);
  assert.deepEqual(out, [downbeats[0], downbeats[16], downbeats[32], downbeats[48]]);
});

test('an explicit bars list beats the downbeat list', () => {
  const downbeats = beatsFrom(1.5, 80, 4 * BEAT);
  const bars = beatsFrom(2.75, 80, 4 * BEAT);
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200, downbeats, bars });
  assert.ok(out);
  assert.deepEqual(out, [bars[0], bars[16], bars[32], bars[48]]);
});

test('a short downbeat list falls back to arithmetic for the phrases it lacks', () => {
  const downbeats = beatsFrom(1.5, 20, 4 * BEAT); // only 20 bars cached
  const out = seedCues({ beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200, downbeats });
  assert.ok(out);
  assert.equal(out[0], 1.5);
  assert.equal(out[1], downbeats[16]);
  // 32 and 48 are past the cached list — measured off the first downbeat.
  assert.ok(Math.abs(out[2] - (1.5 + 2 * PHRASE)) < 1e-9, `${out[2]}`);
  assert.ok(Math.abs(out[3] - (1.5 + 3 * PHRASE)) < 1e-9, `${out[3]}`);
});

test('downbeats alone are enough — no beats list needed', () => {
  const downbeats = beatsFrom(1.5, 80, 4 * BEAT);
  const out = seedCues({ beats: null, bpm: BPM, duration: 200, downbeats });
  assert.ok(out);
  assert.equal(out[0], 1.5);
});

/* ── defensive: analysis payloads are not always clean ── */

test('non-finite and negative inputs never reach a cue', () => {
  const out = seedCues({
    beats: [Number.NaN, -3, 0.25, 0.75],
    bpm: BPM,
    duration: 200,
  });
  assert.ok(out);
  for (const t of out) assert.ok(Number.isFinite(t) && t >= 0, `${t}`);
  assert.equal(out[0], 0.25);
});

test('the result is a fresh array each call (never shared state)', () => {
  const args = { beats: beatsFrom(0.25, 400), bpm: BPM, duration: 200 };
  const a = seedCues(args);
  const b = seedCues(args);
  assert.ok(a && b);
  assert.notEqual(a, b);
  assert.deepEqual(a, b);
});

/* ── what DJView really passes: the constant beatgrid ── */

test('with the grid the deck passes, cue 1 is the first detected beat', () => {
  // PR #207 review: every test above fed raw beats, but DJView passes
  // `gridBeats` — buildBeatgrid's constant grid, whose first line is the grid
  // line nearest 0:00. After a 3.2 s intro that line is at 0.2 s, six beats
  // before the music, and cue 1 and every phrase cue landed there.
  const raw = beatsFrom(3.2, 390);
  const grid = buildBeatgrid({ bpm: BPM, beats: raw, duration: 200 });
  assert.ok(grid);
  assert.equal(grid.beats[0], 0.2, 'the grid the deck builds starts before the music');
  const out = seedCues({ beats: grid.beats, firstBeat: raw[0], bpm: BPM, duration: 200 });
  assert.ok(out);
  assert.equal(out[0], 3.2, 'THE BUG: cue 1 sat on the grid line nearest 0:00');
  assert.deepEqual(out, [3.2, 3.2 + PHRASE, 3.2 + 2 * PHRASE, 3.2 + 3 * PHRASE], 'phrase cues count from the first beat');
});

test('cached downbeats still win over the first beat', () => {
  const raw = beatsFrom(3.2, 390);
  const grid = buildBeatgrid({ bpm: BPM, beats: raw, duration: 200 });
  assert.ok(grid);
  const out = seedCues({ beats: grid.beats, firstBeat: raw[0], bpm: BPM, duration: 200, downbeats: beatsFrom(4.2, 90, 4 * BEAT) });
  assert.ok(out);
  assert.equal(out[0], 4.2);
});

console.log(`\ndjCueSeed: ${passed} passed`);
