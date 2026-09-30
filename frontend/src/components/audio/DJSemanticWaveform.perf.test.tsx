/**
 * DJSemanticWaveform — flipping `normalize` must re-run `analyzeBuffer` in
 * the new mode WITHOUT re-fetching or re-decoding the audio file (audit
 * follow-up #5): the fetch+decode step and the analysis step used to live in
 * ONE effect keyed on `[audioUrl, normalize]`, so a prop that only changes
 * how the SAME already-decoded buffer is scaled re-downloaded and re-decoded
 * the whole file every time it flipped.
 *
 * The fix splits them into two effects: fetch+decode is keyed on `audioUrl`
 * alone and keeps its `AudioBuffer` in state; a second effect, keyed on
 * `[buffer, normalize]`, re-runs `analyzeBuffer` against that SAME buffer.
 *
 * Real component, real React (via react-dom/client + act), under jsdom — the
 * same harness pattern `orb-kit/stream/useChatStream.hook.test.tsx` uses.
 * `fetch` and `window.AudioContext` are stubbed and counted; jsdom's own
 * `canvas.getContext('2d')` returns null with no canvas backend installed,
 * which `drawWaveform` already no-ops on, so no canvas stub is needed.
 *
 * Run: `npx tsx src/components/audio/DJSemanticWaveform.perf.test.tsx`
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
const g = globalThis as unknown as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom has no ResizeObserver. This one keeps the latest callback so a layout
// change can be delivered for real (DJ-2R item 5), and a controllable
// `clientWidth` stands in for the measured lane.
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

const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { DJSemanticWaveform } = await import('./DJSemanticWaveform.tsx');
const { analyzeBufferMemo } = await import('./djSemanticWaveformAnalysis.ts');

// ── fetch stub: counts calls, returns a tiny fixed payload every time ───────
let fetchCount = 0;
const lastFetchUrls: string[] = [];
g.fetch = async (input: unknown) => {
  fetchCount += 1;
  lastFetchUrls.push(String(input));
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => new ArrayBuffer(8),
  } as unknown as Response;
};

// ── decoding context stub: counts decodeAudioData calls ────────────────────
// DJ-2: decoding goes through `lib/djAudioCache`, which decodes with a shared
// OfflineAudioContext (or the engine's context) and must NEVER build a real
// AudioContext — every real one opens the output device, which can glitch the
// engine's playing context on Windows/WASAPI.
let decodeCount = 0;
/** Every fresh analysis reads the channel data once; a memo hit reads none. */
let analysisCalls = 0;
let lastDecoded: AudioBuffer | null = null;
class FakeOfflineAudioContext {
  static constructed = 0;
  constructor(_channels: number, _length: number, _sampleRate: number) {
    FakeOfflineAudioContext.constructed += 1;
  }
  async decodeAudioData(_buf: ArrayBuffer): Promise<AudioBuffer> {
    decodeCount += 1;
    // `duration` drives the BIN COUNT and `length` the analysis loop, so a
    // 128-sample fixture can still stand in for a 3.5-minute track's sizing -
    // which is the thing the lane width changes.
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
class ForbiddenAudioContext {
  constructor() {
    throw new Error('a real AudioContext was constructed for a waveform decode');
  }
}
(g.window as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;
(g.window as Record<string, unknown>).AudioContext = ForbiddenAudioContext;
g.OfflineAudioContext = FakeOfflineAudioContext;
g.AudioContext = ForbiddenAudioContext;

/** Let the fetch → decode → analyze chain and its state updates settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const root = createRoot(dom.window.document.getElementById('root') as unknown as Element);

// First mount: one fetch, one decode.
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />);
});
await settle();
assert.equal(fetchCount, 1, 'the first mount fetches the audio once');
assert.equal(decodeCount, 1, 'and decodes it once');

// Flip `normalize` for the SAME audioUrl: must re-analyze, must NOT re-fetch
// or re-decode.
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-a.wav" normalize={false} />);
});
await settle();
assert.equal(fetchCount, 1, 'flipping normalize must not re-fetch the audio file');
assert.equal(decodeCount, 1, 'flipping normalize must not re-decode the audio file');

// Flip it right back: still no new fetch/decode — this is not "the first
// flip is cached, the second one is not".
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />);
});
await settle();
assert.equal(fetchCount, 1);
assert.equal(decodeCount, 1);

// Sanity: a truly NEW audioUrl still fetches and decodes — proves the
// counts above are not just stuck at 1 because the stubs are no-ops.
await act(async () => {
  root.render(<DJSemanticWaveform audioUrl="track-b.wav" normalize={true} />);
});
await settle();
assert.equal(fetchCount, 2, 'a new audioUrl does fetch again');
assert.equal(decodeCount, 2, 'and does decode again');
assert.deepEqual(lastFetchUrls, ['track-a.wav', 'track-b.wav'], 'exactly the two real URL changes fetched');

// DJ-2: every decode above ran on ONE shared OfflineAudioContext, and not a
// single real AudioContext was opened (ForbiddenAudioContext would have
// thrown). The old code built — and closed — one real output-device context
// per waveform INSTANCE, and the default deck layout mounts two of them.
assert.equal(FakeOfflineAudioContext.constructed, 1, 'one shared decoding context for every URL');

// DJ-2: a SECOND waveform instance for a URL already loaded must ride the
// shared cache — no second fetch, no second decode.
await act(async () => {
  root.render(
    <>
      <DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />
      <DJSemanticWaveform audioUrl="track-a.wav" normalize={true} />
    </>,
  );
});
await settle();
assert.equal(fetchCount, 2, 'two instances of an already-decoded URL fetch nothing further');
assert.equal(decodeCount, 2, 'and decode nothing further');

// DJ-2R item 5: the analysis lane width is STATE fed by the ResizeObserver,
// not a value sampled once inside the analysis effect. Sampled once, a lane
// that is hidden or not yet laid out measures 0, analyses at the full
// 6,400-bin cap, and NEVER re-analyses when it is shown or resized — which is
// every overview lane on a tab that was not the active one at mount.
{
  laneClientWidth = 0;
  analysisCalls = 0;
  await act(async () => {
    root.render(<DJSemanticWaveform audioUrl="track-c.wav" normalize={true} />);
  });
  await settle();
  assert.equal(analysisCalls, 1, 'the first mount analyses once');
  assert.ok(lastDecoded, 'and holds the decoded buffer');

  // The lane gets a real width and the ResizeObserver reports it.
  laneClientWidth = 600;
  await act(async () => {
    latestResize?.();
  });
  await settle();
  assert.equal(analysisCalls, 2, 'a lane that gains a real width must re-analyse at that width');

  // ...and at EXACTLY the bucketed measured width: asking the memo for that
  // key must be a hit, which reads no channel data at all.
  const settled = analysisCalls;
  analyzeBufferMemo('track-c.wav', lastDecoded, { normalize: true, width: 640 });
  assert.equal(
    analysisCalls,
    settled,
    'the re-analysis is memoised under the bucketed measured width (600 -> 640)',
  );

  // A sub-bucket wobble is NOT a new analysis: the width is bucketed to 64 px
  // so a one-pixel layout jitter cannot thrash the analysis.
  laneClientWidth = 610;
  await act(async () => {
    latestResize?.();
  });
  await settle();
  assert.equal(analysisCalls, settled, 'a sub-bucket resize does not re-analyse');
}

await act(async () => {
  root.unmount();
});

console.log('DJSemanticWaveform.perf.test.tsx: ok');
