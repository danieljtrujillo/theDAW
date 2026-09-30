// clipDragMath: the trim/move/slip arithmetic EDIT does inline today, pulled
// out so it can be tested. The first section is the proof that matters — the
// module is checked against a transcription of the current inline math in
// WaveformEditor.tsx's onPointerMove (~:3029-3050) over a grid of clips and
// deltas, so wave 3 can swap it in without a behaviour change.
import assert from 'node:assert/strict';
import {
  fromTimelineOffset, MIN_CLIP_SEC, move, resizeLeft, resizeRight, slip, toTimelineView,
  type DragClip,
} from './clipDragMath.ts';

const clip = (over: Partial<DragClip> = {}): DragClip => ({
  startSec: 4, durationSec: 3, offsetIntoSource: 1, sourceDuration: 10, ...over,
});

// ── 1. Against the current inline math ───────────────────────────────────────
{
  // Transcribed from WaveformEditor.tsx onPointerMove, with snapping off
  // (`snapSec` is the identity when the grid is 'off').
  const inlineMove = (c: DragClip, dxSec: number) => Math.max(0, c.startSec + dxSec);
  const inlineResizeRight = (c: DragClip, dxSec: number) => {
    const newDur = Math.max(0.05, c.durationSec + dxSec);
    const maxDur = Math.max(0.05, c.sourceDuration - c.offsetIntoSource);
    return Math.min(newDur, maxDur);
  };
  const inlineResizeLeft = (c: DragClip, dxSec: number) => {
    const delta = dxSec;
    const newStart = c.startSec + delta;
    const newOffset = c.offsetIntoSource + delta;
    const newDur = c.durationSec - delta;
    if (newDur <= 0.05 || newOffset < 0) return null;
    return { startSec: Math.max(0, newStart), offsetIntoSource: newOffset, durationSec: newDur };
  };

  const cases: DragClip[] = [
    clip(),
    clip({ startSec: 0, offsetIntoSource: 0 }),
    clip({ startSec: 0.2, durationSec: 0.06, offsetIntoSource: 0.01 }),
    clip({ startSec: 12, durationSec: 8, offsetIntoSource: 2, sourceDuration: 9 }),
    clip({ startSec: 1, durationSec: 5, offsetIntoSource: 5, sourceDuration: 5 }),
  ];
  const deltas = [-20, -5, -3, -2.95, -1, -0.06, -0.05, -0.0001, 0, 0.0001, 0.05, 1, 3, 7, 40];

  for (const c of cases) {
    for (const dx of deltas) {
      const where = `clip ${JSON.stringify(c)} dx=${dx}`;
      // move changes only the start, and never crosses zero.
      const moved = move(c, dx);
      assert.equal(moved.startSec, inlineMove(c, dx), `move start: ${where}`);
      assert.equal(moved.durationSec, c.durationSec, `move keeps length: ${where}`);
      assert.equal(moved.offsetIntoSource, c.offsetIntoSource, `move keeps offset: ${where}`);

      // resize-right changes only the length, clamped to what is left of the source.
      const right = resizeRight(c, dx);
      assert.equal(right.durationSec, inlineResizeRight(c, dx), `resizeRight length: ${where}`);
      assert.equal(right.startSec, c.startSec, `resizeRight keeps start: ${where}`);
      assert.equal(right.offsetIntoSource, c.offsetIntoSource, `resizeRight keeps offset: ${where}`);

      // resize-left moves start, offset and length together — or refuses.
      assert.deepEqual(resizeLeft(c, dx), inlineResizeLeft(c, dx), `resizeLeft: ${where}`);
    }
  }
}

// ── 2. The minimum clip length ───────────────────────────────────────────────
{
  assert.equal(MIN_CLIP_SEC, 0.05);

  // Dragging the right edge past the minimum clamps to it rather than refusing.
  assert.equal(resizeRight(clip(), -10).durationSec, MIN_CLIP_SEC);
  assert.equal(resizeRight(clip({ durationSec: 0.05 }), -1).durationSec, MIN_CLIP_SEC);

  // Dragging the left edge past the minimum refuses: the clip is left alone.
  assert.equal(resizeLeft(clip(), 3), null);        // would leave 0 s
  assert.equal(resizeLeft(clip(), 2.95), null);     // would leave exactly the minimum
  assert.notEqual(resizeLeft(clip(), 2.94), null);  // a hair under, still allowed
  // …and so does a drag that would run off the head of the source.
  assert.equal(resizeLeft(clip({ offsetIntoSource: 0.5 }), -0.6), null);
  assert.deepEqual(resizeLeft(clip({ offsetIntoSource: 0.5 }), -0.5), {
    startSec: 3.5, durationSec: 3.5, offsetIntoSource: 0,
  });

  // The right edge never reads past the end of the source.
  assert.equal(resizeRight(clip({ offsetIntoSource: 8, sourceDuration: 10 }), 50).durationSec, 2);
  // A clip whose offset already sits at (or past) the source end still keeps a
  // usable minimum length, exactly as the inline math does.
  assert.equal(resizeRight(clip({ offsetIntoSource: 10, sourceDuration: 10 }), 50).durationSec, MIN_CLIP_SEC);
}

// ── 3. Slip ──────────────────────────────────────────────────────────────────
{
  const c = clip({ startSec: 4, durationSec: 3, offsetIntoSource: 1, sourceDuration: 10 });

  // Only the offset moves — the clip stays where it is and keeps its length.
  const s = slip(c, 2);
  assert.deepEqual(s, { startSec: 4, durationSec: 3, offsetIntoSource: 3 });
  assert.deepEqual(slip(c, -0.5), { startSec: 4, durationSec: 3, offsetIntoSource: 0.5 });

  // Clamped to [0, sourceDuration - durationSec]: the clip can never point at
  // audio that is not there.
  assert.equal(slip(c, -50).offsetIntoSource, 0);
  assert.equal(slip(c, 50).offsetIntoSource, 7);
  assert.equal(slip(c, 6).offsetIntoSource, 7);

  // A source no longer than the clip cannot slip at all.
  const tight = clip({ durationSec: 5, offsetIntoSource: 0, sourceDuration: 5 });
  assert.deepEqual(slip(tight, 2), { startSec: 4, durationSec: 5, offsetIntoSource: 0 });
  assert.deepEqual(slip(tight, -2), { startSec: 4, durationSec: 5, offsetIntoSource: 0 });
  const short = clip({ durationSec: 6, offsetIntoSource: 0.4, sourceDuration: 5 });
  assert.equal(slip(short, 2).offsetIntoSource, 0.4);
  assert.equal(slip(short, -2).offsetIntoSource, 0.4);

  // A zero drag is a no-op.
  assert.deepEqual(slip(c, 0), { startSec: 4, durationSec: 3, offsetIntoSource: 1 });
}

// ── 4. Snapping is the caller's ─────────────────────────────────────────────
{
  const toHalf = (s: number) => Math.round(s * 2) / 2;
  const c = clip({ startSec: 4, durationSec: 3, offsetIntoSource: 1, sourceDuration: 20 });

  // move snaps the new start…
  assert.equal(move(c, 1.2).startSec, 5.2);
  assert.equal(move(c, 1.2, toHalf).startSec, 5);
  // …and still cannot go negative once snapped.
  assert.equal(move(c, -4.2, toHalf).startSec, 0);

  // resizeRight snaps the clip's END, so the length follows from it.
  assert.equal(resizeRight(c, 1.2).durationSec, 4.2);
  assert.equal(resizeRight(c, 1.2, toHalf).durationSec, 4);   // end 8.2 -> 8
  assert.equal(resizeRight(c, 0.4, toHalf).durationSec, 3.5); // end 7.4 -> 7.5

  // resizeLeft snaps the new start, and the offset and length follow it so the
  // audio under the clip does not shift.
  assert.deepEqual(resizeLeft(c, 1.2, toHalf), { startSec: 5, durationSec: 2, offsetIntoSource: 2 });
  assert.deepEqual(resizeLeft(c, -0.8, toHalf), { startSec: 3, durationSec: 4, offsetIntoSource: 0 });
  // A snap that would leave less than the minimum is refused like any other.
  assert.equal(resizeLeft(c, 2.8, toHalf), null); // start 6.8 -> 7, leaves 0 s
}

// ── 5. A stretched clip: one view, one conversion ───────────────────────────
// At rate `r` a clip eats `r` seconds of source per second of timeline, so the
// gestures are handed a view in which the read offset and the source length
// are TIMELINE seconds too. Every conversion lives in `toTimelineView` /
// `fromTimelineOffset`, so the three gestures cannot disagree about units.
{
  const stretched: DragClip = { startSec: 4, durationSec: 3, offsetIntoSource: 2, sourceDuration: 10 };
  assert.deepEqual(toTimelineView(stretched, 2), {
    startSec: 4, durationSec: 3, offsetIntoSource: 1, sourceDuration: 5,
  });
  assert.equal(fromTimelineOffset(1, 2), 2, 'and the offset converts back');

  // Rate 1 is the identity, so every number the trims produced before the
  // stretch existed is unchanged.
  const plain = clip();
  assert.deepEqual(toTimelineView(plain, 1), plain);
  assert.equal(fromTimelineOffset(plain.offsetIntoSource, 1), plain.offsetIntoSource);
  for (const dx of [-3, -1, -0.05, 0, 0.05, 1, 3, 40]) {
    const view = toTimelineView(plain, 1);
    assert.deepEqual(resizeLeft(view, dx), resizeLeft(plain, dx), `identity resizeLeft dx=${dx}`);
    assert.deepEqual(resizeRight(view, dx), resizeRight(plain, dx), `identity resizeRight dx=${dx}`);
    assert.deepEqual(slip(view, dx), slip(plain, dx), `identity slip dx=${dx}`);
  }

  // A 1 s left-trim of a rate-2 clip takes 2 s of SOURCE off the head…
  const trimmed = resizeLeft(toTimelineView(stretched, 2), 1);
  assert.ok(trimmed, 'the trim is allowed');
  const trimmedOffset = fromTimelineOffset(trimmed.offsetIntoSource, 2);
  assert.equal(trimmedOffset, 4, 'offsetIntoSource advances by 2 s of source');
  assert.equal(trimmed.startSec, 5);
  assert.equal(trimmed.durationSec, 2);
  // …and the clip still ends at the same point in the source: the trim took
  // audio off the head, it did not re-point the clip somewhere else.
  assert.equal(
    trimmedOffset + trimmed.durationSec * 2,
    stretched.offsetIntoSource + stretched.durationSec * 2,
    'the source span the clip covers keeps its end',
  );

  // The right edge cannot claim more timeline than the leftover source fills:
  // 8 s of source after the offset, at rate 2, is 4 s of timeline.
  assert.equal(resizeRight(toTimelineView(stretched, 2), 50).durationSec, 4);

  // Slip is measured and clamped in the same timeline view, then converted
  // back once, instead of doing its own arithmetic.
  const slipped = slip(toTimelineView(stretched, 2), 1);
  assert.equal(fromTimelineOffset(slipped.offsetIntoSource, 2), 4);
  assert.equal(
    fromTimelineOffset(slip(toTimelineView(stretched, 2), 50).offsetIntoSource, 2),
    4,
    'clamped to the source the clip does not already cover',
  );
  assert.equal(fromTimelineOffset(slip(toTimelineView(stretched, 2), -50).offsetIntoSource, 2), 0);
}

console.log('clipDragMath: ok');
