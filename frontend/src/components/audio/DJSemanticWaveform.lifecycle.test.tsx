/**
 * DJSemanticWaveform — the lane's life, replayed (PR #207 review).
 *
 *  - The bin count follows ZOOM. The detail lane shows an eighth of the track;
 *    sized from the lane's own width it analysed 3,840 bins for the whole
 *    track, 480 across the lane where main drew 800.
 *  - A lane resized pixel by pixel re-analyses only when the bin count really
 *    changes. Every 64 px step used to be a new analysis (and, in the browser,
 *    a copy of the whole decoded buffer on the main thread).
 *  - A lane that unmounts mid-download withdraws: the download stops and
 *    nothing lands in the decode cache. Without it an unmounted lane still
 *    filled the four-slot cache.
 *  - A lane that goes away for good evicts its audio from the cache.
 *  - The EDIT timeline's clip keeps ONE object URL across a remount, so the
 *    remount is a cache hit rather than a second download and decode.
 *
 * Real component, real React (react-dom/client + act), under jsdom — the
 * harness `DJSemanticWaveform.perf.test.tsx` uses.
 *
 * Run: `npx tsx src/components/audio/DJSemanticWaveform.lifecycle.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
let latestResize: (() => void) | null = null;
let laneClientWidth = 0;
class FakeResizeObserver {
  constructor(cb: () => void) {
    latestResize = cb;
  }
  observe(): void {}
  disconnect(): void {}
}
Object.defineProperty(dom.window.Element.prototype, 'clientWidth', {
  configurable: true,
  get: () => laneClientWidth,
});
(g.window as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
g.ResizeObserver = FakeResizeObserver;

// ── fetch: counted, and parkable so a download can still be in flight ──────
type Parked = { url: string; signal: AbortSignal | undefined; release: () => void };
const parkUrls = new Set<string>();
const parked: Parked[] = [];
const fetched: string[] = [];
g.fetch = (input: unknown, init?: { signal?: AbortSignal }) => {
  const url = String(input);
  fetched.push(url);
  const respond = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(8) }) as unknown as Response;
  if (!parkUrls.has(url)) return Promise.resolve(respond());
  return new Promise<Response>((resolve, reject) => {
    parked.push({ url, signal: init?.signal, release: () => resolve(respond()) });
    init?.signal?.addEventListener('abort', () => {
      const err = new Error('aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
};

// ── decoding: a 210 s track whose analysis reads are counted ──────────────
let decodeCount = 0;
/** Every fresh analysis reads the channel data once; a memo hit reads none. */
let analysisCalls = 0;
let lastDecoded: AudioBuffer | null = null;
class FakeOfflineAudioContext {
  sampleRate = 44100;
  async decodeAudioData(_buf: ArrayBuffer): Promise<AudioBuffer> {
    decodeCount += 1;
    lastDecoded = {
      numberOfChannels: 1,
      length: 128,
      sampleRate: 44100,
      duration: 210,
      getChannelData: () => {
        analysisCalls += 1;
        return new Float32Array(128);
      },
    } as unknown as AudioBuffer;
    return lastDecoded;
  }
}
(g.window as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;
g.OfflineAudioContext = FakeOfflineAudioContext;

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DJSemanticWaveform } = await import('./DJSemanticWaveform.tsx');
const { analyzeBufferMemo } = await import('./djSemanticWaveformAnalysis.ts');
const { RELEASE_GRACE_MS, isDecoded } = await import('../../lib/djAudioCache.ts');
const { OBJECT_URL_GRACE_MS, acquireObjectUrl, liveObjectUrlCount } = await import('../../lib/sharedObjectUrl.ts');

// The grace periods run on captured timers, so no case waits out seconds.
const realSetTimeout = g.setTimeout as typeof setTimeout;
const realClearTimeout = g.clearTimeout as typeof clearTimeout;
const graceTimers = new Map<number, () => void>();
let nextTimer = 7_000_000;
g.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms === RELEASE_GRACE_MS || ms === OBJECT_URL_GRACE_MS) {
    nextTimer += 1;
    graceTimers.set(nextTimer, fn);
    return nextTimer;
  }
  return realSetTimeout(fn, ms, ...rest);
}) as typeof setTimeout;
g.clearTimeout = ((id: number) => {
  if (graceTimers.delete(id)) return;
  realClearTimeout(id);
}) as typeof clearTimeout;
function passGrace(): void {
  const due = [...graceTimers.values()];
  graceTimers.clear();
  for (const fn of due) fn();
}

async function settle(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((resolve) => realSetTimeout(resolve, 0));
    });
  }
}
async function resizeTo(width: number): Promise<void> {
  laneClientWidth = width;
  await act(async () => {
    latestResize?.();
  });
  await settle();
}

/** Whether the memo holds an analysis of `url` at exactly `bins` bins: a hit
 *  reads no channel data. */
function analysedAt(url: string, bins: number, normalize = true): boolean {
  assert.ok(lastDecoded, 'a buffer was decoded');
  const before = analysisCalls;
  analyzeBufferMemo(url, lastDecoded, { normalize, bins });
  const hit = analysisCalls === before;
  return hit;
}

const root = createRoot(dom.window.document.getElementById('root') as unknown as Element);

// ── the detail lane at zoom 8 analyses at main's resolution ───────────────
// The sequence from DJView: a deck loads, its detail lane is 900 px wide and
// shows an eighth of the track (zoom 8, viewport 0.4..0.525).
{
  laneClientWidth = 900;
  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl="zoomed.wav" viewportStart={0.4} viewportEnd={0.525} />);
  });
  await settle();
  await resizeTo(900);
  assert.ok(
    analysedAt('zoomed.wav', 6400),
    'the zoom-8 detail lane must be analysed at main’s 6,400 bins (800 across the lane)',
  );
}

// ── a lane resized pixel by pixel re-analyses only when the count changes ─
// The sequence: the user drags the DJ layout's splitter, widening a whole-
// track lane from 900 px to 1,020 px a few pixels at a time.
{
  laneClientWidth = 900;
  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl="resized.wav" />);
  });
  await settle();
  await resizeTo(900);
  const settledCalls = analysisCalls;
  for (let w = 904; w <= 1020; w += 4) await resizeTo(w);
  assert.equal(analysisCalls, settledCalls, 'a 900 -> 1,020 px drag must not re-analyse (it did every 64 px)');

  // Crossing into the next bin count is one re-analysis, not one per step.
  for (let w = 1030; w <= 1100; w += 10) await resizeTo(w);
  assert.equal(analysisCalls, settledCalls + 1, 'crossing a bin-count boundary re-analyses exactly once');
}

// ── an unmounted lane withdraws from its download ─────────────────────────
// The sequence: a deck's lane starts downloading, the user loads another
// track before it finishes. The lane used to drop only the result; the
// download ran on and its decode landed in the cache.
{
  parkUrls.add('abandoned.wav');
  const decodesBefore = decodeCount;
  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl="abandoned.wav" />);
  });
  await settle();
  const download = parked.find((p) => p.url === 'abandoned.wav');
  assert.ok(download, 'the download is in flight');

  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl="replacement.wav" />);
  });
  await settle();
  assert.equal(download.signal?.aborted, true, 'the abandoned download is aborted');
  download.release(); // too late: nobody is waiting
  await settle();
  assert.equal(isDecoded('abandoned.wav'), false, 'and nothing from it lands in the cache');
  assert.equal(decodeCount, decodesBefore + 1, 'only the replacement was decoded');
}

// ── a lane that goes away for good evicts its audio ───────────────────────
{
  assert.equal(isDecoded('replacement.wav'), true, 'the mounted lane’s audio is resident');
  await act(async () => {
    root.render(<></>);
  });
  await settle();
  assert.equal(isDecoded('replacement.wav'), true, 'not at once: a remount inside the grace period keeps it');
  passGrace();
  assert.equal(isDecoded('replacement.wav'), false, 'evicted once nothing shows it');
}

// ── EDIT: a clip keeps one object URL across a remount ────────────────────
// The sequence ClipWave produces under React StrictMode (and on every
// re-render that remounts a clip): acquire a URL, mount the lane, cleanup,
// remount. A fresh URL per mount was a new decode-cache key each time: a
// second download, a second decode, and a stale entry nobody read again.
{
  const blob = new Blob([new Uint8Array(8)], { type: 'audio/wav' });
  const fetchesBefore = fetched.length;
  const decodesBefore = decodeCount;

  const first = acquireObjectUrl(blob);
  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl={first.url} normalize={false} />);
  });
  await settle();
  // StrictMode's cleanup + remount.
  first.release();
  await act(async () => {
    root.render(<></>);
  });
  const second = acquireObjectUrl(blob);
  assert.equal(second.url, first.url, 'the remount gets the same, still-live URL');
  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl={second.url} normalize={false} />);
  });
  await settle();
  assert.equal(fetched.length, fetchesBefore + 1, 'one download across the remount');
  assert.equal(decodeCount, decodesBefore + 1, 'one decode across the remount');

  // A second clip cut from the same source shares it too.
  const sibling = acquireObjectUrl(blob);
  assert.equal(sibling.url, first.url, 'two clips of one Blob share one URL');
  sibling.release();

  // The clip is deleted: the URL is revoked and the audio evicted.
  second.release();
  await act(async () => {
    root.render(<></>);
  });
  await settle();
  passGrace();
  assert.equal(liveObjectUrlCount(), 0, 'the URL is revoked once no clip holds it');
  assert.equal(isDecoded(first.url), false, 'and its decoded audio leaves the cache');
}

await act(async () => {
  root.unmount();
});
g.setTimeout = realSetTimeout;
g.clearTimeout = realClearTimeout;

console.log('DJSemanticWaveform.lifecycle.test.tsx: ok');
