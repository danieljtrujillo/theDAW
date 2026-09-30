// liveMixer schedule math + the fade-envelope equivalence pin (T07b).
//
// Two jobs:
//
//  1. THE PIN. Before T07b the clip fade envelope was hand-written four times
//     (liveMixer.scheduleClips and the three offline bounces in
//     WaveformEditor). `legacyLiveEnvelope` / `legacyOfflineEnvelope` below are
//     that code transcribed VERBATIM from baseline 9af4911 and frozen here as
//     the reference — plus the literal event sequences they produced, captured
//     before a line was changed. Every site now calls `applyFadeAutomation`,
//     and for a clip carrying none of the T07a fields the recorded AudioParam
//     calls must still be identical: same methods, same times, same values.
//
//     ONE deliberate difference, inherited from T07a and asserted below: when
//     playback starts INSIDE a fade-out, the old live scheduler re-set the gain
//     to full peak and ramped down from there (an audible jump); the envelope
//     now anchors at the partial value it already has. A second, incidental
//     difference is confined to clips whose two fades are longer than the clip
//     (`fadeInSec + fadeOutSec > durationSec`), where the old code emitted an
//     out-of-order event pair and T07a's clamp resolves it. Both are pinned.
//
//  2. THE SCHEDULE MATH. `computeClipSchedule` is the pure per-clip
//     computation — start time, buffer offset, duration, playback rate, one
//     entry per warp segment — that the live scheduler and all three offline
//     renderers now share. It is tested here with no audio context at all.
import assert from 'node:assert/strict';
import {
  computeClipSchedule, scheduleClipSources,
  type ScheduleClip, type SchedulableClip,
} from './liveMixer.ts';
import { applyFadeAutomation, type AudioParamLike, type FadeClip } from '../lib/clipFade.ts';
import { warpSegments, type WarpMarker } from '../lib/audioWarp.ts';

/* ── An AudioParam that only records ──────────────────────────────────────── */

type Call = [string, number, number];
type Recorder = AudioParamLike & { calls: Call[] };

const recorder = (): Recorder => {
  const calls: Call[] = [];
  return {
    calls,
    setValueAtTime(v: number, t: number) { calls.push(['setValueAtTime', v, t]); return this; },
    linearRampToValueAtTime(v: number, t: number) { calls.push(['linearRampToValueAtTime', v, t]); return this; },
  };
};

/* ── The pre-T07b envelopes, frozen ───────────────────────────────────────── */

interface LegacyClip { durationSec: number; fadeInSec?: number; fadeOutSec?: number }

/** liveMixer.scheduleClips at baseline 9af4911, transcribed verbatim. */
function legacyLiveEnvelope(
  g: Recorder, clip: LegacyClip, safeDur: number, peak: number,
  clipStartCtx: number, now: number, into: number,
): void {
  const fadeIn = clip.fadeInSec ?? 0;
  const fadeOut = clip.fadeOutSec ?? 0;
  const when = Math.max(now, clipStartCtx);
  if (clipStartCtx >= now) {
    g.setValueAtTime(fadeIn > 0 ? 0 : peak, when);
    if (fadeIn > 0) g.linearRampToValueAtTime(peak, when + Math.min(fadeIn, safeDur));
  } else {
    const cur = fadeIn > 0 && into < fadeIn ? (into / fadeIn) * peak : peak;
    g.setValueAtTime(cur, now);
    if (fadeIn > 0 && into < fadeIn) g.linearRampToValueAtTime(peak, clipStartCtx + fadeIn);
  }
  if (fadeOut > 0) {
    const foStartCtx = clipStartCtx + safeDur - Math.min(fadeOut, safeDur);
    if (foStartCtx > now) g.setValueAtTime(peak, foStartCtx);
    g.linearRampToValueAtTime(0, clipStartCtx + safeDur);
  }
}

/** The three offline bounces at baseline 9af4911 — one shape, three copies. */
function legacyOfflineEnvelope(
  g: Recorder, clip: LegacyClip, safeDur: number, peak: number, startSec: number,
): void {
  const fadeIn = clip.fadeInSec ?? 0;
  const fadeOut = clip.fadeOutSec ?? 0;
  g.setValueAtTime(fadeIn > 0 ? 0 : peak, startSec);
  if (fadeIn > 0) g.linearRampToValueAtTime(peak, startSec + Math.min(fadeIn, safeDur));
  if (fadeOut > 0) {
    const foStart = startSec + safeDur - Math.min(fadeOut, safeDur);
    g.setValueAtTime(peak, foStart);
    g.linearRampToValueAtTime(0, startSec + safeDur);
  }
}

/** What the live scheduler does now: one call, the clip head as `whenSec`, and
 *  the schedule's effective length (the old `safeDur`) as the playable span. */
const liveEnvelope = (
  clip: LegacyClip, safeDur: number, peak: number, clipStartCtx: number, into: number,
): Call[] => {
  const g = recorder();
  applyFadeAutomation(g, clip, clipStartCtx, into, { peak, effectiveDurationSec: safeDur });
  return g.calls;
};

/** What each offline renderer does now: the same call with `fromSec` = 0. */
const offlineEnvelope = (clip: LegacyClip, safeDur: number, peak: number, startSec: number): Call[] => {
  const g = recorder();
  applyFadeAutomation(g, clip, startSec, 0, { peak, effectiveDurationSec: safeDur });
  return g.calls;
};

const legacyLive = (
  clip: LegacyClip, safeDur: number, peak: number, clipStartCtx: number, now: number, into: number,
): Call[] => {
  const g = recorder();
  legacyLiveEnvelope(g, clip, safeDur, peak, clipStartCtx, now, into);
  return g.calls;
};

const legacyOffline = (clip: LegacyClip, safeDur: number, peak: number, startSec: number): Call[] => {
  const g = recorder();
  legacyOfflineEnvelope(g, clip, safeDur, peak, startSec);
  return g.calls;
};

/* ── 1. The equivalence pin ───────────────────────────────────────────────── */

function pinTheEnvelope(): void {
  const D = 4;
  const NOW = 100;
  const faded: LegacyClip = { durationSec: D, fadeInSec: 1, fadeOutSec: 1 };
  const bare: LegacyClip = { durationSec: D };

  // Case 1 — a clip with fades that starts in the future.
  const future: Call[] = [
    ['setValueAtTime', 0, 102],
    ['linearRampToValueAtTime', 1, 103],
    ['setValueAtTime', 1, 105],
    ['linearRampToValueAtTime', 0, 106],
  ];
  assert.deepEqual(legacyLive(faded, D, 1, 102, NOW, 0), future, 'captured: the old envelope for a future clip');
  assert.deepEqual(liveEnvelope(faded, D, 1, 102, 0), future, 'a future clip with fades is unchanged');

  // Case 2 — a clip with no fades at all: one event, the peak.
  const noFades: Call[] = [['setValueAtTime', 1, 102]];
  assert.deepEqual(legacyLive(bare, D, 1, 102, NOW, 0), noFades, 'captured: the old envelope with no fades');
  assert.deepEqual(liveEnvelope(bare, D, 1, 102, 0), noFades, 'a clip with no fades is unchanged');

  // Case 3 — the playhead starts half-way through a 1 s fade-in.
  const midFadeIn: Call[] = [
    ['setValueAtTime', 0.5, 100],
    ['linearRampToValueAtTime', 1, 100.5],
    ['setValueAtTime', 1, 102.5],
    ['linearRampToValueAtTime', 0, 103.5],
  ];
  assert.deepEqual(legacyLive(faded, D, 1, NOW - 0.5, NOW, 0.5), midFadeIn, 'captured: the old mid-fade-in start');
  assert.deepEqual(liveEnvelope(faded, D, 1, NOW - 0.5, 0.5), midFadeIn, 'a start inside the fade-in is unchanged');

  // …and with a non-unity clip gain, so the peak is carried through untouched.
  const midFadeInQuiet: Call[] = [
    ['setValueAtTime', 0.125, 100],
    ['linearRampToValueAtTime', 0.5, 100.75],
    ['setValueAtTime', 0.5, 102.75],
    ['linearRampToValueAtTime', 0, 103.75],
  ];
  assert.deepEqual(legacyLive(faded, D, 0.5, NOW - 0.25, NOW, 0.25), midFadeInQuiet, 'captured: old, clip gain 0.5');
  assert.deepEqual(liveEnvelope(faded, D, 0.5, NOW - 0.25, 0.25), midFadeInQuiet, 'clip gain 0.5 is unchanged');

  // Case 4 — THE ONE DELIBERATE CHANGE. Starting 3.5 s into a 4 s clip lands
  // half-way down a 1 s fade-out. The old code jumped back to full peak first.
  assert.deepEqual(
    legacyLive(faded, D, 1, NOW - 3.5, NOW, 3.5),
    [['setValueAtTime', 1, 100], ['linearRampToValueAtTime', 0, 100.5]],
    'captured: the old mid-fade-out start jumped to full peak',
  );
  assert.deepEqual(
    liveEnvelope(faded, D, 1, NOW - 3.5, 3.5),
    [['setValueAtTime', 0.5, 100], ['linearRampToValueAtTime', 0, 100.5]],
    'a start inside the fade-out now anchors at the value the envelope already has',
  );

  // The incidental difference: fades longer than the clip. The old code emitted
  // a `setValueAtTime` BEFORE the end of a ramp already scheduled — an
  // out-of-order pair that silenced the first half of the clip and then jumped
  // to peak. T07a's clamp shrinks the smaller fade instead.
  const tooLong: LegacyClip = { durationSec: 2, fadeInSec: 1.5, fadeOutSec: 1.5 };
  assert.deepEqual(
    legacyLive(tooLong, 2, 1, 102, NOW, 0),
    [
      ['setValueAtTime', 0, 102],
      ['linearRampToValueAtTime', 1, 103.5],
      ['setValueAtTime', 1, 102.5],   // ← lands before the ramp above ends
      ['linearRampToValueAtTime', 0, 104],
    ],
    'captured: the old overlapping-fade envelope scheduled events out of order',
  );
  assert.deepEqual(
    liveEnvelope(tooLong, 2, 1, 102, 0),
    [
      ['setValueAtTime', 0, 102],
      ['linearRampToValueAtTime', 1, 103.5],
      ['setValueAtTime', 1, 103.5],
      ['linearRampToValueAtTime', 0, 104],
    ],
    'overlapping fades are clamped, and every event is now in time order',
  );

  // The three offline renderers: `fromSec` is always 0, so every case must be
  // byte-identical — including a clip longer than its decoded buffer, where the
  // effective duration is the buffer's.
  const offlineCases: { name: string; clip: LegacyClip; safeDur: number; peak: number }[] = [
    { name: 'both fades', clip: faded, safeDur: D, peak: 1 },
    { name: 'no fades', clip: bare, safeDur: D, peak: 1 },
    { name: 'fade-in only, clip gain 0.8', clip: { durationSec: D, fadeInSec: 1 }, safeDur: D, peak: 0.8 },
    { name: 'fade-out only', clip: { durationSec: D, fadeOutSec: 2 }, safeDur: D, peak: 1 },
    { name: 'buffer shorter than the clip', clip: { durationSec: 10, fadeInSec: 1, fadeOutSec: 1 }, safeDur: 3, peak: 1 },
  ];
  for (const c of offlineCases) {
    assert.deepEqual(
      offlineEnvelope(c.clip, c.safeDur, c.peak, 10),
      legacyOffline(c.clip, c.safeDur, c.peak, 10),
      `offline bounce unchanged: ${c.name}`,
    );
  }
  // …and the literal capture for the two that carry both fades, so the pin does
  // not rest on the transcription alone.
  assert.deepEqual(offlineEnvelope(faded, D, 1, 10), [
    ['setValueAtTime', 0, 10],
    ['linearRampToValueAtTime', 1, 11],
    ['setValueAtTime', 1, 13],
    ['linearRampToValueAtTime', 0, 14],
  ], 'captured: offline bounce, both fades');
  assert.deepEqual(offlineEnvelope({ durationSec: 10, fadeInSec: 1, fadeOutSec: 1 }, 3, 1, 10), [
    ['setValueAtTime', 0, 10],
    ['linearRampToValueAtTime', 1, 11],
    ['setValueAtTime', 1, 12],
    ['linearRampToValueAtTime', 0, 13],
  ], 'captured: offline bounce, buffer shorter than the clip');
}

/* ── 2. The schedule math ─────────────────────────────────────────────────── */

const plainClip = (over: Partial<ScheduleClip> = {}): ScheduleClip => ({
  offsetIntoSource: 0,
  durationSec: 4,
  ...over,
});

function scheduleWithNoNewFields(): void {
  // The clip sits inside its buffer: one segment, unit rate, nothing moved.
  const s = computeClipSchedule(plainClip({ offsetIntoSource: 1 }), 10);
  assert.ok(s, 'a playable clip schedules');
  assert.equal(s.durationSec, 4, 'the clip keeps its timeline length');
  assert.deepEqual(s.segments, [
    { targetStart: 0, targetEnd: 4, sourceOffset: 1, sourceDuration: 4, playbackRate: 1 },
  ], 'one segment reading the clip straight out of the buffer');

  // A buffer shorter than the clip is the old `safeDur` clamp, unchanged.
  const short = computeClipSchedule(plainClip({ durationSec: 10 }), 3);
  assert.ok(short);
  assert.equal(short.durationSec, 3, 'a short buffer shortens the clip');
  assert.equal(short.segments[0].sourceDuration, 3, 'and the source span with it');

  // An offset past the end of the buffer is pulled back, exactly as before.
  const past = computeClipSchedule(plainClip({ offsetIntoSource: 99 }), 5);
  assert.ok(past);
  assert.equal(past.segments[0].sourceOffset, 4.99, 'the offset is clamped to buffer end - 0.01');
  // `buffer - 0.01` is not exact in binary, so the tail is 0.01 to within an ulp.
  assert.ok(
    Math.abs(past.segments[0].sourceDuration - 0.01) < 1e-9,
    'leaving only the tail to play',
  );

  // Nothing to play.
  assert.equal(computeClipSchedule(plainClip(), 0), null, 'an empty buffer schedules nothing');
  assert.equal(computeClipSchedule(plainClip(), NaN), null, 'an unknown buffer length schedules nothing');
  assert.equal(computeClipSchedule(plainClip({ durationSec: 0 }), 10), null, 'a zero-length clip schedules nothing');
  assert.equal(computeClipSchedule(plainClip(), 10, 4), null, 'seeking to the clip end schedules nothing');
  assert.equal(computeClipSchedule(plainClip(), 10, 9), null, 'seeking past the clip schedules nothing');

  // A mid-clip start trims the head off the one segment — the old
  // `safeOffset + into` / `safeDur - into` pair.
  const mid = computeClipSchedule(plainClip({ offsetIntoSource: 1 }), 10, 1.5);
  assert.ok(mid);
  assert.equal(mid.durationSec, 4, 'the clip length is the whole clip, not the remainder');
  assert.deepEqual(mid.segments, [
    { targetStart: 1.5, targetEnd: 4, sourceOffset: 2.5, sourceDuration: 2.5, playbackRate: 1 },
  ], 'a mid-clip start reads from further into the buffer');
}

function scheduleWithTimeStretch(): void {
  // Half speed: twice as long on the timeline for the same source, so the clip
  // can only fill its 4 s from 2 s of source.
  const slow = computeClipSchedule(plainClip({ timeStretchRate: 0.5 }), 10);
  assert.ok(slow);
  assert.deepEqual(slow.segments, [
    { targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 2, playbackRate: 0.5 },
  ], 'rate 0.5 reads half as much source');

  // Double speed: 4 s of timeline eats 8 s of source.
  const fast = computeClipSchedule(plainClip({ timeStretchRate: 2 }), 10);
  assert.ok(fast);
  assert.deepEqual(fast.segments, [
    { targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 8, playbackRate: 2 },
  ], 'rate 2 reads twice as much source');

  // …and when the buffer cannot supply it, the clip is shortened by the RATE.
  const starved = computeClipSchedule(plainClip({ timeStretchRate: 2 }), 5);
  assert.ok(starved);
  assert.equal(starved.durationSec, 2.5, '5 s of source at rate 2 is 2.5 s of timeline');
  assert.equal(starved.segments[0].sourceDuration, 5, 'and it reads the whole buffer');

  // A mid-clip start advances the buffer offset at the playback rate.
  const mid = computeClipSchedule(plainClip({ timeStretchRate: 2 }), 10, 1);
  assert.ok(mid);
  assert.deepEqual(mid.segments, [
    { targetStart: 1, targetEnd: 4, sourceOffset: 2, sourceDuration: 6, playbackRate: 2 },
  ], 'one timeline second in is two source seconds in at rate 2');

  // 'offline' mode is already baked into the clip's blob — do not stretch twice.
  const baked = computeClipSchedule(plainClip({ timeStretchRate: 2, stretchMode: 'offline' }), 10);
  assert.ok(baked);
  assert.deepEqual(baked.segments, [
    { targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 4, playbackRate: 1 },
  ], "stretchMode 'offline' schedules exactly like an unstretched clip");

  // 'repitch' is the explicit spelling of the default.
  assert.deepEqual(
    computeClipSchedule(plainClip({ timeStretchRate: 0.5, stretchMode: 'repitch' }), 10)?.segments,
    slow.segments,
    "stretchMode 'repitch' is the default behaviour",
  );

  // Junk rates fall back to unity rather than silencing or hanging the clip.
  for (const rate of [0, -2, NaN, Infinity]) {
    assert.deepEqual(
      computeClipSchedule(plainClip({ timeStretchRate: rate }), 10)?.segments,
      [{ targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 4, playbackRate: 1 }],
      `rate ${rate} falls back to unity`,
    );
  }
}

function scheduleWithWarpMarkers(): void {
  // Markers anchoring BOTH ends, so the segment list is fully determined by the
  // markers themselves: the first 2 s of source is squeezed into 1 s, the rest
  // plays at speed.
  const markers: WarpMarker[] = [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }];
  const warped = computeClipSchedule(plainClip({ offsetIntoSource: 5, warpMarkers: markers }), 20);
  assert.ok(warped);
  assert.deepEqual(warped.segments, [
    { targetStart: 0, targetEnd: 1, sourceOffset: 5, sourceDuration: 2, playbackRate: 2 },
    { targetStart: 1, targetEnd: 3, sourceOffset: 7, sourceDuration: 2, playbackRate: 1 },
  ], 'each warp segment gets its own source span and rate, offset by the clip');
  assert.equal(warped.durationSec, 3, 'the warped clip is as long as its last segment');

  // A map left open at the end: `warpSegments` closes it by carrying on at rate
  // 1 from the last marker, and the clip's offset shifts the whole thing into
  // the buffer. One marker at source 1 s / target 2 s over a 4 s clip therefore
  // means "the first second plays at half speed, the rest at speed".
  const openEnded: WarpMarker[] = [{ sourceSec: 1, targetSec: 2 }];
  const sched = computeClipSchedule(plainClip({ offsetIntoSource: 3, warpMarkers: openEnded }), 20);
  assert.ok(sched);
  assert.deepEqual(sched.segments, [
    { targetStart: 0, targetEnd: 2, sourceOffset: 3, sourceDuration: 1, playbackRate: 0.5 },
    { targetStart: 2, targetEnd: 4, sourceOffset: 4, sourceDuration: 2, playbackRate: 1 },
  ], 'the segments are lib/audioWarp\'s, offset into the buffer and clamped to the box');
  assert.equal(sched.durationSec, 4, 'the clip runs to the end of its box');

  // Whatever the map, the segments tile the clip end to end with no gap and no
  // overlap — a seam either way is an audible glitch.
  let seam = 0;
  for (const seg of sched.segments) {
    assert.equal(seg.targetStart, seam, 'each segment starts where the last ended');
    seam = seg.targetEnd;
  }

  // The source span the markers describe is the clip's, clamped to the buffer.
  const clamped = computeClipSchedule(plainClip({ durationSec: 9, warpMarkers: markers }), 4);
  assert.ok(clamped);
  assert.deepEqual(
    clamped.segments.map((s) => s.sourceDuration),
    warpSegments(markers, 4).map((s) => s.sourceEnd - s.sourceStart),
    'a buffer shorter than the clip shortens the warp map',
  );

  // Seeking into the middle of segment k: segments before k are gone, k is
  // trimmed at its own playback rate, segments after k are untouched.
  const seek = computeClipSchedule(plainClip({ offsetIntoSource: 5, warpMarkers: markers }), 20, 2);
  assert.ok(seek);
  assert.deepEqual(seek.segments, [
    { targetStart: 2, targetEnd: 3, sourceOffset: 8, sourceDuration: 1, playbackRate: 1 },
  ], 'only the segment under the playhead survives, trimmed');
  assert.equal(seek.durationSec, 3, 'the fade envelope still spans the whole clip');

  // Seeking inside the FIRST (rate 2) segment trims the source at that rate.
  const seekFast = computeClipSchedule(plainClip({ offsetIntoSource: 5, warpMarkers: markers }), 20, 0.5);
  assert.ok(seekFast);
  assert.deepEqual(seekFast.segments, [
    { targetStart: 0.5, targetEnd: 1, sourceOffset: 6, sourceDuration: 1, playbackRate: 2 },
    { targetStart: 1, targetEnd: 3, sourceOffset: 7, sourceDuration: 2, playbackRate: 1 },
  ], 'half a second into a double-speed segment is one second into its source');

  // An empty marker list is not a warp at all.
  assert.deepEqual(
    computeClipSchedule(plainClip({ warpMarkers: [] }), 10)?.segments,
    [{ targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 4, playbackRate: 1 }],
    'no markers means no warp',
  );

  // Warp wins over a plain stretch rate: the markers already say where the
  // audio goes, so the rate must not be applied on top of them.
  assert.deepEqual(
    computeClipSchedule(plainClip({ offsetIntoSource: 5, warpMarkers: markers, timeStretchRate: 3 }), 20)?.segments,
    warped.segments,
    'warp markers take precedence over timeStretchRate',
  );
}

/** A warp map may re-time the clip PAST its own box: `warpSegments` closes the
 *  map by continuing at rate 1 from the last marker, so a marker that pushes
 *  audio later pushes the tail later too. The clip box is what the timeline
 *  draws, what every offline render is sized from, and what the fade envelope
 *  spans — so the schedule is clamped to it, and preview and export agree. */
function warpClampedToTheClipBox(): void {
  // Source 0-1 s stretched over the first 3 s of the clip, then 1:1 — which runs
  // the map to t = 6 on a clip whose box is 4.
  const markers: WarpMarker[] = [{ sourceSec: 1, targetSec: 3 }];
  const raw = warpSegments(markers, 4);
  assert.ok(raw[raw.length - 1].targetEnd > 4, 'this map really does overrun the clip box');

  const s = computeClipSchedule(plainClip({ offsetIntoSource: 2, warpMarkers: markers }), 20);
  assert.ok(s);
  assert.equal(s.durationSec, 4, 'the clip is as long as its box, never longer');
  assert.equal(
    s.segments[s.segments.length - 1].targetEnd, 4,
    'the last segment ends exactly on the box end',
  );
  assert.deepEqual(s.segments, [
    { targetStart: 0, targetEnd: 3, sourceOffset: 2, sourceDuration: 1, playbackRate: 1 / 3 },
    { targetStart: 3, targetEnd: 4, sourceOffset: 3, sourceDuration: 1, playbackRate: 1 },
  ], 'the overrunning segment is trimmed, and its source span with it');

  // …and the fade-out therefore anchors on the box end rather than being lost.
  const g = recorder();
  applyFadeAutomation(
    g, { durationSec: 4, fadeOutSec: 1 }, 10, 0,
    { peak: 1, effectiveDurationSec: s.durationSec },
  );
  assert.deepEqual(g.calls, [
    ['setValueAtTime', 1, 10],
    ['setValueAtTime', 1, 13],
    ['linearRampToValueAtTime', 0, 14],
  ], 'the fade-out lands on the clip box end');

  // A segment that starts at or past the box never plays at all.
  const wayPast = computeClipSchedule(
    plainClip({ durationSec: 2, warpMarkers: [{ sourceSec: 1, targetSec: 2 }] }), 20,
  );
  assert.ok(wayPast);
  assert.ok(
    wayPast.segments.every((seg) => seg.targetStart < 2 && seg.targetEnd <= 2),
    'no segment starts at or runs past the box end',
  );
}

/** Markers that `warpSegments` throws away — non-finite, negative, past the end
 *  of the source — leave an identity map. That is not a warp, so the clip must
 *  fall through to the ordinary stretch path instead of silently losing its
 *  `timeStretchRate`. */
function junkMarkersFallThroughToStretch(): void {
  const junk: WarpMarker[] = [
    { sourceSec: -5, targetSec: 1 },
    { sourceSec: NaN, targetSec: 2 },
    { sourceSec: 99, targetSec: 3 },
  ];
  assert.deepEqual(
    warpSegments(junk, 4), warpSegments([], 4),
    'these markers really are all discarded',
  );
  assert.deepEqual(
    computeClipSchedule(plainClip({ warpMarkers: junk, timeStretchRate: 2 }), 10)?.segments,
    [{ targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 8, playbackRate: 2 }],
    'junk markers do not swallow the clip stretch rate',
  );

  // A marker that only restates where the source already ends is a no-op too.
  assert.deepEqual(
    computeClipSchedule(
      plainClip({ warpMarkers: [{ sourceSec: 4, targetSec: 4 }], timeStretchRate: 0.5 }), 10,
    )?.segments,
    [{ targetStart: 0, targetEnd: 4, sourceOffset: 0, sourceDuration: 2, playbackRate: 0.5 }],
    'an identity marker is not a warp',
  );

  // But a real one-segment map still wins over the stretch rate.
  assert.deepEqual(
    computeClipSchedule(
      plainClip({ warpMarkers: [{ sourceSec: 4, targetSec: 2 }], timeStretchRate: 3 }), 10,
    )?.segments,
    [{ targetStart: 0, targetEnd: 2, sourceOffset: 0, sourceDuration: 4, playbackRate: 2 }],
    'a single non-identity segment is still a warp',
  );
}

/* ── 3. The live wiring ───────────────────────────────────────────────────── */

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

const wire = (clip: SchedulableClip, bufferDuration: number, nowSec: number, fromSec: number) => {
  const ctx = fakeCtx();
  const dest = fakeNode('destination');
  const scheduled = scheduleClipSources(
    ctx as unknown as CtxArg,
    clip,
    { duration: bufferDuration } as unknown as BufArg,
    dest as unknown as DestArg,
    nowSec,
    fromSec,
  );
  return { ctx, dest, scheduled };
};

/** `scheduleClips` resolves the track nodes and the decoded buffer and then
 *  hands each clip to `scheduleClipSources`. This drives that wiring with a
 *  stand-in context: the real one is built by playerStore.ensureEngine() off
 *  `window.AudioContext`, which no test can supply without a seam in
 *  playerStore — so the seam is here, in the function under test. */
function liveWiring(): void {
  const clip: SchedulableClip = {
    id: 'clip-a', startSec: 10, offsetIntoSource: 1, durationSec: 4,
    fadeInSec: 1, fadeOutSec: 1, gain: 0.5,
  };

  // ── A clip in the future: one source, one envelope, one gate ──────────────
  const future = wire(clip, 20, 100, 8);
  assert.ok(future.scheduled, 'a playable clip is wired up');
  const [clipGain, muteGate, src] = future.ctx.created;
  assert.deepEqual(
    future.ctx.created.map((n) => n.kind), ['gain', 'gain', 'source'],
    'one envelope gain, one mute gate, one source',
  );
  assert.equal(
    future.scheduled.muteGate as unknown, muteGate,
    'the mute gate is handed back, for clipMuteGains to key by clip id',
  );
  assert.deepEqual(future.scheduled.sources as unknown[], [src], 'so is the source list');
  assert.equal(muteGate.gain.value, 1, 'the gate opens at unity');

  // Routing: source -> clipGain -> muteGate -> destination.
  assert.deepEqual(src.outputs, [clipGain], 'the source feeds the envelope gain');
  assert.deepEqual(clipGain.outputs, [muteGate], 'the envelope feeds the mute gate');
  assert.deepEqual(muteGate.outputs, [future.dest], 'the gate feeds the track');

  // The envelope is the one lib/clipFade writes for whenSec = the clip HEAD in
  // context time (102 = 100 + (10 - 8)) and fromSec = 0.
  const expectFuture = recorder();
  applyFadeAutomation(expectFuture, clip, 102, 0, { peak: 0.5, effectiveDurationSec: 4 });
  assert.deepEqual(clipGain.gain.calls, expectFuture.calls, 'the envelope is scheduled from the clip head');
  assert.deepEqual(src.started, [[102, 1, 4]], 'the source starts at the clip head, at its offset');
  assert.equal(src.playbackRate.value, 1, 'an unstretched clip plays at unit rate');

  // ── Starting mid-clip: `into` reaches the envelope, `now` clamps the start ─
  const mid = wire(clip, 20, 100, 11.5);
  assert.ok(mid.scheduled);
  const expectMid = recorder();
  applyFadeAutomation(expectMid, clip, 98.5, 1.5, { peak: 0.5, effectiveDurationSec: 4 });
  assert.deepEqual(mid.ctx.created[0].gain.calls, expectMid.calls, 'the envelope resumes from mid-clip');
  assert.deepEqual(mid.ctx.created[2].started, [[100, 2.5, 2.5]], 'a start in the past is clamped to now');

  // ── A warped clip: one source per segment, all on ONE envelope ────────────
  const warped: SchedulableClip = {
    id: 'clip-b', startSec: 10, offsetIntoSource: 5, durationSec: 4, fadeOutSec: 1,
    warpMarkers: [{ sourceSec: 2, targetSec: 1 }, { sourceSec: 4, targetSec: 3 }],
  };
  const w = wire(warped, 20, 100, 10);
  assert.ok(w.scheduled);
  assert.deepEqual(
    w.ctx.created.map((n) => n.kind), ['gain', 'gain', 'source', 'source'],
    'two segments share one envelope gain and one gate',
  );
  const [wGain, wGate, s0, s1] = w.ctx.created;
  assert.deepEqual(s0.started, [[100, 5, 2]], 'segment 1 starts at the clip head');
  assert.equal(s0.playbackRate.value, 2, 'and plays at its own rate');
  assert.deepEqual(s1.started, [[101, 7, 2]], 'segment 2 starts one second later');
  assert.equal(s1.playbackRate.value, 1);
  assert.deepEqual([s0.outputs, s1.outputs], [[wGain], [wGain]], 'both segments feed the same envelope');
  const expectWarp = recorder();
  applyFadeAutomation(expectWarp, warped, 100, 0, { peak: 1, effectiveDurationSec: 3 });
  assert.deepEqual(wGain.gain.calls, expectWarp.calls, 'the envelope is written once, over the whole clip');

  // ── Teardown: the shared nodes outlive every segment but the last ─────────
  s0.onended?.();
  assert.equal(s0.disconnects, 1, 'a finished segment lets go of itself');
  assert.deepEqual([wGain.disconnects, wGate.disconnects], [0, 0], 'the envelope and gate stay for the rest of the clip');
  s1.onended?.();
  assert.equal(s1.disconnects, 1);
  assert.deepEqual([wGain.disconnects, wGate.disconnects], [1, 1], 'the last segment tears the clip down');

  // ── Nothing to play builds nothing ───────────────────────────────────────
  const gone = wire(clip, 20, 100, 14);
  assert.equal(gone.scheduled, null, 'a clip already finished is not wired up');
  assert.deepEqual(gone.ctx.created, [], 'and costs no nodes');
  assert.equal(wire(clip, 0, 100, 8).scheduled, null, 'nor is one with no decoded audio');
}

/** The schedule's effective length is what every fade site hands
 *  `applyFadeAutomation` as `effectiveDurationSec`, so the two have to line up:
 *  a clip whose buffer runs out early fades out at the end of the audio. */
function theEnvelopeFollowsTheSchedule(): void {
  const clip = { offsetIntoSource: 0, durationSec: 10, fadeInSec: 1, fadeOutSec: 2 };
  const schedule = computeClipSchedule(clip, 6);
  assert.ok(schedule);
  assert.equal(schedule.durationSec, 6, 'six seconds of buffer is a six second clip');
  const g = recorder();
  applyFadeAutomation(g, clip, 0, 0, { peak: 1, effectiveDurationSec: schedule.durationSec });
  assert.deepEqual(g.calls, [
    ['setValueAtTime', 0, 0],
    ['linearRampToValueAtTime', 1, 1],
    ['setValueAtTime', 1, 4],
    ['linearRampToValueAtTime', 0, 6],
  ], 'the fade-out ends where the audio ends, not where the clip claims to');

  // A named fade curve rides along untouched: the clip object itself is handed
  // over, so `fadeInCurve` reaches lib/clipFade and a shaped fade is scheduled.
  const methods: string[] = [];
  const shapedParam: AudioParamLike = {
    setValueAtTime(_v: number, _t: number) { methods.push('setValueAtTime'); },
    linearRampToValueAtTime(_v: number, _t: number) { methods.push('linearRampToValueAtTime'); },
    setValueCurveAtTime(_values: Float32Array, _t: number, _dur: number) { methods.push('setValueCurveAtTime'); },
  };
  const shaped: ScheduleClip & FadeClip = {
    offsetIntoSource: 0, durationSec: 4, fadeInSec: 1, fadeInCurve: 'equal-power',
  };
  applyFadeAutomation(shapedParam, shaped, 0, 0, { peak: 1, effectiveDurationSec: 4 });
  assert.ok(methods.includes('setValueCurveAtTime'), 'a named fade curve reaches lib/clipFade through the same call');
}

/**
 * T46A: the buffer argument widened to `AudioBuffer | (takeIndex) => AudioBuffer`
 * so a comped clip can hand over several takes' buffers through this one
 * scheduler instead of growing a second one.
 *
 * The pin is that NOTHING changed for the single-buffer form every call site
 * uses today: the schedule a plain `AudioBuffer` produces is captured here and
 * the resolver form is asserted deep-equal against it. The resolver is asked
 * once, for `clip.activeTakeIndex ?? 0`.
 */
function takeResolverSeam(): void {
  const clip: SchedulableClip = {
    id: 'clip-t', startSec: 10, offsetIntoSource: 1, durationSec: 4,
    fadeInSec: 1, fadeOutSec: 1, gain: 0.5,
  };
  const buf20 = { duration: 20 } as unknown as BufArg;
  const resolver = (fn: (takeIndex: number) => unknown): BufArg => fn as unknown as BufArg;

  /** Everything one wiring pass produced, as plain data to compare. */
  const drive = (buf: BufArg, c: SchedulableClip = clip) => {
    const ctx = fakeCtx();
    const dest = fakeNode('destination');
    const scheduled = scheduleClipSources(
      ctx as unknown as CtxArg, c, buf, dest as unknown as DestArg, 100, 8,
    );
    return {
      built: scheduled !== null,
      nodes: ctx.created.map((n) => ({
        kind: n.kind,
        started: n.started,
        calls: n.gain.calls,
        rate: n.playbackRate.value,
        buffer: n.buffer,
        outputs: n.outputs.map((o) => o.kind),
      })),
    };
  };

  // The pre-change result: the argument form every call site passes today.
  const plain = drive(buf20);
  assert.ok(plain.built, 'a plain AudioBuffer still schedules');
  assert.deepEqual(plain.nodes.map((n) => n.kind), ['gain', 'gain', 'source']);
  assert.deepEqual(plain.nodes[2].started, [[102, 1, 4]], 'and starts where it always did');

  // The resolver form: asked ONCE, for take 0, and it wires up the same graph.
  const asked: number[] = [];
  const viaResolver = drive(resolver((i) => { asked.push(i); return buf20; }));
  assert.deepEqual(asked, [0], 'the resolver is asked once, for the active take');
  assert.deepEqual(viaResolver, plain, 'a resolver schedules byte-for-byte what the plain buffer did');

  // `activeTakeIndex` is what it is asked for, and undefined means take 0.
  const askedTwo: number[] = [];
  drive(resolver((i) => { askedTwo.push(i); return buf20; }), { ...clip, activeTakeIndex: 2 });
  assert.deepEqual(askedTwo, [2], 'the ACTIVE take is the one resolved');
  const askedNone: number[] = [];
  drive(resolver((i) => { askedNone.push(i); return buf20; }), { ...clip, activeTakeIndex: undefined });
  assert.deepEqual(askedNone, [0], 'an absent active take is take 0');

  // The resolved buffer really is the one that plays: a shorter take for take 1
  // runs out early, exactly as a shorter single buffer would.
  const short = drive(
    resolver((i) => (i === 1 ? { duration: 3 } : buf20)),
    { ...clip, activeTakeIndex: 1 },
  );
  assert.deepEqual(short.nodes[2].started, [[102, 1, 2]], 'the resolved take decides the schedule');

  // Nothing decoded for that take builds nothing, like a missing buffer always has.
  const none = drive(resolver(() => undefined));
  assert.equal(none.built, false, 'an unresolved take schedules nothing');
  assert.deepEqual(none.nodes, [], 'and costs no nodes');
}

pinTheEnvelope();
scheduleWithNoNewFields();
scheduleWithTimeStretch();
scheduleWithWarpMarkers();
warpClampedToTheClipBox();
junkMarkersFallThroughToStretch();
liveWiring();
takeResolverSeam();
theEnvelopeFollowsTheSchedule();

console.log('liveMixer.schedule: ok');
