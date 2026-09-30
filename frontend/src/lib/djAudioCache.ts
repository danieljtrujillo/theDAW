/**
 * One fetch + one decode per audio URL for the whole DJ tab (DJ-2).
 *
 * ## Why
 *
 * Loading a deck used to download and decode the same file several times over.
 * `djEngine.loadDeck` does its own `fetch` -> `arrayBuffer` ->
 * `ctx.decodeAudioData`, and the default DJ layout mounts TWO
 * `DJSemanticWaveform` instances per deck (the zoomed lane and the overview),
 * each of which ran `djSemanticWaveformAnalysis.decodeAudio` independently:
 * its own `fetch`, its own `arrayBuffer.slice(0)` (a full extra copy of the
 * file), its own `new AudioContext()` — a REAL output-device context — and a
 * `close()` afterwards. Loading two decks was therefore 6 fetches, 6 decodes
 * and 4 throwaway output contexts, every one of which can glitch the engine's
 * own playing context on Windows/WASAPI.
 *
 * ## The contract
 *
 *   getDecodedAudio(url)                     -> Promise<AudioBuffer>
 *   getDecodedAudio(url, context)            -> ... decoded through `context`
 *   getDecodedAudio(url, context, { signal }) -> ... this caller can walk away
 *   retainDecodedAudio(url) -> release()
 *   evict(url) / evictAll() / onEvict(listener)
 *   setDecodeContext(ctx)
 *
 * - **Keyed by URL and decode rate.** Same URL, same `AudioBuffer` instance,
 *   for every caller that decodes at the same rate. A caller that names no
 *   context (a waveform) takes whatever rate is already resident: it only
 *   draws the audio, and a second decode of the file to change its rate would
 *   be pure waste. A caller that names its context (the engine) gets exactly
 *   that rate.
 * - **Single-flight.** Callers that arrive while a decode is in flight join it;
 *   they never start a second fetch.
 * - **A caller can walk away.** With a `signal`, aborting rejects that caller's
 *   promise and removes it from the flight; when every caller of a flight has
 *   walked away the download itself is aborted and nothing is stored. A
 *   waveform lane that unmounts mid-download used to keep downloading and
 *   then push a deck's buffer out of the cache with audio nobody wanted.
 * - **Held while in use.** {@link retainDecodedAudio} marks a URL as in use by
 *   a mounted surface; when the last holder releases it the entry is evicted
 *   after {@link RELEASE_GRACE_MS} (a remount inside that window keeps it).
 *   Nothing called {@link evict} before, so decoded audio only ever left
 *   through the LRU.
 * - **LRU of {@link DJ_AUDIO_CACHE_MAX} buffers** (decoded audio is large — a
 *   3.5-minute stereo track is ~74 MB of Float32: 210 s x 44,100 x 2 ch x 4 B
 *   — so this is deliberately
 *   small: two decks plus one on either side of a transition).
 * - **Never constructs a real `AudioContext`.** Decoding needs *a* context, not
 *   an output device: this uses the caller's context if given, else the one
 *   registered with {@link setDecodeContext}, else a single shared
 *   `OfflineAudioContext`, which allocates no device.
 * - **No defensive copy.** The fetched `ArrayBuffer` goes straight into
 *   `decodeAudioData`; nothing else reads it afterwards, so the old
 *   `.slice(0)` was pure waste on a multi-MB buffer.
 * - **Failures are not cached.** A rejected load leaves no entry, so the next
 *   caller retries.
 *
 * ## The engine's context
 *
 * `playerStore.ensureEngine` registers the app's one `AudioContext` with
 * {@link setDecodeContext} when it builds it, so every waveform decode made
 * after that runs at the rate playback runs at. Before the engine exists the
 * shared `OfflineAudioContext` below decodes at {@link FALLBACK_SAMPLE_RATE};
 * a buffer at a different rate than the output still plays at the correct
 * pitch (`AudioBufferSourceNode` resamples), it is only resampled twice.
 *
 * `djEngine.loadDeck` decodes through the engine context too; routed through
 * `getDecodedAudio(url, getEngineCtx())` it shares one fetch and one decode
 * with the deck's waveform lanes.
 */

/** The slice of `BaseAudioContext` this module actually needs. Accepting the
 *  structural type (rather than `AudioContext`) is what lets an
 *  `OfflineAudioContext` — or the engine's context — serve as the decoder. */
export interface AudioDecodeContext {
  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer>;
  /** The rate `decodeAudioData` RESAMPLES to. Part of the cache key: a buffer
   *  decoded at 44.1k is not interchangeable with the same file decoded at
   *  48k, so two contexts running at different rates must not share an entry.
   *  Optional because a caller may pass a bare decoder with no rate to
   *  advertise; those share one key (rate 0) among themselves. */
  readonly sampleRate?: number;
}

/** Decoded buffers held at once. Four = both decks plus the pair either side
 *  of an automix transition. */
export const DJ_AUDIO_CACHE_MAX = 4;

/** Sample rate of the shared fallback `OfflineAudioContext`. Only used when
 *  no engine context is available; see the module doc. */
const FALLBACK_SAMPLE_RATE = 44100;

/** How long an entry stays after its last holder releases it. Long enough for
 *  React StrictMode's unmount/remount and for a lane that re-mounts on a
 *  layout change; short enough that audio nobody shows is gone in seconds. */
export const RELEASE_GRACE_MS = 3000;

/** Insertion-ordered = LRU order: the first key is the least recently used.
 *  Keyed `${url}@${decodeSampleRate}` — see {@link cacheKeyFor}. */
const decoded = new Map<string, AudioBuffer>();

/** One download + decode, shared by every caller that joined it. */
type Flight = {
  promise: Promise<AudioBuffer>;
  /** Aborts the fetch once every waiting caller has walked away. */
  controller: AbortController;
  /** Callers still waiting. A caller with no signal can never walk away, so
   *  a flight with one of those is never aborted. */
  waiters: number;
};
/** In-flight decodes, same key — the single-flight table. */
const inFlight = new Map<string, Flight>();

/** Mounted surfaces holding each URL, and the evictions waiting out their
 *  grace period. */
const holders = new Map<string, number>();
const pendingEvictions = new Map<string, ReturnType<typeof setTimeout>>();

/** Told about every eviction: a URL, or `null` for "everything". */
type EvictListener = (url: string | null) => void;
const evictListeners = new Set<EvictListener>();

/**
 * The cache key: the URL AND the rate the audio will be resampled to.
 *
 * `decodeAudioData` resamples to the decoding context's own rate, so the same
 * file decoded through the 44.1 kHz offline fallback and through a 48 kHz
 * engine context are two different buffers. Keyed on the URL alone, whichever
 * caller decoded FIRST silently fixed the rate for everyone that followed —
 * a waveform's offline fallback could decide the rate the engine got.
 *
 * A context that advertises no `sampleRate` keys as rate 0: unknown, but at
 * least consistently unknown.
 */
function cacheKeyFor(url: string, ctx: AudioDecodeContext): string {
  return `${url}@${typeof ctx.sampleRate === 'number' ? ctx.sampleRate : 0}`;
}

/**
 * The URL part of a cache key — everything before the LAST `@`.
 *
 * `@` is legal in a URL (`a@b.wav`, credentials, an encoded name), so it is
 * not a delimiter the URL side is guaranteed to be free of. A prefix test on
 * `` `${url}@` `` therefore matches other URLs' keys: `evict('a')` used to
 * take every entry for `a@b.wav` with it. Only the rate suffix is guaranteed
 * `@`-free, so the split is anchored at the end.
 */
function urlOfKey(key: string): string {
  return key.slice(0, key.lastIndexOf('@'));
}

/** Every cache key currently held for `url`, at any rate. */
function keysFor(url: string): string[] {
  return [...decoded.keys(), ...inFlight.keys()].filter((key) => urlOfKey(key) === url);
}

let registeredContext: AudioDecodeContext | null = null;
let sharedOfflineContext: AudioDecodeContext | null = null;

/** Every context a decode has gone through since the last {@link evictAll},
 *  so a change of context can be told apart from registering the same one
 *  again. */
const decodedThrough = new Set<AudioDecodeContext>();

/**
 * Register the context every decode should go through when the caller does not
 * supply one — the engine's own `AudioContext`. Pass `null` to clear it (and
 * to drop the reference, e.g. when the engine tears its context down).
 *
 * When decodes this session went through a context other than the one that
 * decodes from now on (the offline fallback that decoded the library's
 * waveforms before the engine existed, or an engine context being torn down),
 * everything held is dropped with {@link evictAll}: those buffers are at the
 * old context's rate, and a caller that decodes through the new one would
 * only have held a second copy of each file beside them.
 */
export function setDecodeContext(ctx: AudioDecodeContext | null): void {
  registeredContext = ctx;
  const next = ctx ?? sharedOfflineContext;
  for (const used of decodedThrough) {
    if (used !== next) {
      evictAll();
      return;
    }
  }
}

type OfflineCtor = new (channels: number, length: number, sampleRate: number) => AudioDecodeContext;

function resolveContext(explicit?: AudioDecodeContext | null): AudioDecodeContext {
  if (explicit) return explicit;
  if (registeredContext) return registeredContext;
  if (sharedOfflineContext) return sharedOfflineContext;

  const scope = globalThis as unknown as { OfflineAudioContext?: OfflineCtor; webkitOfflineAudioContext?: OfflineCtor };
  const Ctor = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext;
  if (!Ctor) {
    // Deliberately NOT falling back to `new AudioContext()`: that opens the
    // output device, which is the exact cost this module exists to remove.
    throw new Error('No audio decoding context available (pass one to getDecodedAudio or call setDecodeContext)');
  }
  // 1 channel / 1 frame: the context is a decoder, it never renders anything.
  sharedOfflineContext = new Ctor(1, 1, FALLBACK_SAMPLE_RATE);
  return sharedOfflineContext;
}

/** Move `key` to the most-recently-used end of the LRU order. */
function touch(key: string): AudioBuffer | undefined {
  const hit = decoded.get(key);
  if (hit === undefined) return undefined;
  decoded.delete(key);
  decoded.set(key, hit);
  return hit;
}

function store(key: string, buffer: AudioBuffer): void {
  decoded.delete(key);
  decoded.set(key, buffer);
  while (decoded.size > DJ_AUDIO_CACHE_MAX) {
    const oldest = decoded.keys().next();
    if (oldest.done) break;
    decoded.delete(oldest.value);
  }
}

/**
 * Wrap `fn` in a `performance.mark`/`measure` pair named `name`, so the cost
 * shows up on the DevTools performance timeline instead of only in a profile.
 * The marks are cleared again (the measure is kept — that is the visible part)
 * so a long session does not accumulate thousands of entries. Never logs.
 */
export function measureSync<T>(name: string, fn: () => T): T {
  const perf = (globalThis as unknown as { performance?: Performance }).performance;
  if (!perf || typeof perf.mark !== 'function' || typeof perf.measure !== 'function') return fn();
  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  perf.mark(startMark);
  try {
    return fn();
  } finally {
    try {
      perf.mark(endMark);
      perf.measure(name, startMark, endMark);
      perf.clearMarks?.(startMark);
      perf.clearMarks?.(endMark);
    } catch {
      /* measurement must never break the thing it measures */
    }
  }
}

/** The async twin of {@link measureSync}. */
async function measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const perf = (globalThis as unknown as { performance?: Performance }).performance;
  if (!perf || typeof perf.mark !== 'function' || typeof perf.measure !== 'function') return fn();
  const startMark = `${name}:start`;
  const endMark = `${name}:end`;
  perf.mark(startMark);
  try {
    return await fn();
  } finally {
    try {
      perf.mark(endMark);
      perf.measure(name, startMark, endMark);
      perf.clearMarks?.(startMark);
      perf.clearMarks?.(endMark);
    } catch {
      /* ignore */
    }
  }
}

function abortError(): Error {
  const err = new Error('The audio load was aborted');
  err.name = 'AbortError';
  return err;
}

/** A resident buffer for `url` at ANY rate, most recently used first. */
function anyResident(url: string): string | undefined {
  let found: string | undefined;
  for (const key of decoded.keys()) if (urlOfKey(key) === url) found = key;
  return found;
}

/** The key of an in-flight decode for `url` at ANY rate. */
function anyInFlight(url: string): string | undefined {
  for (const key of inFlight.keys()) if (urlOfKey(key) === url) return key;
  return undefined;
}

/** Join `flight` as one more waiter. Without a signal the caller gets the
 *  shared promise itself and can never leave; with one, aborting rejects this
 *  caller alone, and the last waiter out aborts the download. */
function join(flight: Flight, key: string, signal?: AbortSignal | null): Promise<AudioBuffer> {
  flight.waiters += 1;
  if (!signal) return flight.promise;
  return new Promise<AudioBuffer>((resolve, reject) => {
    let left = false;
    const leave = () => {
      if (left) return;
      left = true;
      flight.waiters -= 1;
      if (flight.waiters <= 0 && inFlight.get(key) === flight) {
        inFlight.delete(key);
        flight.controller.abort();
      }
      reject(abortError());
    };
    signal.addEventListener('abort', leave, { once: true });
    flight.promise.then(
      (buffer) => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', leave);
        resolve(buffer);
      },
      (err: unknown) => {
        if (left) return;
        left = true;
        signal.removeEventListener('abort', leave);
        reject(err);
      },
    );
  });
}

/**
 * The decoded audio for `url`, fetching and decoding it at most once.
 *
 * @param url      audio URL; also the cache key.
 * @param context  optional context to decode through — the engine's
 *                 `AudioContext` when the caller has one. Given, the buffer is
 *                 at exactly that context's rate. Omitted, any rate already
 *                 resident (or decoding) for `url` is taken, and only a miss
 *                 decodes, through the registered or the offline context.
 * @param opts.signal  aborting it rejects THIS call with an `AbortError`; the
 *                 download stops once no caller is waiting for it.
 */
export function getDecodedAudio(
  url: string,
  context?: AudioDecodeContext | null,
  opts?: { signal?: AbortSignal | null },
): Promise<AudioBuffer> {
  const signal = opts?.signal ?? null;
  if (signal?.aborted) return Promise.reject(abortError());
  // Resolved FIRST because the rate it decodes at is part of the key. That is
  // a lookup, not a construction, on every call but the very first.
  //
  // It is also the one step here that can fail, and it runs before any
  // `async` boundary: callers handle a failed load with `.catch`/`await`, so
  // a throw out of the call ITSELF would escape them. Hand it back as a
  // rejection, like every other failure this function reports.
  let ctx: AudioDecodeContext;
  let key: string;
  try {
    ctx = resolveContext(context);
    key = cacheKeyFor(url, ctx);
  } catch (err) {
    return Promise.reject(err instanceof Error ? err : new Error(String(err)));
  }

  const hit = touch(context ? key : anyResident(url) ?? key);
  if (hit !== undefined) return Promise.resolve(hit);

  const pendingKey = context ? key : anyInFlight(url) ?? key;
  const pending = inFlight.get(pendingKey);
  if (pending) return join(pending, pendingKey, signal);

  decodedThrough.add(ctx);
  const controller = new AbortController();
  const promise: Promise<AudioBuffer> = measureAsync(`dj:decode:${url}`, async () => {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`Unable to load audio waveform: ${res.status}`);
    // No `.slice(0)`: nothing reads these bytes after the decode, and the copy
    // was a full extra multi-MB allocation per waveform instance.
    const bytes = await res.arrayBuffer();
    return ctx.decodeAudioData(bytes);
  })
    .then((buffer) => {
      // A concurrent `evict(url)`, or every caller walking away, while this
      // was in flight means nobody wants it cached; still resolve, just do
      // not store.
      if (inFlight.get(key) === flight) store(key, buffer);
      return buffer;
    })
    .finally(() => {
      // Failures are not cached — dropping the in-flight entry is what lets
      // the next caller retry.
      if (inFlight.get(key) === flight) inFlight.delete(key);
    });
  const flight: Flight = { promise, controller, waiters: 0 };
  // Nobody may be waiting on the shared promise itself (every caller had a
  // signal and left); an abort then must not surface as an unhandled rejection.
  promise.catch(() => undefined);

  inFlight.set(key, flight);
  return join(flight, key, signal);
}

/**
 * Mark `url` as in use by a mounted surface. Returns the matching release;
 * calling it more than once is harmless. When the last holder releases, the
 * URL is evicted after {@link RELEASE_GRACE_MS} unless someone retains it
 * again first — React StrictMode's unmount/remount lands inside that window.
 */
export function retainDecodedAudio(url: string): () => void {
  holders.set(url, (holders.get(url) ?? 0) + 1);
  const pendingEviction = pendingEvictions.get(url);
  if (pendingEviction !== undefined) {
    clearTimeout(pendingEviction);
    pendingEvictions.delete(url);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const left = (holders.get(url) ?? 1) - 1;
    if (left > 0) {
      holders.set(url, left);
      return;
    }
    holders.delete(url);
    pendingEvictions.set(
      url,
      setTimeout(() => {
        pendingEvictions.delete(url);
        if (!holders.has(url)) evict(url);
      }, RELEASE_GRACE_MS),
    );
  };
}

/** How many mounted surfaces hold `url` right now. Introspection for tests. */
export function holdersOf(url: string): number {
  return holders.get(url) ?? 0;
}

/** Be told about every eviction (`null` = everything). Returns the
 *  unsubscribe. The waveform module drops its analyses and renders here. */
export function onEvict(listener: EvictListener): () => void {
  evictListeners.add(listener);
  return () => evictListeners.delete(listener);
}

function notifyEvicted(url: string | null): void {
  for (const listener of evictListeners) {
    try {
      listener(url);
    } catch {
      /* one broken listener must not keep the others from hearing */
    }
  }
}

/** Drop one URL's decoded buffers — EVERY rate held for it — and disown any
 *  in-flight decode for it. Callers know URLs, not decode rates. */
export function evict(url: string): void {
  for (const key of keysFor(url)) {
    decoded.delete(key);
    inFlight.delete(key);
  }
  notifyEvicted(url);
}

/** Drop every decoded buffer and disown every in-flight decode — a change of
 *  decode context (see {@link setDecodeContext}), and test isolation. The
 *  holders stay: they count mounted surfaces, not entries, and each one still
 *  releases what it retained. */
export function evictAll(): void {
  decoded.clear();
  inFlight.clear();
  for (const timer of pendingEvictions.values()) clearTimeout(timer);
  pendingEvictions.clear();
  decodedThrough.clear();
  notifyEvicted(null);
}

/** Whether `url` is decoded and resident right now. Read-only; does not
 *  refresh LRU recency. */
export function isDecoded(url: string): boolean {
  for (const key of decoded.keys()) if (urlOfKey(key) === url) return true;
  return false;
}
