/**
 * DJSemanticWaveform — batch-12 fixes (T21).
 *
 * FE-008: `getMonoSample` used to call `AudioBuffer.getChannelData(ch)` once
 *   per sample read, and `getChannelData` is allowed to copy on every call.
 *   `analyzeBuffer` must fetch each channel's array exactly once (via
 *   `getChannels`) and index into the cached arrays for every sample.
 * FE-021: `drawWaveform` painted an opaque background gradient unconditionally,
 *   which defeated `transparentBg` (SemanticWave embeds the canvas over an
 *   already-coloured panel). The gradient fill must be skipped when the
 *   caller asks for a transparent background.
 * FE-011: a failed decode used to fall through to the exact same thin
 *   centre-line render as "no data yet" — a broken audio URL was invisible.
 *   `drawWaveform` must paint a distinct, visible failure state.
 *
 * Pure helpers only: no React, no real DOM canvas (not available under plain
 * node/tsx) — a minimal fake canvas/context records what was drawn.
 *
 * Run: `node node_modules/tsx/dist/cli.mjs src/components/audio/DJSemanticWaveform.b12.test.ts`
 * — `npm test` discovers it.
 */
import assert from 'node:assert/strict';
import {
  MAX_CANVAS_DEVICE_WIDTH,
  analyzeBuffer,
  analyzeBufferAsync,
  analyzeBufferMemo,
  binCountFor,
  canvasWindowFor,
  drawWaveform,
  drawWaveformCached,
  evictAnalysis,
  getChannels,
  getMonoSample,
} from './djSemanticWaveformAnalysis.ts';
import type { WaveBin } from './djSemanticWaveformAnalysis.ts';
import type { CanvasBox } from '../../lib/canvasScale.ts';

// ── FE-008: getChannelData is fetched once per channel, not per sample ─────

{
  let callCount = 0;
  const chLeft = new Float32Array([0.1, 0.2, 0.3, 0.4]);
  const chRight = new Float32Array([0.5, 0.6, 0.7, 0.8]);
  const fakeBuffer = {
    numberOfChannels: 2,
    length: 4,
    duration: 4 / 44100,
    sampleRate: 44100,
    getChannelData(ch: number) {
      callCount += 1;
      return ch === 0 ? chLeft : chRight;
    },
  } as unknown as AudioBuffer;

  const channels = getChannels(fakeBuffer);
  assert.equal(callCount, 2, 'getChannelData must be called exactly once per channel');
  assert.equal(channels.length, 2);

  // Reading many samples afterwards must not call getChannelData again.
  for (let i = 0; i < fakeBuffer.length; i += 1) getMonoSample(channels, i);
  assert.equal(callCount, 2, 'getMonoSample must reuse the cached channel arrays, not re-fetch per sample');

  // The mono mix is still the average of the channels at that index.
  const mixed = getMonoSample(channels, 1);
  // Float32Array values round-trip with float32 precision, not float64.
  assert.ok(Math.abs(mixed - (0.2 + 0.6) / 2) < 1e-6);
}

{
  // analyzeBuffer (the real per-sample analysis loop) must also only call
  // getChannelData once per channel regardless of the buffer's sample count.
  let callCount = 0;
  const length = 20000; // several analysis bins' worth
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = Math.sin(i * 0.01) * 0.5;
  const fakeBuffer = {
    numberOfChannels: 1,
    length,
    duration: length / 44100,
    sampleRate: 44100,
    getChannelData(_ch: number) {
      callCount += 1;
      return data;
    },
  } as unknown as AudioBuffer;

  const bins = analyzeBuffer(fakeBuffer);
  assert.equal(callCount, 1, 'analyzeBuffer must fetch each channel once, never per sample');
  assert.ok(bins.length > 0);
}

// ── Fake canvas/context for drawWaveform assertions ─────────────────────────

type FillCall = { kind: 'fillRect' | 'strokeRect'; style: unknown; x: number; y: number; w: number; h: number };
type ImageCall = { source: unknown; sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number };

function makeFakeCanvas() {
  const calls: FillCall[] = [];
  const gradients: string[] = [];
  const images: ImageCall[] = [];
  let fillStyle: unknown = null;
  let strokeStyle: unknown = null;

  const ctx = {
    clearRect() {},
    drawImage(source: unknown, sx: number, sy: number, sw: number, sh: number, dx: number, dy: number, dw: number, dh: number) {
      images.push({ source, sx, sy, sw, sh, dx, dy, dw, dh });
    },
    createLinearGradient() {
      gradients.push('created');
      return { addColorStop(_offset: number, color: string) { gradients.push(color); } };
    },
    setTransform() {},
    fillRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'fillRect', style: fillStyle, x, y, w, h });
    },
    strokeRect(x: number, y: number, w: number, h: number) {
      calls.push({ kind: 'strokeRect', style: strokeStyle, x, y, w, h });
    },
    fillText() {},
    set fillStyle(v: unknown) { fillStyle = v; },
    get fillStyle() { return fillStyle; },
    set strokeStyle(v: unknown) { strokeStyle = v; },
    get strokeStyle() { return strokeStyle; },
    lineWidth: 1,
    font: '',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    globalCompositeOperation: 'source-over',
    globalAlpha: 1,
  };

  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;

  return { canvas, calls, gradients, images };
}

const BOX: CanvasBox = { cssWidth: 200, cssHeight: 64, deviceWidth: 200, deviceHeight: 64, scale: 1, zoom: 1, dpr: 1 };

// ── FE-021: transparentBg must not be covered by the opaque bg gradient ────

{
  const { canvas, gradients } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, true, null);
  assert.equal(gradients.length, 0, 'transparent=true must skip the opaque background gradient entirely');
}

{
  const { canvas, gradients } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, false, null);
  assert.ok(gradients.length > 0, 'transparent=false must still paint the background gradient (unchanged default behaviour)');
}

// ── FE-011: a decode failure paints a distinct, visible state ──────────────

{
  const { canvas, calls } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, false, 'Unable to load audio waveform: 404');
  const strokes = calls.filter((c) => c.kind === 'strokeRect');
  assert.ok(strokes.length > 0, 'a decode error must draw a visible border, not the silent "no data" line');
  assert.ok(
    String(strokes[0].style).includes('255, 89, 64'),
    'the error state must use the failure colour, not the neutral "no data" colour',
  );
  // Its label is bold and at least 12 px, even on a short lane (it was 9 px).
  const shortLane = makeFakeCanvas();
  drawWaveform(shortLane.canvas, { ...BOX, cssHeight: 16, deviceHeight: 16 }, [], 0, 1, false, 'Unable to load audio waveform: 404');
  const font = String((shortLane.canvas.getContext('2d') as unknown as { font: string }).font);
  const px = Number(/(\d+(?:\.\d+)?)px/.exec(font)?.[1] ?? 0);
  assert.ok(font.startsWith('bold ') && px >= 12, `the failure label must be bold 12 px or more, got "${font}"`);
}

{
  // The pre-existing "no data yet" (bins empty, no error) state is unchanged:
  // a faint centre line, not the red error indicator.
  const { canvas, calls } = makeFakeCanvas();
  drawWaveform(canvas, BOX, [], 0, 1, false, null);
  const strokes = calls.filter((c) => c.kind === 'strokeRect');
  assert.equal(strokes.length, 0, 'the plain "no data yet" state must not draw the error border');
}

// ══ DJ-2: the deck's main-thread burst at load ═════════════════════════════

// ── bins come from the width the WHOLE track spans at the lane's zoom ──────

{
  // Unchanged behaviour when nothing says how wide the track is drawn.
  assert.equal(binCountFor(210, undefined), 6400, 'no width: the historical 6,400 cap');
  assert.equal(binCountFor(210, 0), 6400, 'a not-yet-measured (zero) width falls back to the cap too');

  // PR #207 review: the width is the lane's width over the fraction of the
  // track it shows. The DJ detail lane runs at zoom 8 (span 0.125); passed the
  // lane's own ~900 px, the PR analysed 3,840 bins for the whole track, i.e.
  // 480 across the visible lane where main drew 800. At zoom it gets main's
  // full resolution back.
  const mainBins = 6400; // main: clamp(round(210 * 32), 900, 6400)
  const detail = binCountFor(210, 900 / 0.125);
  assert.ok(detail >= mainBins, `the zoom-8 detail lane must keep main's ${mainBins} bins, got ${detail}`);
  assert.ok(detail * 0.125 >= 800, 'at least the 800 bins main showed across the visible lane');
  // Deeper zoom never lowers it, and nothing exceeds the historical count.
  for (const zoom of [2, 8, 16, 36]) {
    assert.equal(binCountFor(210, 900 * zoom), mainBins, `zoom ${zoom}: main's count, never above it`);
  }

  // A whole-track overview lane 40 px wide needs far fewer: at least 4 bins
  // per pixel and the 900 floor, rounded up to a power of two.
  assert.equal(binCountFor(210, 40), 1024, 'a 40 px overview lane computes ~1k bins, not 6,400');

  // A short track still never goes above its own natural count.
  assert.equal(binCountFor(20, 1200), 900, 'the 900-bin floor is unchanged');
  assert.equal(binCountFor(210, 4000), 6400, 'the absolute 6,400 cap still wins over 4*width');

  // The count moves in powers of two, so a lane resized pixel by pixel keeps
  // one count across a wide band of widths (every 64 px step used to be a new
  // analysis). 900..1023 px of whole-track width all ask for 4,096.
  const band = new Set<number>();
  for (let w = 900; w < 1024; w += 1) band.add(binCountFor(210, w));
  assert.deepEqual([...band], [4096], 'one bin count across a 900-1023 px resize');
  for (let w = 40; w <= 4000; w += 7) {
    assert.ok(binCountFor(210, w) >= Math.min(6400, w * 4), `at least 4 bins per px at ${w} px (or the cap)`);
  }
}

// ── the analysis is memoised per (url, normalize, bins) ────────────────────

/** `duration` drives the BIN COUNT while `length` drives the analysis loop, so
 *  a cheap 20k-sample fixture can still stand in for a 3.5-minute track's bin
 *  sizing (which is the thing `width` changes). */
function countingBuffer(seed: number, counter: { calls: number }, duration = 210, sampleRate = 44100): AudioBuffer {
  const length = 20000;
  const data = new Float32Array(length);
  for (let i = 0; i < length; i += 1) data[i] = Math.sin(i * 0.01 + seed) * 0.5;
  return {
    numberOfChannels: 1,
    length,
    duration,
    sampleRate,
    getChannelData(_ch: number) {
      counter.calls += 1;
      return data;
    },
  } as unknown as AudioBuffer;
}

{
  evictAnalysis('memo-a.wav');
  const counter = { calls: 0 };
  const buffer = countingBuffer(0, counter);

  const first = analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 40 });
  const second = analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 40 });
  assert.equal(counter.calls, 1, 'the SECOND waveform instance for the same URL must cost nothing');
  assert.equal(first, second, 'and gets the very same analysed bins array back');

  // A different `normalize` is a different cache key — it must re-analyse.
  const flipped = analyzeBufferMemo('memo-a.wav', buffer, { normalize: false, width: 40 });
  assert.equal(counter.calls, 2, 'flipping normalize is a different analysis');
  assert.notEqual(first, flipped);

  // A different bin count (a wider lane) is also a different key.
  analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 1200 });
  assert.equal(counter.calls, 3, 'a wider lane analyses at its own bin count');
  // ...and an explicit count is the same key as the width that yields it.
  analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, bins: binCountFor(210, 1200) });
  assert.equal(counter.calls, 3, 'opts.bins names the same analysis as the width behind it');

  // The async entry point (the one the component calls) resolves to the same
  // memoised array without re-analysing when no Worker exists — which is the
  // path these node/tsx tests exercise.
  assert.equal(typeof (globalThis as Record<string, unknown>).Worker, 'undefined', 'no Worker under node/tsx');
  const viaAsync = await analyzeBufferAsync('memo-a.wav', buffer, { normalize: true, width: 40 });
  assert.equal(viaAsync, first, 'analyzeBufferAsync returns the memoised bins');
  assert.equal(counter.calls, 3, 'and does not re-run the analysis');

  // Evicting the URL drops every one of its keyed entries.
  evictAnalysis('memo-a.wav');
  analyzeBufferMemo('memo-a.wav', buffer, { normalize: true, width: 40 });
  assert.equal(counter.calls, 4, 'evictAnalysis clears the memo for that URL');
}

// ── the memo key includes the buffer's SAMPLE RATE ────────────────────────

{
  // The analysis reads frequency bands out of the samples, so the rate the
  // buffer was decoded at changes the RESULT — `bandPower` is handed
  // `sampleRate / stride`. Keyed on (url, normalize, bins) alone, a buffer
  // re-decoded at another rate silently reused the first rate's bins.
  evictAnalysis('rate-memo.wav');
  const counter = { calls: 0 };
  const at44 = countingBuffer(3, counter, 210, 44100);
  const at48 = countingBuffer(3, counter, 210, 48000);

  const bins44 = analyzeBufferMemo('rate-memo.wav', at44, { normalize: true, width: 40 });
  assert.equal(counter.calls, 1);
  const bins48 = analyzeBufferMemo('rate-memo.wav', at48, { normalize: true, width: 40 });
  assert.equal(counter.calls, 2, 'a buffer decoded at another sample rate is a different analysis');
  assert.notEqual(bins44, bins48, 'and gets its own bins');

  assert.equal(analyzeBufferMemo('rate-memo.wav', at44, { normalize: true, width: 40 }), bins44);
  assert.equal(counter.calls, 2, 'each rate keeps its own memo entry');

  evictAnalysis('rate-memo.wav');
  analyzeBufferMemo('rate-memo.wav', at48, { normalize: true, width: 40 });
  assert.equal(counter.calls, 3, 'evictAnalysis drops every rate for that URL');
}

// ── the analysis is instrumented as `dj:analyze:<url>` ─────────────────────

{
  evictAnalysis('measured.wav');
  const counter = { calls: 0 };
  const buffer = countingBuffer(1, counter);
  const measures: string[] = [];
  const g = globalThis as unknown as Record<string, unknown>;
  const realPerf = g.performance as Record<string, unknown> | undefined;
  g.performance = {
    now: () => 0,
    mark: () => undefined,
    measure: (name: string) => { measures.push(name); return undefined; },
    clearMarks: () => undefined,
    clearMeasures: () => undefined,
  };
  analyzeBufferMemo('measured.wav', buffer, { normalize: true, width: 40 });
  g.performance = realPerf;
  assert.ok(
    measures.includes('dj:analyze:measured.wav'),
    `analysis must emit a "dj:analyze:<url>" measure — got ${JSON.stringify(measures)}`,
  );
}

// ── repaint: the full view is unchanged, a viewport pan is a blit ──────────

// `drawWaveformCached` builds its offscreen render with
// `document.createElement('canvas')`; under plain node there is no document,
// so one is faked here with the same recording canvas as above.
const offscreens: Array<ReturnType<typeof makeFakeCanvas>> = [];
(globalThis as unknown as Record<string, unknown>).document = {
  createElement(tag: string) {
    assert.equal(tag, 'canvas', 'the offscreen cache only ever creates canvases');
    const fake = makeFakeCanvas();
    offscreens.push(fake);
    return fake.canvas;
  },
};

const REAL_BINS = analyzeBuffer(countingBuffer(2, { calls: 0 }));

{
  offscreens.length = 0;
  const direct = makeFakeCanvas();
  drawWaveform(direct.canvas, BOX, REAL_BINS, 0, 1, false, null);

  const cached = makeFakeCanvas();
  drawWaveformCached(cached.canvas, BOX, REAL_BINS, 0, 1, false, null, 'full-view');

  // `createLinearGradient` hands back a fresh object each time, so compare a
  // projection where a gradient style is just "gradient" — every other style
  // is the literal colour string and is compared exactly.
  const normalize = (calls: typeof direct.calls) =>
    calls.map((c) => ({ ...c, style: typeof c.style === 'object' && c.style !== null ? 'gradient' : String(c.style) }));
  assert.deepEqual(
    normalize(cached.calls),
    normalize(direct.calls),
    // Delegation, not proof: the golden above is what pins the output.
    'the full view must delegate to drawWaveform, call for call',
  );
  assert.deepEqual(cached.gradients, direct.gradients, 'including every gradient stop');
  assert.equal(cached.images.length, 0, 'the full view blits nothing');
  assert.equal(offscreens.length, 0, 'and allocates no offscreen canvas at all');
}

/** Forget what a fake canvas recorded, so the next frame is counted alone. */
function clearFrame(fake: ReturnType<typeof makeFakeCanvas>): void {
  fake.calls.length = 0;
  fake.images.length = 0;
  fake.gradients.length = 0;
}

/** The distinct columns a frame painted (one fill per column minimum). */
function columnsPainted(fake: ReturnType<typeof makeFakeCanvas>): number {
  return new Set(fake.calls.filter((c) => c.kind === 'fillRect' && c.w === 1).map((c) => c.x)).size;
}

{
  // One lane, frame after frame — the way a deck's canvas is really driven.
  offscreens.length = 0;
  const lane = makeFakeCanvas();
  drawWaveformCached(lane.canvas, BOX, REAL_BINS, 0.2, 0.4, false, null, 'zoomed');
  assert.equal(offscreens.length, 0, 'the first frame at a zoom is drawn directly: nothing to reuse yet');
  assert.equal(lane.images.length, 0);
  assert.ok(columnsPainted(lane) <= BOX.cssWidth, 'and it paints one lane-width of columns, not the track');

  // The hot path: the viewport moves ~6x/second per deck while a deck plays.
  clearFrame(lane);
  drawWaveformCached(lane.canvas, BOX, REAL_BINS, 0.21, 0.41, false, null, 'zoomed');
  assert.equal(offscreens.length, 1, 'once it scrolls, the window around the viewport is rendered once');
  const paintedOnce = offscreens[0].calls.length;
  assert.ok(paintedOnce > 0, 'the offscreen actually holds a rendered waveform');
  assert.equal(lane.images.length, 1, 'and the visible slice is blitted onto the real canvas');
  const firstSx = lane.images[0].sx;

  clearFrame(lane);
  drawWaveformCached(lane.canvas, BOX, REAL_BINS, 0.25, 0.45, false, null, 'zoomed');
  assert.equal(offscreens.length, 1, 'panning inside the window must NOT re-render the waveform');
  assert.equal(offscreens[0].calls.length, paintedOnce, 'the window is never repainted');
  assert.equal(lane.images.length, 1, 'the pan is one blit');
  assert.notEqual(lane.images[0].sx, firstSx, 'at a shifted source offset');

  // Changing the ZOOM (the span) is drawn directly again — one lane-width of
  // columns, never a render of the whole track at the new zoom.
  clearFrame(lane);
  drawWaveformCached(lane.canvas, BOX, REAL_BINS, 0.25, 0.65, false, null, 'zoomed');
  assert.equal(lane.images.length, 0, 'a new zoom never blits the old zoom’s window');
  assert.ok(columnsPainted(lane) <= BOX.cssWidth);
}

// DJ-2R item 4: a golden of the PRE-DJ-2 full-view render.
//
// The "pixel-identical" check below compares `drawWaveformCached` against
// `drawWaveform`, which it delegates to for the full view — true by
// construction, and blind to the thing that could actually have broken:
// DJ-2 carved `drawWaveBody` / `paintGuides` / `paintSpine` / `paintVignette`
// out of what was one straight-line `drawWaveform`. THIS is the check that
// the extraction changed nothing: the call sequence below was generated once
// from `git show e190ee0:.../djSemanticWaveformAnalysis.ts` — the last
// revision before DJ-2 — and is compared against today's output for the same
// bins and the same box.
//
// Regenerating it is only correct if the waveform is MEANT to look different.

/** Fixed, hand-built bins: the golden is about DRAWING, so its input must not
 *  depend on the analysis. Covers a beat-coloured bin (the low rail), a
 *  silence-coloured one, and a spread of band energies. */
function goldenBins(): WaveBin[] {
  const colors = ['#ff3f4f', '#72ee78', '#2ea9ff', '#f5b84b', '#bca8ff', 'rgba(72, 83, 100, 0.45)'];
  const out: WaveBin[] = [];
  for (let i = 0; i < 12; i += 1) {
    const t = i / 11;
    out.push({
      peak: 0.15 + t * 0.8,
      rms: 0.08 + t * 0.4,
      min: -(0.1 + t * 0.7),
      max: 0.12 + t * 0.75,
      low: (i % 3) / 2,
      mid: ((i + 1) % 4) / 3,
      bright: ((i + 2) % 5) / 4,
      transient: (i % 6) / 5,
      color: colors[i % colors.length],
      clipped: 0,
    });
  }
  return out;
}

const GOLDEN_BOX: CanvasBox = { cssWidth: 24, cssHeight: 16, deviceWidth: 24, deviceHeight: 16, scale: 1, zoom: 1, dpr: 1 };

const GOLDEN_CALLS: string[] = [
  "fillRect|gradient|0.0000|0.0000|24.0000|16.0000",
  "fillRect|rgba(255,255,255,0.035)|0.0000|4.0000|24.0000|1.0000",
  "fillRect|rgba(255,255,255,0.035)|0.0000|12.0000|24.0000|1.0000",
  "fillRect|rgba(255,255,255,0.055)|0.0000|7.5000|24.0000|1.0000",
  "fillRect|rgba(255, 89, 64, 0.39073887273085706)|0.0000|6.1983|1.0000|3.6034",
  "fillRect|rgba(30, 144, 255, 0.06662091123078989)|0.0000|6.6988|1.0000|2.6025",
  "fillRect|rgba(76, 241, 112, 0.20906666666666668)|0.0000|6.7989|1.0000|2.4023",
  "fillRect|rgba(255, 182, 65, 0.28)|0.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 89, 64, 0.2)|0.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(255, 89, 64, 0.39073887273085706)|1.0000|6.1983|1.0000|3.6034",
  "fillRect|rgba(30, 144, 255, 0.06662091123078989)|1.0000|6.6988|1.0000|2.6025",
  "fillRect|rgba(76, 241, 112, 0.20906666666666668)|1.0000|6.7989|1.0000|2.4023",
  "fillRect|rgba(255, 182, 65, 0.28)|1.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 89, 64, 0.2)|1.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(76, 241, 112, 0.4278942950987756)|2.0000|5.7340|1.0000|4.5320",
  "fillRect|rgba(30, 144, 255, 0.24348101061147662)|2.0000|5.8284|1.0000|4.3432",
  "fillRect|rgba(76, 241, 112, 0.3659151515151515)|2.0000|6.0487|1.0000|3.9025",
  "fillRect|rgba(255, 182, 65, 0.43700000000000006)|2.0000|6.6467|1.0000|2.7066",
  "fillRect|rgba(76, 241, 112, 0.4278942950987756)|3.0000|5.7340|1.0000|4.5320",
  "fillRect|rgba(30, 144, 255, 0.24348101061147662)|3.0000|5.8284|1.0000|4.3432",
  "fillRect|rgba(76, 241, 112, 0.3659151515151515)|3.0000|6.0487|1.0000|3.9025",
  "fillRect|rgba(255, 182, 65, 0.43700000000000006)|3.0000|6.6467|1.0000|2.7066",
  "fillRect|rgba(46, 169, 255, 0.461234540759595)|4.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(30, 144, 255, 0.41944342135519885)|4.0000|4.8114|1.0000|6.3772",
  "fillRect|rgba(76, 241, 112, 0.5227636363636363)|4.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(255, 182, 65, 0.5940000000000001)|4.0000|6.1462|1.0000|3.7077",
  "fillRect|rgba(255, 246, 210, 0.17064342135519883)|4.0000|5.4373|1.0000|5.1255",
  "fillRect|rgba(46, 169, 255, 0.47)|4.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(46, 169, 255, 0.461234540759595)|5.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(30, 144, 255, 0.41944342135519885)|5.0000|4.8114|1.0000|6.3772",
  "fillRect|rgba(76, 241, 112, 0.5227636363636363)|5.0000|5.3305|1.0000|5.3391",
  "fillRect|rgba(255, 182, 65, 0.5940000000000001)|5.0000|6.1462|1.0000|3.7077",
  "fillRect|rgba(255, 246, 210, 0.17064342135519883)|5.0000|5.4373|1.0000|5.1255",
  "fillRect|rgba(46, 169, 255, 0.47)|5.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(255, 182, 65, 0.4920561816333351)|6.0000|4.9670|1.0000|6.0659",
  "fillRect|rgba(30, 144, 255, 0.08481321920784356)|6.0000|5.8095|1.0000|4.3809",
  "fillRect|rgba(76, 241, 112, 0.09294545454545455)|6.0000|6.5678|1.0000|2.8645",
  "fillRect|rgba(255, 182, 65, 0.126)|6.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 246, 210, 0.3400132192078435)|6.0000|5.0884|1.0000|5.8233",
  "fillRect|rgba(255, 182, 65, 0.4920561816333351)|7.0000|4.9670|1.0000|6.0659",
  "fillRect|rgba(30, 144, 255, 0.08481321920784356)|7.0000|5.8095|1.0000|4.3809",
  "fillRect|rgba(76, 241, 112, 0.09294545454545455)|7.0000|6.5678|1.0000|2.8645",
  "fillRect|rgba(255, 182, 65, 0.126)|7.0000|7.0000|1.0000|2.0000",
  "fillRect|rgba(255, 246, 210, 0.3400132192078435)|7.0000|5.0884|1.0000|5.8233",
  "fillRect|rgba(188, 168, 255, 0.5210469222279449)|8.0000|4.6328|1.0000|6.7345",
  "fillRect|rgba(30, 144, 255, 0.2597522169948106)|8.0000|4.7731|1.0000|6.4539",
  "fillRect|rgba(76, 241, 112, 0.2497939393939394)|8.0000|5.7552|1.0000|4.4896",
  "fillRect|rgba(255, 182, 65, 0.28300000000000003)|8.0000|6.8308|1.0000|2.3384",
  "fillRect|rgba(255, 246, 210, 0.5089522169948105)|8.0000|4.7675|1.0000|6.4651",
  "fillRect|rgba(188, 168, 255, 0.5210469222279449)|9.0000|4.6328|1.0000|6.7345",
  "fillRect|rgba(30, 144, 255, 0.2597522169948106)|9.0000|4.7731|1.0000|6.4539",
  "fillRect|rgba(76, 241, 112, 0.2497939393939394)|9.0000|5.7552|1.0000|4.4896",
  "fillRect|rgba(255, 182, 65, 0.28300000000000003)|9.0000|6.8308|1.0000|2.3384",
  "fillRect|rgba(255, 246, 210, 0.5089522169948105)|9.0000|4.7675|1.0000|6.4651",
  "fillRect|rgba(72, 83, 100, 0.5486251491971231)|10.0000|4.3210|1.0000|7.3580",
  "fillRect|rgba(30, 144, 255, 0.4343588586346172)|10.0000|3.6056|1.0000|8.7887",
  "fillRect|rgba(76, 241, 112, 0.40664242424242425)|10.0000|4.8320|1.0000|6.3361",
  "fillRect|rgba(255, 182, 65, 0.44000000000000006)|10.0000|6.2627|1.0000|3.4746",
  "fillRect|rgba(255, 246, 210, 0.66)|10.0000|4.4682|1.0000|7.0637",
  "fillRect|rgba(46, 169, 255, 0.47)|10.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(72, 83, 100, 0.5486251491971231)|11.0000|4.3210|1.0000|7.3580",
  "fillRect|rgba(30, 144, 255, 0.4343588586346172)|11.0000|3.6056|1.0000|8.7887",
  "fillRect|rgba(76, 241, 112, 0.40664242424242425)|11.0000|4.8320|1.0000|6.3361",
  "fillRect|rgba(255, 182, 65, 0.44000000000000006)|11.0000|6.2627|1.0000|3.4746",
  "fillRect|rgba(255, 246, 210, 0.66)|11.0000|4.4682|1.0000|7.0637",
  "fillRect|rgba(46, 169, 255, 0.47)|11.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(255, 89, 64, 0.5750685450389378)|12.0000|4.0212|1.0000|7.9515",
  "fillRect|rgba(30, 144, 255, 0.09869848118563243)|12.0000|5.1308|1.0000|5.7384",
  "fillRect|rgba(76, 241, 112, 0.563490909090909)|12.0000|4.0273|1.0000|7.9454",
  "fillRect|rgba(255, 182, 65, 0.405)|12.0000|5.6274|1.0000|4.7452",
  "fillRect|rgba(255, 89, 64, 0.2)|12.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(255, 89, 64, 0.5750685450389378)|13.0000|4.0212|1.0000|7.9515",
  "fillRect|rgba(30, 144, 255, 0.09869848118563243)|13.0000|5.1308|1.0000|5.7384",
  "fillRect|rgba(76, 241, 112, 0.563490909090909)|13.0000|4.0273|1.0000|7.9454",
  "fillRect|rgba(255, 182, 65, 0.405)|13.0000|5.6274|1.0000|4.7452",
  "fillRect|rgba(255, 89, 64, 0.2)|13.0000|14.0000|1.0000|1.0000",
  "fillRect|rgba(76, 241, 112, 0.600572915006052)|14.0000|3.5085|1.0000|8.7430",
  "fillRect|rgba(30, 144, 255, 0.27281715647201227)|14.0000|3.9257|1.0000|8.1486",
  "fillRect|rgba(76, 241, 112, 0.1336727272727273)|14.0000|5.9924|1.0000|4.0153",
  "fillRect|rgba(255, 182, 65, 0.562)|14.0000|5.0476|1.0000|5.9048",
  "fillRect|rgba(255, 246, 210, 0.030017156472012252)|14.0000|3.6882|1.0000|8.3932",
  "fillRect|rgba(76, 241, 112, 0.600572915006052)|15.0000|3.5085|1.0000|8.7430",
  "fillRect|rgba(30, 144, 255, 0.27281715647201227)|15.0000|3.9257|1.0000|8.1486",
  "fillRect|rgba(76, 241, 112, 0.1336727272727273)|15.0000|5.9924|1.0000|4.0153",
  "fillRect|rgba(255, 182, 65, 0.562)|15.0000|5.0476|1.0000|5.9048",
  "fillRect|rgba(255, 246, 210, 0.030017156472012252)|15.0000|3.6882|1.0000|8.3932",
  "fillRect|rgba(46, 169, 255, 0.6252826467725419)|16.0000|2.9958|1.0000|9.5846",
  "fillRect|rgba(30, 144, 255, 0.4467488580641275)|16.0000|2.6040|1.0000|10.7920",
  "fillRect|rgba(76, 241, 112, 0.2905212121212122)|16.0000|4.9883|1.0000|6.0234",
  "fillRect|rgba(255, 182, 65, 0.094)|16.0000|6.9961|1.0000|2.0078",
  "fillRect|rgba(255, 246, 210, 0.1979488580641275)|16.0000|3.1960|1.0000|9.2012",
  "fillRect|rgba(46, 169, 255, 0.47)|16.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(46, 169, 255, 0.6252826467725419)|17.0000|2.9958|1.0000|9.5846",
  "fillRect|rgba(30, 144, 255, 0.4467488580641275)|17.0000|2.6040|1.0000|10.7920",
  "fillRect|rgba(76, 241, 112, 0.2905212121212122)|17.0000|4.9883|1.0000|6.0234",
  "fillRect|rgba(255, 182, 65, 0.094)|17.0000|6.9961|1.0000|2.0078",
  "fillRect|rgba(255, 246, 210, 0.1979488580641275)|17.0000|3.1960|1.0000|9.2012",
  "fillRect|rgba(46, 169, 255, 0.47)|17.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(255, 182, 65, 0.6493079455407463)|18.0000|2.4831|1.0000|10.5759",
  "fillRect|rgba(30, 144, 255, 0.11051951659782266)|18.0000|4.5530|1.0000|6.8940",
  "fillRect|rgba(76, 241, 112, 0.447369696969697)|18.0000|3.8901|1.0000|8.2198",
  "fillRect|rgba(255, 182, 65, 0.251)|18.0000|6.3428|1.0000|3.3144",
  "fillRect|rgba(255, 246, 210, 0.36571951659782265)|18.0000|2.7037|1.0000|10.1528",
  "fillRect|rgba(255, 182, 65, 0.6493079455407463)|19.0000|2.4831|1.0000|10.5759",
  "fillRect|rgba(30, 144, 255, 0.11051951659782266)|19.0000|4.5530|1.0000|6.8940",
  "fillRect|rgba(76, 241, 112, 0.447369696969697)|19.0000|3.8901|1.0000|8.2198",
  "fillRect|rgba(255, 182, 65, 0.251)|19.0000|6.3428|1.0000|3.3144",
  "fillRect|rgba(255, 246, 210, 0.36571951659782265)|19.0000|2.7037|1.0000|10.1528",
  "fillRect|rgba(188, 168, 255, 0.6727352621442041)|20.0000|1.9703|1.0000|11.5671",
  "fillRect|rgba(30, 144, 255, 0.2841494734456951)|20.0000|3.1907|1.0000|9.6187",
  "fillRect|rgba(76, 241, 112, 0.6)|20.0000|2.9816|1.0000|10.0369",
  "fillRect|rgba(255, 182, 65, 0.40800000000000003)|20.0000|5.6302|1.0000|4.7396",
  "fillRect|rgba(255, 246, 210, 0.533349473445695)|20.0000|2.2115|1.0000|11.1044",
  "fillRect|rgba(188, 168, 255, 0.6727352621442041)|21.0000|1.9703|1.0000|11.5671",
  "fillRect|rgba(30, 144, 255, 0.2841494734456951)|21.0000|3.1907|1.0000|9.6187",
  "fillRect|rgba(76, 241, 112, 0.6)|21.0000|2.9816|1.0000|10.0369",
  "fillRect|rgba(255, 182, 65, 0.40800000000000003)|21.0000|5.6302|1.0000|4.7396",
  "fillRect|rgba(255, 246, 210, 0.533349473445695)|21.0000|2.2115|1.0000|11.1044",
  "fillRect|rgba(72, 83, 100, 0.6956339430391494)|22.0000|1.4576|1.0000|12.5584",
  "fillRect|rgba(30, 144, 255, 0.45765504542097635)|22.0000|1.7224|1.0000|12.5553",
  "fillRect|rgba(76, 241, 112, 0.17440000000000003)|22.0000|5.5181|1.0000|4.9637",
  "fillRect|rgba(255, 182, 65, 0.5650000000000001)|22.0000|4.8612|1.0000|6.2776",
  "fillRect|rgba(255, 246, 210, 0.66)|22.0000|1.7193|1.0000|12.0561",
  "fillRect|rgba(46, 169, 255, 0.47)|22.0000|12.0000|1.0000|3.0000",
  "fillRect|rgba(72, 83, 100, 0.6956339430391494)|23.0000|1.4576|1.0000|12.5584",
  "fillRect|rgba(30, 144, 255, 0.45765504542097635)|23.0000|1.7224|1.0000|12.5553",
  "fillRect|rgba(76, 241, 112, 0.17440000000000003)|23.0000|5.5181|1.0000|4.9637",
  "fillRect|rgba(255, 182, 65, 0.5650000000000001)|23.0000|4.8612|1.0000|6.2776",
  "fillRect|rgba(255, 246, 210, 0.66)|23.0000|1.7193|1.0000|12.0561",
  "fillRect|rgba(46, 169, 255, 0.47)|23.0000|12.0000|1.0000|3.0000",
  "fillRect|gradient|0.0000|7.5000|24.0000|1.0000",
  "fillRect|gradient|0.0000|0.0000|24.0000|16.0000",
];

const GOLDEN_GRADIENTS: string[] = [
  "created",
  "#06070d",
  "#0e1018",
  "#05060a",
  "created",
  "rgba(255,255,255,0.04)",
  "rgba(255,255,255,0.32)",
  "rgba(255,255,255,0.04)",
  "created",
  "rgba(0,0,0,0.34)",
  "rgba(0,0,0,0)",
  "rgba(0,0,0,0)",
  "rgba(0,0,0,0.36)",
];

/**
 * The precision the golden's colour alphas are compared at: 12 decimal places.
 *
 * The alphas come out of `Math.pow(peak, 0.58)`, and ECMAScript leaves
 * `Math.pow` implementation-approximated: V8's result can differ in the last
 * bit between builds and CPUs, which is exactly how this golden broke — a
 * 16th significant digit, 0.5750685450389379 against the ...378 it was
 * generated with. Twelve places is a thousand times finer than any colour a
 * canvas can show (8 bits per channel) and still catches every real change to
 * the drawing, so the golden keeps proving what it proves on every machine.
 */
const ALPHA_DECIMALS = 12;

/** `s` with every number of more than {@link ALPHA_DECIMALS} decimals rounded
 *  to that many. Geometry is already fixed at 4 decimals by `serialize`. */
function atGoldenPrecision(s: string): string {
  return s.replace(/\d+\.\d{13,}/g, (n) => String(Number(Number(n).toFixed(ALPHA_DECIMALS))));
}

/** One line per paint op, so a mismatch names the op that moved. */
function serialize(calls: { kind: string; style: unknown; x: number; y: number; w: number; h: number }[]): string[] {
  return calls.map((c) =>
    atGoldenPrecision(
      `${c.kind}|${typeof c.style === 'object' && c.style !== null ? 'gradient' : String(c.style)}` +
        `|${c.x.toFixed(4)}|${c.y.toFixed(4)}|${c.w.toFixed(4)}|${c.h.toFixed(4)}`,
    ),
  );
}

{
  // The rounding itself: last-bit noise disappears, a real change does not.
  assert.equal(
    atGoldenPrecision('rgba(255, 89, 64, 0.5750685450389379)'),
    atGoldenPrecision('rgba(255, 89, 64, 0.5750685450389378)'),
    'two alphas one ulp apart compare equal',
  );
  assert.notEqual(
    atGoldenPrecision('rgba(255, 89, 64, 0.5750685450389378)'),
    atGoldenPrecision('rgba(255, 89, 64, 0.5750685450399378)'),
    'a difference in the 12th decimal is still caught',
  );
  assert.equal(atGoldenPrecision('rgba(255, 182, 65, 0.28)'), 'rgba(255, 182, 65, 0.28)', 'short numbers are untouched');
}

{
  const golden = GOLDEN_CALLS.map(atGoldenPrecision);
  const direct = makeFakeCanvas();
  drawWaveform(direct.canvas, GOLDEN_BOX, goldenBins(), 0, 1, false, null);
  assert.deepEqual(
    serialize(direct.calls),
    golden,
    'drawWaveform must paint exactly what it painted before DJ-2 split it into helpers',
  );
  assert.deepEqual(direct.gradients, GOLDEN_GRADIENTS, 'including every gradient stop, in order');

  const cached = makeFakeCanvas();
  drawWaveformCached(cached.canvas, GOLDEN_BOX, goldenBins(), 0, 1, false, null, 'golden');
  assert.deepEqual(
    serialize(cached.calls),
    golden,
    'and the full view through drawWaveformCached reproduces the same pre-DJ-2 output',
  );
  assert.deepEqual(cached.gradients, GOLDEN_GRADIENTS);
}

// DJ-2R item 1: the window must engage at the geometry the APP actually uses.
// `DJView`'s detail lane runs at zoom 8 (span 0.125) with
// `viewMin = -visibleFrac / 2`, so the viewport starts BEFORE the track for
// the first ~6% of it and runs past the end for the last ~6%. Rejecting that
// case sent every detail-lane frame - six a second per playing deck - down
// the slow path, which is the entire cost the window exists to remove.
const LANE: CanvasBox = { cssWidth: 600, cssHeight: 64, deviceWidth: 1200, deviceHeight: 128, scale: 2, zoom: 8, dpr: 2 };

const near = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-6, `${what}: ${a} vs ${b}`);

{
  offscreens.length = 0;
  const lane = makeFakeCanvas();
  // Start of the track: half the lane is off the left-hand end. The first
  // frame is direct; the next one (the deck playing on) builds the window.
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, -0.0625, 0.0625, false, null, 'detail-lane');
  clearFrame(lane);
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, -0.06, 0.065, false, null, 'detail-lane');
  assert.equal(offscreens.length, 1, 'the app’s real detail lane must build a window render');
  assert.equal(lane.images.length, 1, 'and blit the in-range part of it');
  // The out-of-range part is left as background: the blit is inset by the
  // part of the viewport before the track and covers only what has audio.
  near(lane.images[0].dx, (0.06 / 0.125) * 600, 'the blit is inset by the part of the viewport before the track');
  near(lane.images[0].dw, (0.065 / 0.125) * 600, 'and covers only the part that has audio');
  assert.equal(lane.images[0].sx, 0, 'reading from the very start of the render');

  // End of the track: the overhang is on the right instead.
  clearFrame(lane);
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.9375, 1.0625, false, null, 'detail-lane');
  assert.equal(lane.images.length, 1);
  assert.equal(lane.images[0].dx, 0, 'an overhang past the END starts the blit at the left edge');
  near(lane.images[0].dw, 300, 'and still covers only the half that has audio');

  // And the ordinary mid-track pan at that zoom fills the lane edge to edge,
  // one device pixel of the window per device pixel of the lane.
  clearFrame(lane);
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.4, 0.525, false, null, 'detail-lane');
  clearFrame(lane);
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.41, 0.535, false, null, 'detail-lane');
  assert.equal(lane.images[0].dx, 0);
  near(lane.images[0].dw, 600, 'a fully in-range viewport blits the whole lane');
  assert.ok(lane.images[0].sx > 0, 'from further into the render');
  assert.equal(lane.images[0].sw, Math.round(lane.images[0].dw * LANE.scale), 'at 1:1, never resampled');
}

// PR #207 review: deep zoom stays SHARP and costs one window, not the track.
// At 36x on a 1,300 px lane at dpr 2 the whole track is 93,600 device px. The
// PR rendered all 46,800 columns into an offscreen clamped to 8,192 px and
// stretched a ~230 px slice of it across the 2,600 px lane.
const DEEP: CanvasBox = { cssWidth: 1300, cssHeight: 64, deviceWidth: 2600, deviceHeight: 128, scale: 2, zoom: 1, dpr: 2 };

{
  offscreens.length = 0;
  const lane = makeFakeCanvas();
  const span = 1 / 36;
  drawWaveformCached(lane.canvas, DEEP, REAL_BINS, 0.5, 0.5 + span, false, null, 'deep');
  clearFrame(lane);
  drawWaveformCached(lane.canvas, DEEP, REAL_BINS, 0.5005, 0.5005 + span, false, null, 'deep');
  assert.equal(offscreens.length, 1);
  const win = offscreens[0];
  assert.ok(win.canvas.width <= MAX_CANVAS_DEVICE_WIDTH, `the window fits one canvas, got ${win.canvas.width}`);
  assert.ok(
    columnsPainted(win) <= DEEP.cssWidth * 3 + 2,
    `the window paints about three lane widths of columns, not the whole track (${columnsPainted(win)})`,
  );
  assert.equal(lane.images.length, 1);
  assert.equal(
    lane.images[0].sw,
    Math.round(lane.images[0].dw * DEEP.scale),
    'the blit copies device pixels 1:1 — the 8,192 px clamp stretched them into a blur',
  );
}

// PR #207 review: continuous wheel zoom on one deck never evicts the other.
// The sequence from the DJ tab: deck B is playing (its lane has a window);
// the user wheel-zooms deck A, one event per notch. Every event was a new key
// in ONE 4-slot cache shared by every lane, so the fifth notch pushed deck B
// out and deck B re-rendered its whole track on its next frame.
{
  offscreens.length = 0;
  const deckB = makeFakeCanvas();
  drawWaveformCached(deckB.canvas, LANE, REAL_BINS, 0.4, 0.525, false, null, 'deck-b');
  drawWaveformCached(deckB.canvas, LANE, REAL_BINS, 0.401, 0.526, false, null, 'deck-b');
  assert.equal(offscreens.length, 1, 'deck B has its window');
  const deckBWindow = offscreens[0];
  const deckBPaint = deckBWindow.calls.length;

  const deckA = makeFakeCanvas();
  for (const zoom of [8, 9.5, 11, 13, 15, 18, 21, 25, 30, 36]) {
    clearFrame(deckA);
    const span = 1 / zoom;
    drawWaveformCached(deckA.canvas, LANE, REAL_BINS, 0.3 - span / 2, 0.3 + span / 2, false, null, 'deck-a');
    assert.ok(
      columnsPainted(deckA) <= LANE.cssWidth,
      `a wheel notch at ${zoom}x paints one lane width (${columnsPainted(deckA)} columns)`,
    );
  }
  assert.equal(offscreens.length, 1, 'wheel zoom renders no offscreen track at every notch');

  const beforeNext = deckB.images.length;
  drawWaveformCached(deckB.canvas, LANE, REAL_BINS, 0.402, 0.527, false, null, 'deck-b');
  assert.equal(offscreens.length, 1, 'deck B’s next frame needs no new render');
  assert.equal(deckBWindow.calls.length, deckBPaint, 'its window was never repainted');
  assert.equal(deckB.images.length, beforeNext + 1, 'it is still one blit');
}

{
  // DJView passes `viewEnd = viewStart + visibleFrac`, so the span it hands
  // over wobbles in its last bits from frame to frame (0.335 - 0.21 is
  // 0.12500000000000003). A playing deck at a steady zoom must still be one
  // window and a blit per frame, not a fresh direct draw every time.
  offscreens.length = 0;
  const lane = makeFakeCanvas();
  const visibleFrac = 0.125;
  let blits = 0;
  for (let frame = 0; frame < 12; frame += 1) {
    const viewStart = 0.21 + frame * 0.0071;
    clearFrame(lane);
    drawWaveformCached(lane.canvas, LANE, REAL_BINS, viewStart, viewStart + visibleFrac, false, null, 'playing');
    blits += lane.images.length;
  }
  assert.equal(offscreens.length, 1, 'one window serves the steady zoom');
  assert.equal(blits, 11, 'every frame after the first is a blit');
}

{
  // A viewport that covers the whole track, however it over-scrolls, still
  // goes straight to drawWaveform - there is nothing to cache.
  offscreens.length = 0;
  const whole = makeFakeCanvas();
  drawWaveformCached(whole.canvas, LANE, REAL_BINS, -0.1, 1.1, false, null, 'whole');
  drawWaveformCached(whole.canvas, LANE, REAL_BINS, -0.1, 1.1, false, null, 'whole');
  assert.equal(offscreens.length, 0, 'a whole-track viewport builds no offscreen render');
  assert.equal(whole.images.length, 0, 'and blits nothing');
}

// The EDIT timeline's ClipWave box is the clip's duration times the
// timeline's zoom: a 220 s clip at 400 px/s is an 88,000 px wide wrapper. A
// canvas that fills it asks for a backing store no browser allocates (the
// blank-clip regression); the PR instead drew it into an 8,192 px offscreen
// and stretched that over the box, so EDIT chops blurred at deep zoom.
// `canvasWindowFor` puts the visible canvas over the on-screen part only, at
// full resolution.
{
  const wrapWidth = 88_000;
  const fits = canvasWindowFor({ wrapLeft: 0, wrapWidth: 12_000, visibleLeft: 0, visibleRight: 1600, zoom: 1, dpr: 1 });
  assert.equal(fits, null, 'a wrapper one canvas can back keeps the plain full-size canvas');

  const atStart = canvasWindowFor({ wrapLeft: 0, wrapWidth, visibleLeft: 0, visibleRight: 1600, zoom: 1, dpr: 1 });
  assert.ok(atStart, 'an 88,000 px clip gets a window');
  assert.ok(atStart.width <= MAX_CANVAS_DEVICE_WIDTH, 'no wider than one canvas');
  assert.ok(atStart.left <= 0 && atStart.left + atStart.width >= 1600, 'covering what is on screen');

  // The timeline scrolled: the clip's left edge is now 40,000 px off-screen.
  const scrolled = canvasWindowFor({ wrapLeft: -40_000, wrapWidth, visibleLeft: 0, visibleRight: 1600, zoom: 1, dpr: 1 });
  assert.ok(scrolled);
  assert.ok(scrolled.left <= 40_000 && scrolled.left + scrolled.width >= 41_600, 'the window follows the scroll');

  // At a CSS zoom of 1.25 on a dpr-2 display the device budget is in device px.
  const hiDpi = canvasWindowFor({ wrapLeft: 0, wrapWidth: wrapWidth * 1.25, visibleLeft: 0, visibleRight: 2000, zoom: 1.25, dpr: 2 });
  assert.ok(hiDpi && hiDpi.width * 1.25 * 2 <= MAX_CANVAS_DEVICE_WIDTH, 'the budget counts device pixels');

  // Drawn the way DJSemanticWaveform draws the window: the viewport slice
  // under the canvas, into a box the canvas can back, column for column.
  offscreens.length = 0;
  const win = scrolled;
  const box: CanvasBox = { cssWidth: win.width, cssHeight: 64, deviceWidth: Math.round(win.width), deviceHeight: 64, scale: 1, zoom: 1, dpr: 1 };
  const clip = makeFakeCanvas();
  drawWaveformCached(clip.canvas, box, REAL_BINS, win.left / wrapWidth, (win.left + win.width) / wrapWidth, false, null, 'edit-clip');
  assert.equal(clip.canvas.width, box.deviceWidth, 'the visible canvas is backed at full resolution');
  assert.ok(clip.canvas.width <= MAX_CANVAS_DEVICE_WIDTH);
  assert.equal(clip.images.length, 0, 'drawn directly, nothing stretched');
  assert.ok(columnsPainted(clip) >= Math.floor(win.width) - 1, 'one column per pixel of the window');
  assert.equal(offscreens.length, 0);
}

{
  // A decode error and the "no data yet" state keep going straight through to
  // drawWaveform — the FE-011 / FE-021 behaviour pinned above is untouched.
  offscreens.length = 0;
  const errored = makeFakeCanvas();
  drawWaveformCached(errored.canvas, BOX, REAL_BINS, 0.2, 0.4, false, 'Unable to load audio waveform: 404', 'err');
  assert.ok(errored.calls.some((c) => c.kind === 'strokeRect'), 'the error state still paints its border');
  assert.equal(offscreens.length, 0, 'and never builds an offscreen render');

  const empty = makeFakeCanvas();
  drawWaveformCached(empty.canvas, BOX, [], 0.2, 0.4, false, null, 'empty');
  assert.equal(empty.images.length, 0);
  assert.equal(offscreens.length, 0);
}

// ── waveform display modes: semantic (default) / plain / clipping ──────────

/** `createLinearGradient` hands back a fresh object each call, so compare a
 *  projection where a gradient style is just "gradient" (matches the
 *  `normalize` helper used above, module-scoped here for reuse). */
function normalizeCalls(calls: ReturnType<typeof makeFakeCanvas>['calls']) {
  return calls.map((c) => ({ ...c, style: typeof c.style === 'object' && c.style !== null ? 'gradient' : String(c.style) }));
}

function modeBins(): WaveBin[] {
  return [
    // Holds clipped samples: the case 'clipping' mode must flag.
    { peak: 0.99, rms: 0.7, min: -0.98, max: 0.99, low: 0.6, mid: 0.2, bright: 0.1, transient: 0.1, color: '#ff3f4f', clipped: 3 },
    // Ordinary level: must NOT be flagged, in either non-semantic mode.
    { peak: 0.5, rms: 0.3, min: -0.45, max: 0.5, low: 0.1, mid: 0.6, bright: 0.2, transient: 0.05, color: '#72ee78', clipped: 0 },
  ];
}
const MODE_BOX: CanvasBox = { cssWidth: 2, cssHeight: 16, deviceWidth: 2, deviceHeight: 16, scale: 1, zoom: 1, dpr: 1 };

{
  // Default (omitted) and explicit 'semantic' must be the exact same call —
  // every existing caller that never passes a mode keeps its exact output.
  const omitted = makeFakeCanvas();
  drawWaveform(omitted.canvas, MODE_BOX, modeBins(), 0, 1, false, null);
  const explicit = makeFakeCanvas();
  drawWaveform(explicit.canvas, MODE_BOX, modeBins(), 0, 1, false, null, 'semantic');
  assert.deepEqual(normalizeCalls(explicit.calls), normalizeCalls(omitted.calls), "mode: 'semantic' must be byte-identical to omitting mode");
  assert.deepEqual(explicit.gradients, omitted.gradients);
}

{
  // 'plain': one flat colour for every bin, not the per-bin semantic colour,
  // and none of the frequency-glow layers (far fewer fillRect calls).
  const semantic = makeFakeCanvas();
  drawWaveform(semantic.canvas, MODE_BOX, modeBins(), 0, 1, false, null, 'semantic');
  const plain = makeFakeCanvas();
  drawWaveform(plain.canvas, MODE_BOX, modeBins(), 0, 1, false, null, 'plain');

  assert.ok(plain.calls.length < semantic.calls.length, 'plain skips the frequency-glow layers');
  const plainFills = plain.calls.filter((c) => c.kind === 'fillRect' && typeof c.style === 'string' && (c.style as string).startsWith('rgba(188, 196, 214'));
  assert.equal(plainFills.length, 2, 'both bins use the one flat plain colour');
  assert.ok(
    !plain.calls.some((c) => typeof c.style === 'string' && ((c.style as string).includes('255, 89, 64') || (c.style as string).includes('30, 144, 255'))),
    'plain never paints the beat-rail or low-glow colours',
  );
}

{
  // 'clipping': the bin holding clipped samples is flagged red; the ordinary
  // bin stays the plain neutral colour, same as 'plain' mode.
  const clipping = makeFakeCanvas();
  drawWaveform(clipping.canvas, MODE_BOX, modeBins(), 0, 1, false, null, 'clipping');
  const bodyFills = clipping.calls.filter(
    (c) => c.kind === 'fillRect' && typeof c.style === 'string'
      && ((c.style as string).startsWith('rgba(255, 61, 79') || (c.style as string).startsWith('rgba(188, 196, 214')),
  );
  assert.equal(bodyFills.length, 2, 'one body fill per column at this box width');
  assert.ok((bodyFills[0].style as string).startsWith('rgba(255, 61, 79'), `column 0 (clipped samples) must be flagged red, got ${bodyFills[0].style}`);
  assert.ok((bodyFills[1].style as string).startsWith('rgba(188, 196, 214'), `column 1 (none clipped) must stay plain, got ${bodyFills[1].style}`);

  // The drawn peak says nothing about clipping: a normalised waveform's
  // loudest bin is 1.0 whatever the file's level. Only the clip count flags.
  const loudestOfNormalised = makeFakeCanvas();
  drawWaveform(loudestOfNormalised.canvas, MODE_BOX, [
    { peak: 1, rms: 0.6, min: -1, max: 1, low: 0.5, mid: 0.2, bright: 0.1, transient: 0.1, color: '#ff3f4f', clipped: 0 },
    modeBins()[1],
  ], 0, 1, false, null, 'clipping');
  const loudestFill = loudestOfNormalised.calls.find(
    (c) => c.kind === 'fillRect' && typeof c.style === 'string'
      && ((c.style as string).startsWith('rgba(255, 61, 79') || (c.style as string).startsWith('rgba(188, 196, 214')),
  );
  assert.ok(loudestFill && (loudestFill.style as string).startsWith('rgba(188, 196, 214'), 'a peak of 1.0 with no clipped sample is not flagged');
}

{
  // drawWaveformCached: a window is rasterised body, so switching modes on an
  // otherwise-unchanged zoomed lane must redraw in the new colours instead of
  // blitting the old mode's window.
  offscreens.length = 0;
  const lane = makeFakeCanvas();
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.4, 0.525, false, null, 'mode-key', 'semantic');
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.401, 0.526, false, null, 'mode-key', 'semantic');
  assert.equal(offscreens.length, 1, 'the semantic window');

  clearFrame(lane);
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.402, 0.527, false, null, 'mode-key', 'plain');
  assert.equal(lane.images.length, 0, 'a mode switch never blits the old mode’s window');
  assert.ok(
    lane.calls.some((c) => typeof c.style === 'string' && c.style.startsWith('rgba(188, 196, 214')),
    'the switched frame is painted in the plain colour',
  );

  // Scrolling on in the new mode builds a window of its own, in its colours.
  clearFrame(lane);
  drawWaveformCached(lane.canvas, LANE, REAL_BINS, 0.403, 0.528, false, null, 'mode-key', 'plain');
  assert.equal(offscreens.length, 2, 'a new window for the new mode');
  assert.ok(offscreens[1].calls.some((c) => typeof c.style === 'string' && c.style.startsWith('rgba(188, 196, 214')));
  assert.equal(lane.images.length, 1);
}

console.log('DJSemanticWaveform.b12.test.ts OK');
