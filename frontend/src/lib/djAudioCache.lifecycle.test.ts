/**
 * djAudioCache — who lets go of decoded audio, and when (PR #207 review).
 *
 * The PR shipped `evict`, `evictAll` and `setDecodeContext` with no caller,
 * and no way for a waveform lane to withdraw from a download: decoded audio
 * (~74 MB per 3.5-minute track) only ever left through the LRU, an unmounted
 * lane's download still landed in the cache, and the cache never learned the
 * engine's context existed. Each case below replays the sequence a real
 * session produces.
 *
 * Run: `npx tsx src/lib/djAudioCache.lifecycle.test.ts` — `npm test` discovers it.
 */
import assert from 'node:assert/strict';

const g = globalThis as unknown as Record<string, unknown>;

// ── stubs ──────────────────────────────────────────────────────────────────

type Parked = { url: string; release: () => void; signal: AbortSignal | undefined };
/** URLs whose fetch parks until released, and the fetches parked right now. */
const parkUrls = new Set<string>();
const parked: Parked[] = [];
let fetchCount = 0;

g.fetch = (input: unknown, init?: { signal?: AbortSignal }) => {
  fetchCount += 1;
  const url = String(input);
  const signal = init?.signal;
  const respond = () => ({ ok: true, status: 200, arrayBuffer: async () => new ArrayBuffer(16) }) as unknown as Response;
  if (!parkUrls.has(url)) return Promise.resolve(respond());
  return new Promise<Response>((resolve, reject) => {
    const entry: Parked = { url, signal, release: () => resolve(respond()) };
    parked.push(entry);
    signal?.addEventListener('abort', () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
};

let decodeCount = 0;
function fakeBuffer(rate: number): AudioBuffer {
  return {
    numberOfChannels: 1,
    length: 128,
    sampleRate: rate,
    duration: 128 / rate,
    getChannelData: () => new Float32Array(128),
  } as unknown as AudioBuffer;
}
class FakeOfflineAudioContext {
  sampleRate: number;
  constructor(_channels: number, _length: number, sampleRate: number) {
    this.sampleRate = sampleRate;
  }
  async decodeAudioData(_data: ArrayBuffer): Promise<AudioBuffer> {
    decodeCount += 1;
    return fakeBuffer(this.sampleRate);
  }
}
g.OfflineAudioContext = FakeOfflineAudioContext;

/** The engine's context: a real one would run at the output device's rate. */
function engineContext(rate = 48000) {
  return {
    sampleRate: rate,
    decodeAudioData: async (_data: ArrayBuffer) => {
      decodeCount += 1;
      return fakeBuffer(rate);
    },
  };
}

// The release grace period is driven by captured timers, so no case waits
// out real seconds.
const realSetTimeout = g.setTimeout as typeof setTimeout;
const realClearTimeout = g.clearTimeout as typeof clearTimeout;
const graceTimers = new Map<number, () => void>();
let nextTimer = 5_000_000;

const {
  RELEASE_GRACE_MS,
  evict,
  evictAll,
  getDecodedAudio,
  holdersOf,
  isDecoded,
  onEvict,
  retainDecodedAudio,
  setDecodeContext,
} = await import('./djAudioCache.ts');

g.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
  if (ms === RELEASE_GRACE_MS) {
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

/** Let RELEASE_GRACE_MS pass. */
function passGrace(): void {
  const due = [...graceTimers.values()];
  graceTimers.clear();
  for (const fn of due) fn();
}

const evictions: Array<string | null> = [];
onEvict((url) => evictions.push(url));

function reset(): void {
  evictAll();
  setDecodeContext(null);
  parkUrls.clear();
  parked.length = 0;
  graceTimers.clear();
  evictions.length = 0;
  fetchCount = 0;
  decodeCount = 0;
}

const tick = () => new Promise((r) => realSetTimeout(r, 0));

// ── a lane that unmounts mid-download withdraws; the cache stays clean ─────
// The sequence: a deck lane starts downloading its track, and the user loads
// another track (or switches layout) before the download finishes. The lane's
// cleanup could only drop the RESULT; the download ran on, was decoded, and
// pushed a buffer somebody was using out of the four-slot cache.
{
  reset();
  parkUrls.add('left-behind.wav');
  const controller = new AbortController();
  const lane = getDecodedAudio('left-behind.wav', null, { signal: controller.signal });
  await tick();
  assert.equal(parked.length, 1, 'the download is in flight');

  controller.abort(); // the lane unmounts
  const outcome = await lane.then(
    () => 'resolved',
    (err: unknown) => (err instanceof Error ? err.name : String(err)),
  );
  assert.equal(outcome, 'AbortError', 'the unmounted lane’s promise rejects');
  assert.equal(parked[0].signal?.aborted, true, 'the download itself is aborted: nobody else wanted it');
  await tick();
  assert.equal(decodeCount, 0, 'nothing is decoded');
  assert.equal(isDecoded('left-behind.wav'), false, 'and nothing lands in the cache');
}

// ...but one lane leaving never cancels a download the other lane still needs.
{
  reset();
  parkUrls.add('shared.wav');
  const leaving = new AbortController();
  const staying = new AbortController();
  const a = getDecodedAudio('shared.wav', null, { signal: leaving.signal });
  const b = getDecodedAudio('shared.wav', null, { signal: staying.signal });
  await tick();
  assert.equal(parked.length, 1, 'one download for both lanes');
  leaving.abort();
  await a.catch(() => undefined);
  assert.equal(parked[0].signal?.aborted, false, 'the download continues for the lane that stayed');
  parked[0].release();
  const buffer = await b;
  assert.ok(buffer, 'the staying lane gets its audio');
  assert.equal(isDecoded('shared.wav'), true, 'and it is cached');
}

// ── the last lane to let go evicts, after a grace period ─────────────────
// The sequence: a lane mounts and decodes, unmounts, remounts inside the
// grace period (React StrictMode, a layout switch), and later unmounts for
// good. Nothing ever called evict, so every track a lane had shown stayed
// resident until the LRU happened to push it out.
{
  reset();
  const release1 = retainDecodedAudio('lane.wav');
  await getDecodedAudio('lane.wav');
  assert.equal(holdersOf('lane.wav'), 1);
  release1();
  assert.equal(isDecoded('lane.wav'), true, 'an unmount does not evict at once');

  const release2 = retainDecodedAudio('lane.wav'); // remount inside the grace
  passGrace();
  assert.equal(isDecoded('lane.wav'), true, 'a remount inside the grace period keeps the audio');
  assert.equal(fetchCount, 1, 'and costs no second download');

  release2();
  release2(); // a second call is harmless
  assert.equal(holdersOf('lane.wav'), 0);
  passGrace();
  assert.equal(isDecoded('lane.wav'), false, 'the last release evicts once the grace period passes');
  assert.deepEqual(evictions, ['lane.wav'], 'and tells the waveform module, which drops its analyses');
}

// A deck changing track releases the old URL and holds the new one.
{
  reset();
  const releaseOld = retainDecodedAudio('track-1.wav');
  await getDecodedAudio('track-1.wav');
  releaseOld();
  const releaseNew = retainDecodedAudio('track-2.wav');
  await getDecodedAudio('track-2.wav');
  passGrace();
  assert.equal(isDecoded('track-1.wav'), false, 'the track the deck left is evicted');
  assert.equal(isDecoded('track-2.wav'), true, 'the track it shows stays');
  releaseNew();
}

// ── the engine's context arriving drops what the offline fallback decoded ─
// The sequence: the library's waveforms decode before anything has played
// (through the 44.1 kHz offline fallback), then the first play builds the
// engine's context at 48 kHz and registers it. Nothing registered it before,
// so the cache decoded everything at 44.1k for the whole session.
{
  reset();
  await getDecodedAudio('early.wav');
  assert.equal(isDecoded('early.wav'), true);

  const release = retainDecodedAudio('early.wav');
  const engine = engineContext(48000);
  setDecodeContext(engine);
  assert.equal(isDecoded('early.wav'), false, 'the 44.1k decode is dropped when the engine context arrives');
  assert.deepEqual(evictions, [null], 'evictAll told the listeners');
  assert.equal(holdersOf('early.wav'), 1, 'a mounted lane still holds its URL');

  const redecoded = await getDecodedAudio('early.wav');
  assert.equal(redecoded.sampleRate, 48000, 'the next decode runs at the engine’s rate');

  // Registering the same context again is not a change.
  evictions.length = 0;
  setDecodeContext(engine);
  assert.equal(isDecoded('early.wav'), true, 're-registering the same context evicts nothing');
  assert.deepEqual(evictions, []);
  release();
}

// A caller that names no context (a waveform) takes the engine's decode.
{
  reset();
  const engine = engineContext(48000);
  await getDecodedAudio('deck.wav', engine); // the deck decodes at 48k
  const drawn = await getDecodedAudio('deck.wav'); // its lane, no context
  assert.equal(drawn.sampleRate, 48000);
  assert.equal(fetchCount, 1, 'the lane shares the deck’s decode instead of decoding at another rate');
}

// evict(url) by hand still drops every rate and tells the listeners.
{
  reset();
  await getDecodedAudio('manual.wav');
  evict('manual.wav');
  assert.equal(isDecoded('manual.wav'), false);
  assert.deepEqual(evictions, ['manual.wav']);
}

g.setTimeout = realSetTimeout;
g.clearTimeout = realClearTimeout;
console.log('djAudioCache.lifecycle.test.ts OK');
