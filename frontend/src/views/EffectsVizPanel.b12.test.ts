/**
 * EffectsVizPanel's real frequency-response math (FE-022).
 *
 * `parametric_eq` is the only MIX rack effect whose entire signal chain is
 * one biquad topology this file can reconstruct exactly (three
 * `BiquadFilterNode`s in series — see `makeParametricEq` in
 * `lib/rackEffects.ts:1469-1505`: a fixed 120 Hz low shelf, a `Q=1` peaking
 * filter swept by `midFreq`, a fixed 6000 Hz high shelf). The coefficient
 * formulas below are the Web Audio API's own normative ones (Audio EQ
 * Cookbook, R. Bristow-Johnson — the spec cites it verbatim for
 * `BiquadFilterNode`'s characteristics), not an approximation, so this test
 * checks the SAME response `BiquadFilterNode.getFrequencyResponse()` would
 * report for that exact node graph.
 *
 * Run: `npx tsx src/views/EffectsVizPanel.b12.test.ts`
 */
import assert from 'node:assert/strict';
import {
  biquadMagnitudeDb,
  buildEqCurvePath,
  buildFlatCurvePath,
  hasRealResponse,
  parametricEqResponseDb,
  peakingCoeffs,
  shelfCoeffs,
} from './EffectsVizPanel.tsx';

const closeTo = (actual: number, expected: number, eps: number, msg: string) => {
  assert.ok(
    Math.abs(actual - expected) <= eps,
    `${msg}: expected ${actual} to be within ${eps} of ${expected}`,
  );
};

// ── biquadMagnitudeDb: a unity (all-zero-gain) filter is flat 0 dB ─────────
{
  // A peaking filter with 0 dB gain has A = 10^0 = 1, which collapses its
  // coefficients to the identity transfer function (b == a term for term).
  const c = peakingCoeffs(1000, 0, 1, 44100);
  closeTo(biquadMagnitudeDb(c, 100, 44100), 0, 1e-9, 'unity peaking at 100 Hz');
  closeTo(biquadMagnitudeDb(c, 1000, 44100), 0, 1e-9, 'unity peaking at 1000 Hz (center)');
  closeTo(biquadMagnitudeDb(c, 15000, 44100), 0, 1e-9, 'unity peaking at 15000 Hz');
}

// ── peakingCoeffs: the peaking filter's defining property is that its gain
// AT the center frequency is exactly dBgain — that is what "Q" is normalized
// against in the cookbook (mixReference: RBJ cookbook peakingEQ). ──────────
{
  const c = peakingCoeffs(1000, 6, 1, 44100);
  closeTo(biquadMagnitudeDb(c, 1000, 44100), 6, 0.05, 'peaking +6 dB at its own center frequency');
  // Far from the center the filter converges back toward 0 dB.
  closeTo(biquadMagnitudeDb(c, 50, 44100), 0, 0.5, 'peaking +6 dB is flat far below its center');
  closeTo(biquadMagnitudeDb(c, 18000, 44100), 0, 0.5, 'peaking +6 dB is flat far above its center');
}

// ── shelfCoeffs: a low shelf boosts low frequencies and settles to 0 dB well
// above its corner; a high shelf is the mirror image. ──────────────────────
{
  const low = shelfCoeffs('lowshelf', 120, 6, 44100);
  closeTo(biquadMagnitudeDb(low, 20, 44100), 6, 0.6, 'low shelf +6 dB is fully boosted well below 120 Hz');
  closeTo(biquadMagnitudeDb(low, 15000, 44100), 0, 0.2, 'low shelf +6 dB is flat well above 120 Hz');

  const high = shelfCoeffs('highshelf', 6000, 6, 44100);
  closeTo(biquadMagnitudeDb(high, 20, 44100), 0, 0.2, 'high shelf +6 dB is flat well below 6000 Hz');
  closeTo(biquadMagnitudeDb(high, 18000, 44100), 6, 0.6, 'high shelf +6 dB is fully boosted well above 6000 Hz');
}

// ── parametricEqResponseDb: the three bands sum in dB (series filters
// multiply in linear magnitude, which is addition in the log domain) ───────
{
  const flat = parametricEqResponseDb({ low: 0, midFreq: 1000, mid: 0, high: 0 }, 1000);
  closeTo(flat, 0, 1e-9, 'every band at 0 dB gain is a flat unity chain');

  const boosted = parametricEqResponseDb({ low: 3, midFreq: 2000, mid: 4, high: 2 }, 2000);
  // At exactly the mid band's own center frequency, the low and high shelves
  // have each mostly settled (2000 Hz is well above the 120 Hz low shelf and
  // well below the 6000 Hz high shelf), so the total is close to (but not
  // required to be exactly) the mid band's own +4 dB alone plus whatever the
  // shelves still contribute at 2000 Hz — checked against the same math the
  // component draws, not a hand-picked number.
  const midOnly = parametricEqResponseDb({ low: 0, midFreq: 2000, mid: 4, high: 0 }, 2000);
  const lowAt2k = parametricEqResponseDb({ low: 3, midFreq: 2000, mid: 0, high: 0 }, 2000);
  const highAt2k = parametricEqResponseDb({ low: 0, midFreq: 2000, mid: 0, high: 2 }, 2000);
  closeTo(boosted, midOnly + lowAt2k + highAt2k, 1e-6, 'the three bands sum in dB, independently of each other');

  // Missing params fall back to makeParametricEq's own defaults (low: 0,
  // midFreq: 1000, mid: 0, high: 0) — an empty params object is a flat chain.
  closeTo(parametricEqResponseDb({}, 1000), 0, 1e-9, 'defaulted params are a flat chain');
}

// ── hasRealResponse: only the one effect whose topology this file can
// reconstruct exactly gets a real curve; everything else is honestly absent
// rather than drawn as a decorative approximation. ──────────────────────────
{
  assert.equal(hasRealResponse('parametric_eq'), true);
  for (const id of ['compressor', 'eq_mid', 'reverb', 'highpass', 'lowpass', 'vst3', null]) {
    assert.equal(hasRealResponse(id), false, `${id} has no reconstructable topology`);
  }
}

// ── buildEqCurvePath: a valid SVG path string that moves for every sampled
// point (no NaN — a degenerate coefficient set would poison the whole path). ─
{
  const d = buildEqCurvePath({ low: -12, midFreq: 300, mid: 8, high: -6 });
  assert.ok(d.startsWith('M'), 'the path starts with a moveto');
  assert.ok(!d.includes('NaN'), 'no NaN coordinate reached the path string');
  assert.ok(d.includes('L'), 'the path has more than one point');
}

// ── buildFlatCurvePath: a disabled effect draws a flat 0 dB line, not
// whatever its bypassed params would otherwise produce. ────────────────────
{
  const flat = buildFlatCurvePath();
  assert.ok(flat.startsWith('M'), 'the flat line starts with a moveto');
  assert.ok(!flat.includes('NaN'), 'no NaN in the flat line');
  // Exactly two points (a straight horizontal line), unlike the swept curve's
  // many sampled points.
  assert.equal((flat.match(/[ML]/g) ?? []).length, 2, 'a flat line is two points, not a sampled sweep');
  // Both endpoints sit on the SAME y — dbToY(0), the 0 dB baseline — proving
  // it really is flat and not just "happens to start near the baseline".
  const ys = [...flat.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => m[1]);
  assert.equal(ys.length, 2);
  assert.equal(ys[0], ys[1], 'a flat 0 dB line has the same y at both ends');
  // A boosted chain's real curve, by contrast, is NOT flat at that same
  // frequency point — proving buildFlatCurvePath is not just a degenerate
  // case of buildEqCurvePath that happens to look flat.
  const boostedD = buildEqCurvePath({ low: 12, midFreq: 1000, mid: 0, high: 0 });
  const boostedYs = [...boostedD.matchAll(/[ML][\d.]+,([\d.]+)/g)].map((m) => m[1]);
  assert.notEqual(boostedYs[0], boostedYs.at(-1), 'sanity: a real boosted curve is not flat end to end');
}

console.log('EffectsVizPanel frequency-response math: all assertions passed');
