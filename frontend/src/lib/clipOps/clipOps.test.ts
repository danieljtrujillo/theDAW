/**
 * Timeline clip math, end to end.
 *
 * Every function under test is pure: a clip in, a new clip (or a plan) out, and
 * the input object is never touched. That is the whole reason this layer exists
 * separately from `editorStore` — the assistant's `editor_*` tools need to know
 * what an edit WOULD do (and whether it is legal) before anything is committed
 * to the store, and a Node test can prove that without a browser.
 *
 * The cases pinned here are the ones that are easy to get wrong by one term:
 * trimming past the ends of the source media, nudging into negative time,
 * validating a fade against the duration it is being applied to at the same
 * time, and the BPM→ratio direction for a stretch (faster tempo = SHORTER clip).
 *
 * Run: `npx tsx src/lib/clipOps/clipOps.test.ts`
 */
import assert from 'node:assert/strict';
import type { AudioClip } from '../../state/editorStore';
import {
  MIN_CLIP_SEC,
  crossfadePlan,
  duplicateClip,
  mergePlan,
  nudgeClip,
  selectRange,
  setClipProps,
  setClipSourceBpm,
  stretchPlan,
  trimClip,
} from './timeline';
import type { ClipOpResult } from './timeline';

/** A clip with 1s of source trimmed off its head and 5s left after its tail. */
const clip = (over: Partial<AudioClip> = {}): AudioClip => ({
  id: 'c1',
  trackId: 't1',
  label: 'clip',
  audioBlob: new Blob(['x'], { type: 'audio/wav' }),
  mimeType: 'audio/wav',
  sourceDuration: 10,
  offsetIntoSource: 1,
  durationSec: 4,
  startSec: 2,
  color: '#8b5cf6',
  ...over,
});

const ok = <T>(r: ClipOpResult<T>): T => {
  if (!r.ok) assert.fail(`expected ok, got error: ${r.error}`);
  return r.value;
};
const err = <T>(r: ClipOpResult<T>): string => {
  if (r.ok) assert.fail('expected an error result');
  return r.error;
};

/* ── trimClip: inside the source bounds ──────────────────────────────────── */
{
  const c = clip();

  // Pull the in point later: the timeline start moves right and the SAME
  // number of seconds is consumed from the source, so the audio under the
  // remaining clip does not shift.
  const inTrimmed = trimClip(c, { inSec: 3 });
  assert.equal(inTrimmed.startSec, 3);
  assert.equal(inTrimmed.offsetIntoSource, 2);
  assert.equal(inTrimmed.durationSec, 3);

  // Pull the out point earlier: only the length changes.
  const outTrimmed = trimClip(c, { outSec: 4 });
  assert.equal(outTrimmed.startSec, 2);
  assert.equal(outTrimmed.offsetIntoSource, 1);
  assert.equal(outTrimmed.durationSec, 2);

  // Both at once.
  const both = trimClip(c, { inSec: 3, outSec: 4.5 });
  assert.equal(both.startSec, 3);
  assert.equal(both.offsetIntoSource, 2);
  assert.equal(both.durationSec, 1.5);

  // The input is untouched and the result is a different object.
  assert.notEqual(both, c);
  assert.equal(c.startSec, 2);
  assert.equal(c.offsetIntoSource, 1);
  assert.equal(c.durationSec, 4);
  // Everything not part of the trim rides along.
  assert.equal(both.id, 'c1');
  assert.equal(both.label, 'clip');
  assert.equal(both.audioBlob, c.audioBlob);
}

/* ── trimClip: clamped to what the source actually has ───────────────────── */
{
  const c = clip();

  // Only 1s of source exists before the current head, so the in point cannot
  // travel further left than 1s of timeline.
  const wayLeft = trimClip(c, { inSec: -20 });
  assert.equal(wayLeft.startSec, 1);
  assert.equal(wayLeft.offsetIntoSource, 0, 'cannot read before the start of the source');
  assert.equal(wayLeft.durationSec, 5);

  // Only 5s of source exists after the current tail.
  const wayRight = trimClip(c, { outSec: 100 });
  assert.equal(wayRight.startSec, 2);
  assert.equal(wayRight.durationSec, 9);
  assert.equal(
    wayRight.offsetIntoSource + wayRight.durationSec,
    c.sourceDuration,
    'cannot read past the end of the source',
  );

  // A clip parked at 0.5s with 3s of source behind it still cannot start before 0.
  const nearZero = trimClip(clip({ startSec: 0.5, offsetIntoSource: 3 }), { inSec: -1 });
  assert.equal(nearZero.startSec, 0);
  assert.equal(nearZero.offsetIntoSource, 2.5);
  assert.equal(nearZero.durationSec, 4.5);

  // An inverted / degenerate request collapses to the minimum, never to zero
  // or a negative length.
  const collapsed = trimClip(c, { inSec: 5, outSec: 5 });
  assert.equal(collapsed.durationSec, MIN_CLIP_SEC);
  assert.equal(collapsed.startSec, 5);

  // An in point at or past the very end of the media leaves nothing to play, so
  // the head is backed off to the shortest legal clip rather than handed back
  // with zero length.
  for (const inSec of [11, 50]) {
    const atEnd = trimClip(c, { inSec });
    // Tolerances here are float dust from `sourceDuration - offsetIntoSource`
    // (10 - 9.99), not slack in the rule.
    assert.ok(
      Math.abs(atEnd.durationSec - MIN_CLIP_SEC) < 1e-9,
      `inSec ${inSec}: shortest legal clip, got ${atEnd.durationSec}`,
    );
    assert.ok(
      Math.abs(atEnd.startSec - (11 - MIN_CLIP_SEC)) < 1e-9,
      `inSec ${inSec}: backed off the end, got ${atEnd.startSec}`,
    );
    assert.ok(
      atEnd.offsetIntoSource + atEnd.durationSec <= c.sourceDuration + 1e-12,
      `inSec ${inSec}: ran past the end of the source`,
    );
  }

  // A source shorter than the minimum clip length: the MIN_CLIP_SEC floor must
  // yield, because a window that reads past the end of the media is a decode
  // error at playback time, whereas a clip below the nominal minimum is merely
  // small. Containment wins over the floor, always.
  const tiny = clip({ sourceDuration: 0.005, offsetIntoSource: 0, durationSec: 0.005, startSec: 0 });
  for (const bounds of [
    { outSec: 10 },
    { inSec: -5 },
    { inSec: 0.004, outSec: 0.004 },
    { inSec: 10, outSec: 20 },
    {},
  ]) {
    const t = trimClip(tiny, bounds);
    assert.ok(
      t.offsetIntoSource + t.durationSec <= tiny.sourceDuration + 1e-12,
      `${JSON.stringify(bounds)}: window ran past a 5ms source ` +
        `(offset ${t.offsetIntoSource} + duration ${t.durationSec} > ${tiny.sourceDuration})`,
    );
    assert.ok(t.offsetIntoSource >= 0, `${JSON.stringify(bounds)}: negative offset`);
    assert.ok(t.startSec >= 0, `${JSON.stringify(bounds)}: negative start`);
    assert.ok(t.durationSec > 0, `${JSON.stringify(bounds)}: zero-length clip`);
  }
  assert.equal(trimClip(tiny, { outSec: 10 }).durationSec, 0.005, 'a 5ms source yields a 5ms clip, not a 10ms one');

  // Same rule partway into a short source: only what is left may be used.
  const tinyOffset = clip({ sourceDuration: 0.005, offsetIntoSource: 0.002, durationSec: 0.003, startSec: 1 });
  const grown = trimClip(tinyOffset, { outSec: 99 });
  assert.equal(grown.offsetIntoSource, 0.002, 'the head did not move');
  assert.equal(grown.durationSec, 0.003, 'only the 3ms that remain after the offset');

  // No bounds given = no change.
  const same = trimClip(c, {});
  assert.deepEqual(
    [same.startSec, same.offsetIntoSource, same.durationSec],
    [c.startSec, c.offsetIntoSource, c.durationSec],
  );
}

/* ── nudgeClip: relative move, clamped at the timeline origin ────────────── */
{
  const c = clip(); // startSec 2

  assert.equal(nudgeClip(c, 3).startSec, 5);
  assert.equal(nudgeClip(c, -1.5).startSec, 0.5);
  assert.equal(nudgeClip(c, -5).startSec, 0, 'clamps at 0 rather than going negative');
  assert.equal(nudgeClip(c, -5, { minStart: 1 }).startSec, 1, 'honours a custom floor');
  assert.equal(nudgeClip(c, Number.NaN).startSec, 2, 'a junk delta is a no-op');

  // A nudge only moves the clip on the timeline; the source window is untouched.
  const moved = nudgeClip(c, -5);
  assert.equal(moved.offsetIntoSource, c.offsetIntoSource);
  assert.equal(moved.durationSec, c.durationSec);
  assert.equal(c.startSec, 2, 'input untouched');
}

/* ── duplicateClip: new id, placed after the original by default ─────────── */
{
  const c = clip(); // startSec 2, durationSec 4

  const after = duplicateClip(c, { newId: 'c2' });
  assert.equal(after.id, 'c2');
  assert.equal(after.startSec, 6, 'defaults to butt-joined after the original');
  assert.equal(after.trackId, c.trackId);
  assert.equal(after.offsetIntoSource, c.offsetIntoSource);
  assert.equal(after.durationSec, c.durationSec);
  assert.equal(after.audioBlob, c.audioBlob, 'shares the source bytes, no re-encode');

  assert.equal(duplicateClip(c, { newId: 'c3', at: 12 }).startSec, 12);
  assert.equal(duplicateClip(c, { newId: 'c4', at: -3 }).startSec, 0, 'clamps at the origin');
  assert.equal(duplicateClip(c, { newId: 'c5', at: Number.NaN }).startSec, 6, 'junk falls back');

  assert.equal(c.id, 'c1', 'input untouched');
}

/* ── setClipProps: validation ────────────────────────────────────────────── */
{
  const c = clip(); // durationSec 4, offsetIntoSource 1, sourceDuration 10

  const good = ok(
    setClipProps(c, { gain: 1.5, fadeInSec: 0.5, fadeOutSec: 1, muted: true, label: 'lead' }),
  );
  assert.equal(good.gain, 1.5);
  assert.equal(good.fadeInSec, 0.5);
  assert.equal(good.fadeOutSec, 1);
  assert.equal(good.muted, true);
  assert.equal(good.label, 'lead');
  assert.equal(c.gain, undefined, 'input untouched');

  // Unmentioned keys are left exactly as they were.
  const partial = ok(setClipProps(good, { muted: false }));
  assert.equal(partial.gain, 1.5);
  assert.equal(partial.fadeInSec, 0.5);
  assert.equal(partial.muted, false);

  assert.match(err(setClipProps(c, { gain: -0.1 })), /gain/);
  assert.match(err(setClipProps(c, { gain: Number.POSITIVE_INFINITY })), /gain/);
  assert.match(err(setClipProps(c, { fadeInSec: 5 })), /fadeInSec/, 'fade longer than the clip');
  assert.match(err(setClipProps(c, { fadeOutSec: -1 })), /fadeOutSec/);
  assert.match(err(setClipProps(c, { durationSec: 0 })), /durationSec/);
  assert.match(
    err(setClipProps(c, { durationSec: 50 })),
    /source/,
    'cannot play past the end of the source',
  );
  assert.match(err(setClipProps(c, { label: '   ' })), /label/);
  assert.match(err(setClipProps(c, { instrumentProgram: 200 })), /instrumentProgram/);

  // Shrinking the duration is checked against the fades that will survive it.
  const faded = ok(setClipProps(c, { fadeInSec: 3 }));
  assert.match(err(setClipProps(faded, { durationSec: 1 })), /fadeInSec/);
  ok(setClipProps(faded, { durationSec: 1, fadeInSec: 0.5 }));

  // A fade exactly as long as the clip is legal.
  assert.equal(ok(setClipProps(c, { fadeInSec: 4 })).fadeInSec, 4);
  assert.equal(ok(setClipProps(c, { gain: 0 })).gain, 0, 'silence is a legal gain');
  assert.equal(ok(setClipProps(c, { instrumentProgram: 0 })).instrumentProgram, 0);
  assert.equal(ok(setClipProps(c, {})).id, c.id, 'an empty patch is legal');
}

/* ── selectRange: overlap, with an optional track filter ─────────────────── */
{
  const clips: AudioClip[] = [
    clip({ id: 'a', trackId: 't1', startSec: 0, durationSec: 2 }),   // 0..2
    clip({ id: 'b', trackId: 't1', startSec: 4, durationSec: 2 }),   // 4..6
    clip({ id: 'c', trackId: 't2', startSec: 5, durationSec: 4 }),   // 5..9
    clip({ id: 'd', trackId: 't2', startSec: 20, durationSec: 1 }),  // 20..21
  ];

  assert.deepEqual(selectRange(clips, { startSec: 3, endSec: 7 }), ['b', 'c']);
  assert.deepEqual(
    selectRange(clips, { startSec: 3, endSec: 7, trackIds: ['t2'] }),
    ['c'],
    'the track filter drops b',
  );
  assert.deepEqual(selectRange(clips, { startSec: 3, endSec: 7, trackIds: [] }), [], 'an empty filter selects nothing');
  assert.deepEqual(selectRange(clips, { startSec: 7, endSec: 3 }), ['b', 'c'], 'a reversed range is normalized');
  assert.deepEqual(selectRange(clips, { startSec: 100, endSec: 200 }), []);

  // Touching edges do not count as overlap; a shared instant is not a selection.
  assert.deepEqual(selectRange(clips, { startSec: 2, endSec: 4 }), []);
  assert.deepEqual(selectRange(clips, { startSec: 0, endSec: 30 }), ['a', 'b', 'c', 'd'], 'returned in timeline order');
}

/* ── mergePlan: order, gaps, and the cross-track refusal ─────────────────── */
{
  const a = clip({ id: 'a', trackId: 't1', startSec: 4, durationSec: 2 }); // 4..6
  const b = clip({ id: 'b', trackId: 't1', startSec: 0, durationSec: 2 }); // 0..2
  const cc = clip({ id: 'c', trackId: 't1', startSec: 7, durationSec: 1 }); // 7..8

  const plan = ok(mergePlan([a, b, cc]));
  assert.deepEqual(plan.order, ['b', 'a', 'c'], 'sorted by timeline position, not argument order');
  assert.deepEqual(plan.gaps, [2, 1], 'silence between b→a and a→c');
  assert.equal(plan.totalDurationSec, 8, '5s of audio + 3s of gap');
  assert.equal(plan.trackId, 't1');

  // Overlapping clips report a zero gap — concat cannot splice backwards.
  const overlapping = ok(mergePlan([b, clip({ id: 'z', trackId: 't1', startSec: 1, durationSec: 2 })]));
  assert.deepEqual(overlapping.gaps, [0]);
  assert.equal(overlapping.totalDurationSec, 4);

  assert.match(
    err(mergePlan([a, clip({ id: 'x', trackId: 't2' })])),
    /track/i,
    'clips on different tracks cannot be merged',
  );
  assert.match(err(mergePlan([a])), /at least 2/i);
  assert.match(err(mergePlan([])), /at least 2/i);
}

/* ── crossfadePlan: symmetric fades, later clip slid back over the earlier ─ */
{
  const first = clip({ id: 'a', startSec: 0, durationSec: 4 });  // 0..4
  const second = clip({ id: 'b', startSec: 4, durationSec: 4, offsetIntoSource: 1 }); // 4..8

  const plan = ok(crossfadePlan(first, second, { overlapSec: 1 }));
  assert.equal(plan.overlapSec, 1);
  assert.equal(plan.first.id, 'a');
  assert.equal(plan.first.fadeOutSec, 1);
  assert.equal(plan.second.id, 'b');
  assert.equal(plan.second.fadeInSec, 1, 'both sides fade over the same window');
  assert.equal(plan.second.startSec, 3, 'the later clip slides back onto the earlier one');

  // Argument order does not decide which clip is "first" — timeline position does.
  const flipped = ok(crossfadePlan(second, first, { overlapSec: 1 }));
  assert.equal(flipped.first.id, 'a');
  assert.equal(flipped.second.id, 'b');

  // The overlap cannot exceed the shorter clip, and the result reports what it
  // actually used rather than what was asked for.
  const clamped = ok(crossfadePlan(first, clip({ id: 's', startSec: 4, durationSec: 0.5 }), { overlapSec: 9 }));
  assert.equal(clamped.overlapSec, 0.5);
  assert.equal(clamped.first.fadeOutSec, 0.5);
  assert.equal(clamped.second.startSec, 3.5);

  // The later clip can never be slid past the timeline origin.
  const atOrigin = ok(
    crossfadePlan(clip({ id: 'p', startSec: 0, durationSec: 2 }), clip({ id: 'q', startSec: 2, durationSec: 4 }), {
      overlapSec: 2,
    }),
  );
  assert.equal(atOrigin.second.startSec, 0);
  assert.equal(atOrigin.overlapSec, 2);

  assert.match(err(crossfadePlan(first, second, { overlapSec: 0 })), /overlap/i);
  assert.match(err(crossfadePlan(first, second, { overlapSec: -1 })), /overlap/i);
  assert.match(err(crossfadePlan(first, first, { overlapSec: 1 })), /same clip/i);
  assert.match(
    err(crossfadePlan(first, clip({ id: 'far', startSec: 50, durationSec: 2 }), { overlapSec: 1 })),
    /gap/i,
    'clips that do not touch cannot crossfade without moving more than the overlap',
  );
}

/* ── setClipSourceBpm ────────────────────────────────────────────────────── */
{
  const c = clip({ sourceKind: 'piano-roll', sourceBpm: 120 });
  assert.equal(ok(setClipSourceBpm(c, 99)).sourceBpm, 99);
  assert.equal(c.sourceBpm, 120, 'input untouched');
  assert.match(err(setClipSourceBpm(c, 0)), /bpm/i);
  assert.match(err(setClipSourceBpm(c, 10)), /bpm/i);
  assert.match(err(setClipSourceBpm(c, 1000)), /bpm/i);
  assert.match(err(setClipSourceBpm(c, Number.NaN)), /bpm/i);
}

/* ── stretchPlan: ratio direction and the 99 → 120 BPM case ──────────────── */
{
  const midi = clip({
    sourceKind: 'piano-roll',
    sourceBpm: 99,
    sourceTotalSteps: 16,
    durationSec: 8,
    sourcePianoRoll: [{ id: 'n1', note: 60, step: 0, length: 4, velocity: 100 }],
  });

  // 99 → 120 BPM is FASTER, so the clip gets shorter: ratio = 99/120 = 0.825.
  const faster = ok(stretchPlan(midi, { targetBpm: 120 }));
  assert.equal(faster.kind, 'midi');
  assert.ok(Math.abs(faster.ratio - 0.825) < 1e-12, `ratio was ${faster.ratio}`);
  assert.ok(Math.abs(faster.newDurationSec - 6.6) < 1e-9, `duration was ${faster.newDurationSec}`);

  // The inverse direction is the reciprocal.
  const slower = ok(stretchPlan(clip({ sourceKind: 'piano-roll', sourceBpm: 120, durationSec: 6.6 }), { targetBpm: 99 }));
  assert.ok(Math.abs(slower.ratio - 120 / 99) < 1e-12);

  // A target length works on audio too, and reports the audio kind so the
  // caller knows to route it at the pitch-preserving backend stretch.
  const audio = ok(stretchPlan(clip({ durationSec: 4 }), { targetDurationSec: 6 }));
  assert.equal(audio.kind, 'audio');
  assert.equal(audio.ratio, 1.5);
  assert.equal(audio.newDurationSec, 6);

  assert.match(err(stretchPlan(midi, {})), /target/i);
  assert.match(err(stretchPlan(midi, { targetBpm: 120, targetDurationSec: 6 })), /exactly one/i);
  assert.match(err(stretchPlan(clip(), { targetBpm: 120 })), /sourceBpm/i, 'no source tempo, no ratio');
  assert.match(err(stretchPlan(midi, { targetDurationSec: 0 })), /targetDurationSec/i);
  assert.match(err(stretchPlan(midi, { targetBpm: 5 })), /bpm/i);
}

console.log('clipOps/timeline: ok');
