/**
 * One decode cache for the whole DAW.
 *
 * A decoded clip is stereo float32 in RAM — about 0.35 MB per second at
 * 44.1 kHz, ~85 MB for a four-minute track. Before this module the live mixer
 * and each offline renderer kept a private Blob-keyed cache and each re-ran the
 * same timeout-guarded decodeAudioData, so bouncing a project that was already
 * playing decoded every clip a second time and roughly doubled peak memory. In
 * Electron that is a renderer-process OOM on a 16 GB laptop, not a slowdown.
 *
 * Everything that decodes a clip's `audioBlob` goes through here instead, so a
 * clip decoded once is reused by every later play and bounce.
 *
 * Sharing one buffer across contexts is safe by spec: an AudioBuffer is a
 * memory-resident asset, not a child of the context that produced it, and may
 * be used by one or more contexts — assigning it to an AudioBufferSourceNode of
 * an OfflineAudioContext is exactly the supported case.
 *
 * TWO invariants this module exists to hold:
 *
 * 1. The cache only ever contains buffers that decoded SUCCESSFULLY. A rejected
 *    or timed-out decode leaves no entry — neither a resolved one (silence
 *    would play forever) nor a rejected promise (one blip would poison every
 *    later play and bounce of that clip).
 *
 * 2. A buffer is only ever handed to a caller decoding at the SAME sample rate.
 *    decodeAudioData resamples its output to the context's rate, and the two
 *    kinds of caller here do not agree on one: the live engine context runs at
 *    whatever the output device gives (commonly 48 kHz), while every offline
 *    renderer deliberately pins 44100 to match its OfflineAudioContext. Handing
 *    a bounce the live 48 kHz buffer would resample 44.1 -> 48 -> 44.1 material
 *    that needed no resampling at all, and — worse — would make a bounce's
 *    output depend on whether the user happened to press play first. Entries
 *    are therefore per rate, so reuse is always a pure win and never a quality
 *    or determinism change.
 *
 * RETENTION (added later). Holding every decoded clip for as long as its Blob
 * lives is what made the sharing above free, and it is also unbounded: a
 * 4-minute clip is ~81 MiB, twenty of them ~1.6 GiB, and on a 48 kHz output
 * device the rate keying means a live 48 kHz buffer AND a 44.1 kHz bounce
 * buffer can both be resident for the same clip. So the cache now carries an
 * explicit byte budget, an LRU index, and a pin API:
 *
 * - `configureDecodeCache({ budgetBytes })`. The budget starts UNBOUNDED, so
 *   nothing is evicted until an explicit call turns eviction on; the value to
 *   turn it on WITH — `min(1 GiB, 25% of navigator.deviceMemory)` — is
 *   `defaultDecodeBudgetBytes()`.
 * - After a successful decode the least recently USED unpinned entry is dropped
 *   until the total is back inside the budget.
 * - `pinDecoded` / `unpinDecoded` / `withPinned` make a buffer un-evictable
 *   while something is playing it. Evicting a buffer an AudioBufferSourceNode is
 *   still reading would not free anything — the node holds its own reference —
 *   but it WOULD make the next request re-decode a clip that is already in RAM,
 *   and it is exactly the kind of bookkeeping that later grows into a real bug.
 *   The budget therefore yields to pins and reports `overBudget` instead of ever
 *   taking a pinned buffer.
 *
 * WHY EVICTION IS OFF BY DEFAULT. Dropping an entry is transparent to
 * `decodeClipBlob` callers — the next request decodes it again, and a caller's
 * own reference to a buffer it already holds is untouched. It is NOT transparent
 * to `peekDecoded` callers, and the live mixer is one: it awaits `decodeClipBlob`
 * for every clip in turn and only then reads them all back synchronously with
 * `peekDecoded` (`state/liveMixer.ts:374-379`, `:1729-1730`). Under a budget, a
 * project big enough for the later decodes to evict the earlier ones would have
 * those clips peek as `undefined` and simply not be scheduled — silence, not a
 * slower load. So:
 *
 * !! `scheduleClipSources`/`scheduleClips` in `state/liveMixer.ts` MUST pin every
 * buffer it schedules and unpin it when those sources end, and only then may the
 * app call `configureDecodeCache({ budgetBytes: defaultDecodeBudgetBytes() })`.
 * That wiring is NOT in this module's remit and is not done yet (wave-2 T46B).
 * Until it lands the budget stays unbounded, which is exactly the behaviour this
 * module had before the budget existed.
 *
 * `releaseDecoded(blob)` is the other half of an unbounded cache: with no budget
 * to evict them, a deleted clip's buffers are freed only when someone says the
 * clip is gone. `state/editorStore.ts`'s `releaseClipAudio` calls it from
 * `removeClip`, `removeTrack`, and `loadProject` (T66B) — but only for a Blob
 * no clip still LIVE in the document references, since a split, a duplicate/
 * paste, and a shared active-take import can all leave two clips pointing at
 * the same Blob object (audit MAJOR #1 on T66B). A Blob only undo history
 * still holds is released anyway: undo restores the clip object rather than
 * re-decoding, so the next play simply decodes it again, same as any clip
 * that was never played.
 *
 * DESIGN SOURCE (design only — no code was copied, and none may be):
 * Ardour's `libs/ardour/disk_reader.cc` (GNU GPL-2.0-or-later), whose butler
 * keeps each track to a fixed, bounded playback buffer refilled from disk
 * instead of holding whole files resident. The bounded-retention idea below is
 * that design applied to a whole-file cache; the streaming half of it is the
 * later step this budget is the prerequisite for.
 */

/** How long a single clip decode may take before the race rejects it.
 *  This is the live mixer's long-standing value; the offline renderers used
 *  the same number, independently. */
export const DECODE_TIMEOUT_MS = 15000;

/** Decoded buffers, keyed by Blob identity then by the sample rate they were
 *  decoded at. A WeakMap means a clip's buffers are reclaimed once its Blob is
 *  gone, and an edited clip (a fresh Blob) decodes again rather than playing
 *  the pre-edit audio. */
const decoded = new WeakMap<Blob, Map<number, AudioBuffer>>();

/** Decodes currently running, same keying, so two callers asking for the same
 *  clip at the same rate at the same time (playback starting while a bounce
 *  walks the same timeline) share one decodeAudioData instead of allocating
 *  the buffer twice. */
const inFlight = new WeakMap<Blob, Map<number, Promise<AudioBuffer>>>();

/* ── retention: budget, LRU index, pins ───────────────────────────────────── */

const GIB = 1024 * 1024 * 1024;

/** The cap on the DERIVED budget, and the fallback when the browser will not say
 *  how much RAM it has (only Chromium implements `navigator.deviceMemory`).
 *  Note this is not the budget the module starts with — see `budgetBytes`. */
const DERIVED_BUDGET_CAP_BYTES = GIB;

/** What one entry is worth, and everything needed to unhook it. `blob` is a
 *  STRONG reference — that is the point of the index: the WeakMap cannot be
 *  enumerated, so without it there is nothing to walk when the budget is blown.
 *  Retention stays bounded because the budget bounds the index. */
interface CacheEntry {
  readonly blob: Blob;
  readonly rate: number;
  readonly buffer: AudioBuffer;
  readonly bytes: number;
}

/** Every resident entry, in least-recently-USED first order. A Set preserves
 *  insertion order and `delete` + `add` is an O(1) move to the end, so touching
 *  an entry on a cache hit costs nothing and allocates nothing. */
const lru = new Set<CacheEntry>();

/** The same entries, addressable the way `decoded` is, so a hit finds its entry
 *  without a scan. `decoded` stays the source of truth for identity. */
const entryOf = new WeakMap<Blob, Map<number, CacheEntry>>();

/** Outstanding pins per Blob and rate. Kept separately from the entries so a pin
 *  taken BEFORE the decode lands (or while it is in flight) still protects the
 *  buffer the moment it arrives. */
const pins = new WeakMap<Blob, Map<number, number>>();

/**
 * UNBOUNDED until someone configures a budget, which is a deliberate default
 * and not an oversight: see the `peekDecoded` hazard in the header. Eviction is
 * only safe once every scheduled buffer is pinned, so the app opts in with
 * `configureDecodeCache({ budgetBytes: defaultDecodeBudgetBytes() })` at the
 * point that wiring exists.
 */
let budgetBytes = Number.POSITIVE_INFINITY;
let residentBytes = 0;
let evictions = 0;

/**
 * The budget this machine should use once eviction is safe to turn on:
 * `min(1 GiB, 25% of navigator.deviceMemory)`, and 1 GiB where the browser does
 * not report `deviceMemory` (everything but Chromium).
 *
 * Read at call time, not at module load, so a host that installs its own
 * `navigator` (an Electron preload, a test) is seen.
 */
export function defaultDecodeBudgetBytes(): number {
  const nav = (globalThis as { navigator?: { deviceMemory?: number } }).navigator;
  const gib = nav?.deviceMemory;
  if (typeof gib !== 'number' || !Number.isFinite(gib) || gib <= 0) {
    return DERIVED_BUDGET_CAP_BYTES;
  }
  return Math.min(DERIVED_BUDGET_CAP_BYTES, 0.25 * gib * GIB);
}

/** An AudioBuffer's resident cost: float32 per sample per channel. Anything the
 *  platform will not tell us about counts as 0 rather than as NaN — a poisoned
 *  total would evict everything or nothing, and both are worse than an entry
 *  that is merely unaccounted. */
function bufferBytes(buffer: AudioBuffer): number {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  if (!Number.isFinite(channels) || !Number.isFinite(length)) return 0;
  if (channels <= 0 || length <= 0) return 0;
  return channels * length * 4;
}

function pinCount(blob: Blob, rate: number): number {
  return pins.get(blob)?.get(rate) ?? 0;
}

/** Move an entry to the most-recently-used end. */
function touch(entry: CacheEntry): void {
  lru.delete(entry);
  lru.add(entry);
}

/** Unhook one entry from the index, the WeakMap and the byte total. */
function drop(entry: CacheEntry): void {
  lru.delete(entry);
  const byRate = entryOf.get(entry.blob);
  if (byRate?.get(entry.rate) === entry) byRate.delete(entry.rate);
  const decodedByRate = decoded.get(entry.blob);
  if (decodedByRate?.get(entry.rate) === entry.buffer) decodedByRate.delete(entry.rate);
  residentBytes -= entry.bytes;
  if (residentBytes < 0) residentBytes = 0;
}

/**
 * Drop least-recently-used entries until the total is inside the budget.
 *
 * Three entries are never taken: a pinned one (something is playing it), one
 * whose Blob has a decode in flight (that decode is about to write beside it),
 * and `keep` — the buffer the caller that triggered this pass is about to use,
 * which it would be absurd to decode and immediately forget. If that leaves
 * nothing to take, the cache stays over budget and says so in `decodeCacheStats`.
 */
function evictToBudget(keep?: CacheEntry): void {
  while (residentBytes > budgetBytes) {
    let victim: CacheEntry | undefined;
    for (const entry of lru) {
      if (entry === keep) continue;
      if (pinCount(entry.blob, entry.rate) > 0) continue;
      if ((inFlight.get(entry.blob)?.size ?? 0) > 0) continue;
      victim = entry;
      break;
    }
    if (!victim) return;
    drop(victim);
    evictions += 1;
  }
}

/** Record a freshly decoded buffer in the index and bring the cache back inside
 *  its budget. The caller has already written `decoded`. */
function admit(blob: Blob, rate: number, buffer: AudioBuffer): void {
  const previous = entryOf.get(blob)?.get(rate);
  if (previous) drop(previous);
  const entry: CacheEntry = { blob, rate, buffer, bytes: bufferBytes(buffer) };
  lane(entryOf, blob).set(rate, entry);
  lru.add(entry);
  residentBytes += entry.bytes;
  evictToBudget(entry);
}

/**
 * Set the cache's byte budget, turning eviction ON.
 *
 * With no `budgetBytes` — or a nonsensical one — the budget returns to the
 * module's unbounded default, i.e. eviction is turned back OFF. For the value
 * to configure once pinning is wired, call `defaultDecodeBudgetBytes()`.
 * Shrinking the budget evicts down to it immediately, by the same rules a
 * decode does.
 */
export function configureDecodeCache(options: { budgetBytes?: number } = {}): void {
  const wanted = options.budgetBytes;
  budgetBytes =
    typeof wanted === 'number' && !Number.isNaN(wanted) && wanted >= 0
      ? wanted
      : Number.POSITIVE_INFINITY;
  evictToBudget();
}

/**
 * What the cache is holding. `overBudget` is true only when pins (or in-flight
 * decodes) left nothing that could legally be dropped.
 *
 * `bytes` is decoded PCM only — `numberOfChannels × length × 4` per entry. It
 * does NOT include the encoded source Blobs, which the LRU index also holds a
 * strong reference to for as long as an entry is resident (a few hundred KiB of
 * MP3 against ~81 MiB of PCM for a 4-minute clip, so the omission is small, but
 * it is an omission). `releaseDecoded` is what frees both.
 */
export interface DecodeCacheStats {
  entries: number;
  bytes: number;
  budgetBytes: number;
  pinnedBytes: number;
  overBudget: boolean;
  evictions: number;
}

export function decodeCacheStats(): DecodeCacheStats {
  let pinnedBytes = 0;
  for (const entry of lru) {
    if (pinCount(entry.blob, entry.rate) > 0) pinnedBytes += entry.bytes;
  }
  return {
    entries: lru.size,
    bytes: residentBytes,
    budgetBytes,
    pinnedBytes,
    overBudget: residentBytes > budgetBytes,
    evictions,
  };
}

/**
 * Protect this clip's buffer at this sample rate from eviction.
 *
 * Pins nest: N pins need N unpins, so two overlapping schedulings of the same
 * clip cannot have the first one ending unpin the buffer the second is playing.
 * A pin may be taken before the buffer exists; it applies when it arrives.
 */
export function pinDecoded(blob: Blob, rate: number): void {
  const byRate = lane(pins, blob);
  byRate.set(rate, (byRate.get(rate) ?? 0) + 1);
}

/** Release one pin. An unpin with no matching pin is a no-op — the counter never
 *  goes negative, so a stray release cannot make a live buffer evictable. */
export function unpinDecoded(blob: Blob, rate: number): void {
  const byRate = pins.get(blob);
  const held = byRate?.get(rate) ?? 0;
  if (!byRate || held <= 0) return;
  if (held === 1) byRate.delete(rate);
  else byRate.set(rate, held - 1);
}

/**
 * Run `fn` with the clip's buffer pinned, releasing the pin when it is done —
 * including when it throws, and including when it is async, in which case the
 * pin is held until the returned promise settles.
 */
export function withPinned<T>(blob: Blob, rate: number, fn: () => T): T {
  pinDecoded(blob, rate);
  let result: T;
  try {
    result = fn();
  } catch (err) {
    unpinDecoded(blob, rate);
    throw err;
  }
  const maybeThenable = result as unknown as PromiseLike<unknown> | undefined;
  if (maybeThenable && typeof (maybeThenable as { then?: unknown }).then === 'function') {
    const release = () => unpinDecoded(blob, rate);
    void Promise.resolve(maybeThenable).then(release, release);
    return result;
  }
  unpinDecoded(blob, rate);
  return result;
}

/**
 * Forget one clip: drop every rate's buffer for this Blob.
 *
 * For the caller that knows a clip is gone — deleted from the timeline, or a
 * project being closed — because nothing else will ever tell this module that.
 * The LRU index holds a STRONG reference to each cached Blob (it has to; the
 * WeakMap cannot be walked), so without this call a deleted clip's decoded PCM
 * *and* its encoded Blob stay resident until the budget happens to evict them —
 * and with the default unbounded budget, that is never.
 *
 * Pinned entries and entries whose Blob has a decode in flight are left alone,
 * by the same rule eviction follows; calling it for a clip that was never
 * decoded is a no-op. Called from `state/editorStore.ts`'s `releaseClipAudio`
 * (`removeClip`, `removeTrack`, `loadProject` — T66B), which skips this call
 * entirely for any Blob a clip still live in the document shares (see the
 * module header).
 */
export function releaseDecoded(blob: Blob): void {
  if ((inFlight.get(blob)?.size ?? 0) > 0) return;
  const byRate = entryOf.get(blob);
  if (!byRate) return;
  for (const entry of [...byRate.values()]) {
    if (pinCount(entry.blob, entry.rate) > 0) continue;
    drop(entry);
  }
}

/**
 * Drop every unpinned buffer. Pinned entries stay — something is playing them,
 * and the point of a pin is that no caller, not even this one, can take it.
 */
export function clearDecodeCache(): void {
  for (const entry of [...lru]) {
    if (pinCount(entry.blob, entry.rate) > 0) continue;
    drop(entry);
  }
}

function lane<T>(store: WeakMap<Blob, Map<number, T>>, blob: Blob): Map<number, T> {
  let byRate = store.get(blob);
  if (!byRate) {
    byRate = new Map<number, T>();
    store.set(blob, byRate);
  }
  return byRate;
}

/**
 * The decoded buffer for a clip at this context's sample rate, if one is
 * already in the cache.
 *
 * A peek COUNTS AS A USE: it moves the entry to the most-recently-used end of
 * the LRU order, because the scheduler peeks exactly the clips it is about to
 * play and an order that ignored that would evict them first. It is also why a
 * peek can return `undefined` for a clip `decodeClipBlob` resolved earlier: if a
 * budget is configured, the buffer may have been evicted in between, and unlike
 * `decodeClipBlob` a peek cannot re-decode. Pin what you schedule.
 *
 * For the synchronous readers on the live path — the scheduler builds source
 * nodes inside a loop that cannot await, having called `decodeClipBlob` for
 * every clip beforehand.
 */
export function peekDecoded(ctx: BaseAudioContext, blob: Blob): AudioBuffer | undefined {
  const rate = ctx.sampleRate;
  const hit = decoded.get(blob)?.get(rate);
  // A peek is a USE: the scheduler peeks every clip it is about to play, and an
  // eviction order that ignored that would drop the clips being played in favour
  // of the ones nobody has asked for since they landed.
  if (hit) {
    const entry = entryOf.get(blob)?.get(rate);
    if (entry) touch(entry);
  }
  return hit;
}

async function runDecode(ctx: BaseAudioContext, blob: Blob, rate: number): Promise<AudioBuffer> {
  const bytes = await blob.arrayBuffer();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // `slice(0)` because decodeAudioData detaches the buffer it is given, and a
    // retry after a failure would otherwise be handed an empty one.
    const buffer = await Promise.race([
      ctx.decodeAudioData(bytes.slice(0)),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('decodeAudioData timeout')), DECODE_TIMEOUT_MS);
      }),
    ]);
    lane(decoded, blob).set(rate, buffer);
    admit(blob, rate, buffer);
    return buffer;
  } finally {
    // The deadline is disarmed once the race is decided either way. The old
    // per-site copies left it armed, which held a timer handle (and, under a
    // test runner, the whole process) alive for the full 15 s.
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Decode a clip's audio Blob, reusing the buffer if any other part of the app
 * has already decoded it at this context's sample rate.
 *
 * `ctx` does the decoding and sets the rate; the resulting buffer belongs to no
 * context in particular and may be played on any of them. A failed decode is
 * not cached, so the caller may retry.
 */
export function decodeClipBlob(ctx: BaseAudioContext, blob: Blob): Promise<AudioBuffer> {
  const rate = ctx.sampleRate;

  const hit = decoded.get(blob)?.get(rate);
  if (hit) {
    const entry = entryOf.get(blob)?.get(rate);
    if (entry) touch(entry);
    return Promise.resolve(hit);
  }

  const pending = inFlight.get(blob)?.get(rate);
  if (pending) return pending;

  const started = runDecode(ctx, blob, rate);
  lane(inFlight, blob).set(rate, started);
  // Clear the in-flight slot however it settles — on success the buffer has
  // already moved into `decoded`, and on failure the next caller must be free
  // to try again rather than re-await a promise that is known to reject.
  // Both handlers return undefined, so this derived promise never rejects and
  // the caller's own rejection stays the only one to handle.
  const release = () => {
    const byRate = inFlight.get(blob);
    if (byRate?.get(rate) === started) byRate.delete(rate);
  };
  void started.then(release, release);
  return started;
}
