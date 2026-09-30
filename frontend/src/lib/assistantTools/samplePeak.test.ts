// samplePeak: pure sample-peak measurement over decoded Float32Array channels.
// Named cases mirror the ticket so a failure here names exactly what broke.
//
// Run: npx tsx src/lib/assistantTools/samplePeak.test.ts
import assert from 'node:assert/strict';
import {
  gainDbToReachPeak, samplePeak, samplePeakDb,
} from './samplePeak.ts';

const close = (a: number, b: number, eps: number, what: string) =>
  assert.ok(Math.abs(a - b) <= eps, `${what}: ${a} vs ${b} (eps ${eps})`);

/** A period-40 sine so a sample lands exactly on the peak (index 10) and
 *  trough (index 30) of every cycle — no need to hunt for the closest sample. */
const sine = (cycles: number, amplitude: number): Float32Array => {
  const period = 40;
  const out = new Float32Array(period * cycles);
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * i) / period);
  return out;
};

// ── 'silence is -inf' ────────────────────────────────────────────────────────
{
  const silence = new Float32Array(64);
  assert.equal(samplePeak([silence]), 0, 'silence: samplePeak');
  assert.equal(samplePeakDb([silence]), Number.NEGATIVE_INFINITY, 'silence: samplePeakDb');
  // No channels at all is the same "nothing to hear" case.
  assert.equal(samplePeak([]), 0, 'no channels');
}

// ── 'full-scale sine is 0 dBFS' ──────────────────────────────────────────────
{
  const full = sine(3, 1);
  close(samplePeak([full]), 1, 1e-6, 'full-scale peak');
  close(samplePeakDb([full]), 0, 1e-6, 'full-scale dBFS');
}

// ── 'half scale is about -6 dBFS' ────────────────────────────────────────────
{
  const half = sine(3, 0.5);
  close(samplePeakDb([half]), -6.0206, 0.01, 'half-scale dBFS');
}

// Fixtures below use eighths/sixteenths (0.125, 0.25, 0.375, 0.625, 0.75,
// 0.9375, ...): exact in binary, so a Float32Array round-trips them exactly
// and `assert.equal` needs no epsilon. Values like 0.1 or 0.3 are NOT exact
// in float32 and would fail strict equality on rounding noise alone.

// ── 'peak is taken across channels' ──────────────────────────────────────────
{
  const left = Float32Array.from([0.125, -0.25, 0.1875]);
  const right = Float32Array.from([0.375, 0.75, -0.0625]);
  assert.equal(samplePeak([left]), 0.25, 'left alone');
  assert.equal(samplePeak([right]), 0.75, 'right alone');
  assert.equal(samplePeak([left, right]), 0.75, 'across both channels');
}

// ── 'region clamps' ───────────────────────────────────────────────────────────
{
  const ch = Float32Array.from([0.125, 0.25, 0.9375, 0.375, 0.0625]);
  // The 0.9375 spike at index 2 sits outside [3, 5) and must be ignored.
  assert.equal(samplePeak([ch], { startSample: 3, endSample: 5 }), 0.375, 'spike outside window ignored');
  // A negative start clamps to 0 rather than throwing.
  assert.equal(samplePeak([ch], { startSample: -5, endSample: 2 }), 0.25, 'negative start clamps to 0');
  // An end past the buffer clamps to its length, so the spike is back in view.
  assert.equal(samplePeak([ch], { startSample: 0, endSample: 9999 }), 0.9375, 'end past length clamps to length');
  assert.equal(samplePeak([ch], { startSample: -10, endSample: 9999 }), 0.9375, 'both bounds out of range clamp, not throw');
  // endSample <= startSample is a degenerate, empty window: 0, not a throw.
  assert.equal(samplePeak([ch], { startSample: 4, endSample: 2 }), 0, 'endSample <= startSample yields 0');
  assert.equal(samplePeak([ch], { startSample: 3, endSample: 3 }), 0, 'endSample === startSample yields 0');
  // Omitting both bounds means the whole buffer.
  assert.equal(samplePeak([ch], {}), 0.9375, 'omitted region is the whole buffer');
  // A fractional startSample must floor to an integer index like any other
  // array index: `channel[0.5]` is `undefined`, so a bare floor/ceil miss here
  // silently turns every sample in the region into a skipped non-finite value
  // and reads back as total silence instead of the region's real peak.
  assert.equal(
    samplePeak([ch], { startSample: 0.5 }),
    samplePeak([ch], { startSample: 0 }),
    'fractional start floors like startSample: 0',
  );
  assert.equal(samplePeak([ch], { startSample: 0.5 }), 0.9375, 'fractional start still finds the whole-buffer peak');
}

// ── 'non-finite samples ignored' ─────────────────────────────────────────────
{
  const withGarbage = Float32Array.from([0.125, Number.NaN, 0.375, Number.POSITIVE_INFINITY, -0.25, Number.NEGATIVE_INFINITY]);
  assert.equal(samplePeak([withGarbage]), 0.375, 'largest finite magnitude, garbage skipped');
  assert.equal(samplePeakDb([withGarbage]) > Number.NEGATIVE_INFINITY, true, 'garbage does not read as silence');
}

// ── 'gainDbToReachPeak' ───────────────────────────────────────────────────────
{
  close(gainDbToReachPeak(-7, -1), 6, 1e-12, 'typical gain');
  assert.equal(gainDbToReachPeak(Number.NEGATIVE_INFINITY, -1), Number.POSITIVE_INFINITY, 'silence can never reach a target');
}

console.log('samplePeak: ok');
