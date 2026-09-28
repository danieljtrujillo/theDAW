/**
 * Clipping mode marks real clipping only (PR #207 review).
 *
 * The PR flagged a column when its drawn peak was at or above 0.985. That
 * peak is the strided mono mix, rescaled by `normalize` to the track's own
 * loudest bin, so:
 *  - every normalised waveform (DJ decks, MIX rows, MAKE, the footer strip,
 *    the clip editor drawer) showed its loudest passage red, even on a track
 *    peaking at -12 dBFS;
 *  - a file clipping in one channel averaged down to about half and never
 *    showed, even on EDIT (normalize off);
 *  - a short run at full scale between two strided reads never showed.
 *
 * Each case below decodes a buffer the way a surface does (analysis with that
 * surface's `normalize`), draws it in 'clipping' mode one column per bin, and
 * reads back which columns came out red.
 *
 * Run: `npx tsx src/components/audio/djSemanticWaveformAnalysis.clipping.test.ts`
 */
import assert from 'node:assert/strict';
import {
  CLIP_SAMPLE_LEVEL,
  WAVEFORM_LEGEND,
  analyzeBuffer,
  analyzeBufferAsync,
  drawWaveform,
  evictAnalysis,
} from './djSemanticWaveformAnalysis.ts';
import type { CanvasBox } from '../../lib/canvasScale.ts';

const RATE = 44100;
const CLIP_RED = 'rgba(255, 61, 79';

function stereoBuffer(seconds: number, fill: (ch: number, i: number) => number): AudioBuffer {
  const length = Math.round(seconds * RATE);
  const channels = [0, 1].map((ch) => {
    const data = new Float32Array(length);
    for (let i = 0; i < length; i += 1) data[i] = fill(ch, i);
    return data;
  });
  return {
    numberOfChannels: 2,
    length,
    duration: length / RATE,
    sampleRate: RATE,
    getChannelData: (ch: number) => channels[ch],
  } as unknown as AudioBuffer;
}

/** A 440 Hz tone at `amp` in both channels. */
const tone = (amp: number) => (_ch: number, i: number) => amp * Math.sin((2 * Math.PI * 440 * i) / RATE);

/** Which columns a 'clipping' draw paints red, one column per bin. */
function redColumns(bins: ReturnType<typeof analyzeBuffer>): number[] {
  const fills: Array<{ x: number; style: string }> = [];
  let style = '';
  const ctx = {
    set fillStyle(v: unknown) {
      style = typeof v === 'string' ? v : 'gradient';
    },
    get fillStyle() {
      return style;
    },
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    setTransform() {},
    clearRect() {},
    strokeRect() {},
    fillText() {},
    createLinearGradient: () => ({ addColorStop() {} }),
    fillRect(x: number) {
      fills.push({ x, style });
    },
  };
  const canvas = { width: 0, height: 0, getContext: () => ctx } as unknown as HTMLCanvasElement;
  const box: CanvasBox = { cssWidth: bins.length, cssHeight: 32, deviceWidth: bins.length, deviceHeight: 32, scale: 1, zoom: 1, dpr: 1 };
  drawWaveform(canvas, box, bins, 0, 1, true, null, 'clipping');
  return [...new Set(fills.filter((f) => f.style.startsWith(CLIP_RED)).map((f) => f.x))].sort((a, b) => a - b);
}

// ── a DJ deck loads a track that peaks at -12 dBFS: no red anywhere ────────
{
  const url = 'blob:quiet-track';
  const buffer = stereoBuffer(4, tone(0.25));
  // The deck's lane: normalize on (DJSemanticWaveform's default), through the
  // same memoised entry point the component uses.
  const bins = await analyzeBufferAsync(url, buffer, { normalize: true, bins: 200 });
  assert.equal(Math.max(...bins.map((b) => b.peak)), 1, 'normalised: the loudest bin is drawn at full height');
  assert.deepEqual(redColumns(bins), [], 'a track that never reaches full scale shows no clipping');
  evictAnalysis(url);
}

// ── EDIT: one channel clips in the middle second, the other stays quiet ────
{
  // Left is a hard-clipped square from 2 s to 3 s; right is the quiet tone
  // throughout. The mono mix of the clipped region is about 0.6.
  const buffer = stereoBuffer(5, (ch, i) => {
    if (ch === 0 && i >= 2 * RATE && i < 3 * RATE) return Math.sin((2 * Math.PI * 440 * i) / RATE) >= 0 ? 1 : -1;
    return 0.25 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  });
  const bins = analyzeBuffer(buffer, { normalize: false, bins: 100 });
  // 100 bins over 5 s: bins 40..59 hold the second from 2 s to 3 s.
  const expected = Array.from({ length: 20 }, (_, k) => 40 + k);
  assert.deepEqual(redColumns(bins), expected, 'EDIT (absolute level): exactly the clipped second is red');

  // The same file on a normalised surface marks the same second, no more.
  const normalised = analyzeBuffer(buffer, { normalize: true, bins: 100 });
  assert.deepEqual(redColumns(normalised), expected, 'a normalised surface marks the same clipped second');
}

// ── a clip in the RIGHT channel only, on a deck (normalize on) ─────────────
{
  const buffer = stereoBuffer(2, (ch, i) => {
    if (ch === 1 && i >= RATE && i < RATE + RATE / 10) return 1.05; // float WAV overshoot
    return 0.1 * Math.sin((2 * Math.PI * 440 * i) / RATE);
  });
  const bins = analyzeBuffer(buffer, { normalize: true, bins: 20 });
  // 20 bins over 2 s: the 0.1 s from 1.0 s is bin 10.
  assert.deepEqual(redColumns(bins), [10], 'one channel over full scale is enough');
}

// ── a three-sample run at full scale that the strided read steps over ──────
{
  // 10 s in 100 bins is 4,410 samples per bin; the tone/band read samples
  // every 8th. Three samples at offsets 1-3 of bin 37 fall between reads.
  const at = 37 * 4410 + 1;
  const buffer = stereoBuffer(10, (ch, i) => (ch === 0 && i >= at && i < at + 3 ? -CLIP_SAMPLE_LEVEL : 0.3 * Math.sin((2 * Math.PI * 440 * i) / RATE)));
  const bins = analyzeBuffer(buffer, { normalize: false, bins: 100 });
  assert.equal(bins[37].clipped, 3, 'every raw sample is counted, not the strided read');
  assert.deepEqual(redColumns(bins), [37]);
}

// ── the legend keeps the two reds apart and names the green band ───────────
{
  const semantic = WAVEFORM_LEGEND.semantic.map((i) => i.label);
  const clipping = WAVEFORM_LEGEND.clipping.map((i) => i.label);
  assert.ok(semantic.some((l) => /^Red: beat/.test(l)), 'semantic red is a beat');
  assert.ok(clipping.some((l) => /^Red: clipped/.test(l)), 'clipping red is a clipped sample');
  assert.ok(!semantic.some((l) => /clip/i.test(l)) && !clipping.some((l) => /beat/i.test(l)), 'neither mode borrows the other red');
  assert.ok(semantic.includes('Green: mids 420 Hz–1.7 kHz'), `green names the band it measures, got ${semantic.join(' | ')}`);
  assert.ok(!semantic.some((l) => /vocal/i.test(l)), 'green is a frequency band, not a claim about vocals');
}

console.log('djSemanticWaveformAnalysis.clipping: ok');
