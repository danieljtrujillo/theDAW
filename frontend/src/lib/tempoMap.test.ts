import assert from 'node:assert/strict';
import {
  DEFAULT_BPM, DEFAULT_TEMPO_MAP, beatToTime, getBarAtBeat, getBarLength, getBeatAtBar, getBeatLength,
  getSecPerBeatAt, getTempoAtBeat, normalizeTempoMap, remapOnTempoChange, timeToBeat,
  type TempoEvent, type TempoPoint,
} from './tempoMap.ts';
import { beatsFromSeconds, secondsFromBeats, type TempoEntry } from './notechart.ts';
import type { MeterSegment } from './meterMap.ts';

const near = (a: number, b: number, eps = 1e-9): void => assert.ok(Math.abs(a - b) < eps, `${a} !~ ${b}`);

const M44 = { num: 4, den: 4, groups: [] };
const M78 = { num: 7, den: 8, groups: [3, 2, 2] };
const M68 = { num: 6, den: 8, groups: [3, 3] };

// A seeded default: an empty or missing map is one 120 bpm event at beat 0.
{
  assert.equal(DEFAULT_BPM, 120);
  // `slope` is the ramp field: 0 means "this segment holds", which is every
  // segment of every map written before ramps existed.
  assert.deepEqual(normalizeTempoMap(undefined), [{ beat: 0, bpm: 120, timeSec: 0, secPerBeat: 0.5, slope: 0 }]);
  assert.deepEqual(normalizeTempoMap([]), normalizeTempoMap(null));
  assert.deepEqual(normalizeTempoMap(DEFAULT_TEMPO_MAP), normalizeTempoMap([]));
  assert.equal(getTempoAtBeat(undefined, 0), 120);
  assert.equal(getTempoAtBeat([], 1000), 120);
  assert.equal(beatToTime(null, 8), 4);
  assert.equal(timeToBeat(null, 4), 8);
  assert.equal(getSecPerBeatAt([], 3), 0.5);
  // Junk is dropped, not trusted: a zero/negative/NaN bpm cannot define a segment.
  // This is deliberate, not incidental — the inline code this replaced divided
  // by a negative bpm and ran time BACKWARDS through such an event.
  assert.deepEqual(normalizeTempoMap([{ beat: 0, bpm: 0 }, { beat: 4, bpm: Number.NaN }]), normalizeTempoMap([]));
  assert.equal(beatToTime([{ beat: 0, bpm: -120 }], 8), 4, 'a negative bpm falls back to the seeded 120, not -4 s');
  assert.equal(getTempoAtBeat([{ beat: 0, bpm: 120 }, { beat: 8, bpm: -60 }], 16), 120);
}

// Constant tempo: round-trips, and both directions are linear.
{
  for (const bpm of [20, 60, 90, 120, 128.5, 174, 300]) {
    const map: TempoEvent[] = [{ beat: 0, bpm }];
    for (const b of [0, 0.25, 1, 4.75, 16, 129.5, -3.5]) near(timeToBeat(map, beatToTime(map, b)), b);
    for (const s of [0, 0.125, 2, 37.75, -1.5]) near(beatToTime(map, timeToBeat(map, s)), s);
    near(beatToTime(map, 4), (4 * 60) / bpm);
    near(timeToBeat(map, 4), (4 * bpm) / 60);
  }
  // beatClock's degenerate map: the exact scalar it has always used.
  assert.equal(beatToTime([{ beat: 0, bpm: 140 }], 7), (60 / 140) * 7);
  assert.equal(timeToBeat([{ beat: 0, bpm: 140 }], 3.0001), 3.0001 / (60 / 140));
}

// Two events: 120 until beat 16, then 90. Piecewise, not blended.
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }];
  assert.equal(beatToTime(map, 0), 0);
  assert.equal(beatToTime(map, 8), 4);
  assert.equal(beatToTime(map, 16), 8); // 16 beats * 0.5 s
  assert.equal(beatToTime(map, 20), 8 + 4 * (60 / 90));
  near(beatToTime(map, 28), 16);
  // Backwards past the first event extends its tempo.
  assert.equal(beatToTime(map, -4), -2);
  // Inverse across the change.
  assert.equal(timeToBeat(map, 8), 16);
  near(timeToBeat(map, 16), 28);
  assert.equal(timeToBeat(map, 4), 8);
  assert.equal(timeToBeat(map, -2), -4);
  for (const b of [0, 5.5, 15.999, 16, 16.001, 40]) near(timeToBeat(map, beatToTime(map, b)), b);
  // Unsorted input normalizes; a later event at the same beat wins.
  assert.deepEqual(normalizeTempoMap([{ beat: 16, bpm: 90 }, { beat: 0, bpm: 120 }]), normalizeTempoMap(map));
  assert.equal(getTempoAtBeat([{ beat: 0, bpm: 120 }, { beat: 0, bpm: 150 }], 0), 150);
}

// getTempoAtBeat before / at / after an event.
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }, { beat: 32, bpm: 174 }];
  assert.equal(getTempoAtBeat(map, -1), 120);
  assert.equal(getTempoAtBeat(map, 15.999), 120);
  assert.equal(getTempoAtBeat(map, 16), 90); // the event owns its own beat
  assert.equal(getTempoAtBeat(map, 16.001), 90);
  assert.equal(getTempoAtBeat(map, 31.999), 90);
  assert.equal(getTempoAtBeat(map, 32), 174);
  assert.equal(getTempoAtBeat(map, 1e6), 174);
  assert.equal(getSecPerBeatAt(map, 20), 60 / 90);
}

// An event may carry its own authoritative seconds (the notechart shape does).
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 120, timeSec: 0 }, { beat: 8, bpm: 60, timeSec: 4 }];
  assert.equal(beatToTime(map, 10), 6);
  assert.equal(timeToBeat(map, 6), 10);
  // A first event that starts late, with no seconds of its own, runs its tempo back to beat 0.
  assert.equal(beatToTime([{ beat: 4, bpm: 120 }], 0), 0);
  assert.equal(beatToTime([{ beat: 4, bpm: 120 }], 6), 3);
  // The supported shapes — seconds on EVERY event, or on none — both round-trip.
  // (Mixing the two can order the seconds 0, 4, 2, and `timeToBeat` searches on
  // them, so it would stop being the inverse. The JSDoc states the precondition;
  // no caller mixes, and authoritative values are never clamped to hide it.)
  const authoritative: TempoEvent[] = [
    { beat: 0, bpm: 120, timeSec: 0 }, { beat: 8, bpm: 60, timeSec: 4 }, { beat: 16, bpm: 174, timeSec: 12 },
  ];
  const integrated: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 60 }, { beat: 16, bpm: 174 }];
  for (const m of [authoritative, integrated]) {
    for (const b of [0, 3.5, 8, 11.25, 16, 40, -6]) near(timeToBeat(m, beatToTime(m, b)), b);
    for (const s of [0, 2, 4, 9.5, 12, 30, -1]) near(beatToTime(m, timeToBeat(m, s)), s);
  }
  // Both shapes describe the same music, so they agree.
  for (const b of [0, 3.5, 8, 11.25, 16, 40]) near(beatToTime(authoritative, b), beatToTime(integrated, b));
}

// Bar and beat lengths, in quarter notes.
{
  assert.equal(getBeatLength(M44), 1);
  assert.equal(getBeatLength(M78), 0.5);
  assert.equal(getBarLength(M44), 4);
  assert.equal(getBarLength(M78), 3.5);
  assert.equal(getBarLength(M68), 3);
  assert.equal(getBarLength({ num: 5, den: 16, groups: [] }), 1.25);
}

// getBeatAtBar / getBarAtBeat under 4/4.
{
  const map: MeterSegment[] = [{ bar: 0, meter: M44 }];
  assert.equal(getBeatAtBar(map, 0), 0);
  assert.equal(getBeatAtBar(map, 3), 12);
  const p = getBarAtBeat(map, 9.5);
  assert.deepEqual([p.bar, p.startBeat, p.lengthBeats, p.beatInBar], [2, 8, 4, 1.5]);
  assert.equal(getBarAtBeat(map, 0).bar, 0);
  assert.equal(getBarAtBeat(map, 16).bar, 4);
  // No meter map at all is 4/4.
  assert.equal(getBeatAtBar(undefined, 3), 12);
  assert.equal(getBarAtBeat(null, 9.5).bar, 2);
  // A hair BELOW a bar line: meterMap.barAt's 1e-9 step epsilon snaps to the
  // next bar, so `beatInBar` must clamp at 0 rather than go negative — a
  // negative offset would make phase() report beat -1 and sixteenth 3.
  const edge = getBarAtBeat(map, 4 - 1e-10);
  assert.equal(edge.bar, 1);
  assert.equal(edge.startBeat, 4);
  assert.equal(edge.beatInBar, 0);
  assert.ok(edge.beatInBar >= 0 && Math.floor(edge.beatInBar) >= 0);
  for (const bar of [1, 2, 8]) {
    for (const d of [-1e-10, -1e-12, 0, 1e-12]) {
      assert.ok(getBarAtBeat(map, bar * 4 + d).beatInBar >= 0, `beatInBar >= 0 at ${bar * 4 + d}`);
    }
  }
}

// ... under 7/8 (3.5 quarter notes to the bar) ...
{
  const map: MeterSegment[] = [{ bar: 0, meter: M78 }];
  assert.equal(getBeatAtBar(map, 1), 3.5);
  assert.equal(getBeatAtBar(map, 4), 14);
  const p = getBarAtBeat(map, 8);
  assert.deepEqual([p.bar, p.startBeat, p.lengthBeats], [2, 7, 3.5]);
  near(p.beatInBar, 1);
  assert.deepEqual(p.meter, M78);
}

// ... and across a meter change mid-song: 4/4, then 7/8 at bar 2, then 4/4 again at bar 4.
{
  const map: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }, { bar: 4, meter: M44 }];
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6].map((b) => getBeatAtBar(map, b)), [0, 4, 8, 11.5, 15, 19, 23]);
  assert.equal(getBarAtBeat(map, 7.99).bar, 1);
  assert.equal(getBarAtBeat(map, 8).bar, 2);
  assert.equal(getBarAtBeat(map, 11.5).bar, 3);
  assert.equal(getBarAtBeat(map, 14.99).bar, 3);
  assert.equal(getBarAtBeat(map, 15).bar, 4);
  assert.equal(getBarAtBeat(map, 15).lengthBeats, 4);
  for (const bar of [0, 1, 2, 3, 4, 7, 12]) assert.equal(getBarAtBeat(map, getBeatAtBar(map, bar)).bar, bar);
}

// Tempo and meter together: bar starts in seconds under a tempo change AND a meter change.
{
  const meters: MeterSegment[] = [{ bar: 0, meter: M44 }, { bar: 2, meter: M78 }];
  const tempo: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 8, bpm: 90 }];
  // Bars 0..2 are 4/4 at 120 -> 2 s each. Bar 2 starts at beat 8, where 90 bpm begins.
  assert.equal(beatToTime(tempo, getBeatAtBar(meters, 2)), 4);
  near(beatToTime(tempo, getBeatAtBar(meters, 3)), 4 + 3.5 * (60 / 90));
}

// --- notechart delegation: the two wrappers still produce the shipped numbers ---
// Pinned from the fixture in components/layout/score/highway/schedule.test.ts,
// captured from the pre-delegation inline implementation.
{
  const TEMPO: TempoEntry[] = [
    { timeSec: 0, timeBeats: 0, timeTicks: 0, bpm: 120, secPerBeat: 0.5, measure: 0, interpolateToNext: false },
    { timeSec: 4, timeBeats: 8, timeTicks: 3840, bpm: 60, secPerBeat: 1, measure: 0, interpolateToNext: false },
  ];
  assert.equal(secondsFromBeats(TEMPO, 10), 6);
  assert.equal(secondsFromBeats(TEMPO, 1.25), 0.625);
  assert.equal(secondsFromBeats(TEMPO, 7.999), 3.9995);
  assert.equal(secondsFromBeats(TEMPO, 9.5), 5.5);
  assert.equal(secondsFromBeats(TEMPO, 20), 16);
  assert.equal(secondsFromBeats(TEMPO, -2), -1); // before the first entry: its tempo runs backwards
  assert.equal(beatsFromSeconds(TEMPO, 6), 10);
  assert.equal(beatsFromSeconds(TEMPO, 3), 6);
  assert.equal(beatsFromSeconds(TEMPO, 5.5), 9.5);
  assert.equal(beatsFromSeconds(TEMPO, -1), -2);
  // An empty map, and a zero bpm, both fall back to 120.
  assert.equal(secondsFromBeats([], 4), 2);
  assert.equal(beatsFromSeconds([], 2), 4);
  assert.equal(secondsFromBeats([{ ...TEMPO[0], bpm: 0 }], 4), 2);
  // Awkward tempos, captured the same way. The delegated path multiplies by
  // 60/bpm (the scalar beatClock has always used) where the old inline code
  // wrote (x*60)/bpm, so these agree to within an ulp, not bit-for-bit.
  const U: TempoEntry[] = [
    { timeSec: 0, timeBeats: 0, timeTicks: 0, bpm: 90, secPerBeat: 60 / 90, measure: 0, interpolateToNext: false },
    { timeSec: 7.5, timeBeats: 11, timeTicks: 5280, bpm: 133, secPerBeat: 60 / 133, measure: 3, interpolateToNext: true },
  ];
  // 3 * (60/90) lands on exactly 2 by rounding luck, so these two use near():
  // a future reassociation must not fail them for the wrong reason.
  near(secondsFromBeats(U, 3), 2, 1e-12);
  assert.equal(secondsFromBeats(U, 11), 7.5); // authoritative timeSec, exact by construction
  near(secondsFromBeats(U, 13.75), 8.740601503759398, 1e-12);
  near(secondsFromBeats(U, 100), 47.650375939849624, 1e-12);
  near(secondsFromBeats(U, -2.5), -1.6666666666666667, 1e-12);
  near(beatsFromSeconds(U, 2), 3, 1e-12); // 2 / (60/90) is exact only by luck
  assert.equal(beatsFromSeconds(U, 7.5), 11); // authoritative timeSec, exact by construction
  near(beatsFromSeconds(U, 9.25), 14.879166666666666, 1e-12);
  near(beatsFromSeconds(U, 40), 83.04166666666667, 1e-12);
  near(beatsFromSeconds(U, -1), -1.5, 1e-12);
}

// --- normalization is cached per input ARRAY IDENTITY ------------------------
// The contract that makes the cache safe: a map handed to the module is
// immutable. Change the tempo by passing a NEW array.
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }, { beat: 32, bpm: 174 }];
  const first = normalizeTempoMap(map);
  assert.equal(normalizeTempoMap(map), first, 'same array -> same normalized points');
  assert.notEqual(normalizeTempoMap([...map]), first, 'a new array normalizes again');
  // Cached points are frozen, so a caller cannot corrupt another caller's map.
  assert.ok(Object.isFrozen(first));
  assert.throws(() => (first as TempoPoint[]).push(first[0]));
  // Mutating in place is the unsupported input: the cache keeps serving the old shape.
  map.push({ beat: 48, bpm: 60 });
  assert.equal(getTempoAtBeat(map, 50), 174);
  assert.equal(getTempoAtBeat([...map], 50), 60);
  map.pop();
  // The seeded default never allocates either.
  assert.equal(normalizeTempoMap(null), normalizeTempoMap(undefined));
  assert.equal(normalizeTempoMap([{ beat: 0, bpm: -1 }]), normalizeTempoMap(null));
  // Hammering a cached map stays correct.
  for (let i = 0; i < 10000; i += 1) {
    assert.equal(getTempoAtBeat(map, 15.999), 120);
    assert.equal(getTempoAtBeat(map, 16), 90);
    assert.equal(getTempoAtBeat(map, 1e6), 174);
  }
}

// --- and the conversions binary-search, so a big map stays cheap -------------
// The SCORE highway converts once per chart event. Before the cache + binary
// search, 20 000 conversions over a 500-event map took ~600 ms; it is ~2 ms
// now. The bound is deliberately loose (100x headroom over the measurement, 6x
// under the regression it guards) so it cannot flake on a busy machine.
{
  const big: TempoEvent[] = [];
  for (let i = 0; i < 500; i += 1) big.push({ beat: i * 4, bpm: 60 + ((i * 37) % 180) });
  beatToTime(big, 0); // warm the cache, as any real caller does
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < 20000; i += 1) sink += beatToTime(big, (i / 20000) * 2000);
  const elapsed = performance.now() - t0;
  assert.ok(Number.isFinite(sink));
  assert.ok(elapsed < 200, `20 000 beatToTime calls over 500 events took ${elapsed.toFixed(1)} ms`);
}

// --- correctness sweep against a plain reference implementation --------------
{
  const events: TempoEvent[] = [];
  for (let i = 0; i < 200; i += 1) events.push({ beat: i * 3, bpm: 40 + ((i * 53) % 240) });
  // The reference: integrate forwards, then scan linearly. No cache, no search.
  const ref: { beat: number; timeSec: number; secPerBeat: number }[] = [];
  for (const e of events) {
    const secPerBeat = 60 / e.bpm;
    const prev = ref[ref.length - 1];
    ref.push({ beat: e.beat, timeSec: prev ? prev.timeSec + (e.beat - prev.beat) * prev.secPerBeat : e.beat * secPerBeat, secPerBeat });
  }
  const refBeatToTime = (beat: number): number => {
    let i = 0;
    while (i + 1 < ref.length && ref[i + 1].beat <= beat) i += 1;
    return ref[i].timeSec + (beat - ref[i].beat) * ref[i].secPerBeat;
  };
  const refTimeToBeat = (sec: number): number => {
    let i = 0;
    while (i + 1 < ref.length && ref[i + 1].timeSec <= sec) i += 1;
    return ref[i].beat + (sec - ref[i].timeSec) / ref[i].secPerBeat;
  };
  const lastBeat = ref[ref.length - 1].beat;
  const lastSec = ref[ref.length - 1].timeSec;
  for (let i = 0; i < 2000; i += 1) {
    // Spread over the whole map and a little past both ends.
    const beat = -12 + (i / 1999) * (lastBeat + 24);
    assert.equal(beatToTime(events, beat), refBeatToTime(beat), `beatToTime(${beat})`);
    const sec = -6 + (i / 1999) * (lastSec + 12);
    assert.equal(timeToBeat(events, sec), refTimeToBeat(sec), `timeToBeat(${sec})`);
  }
  // Every event boundary exactly, where the search picks a side.
  for (const e of events) {
    for (const beat of [e.beat - 1e-9, e.beat, e.beat + 1e-9]) {
      assert.equal(beatToTime(events, beat), refBeatToTime(beat), `boundary beatToTime(${beat})`);
    }
  }
}

/* ========================= tempo ramps ==================================== */

/**
 * The reference the closed form is checked against: Simpson's rule on
 * `60 / bpm(b)` with the bpm interpolated linearly in BEATS. Nothing about the
 * implementation is reused here — it is the definition of the integral, and
 * nothing else, so agreement is evidence and not a tautology.
 */
function integrateRamp(b0: number, v0: number, b1: number, v1: number, beat: number, steps = 20000): number {
  const bpmAt = (u: number): number => v0 + ((v1 - v0) * (u - b0)) / (b1 - b0);
  const f = (u: number): number => 60 / bpmAt(u);
  const n = steps % 2 === 0 ? steps : steps + 1;
  const h = (beat - b0) / n;
  if (h === 0) return 0;
  let sum = f(b0) + f(beat);
  for (let i = 1; i < n; i += 1) sum += f(b0 + i * h) * (i % 2 === 1 ? 4 : 2);
  return (h / 3) * sum;
}

// The closed form IS the integral: 1e-6 against numeric integration, over
// ramps up, down, shallow and steep, sampled all the way across each segment.
{
  const ramps: [number, number, number, number][] = [
    [0, 120, 16, 90],     // down
    [0, 90, 16, 174],     // up
    [0, 128, 32, 128.5],  // shallow: the case a naive ln(v1/v0) loses to cancellation
    [0, 20, 8, 300],      // the whole clamp range in eight beats
    [4, 174, 12, 60],     // not starting at beat 0
  ];
  for (const [b0, v0, b1, v1] of ramps) {
    const map: TempoEvent[] = [{ beat: b0, bpm: v0, curve: 'linear' }, { beat: b1, bpm: v1 }];
    const t0 = beatToTime(map, b0);
    for (let i = 0; i <= 40; i += 1) {
      const beat = b0 + ((b1 - b0) * i) / 40;
      const want = t0 + integrateRamp(b0, v0, b1, v1, beat);
      const got = beatToTime(map, beat);
      assert.ok(Math.abs(got - want) < 1e-6, `ramp ${v0}->${v1} at beat ${beat}: ${got} !~ ${want}`);
      // ... and the inverse lands back on the beat it came from.
      near(timeToBeat(map, got), beat, 1e-9);
    }
    // The far end of the ramp is the next event's own seconds, so the segment
    // after it starts exactly where the ramp stopped — no seam.
    near(beatToTime(map, b1), t0 + integrateRamp(b0, v0, b1, v1, b1), 1e-6);
  }
}

// A ramp is strictly monotonic in both directions, and the tempo it reports
// walks linearly from one event to the next.
{
  const map: TempoEvent[] = [{ beat: 0, bpm: 90, curve: 'linear' }, { beat: 16, bpm: 174 }, { beat: 32, bpm: 60 }];
  let prevSec = -Infinity;
  let prevBeat = -Infinity;
  for (let i = 0; i <= 2000; i += 1) {
    const beat = -8 + (i / 2000) * 56;
    const sec = beatToTime(map, beat);
    assert.ok(sec > prevSec, `beatToTime must rise: ${sec} after ${prevSec} at beat ${beat}`);
    prevSec = sec;
    const back = timeToBeat(map, -4 + (i / 2000) * 40);
    assert.ok(back > prevBeat, `timeToBeat must rise: ${back} after ${prevBeat}`);
    prevBeat = back;
  }
  // bpm(b) = v0 + k·Δb over the ramp; the step segment after it holds.
  assert.equal(getTempoAtBeat(map, 0), 90);
  assert.equal(getTempoAtBeat(map, 8), 132); // halfway between 90 and 174
  near(getTempoAtBeat(map, 4), 90 + 84 * 0.25);
  assert.equal(getTempoAtBeat(map, 16), 174); // the event owns its own beat
  assert.equal(getTempoAtBeat(map, 24), 174); // step: it holds
  assert.equal(getTempoAtBeat(map, 32), 60);
  assert.equal(getTempoAtBeat(map, 1e6), 60); // the last event has nothing to ramp to
  assert.equal(getSecPerBeatAt(map, 8), 60 / 132);
  assert.equal(getSecPerBeatAt(map, 24), 60 / 174);
  // In FRONT of the first event a ramp does not run backwards: its start tempo
  // extends, exactly as a step event's always has.
  assert.equal(getTempoAtBeat(map, -4), 90);
  assert.equal(beatToTime(map, -4), beatToTime([{ beat: 0, bpm: 90 }], -4));
}

// A ramp changes NOTHING for a map that does not use one, and the shapes that
// cannot ramp fall back to a step bit-for-bit.
{
  const step: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }, { beat: 32, bpm: 174 }];
  const spelled: TempoEvent[] = step.map((e) => ({ ...e, curve: 'step' as const }));
  // A 'linear' LAST event: nothing to ramp to.
  const lastLinear: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 90 }, { beat: 32, bpm: 174, curve: 'linear' }];
  // A 'linear' event whose next tempo is the SAME: k = 0, so the integral is
  // the plain product — and must be the very same float, not merely close.
  const flat: TempoEvent[] = [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 120 }];
  const flatStep: TempoEvent[] = [{ beat: 0, bpm: 120 }, { beat: 16, bpm: 120 }];
  for (const b of [-4, 0, 1 / 3, 7.5, 16, 23.75, 32, 40.125, 1e4]) {
    assert.equal(beatToTime(spelled, b), beatToTime(step, b), `explicit 'step' at ${b}`);
    assert.equal(beatToTime(lastLinear, b), beatToTime(step, b), `trailing 'linear' at ${b}`);
    assert.equal(beatToTime(flat, b), beatToTime(flatStep, b), `zero-slope ramp at ${b}`);
    assert.equal(getTempoAtBeat(flat, b), getTempoAtBeat(flatStep, b));
  }
  for (const s of [-2, 0, 0.75, 8, 12.5, 20, 1e3]) {
    assert.equal(timeToBeat(spelled, s), timeToBeat(step, s));
    assert.equal(timeToBeat(lastLinear, s), timeToBeat(step, s));
    assert.equal(timeToBeat(flat, s), timeToBeat(flatStep, s));
  }
  // The normalized shape says it too: a step segment's slope is 0.
  assert.deepEqual(normalizeTempoMap(spelled).map((p) => p.slope), [0, 0, 0]);
  assert.deepEqual(normalizeTempoMap(lastLinear).map((p) => p.slope), [0, 0, 0]);
  assert.deepEqual(normalizeTempoMap(flat).map((p) => p.slope), [0, 0]);
  assert.deepEqual(normalizeTempoMap([{ beat: 0, bpm: 90, curve: 'linear' }, { beat: 16, bpm: 174 }]).map((p) => p.slope), [84 / 16, 0]);
}

// Ramps do not defeat the identity cache, and normalizing one still costs once.
{
  const ramp: TempoEvent[] = [{ beat: 0, bpm: 90, curve: 'linear' }, { beat: 32, bpm: 150 }];
  const first = normalizeTempoMap(ramp);
  assert.equal(normalizeTempoMap(ramp), first, 'same array -> same normalized points');
  assert.notEqual(normalizeTempoMap([...ramp]), first, 'a new array normalizes again');
  assert.ok(Object.isFrozen(first));
  assert.ok(Object.isFrozen(first[0]));
  beatToTime(ramp, 0);
  const t0 = performance.now();
  let sink = 0;
  for (let i = 0; i < 20000; i += 1) sink += beatToTime(ramp, (i / 20000) * 32);
  const elapsed = performance.now() - t0;
  assert.ok(Number.isFinite(sink));
  // Reported, never asserted: a wall clock on a machine running three other
  // suites at once measures the machine, not the code. What IS asserted is the
  // thing that would make it slow — the cache still returning one array above.
  console.info(`  tempoMap: 20 000 ramped beatToTime calls in ${elapsed.toFixed(1)} ms`);
}

/* ===================== remapOnTempoChange ================================= */
{
  const prev: TempoEvent[] = [{ beat: 0, bpm: 120 }];
  const next: TempoEvent[] = [{ beat: 0, bpm: 60 }];
  // Beat-anchored items move to their beat's new seconds; second-anchored ones
  // (no `beat`) do not move at all.
  assert.deepEqual(
    remapOnTempoChange(prev, next, [{ beat: 0, sec: 0 }, { beat: 4, sec: 2 }, { sec: 2 }, { beat: 8, sec: 4 }]),
    [0, 4, 2, 8],
  );
  // A halved tempo doubles every musical position, and nothing else.
  assert.deepEqual(remapOnTempoChange(prev, next, []), []);
  // An unchanged map moves nothing — the same array, or one that normalizes the
  // same way (both empty maps are the seeded 120 default).
  assert.deepEqual(remapOnTempoChange(prev, prev, [{ beat: 4, sec: 999 }]), [999]);
  assert.deepEqual(remapOnTempoChange([], null, [{ beat: 4, sec: 999 }]), [999]);
  // ... and two DISTINCT arrays with equal content are an unchanged map too.
  // This is the undo-back-onto-the-same-tempo case: identity differs, so only a
  // point-by-point comparison can stop every clip being nudged by a rounding
  // error. `sec: 999` is deliberately not where beat 4 is — a recomputation
  // would return 2 and be caught here.
  const twin: TempoEvent[] = [{ beat: 0, bpm: 120 }];
  assert.notEqual(twin as unknown, prev as unknown);
  assert.notEqual(normalizeTempoMap(twin), normalizeTempoMap(prev), 'distinct arrays normalize to distinct objects');
  assert.deepEqual(remapOnTempoChange(prev, twin, [{ beat: 4, sec: 999 }, { sec: 7 }]), [999, 7]);
  // A ramp map rebuilt event-for-event is the same map as well, curve included.
  const rampA: TempoEvent[] = [{ beat: 0, bpm: 90, curve: 'linear' }, { beat: 16, bpm: 174 }];
  const rampB: TempoEvent[] = [{ beat: 0, bpm: 90, curve: 'linear' }, { beat: 16, bpm: 174 }];
  assert.deepEqual(remapOnTempoChange(rampA, rampB, [{ beat: 8, sec: 999 }]), [999]);
  // But a real difference — even only in the CURVE — does move things.
  const stepped: TempoEvent[] = [{ beat: 0, bpm: 90 }, { beat: 16, bpm: 174 }];
  assert.deepEqual(
    remapOnTempoChange(rampA, stepped, [{ beat: 8, sec: beatToTime(rampA, 8) }]),
    [beatToTime(stepped, 8)],
  );
  assert.notEqual(beatToTime(rampA, 8), beatToTime(stepped, 8), 'the ramp and the step really do differ at beat 8');
  // A junk beat is not a musical anchor: the item keeps its seconds.
  assert.deepEqual(remapOnTempoChange(prev, next, [{ beat: Number.NaN, sec: 3 }]), [3]);
  // Into and out of a ramp: the remapped seconds are exactly `beatToTime(next)`.
  const ramped: TempoEvent[] = [{ beat: 0, bpm: 120, curve: 'linear' }, { beat: 16, bpm: 60 }, { beat: 32, bpm: 174 }];
  const beats = [0, 3.5, 16, 24, 40];
  assert.deepEqual(
    remapOnTempoChange(prev, ramped, beats.map((beat) => ({ beat, sec: beatToTime(prev, beat) }))),
    beats.map((beat) => beatToTime(ramped, beat)),
  );
  // ... and remapping BACK returns the original seconds, so the helper is the
  // inverse of itself across a pair of maps.
  assert.deepEqual(
    remapOnTempoChange(ramped, prev, beats.map((beat) => ({ beat, sec: beatToTime(ramped, beat) }))),
    beats.map((beat) => beatToTime(prev, beat)),
  );
}

console.log('tempoMap: ok');
