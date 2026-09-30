/**
 * djAudioCache — DJ-2.
 *
 * The DJ tab used to fetch + decode the SAME file once per consumer: the
 * engine's `loadDeck` did its own fetch/decode, and EVERY mounted
 * `DJSemanticWaveform` instance did another one inside
 * `djSemanticWaveformAnalysis.decodeAudio` — which also spun up a THROWAWAY
 * real `AudioContext` per instance (each one opens the output device, a
 * glitch source on Windows/WASAPI while the engine context is playing) and
 * copied the whole file with `arrayBuffer.slice(0)`.
 *
 * This pins the replacement: one fetch + one decode per URL (single-flight),
 * an LRU of 4 decoded buffers, `evict`, no real `AudioContext` construction,
 * and no defensive copy of the downloaded bytes.
 *
 * Run: `npx tsx src/lib/djAudioCache.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

const g = globalThis as unknown as Record<string, unknown>;

// ── stubs ──────────────────────────────────────────────────────────────────

let fetchCount = 0;
let fetchedUrls: string[] = [];
let failNext = false;
/** The exact ArrayBuffer handed to the caller, so the test can prove the
 *  cache passes it straight to `decodeAudioData` instead of `.slice(0)`-ing
 *  a whole second copy of the file. */
let lastArrayBuffer: ArrayBuffer | null = null;

g.fetch = async (input: unknown) => {
  fetchCount += 1;
  fetchedUrls.push(String(input));
  if (failNext) {
    failNext = false;
    return { ok: false, status: 404, arrayBuffer: async () => new ArrayBuffer(8) } as unknown as Response;
  }
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => {
      lastArrayBuffer = new ArrayBuffer(16);
      return lastArrayBuffer;
    },
  } as unknown as Response;
};

let decodeCount = 0;
let decodedBuffers: ArrayBuffer[] = [];
function fakeDecoded(tag: string): AudioBuffer {
  return {
    numberOfChannels: 1,
    length: 128,
    sampleRate: 44100,
    duration: 128 / 44100,
    getChannelData: () => new Float32Array(128),
    // marker so the test can tell instances apart
    __tag: tag,
  } as unknown as AudioBuffer;
}

class FakeOfflineAudioContext {
  static constructed = 0;
  sampleRate: number;
  constructor(_channels: number, _length: number, sampleRate: number) {
    FakeOfflineAudioContext.constructed += 1;
    this.sampleRate = sampleRate;
  }
  async decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    decodeCount += 1;
    decodedBuffers.push(data);
    return fakeDecoded(`offline-${decodeCount}`);
  }
}
g.OfflineAudioContext = FakeOfflineAudioContext;

/** A REAL AudioContext opens the output device. The cache must never build
 *  one — constructing this blows the test up rather than silently regressing. */
class ForbiddenAudioContext {
  constructor() {
    throw new Error('djAudioCache constructed a real AudioContext');
  }
}
g.AudioContext = ForbiddenAudioContext;
g.window = g.window ?? g;
(g.window as Record<string, unknown>).AudioContext = ForbiddenAudioContext;
(g.window as Record<string, unknown>).OfflineAudioContext = FakeOfflineAudioContext;

const { getDecodedAudio, evict, evictAll, isDecoded, setDecodeContext, DJ_AUDIO_CACHE_MAX } = await import('./djAudioCache.ts');

function reset(): void {
  evictAll();
  setDecodeContext(null);
  fetchCount = 0;
  decodeCount = 0;
  fetchedUrls = [];
  decodedBuffers = [];
  failNext = false;
}

// ── no context at all: a REJECTED promise, never a synchronous throw ───────

// Runs FIRST, while the shared offline context is still unbuilt — once it has
// been constructed it is kept for the rest of the run and this case cannot
// happen again. Callers (`DJSemanticWaveform`, `loadDeck`) handle the failure
// with `.catch`/`await`, so a throw out of the call itself escapes them.
{
  reset();
  const savedOffline = g.OfflineAudioContext;
  const savedWebkit = g.webkitOfflineAudioContext;
  delete g.OfflineAudioContext;
  delete g.webkitOfflineAudioContext;
  let threw: unknown = null;
  let promise: Promise<AudioBuffer> | null = null;
  try {
    promise = getDecodedAudio('no-context.wav');
  } catch (err) {
    threw = err;
  }
  g.OfflineAudioContext = savedOffline;
  if (savedWebkit !== undefined) g.webkitOfflineAudioContext = savedWebkit;

  assert.equal(threw, null, 'a missing decode context must not throw synchronously out of getDecodedAudio');
  assert.ok(promise, 'getDecodedAudio must return a promise even with no context available');
  await assert.rejects(promise, /No audio decoding context available/);
  assert.equal(fetchCount, 0, 'and nothing is fetched when there is nothing to decode with');
}

// ── single-flight: two concurrent callers + a later one = 1 fetch, 1 decode ─

{
  reset();
  const [a, b] = await Promise.all([
    getDecodedAudio('deck-a.wav'),
    getDecodedAudio('deck-a.wav'),
  ]);
  const c = await getDecodedAudio('deck-a.wav');

  assert.equal(fetchCount, 1, 'three callers for one URL must fetch exactly once');
  assert.equal(decodeCount, 1, 'three callers for one URL must decode exactly once');
  assert.equal(a, b, 'concurrent callers share the one decoded AudioBuffer');
  assert.equal(a, c, 'a later caller gets the cached AudioBuffer, not a fresh decode');
}

// ── the downloaded bytes are decoded in place, never `.slice(0)`-copied ─────

{
  reset();
  await getDecodedAudio('deck-a.wav');
  assert.equal(decodedBuffers.length, 1);
  assert.equal(
    decodedBuffers[0],
    lastArrayBuffer,
    'decodeAudioData must receive the fetched ArrayBuffer itself, not a whole-file copy',
  );
}

// ── never a real AudioContext; the shared offline context is built once ─────

{
  reset();
  await getDecodedAudio('deck-a.wav');
  await getDecodedAudio('deck-b.wav');
  // Counted across the WHOLE run (the shared context is built lazily, once,
  // and kept): several URLs, several decodes, still one context ever.
  assert.equal(
    FakeOfflineAudioContext.constructed,
    1,
    'one shared OfflineAudioContext decodes every URL — never one context per file',
  );
  // (a real AudioContext would have thrown from ForbiddenAudioContext above)
}

// ── an explicitly supplied context (the engine's) is used instead ───────────

{
  reset();
  let engineDecodes = 0;
  const engineCtx = {
    decodeAudioData: async (_data: ArrayBuffer) => {
      engineDecodes += 1;
      return fakeDecoded('engine');
    },
  };
  await getDecodedAudio('deck-c.wav', engineCtx);
  assert.equal(engineDecodes, 1, 'the caller-supplied context decodes the audio');
  assert.equal(decodeCount, 0, 'and the shared offline context is not used at all');
}

// ── a registered engine context is preferred over the offline fallback ──────

{
  reset();
  let engineDecodes = 0;
  setDecodeContext({
    decodeAudioData: async (_data: ArrayBuffer) => {
      engineDecodes += 1;
      return fakeDecoded('registered');
    },
  });
  await getDecodedAudio('deck-d.wav');
  assert.equal(engineDecodes, 1, 'setDecodeContext wins over the OfflineAudioContext fallback');
  assert.equal(decodeCount, 0);
  setDecodeContext(null);
}

// ── LRU of 4, least-RECENTLY-USED evicted (a cache hit refreshes recency) ───

{
  reset();
  assert.equal(DJ_AUDIO_CACHE_MAX, 4, 'the DJ deck cache holds four decoded buffers');

  await getDecodedAudio('a.wav');
  await getDecodedAudio('b.wav');
  await getDecodedAudio('c.wav');
  await getDecodedAudio('d.wav');
  assert.equal(fetchCount, 4);

  // Touch 'a' so 'b' becomes the least recently used entry.
  await getDecodedAudio('a.wav');
  assert.equal(fetchCount, 4, 'a cache hit does not refetch');

  await getDecodedAudio('e.wav'); // 5th entry -> evicts 'b'
  assert.equal(fetchCount, 5);

  await getDecodedAudio('a.wav');
  assert.equal(fetchCount, 5, 'the recently-touched entry survived the eviction');

  await getDecodedAudio('b.wav');
  assert.equal(fetchCount, 6, 'the least recently used entry was evicted and refetches');
}

// ── evict(url) drops exactly that entry ────────────────────────────────────

{
  reset();
  await getDecodedAudio('a.wav');
  await getDecodedAudio('b.wav');
  assert.equal(fetchCount, 2);

  evict('a.wav');
  await getDecodedAudio('b.wav');
  assert.equal(fetchCount, 2, 'evicting one URL leaves the others cached');
  await getDecodedAudio('a.wav');
  assert.equal(fetchCount, 3, 'the evicted URL refetches');
}

// ── the key includes the SAMPLE RATE the audio was decoded at ─────────────

{
  // `decodeAudioData` resamples to the DECODING context's rate, so the first
  // caller's context used to fix the sample rate for everyone: a waveform
  // decoded through the 44.1k offline fallback would be handed back to the
  // engine running at 48k, and vice versa. The rate is part of what the entry
  // IS, so it is part of the key.
  reset();
  const at48 = { sampleRate: 48000, decodeAudioData: async () => fakeDecoded('48k') };
  const at44 = { sampleRate: 44100, decodeAudioData: async () => fakeDecoded('44k') };

  const a = await getDecodedAudio('rate.wav', at48);
  const b = await getDecodedAudio('rate.wav', at44);
  assert.notEqual(a, b, 'the same URL decoded at a different rate is a different cache entry');
  assert.equal(fetchCount, 2, 'so it is fetched and decoded again at the new rate');

  const again = await getDecodedAudio('rate.wav', at48);
  assert.equal(again, a, 'and the first rate is still cached alongside it');
  assert.equal(fetchCount, 2);

  const sameRateOtherCtx = { sampleRate: 48000, decodeAudioData: async () => fakeDecoded('48k-2') };
  const shared = await getDecodedAudio('rate.wav', sameRateOtherCtx);
  assert.equal(shared, a, 'two contexts at the SAME rate still share one decode');
  assert.equal(fetchCount, 2);

  evict('rate.wav');
  await getDecodedAudio('rate.wav', at48);
  assert.equal(fetchCount, 3, 'evict(url) drops every rate held for that URL');
  assert.equal(isDecoded('rate.wav'), true, 'and isDecoded still answers for the bare URL');
}

// ── a URL containing '@' is its own entry, not another URL's ──────────────

{
  // The key is `${url}@${rate}`, so '@' is not a delimiter the URL is free of:
  // a prefix match on `'a' + '@'` also matches every key for 'a@b.wav'. Only
  // the LAST '@' separates the rate, so that is the one the URL ends at.
  reset();
  await getDecodedAudio('a');
  await getDecodedAudio('a@b.wav');
  assert.equal(fetchCount, 2);
  assert.equal(isDecoded('a'), true);
  assert.equal(isDecoded('a@b.wav'), true);

  evict('a');
  assert.equal(isDecoded('a@b.wav'), true, "evicting 'a' must not evict the different URL 'a@b.wav'");
  await getDecodedAudio('a@b.wav');
  assert.equal(fetchCount, 2, "so 'a@b.wav' is still cached and does not refetch");

  assert.equal(isDecoded('a'), false, "and 'a' itself is gone — 'a@b.wav' is not an entry for 'a'");
  await getDecodedAudio('a');
  assert.equal(fetchCount, 3, "the evicted 'a' refetches");
}

// ── a failure is not cached: the next caller retries ───────────────────────

{
  reset();
  failNext = true;
  await assert.rejects(getDecodedAudio('broken.wav'), /404/);
  assert.equal(fetchCount, 1);

  const buf = await getDecodedAudio('broken.wav');
  assert.equal(fetchCount, 2, 'a failed load must not be cached as a permanent rejection');
  assert.ok(buf, 'the retry resolves normally');
}

// ── the decode is instrumented for DevTools, without console noise ─────────

{
  reset();
  const measures: string[] = [];
  const realPerf = g.performance as Record<string, unknown> | undefined;
  g.performance = {
    now: () => (realPerf?.now as () => number)?.() ?? 0,
    mark: () => undefined,
    measure: (name: string) => { measures.push(name); return undefined; },
    clearMarks: () => undefined,
    clearMeasures: () => undefined,
  };
  await getDecodedAudio('measured.wav');
  g.performance = realPerf;
  assert.ok(
    measures.includes('dj:decode:measured.wav'),
    `decode must emit a "dj:decode:<url>" measure — got ${JSON.stringify(measures)}`,
  );
}

reset();
console.log('djAudioCache.test.ts OK');
