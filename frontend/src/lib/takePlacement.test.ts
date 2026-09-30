// takePlacement: does a new pass land ON an existing clip, or beside it?
//
// Pure arithmetic over spans, so the suite pins the rule itself rather than the
// store that applies it:
//
//   * the overlap threshold is the SHORTER span's half, and exactly half counts;
//   * a take must be READABLE as the clip: the clip's head cannot precede the
//     take's, and the take must reach the clip's end (bar a tolerance);
//   * the read head is rebased onto the clip's start, which is the whole reason
//     this file exists — a take brings bytes, not a position;
//   * a take that measured nothing (length 0) never matches, because the length
//     repair is about to rewrite it;
//   * of several candidates the biggest overlap wins, and a tie goes to the
//     earlier clip, so the choice never depends on the clip array's order;
//   * a MIDI clip is never a take target;
//   * the label never repeats a number already on the clip.
import assert from 'node:assert/strict';
import {
  TAKE_COVER_TOLERANCE_SEC,
  TAKE_OVERLAP_MIN,
  matchClipForTake,
  nextTakeLabel,
  takeOverlapRatio,
  takeReadOffsetFor,
  type TakeSpan,
  type TakeTargetClip,
} from './takePlacement.ts';

const clip = (
  id: string,
  startSec: number,
  durationSec: number,
  extra: Partial<TakeTargetClip> = {},
): TakeTargetClip => ({ id, startSec, durationSec, ...extra });

const span = (startSec: number, durationSec: number, offsetIntoSource = 0): TakeSpan =>
  ({ startSec, durationSec, offsetIntoSource });

// ── 1. the overlap ratio ─────────────────────────────────────────────────────
{
  assert.equal(TAKE_OVERLAP_MIN, 0.5, 'half of the shorter span is the rule');

  // Identical spans overlap completely.
  assert.equal(takeOverlapRatio(clip('c', 0, 4), span(0, 4)), 1);

  // The take is the shorter span: 2 s of its 4 s overlap a 10 s clip.
  assert.equal(takeOverlapRatio(clip('c', 0, 10), span(8, 4)), 0.5);

  // The CLIP is the shorter span, so it is the clip's half that decides.
  assert.equal(takeOverlapRatio(clip('c', 9, 2), span(0, 10)), 0.5);

  // Disjoint, and touching end-to-end, are both nothing.
  assert.equal(takeOverlapRatio(clip('c', 0, 4), span(6, 4)), 0);
  assert.equal(takeOverlapRatio(clip('c', 0, 4), span(4, 4)), 0);
}

// ── 2. the read head is rebased onto the CLIP's start ────────────────────────
{
  // Take and clip start together: the head is the head the take already had.
  assert.equal(takeReadOffsetFor(clip('c', 4, 4), span(4, 4)), 0);

  // The clip starts LATER than the take, so the clip reads that much further
  // into it. Without this the clip would play the take from the take's own
  // beginning and run out early.
  assert.equal(takeReadOffsetFor(clip('c', 6, 2), span(4, 4)), 2);

  // A punch crop already moved the head; the rebase adds to it.
  assert.equal(takeReadOffsetFor(clip('c', 6, 2), span(4, 4, 1.5)), 3.5);

  // The clip starts BEFORE the take: there are no bytes from before the
  // recording started, so this is not a take of this clip at all.
  assert.equal(takeReadOffsetFor(clip('c', 3, 5), span(4, 4)), null);
  assert.equal(takeReadOffsetFor(clip('c', 3.999, 4), span(4, 4)), null, 'and no clamping to zero');

  // The clip ends after the take does. Activating such a take would silence the
  // clip's tail, so it is refused — the tolerance, and one tick past it.
  assert.equal(takeReadOffsetFor(clip('c', 4, 4 + TAKE_COVER_TOLERANCE_SEC), span(4, 4)), 0);
  assert.equal(takeReadOffsetFor(clip('c', 4, 4.02), span(4, 4)), null);
  assert.equal(takeReadOffsetFor(clip('c', 4, 40), span(4, 4)), null, 'a fragment is not a take');
}

// ── 3. the two tests together ────────────────────────────────────────────────
{
  // Exactly 50 % overlap, and the take covers the clip: it lands on it. (The
  // clip is the shorter span here, so half of IT is the threshold.)
  assert.equal(takeOverlapRatio(clip('c1', 0, 4), span(0, 8)), 1);
  assert.equal(matchClipForTake([clip('c1', 0, 4)], span(0, 8)), 'c1');

  // 50 % overlap WITHOUT coverage — the case the overlap rule alone would have
  // accepted and the clip would have played as an eight-second fragment of a
  // ten-second clip. A clip of its own instead, until comping can hold it.
  assert.equal(takeOverlapRatio(clip('c1', 0, 10), span(8, 4)), 0.5);
  assert.equal(matchClipForTake([clip('c1', 0, 10)], span(8, 4)), null);

  // Under the threshold, however readable.
  assert.equal(matchClipForTake([clip('c1', 0, 10)], span(8.1, 4)), null);

  // Disjoint entirely, and nothing at all.
  assert.equal(matchClipForTake([clip('c1', 0, 4)], span(20, 4)), null);
  assert.equal(matchClipForTake([], span(0, 4)), null);
}

// ── 4. a take with no measured length never matches ──────────────────────────
{
  // `takeClipPlacement` reports 0 for a pass whose clock never moved, and the
  // decode is about to supply the real length. Matching on a length that is
  // known to be wrong would bury the pass inside a clip it may not overlap at
  // all — so it lands as its own clip, which is what every such pass did
  // before takes existed.
  assert.equal(matchClipForTake([clip('c1', 0, 10)], span(2, 0)), null);
  assert.equal(matchClipForTake([clip('c1', 0, 10)], span(2, Number.NaN)), null);

  // A clip with no length of its own is not a target either.
  assert.equal(matchClipForTake([clip('c1', 0, 0)], span(0, 4)), null);
  assert.equal(matchClipForTake([clip('c1', Number.NaN, 4)], span(0, 4)), null);

  // Nor is a negative read head, however it got there.
  assert.equal(takeReadOffsetFor(clip('c1', 0, 4), span(0, 4, -1)), null);
}

// ── 5. several candidates: the biggest overlap, ties to the earlier clip ─────
{
  const take = span(0, 10); // 0 → 10, covering all three clips below
  const clips = [
    clip('small', 8, 2),  // 2 s of 2 = 1.0, but 2 s of overlap
    clip('big', 0, 10),   // 10 s of 10 = 1.0
  ];
  // Both ratios are 1 (each clip is wholly inside the take), so the tie rule
  // decides and the EARLIER clip takes it.
  assert.equal(matchClipForTake(clips, take), 'big');
  assert.equal(matchClipForTake([...clips].reverse(), take), 'big', 'and the array order does not decide');

  // A clearer winner: only one of the two is covered at all.
  assert.equal(
    matchClipForTake([clip('late', 6, 8), clip('inside', 2, 4)], span(0, 10)),
    'inside',
    'the clip the take can actually be wins',
  );
}

// ── 6. a MIDI clip is never a take target ────────────────────────────────────
{
  // A piano-roll clip's audio is derived from its notes and is re-rendered on
  // every instrument change, so an audio take stacked onto it would be thrown
  // away by the next render — and "Edit in Piano Roll" would open the wrong
  // material. Such a clip is stepped over and the take lands beside it.
  const midi = clip('midi', 0, 10, { sourceKind: 'piano-roll' });
  assert.equal(matchClipForTake([midi], span(0, 10)), null);

  // With an audio clip beside it, the audio one is chosen even though the MIDI
  // clip is the earlier of the two.
  assert.equal(
    matchClipForTake([midi, clip('audio', 2, 4, { sourceKind: 'audio' })], span(0, 10)),
    'audio',
  );
}

// ── 7. the label never repeats a number the clip already carries ─────────────
{
  // No takes yet: the clip's current media IS take 1, so the pass landing on it
  // is take 2 — and the clip's own label is in the running, because that is the
  // label take 1 is seeded with.
  assert.equal(nextTakeLabel(clip('c', 0, 4)), 'Take 2');
  assert.equal(nextTakeLabel(clip('c', 0, 4, { label: 'Take 1' })), 'Take 2');
  assert.equal(nextTakeLabel(clip('c', 0, 4, { takes: [] })), 'Take 2');

  // A clip already called `Take 2` — the second pass of an earlier session,
  // dragged here — must not be joined by a second `Take 2`.
  assert.equal(nextTakeLabel(clip('c', 0, 4, { label: 'Take 2' })), 'Take 3');
  assert.equal(nextTakeLabel(clip('c', 0, 4, { label: 'Take 9' })), 'Take 10');

  // A clip with a name of its own carries no number, so counting decides.
  assert.equal(nextTakeLabel(clip('c', 0, 4, { label: 'vocals.wav' })), 'Take 2');

  assert.equal(nextTakeLabel(clip('c', 0, 4, { takes: [{ label: 'Take 1' }, { label: 'Take 2' }] })), 'Take 3');

  // Takes deleted in the middle, or renamed: the highest number wins over the
  // count, so no label is ever issued twice.
  assert.equal(nextTakeLabel(clip('c', 0, 4, { takes: [{ label: 'Take 1' }, { label: 'Take 4' }] })), 'Take 5');
  assert.equal(nextTakeLabel(clip('c', 0, 4, { takes: [{ label: 'vocals' }, { label: 'harmony' }] })), 'Take 3');
  assert.equal(
    nextTakeLabel(clip('c', 0, 4, { takes: [{ label: 'Take 3' }, { label: 'x' }, { label: 'y' }] })),
    'Take 4',
    'the count says 4 and the highest number says 4 — and either way it is free',
  );
  assert.equal(
    nextTakeLabel(clip('c', 0, 4, { takes: [{ label: 'a' }, { label: 'Take 3' }, { label: 'c' }] })),
    'Take 4',
    'the count would have collided with an existing label',
  );
}

console.log('takePlacement.test.ts: all assertions passed');
