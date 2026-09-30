// Run with: npx tsx src/lib/roundTripLatency.test.ts
//
// The loopback estimator, driven entirely by synthetic captures: a probe is
// generated, delayed by a KNOWN number of samples, then degraded the way a real
// microphone degrades it — attenuated, noisy, clipped, or absent — and the
// estimator has to come back with that same delay, or say it does not know.
//
// The load-bearing assertions:
//   - a delayed copy is found to the sample, whatever its level;
//   - nothing to find (silence, or noise with no probe in it) is reported as
//     confidence ~0 rather than as a confident wrong answer;
//   - a lag outside the searched window is never reported as if it were inside;
//   - `roundTripMs` splits the measured loop and falls back to the declared
//     halves when there is no measurement.
import assert from 'node:assert/strict';

import {
  CLICK_OFFSETS,
  DEFAULT_MAX_LAG_SEC,
  EARLY_PEAK_FRACTION,
  MAX_LAG_CAP_SEC,
  MIN_USABLE_CONFIDENCE,
  PROBE_DEFAULT_DURATION_SEC,
  PROBE_PEAK,
  estimateOffset,
  makeProbe,
  roundTripMs,
} from './roundTripLatency.ts';

const near = (a: number, b: number, eps: number, what = ''): void =>
  assert.ok(Math.abs(a - b) <= eps, `${what} ${a} != ${b} (±${eps})`);

/** mulberry32 — a seeded PRNG, so every "noisy" case below is the SAME noise on
 *  every run. A flaky estimator test is worse than no test. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A capture holding `probe` at `lagSamples`, scaled by `gain`, on `noise` of
 *  the given amplitude, with `tailSec` of room after it. */
function capture(
  probe: Float32Array,
  sampleRate: number,
  lagSamples: number,
  opts: { gain?: number; noise?: number; seed?: number; tailSec?: number; clipAt?: number } = {},
): Float32Array {
  const { gain = 1, noise = 0, seed = 7, tailSec = 0.2, clipAt = Infinity } = opts;
  const n = lagSamples + probe.length + Math.round(sampleRate * tailSec);
  const out = new Float32Array(n);
  const rand = rng(seed);
  for (let i = 0; i < n; i += 1) out[i] = noise > 0 ? (rand() * 2 - 1) * noise : 0;
  for (let i = 0; i < probe.length; i += 1) out[lagSamples + i] += probe[i] * gain;
  if (Number.isFinite(clipAt)) {
    for (let i = 0; i < n; i += 1) {
      if (out[i] > clipAt) out[i] = clipAt;
      else if (out[i] < -clipAt) out[i] = -clipAt;
    }
  }
  return out;
}

const SR = 48000;
/** Short probes keep the O(n·lag) correlation inside a test's patience. */
const TEST_PROBE_SEC = 0.05;
const TEST_MAX_LAG_SEC = 0.05;

/* --------------------------------- makeProbe -------------------------------- */

{
  const chirp = makeProbe(SR, { kind: 'chirp', durationSec: 0.25 });
  assert.equal(chirp.length, Math.round(SR * 0.25), 'the probe is exactly as long as asked');
  assert.ok(chirp.every((v) => Number.isFinite(v)), 'every sample is a number');
  let peak = 0;
  for (const v of chirp) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak <= PROBE_PEAK + 1e-6, `peak ${peak} must stay at or under ${PROBE_PEAK}`);
  assert.ok(peak > PROBE_PEAK * 0.9, 'and must actually reach it, or the SNR is thrown away');
  // Faded at both ends: a step into a sweep is a click through the speakers.
  near(chirp[0], 0, 1e-6, 'chirp starts silent');
  near(chirp[chirp.length - 1], 0, 1e-6, 'chirp ends silent');
  // A sweep has no DC to bias the correlation with.
  let sum = 0;
  for (const v of chirp) sum += v;
  assert.ok(Math.abs(sum / chirp.length) < 0.02, 'the chirp is centred');

  // The default kind and duration.
  const dflt = makeProbe(SR);
  assert.equal(dflt.length, Math.round(SR * PROBE_DEFAULT_DURATION_SEC));

  const clicks = makeProbe(SR, { kind: 'clicks', durationSec: 0.25 });
  assert.equal(clicks.length, Math.round(SR * 0.25));
  // A burst at every offset...
  const energyAt = (from: number, len: number): number => {
    let e = 0;
    for (let i = from; i < Math.min(clicks.length, from + len); i += 1) e += clicks[i] * clicks[i];
    return e;
  };
  for (const off of CLICK_OFFSETS) {
    const at = Math.round(off * clicks.length);
    assert.ok(energyAt(at, Math.round(SR * 0.003)) > 0, `a burst at offset ${off}`);
  }
  // ...and silence between them.
  for (let k = 1; k < CLICK_OFFSETS.length; k += 1) {
    const mid = Math.round(((CLICK_OFFSETS[k - 1] + CLICK_OFFSETS[k]) / 2) * clicks.length);
    assert.equal(clicks[mid], 0, `silence between offsets ${k - 1} and ${k}`);
  }
  // Irregular spacing is the whole point — equal spacing makes the correlation
  // ambiguous at multiples of the period.
  const gaps = CLICK_OFFSETS.slice(1).map((o, i) => o - CLICK_OFFSETS[i]);
  assert.ok(new Set(gaps.map((g) => g.toFixed(4))).size > 1, 'the clicks are NOT evenly spaced');

  // Nonsense in, empty out — never NaN.
  assert.equal(makeProbe(0).length, 0);
  assert.equal(makeProbe(Number.NaN).length, 0);
  assert.equal(makeProbe(SR, { durationSec: 0 }).length, 0);
  assert.equal(makeProbe(SR, { durationSec: -1 }).length, 0);
}

/* ------------------------------- a clean loop ------------------------------- */

{
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const lag = 1234;
  const cap = capture(probe, SR, lag, {});
  const r = estimateOffset(probe, cap, SR, { maxLagSec: TEST_MAX_LAG_SEC });
  assert.equal(r.lagSamples, lag, 'a clean delayed copy is found to the sample');
  near(r.lagSec, lag / SR, 1e-9, 'lagSec agrees with lagSamples');
  assert.ok(r.confidence > 0.9, `a perfect loop is confident, got ${r.confidence}`);
  assert.ok(r.peak > 0.99, `and correlates at ~1, got ${r.peak}`);
  assert.ok(r.peakRatio > 4, `with a peak that stands well clear, got ${r.peakRatio}`);
  assert.equal(r.clippedFraction, 0, 'nothing clipped');
}

/* ------------------------------ zero lag is a lag --------------------------- */

{
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const cap = capture(probe, SR, 0, {});
  const r = estimateOffset(probe, cap, SR, { maxLagSec: TEST_MAX_LAG_SEC });
  assert.equal(r.lagSamples, 0, 'an undelayed capture is lag 0, not "not found"');
  assert.ok(r.confidence > 0.9);
}

/* --------------------------------- attenuated ------------------------------- */

{
  // A quiet mic 26 dB down still carries the same delay.
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const lag = 900;
  const r = estimateOffset(probe, capture(probe, SR, lag, { gain: 0.05 }), SR, {
    maxLagSec: TEST_MAX_LAG_SEC,
  });
  assert.equal(r.lagSamples, lag, 'level does not move the peak — the correlation is normalized');
  assert.ok(r.confidence > 0.9, `a quiet but clean loop is still confident, got ${r.confidence}`);
}

/* ----------------------------------- noisy ---------------------------------- */

{
  // Room noise at a third of the probe's own peak.
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const lag = 2001;
  const r = estimateOffset(probe, capture(probe, SR, lag, { gain: 0.4, noise: 0.15, seed: 11 }), SR, {
    maxLagSec: TEST_MAX_LAG_SEC,
  });
  near(r.lagSamples, lag, 2, 'a noisy loop lands within two samples');
  assert.ok(
    r.confidence >= MIN_USABLE_CONFIDENCE,
    `a noisy but real loop stays usable, got ${r.confidence}`,
  );
}

/* --------------------------------- clipping --------------------------------- */

{
  // The input is 12 dB too hot and the converter squares off the peaks.
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const lag = 777;
  const cap = capture(probe, SR, lag, { gain: 4, clipAt: 1 });
  const r = estimateOffset(probe, cap, SR, { maxLagSec: TEST_MAX_LAG_SEC });
  near(r.lagSamples, lag, 1, 'a clipped capture still carries its delay');
  assert.ok(r.clippedFraction > 0.001, `clipping is reported, got ${r.clippedFraction}`);
  assert.ok(r.confidence > 0.5, 'and is a warning, not a failure');
}

/* ------------------------------ echo / multipath ---------------------------- */

{
  // The microphone sits on a desk: it hears the speaker directly, and again off
  // the surface 1.5 ms later. With the mic close to the surface the REFLECTION
  // is the louder of the two, so the largest correlation is the late one — and
  // taking it would bias every take 1.5 ms late, every time.
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const direct = 1600;
  const echo = direct + Math.round(SR * 0.0015);
  const withEcho = (directGain: number, echoGain: number): Float32Array => {
    const out = capture(probe, SR, direct, { gain: directGain, noise: 0.01, seed: 21 });
    for (let i = 0; i < probe.length; i += 1) out[echo + i] += probe[i] * echoGain;
    return out;
  };

  const r = estimateOffset(probe, withEcho(0.4, 0.42), SR, { maxLagSec: TEST_MAX_LAG_SEC });
  assert.equal(r.lagSamples, direct, 'the DIRECT path is the answer, not the louder reflection');
  assert.ok(r.lagSamples < echo, 'the late arrival would have biased every take, not just this one');
  assert.ok(r.confidence > 0.5, `and it is still a measurement, got ${r.confidence}`);

  // The honest boundary of the rule: the earlier arrival has to be worth at
  // least EARLY_PEAK_FRACTION of the peak. A reflection that swamps the direct
  // path — a microphone pressed against a hard surface — is NOT recovered, and
  // this pins that rather than leaving it to be discovered in the field.
  assert.equal(
    estimateOffset(probe, withEcho(0.4, 0.7), SR, { maxLagSec: TEST_MAX_LAG_SEC }).lagSamples,
    echo,
    `an echo far above ${EARLY_PEAK_FRACTION}x the direct path still wins — move the mic`,
  );

  // A reflection QUIETER than the direct path changes nothing — the peak was
  // already the right arrival.
  assert.equal(
    estimateOffset(probe, withEcho(0.5, 0.2), SR, { maxLagSec: TEST_MAX_LAG_SEC }).lagSamples,
    direct,
    'a quiet reflection is simply ignored',
  );

  // The preference must not fire on a CLEAN single arrival: the rising shoulder
  // of the peak's own lobe clears 0.9·peak a sample early, and treating that as
  // an earlier arrival would drag every measurement forward.
  for (const lag of [500, 1234, 2222]) {
    assert.equal(
      estimateOffset(probe, capture(probe, SR, lag, {}), SR, { maxLagSec: TEST_MAX_LAG_SEC }).lagSamples,
      lag,
      `a single clean arrival at ${lag} is reported exactly, not a lobe-width early`,
    );
  }
}

/* -------------------------------- no capture -------------------------------- */

{
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  // Dead silence — a muted input, or the wrong device.
  const silent = new Float32Array(probe.length + SR * 0.1);
  const r = estimateOffset(probe, silent, SR, { maxLagSec: TEST_MAX_LAG_SEC });
  assert.equal(r.confidence, 0, 'silence is not a measurement');
  assert.equal(r.lagSec, 0, 'and reports no lag rather than an arbitrary one');

  // Noise with no probe anywhere in it — the mic is open but hears nothing of ours.
  const rand = rng(3);
  const noise = new Float32Array(probe.length + Math.round(SR * TEST_MAX_LAG_SEC));
  for (let i = 0; i < noise.length; i += 1) noise[i] = (rand() * 2 - 1) * 0.2;
  const r2 = estimateOffset(probe, noise, SR, { maxLagSec: TEST_MAX_LAG_SEC });
  assert.ok(
    r2.confidence < MIN_USABLE_CONFIDENCE,
    `noise alone must not look like a measurement, got ${r2.confidence}`,
  );
}

/* ------------------------------ nothing to search --------------------------- */

{
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  // A capture shorter than the probe: the reference never fits, so there is no
  // lag to report.
  const short = new Float32Array(probe.length - 10);
  const r = estimateOffset(probe, short, SR, { maxLagSec: TEST_MAX_LAG_SEC });
  assert.equal(r.confidence, 0);
  assert.equal(r.lagSec, 0);
  assert.equal(r.searchedLags, 0);

  // An empty reference is no reference.
  assert.equal(estimateOffset(new Float32Array(0), short, SR).confidence, 0);
  // A nonsense sample rate cannot produce a time.
  assert.equal(estimateOffset(probe, short, 0).confidence, 0);
}

/* ------------------------- a lag outside the window ------------------------- */

{
  const probe = makeProbe(SR, { durationSec: TEST_PROBE_SEC });
  const maxLagSec = 0.01;
  const maxLagSamples = Math.round(SR * maxLagSec);
  // The true delay is five times the window: whatever comes back, it must not
  // be reported as a confident answer inside a window that cannot hold it.
  const r = estimateOffset(probe, capture(probe, SR, maxLagSamples * 5, {}), SR, { maxLagSec });
  assert.ok(r.lagSamples <= maxLagSamples, 'the answer never leaves the searched window');
  assert.ok(
    r.confidence < MIN_USABLE_CONFIDENCE,
    `a probe that is not in the window is not a measurement, got ${r.confidence}`,
  );
}

/* ------------------------------ the lag window ------------------------------ */

{
  const probe = makeProbe(SR, { durationSec: 0.01 });
  const cap = new Float32Array(SR * 2);
  // Asking for more than the cap searches the cap, not the ask.
  const r = estimateOffset(probe, cap, SR, { maxLagSec: 99 });
  assert.ok(
    r.searchedLags <= Math.round(SR * MAX_LAG_CAP_SEC) + 1,
    `maxLagSec is capped at ${MAX_LAG_CAP_SEC} s — the correlation is O(n·lag)`,
  );
  // And the default is the default.
  assert.ok(DEFAULT_MAX_LAG_SEC > 0 && DEFAULT_MAX_LAG_SEC <= MAX_LAG_CAP_SEC);
}

/* -------------------------------- clicks kind ------------------------------- */

{
  const probe = makeProbe(SR, { kind: 'clicks', durationSec: 0.12 });
  const lag = 1500;
  const r = estimateOffset(probe, capture(probe, SR, lag, { gain: 0.5, noise: 0.02, seed: 5 }), SR, {
    maxLagSec: 0.05,
  });
  assert.equal(r.lagSamples, lag, 'the click train correlates as sharply as the chirp');
  assert.ok(r.confidence > 0.8);
}

/* -------------------------------- roundTripMs ------------------------------- */

{
  // 40 ms measured, of which the mixer already declares 8 ms of chain latency.
  const s = roundTripMs(0.04, 0.008, 0.005);
  near(s.totalMs, 40, 1e-9);
  near(s.outputMs, 8, 1e-9);
  near(s.inputMs, 32, 1e-9, 'the rest of the loop is the input side');
  near(s.compMs, 40, 1e-9, 'placement removes the WHOLE loop, not half of it');
  assert.equal(s.estimated, false);

  // A declared output latency larger than the whole measured loop cannot make
  // the input side negative.
  const s2 = roundTripMs(0.004, 0.02, 0.005);
  near(s2.totalMs, 4, 1e-9);
  near(s2.inputMs, 0, 1e-9);
  near(s2.compMs, 4, 1e-9, 'the MEASUREMENT still wins — it is the real loop');

  // No measurement: fall back to the two declared halves and say so.
  const s3 = roundTripMs(Number.NaN, 0.008, 0.005);
  assert.equal(s3.estimated, true);
  near(s3.totalMs, 13, 1e-9);
  near(s3.compMs, 13, 1e-9);
  near(s3.outputMs, 8, 1e-9);
  near(s3.inputMs, 5, 1e-9);

  // A negative lag is not a round trip.
  const s4 = roundTripMs(-0.01, 0.008, 0.005);
  assert.equal(s4.estimated, true);
  near(s4.totalMs, 13, 1e-9);

  // Nonsense on the declared side degrades to zero, never to NaN.
  const s5 = roundTripMs(0.02, Number.NaN, Number.NaN);
  near(s5.totalMs, 20, 1e-9);
  near(s5.outputMs, 0, 1e-9);
  near(s5.inputMs, 20, 1e-9);
  assert.equal(s5.estimated, false);
  const s6 = roundTripMs(Number.NaN, Number.NaN, Number.NaN);
  near(s6.totalMs, 0, 1e-9);
  assert.equal(s6.estimated, true);
}

console.log('roundTripLatency tests passed');
