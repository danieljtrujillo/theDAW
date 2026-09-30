// liveMixer: comping plays live, and the decode-cache pins that make a budget
// safe (T46B).
//
// Three jobs:
//
//  1. THE COMP WIRING. A clip with two takes and a comp plays each region from
//     its own take: one `computeClipSchedule` per comp segment, each on its own
//     seam gain carrying the boundary crossfade, all feeding the ONE whole-clip
//     fade envelope and the ONE mute gate. The crossfade is the LINEAR pair
//     (`in + out = 1`, lib/crossfade.ts:19-22) because two takes of the same
//     performance are correlated; the two sides are asserted to sum to unity
//     across the seam.
//
//  2. THE NON-COMPED PIN. Every clip that is not comped must schedule
//     byte-identically to before comping existed. The literal node list, start
//     arguments and envelope events are captured here, and a clip carrying
//     `takes` but no comp is asserted deep-equal to the same clip without them.
//
//  3. THE DECODE PINS. `lib/decodeCache` may now evict to a byte budget, and
//     this module prefetches with `decodeClipBlob` then reads back with
//     `peekDecoded`, which cannot re-decode. `prefetchDecodes` and
//     `takeResolver` pin what they hand over; the negative control below shows
//     the same sequence WITHOUT pins really does lose its earlier buffers.
import assert from 'node:assert/strict';
import {
  prefetchDecodes,
  releaseOnce,
  resetScheduleWarnings,
  scheduleClipSources,
  takeResolver,
  type DecodePin,
  type SchedulableClip,
} from './liveMixer.ts';
import { useLogStore } from './logStore.ts';
import { applyFadeAutomation, clampClipFades, type AudioParamLike } from '../lib/clipFade.ts';
import {
  configureDecodeCache,
  decodeCacheStats,
  decodeClipBlob,
  peekDecoded,
  pinDecoded,
  unpinDecoded,
} from '../lib/decodeCache.ts';
import type { ClipTake, CompRegion } from '../lib/clipComp.ts';

/* ── Harness ──────────────────────────────────────────────────────────────── */

type Call = [string, number, number];

interface FakeNode {
  kind: string;
  gain: AudioParamLike & { value: number; calls: Call[] };
  playbackRate: { value: number };
  buffer: unknown;
  outputs: FakeNode[];
  disconnects: number;
  started: number[][];
  onended: (() => void) | null;
  connect(to: FakeNode): FakeNode;
  disconnect(): void;
  start(...args: number[]): void;
}

const fakeNode = (kind: string): FakeNode => {
  const calls: Call[] = [];
  const node: FakeNode = {
    kind,
    gain: {
      value: 1,
      calls,
      setValueAtTime(v: number, t: number) { calls.push(['setValueAtTime', v, t]); return node.gain; },
      linearRampToValueAtTime(v: number, t: number) { calls.push(['linearRampToValueAtTime', v, t]); return node.gain; },
    },
    playbackRate: { value: 1 },
    buffer: null,
    outputs: [],
    disconnects: 0,
    started: [],
    onended: null,
    connect(to: FakeNode) { node.outputs.push(to); return to; },
    disconnect() { node.disconnects += 1; },
    start(...args: number[]) { node.started.push(args); },
  };
  return node;
};

const fakeCtx = () => {
  const created: FakeNode[] = [];
  return {
    created,
    createGain() { const n = fakeNode('gain'); created.push(n); return n; },
    createBufferSource() { const n = fakeNode('source'); created.push(n); return n; },
  };
};

type CtxArg = Parameters<typeof scheduleClipSources>[0];
type BufArg = Parameters<typeof scheduleClipSources>[2];
type DestArg = Parameters<typeof scheduleClipSources>[3];

/** Any function, as the buffer argument. */
const asResolver = (fn: (takeIndex: number) => unknown): BufArg => fn as unknown as BufArg;

/** A resolver over a fixed take -> buffer-duration table. `undefined` in the
 *  table is "that take has not decoded". */
const takes = (...durations: (number | undefined)[]): BufArg =>
  asResolver((i) => (durations[i] === undefined ? undefined : { duration: durations[i] }));

interface Driven {
  built: boolean;
  ctx: ReturnType<typeof fakeCtx>;
  dest: FakeNode;
  kinds: string[];
  sources: FakeNode[];
  /** How many times the clip's release hook has fired. */
  released: { count: number };
}

const drive = (
  clip: SchedulableClip, buf: BufArg, nowSec: number, fromSec: number,
): Driven => {
  const ctx = fakeCtx();
  const dest = fakeNode('destination');
  const released = { count: 0 };
  const scheduled = scheduleClipSources(
    ctx as unknown as CtxArg, clip, buf, dest as unknown as DestArg, nowSec, fromSec,
    { onEnded: () => { released.count += 1; } },
  );
  return {
    built: scheduled !== null,
    ctx,
    dest,
    kinds: ctx.created.map((n) => n.kind),
    sources: ctx.created.filter((n) => n.kind === 'source'),
    released,
  };
};

/** Everything one pass produced, as plain data — for deep-equal comparisons
 *  between two wirings that must be identical. */
const shapeOf = (d: Driven) => d.ctx.created.map((n) => ({
  kind: n.kind,
  started: n.started,
  calls: n.gain.calls,
  rate: n.playbackRate.value,
  outputs: n.outputs.map((o) => o.kind),
}));

const take = (offsetIntoSource: number, tag: string): ClipTake => ({
  id: `take-${tag}`,
  label: tag,
  audioBlob: new Blob([tag]),
  mimeType: 'audio/wav',
  sourceDuration: 20,
  offsetIntoSource,
});

const TAKE_A = take(0.5, 'a');
const TAKE_B = take(2, 'b');

/** A 4 s clip at t = 10 with two takes. `comp` is supplied per case. */
const compedClip = (comp: CompRegion[], over: Partial<SchedulableClip> = {}): SchedulableClip => ({
  id: 'comp-clip',
  startSec: 10,
  offsetIntoSource: TAKE_A.offsetIntoSource,
  durationSec: 4,
  activeTakeIndex: 0,
  takes: [TAKE_A, TAKE_B],
  comp,
  ...over,
});

const BUTT: CompRegion[] = [{ startSec: 0, takeIndex: 0 }, { startSec: 2, takeIndex: 1 }];
const XFADE: CompRegion[] = [
  { startSec: 0, takeIndex: 0 },
  { startSec: 2, takeIndex: 1, crossfadeSec: 0.4 },
];

/** Sums of tenths are not exact in binary, so the multi-boundary case below —
 *  the only one whose times are built from three additions — compares to within
 *  an ulp. Every other case in this file is asserted exactly. */
const near = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

function assertStarted(node: FakeNode, expected: number[], msg: string): void {
  assert.equal(node.started.length, 1, `${msg} (one start call)`);
  assert.equal(node.started[0].length, expected.length, `${msg} (argument count)`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.ok(near(node.started[0][i], expected[i]), `${msg} (arg ${i}: ${node.started[0][i]} vs ${expected[i]})`);
  }
}

function assertCalls(calls: readonly Call[], expected: Call[], msg: string): void {
  assert.equal(calls.length, expected.length, `${msg} (event count)`);
  for (let i = 0; i < expected.length; i += 1) {
    assert.equal(calls[i][0], expected[i][0], `${msg} (event ${i} method)`);
    assert.ok(near(calls[i][1], expected[i][1]), `${msg} (event ${i} value ${calls[i][1]})`);
    assert.ok(near(calls[i][2], expected[i][2]), `${msg} (event ${i} time ${calls[i][2]})`);
  }
}

/** Replay a recorded `setValueAtTime` / `linearRampToValueAtTime` sequence and
 *  read the param's value at `t`, by the AudioParam ramp rules. */
function paramAt(calls: readonly Call[], t: number): number {
  let value = calls.length > 0 ? calls[0][1] : 1;
  let lastT = -Infinity;
  for (let i = 0; i < calls.length; i += 1) {
    const [method, v, when] = calls[i];
    if (when <= t) { value = v; lastT = when; continue; }
    if (method === 'linearRampToValueAtTime') {
      const span = when - lastT;
      if (span <= 0) return v;
      return value + (v - value) * ((t - lastT) / span);
    }
    return value;
  }
  return value;
}

/* ── 1. Butt cut: two takes, one boundary ─────────────────────────────────── */

function buttCut(): void {
  const d = drive(compedClip(BUTT), takes(20, 20), 100, 10);
  assert.ok(d.built, 'a comped clip is wired up');

  // clipGain, muteGate, then one seam gain + one source per comp segment.
  assert.deepEqual(
    d.kinds, ['gain', 'gain', 'gain', 'source', 'gain', 'source'],
    'one envelope, one gate, and a seam gain + source per region',
  );
  const [clipGain, muteGate, seam0, src0, seam1, src1] = d.ctx.created;

  // Region 0 reads take A from its own offset; region 1 reads take B from ITS
  // offset advanced by where the region starts on the timeline.
  assert.deepEqual(src0.started, [[100, 0.5, 2]], 'region 0 plays take A, 0-2 s, from take A\'s offset');
  assert.deepEqual(src1.started, [[102, 4, 2]], 'region 1 plays take B, 2-4 s, from take B\'s offset + 2');
  assert.deepEqual([src0.playbackRate.value, src1.playbackRate.value], [1, 1]);

  // Routing: source -> seam gain -> clipGain -> muteGate -> destination.
  assert.deepEqual([src0.outputs, src1.outputs], [[seam0], [seam1]], 'each region feeds its own seam gain');
  assert.deepEqual([seam0.outputs, seam1.outputs], [[clipGain], [clipGain]], 'both seams feed the ONE envelope');
  assert.deepEqual(clipGain.outputs, [muteGate], 'the envelope feeds the mute gate');
  assert.deepEqual(muteGate.outputs, [d.dest], 'the gate feeds the track');
  assert.equal(muteGate.gain.value, 1, 'the gate opens at unity');

  // A butt cut has no crossfade, so both seams sit at unity for their whole run.
  assert.deepEqual(seam0.gain.calls, [['setValueAtTime', 1, 100]], 'a butt cut shapes nothing');
  assert.deepEqual(seam1.gain.calls, [['setValueAtTime', 1, 102]]);

  // The whole-clip envelope is written ONCE, over the whole clip — the comp does
  // not shorten or split it.
  const expected = fakeNode('probe');
  applyFadeAutomation(expected.gain, compedClip(BUTT), 100, 0, { peak: 1, effectiveDurationSec: 4 });
  assert.deepEqual(clipGain.gain.calls, expected.gain.calls, 'one envelope, spanning all four seconds');
}

/* ── 2. Crossfade: mirrored linear ramps summing to unity ─────────────────── */

function crossfadeSeam(): void {
  const d = drive(compedClip(XFADE), takes(20, 20), 100, 10);
  assert.ok(d.built);
  const [, , seam0, src0, seam1, src1] = d.ctx.created;

  // A 0.4 s crossfade at t = 2 runs region 0 on 0.2 s past the boundary and
  // starts region 1 0.2 s early, so the two OVERLAP by exactly the crossfade.
  assert.deepEqual(src0.started, [[100, 0.5, 2.2]], 'region 0 plays 0 - 2.2 s');
  assert.deepEqual(src1.started, [[101.8, 3.8, 2.2]], 'region 1 plays 1.8 - 4 s, from take B + 1.8');

  const seamStart = 101.8;
  const seamEnd = 102.2;
  assert.deepEqual(seam0.gain.calls, [
    ['setValueAtTime', 1, 100],
    ['setValueAtTime', 1, seamStart],
    ['linearRampToValueAtTime', 0, seamEnd],
  ], 'the outgoing take fades out across the overlap');
  assert.deepEqual(seam1.gain.calls, [
    ['setValueAtTime', 0, seamStart],
    ['linearRampToValueAtTime', 1, seamEnd],
  ], 'the incoming take fades in across the same window');

  // The point of the linear pair: two takes of the same performance are
  // correlated, so the seam must sum — not hold constant POWER, which would
  // bulge through the middle.
  for (let i = 0; i <= 8; i += 1) {
    const t = seamStart + ((seamEnd - seamStart) * i) / 8;
    const out = paramAt(seam0.gain.calls, t);
    const into = paramAt(seam1.gain.calls, t);
    assert.ok(Math.abs(out + into - 1) < 1e-9, `the seam sums to unity at t=${t} (${out} + ${into})`);
    assert.ok(out >= 0 && out <= 1 && into >= 0 && into <= 1, 'and neither side leaves [0, 1]');
  }
  // Mirror images: the two fades are the same length and opposite directions.
  assert.equal(paramAt(seam0.gain.calls, seamStart), 1);
  assert.equal(paramAt(seam1.gain.calls, seamStart), 0);
  assert.equal(paramAt(seam0.gain.calls, seamEnd), 0);
  assert.equal(paramAt(seam1.gain.calls, seamEnd), 1);
  // Outside the overlap each take is at full: nothing is ducked that should not be.
  assert.equal(paramAt(seam0.gain.calls, 100.9), 1, 'the outgoing take is at full before the seam');
  assert.equal(paramAt(seam1.gain.calls, 103), 1, 'and the incoming one after it');
}

/* ── 3. A seek into the second region ─────────────────────────────────────── */

function seekIntoSecondRegion(): void {
  // Playhead at 13 s = 3 s into the clip: region 0 is finished, region 1 is
  // joined one second in.
  const d = drive(compedClip(BUTT), takes(20, 20), 100, 13);
  assert.ok(d.built);
  assert.deepEqual(d.kinds, ['gain', 'gain', 'gain', 'source'], 'only the region under the playhead is built');
  const [clipGain, , seam, src] = d.ctx.created;
  assert.deepEqual(
    src.started, [[100, 5, 1]],
    'region 1 resumes one second in: take B + 2 + 1, for the remaining second',
  );
  assert.deepEqual(
    seam.gain.calls, [['setValueAtTime', 1, 100]],
    'its seam gain is anchored at the scheduling moment, at the value it already has',
  );

  // The whole-clip envelope still spans the whole clip, not the remainder —
  // `clipStartCtx` is in the past (97) and `effectiveDurationSec` is still 4.
  const expected = fakeNode('probe');
  applyFadeAutomation(expected.gain, compedClip(BUTT), 97, 3, { peak: 1, effectiveDurationSec: 4 });
  assert.deepEqual(clipGain.gain.calls, expected.gain.calls, 'the envelope spans the clip, seek or no seek');

  // A seek INTO the crossfade overlap keeps both regions, each trimmed.
  const inSeam = drive(compedClip(XFADE), takes(20, 20), 100, 12);
  assert.ok(inSeam.built);
  assert.deepEqual(
    inSeam.kinds, ['gain', 'gain', 'gain', 'source', 'gain', 'source'],
    'a seek inside the overlap still plays both takes',
  );
  const [, , , a, , b] = inSeam.ctx.created;
  // `2.2 - 2` is not exact in binary, so the remaining overhang is 0.2 to within
  // an ulp — the only place in this file where the arithmetic is not exact.
  assert.equal(a.started.length, 1);
  assert.deepEqual(a.started[0].slice(0, 2), [100, 2.5], 'the outgoing take plays out the rest of its overhang');
  assert.ok(Math.abs(a.started[0][2] - 0.2) < 1e-9, 'for the 0.2 s of overhang it has left');
  assert.deepEqual(b.started, [[100, 4, 2]], 'and the incoming one joins 0.2 s into its own head');

  // Seeking past the end of the last region builds nothing at all.
  const past = drive(compedClip(BUTT), takes(20, 20), 100, 14);
  assert.equal(past.built, false, 'a comped clip already finished is not wired up');
  assert.deepEqual(past.ctx.created, [], 'and costs no nodes');
}

/* ── 4. Loop / replay ─────────────────────────────────────────────────────── */

function loopRestartIsIdentical(): void {
  // A loop restart is `start(0)` again: the scheduler holds no per-pass state,
  // so pass two must be indistinguishable from pass one.
  const first = drive(compedClip(XFADE), takes(20, 20), 100, 10);
  const second = drive(compedClip(XFADE), takes(20, 20), 100, 10);
  assert.deepEqual(shapeOf(second), shapeOf(first), 'a loop restart schedules exactly what the first pass did');

  // …and the same pass at a later context time is the same graph, shifted.
  const later = drive(compedClip(XFADE), takes(20, 20), 250, 10);
  assert.deepEqual(
    later.sources.map((n) => n.started),
    first.sources.map((n) => n.started.map(([w, o, dur]) => [w + 150, o, dur])),
    'the second loop lands 150 s later with identical offsets and durations',
  );
}

/* ── 5. Teardown: every source counted, released once ─────────────────────── */

function teardownCountsEverySource(): void {
  const d = drive(compedClip(XFADE), takes(20, 20), 100, 10);
  const [clipGain, muteGate, seam0, src0, seam1, src1] = d.ctx.created;
  assert.equal(d.released.count, 0, 'nothing is released while the clip is still playing');

  src0.onended?.();
  assert.equal(src0.disconnects, 1, 'a finished region lets go of itself');
  assert.deepEqual(
    [clipGain.disconnects, muteGate.disconnects, seam0.disconnects, seam1.disconnects], [0, 0, 0, 0],
    'but nothing shared goes while another region is still playing',
  );
  assert.equal(d.released.count, 0, 'and the pins are still held');

  src1.onended?.();
  assert.equal(src1.disconnects, 1);
  assert.deepEqual(
    [clipGain.disconnects, muteGate.disconnects, seam0.disconnects, seam1.disconnects], [1, 1, 1, 1],
    'the LAST source tears down the envelope, the gate and every seam gain',
  );
  assert.equal(d.released.count, 1, 'and releases the clip\'s decode pins, exactly once');

  // The counter is over EVERY source: a warped (non-comped) clip that plays as
  // two segments still only tears down on the second.
  const warped = drive(
    { id: 'w', startSec: 10, offsetIntoSource: 5, durationSec: 4,
      warpMarkers: [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }] },
    takes(20), 100, 10,
  );
  assert.deepEqual(warped.kinds, ['gain', 'gain', 'source', 'source'], 'a warped clip grows no seam gains');
  warped.sources[0].onended?.();
  assert.equal(warped.released.count, 0);
  warped.sources[1].onended?.();
  assert.equal(warped.released.count, 1, 'the warp path still releases once, on the last source');
}

/* ── 6. Non-comped clips are byte-identical ───────────────────────────────── */

function nonCompedIsUnchanged(): void {
  const plain: SchedulableClip = {
    id: 'clip-a', startSec: 10, offsetIntoSource: 1, durationSec: 4,
    fadeInSec: 1, fadeOutSec: 1, gain: 0.5,
  };
  const d = drive(plain, takes(20), 100, 8);
  assert.ok(d.built);

  // The literal pre-change result, captured from the schedule before the comp
  // branch existed: three nodes, one source, the envelope on the first gain.
  assert.deepEqual(d.kinds, ['gain', 'gain', 'source'], 'an ordinary clip still costs one gain, one gate, one source');
  assert.deepEqual(d.sources[0].started, [[102, 1, 4]], 'and starts exactly where it always did');
  assert.deepEqual(d.ctx.created[0].gain.calls, [
    ['setValueAtTime', 0, 102],
    ['linearRampToValueAtTime', 0.5, 103],
    ['setValueAtTime', 0.5, 105],
    ['linearRampToValueAtTime', 0, 106],
  ], 'captured: the envelope an ordinary clip has always been given');
  assert.deepEqual(d.ctx.created[2].outputs.map((n) => n.kind), ['gain'], 'the source feeds the envelope DIRECTLY');

  // Takes with NO comp is take switching, which needs none of this: the clip's
  // own fields are the active take, and the wiring is the same graph.
  const switching: SchedulableClip = { ...plain, takes: [TAKE_A, TAKE_B], activeTakeIndex: 1 };
  assert.deepEqual(
    shapeOf(drive(switching, takes(20, 20), 100, 8)), shapeOf(d),
    'two takes with no comp schedule byte-identically to no takes at all',
  );
  // …and it is the ACTIVE take that is resolved.
  const asked: number[] = [];
  drive(switching, asResolver((i) => { asked.push(i); return { duration: 20 }; }), 100, 8);
  assert.deepEqual(asked, [1], 'take switching resolves the active take, once');

  // One take plus a comp is not a comp either — there is nothing to comp with.
  assert.deepEqual(
    shapeOf(drive({ ...plain, takes: [TAKE_A], comp: BUTT }, takes(20), 100, 8)), shapeOf(d),
    'a single take with a comp still plays as an ordinary clip',
  );
  // An empty comp on two takes, likewise.
  assert.deepEqual(
    shapeOf(drive({ ...plain, takes: [TAKE_A, TAKE_B], comp: [] }, takes(20, 20), 100, 8)), shapeOf(d),
    'an empty comp is not a comp',
  );
}

/* ── 7. Warp + comp falls back to the active take, loudly ─────────────────── */

function warpPlusCompFallsBack(): void {
  useLogStore.getState().clear();
  resetScheduleWarnings('all');
  const clip = compedClip(BUTT, {
    id: 'warp-comp-clip',
    activeTakeIndex: 1,
    offsetIntoSource: TAKE_B.offsetIntoSource,
    warpMarkers: [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }],
  });
  const asked: number[] = [];
  const d = drive(clip, asResolver((i) => { asked.push(i); return { duration: 20 }; }), 100, 10);
  assert.ok(d.built);
  assert.deepEqual(asked, [1], 'the fallback resolves only the ACTIVE take');
  assert.deepEqual(d.kinds, ['gain', 'gain', 'source', 'source'], 'and schedules as a plain warped clip — no seams');
  assert.deepEqual(d.sources[0].started, [[100, 2, 2]], 'warp segment 1, from the active take\'s offset');
  assert.deepEqual(d.sources[1].started, [[101, 4, 2]], 'warp segment 2');

  const warns = useLogStore.getState().entries.filter((e) => e.level === 'warn');
  assert.equal(warns.length, 1, 'it says so, once');
  assert.equal(warns[0].source, 'editor');
  assert.ok(/warp/i.test(warns[0].msg) && /comp/i.test(warns[0].msg), `the warning names both: ${warns[0].msg}`);

  // Re-scheduling the same clip (a seek, a loop restart) must not say it again.
  drive(clip, takes(20, 20), 100, 10);
  drive(clip, takes(20, 20), 100, 11);
  assert.equal(
    useLogStore.getState().entries.filter((e) => e.level === 'warn').length, 1,
    'a warning about a CLIP is emitted once, not once per play',
  );
}

/* ── 7b. A seam whose take runs out of audio ──────────────────────────────── */

/**
 * `lib/clipComp` fits a segment's two crossfades inside its NOMINAL length, but
 * a take whose decoded buffer runs out shortens the segment under them. Left to
 * `clampClipFades`, the shorter of the two gives way — and when that is the
 * fade-IN, a seam that still has audio on both sides of it stops summing. The
 * scheduler fits the fades itself so the fade-in always survives.
 */
function aShortTakeKeepsItsLeadingSeam(): void {
  // Region 1 carries a 0.4 s crossfade in and a 1.2 s one out, and its take has
  // only 1.2 s of audio left to play them over.
  const comp: CompRegion[] = [
    { startSec: 0, takeIndex: 0 },
    { startSec: 1, takeIndex: 1, crossfadeSec: 0.4 },
    { startSec: 2, takeIndex: 0, crossfadeSec: 1.2 },
  ];
  // The fade lengths `compSegments` asks for, and what the generic clamp would
  // have done with them — the fade-IN cut to half, which is the bug.
  const generic = clampClipFades({ durationSec: 1.2, fadeInSec: 0.4, fadeOutSec: 1.0 });
  assert.equal(generic.fadeOutSec, 1.0, 'clampClipFades alone keeps the LONGER fade whole…');
  assert.ok(
    Math.abs(generic.fadeInSec - 0.2) < 1e-9 && generic.fadeInSec < 0.4,
    '…by halving the leading seam, which is the behaviour the scheduler pre-empts',
  );

  const d = drive(compedClip(comp, { id: 'short-seam' }), takes(20, 4, 20), 100, 10);
  assert.ok(d.built);
  assert.deepEqual(
    d.kinds, ['gain', 'gain', 'gain', 'source', 'gain', 'source', 'gain', 'source'],
    'three regions, three seam gains',
  );
  const [, , seam0, src0, seam1, src1, seam2, src2] = d.ctx.created;
  assertStarted(src0, [100, 0.5, 1.2], 'region 0 runs 0.2 s past the first boundary');
  assertStarted(src1, [100.8, 2.8, 1.2], 'region 1 has only 1.2 s of take B left');
  assertStarted(src2, [101.5, 2, 2.5], 'region 2 opens 0.5 s early for the second crossfade');

  // The LEADING seam survives at its full length, so it still sums to unity.
  assertCalls(seam0.gain.calls, [
    ['setValueAtTime', 1, 100],
    ['setValueAtTime', 1, 100.8],
    ['linearRampToValueAtTime', 0, 101.2],
  ], 'region 0 fades out across the first boundary');
  assertCalls(seam1.gain.calls, [
    ['setValueAtTime', 0, 100.8],
    ['linearRampToValueAtTime', 1, 101.2],
    ['setValueAtTime', 1, 101.2],
    ['linearRampToValueAtTime', 0, 102],
  ], 'the fade-in keeps its 0.4 s; the fade-out gives way to 0.8 s instead');
  for (let i = 0; i <= 4; i += 1) {
    const t = 100.8 + (0.4 * i) / 4;
    const sum = paramAt(seam0.gain.calls, t) + paramAt(seam1.gain.calls, t);
    assert.ok(Math.abs(sum - 1) < 1e-9, `the first seam still sums to unity at t=${t} (${sum})`);
  }

  // The TRAILING seam cannot sum: take B's audio ends at 102, half a second
  // before region 2 finishes fading in. That is missing audio, not a fade bug —
  // the test records it so the limitation is visible rather than assumed away.
  assertCalls(seam2.gain.calls, [
    ['setValueAtTime', 0, 101.5],
    ['linearRampToValueAtTime', 1, 102.5],
  ], 'region 2 fades in over its full 1.0 s window');
  assert.equal(paramAt(seam1.gain.calls, 102), 0, 'while the outgoing take is already silent at 102');
  assert.ok(paramAt(seam2.gain.calls, 102) < 1, 'and the incoming one has not arrived yet');
}

/* ── 8. A take with no decoded audio ──────────────────────────────────────── */

function missingTakeIsSkippedNotThrown(): void {
  useLogStore.getState().clear();
  resetScheduleWarnings('all');
  const clip = compedClip(BUTT, { id: 'missing-take-clip' });
  // Take B never decoded: its region is silent, take A's still plays.
  const d = drive(clip, takes(20, undefined), 100, 10);
  assert.ok(d.built, 'the rest of the comp still plays');
  assert.deepEqual(d.kinds, ['gain', 'gain', 'gain', 'source'], 'only the resolvable region is built');
  assert.deepEqual(d.sources[0].started, [[100, 0.5, 2]], 'and it is region 0, unchanged');

  const warns = useLogStore.getState().entries.filter((e) => e.level === 'warn');
  assert.equal(warns.length, 1, 'one warning, not one per segment');
  assert.ok(/take/i.test(warns[0].msg), `the warning names the take: ${warns[0].msg}`);

  // Nothing at all decoded: nothing is built, and still nothing throws.
  const none = drive(compedClip(BUTT, { id: 'nothing-decoded' }), takes(undefined, undefined), 100, 10);
  assert.equal(none.built, false, 'a comp with no decoded takes schedules nothing');
  assert.deepEqual(none.ctx.created, [], 'and costs no nodes');
}

/** A take that has not decoded is TRANSIENT — it may be there on the next play,
 *  and if it is not, the log must say so again. A warp+comp clip is not: it is a
 *  permanent property of the clip, and repeating it every play is noise. */
function warningsAreForgottenPerPass(): void {
  useLogStore.getState().clear();
  resetScheduleWarnings('all');
  const gap = compedClip(BUTT, { id: 'gap-clip' });
  const bad = compedClip(BUTT, {
    id: 'warped-clip',
    warpMarkers: [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }],
  });
  const warnCount = () => useLogStore.getState().entries.filter((e) => e.level === 'warn').length;

  drive(gap, takes(20, undefined), 100, 10);
  drive(bad, takes(20, 20), 100, 10);
  assert.equal(warnCount(), 2, 'one warning each on the first pass');

  // Re-scheduling WITHIN the pass (a seek, a loop restart) repeats neither.
  drive(gap, takes(20, undefined), 100, 10);
  drive(bad, takes(20, 20), 100, 10);
  assert.equal(warnCount(), 2, 'neither is repeated within a pass');

  // A new pass — what `scheduleClips` does at its top.
  resetScheduleWarnings('transient');
  drive(gap, takes(20, undefined), 100, 10);
  drive(bad, takes(20, 20), 100, 10);
  assert.equal(warnCount(), 3, 'the decode gap says so again; the warp+comp clip does not');

  // …and the gap closing means the next pass has nothing to say at all.
  resetScheduleWarnings('transient');
  drive(gap, takes(20, 20), 100, 10);
  assert.equal(warnCount(), 3, 'a take that decoded in the meantime warns about nothing');

  // `dispose()` drops the permanent ones too: the next session's clip with the
  // same id is a different clip.
  resetScheduleWarnings('all');
  drive(bad, takes(20, 20), 100, 10);
  assert.equal(warnCount(), 4, 'after dispose, a warp+comp clip is news again');
  resetScheduleWarnings('all');
}

/* ── 9. Stretch rides the comp ────────────────────────────────────────────── */

function stretchAdvancesEachRegionsOffset(): void {
  // At rate 2 one timeline second eats two source seconds, so region 1's source
  // offset advances by 2 x its start, and each region reads twice its length.
  const d = drive(compedClip(BUTT, { timeStretchRate: 2 }), takes(20, 20), 100, 10);
  assert.ok(d.built);
  assert.deepEqual(d.sources[0].started, [[100, 0.5, 4]], 'region 0 reads 4 s of take A for its 2 s');
  assert.deepEqual(d.sources[1].started, [[102, 6, 4]], 'region 1 starts 2 x 2 s into take B');
  assert.deepEqual(d.sources.map((n) => n.playbackRate.value), [2, 2], 'both regions play at the clip rate');

  // A take whose buffer runs out early shortens its own region only, and the
  // whole-clip envelope follows the audio that actually plays.
  const short = drive(compedClip(BUTT), takes(20, 5), 100, 10);
  assert.ok(short.built);
  assert.deepEqual(short.sources[1].started, [[102, 4, 1]], 'take B runs out after one second of its region');
  const expected = fakeNode('probe');
  applyFadeAutomation(expected.gain, compedClip(BUTT), 100, 0, { peak: 1, effectiveDurationSec: 3 });
  assert.deepEqual(
    short.ctx.created[0].gain.calls, expected.gain.calls,
    'the clip envelope ends where the comp\'s audio does',
  );
}

/* ── 10. The decode pins ──────────────────────────────────────────────────── */

const SAMPLE_RATE = 48000;
/** One second of 48 kHz stereo float32: 2 x 48000 x 4 = 384000 bytes. */
const ONE_SECOND_BYTES = 2 * SAMPLE_RATE * 4;

const decodeCtx = () => ({
  sampleRate: SAMPLE_RATE,
  decodeAudioData: async () => ({
    duration: 1, length: SAMPLE_RATE, numberOfChannels: 2, sampleRate: SAMPLE_RATE,
  }),
} as unknown as BaseAudioContext);

const clipOf = (tag: string) => ({ audioBlob: new Blob([tag]) });

async function decodePinsSurviveABudget(): Promise<void> {
  const ctx = decodeCtx();
  // Room for ONE second of audio, so a second decode must evict the first.
  const budget = ONE_SECOND_BYTES + 1;

  // ── The negative control: the same sequence with NO pins really does lose
  //    its earlier buffers, so the assertions below have teeth.
  configureDecodeCache({ budgetBytes: budget });
  const loose = [clipOf('loose-1'), clipOf('loose-2'), clipOf('loose-3')];
  for (const clip of loose) await decodeClipBlob(ctx, clip.audioBlob);
  assert.equal(
    peekDecoded(ctx, loose[0].audioBlob), undefined,
    'without pins, decoding clip 3 has already evicted clip 1',
  );
  assert.ok(peekDecoded(ctx, loose[2].audioBlob), 'only the newest survives');

  // ── Pinned: every clip the pass prefetched is still there at schedule time.
  const clips = [clipOf('pinned-1'), clipOf('pinned-2'), clipOf('pinned-3')];
  const pins: DecodePin[] = [];
  await prefetchDecodes(ctx, clips, pins);
  assert.equal(pins.length, 3, 'one pin per prefetched blob');
  for (const clip of clips) {
    assert.ok(peekDecoded(ctx, clip.audioBlob), 'every prefetched clip peeks back at schedule time');
  }
  const stats = decodeCacheStats();
  assert.equal(stats.pinnedBytes, 3 * ONE_SECOND_BYTES, 'all three are pinned');
  assert.ok(stats.overBudget, 'the cache yields to pins and reports being over budget');

  // ── Release: the pass is over, and the budget can do its job again.
  const release = releaseOnce(pins);
  release();
  assert.equal(decodeCacheStats().pinnedBytes, 0, 'releasing the pass drops every pin');
  configureDecodeCache({ budgetBytes: budget }); // re-running the budget now evicts
  assert.ok(decodeCacheStats().bytes <= budget, 'and the cache comes back inside its budget');

  // ── A release runs at most once: pins are COUNTED, so a second call would
  //    drop somebody else's pin on the same blob.
  const shared = new Blob(['shared']);
  await decodeClipBlob(ctx, shared);
  const mine: DecodePin[] = [{ blob: shared, rate: SAMPLE_RATE }];
  pinDecoded(shared, SAMPLE_RATE); // this pass
  pinDecoded(shared, SAMPLE_RATE); // somebody else's
  const releaseMine = releaseOnce(mine);
  releaseMine();
  releaseMine();
  releaseMine();
  assert.equal(
    decodeCacheStats().pinnedBytes, ONE_SECOND_BYTES,
    'three calls released exactly one pin, and the other holder still has theirs',
  );
  unpinDecoded(shared, SAMPLE_RATE);

  // ── `prefetchDecodes` decodes EVERY take of a comped clip, and only the
  //    clip's own blob otherwise.
  const alt = take(0, 'alt');
  const compedPins: DecodePin[] = [];
  await prefetchDecodes(decodeCtx(), [{
    audioBlob: TAKE_A.audioBlob,
    takes: [TAKE_A, alt],
    comp: BUTT,
    activeTakeIndex: 0,
  }], compedPins);
  assert.equal(compedPins.length, 2, 'a comped clip prefetches both takes');
  assert.ok(peekDecoded(ctx, alt.audioBlob), 'including the one its mirrored fields do NOT hold');

  const switchingPins: DecodePin[] = [];
  await prefetchDecodes(decodeCtx(), [{
    audioBlob: TAKE_A.audioBlob, takes: [TAKE_A, alt], activeTakeIndex: 0,
  }], switchingPins);
  assert.equal(
    switchingPins.length, 1,
    'takes with no comp decode exactly what the clip always decoded — its own blob',
  );

  releaseOnce(compedPins)();
  releaseOnce(switchingPins)();
  configureDecodeCache({}); // back to unbounded for anything after this
}

/** `takeResolver` is the seam `scheduleClips` hands each clip: it peeks the
 *  shared cache and pins what it hands over, so the buffers a clip is playing
 *  cannot be evicted out from under it. */
async function theResolverPinsWhatItSchedules(): Promise<void> {
  const ctx = decodeCtx();
  configureDecodeCache({});
  const alt = take(1, 'resolver-alt');
  const own = take(0, 'resolver-own');
  const clip = { audioBlob: own.audioBlob, takes: [own, alt], comp: BUTT, activeTakeIndex: 0 };
  const pins: DecodePin[] = [];
  await prefetchDecodes(ctx, [clip], pins);

  const schedulePins: DecodePin[] = [];
  const resolve = takeResolver(ctx, clip, schedulePins);
  assert.ok(resolve(0), 'take 0 resolves');
  assert.ok(resolve(1), 'take 1 resolves');
  assert.equal(resolve(2), undefined, 'a take that does not exist resolves to nothing');
  assert.deepEqual(
    schedulePins.map((p) => p.rate), [SAMPLE_RATE, SAMPLE_RATE],
    'and only the two it handed over were pinned',
  );

  // Now the prefetch pins can go: the schedule holds its own.
  releaseOnce(pins)();
  assert.equal(
    decodeCacheStats().pinnedBytes, 2 * ONE_SECOND_BYTES,
    'the schedule\'s pins keep both takes resident after the prefetch lets go',
  );
  releaseOnce(schedulePins)();
  assert.equal(decodeCacheStats().pinnedBytes, 0, 'and the teardown releases them');

  // A clip with no takes resolves its own blob for the active index and nothing
  // else — the invariant that its mirrored fields ARE the active take.
  const bare = { audioBlob: own.audioBlob, activeTakeIndex: 2 };
  const barePins: DecodePin[] = [];
  const bareResolve = takeResolver(ctx, bare, barePins);
  assert.ok(bareResolve(2), 'the active index resolves to the clip\'s own blob');
  assert.equal(bareResolve(0), undefined, 'and no other index resolves to anything');
  assert.equal(barePins.length, 1);
  releaseOnce(barePins)();
  configureDecodeCache({});
}

/**
 * THE CALL ORDER, exactly as `scheduleClips` performs it: the release is built
 * BEFORE the resolver has pinned anything, because the resolver is only called
 * from inside `scheduleClipSources`. A release that snapshotted its array at
 * construction would therefore hold nothing and free nothing — every played
 * buffer would stay pinned for the life of the session, and with the budget
 * enabled, un-evictable forever.
 */
async function theReleaseReadsThePinsAtReleaseTime(): Promise<void> {
  const ctx = decodeCtx();
  configureDecodeCache({});
  const own = take(0, 'order-own');
  const alt = take(1, 'order-alt');
  const clip = { audioBlob: own.audioBlob, takes: [own, alt], comp: BUTT, activeTakeIndex: 0 };
  const prefetch: DecodePin[] = [];
  await prefetchDecodes(ctx, [clip], prefetch);
  releaseOnce(prefetch)();
  assert.equal(decodeCacheStats().pinnedBytes, 0, 'starting from nothing pinned');

  // ── The bare ordering, in isolation ──────────────────────────────────────
  const bare: DecodePin[] = [];
  const bareRelease = releaseOnce(bare);       // built FIRST, on an empty array
  const bareResolve = takeResolver(ctx, clip, bare);
  bareResolve(0);
  bareResolve(1);
  assert.equal(bare.length, 2, 'the resolver filled the array after the release was built');
  assert.equal(
    decodeCacheStats().pinnedBytes, 2 * ONE_SECOND_BYTES,
    'and both buffers really are pinned',
  );
  bareRelease();
  assert.equal(
    decodeCacheStats().pinnedBytes, 0,
    'a release built before the pins existed still frees them',
  );

  // ── And through the real thing: resolver -> scheduleClipSources -> onEnded ─
  const pins: DecodePin[] = [];
  const release = releaseOnce(pins);
  const fake = fakeCtx();
  const dest = fakeNode('destination');
  const scheduled = scheduleClipSources(
    fake as unknown as CtxArg,
    { id: 'order-clip', startSec: 10, offsetIntoSource: 0, durationSec: 4,
      activeTakeIndex: 0, takes: [own, alt], comp: BUTT },
    takeResolver(ctx, clip, pins) as unknown as BufArg,
    dest as unknown as DestArg,
    100, 10, { onEnded: release },
  );
  assert.ok(scheduled, 'the comped clip scheduled off the real decode cache');
  assert.equal(pins.length, 2, 'one pin per take it scheduled');
  assert.equal(
    decodeCacheStats().pinnedBytes, 2 * ONE_SECOND_BYTES,
    'held for as long as the sources are alive',
  );
  for (const src of fake.created.filter((n) => n.kind === 'source')) src.onended?.();
  assert.equal(
    decodeCacheStats().pinnedBytes, 0,
    'and released when the last source ends — the pin the budget is waiting on',
  );

  // The other route to the same release (`clearSources`, which nulls `onended`
  // and stops the sources itself) must not double-release.
  pinDecoded(own.audioBlob, SAMPLE_RATE); // somebody else's pin on the same blob
  release();
  release();
  assert.equal(
    decodeCacheStats().pinnedBytes, ONE_SECOND_BYTES,
    'a second release is a no-op and leaves the other holder\'s pin alone',
  );
  unpinDecoded(own.audioBlob, SAMPLE_RATE);
  configureDecodeCache({});
}

/** A prefetch that fails part-way leaves the caller holding the pins it DID
 *  take, so `start()`'s catch can release them instead of stranding the decoded
 *  prefix until the next stop or play. */
async function aFailedPrefetchStillHandsBackItsPins(): Promise<void> {
  configureDecodeCache({});
  let decodes = 0;
  const ctx = {
    sampleRate: SAMPLE_RATE,
    decodeAudioData: async () => {
      decodes += 1;
      if (decodes === 3) throw new Error('decodeAudioData failed');
      return { duration: 1, length: SAMPLE_RATE, numberOfChannels: 2, sampleRate: SAMPLE_RATE };
    },
  } as unknown as BaseAudioContext;

  const clips = [clipOf('fail-1'), clipOf('fail-2'), clipOf('fail-3'), clipOf('fail-4')];
  const pins: DecodePin[] = [];
  await assert.rejects(
    () => prefetchDecodes(ctx, clips, pins),
    /decodeAudioData failed/,
    'the rejection reaches the caller, as it always has',
  );
  assert.equal(pins.length, 2, 'the two that decoded before the failure are pinned');
  assert.equal(decodeCacheStats().pinnedBytes, 2 * ONE_SECOND_BYTES);
  releaseOnce(pins)();
  assert.equal(
    decodeCacheStats().pinnedBytes, 0,
    'releasing the prefetch frees the decoded prefix, which is what start() does in its catch',
  );
  configureDecodeCache({});
}

buttCut();
crossfadeSeam();
seekIntoSecondRegion();
loopRestartIsIdentical();
teardownCountsEverySource();
nonCompedIsUnchanged();
warpPlusCompFallsBack();
aShortTakeKeepsItsLeadingSeam();
missingTakeIsSkippedNotThrown();
warningsAreForgottenPerPass();
stretchAdvancesEachRegionsOffset();

await decodePinsSurviveABudget();
await theResolverPinsWhatItSchedules();
await theReleaseReadsThePinsAtReleaseTime();
await aFailedPrefetchStillHandsBackItsPins();

console.log('liveMixer.comp: ok');
