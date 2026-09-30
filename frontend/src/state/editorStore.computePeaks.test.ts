/**
 * `computePeaks` (D16): the waveform peak decode used for clip thumbnails,
 * comp UI, and drag-and-drop import previews.
 *
 * Two bugs pinned here:
 *  1. Only `getChannelData(0)` was read, so a mono peak of a stereo (or wider)
 *     file silently dropped every channel but the first — a signal that only
 *     ever moved on the right channel drew a flat line.
 *  2. The output was normalised to the CLIP's own loudest sample, so a quiet
 *     clip and a loud clip drew the same waveform height. Two clips of the
 *     same session then looked equally loud, which is exactly the comparison
 *     a waveform exists to make possible.
 *
 * The fix reads every channel and keeps each bucket's peak as the true
 * (un-rescaled) sample amplitude — no per-clip normalisation pass. A float
 * WAV is NOT guaranteed to stay within [-1, 1] (its samples can truly
 * exceed unity), so the peak is clamped to 1 rather than assumed bounded
 * (audit MINOR #3).
 *
 * Run: `npx tsx src/state/editorStore.computePeaks.test.ts`
 */
import assert from 'node:assert/strict';
import { computePeaks } from './editorStore.ts';

/** A fake multi-channel decode: `channels[i]` is channel `i`'s full sample
 *  array. `duration` is arbitrary and only asserted to pass through. */
class FakeAudioContext {
  constructor(private readonly channels: Float32Array[], private readonly duration: number) {}
  async decodeAudioData(_buf: ArrayBuffer) {
    const channels = this.channels;
    const duration = this.duration;
    return {
      duration,
      numberOfChannels: channels.length,
      getChannelData: (i: number) => channels[i],
    };
  }
  async close() {}
}

const withFakeContext = async <T>(channels: Float32Array[], duration: number, fn: () => Promise<T>): Promise<T> => {
  const realWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = {
    AudioContext: function AudioContext() { return new FakeAudioContext(channels, duration); },
  };
  try {
    return await fn();
  } finally {
    (globalThis as { window?: unknown }).window = realWindow;
  }
};

// A signal that only ever moves on channel 1 (right): channel 0 is silent
// throughout. Reading channel 0 alone would draw a flat, all-zero waveform.
{
  const bins = 4;
  const samplesPerBin = 10;
  const len = bins * samplesPerBin;
  const ch0 = new Float32Array(len); // silent
  const ch1 = new Float32Array(len);
  ch1[5] = 0.6;   // bin 0
  ch1[15] = -0.3; // bin 1 (abs 0.3)
  ch1[25] = 0.9;  // bin 2
  // bin 3 stays silent on both channels

  const blob = new Blob(['x']);
  const { peaks, duration } = await withFakeContext([ch0, ch1], 12.5, () => computePeaks(blob, bins));

  assert.equal(duration, 12.5, 'duration passes through from the decode');
  assert.equal(peaks.length, bins);
  assert.ok(Math.abs(peaks[0] - 0.6) < 1e-6, `bin 0 reads the right channel's peak, got ${peaks[0]}`);
  assert.ok(Math.abs(peaks[1] - 0.3) < 1e-6, `bin 1 reads the right channel's peak, got ${peaks[1]}`);
  assert.ok(Math.abs(peaks[2] - 0.9) < 1e-6, `bin 2 reads the right channel's peak, got ${peaks[2]}`);
  assert.equal(peaks[3], 0, 'a silent bin on every channel stays zero');
}

// A quiet clip (peaks well under 1.0) must NOT be rescaled up to a peak of
// 1.0 — that per-clip normalisation is exactly the bug: it made every clip's
// waveform equally tall regardless of how loud the clip actually was.
{
  const bins = 2;
  const samplesPerBin = 4;
  const ch0 = new Float32Array(bins * samplesPerBin);
  ch0[1] = 0.2;
  ch0[5] = 0.1;

  const blob = new Blob(['y']);
  const { peaks } = await withFakeContext([ch0], 1, () => computePeaks(blob, bins));

  assert.ok(Math.abs(peaks[0] - 0.2) < 1e-6, `a quiet clip keeps its true amplitude, got ${peaks[0]}`);
  assert.ok(Math.abs(peaks[1] - 0.1) < 1e-6, `a quiet clip keeps its true amplitude, got ${peaks[1]}`);
}

// A per-bucket peak takes the loudest sample across ALL channels in that
// bucket, not the loudest channel overall picked once for the whole clip: two
// different bins may each be led by a different channel.
{
  const bins = 2;
  const samplesPerBin = 4;
  const ch0 = new Float32Array(bins * samplesPerBin);
  const ch1 = new Float32Array(bins * samplesPerBin);
  ch0[0] = 0.7; // bin 0 led by channel 0
  ch1[5] = 0.8; // bin 1 led by channel 1

  const blob = new Blob(['z']);
  const { peaks } = await withFakeContext([ch0, ch1], 1, () => computePeaks(blob, bins));

  assert.ok(Math.abs(peaks[0] - 0.7) < 1e-6, `bin 0 is led by channel 0, got ${peaks[0]}`);
  assert.ok(Math.abs(peaks[1] - 0.8) < 1e-6, `bin 1 is led by channel 1, got ${peaks[1]}`);
}

// A float WAV's sample can exceed unity — the peak must clamp to 1, not pass
// the raw over-unity value through (audit MINOR #3).
{
  const bins = 1;
  const ch0 = new Float32Array([1.4, -1.2, 0.3]);

  const blob = new Blob(['w']);
  const { peaks } = await withFakeContext([ch0], 1, () => computePeaks(blob, bins));

  assert.equal(peaks[0], 1, `an over-unity sample clamps to exactly 1, got ${peaks[0]}`);
}

console.log('editorStore.computePeaks: ok');
