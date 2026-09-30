/**
 * One decode cache for the whole DAW.
 *
 * Every audio path used to decode a whole file into its own in-RAM AudioBuffer
 * (44.1 kHz stereo float32 ≈ 0.35 MB/s, ~85 MB for a 4-minute track): the live
 * mixer kept one Blob-keyed cache, and each offline renderer kept another. So
 * bouncing a project that was already playing re-decoded every clip and roughly
 * doubled peak memory — enough to OOM the Electron renderer on a 16 GB laptop.
 *
 * What this suite pins down is the part that is easy to get subtly wrong when
 * one cache is shared by the live path and the bounces: a failed decode must
 * NOT be remembered (otherwise one blip poisons every later bounce of that
 * clip), and two callers racing for the same clip must produce exactly one
 * decodeAudioData call, not two.
 *
 * And the one that is invisible until someone listens closely: decodeAudioData
 * resamples to the context's rate, and the live engine context runs at the
 * DEVICE rate while every offline renderer pins 44100. Handing a bounce the
 * 48 kHz buffer the live path decoded would make it resample 44.1 → 48 → 44.1
 * for material that needed no resampling at all — and would make a bounce's
 * output depend on whether the user had pressed play first. Entries are
 * therefore per rate.
 *
 * The context is a fake: decodeAudioData resolves, rejects, or never settles on
 * command, and timers are faked so the 15 s race is exercised in microseconds.
 *
 * Run: npx tsx src/lib/decodeCache.test.ts
 */
import assert from 'node:assert/strict';

/* ── fake timers ──────────────────────────────────────────────────────────
 * Installed for the whole suite, so the 15 s timeout is both assertable and
 * unable to keep the test process alive for 15 s after the last assertion.
 * A leaked timer would show up here as `cancelled === false`.                */

interface FakeTimer {
  cb: () => void;
  ms: number;
  cancelled: boolean;
  fired: boolean;
}

const timers: FakeTimer[] = [];
const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;

globalThis.setTimeout = ((cb: () => void, ms: number) => {
  const t: FakeTimer = { cb, ms, cancelled: false, fired: false };
  timers.push(t);
  return t as unknown as ReturnType<typeof setTimeout>;
}) as unknown as typeof setTimeout;

globalThis.clearTimeout = ((handle: unknown) => {
  if (handle && typeof handle === 'object') (handle as FakeTimer).cancelled = true;
}) as unknown as typeof clearTimeout;

/** Fire every timer that is still armed (the 15 s deadline elapsing). */
const elapse = () => {
  for (const t of timers) {
    if (t.cancelled || t.fired) continue;
    t.fired = true;
    t.cb();
  }
};

/** Let queued microtasks (the decode chain) run to completion. */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/* ── fake context ─────────────────────────────────────────────────────────── */

/** A distinguishable stand-in for a decoded buffer (identity is what we assert). */
const makeBuffer = (tag: string, sampleRate = 44100) =>
  ({ tag, duration: 1, sampleRate }) as unknown as AudioBuffer;

type Outcome =
  | { kind: 'resolve'; buffer: AudioBuffer }
  | { kind: 'reject'; error: Error }
  | { kind: 'hang' };

class FakeContext {
  calls: ArrayBuffer[] = [];
  private outcomes: Outcome[] = [];

  /** Renderers pin 44100; the live engine context is whatever the device gives. */
  constructor(readonly sampleRate = 44100) {}

  /** Queue what the NEXT decodeAudioData call does (falls back to the last one). */
  will(outcome: Outcome): this {
    this.outcomes.push(outcome);
    return this;
  }

  decodeAudioData(data: ArrayBuffer): Promise<AudioBuffer> {
    this.calls.push(data);
    const outcome = this.outcomes.shift() ?? { kind: 'hang' as const };
    if (outcome.kind === 'resolve') return Promise.resolve(outcome.buffer);
    if (outcome.kind === 'reject') return Promise.reject(outcome.error);
    return new Promise<AudioBuffer>(() => {});
  }

  get ctx(): BaseAudioContext {
    return this as unknown as BaseAudioContext;
  }
}

const {
  DECODE_TIMEOUT_MS,
  decodeClipBlob,
  peekDecoded,
  configureDecodeCache,
  defaultDecodeBudgetBytes,
  decodeCacheStats,
  releaseDecoded,
  pinDecoded,
  unpinDecoded,
  withPinned,
  clearDecodeCache,
} = await import('./decodeCache.ts');

/** A fake buffer with real accounting fields: 2 channels × 128 frames × 4 bytes
 *  is exactly 1 KiB, so budgets below read in KiB and the arithmetic in the
 *  assertions is exact rather than approximate. */
const KIB = 1024;
const makeKib = (tag: string, kib: number, sampleRate = 44100) =>
  ({
    tag,
    numberOfChannels: 2,
    length: kib * 128,
    sampleRate,
    duration: (kib * 128) / sampleRate,
  }) as unknown as AudioBuffer;

/** A fresh Blob per call — identity is the cache key, contents are irrelevant. */
const clipBlob = () => new Blob([new Uint8Array([1])], { type: 'audio/wav' });

/* ── one decode serves every caller ───────────────────────────────────────── */

{
  const blob = new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'audio/wav' });
  const want = makeBuffer('clip-a');
  const fake = new FakeContext().will({ kind: 'resolve', buffer: want });

  // The live mixer decodes it for playback…
  const first = await decodeClipBlob(fake.ctx, blob);
  assert.equal(first, want);
  assert.equal(fake.calls.length, 1);

  // …and the bounce that follows reuses the very same buffer. Equality here is
  // identity, not deep-equality: a second AudioBuffer is the 85 MB we are
  // trying not to allocate twice.
  const second = await decodeClipBlob(fake.ctx, blob);
  assert.equal(second, want, 'a cached clip is not decoded again');
  assert.equal(fake.calls.length, 1, 'no second decodeAudioData call');

  // It really was handed the clip's bytes. That a DETACHING decoder — which is
  // what the real decodeAudioData is — cannot break a later decode of the same
  // Blob is proved below, in the block where the fake detaches for real.
  assert.equal(fake.calls[0].byteLength, 4);

  // The synchronous readers the live scheduler uses see it without awaiting.
  assert.equal(peekDecoded(fake.ctx, blob), want);

  // The timeout guard was armed at the value the live mixer has always used,
  // and disarmed once the decode won the race.
  assert.equal(DECODE_TIMEOUT_MS, 15000);
  assert.equal(timers.length, 1);
  assert.equal(timers[0].ms, 15000);
  assert.equal(timers[0].cancelled, true, 'a won race leaves no 15 s timer behind');
}

/* ── distinct clips are distinct entries ──────────────────────────────────── */

{
  const blobA = new Blob([new Uint8Array([9])], { type: 'audio/wav' });
  const blobB = new Blob([new Uint8Array([9])], { type: 'audio/wav' });
  const bufA = makeBuffer('a');
  const bufB = makeBuffer('b');
  const fake = new FakeContext()
    .will({ kind: 'resolve', buffer: bufA })
    .will({ kind: 'resolve', buffer: bufB });

  assert.equal(await decodeClipBlob(fake.ctx, blobA), bufA);
  // Same bytes, different Blob object: keyed by identity, so an edited clip
  // (which gets a fresh Blob) re-decodes instead of playing the stale audio.
  assert.equal(await decodeClipBlob(fake.ctx, blobB), bufB);
  assert.equal(fake.calls.length, 2);
  assert.equal(peekDecoded(fake.ctx, blobA), bufA);
  assert.equal(peekDecoded(fake.ctx, blobB), bufB);
}

/* ── a buffer is only reused at the rate that asked for it ────────────────── */

{
  const blob = new Blob([new Uint8Array([4, 4])], { type: 'audio/wav' });
  const at48 = makeBuffer('live-48k', 48000);
  const at44 = makeBuffer('bounce-44k1', 44100);

  // The live engine context on a 48 kHz output device: decodeAudioData resamples
  // the 44.1 kHz source up on the way in, and the live path plays that.
  const live = new FakeContext(48000).will({ kind: 'resolve', buffer: at48 });
  assert.equal(await decodeClipBlob(live.ctx, blob), at48);

  // A bounce now runs. Its OfflineAudioContext is 44100 and it decodes at 44100
  // to match, so its source needs no resampling at all. Handing it the 48 kHz
  // buffer would silently insert a 44.1 → 48 → 44.1 round trip AND make the
  // bounce differ depending on whether the user pressed play first.
  const bounce = new FakeContext(44100).will({ kind: 'resolve', buffer: at44 });
  assert.equal(
    await decodeClipBlob(bounce.ctx, blob),
    at44,
    'a bounce at 44100 does not inherit the live 48 kHz buffer',
  );
  assert.equal(bounce.calls.length, 1, 'it really decoded at its own rate');

  // Both entries stand: each caller keeps getting the buffer at its own rate,
  // and neither re-decodes.
  assert.equal(await decodeClipBlob(live.ctx, blob), at48);
  assert.equal(live.calls.length, 1, 'the live entry was not evicted by the bounce');
  assert.equal(await decodeClipBlob(bounce.ctx, blob), at44);
  assert.equal(bounce.calls.length, 1);

  assert.equal(peekDecoded(live.ctx, blob), at48);
  assert.equal(peekDecoded(bounce.ctx, blob), at44);

  // The renderers all pin 44100, so they share with each other unconditionally —
  // which is the dedupe a single bounce of a timeline reusing one clip relies on.
  const otherRenderer = new FakeContext(44100);
  assert.equal(await decodeClipBlob(otherRenderer.ctx, blob), at44);
  assert.equal(otherRenderer.calls.length, 0, 'a second renderer at 44100 reuses the buffer');
}

/* ── a clip not yet decoded ───────────────────────────────────────────────── */

{
  const fake = new FakeContext();
  const blob = new Blob([new Uint8Array([7])], { type: 'audio/wav' });
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'an undecoded clip peeks as undefined');
}

/* ── two callers racing for one clip decode it once ───────────────────────── */

{
  const blob = new Blob([new Uint8Array([5, 5])], { type: 'audio/wav' });
  const want = makeBuffer('shared');
  let release!: (b: AudioBuffer) => void;
  const fake = new FakeContext();
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    fake.calls.push(data);
    return new Promise<AudioBuffer>((resolve) => {
      release = resolve;
    });
  }) as typeof fake.decodeAudioData;

  // Playback starts and a bounce is kicked off before the decode returns.
  const live = decodeClipBlob(fake.ctx, blob);
  const bounce = decodeClipBlob(fake.ctx, blob);
  await settle();
  assert.equal(fake.calls.length, 1, 'the in-flight decode is shared, not restarted');

  // Nothing is cached until it actually lands — a half-decoded clip must never
  // be visible to the scheduler.
  assert.equal(peekDecoded(fake.ctx, blob), undefined);

  release(want);
  assert.equal(await live, want);
  assert.equal(await bounce, want, 'both callers get the one buffer');
  assert.equal(peekDecoded(fake.ctx, blob), want);
}

/* ── a failed decode is not remembered ────────────────────────────────────── */

{
  const blob = new Blob([new Uint8Array([0, 1, 2, 3, 4, 5])], { type: 'audio/wav' });
  const good = makeBuffer('recovered');
  const fake = new FakeContext()
    .will({ kind: 'reject', error: new Error('EncodingError') })
    .will({ kind: 'resolve', buffer: good });

  // The real decodeAudioData DETACHES the ArrayBuffer it is handed, so this fake
  // does too. Byte lengths are recorded before detaching, because afterwards the
  // recorded buffer reads as empty.
  const handed: number[] = [];
  const inner = fake.decodeAudioData.bind(fake);
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    handed.push(data.byteLength);
    const decoding = inner(data);
    structuredClone(data, { transfer: [data] }); // detach, exactly as the decoder does
    return decoding;
  }) as typeof fake.decodeAudioData;

  await assert.rejects(decodeClipBlob(fake.ctx, blob), /EncodingError/);
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'a rejected decode is not cached');
  assert.equal(fake.calls[0].byteLength, 0, 'the fake really detached the first attempt');

  // …and the clip is not written off: the next attempt really re-decodes, and is
  // handed the WHOLE clip again rather than the husk the failed decode left.
  assert.equal(await decodeClipBlob(fake.ctx, blob), good, 'a later call retries');
  assert.equal(fake.calls.length, 2);
  assert.deepEqual(handed, [6, 6], 'the retry gets the full bytes, not a detached buffer');
  assert.equal(peekDecoded(fake.ctx, blob), good);
}

/* ── a shared decode that fails, fails both callers and releases the slot ──── */

{
  const blob = new Blob([new Uint8Array([8, 8])], { type: 'audio/wav' });
  const good = makeBuffer('after-shared-failure');
  let failIt!: (e: Error) => void;
  const fake = new FakeContext();
  let attempt = 0;
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    fake.calls.push(data);
    attempt += 1;
    if (attempt === 1) {
      return new Promise<AudioBuffer>((_, reject) => {
        failIt = reject;
      });
    }
    return Promise.resolve(good);
  }) as typeof fake.decodeAudioData;

  // Playback and a bounce both wait on the one decode…
  const live = decodeClipBlob(fake.ctx, blob);
  const bounce = decodeClipBlob(fake.ctx, blob);
  await settle();
  assert.equal(fake.calls.length, 1);

  // …and it fails. Neither caller may be left hanging on a promise nobody will
  // settle, and neither may quietly receive a buffer that does not exist.
  failIt(new Error('EncodingError'));
  await assert.rejects(live, /EncodingError/);
  await assert.rejects(bounce, /EncodingError/, 'the shared decode fails both callers');
  assert.equal(peekDecoded(fake.ctx, blob), undefined);

  // The in-flight slot was released on the failure, so the clip is retryable —
  // it is not stuck re-awaiting a promise that is known to reject.
  assert.equal(await decodeClipBlob(fake.ctx, blob), good, 'the released slot allows a retry');
  assert.equal(fake.calls.length, 2);
}

/* ── concurrent callers at different rates do not de-dupe each other ───────── */

{
  const blob = new Blob([new Uint8Array([6, 6])], { type: 'audio/wav' });
  const at48 = makeBuffer('live-48k', 48000);
  const at44 = makeBuffer('bounce-44k1', 44100);
  let release48!: (b: AudioBuffer) => void;
  let release44!: (b: AudioBuffer) => void;

  const live = new FakeContext(48000);
  live.decodeAudioData = ((data: ArrayBuffer) => {
    live.calls.push(data);
    return new Promise<AudioBuffer>((resolve) => {
      release48 = resolve;
    });
  }) as typeof live.decodeAudioData;

  const bounce = new FakeContext(44100);
  bounce.decodeAudioData = ((data: ArrayBuffer) => {
    bounce.calls.push(data);
    return new Promise<AudioBuffer>((resolve) => {
      release44 = resolve;
    });
  }) as typeof bounce.decodeAudioData;

  // Playback (device rate) and a bounce (pinned 44100) start together on the
  // same clip. The in-flight de-dupe must be per lane: collapsing these would
  // hand one of them audio at the wrong rate.
  const p48 = decodeClipBlob(live.ctx, blob);
  const p44 = decodeClipBlob(bounce.ctx, blob);
  await settle();
  assert.equal(live.calls.length, 1, 'the 48 kHz lane decoded');
  assert.equal(bounce.calls.length, 1, 'the 44.1 kHz lane decoded separately');

  release48(at48);
  release44(at44);
  assert.equal(await p48, at48);
  assert.equal(await p44, at44);
  assert.notEqual(await p48, await p44, 'two buffers, one per rate');
  assert.equal(peekDecoded(live.ctx, blob), at48, 'each lands in its own lane');
  assert.equal(peekDecoded(bounce.ctx, blob), at44);
}

/* ── the timeout rejects and does not poison the cache ────────────────────── */

{
  const blob = new Blob([new Uint8Array([3, 3, 3])], { type: 'audio/wav' });
  const good = makeBuffer('second-try');
  const fake = new FakeContext().will({ kind: 'hang' }).will({ kind: 'resolve', buffer: good });

  const stuck = decodeClipBlob(fake.ctx, blob);
  await settle();
  const armed = timers.filter((t) => !t.cancelled && !t.fired);
  assert.equal(armed.length, 1, 'a decode in flight has exactly one deadline armed');
  assert.equal(armed[0].ms, 15000);

  elapse();
  await assert.rejects(stuck, /decodeAudioData timeout/);

  // The clip is still playable: a stalled decode leaves no entry behind, so the
  // next play or bounce tries again instead of inheriting the failure forever.
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'a timed-out decode is not cached');
  assert.equal(await decodeClipBlob(fake.ctx, blob), good, 'a later call retries');
  assert.equal(fake.calls.length, 2);
}

/* ── a decode that loses the race and lands late is discarded ─────────────── */

{
  const blob = new Blob([new Uint8Array([2, 2, 2])], { type: 'audio/wav' });
  const tooLate = makeBuffer('arrived-after-the-deadline');
  const fresh = makeBuffer('fresh');
  let resolveLate!: (b: AudioBuffer) => void;
  const fake = new FakeContext();
  let attempt = 0;
  fake.decodeAudioData = ((data: ArrayBuffer) => {
    fake.calls.push(data);
    attempt += 1;
    if (attempt === 1) {
      return new Promise<AudioBuffer>((resolve) => {
        resolveLate = resolve;
      });
    }
    return Promise.resolve(fresh);
  }) as typeof fake.decodeAudioData;

  const stuck = decodeClipBlob(fake.ctx, blob);
  await settle();
  const armed = timers.filter((t) => !t.cancelled && !t.fired);
  assert.equal(armed.length, 1);
  elapse();
  await assert.rejects(stuck, /decodeAudioData timeout/);

  // The decoder finally comes back — a slow file on a busy machine, not an
  // error. The caller has already been told it failed, so this buffer must be
  // dropped on the floor: writing it now would resurrect a decode nobody is
  // waiting for and hand it to whoever asks next.
  resolveLate(tooLate);
  await settle();
  assert.equal(peekDecoded(fake.ctx, blob), undefined, 'a late buffer never lands in the cache');

  // The next caller decodes afresh and gets ITS buffer, not the stale one.
  assert.equal(await decodeClipBlob(fake.ctx, blob), fresh, 'the next call decodes afresh');
  assert.equal(fake.calls.length, 2);
  assert.equal(peekDecoded(fake.ctx, blob), fresh);
}

/* ── out of the box, nothing is ever evicted ──────────────────────────────── */

{
  // The budget the module STARTS with, before anything configures it. It is
  // unbounded on purpose: the live mixer awaits decodeClipBlob for every clip in
  // turn and only then reads them all back with peekDecoded, so a budget that
  // evicted the earliest clips while the later ones decoded would make them peek
  // as undefined and never be scheduled — silent clips, not a slower load. Until
  // scheduleClips pins what it schedules (wave-2), eviction stays off.
  assert.equal(
    decodeCacheStats().budgetBytes,
    Number.POSITIVE_INFINITY,
    'the fresh default budget is unbounded',
  );

  const evictedBefore = decodeCacheStats().evictions;
  const fake = new FakeContext();
  const blobs: Blob[] = [];
  for (let i = 0; i < 12; i += 1) {
    const blob = clipBlob();
    blobs.push(blob);
    fake.will({ kind: 'resolve', buffer: makeKib(`bulk-${i}`, 64) });
    await decodeClipBlob(fake.ctx, blob);
  }

  // 768 KiB of clips decoded one after another, exactly as ensureDecoded does…
  assert.equal(decodeCacheStats().bytes, 12 * 64 * KIB);
  assert.equal(decodeCacheStats().evictions, evictedBefore, 'the default evicts nothing');
  assert.equal(decodeCacheStats().overBudget, false, 'and cannot be over an unbounded budget');
  // …and every one of them is still there when the scheduler peeks them back.
  for (const blob of blobs) {
    assert.notEqual(peekDecoded(fake.ctx, blob), undefined, 'every decoded clip peeks back');
  }

  // The value to turn eviction on WITH is available, but opting in is explicit.
  assert.equal(typeof defaultDecodeBudgetBytes(), 'number');
  assert.ok(defaultDecodeBudgetBytes() > 0);
}

/* ── the byte budget: accounting is exact ─────────────────────────────────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 4 * KIB });

  const before = decodeCacheStats();
  assert.equal(before.entries, 0, 'clearDecodeCache emptied the index');
  assert.equal(before.bytes, 0);
  assert.equal(before.budgetBytes, 4 * KIB);
  assert.equal(before.pinnedBytes, 0);
  assert.equal(before.overBudget, false);

  const blob = clipBlob();
  const buf = makeKib('accounted', 3);
  const fake = new FakeContext().will({ kind: 'resolve', buffer: buf });
  await decodeClipBlob(fake.ctx, blob);

  const stats = decodeCacheStats();
  // numberOfChannels × length × 4 — the whole of the accounting rule.
  assert.equal(stats.bytes, 2 * 3 * 128 * 4);
  assert.equal(stats.bytes, 3 * KIB);
  assert.equal(stats.entries, 1);
  assert.equal(stats.overBudget, false, '3 KiB under a 4 KiB budget');
}

/* ── over budget evicts the least recently USED, not the oldest ───────────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 4 * KIB });
  const evictedBefore = decodeCacheStats().evictions;

  const a = clipBlob();
  const b = clipBlob();
  const c = clipBlob();
  const d = clipBlob();
  const bufA = makeKib('a', 1);
  const bufB = makeKib('b', 1);
  const bufC = makeKib('c', 1);
  const bufD = makeKib('d', 2);
  const fake = new FakeContext()
    .will({ kind: 'resolve', buffer: bufA })
    .will({ kind: 'resolve', buffer: bufB })
    .will({ kind: 'resolve', buffer: bufC })
    .will({ kind: 'resolve', buffer: bufD });

  await decodeClipBlob(fake.ctx, a);
  await decodeClipBlob(fake.ctx, b);
  await decodeClipBlob(fake.ctx, c);
  assert.equal(decodeCacheStats().bytes, 3 * KIB, 'three 1 KiB clips fit under 4 KiB');
  assert.equal(decodeCacheStats().evictions, evictedBefore, 'nothing evicted while under budget');

  // A is the oldest by insertion — but the scheduler peeks it again, which is a
  // USE. The victim must be B, or the cache would throw away the clip that is
  // being played and keep the one nobody has touched since it landed.
  assert.equal(peekDecoded(fake.ctx, a), bufA);

  await decodeClipBlob(fake.ctx, d); // 3 + 2 = 5 KiB > 4 KiB
  assert.equal(decodeCacheStats().evictions, evictedBefore + 1, 'exactly one eviction');
  assert.equal(decodeCacheStats().bytes, 4 * KIB);
  assert.equal(decodeCacheStats().entries, 3);
  assert.equal(peekDecoded(fake.ctx, b), undefined, 'the least recently used clip went');
  assert.equal(peekDecoded(fake.ctx, a), bufA, 'the recently touched clip stayed');
  assert.equal(peekDecoded(fake.ctx, c), bufC);
  assert.equal(peekDecoded(fake.ctx, d), bufD, 'the buffer just decoded is never the victim');

  // Asking for B again is transparent to the caller: it re-decodes, exactly
  // once, and the cache stays inside its budget by evicting the next LRU (C).
  const again = makeKib('b-again', 1);
  fake.will({ kind: 'resolve', buffer: again });
  const callsBefore = fake.calls.length;
  assert.equal(await decodeClipBlob(fake.ctx, b), again, 'an evicted clip re-decodes');
  assert.equal(fake.calls.length, callsBefore + 1, 'and re-decodes once');
  assert.equal(await decodeClipBlob(fake.ctx, b), again, 'then it is cached again');
  assert.equal(fake.calls.length, callsBefore + 1);
  assert.equal(decodeCacheStats().bytes, 4 * KIB);
  // The peeks above are themselves uses, in the order they were written, so by
  // the time B came back A was the stalest entry — which is the property under
  // test stated the other way round.
  assert.equal(peekDecoded(fake.ctx, a), undefined, 'A had become the least recently used');
  assert.equal(peekDecoded(fake.ctx, c), bufC, 'and C, peeked more recently, stayed');
}

/* ── a pinned buffer is never evicted ─────────────────────────────────────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 2 * KIB });

  const pinned = clipBlob();
  const loose = clipBlob();
  const fresh = clipBlob();
  const bufP = makeKib('pinned', 1);
  const bufL = makeKib('loose', 1);
  const bufF = makeKib('fresh', 1);
  const fake = new FakeContext()
    .will({ kind: 'resolve', buffer: bufP })
    .will({ kind: 'resolve', buffer: bufL })
    .will({ kind: 'resolve', buffer: bufF });

  await decodeClipBlob(fake.ctx, pinned);
  pinDecoded(pinned, 44100); // what scheduleClips will do for every source it starts
  await decodeClipBlob(fake.ctx, loose);
  assert.equal(decodeCacheStats().pinnedBytes, 1 * KIB, 'pinned bytes are reported separately');

  // The pinned clip is the least recently used, so an LRU-only cache would take
  // it — and silence a source that is already playing from that buffer.
  await decodeClipBlob(fake.ctx, fresh);
  assert.equal(peekDecoded(fake.ctx, pinned), bufP, 'a pinned buffer survives its LRU turn');
  assert.equal(peekDecoded(fake.ctx, loose), undefined, 'the unpinned neighbour went instead');
  assert.equal(peekDecoded(fake.ctx, fresh), bufF);
  assert.equal(decodeCacheStats().bytes, 2 * KIB);

  // Nested pins: two overlapping schedulings of the same clip, and the first one
  // ending must not unpin the buffer the second is still playing.
  pinDecoded(pinned, 44100);
  unpinDecoded(pinned, 44100);
  const second = clipBlob();
  fake.will({ kind: 'resolve', buffer: makeKib('second', 1) });
  await decodeClipBlob(fake.ctx, second);
  assert.equal(peekDecoded(fake.ctx, pinned), bufP, 'still pinned by the outstanding pin');

  // The last unpin releases it, and then it is an ordinary LRU candidate again.
  unpinDecoded(pinned, 44100);
  assert.equal(decodeCacheStats().pinnedBytes, 0);
  assert.notEqual(peekDecoded(fake.ctx, second), undefined); // make `pinned` the LRU again
  const third = clipBlob();
  fake.will({ kind: 'resolve', buffer: makeKib('third', 1) });
  await decodeClipBlob(fake.ctx, third);
  assert.equal(peekDecoded(fake.ctx, pinned), undefined, 'the released buffer is evictable');
}

/* ── pins win over the budget, and the overrun is reported not hidden ─────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 2 * KIB });
  const evictedBefore = decodeCacheStats().evictions;

  const one = clipBlob();
  const two = clipBlob();
  const three = clipBlob();
  const fake = new FakeContext()
    .will({ kind: 'resolve', buffer: makeKib('one', 1) })
    .will({ kind: 'resolve', buffer: makeKib('two', 1) })
    .will({ kind: 'resolve', buffer: makeKib('three', 1) });

  await decodeClipBlob(fake.ctx, one);
  pinDecoded(one, 44100);
  await decodeClipBlob(fake.ctx, two);
  pinDecoded(two, 44100);
  await decodeClipBlob(fake.ctx, three);

  // Every entry is either pinned or the one just decoded, so there is nothing
  // the cache is allowed to drop. Going over budget is correct — dropping a
  // buffer a live source is playing is not — but it is stated in the stats so a
  // caller that over-pins is visible rather than mysteriously fat.
  const stats = decodeCacheStats();
  assert.equal(stats.entries, 3);
  assert.equal(stats.bytes, 3 * KIB);
  assert.equal(stats.pinnedBytes, 2 * KIB);
  assert.equal(stats.overBudget, true, 'over budget because everything evictable was pinned');
  assert.equal(stats.evictions, evictedBefore, 'no pinned buffer was taken');

  // clearDecodeCache honours the same rule.
  clearDecodeCache();
  const after = decodeCacheStats();
  assert.equal(after.entries, 2, 'clear keeps pinned entries');
  assert.equal(after.bytes, 2 * KIB);
  assert.equal(peekDecoded(fake.ctx, three), undefined, 'and drops the unpinned ones');
  assert.equal(peekDecoded(fake.ctx, one)?.length, 1 * 128);

  unpinDecoded(one, 44100);
  unpinDecoded(two, 44100);
  clearDecodeCache();
  assert.equal(decodeCacheStats().entries, 0);
  assert.equal(decodeCacheStats().bytes, 0);
}

/* ── withPinned holds the pin for exactly the work it wraps ───────────────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 1 * KIB });

  const held = clipBlob();
  const fake = new FakeContext().will({ kind: 'resolve', buffer: makeKib('held', 1) });
  await decodeClipBlob(fake.ctx, held);

  const inside = withPinned(held, 44100, () => decodeCacheStats().pinnedBytes);
  assert.equal(inside, 1 * KIB, 'pinned for the duration of the callback');
  assert.equal(decodeCacheStats().pinnedBytes, 0, 'and released after it');

  // An async body keeps the pin until the promise settles, and a throw still
  // releases it — a leaked pin is a buffer that can never be evicted again.
  const asyncPin = withPinned(held, 44100, async () => {
    await Promise.resolve();
    return decodeCacheStats().pinnedBytes;
  });
  assert.equal(decodeCacheStats().pinnedBytes, 1 * KIB, 'still pinned while awaiting');
  assert.equal(await asyncPin, 1 * KIB);
  assert.equal(decodeCacheStats().pinnedBytes, 0);

  assert.throws(() => {
    withPinned(held, 44100, () => {
      throw new Error('scheduling failed');
    });
  }, /scheduling failed/);
  assert.equal(decodeCacheStats().pinnedBytes, 0, 'a throwing body does not leak its pin');

  await assert.rejects(
    withPinned(held, 44100, async () => {
      await Promise.resolve();
      throw new Error('async scheduling failed');
    }),
    /async scheduling failed/,
  );
  assert.equal(decodeCacheStats().pinnedBytes, 0);

  // An unpin with no matching pin is a no-op, not a negative counter.
  unpinDecoded(held, 44100);
  assert.equal(decodeCacheStats().pinnedBytes, 0);
}

/* ── a clip with a decode in flight is not evicted out from under it ──────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 2 * KIB });

  const busy = clipBlob(); // resident at 44100, and decoding at 48000
  const idle = clipBlob();
  const incoming = clipBlob();

  const at44 = new FakeContext(44100).will({ kind: 'resolve', buffer: makeKib('busy-44', 1) });
  await decodeClipBlob(at44.ctx, busy);
  at44.will({ kind: 'resolve', buffer: makeKib('idle', 1) });
  await decodeClipBlob(at44.ctx, idle);

  const at48 = new FakeContext(48000).will({ kind: 'hang' });
  const stuck = decodeClipBlob(at48.ctx, busy);
  await settle();

  // `busy` is the least recently used, but a decode of that very Blob is in
  // flight; taking its other-rate entry now would race the decode that is about
  // to write beside it. The next candidate goes instead.
  const arriving = new FakeContext(44100).will({ kind: 'resolve', buffer: makeKib('incoming', 1) });
  await decodeClipBlob(arriving.ctx, incoming);
  assert.equal(peekDecoded(at44.ctx, busy)?.length, 1 * 128, 'the busy blob was skipped');
  assert.equal(peekDecoded(at44.ctx, idle), undefined, 'the idle neighbour was evicted');

  elapse();
  await assert.rejects(stuck, /decodeAudioData timeout/);
}

/* ── a failed decode costs the cache nothing ──────────────────────────────── */

{
  clearDecodeCache();
  configureDecodeCache({ budgetBytes: 4 * KIB });
  const blob = clipBlob();
  const fake = new FakeContext().will({ kind: 'reject', error: new Error('EncodingError') });

  await assert.rejects(decodeClipBlob(fake.ctx, blob), /EncodingError/);
  const stats = decodeCacheStats();
  assert.equal(stats.entries, 0, 'a rejected decode is not accounted');
  assert.equal(stats.bytes, 0);
  assert.equal(stats.overBudget, false);
}

/* ── releasing a clip frees it without waiting for a budget ───────────────── */

{
  clearDecodeCache();
  configureDecodeCache({}); // unbounded: nothing will ever evict these for us

  const deleted = clipBlob();
  const kept = clipBlob();
  const live = new FakeContext(48000).will({ kind: 'resolve', buffer: makeKib('del-48', 1, 48000) });
  const bounce = new FakeContext(44100).will({ kind: 'resolve', buffer: makeKib('del-44', 1) });
  await decodeClipBlob(live.ctx, deleted);
  await decodeClipBlob(bounce.ctx, deleted);
  bounce.will({ kind: 'resolve', buffer: makeKib('kept-44', 1) });
  await decodeClipBlob(bounce.ctx, kept);
  assert.equal(decodeCacheStats().entries, 3, 'the deleted clip is resident at two rates');
  assert.equal(decodeCacheStats().bytes, 3 * KIB);

  // The user deletes the clip. Nothing else can tell this module that: the LRU
  // index holds a strong reference to the Blob, and with no budget there is no
  // eviction to collect it, so both rates would stay resident forever.
  releaseDecoded(deleted);
  assert.equal(peekDecoded(live.ctx, deleted), undefined, 'every rate of the clip went');
  assert.equal(peekDecoded(bounce.ctx, deleted), undefined);
  assert.equal(decodeCacheStats().entries, 1, 'and only that clip');
  assert.equal(decodeCacheStats().bytes, 1 * KIB);
  assert.notEqual(peekDecoded(bounce.ctx, kept), undefined);

  // Releasing a clip that was never decoded is a no-op, not a throw.
  releaseDecoded(clipBlob());
  assert.equal(decodeCacheStats().entries, 1);

  // A pinned clip is not released — the pin means something is playing it, and
  // that outranks a caller who thinks the clip is gone.
  pinDecoded(kept, 44100);
  releaseDecoded(kept);
  assert.notEqual(peekDecoded(bounce.ctx, kept), undefined, 'a pinned clip survives release');
  unpinDecoded(kept, 44100);
  releaseDecoded(kept);
  assert.equal(peekDecoded(bounce.ctx, kept), undefined, 'and goes once unpinned');
  assert.equal(decodeCacheStats().entries, 0);

  // Nor is a clip released while a decode of it is in flight — that decode is
  // about to write an entry the release would not have seen.
  const busy = clipBlob();
  const at44 = new FakeContext(44100).will({ kind: 'resolve', buffer: makeKib('busy-44', 1) });
  await decodeClipBlob(at44.ctx, busy);
  const at48 = new FakeContext(48000).will({ kind: 'hang' });
  const stuck = decodeClipBlob(at48.ctx, busy);
  await settle();
  releaseDecoded(busy);
  assert.notEqual(peekDecoded(at44.ctx, busy), undefined, 'release defers to an in-flight decode');
  elapse();
  await assert.rejects(stuck, /decodeAudioData timeout/);
  releaseDecoded(busy);
  assert.equal(peekDecoded(at44.ctx, busy), undefined, 'and works once it has settled');
}

/* ── the budget to opt in WITH follows the machine, capped at 1 GiB ───────── */

{
  const GIB = 1024 * 1024 * 1024;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  const stubNavigator = (value: unknown) => {
    Object.defineProperty(globalThis, 'navigator', {
      value,
      configurable: true,
      writable: true,
    });
  };

  // A 2 GB machine: a quarter of it, which is well under the cap.
  stubNavigator({ deviceMemory: 2 });
  assert.equal(defaultDecodeBudgetBytes(), 0.25 * 2 * GIB);

  // A 64 GB workstation: a quarter would be 16 GiB, so the 1 GiB cap decides.
  stubNavigator({ deviceMemory: 64 });
  assert.equal(defaultDecodeBudgetBytes(), GIB);

  // Firefox and Safari do not report deviceMemory at all.
  stubNavigator({});
  assert.equal(defaultDecodeBudgetBytes(), GIB, 'no deviceMemory falls back to 1 GiB');

  stubNavigator(undefined);
  assert.equal(defaultDecodeBudgetBytes(), GIB, 'no navigator at all falls back to 1 GiB');

  // It is read at call time, not frozen at module load, so the Electron preload
  // (or a test) that installs a navigator later is seen.
  stubNavigator({ deviceMemory: 3 });
  assert.equal(defaultDecodeBudgetBytes(), 0.25 * 3 * GIB);

  // This is the one call that turns eviction on.
  configureDecodeCache({ budgetBytes: defaultDecodeBudgetBytes() });
  assert.equal(decodeCacheStats().budgetBytes, 0.75 * GIB);

  // Nonsense from a caller — or no argument at all — turns eviction back OFF
  // rather than guessing. A budget the caller did not mean is how live buffers
  // get dropped.
  configureDecodeCache({ budgetBytes: Number.NaN });
  assert.equal(decodeCacheStats().budgetBytes, Number.POSITIVE_INFINITY);
  configureDecodeCache({ budgetBytes: -1 });
  assert.equal(decodeCacheStats().budgetBytes, Number.POSITIVE_INFINITY);
  configureDecodeCache({});
  assert.equal(decodeCacheStats().budgetBytes, Number.POSITIVE_INFINITY);

  // …but an explicit 0 is a real budget: cache nothing that is not pinned.
  configureDecodeCache({ budgetBytes: 0 });
  assert.equal(decodeCacheStats().budgetBytes, 0);

  if (original) Object.defineProperty(globalThis, 'navigator', original);
  else delete (globalThis as { navigator?: unknown }).navigator;
  clearDecodeCache();
  configureDecodeCache({});
}

globalThis.setTimeout = realSetTimeout;
globalThis.clearTimeout = realClearTimeout;

console.log(
  'shared decode cache: dedupe, in-flight sharing, timeout and failure recovery, ' +
    'byte budget, LRU eviction, pinning and stats passed',
);
