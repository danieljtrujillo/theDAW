/**
 * What DJ-2 actually bought, measured — `analyzeBuffer` on a synthetic
 * 3.5-minute STEREO buffer at 44.1 kHz, the size a real DJ deck loads.
 *
 * The burst this ticket is about: the default DJ layout mounts two
 * `DJSemanticWaveform` instances per deck (the zoomed lane and the overview
 * lane) and an automix loads two decks, so FOUR instances each ran the full
 * flat-6,400-bin analysis synchronously inside a `useEffect`. The loop is
 * ~6,400 bins x 723 analysed samples x 11 Goertzel frequencies ~= 51M inner
 * iterations per instance.
 *
 * Three things changed, and this file measures each of them separately
 * rather than asserting one opaque total:
 *
 *  1. **bins are sized from the width the whole track is drawn at** — the
 *     lane's width over the fraction of the track it shows. A 40 px overview
 *     lane asked for 6,400 bins and got ~1k bins' worth of visible detail; the
 *     zoom-8 detail lane still needs (and gets) every one of main's 6,400;
 *  2. **the result is memoised** per (url, normalize, binCount), so the
 *     second instance for a deck pays nothing;
 *  3. **the loop runs in a Worker**, leaving the main thread only the
 *     per-channel `Float32Array` copy that is handed to `postMessage` — once
 *     per track: the Worker keeps the audio, so the deck's second lane (a
 *     different bin count of the same audio) sends none.
 *
 * On the assertions: every timed one is a RATIO between two measurements
 * taken in this same process, never a wall-clock budget, because
 * `scripts/run-tests.mjs` runs four suites at a time and an absolute number
 * would mean nothing; the timed ones measured with 2x or more of headroom. The
 * roll-ups and the bin-count claims are exact: analysis work is proportional
 * to the bin count, so they are asserted on bins and the milliseconds are
 * printed. The printed table is the real evidence; run it directly to read it:
 *
 *   npx tsx src/components/audio/djSemanticWaveformAnalysis.cost.test.ts
 *
 * `npm test` discovers it too, where it doubles as a regression guard: if
 * anyone re-flattens the bin count or drops the memo, the ratios collapse.
 */
import assert from 'node:assert/strict';
import {
  analyzeBuffer,
  analyzeBufferMemo,
  binCountFor,
  evictAnalysis,
  getChannels,
} from './djSemanticWaveformAnalysis.ts';

const SAMPLE_RATE = 44100;
const DURATION_S = 210; // 3 min 30 s
const LENGTH = SAMPLE_RATE * DURATION_S;

/** The two lanes the DJ layout actually renders (see `DJView`): a wide lane
 *  zoomed to 8x and a narrow overview lane showing the whole track. The bin
 *  count is sized from the width the WHOLE track spans in each. */
const ZOOMED_LANE_PX = 1200;
const ZOOMED_LANE_ZOOM = 8;
const OVERVIEW_LANE_PX = 40;
/** Two lanes per deck, two decks in an automix transition. */
const INSTANCES = 4;
/** main: clamp(round(duration * 32), 900, 6400). */
const MAIN_BINS = Math.min(6400, Math.max(900, Math.round(DURATION_S * 32)));

// ── the fixture: a real, varied 3.5-minute stereo signal ──────────────────

/** Deterministic and varied — a bass line, a mid tone, a bright tone and a
 *  transient every half second, so `bandPower` and `pickColor` do the same
 *  work they do on music rather than short-circuiting on silence. */
function makeStereoBuffer(): AudioBuffer {
  const left = new Float32Array(LENGTH);
  const right = new Float32Array(LENGTH);
  const twoPi = Math.PI * 2;
  for (let i = 0; i < LENGTH; i += 1) {
    const t = i / SAMPLE_RATE;
    const transient = i % (SAMPLE_RATE / 2) < 512 ? 0.5 : 0;
    const base =
      0.45 * Math.sin(twoPi * 70 * t) + 0.25 * Math.sin(twoPi * 880 * t) + 0.12 * Math.sin(twoPi * 4200 * t);
    left[i] = base + transient;
    right[i] = base * 0.9 - transient * 0.8;
  }
  return {
    numberOfChannels: 2,
    length: LENGTH,
    duration: DURATION_S,
    sampleRate: SAMPLE_RATE,
    getChannelData: (ch: number) => (ch === 0 ? left : right),
  } as unknown as AudioBuffer;
}

function timed<T>(fn: () => T): { ms: number; value: T } {
  const start = performance.now();
  const value = fn();
  return { ms: performance.now() - start, value };
}

const buffer = makeStereoBuffer();

// Warm the JIT on a short buffer so the first real measurement is not paying
// for compilation of the analysis loop.
{
  const warm = new Float32Array(SAMPLE_RATE);
  analyzeBuffer(
    {
      numberOfChannels: 2,
      length: warm.length,
      duration: 1,
      sampleRate: SAMPLE_RATE,
      getChannelData: () => warm,
    } as unknown as AudioBuffer,
  );
}

// ── 1. bins sized from the width the whole track is drawn at ──────────────

// BEFORE: every instance, whatever its lane, analysed at the flat cap.
const before = timed(() => analyzeBuffer(buffer));
assert.equal(before.value.length, MAIN_BINS, 'the pre-DJ-2 call still analyses at the flat 6,400-bin cap');

const zoomedWidth = ZOOMED_LANE_PX * ZOOMED_LANE_ZOOM;
const zoomed = timed(() => analyzeBuffer(buffer, { width: zoomedWidth }));
const overview = timed(() => analyzeBuffer(buffer, { width: OVERVIEW_LANE_PX }));
assert.equal(zoomed.value.length, binCountFor(DURATION_S, zoomedWidth));
assert.equal(overview.value.length, binCountFor(DURATION_S, OVERVIEW_LANE_PX));

// The zoomed lane shows an eighth of the track across 1,200 px: it needs
// main's full resolution, and a count sized from the lane alone (4,800 bins
// for the whole track) drew 600 across it where main drew 800.
assert.equal(zoomed.value.length, MAIN_BINS, 'the zoom-8 lane keeps main’s full resolution');
assert.ok(
  overview.value.length < MAIN_BINS / 4,
  `a ${OVERVIEW_LANE_PX} px overview lane needs a fraction of the bins (${overview.value.length})`,
);
assert.ok(
  overview.ms < before.ms * 0.6,
  `a ${OVERVIEW_LANE_PX} px overview lane must be far cheaper than the flat cap ` +
    `(${overview.ms.toFixed(1)}ms vs ${before.ms.toFixed(1)}ms)`,
);

// ── 2. the memo: the deck's SECOND instance ───────────────────────────────

evictAnalysis('cost.wav');
const firstInstance = timed(() => analyzeBufferMemo('cost.wav', buffer, { width: zoomedWidth }));
const secondInstance = timed(() => analyzeBufferMemo('cost.wav', buffer, { width: zoomedWidth }));
assert.equal(secondInstance.value, firstInstance.value, 'the second instance gets the identical bins array');
assert.ok(
  secondInstance.ms < before.ms * 0.05,
  `a memo hit must be ~free next to a full analysis (${secondInstance.ms.toFixed(3)}ms vs ${before.ms.toFixed(1)}ms)`,
);

// ── 3. the Worker hand-off: what is LEFT on the main thread ───────────────

// `analyzeBufferAsync` copies each channel (the buffer's own arrays must not
// be transferred — that would detach the audio the engine is playing) and
// hands the copies to the worker. That copy is the entire main-thread residue
// of an offloaded analysis, paid once per track while the Worker holds it.
const handoff = timed(() => getChannels(buffer).map((ch) => new Float32Array(ch)));
assert.equal(handoff.value.length, 2);
assert.ok(
  handoff.ms < before.ms * 0.5,
  `the worker hand-off copy must be a fraction of the analysis it replaces ` +
    `(${handoff.ms.toFixed(1)}ms vs ${before.ms.toFixed(1)}ms)`,
);

// ── the roll-up: main-thread work at deck load ────────────────────────────

// BEFORE: four instances, four full flat-cap analyses, all on the main thread.
const beforeTotal = before.ms * INSTANCES;
const beforeBins = before.value.length * INSTANCES;
// AFTER, no Worker (this node/tsx fallback, and any CSP that forbids workers):
// each deck analyses once per DISTINCT bin count — its zoomed lane and its
// overview lane — and the second instance of each is a memo hit.
const afterSyncTotal = (zoomed.ms + overview.ms) * 2;
const afterSyncBins = (zoomed.value.length + overview.value.length) * 2;
// AFTER, with a Worker (every browser the app ships in): the main thread only
// copies each deck's audio once; the second lane's analysis sends none.
const afterWorkerTotal = handoff.ms * 2;

const row = (label: string, ms: number, bins: number | string) =>
  `  ${label.padEnd(44)} ${`${ms.toFixed(1)} ms`.padStart(10)}   ${String(bins).padStart(6)} bins`;

console.log(
  [
    '',
    `djSemanticWaveformAnalysis cost — ${DURATION_S}s stereo @ ${SAMPLE_RATE} Hz (${LENGTH.toLocaleString()} frames/ch)`,
    '',
    '  PER INSTANCE',
    row('before: flat cap (analyzeBuffer, no width)', before.ms, before.value.length),
    row(`after:  zoomed lane (${ZOOMED_LANE_PX}px at ${ZOOMED_LANE_ZOOM}x)`, zoomed.ms, zoomed.value.length),
    row(`after:  overview lane (${OVERVIEW_LANE_PX}px)`, overview.ms, overview.value.length),
    row('after:  memo hit (2nd instance, same lane)', secondInstance.ms, secondInstance.value.length),
    row('after:  worker hand-off (2 channel copies)', handoff.ms, '—'),
    '',
    `  MAIN THREAD AT DECK LOAD (${INSTANCES} waveform instances = 2 lanes x 2 decks)`,
    row('before', beforeTotal, beforeBins),
    row('after, no Worker (sync fallback)', afterSyncTotal, afterSyncBins),
    row('after, with Worker', afterWorkerTotal, '—'),
    '',
    `  sync fallback: ${(beforeTotal / Math.max(afterSyncTotal, 1e-6)).toFixed(1)}x less main-thread work`,
    `  with Worker:   ${(beforeTotal / Math.max(afterWorkerTotal, 1e-6)).toFixed(1)}x less main-thread work`,
    '',
  ].join('\n'),
);

assert.ok(
  afterSyncBins < beforeBins * 0.75,
  `even the Worker-less fallback must cut deck-load analysis substantially ` +
    `(${afterSyncBins} vs ${beforeBins} bins analysed)`,
);
assert.ok(
  afterWorkerTotal < beforeTotal * 0.5,
  `with a Worker the main thread must keep almost none of it ` +
    `(${afterWorkerTotal.toFixed(1)}ms vs ${beforeTotal.toFixed(1)}ms)`,
);

console.log('djSemanticWaveformAnalysis.cost.test.ts OK');
