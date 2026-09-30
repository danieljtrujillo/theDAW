/**
 * The in-flight record in `analyzeBufferAsync` (`created`) is assigned before
 * the analysis task reads it.
 *
 * The task compares `analysisInFlight.get(key) === created` to decide whether
 * to memoise its result. It reads `created` only after its first await, and
 * `analyzeOffThread` is async, so even a Worker that is missing outright
 * (node has none) settles on a later microtask, after the assignment. Were
 * the comparison ever to run first, it would read null, the result would not
 * be memoised, and a second caller would get a fresh analysis.
 *
 * Run: `npx tsx src/components/audio/djSemanticWaveformAnalysis.flight.test.ts`
 */
import assert from 'node:assert/strict';
import { analyzeBufferAsync, evictAnalysis } from './djSemanticWaveformAnalysis.ts';

const RATE = 44100;

function toneBuffer(seconds: number): AudioBuffer {
  const length = Math.round(seconds * RATE);
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / RATE);
  return {
    numberOfChannels: 1,
    length,
    duration: length / RATE,
    sampleRate: RATE,
    getChannelData: () => data,
  } as unknown as AudioBuffer;
}

assert.equal(typeof Worker, 'undefined', 'no Worker here, so every analysis takes the immediate fallback');

// ── one caller, then another: the fallback's result was memoised ──────────
{
  const url = 'blob:flight-sequential';
  const buffer = toneBuffer(1);
  const first = await analyzeBufferAsync(url, buffer, { normalize: true, bins: 64 });
  assert.equal(first.length, 64, 'the fallback analysed the buffer');
  const second = await analyzeBufferAsync(url, buffer, { normalize: true, bins: 64 });
  assert.equal(second, first, 'the second caller is served the memoised array');
  evictAnalysis(url);
}

// ── two callers at once share the one flight, and it is memoised ──────────
{
  const url = 'blob:flight-concurrent';
  const buffer = toneBuffer(1);
  const [a, b] = await Promise.all([
    analyzeBufferAsync(url, buffer, { normalize: true, bins: 32 }),
    analyzeBufferAsync(url, buffer, { normalize: true, bins: 32 }),
  ]);
  assert.equal(a, b, 'both callers get the one analysis');
  const later = await analyzeBufferAsync(url, buffer, { normalize: true, bins: 32 });
  assert.equal(later, a, 'a later caller is served from the memo');
  evictAnalysis(url);
}

console.log('djSemanticWaveformAnalysis flight: all assertions passed');
