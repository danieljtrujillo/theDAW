// audioWarp: turning a clip's warp markers into playable segments. Markers are
// anchors ("this moment of the source plays at this moment of the clip"); the
// stretch between two anchors is one constant playback rate.
import assert from 'node:assert/strict';
import { warpSegments, type WarpMarker } from './audioWarp.ts';

const shape = (segs: ReturnType<typeof warpSegments>) =>
  segs.map((s) => [s.sourceStart, s.sourceEnd, s.targetStart, s.targetEnd, s.playbackRate]);
const m = (sourceSec: number, targetSec: number): WarpMarker => ({ sourceSec, targetSec });

/** Every second of the source is played exactly once, in order: the segments
 *  start at 0, end at the source duration, and hand over end-to-end. This holds
 *  whenever no anchor is degenerate — a skipped segment is the one thing that
 *  can leave a hole, and section 5 pins that case separately. */
const assertCoversSource = (segs: ReturnType<typeof warpSegments>, sourceDurationSec: number, what: string) => {
  assert.ok(segs.length > 0, `${what}: has segments`);
  assert.equal(segs[0].sourceStart, 0, `${what}: starts at the head of the source`);
  assert.equal(segs[segs.length - 1].sourceEnd, sourceDurationSec, `${what}: ends at the source end`);
  for (let i = 1; i < segs.length; i += 1) {
    assert.equal(segs[i].sourceStart, segs[i - 1].sourceEnd, `${what}: source is contiguous at ${i}`);
    assert.equal(segs[i].targetStart, segs[i - 1].targetEnd, `${what}: target is contiguous at ${i}`);
  }
};

// ── 1. No markers is the identity ────────────────────────────────────────────
{
  assert.deepEqual(shape(warpSegments([], 10)), [[0, 10, 0, 10, 1]]);
  assertCoversSource(warpSegments([], 10), 10, 'no markers');
  // Nothing to warp at all.
  assert.deepEqual(warpSegments([], 0), []);
  assert.deepEqual(warpSegments([], -3), []);
  assert.deepEqual(warpSegments([m(1, 2)], Number.NaN), []);
}

// ── 2. The implicit anchors at each end ──────────────────────────────────────
{
  // One marker in the middle: the head is anchored at 0/0, and the tail carries
  // on from the last marker at the original speed — the marked beat moves and
  // everything after it follows, rather than being squeezed to keep the clip's
  // old length.
  assert.deepEqual(shape(warpSegments([m(4, 5)], 10)), [
    [0, 4, 0, 5, 4 / 5],
    [4, 10, 5, 11, 1],
  ]);
  assertCoversSource(warpSegments([m(4, 5)], 10), 10, 'one marker');

  // A marker AT the head replaces the implicit 0/0 anchor — it is allowed to
  // push the whole clip later, again at the original speed.
  assert.deepEqual(shape(warpSegments([m(0, 1)], 10)), [[0, 10, 1, 11, 1]]);

  // A marker at the source end replaces the implicit tail anchor, so the whole
  // clip stretches.
  assert.deepEqual(shape(warpSegments([m(10, 12)], 10)), [[0, 10, 0, 12, 10 / 12]]);
  assertCoversSource(warpSegments([m(10, 12)], 10), 10, 'marker at the source end');

  // THE TAIL MUST SURVIVE A MARKER PUSHED PAST THE SOURCE DURATION. Pinning
  // the tail at source-end/source-end used to make this segment run backwards
  // in time, so it was dropped as degenerate and the audio after the marker was
  // simply never heard.
  assert.deepEqual(shape(warpSegments([m(6, 14)], 10)), [
    [0, 6, 0, 14, 6 / 14],
    [6, 10, 14, 18, 1],
  ]);
  assertCoversSource(warpSegments([m(6, 14)], 10), 10, 'marker past the source duration');

  // Two markers plus both implicit anchors: three segments, each with its own
  // rate, and the rate is always source length over target length.
  const three = warpSegments([m(2, 3), m(6, 6)], 12);
  assert.deepEqual(shape(three), [
    [0, 2, 0, 3, 2 / 3],
    [2, 6, 3, 6, 4 / 3],
    [6, 12, 6, 12, 1],
  ]);
  three.forEach((s) => {
    assert.equal(s.playbackRate, (s.sourceEnd - s.sourceStart) / (s.targetEnd - s.targetStart));
  });
  assertCoversSource(three, 12, 'two markers');
}

// ── 3. Sorting and dedupe ────────────────────────────────────────────────────
{
  // Markers do not have to arrive in order.
  assert.deepEqual(shape(warpSegments([m(6, 6), m(2, 3)], 12)), shape(warpSegments([m(2, 3), m(6, 6)], 12)));

  // Two markers on the same source moment are a contradiction; the first one
  // given wins and the rest are dropped.
  assert.deepEqual(shape(warpSegments([m(4, 5), m(4, 9)], 10)), shape(warpSegments([m(4, 5)], 10)));
  assert.deepEqual(shape(warpSegments([m(4, 5), m(4, 9), m(4, 1)], 10)), shape(warpSegments([m(4, 5)], 10)));
}

// ── 4. Markers that cannot anchor anything ───────────────────────────────────
{
  // Past the end of the source there is no audio to pin, so the marker is
  // dropped and the implicit tail anchor closes the map as usual.
  assert.deepEqual(shape(warpSegments([m(4, 5), m(20, 25)], 10)), shape(warpSegments([m(4, 5)], 10)));
  // Before the head, likewise — and non-finite markers are simply not markers.
  assert.deepEqual(shape(warpSegments([m(-1, 0), m(4, 5)], 10)), shape(warpSegments([m(4, 5)], 10)));
  assert.deepEqual(shape(warpSegments([m(Number.NaN, 5), m(4, 5)], 10)), shape(warpSegments([m(4, 5)], 10)));
  assert.deepEqual(shape(warpSegments([m(4, Number.POSITIVE_INFINITY), m(4.5, 5)], 10)), shape(warpSegments([m(4.5, 5)], 10)));
  // Drop them all and the map is the identity again.
  assert.deepEqual(shape(warpSegments([m(20, 25), m(-4, 1)], 10)), [[0, 10, 0, 10, 1]]);
}

// ── 5. Degenerate segments are skipped ───────────────────────────────────────
{
  // Two anchors on the same target moment: no time passes on the timeline, so
  // there is nothing to play there. The source between them is skipped, and
  // the tail carries on from the later anchor at the original speed.
  const sameTarget = warpSegments([m(2, 3), m(5, 3)], 10);
  assert.deepEqual(shape(sameTarget), [
    [0, 2, 0, 3, 2 / 3],
    [5, 10, 3, 8, 1],
  ]);
  // A skipped segment is the ONE thing that breaks contiguity of the source:
  // 2 s to 5 s of the audio is deliberately never played.
  assert.equal(sameTarget[1].sourceStart, 5);
  assert.notEqual(sameTarget[1].sourceStart, sameTarget[0].sourceEnd);
  // …but the TARGET still hands over end to end, so playback has no gap.
  assert.equal(sameTarget[1].targetStart, sameTarget[0].targetEnd);

  // An anchor that moves BACKWARDS in time cannot be played forwards either.
  assert.deepEqual(shape(warpSegments([m(2, 5), m(4, 1)], 10)), [
    [0, 2, 0, 5, 2 / 5],
    [4, 10, 1, 7, 1],
  ]);

  // A marker at 0/0 is the implicit head anchor, not a zero-length segment.
  assert.deepEqual(shape(warpSegments([m(0, 0), m(4, 5)], 10)), shape(warpSegments([m(4, 5)], 10)));

  // The whole grammar in one map: a head anchor, a skipped same-target pair, a
  // speed-up, a big push, and a rate-1 tail that survives the push.
  const segs = warpSegments([m(2, 3), m(5, 3), m(7, 4), m(8, 30)], 12);
  assert.deepEqual(shape(segs), [
    [0, 2, 0, 3, 2 / 3],
    [5, 7, 3, 4, 2],
    [7, 8, 4, 30, 1 / 26],
    [8, 12, 30, 34, 1],
  ]);
  segs.forEach((s) => {
    assert.ok(s.sourceEnd > s.sourceStart, 'source span is positive');
    assert.ok(s.targetEnd > s.targetStart, 'target span is positive');
    assert.ok(Number.isFinite(s.playbackRate) && s.playbackRate > 0, 'rate is playable');
    assert.ok(s.sourceStart >= 0 && s.sourceEnd <= 12, 'segment stays inside the source');
    assert.equal(s.playbackRate, (s.sourceEnd - s.sourceStart) / (s.targetEnd - s.targetStart));
  });
  // The target is continuous throughout even where the source is not.
  for (let i = 1; i < segs.length; i += 1) {
    assert.equal(segs[i].targetStart, segs[i - 1].targetEnd, `target is contiguous at ${i}`);
  }
}

console.log('audioWarp: ok');
