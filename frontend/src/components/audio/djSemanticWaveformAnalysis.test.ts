/**
 * `analyzeBuffer` — the two peak-scaling modes (audit MAJOR #2 on D16).
 *
 * D16 fixed `editorStore.computePeaks` (the EDIT timeline's waveform) to stop
 * rescaling a clip's peaks to its own loudest sample — a quiet clip and a loud
 * one used to draw the same height, which is not what REAPER does by default.
 * `djSemanticWaveformAnalysis.analyzeBuffer` (the DJ deck / SemanticWave
 * waveform) had the identical bug and was not part of that fix: `bin.peak =
 * clamp(bin.peak / globalPeak, 0, 1)` normalises to the CLIP's own peak.
 *
 * The DJ decks keep that behaviour by default (`normalize` defaults to
 * `true` — a DJ deck wants every track to fill the same visual height so two
 * tracks of very different mastering loudness are still easy to beatmatch
 * by eye). `normalize: false` is the opt-in REAPER-style absolute mode T25b
 * wires the EDIT timeline's ClipWave to.
 *
 * Pure helper only: no React, no real DOM canvas.
 *
 * Run: `npx tsx src/components/audio/djSemanticWaveformAnalysis.test.ts`
 */
import assert from 'node:assert/strict';
import { analyzeBuffer } from './djSemanticWaveformAnalysis.ts';

/** A single-channel buffer of constant amplitude `amp` (alternating sign so
 *  min/max/rms are all exercised, not just peak). `length` must be large
 *  enough that `analyzeBuffer`'s bin count (>= 900) has real samples per bin. */
const constantBuffer = (amp: number, length = 3600, sampleRate = 44100): AudioBuffer => {
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = i % 2 === 0 ? amp : -amp;
  return {
    numberOfChannels: 1,
    length,
    duration: length / sampleRate,
    sampleRate,
    getChannelData: (_ch: number) => data,
  } as unknown as AudioBuffer;
};

// ── default (normalize: true, unchanged DJ-deck behaviour): a quiet buffer's
//    peak is rescaled to fill [0, 1], exactly as before this fix. ───────────
{
  const bins = analyzeBuffer(constantBuffer(0.2));
  const maxPeak = Math.max(...bins.map((b) => b.peak));
  assert.ok(Math.abs(maxPeak - 1) < 1e-6, `normalized peak should reach ~1, got ${maxPeak}`);

  // Same with the option explicitly spelled out.
  const binsExplicit = analyzeBuffer(constantBuffer(0.2), { normalize: true });
  const maxPeakExplicit = Math.max(...binsExplicit.map((b) => b.peak));
  assert.ok(Math.abs(maxPeakExplicit - 1) < 1e-6);
}

// ── normalize: false — absolute amplitude, NOT rescaled to the buffer's own
//    peak. A quiet buffer draws quiet. ───────────────────────────────────────
{
  const bins = analyzeBuffer(constantBuffer(0.2), { normalize: false });
  const maxPeak = Math.max(...bins.map((b) => b.peak));
  assert.ok(Math.abs(maxPeak - 0.2) < 1e-6, `absolute peak should stay ~0.2, got ${maxPeak}`);

  // A LOUDER buffer draws louder than a quieter one — exactly the comparison
  // per-clip normalisation made impossible.
  const loudBins = analyzeBuffer(constantBuffer(0.8), { normalize: false });
  const loudPeak = Math.max(...loudBins.map((b) => b.peak));
  assert.ok(Math.abs(loudPeak - 0.8) < 1e-6);
  assert.ok(loudPeak > maxPeak, 'a louder buffer must draw a taller peak than a quieter one');
}

// ── normalize: false clamps to [0, 1] / [-1, 1] — a float WAV's samples can
//    exceed unity (audit MINOR #3's concern, shared by this absolute path). ──
{
  const bins = analyzeBuffer(constantBuffer(1.4), { normalize: false });
  for (const b of bins) {
    assert.ok(b.peak <= 1, `peak must clamp to <= 1, got ${b.peak}`);
    assert.ok(b.min >= -1 && b.max <= 1, `min/max must clamp to [-1, 1], got ${b.min}/${b.max}`);
    assert.ok(b.rms <= 1, `rms must clamp to <= 1, got ${b.rms}`);
  }
  const maxPeak = Math.max(...bins.map((b) => b.peak));
  assert.ok(Math.abs(maxPeak - 1) < 1e-6, 'an over-unity amplitude clamps to exactly 1, not scaled down further');
}

// ── A totally silent buffer never divides by zero in either mode. ───────────
{
  const silentBins = analyzeBuffer(constantBuffer(0));
  assert.ok(silentBins.every((b) => b.peak === 0));
  const silentBinsAbs = analyzeBuffer(constantBuffer(0), { normalize: false });
  assert.ok(silentBinsAbs.every((b) => b.peak === 0));
}

console.log('djSemanticWaveformAnalysis: ok');
