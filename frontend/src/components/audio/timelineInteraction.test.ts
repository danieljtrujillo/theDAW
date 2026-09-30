import assert from 'node:assert/strict';
import { layoutRows } from '../../lib/timeline/trackOrder';
import type { TimeRange } from '../../lib/timeline/timeSelection';
import {
  CLIP_INSET_PX,
  buildClipHitRects,
  buildRangeMenu,
  classifyRulerPress,
  formatCursorTime,
  formatRangeReadout,
  highlightClearDecision,
  hitTestClipRects,
  inpaintFromRange,
  rangeSplitPlan,
  rulerDragRange,
  type RangeMenuClip,
} from './timelineInteraction';

const H = 100;
const rows = layoutRows([{ id: 't1', height: H }, { id: 't2', height: H }, { id: 't3', height: H }]);

// --- Hit rects: model space from store data, never the DOM -----------------
{
  const clips = [
    { id: 'a', trackId: 't1', startSec: 1, durationSec: 2 },
    { id: 'b', trackId: 't3', startSec: 0.5, durationSec: 1 },
    // Far offscreen (a 10-minute timeline at 50 px/s): still a rect.
    { id: 'far', trackId: 't2', startSec: 600, durationSec: 4 },
    // A clip on a track that is not laid out has no rect.
    { id: 'ghost', trackId: 'gone', startSec: 0, durationSec: 1 },
  ];
  const rects = buildClipHitRects(clips, rows, 50);
  assert.deepEqual(rects.map((r) => r.id), ['a', 'b', 'far']);
  assert.equal(CLIP_INSET_PX, 6);
  assert.deepEqual(rects[0], { id: 'a', trackId: 't1', rect: { x1: 50, y1: 6, x2: 150, y2: 94 } });
  assert.deepEqual(rects[1].rect, { x1: 25, y1: 206, x2: 75, y2: 294 });
  assert.deepEqual(rects[2].rect, { x1: 30000, y1: 106, x2: 30200, y2: 194 });

  // The marquee picks clips across tracks; offscreen ones are found too.
  assert.deepEqual(hitTestClipRects(rects, { x1: 60, y1: 50, x2: 40, y2: 250 }), ['a', 'b']);
  assert.deepEqual(hitTestClipRects(rects, { x1: 29000, y1: 0, x2: 31000, y2: 300 }), ['far']);
  // The lane gutter between clips (inset band) is not a clip.
  assert.deepEqual(hitTestClipRects(rects, { x1: 60, y1: 95, x2: 140, y2: 105 }), []);
  // A zero-area marquee hits nothing.
  assert.deepEqual(hitTestClipRects(rects, { x1: 60, y1: 50, x2: 60, y2: 50 }), []);

  assert.throws(() => buildClipHitRects(clips, rows, 0), RangeError);
  assert.throws(() => buildClipHitRects(clips, rows, Number.NaN), RangeError);
  assert.throws(
    () => buildClipHitRects([{ id: 'x', trackId: 't1', startSec: Number.POSITIVE_INFINITY, durationSec: 1 }], rows, 10),
    RangeError,
  );
}

// --- Ruler press: click vs drag --------------------------------------------
{
  assert.equal(classifyRulerPress({ x: 10, y: 10 }, { x: 10, y: 10 }), 'click');
  assert.equal(classifyRulerPress({ x: 10, y: 10 }, { x: 13, y: 12 }), 'click'); // 3.6 px
  assert.equal(classifyRulerPress({ x: 10, y: 10 }, { x: 14, y: 10 }), 'drag'); // exactly 4 px
  assert.equal(classifyRulerPress({ x: 10, y: 10 }, { x: 0, y: 10 }), 'drag');
  assert.equal(classifyRulerPress({ x: 0, y: 0 }, { x: 5, y: 0 }, 8), 'click');
  assert.throws(() => classifyRulerPress({ x: Number.NaN, y: 0 }, { x: 0, y: 0 }), RangeError);
  assert.throws(() => classifyRulerPress({ x: 0, y: 0 }, { x: 0, y: 0 }, -1), RangeError);

  // Drag range: either direction, snapped edges, all tracks.
  assert.deepEqual(rulerDragRange(3, 1), { startSec: 1, endSec: 3, scope: { kind: 'all-tracks' } });
  const snap = (s: number) => Math.round(s * 2) / 2;
  assert.deepEqual(rulerDragRange(1.1, 2.8, snap), { startSec: 1, endSec: 3, scope: { kind: 'all-tracks' } });
  // Snapping both edges onto one grid line is no range at all.
  assert.equal(rulerDragRange(1.1, 1.2, snap), null);
  assert.throws(() => rulerDragRange(Number.NaN, 1), RangeError);
}

// --- Readouts --------------------------------------------------------------
{
  assert.equal(formatCursorTime(0), '00:00.000');
  assert.equal(formatCursorTime(61.2345), '01:01.234');
  assert.equal(formatCursorTime(3599.9999), '59:59.999');
  assert.equal(formatCursorTime(-2), '00:00.000');
  assert.throws(() => formatCursorTime(Number.NaN), RangeError);
  const r: TimeRange = { startSec: 1.5, endSec: 4, scope: { kind: 'all-tracks' } };
  assert.equal(formatRangeReadout(r), '00:01.500 – 00:04.000 · 2.500s');
}

// --- Split plan ------------------------------------------------------------
{
  const range: TimeRange = { startSec: 2, endSec: 5, scope: { kind: 'all-tracks' } };
  const clips = [
    { id: 'spans', trackId: 't1', startSec: 0, durationSec: 10 }, // both edges inside
    { id: 'head', trackId: 't2', startSec: 1, durationSec: 2 }, // only the start edge (2) inside
    { id: 'tail', trackId: 't3', startSec: 4, durationSec: 3 }, // only the end edge (5) inside
    { id: 'inside', trackId: 't1', startSec: 2.5, durationSec: 1 }, // no edge inside
    { id: 'kiss', trackId: 't2', startSec: 4.97, durationSec: 2 }, // end edge within 50 ms of the head
  ];
  // End edge first, then start edge, on the same id: the left piece keeps the id
  // and still covers the start edge after the first cut.
  assert.deepEqual(rangeSplitPlan(clips, range), [
    { clipId: 'spans', atSec: 5 },
    { clipId: 'spans', atSec: 2 },
    { clipId: 'head', atSec: 2 },
    { clipId: 'tail', atSec: 5 },
  ]);
  const scoped: TimeRange = { ...range, scope: { kind: 'tracks', ids: ['t3'] } };
  assert.deepEqual(rangeSplitPlan(clips, scoped), [{ clipId: 'tail', atSec: 5 }]);

  // A range no longer than the 50 ms edge margin, wholly inside one clip: the
  // end cut leaves a left piece whose new edge is within the margin of the start
  // cut, so splitClipAt would refuse it. Only the end cut is planned.
  const hair: TimeRange = { startSec: 3, endSec: 3.04, scope: { kind: 'all-tracks' } };
  assert.deepEqual(rangeSplitPlan([clips[0]], hair), [{ clipId: 'spans', atSec: 3.04 }]);
  // Exactly the margin is still refused; just over it keeps both cuts.
  assert.deepEqual(rangeSplitPlan([clips[0]], { ...hair, endSec: 3.05 }), [{ clipId: 'spans', atSec: 3.05 }]);
  assert.deepEqual(rangeSplitPlan([clips[0]], { ...hair, endSec: 3.06 }), [
    { clipId: 'spans', atSec: 3.06 },
    { clipId: 'spans', atSec: 3 },
  ]);
  // A short range whose end edge is NOT in the clip keeps its start cut: that
  // cut is measured against the untouched clip.
  assert.deepEqual(rangeSplitPlan([{ id: 'head2', trackId: 't1', startSec: 1, durationSec: 2.07 }], hair), [
    { clipId: 'head2', atSec: 3 },
  ]);
}

// --- Copy range to inpaint -------------------------------------------------
{
  const range: TimeRange = { startSec: 2, endSec: 5, scope: { kind: 'all-tracks' } };
  const audio = (id: string, trackId: string, startSec: number, durationSec: number): RangeMenuClip =>
    ({ id, trackId, startSec, durationSec, midi: false });
  const clips: RangeMenuClip[] = [
    audio('a', 't1', 3, 10), // overlaps [3, 5)
    { id: 'm', trackId: 't2', startSec: 0, durationSec: 10, midi: true },
    audio('b1', 't3', 0, 3),
    audio('b2', 't3', 4, 3),
    audio('sliver', 't2', 4.95, 3), // 50 ms under the range: too short to inpaint
  ];
  assert.deepEqual(inpaintFromRange(clips, range, 't1'), { ok: true, selection: { clipId: 'a', startSec: 3, endSec: 5 } });
  assert.deepEqual(inpaintFromRange(clips, range, 't3'), { ok: false, reason: 'More than one clip on this track is under the range' });
  assert.deepEqual(inpaintFromRange(clips, range, 't2'), { ok: false, reason: 'Less than 0.1 s of the clip is under the range' });
  assert.deepEqual(inpaintFromRange([clips[1]], range, 't2'), { ok: false, reason: 'No audio clip on this track is under the range' });
  assert.deepEqual(inpaintFromRange(clips, range, null), { ok: false, reason: 'Right-click on a track lane to pick the clip' });
  const outOfScope: TimeRange = { ...range, scope: { kind: 'tracks', ids: ['t3'] } };
  assert.deepEqual(inpaintFromRange(clips, outOfScope, 't1'), { ok: false, reason: 'This track is outside the range' });
}

// --- Range menu model ------------------------------------------------------
{
  const range: TimeRange = { startSec: 2, endSec: 5, scope: { kind: 'all-tracks' } };
  const clips: RangeMenuClip[] = [{ id: 'a', trackId: 't1', startSec: 0, durationSec: 10, midi: false }];

  const onClip = buildRangeMenu({ range, clips, trackId: 't1', clipId: 'a' });
  assert.deepEqual(onClip.map((e) => e.action), [
    'play', 'loop', 'zoom', 'split', 'copy-to-inpaint', 'clip-actions', 'render', 'send-assistant', 'clear',
  ]);
  const byAction = new Map(onClip.map((e) => [e.action, e]));
  assert.equal(byAction.get('play')?.label, 'Play selection');
  assert.equal(byAction.get('loop')?.label, 'Loop selection');
  assert.equal(byAction.get('zoom')?.label, 'Zoom to selection');
  assert.equal(byAction.get('split')?.label, 'Split clips at range edges');
  assert.equal(byAction.get('copy-to-inpaint')?.label, 'Copy range to inpaint');
  assert.equal(byAction.get('clip-actions')?.label, 'Clip actions…');
  assert.equal(byAction.get('clear')?.label, 'Clear range');
  for (const a of ['play', 'loop', 'zoom', 'split', 'copy-to-inpaint', 'clip-actions', 'clear'] as const) {
    assert.equal(byAction.get(a)?.enabled, true, a);
    assert.equal(byAction.get(a)?.reason, undefined, a);
  }
  // F24-7: the render row is enabled and labelled "Render range…" whenever
  // the range covers more than zero time.
  assert.deepEqual(byAction.get('render'), {
    action: 'render', label: 'Render range…', enabled: true,
  });
  // Live (F17/T43): a menu only exists when a range does, so the reference it
  // would build always has a span — the row never needs a reason.
  assert.deepEqual(byAction.get('send-assistant'), {
    action: 'send-assistant', label: 'Send range to gantasmob0t', enabled: true,
  });

  // No clip under the pointer: no "Clip actions…" row.
  const onLane = buildRangeMenu({ range, clips, trackId: 't2' });
  assert.equal(onLane.some((e) => e.action === 'clip-actions'), false);
  const split = onLane.find((e) => e.action === 'split');
  assert.equal(split?.enabled, true); // clip 'a' on t1 is in scope even though t2 was clicked
  const copy = onLane.find((e) => e.action === 'copy-to-inpaint');
  assert.equal(copy?.enabled, false);
  assert.equal(copy?.reason, 'No audio clip on this track is under the range');

  // Nothing crosses an edge: split is disabled with a reason.
  const empty = buildRangeMenu({ range, clips: [], trackId: 't1' });
  assert.deepEqual(empty.find((e) => e.action === 'split'), {
    action: 'split', label: 'Split clips at range edges', enabled: false,
    reason: 'No clip in range crosses an edge',
  });
}

// --- Render row: zero-length range disables it (F24-7) ---------------------
{
  // A range render is the full mix over the time span — it never depends on
  // the track or clip under the pointer, only on whether the range is empty.
  const clips: RangeMenuClip[] = [{ id: 'a', trackId: 't1', startSec: 0, durationSec: 10, midi: false }];
  const zero: TimeRange = { startSec: 3, endSec: 3, scope: { kind: 'all-tracks' } };
  const menu = buildRangeMenu({ range: zero, clips, trackId: 't1' });
  assert.deepEqual(menu.find((e) => e.action === 'render'), {
    action: 'render', label: 'Render range…', enabled: false,
    reason: 'The time range is empty',
  });
}

// --- highlightClearDecision: a click away from a highlight clears it (T44) --
{
  const range: TimeRange = { startSec: 2, endSec: 4, scope: { kind: 'all-tracks' } };
  const scoped: TimeRange = { startSec: 2, endSec: 4, scope: { kind: 'tracks', ids: ['t1'] } };
  const mask = { clipId: 'a', startSec: 2.5, endSec: 3.5 };

  // Nothing highlighted: nothing to clear, whatever is clicked.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 9, clickTrackId: 't2', range: null, mask: null }),
    { clearRange: false, clearMask: false },
  );

  // 1. Outside the range clears it — empty lane, another clip, the ruler.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 5, clickTrackId: 't2', range, mask: null }),
    { clearRange: true, clearMask: false },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'clip-body', clickSec: 1.5, clickTrackId: 't1', clickClipId: 'b', range, mask: null }),
    { clearRange: true, clearMask: false },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'ruler', clickSec: 6, clickTrackId: null, range, mask: null }),
    { clearRange: true, clearMask: false },
  );
  // A lane outside a track-scoped range is "outside" even at a time inside it.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 3, clickTrackId: 't2', range: scoped, mask: null }),
    { clearRange: true, clearMask: false },
  );

  // 2. Inside the range keeps it (park the edit cursor in a range).
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 3, clickTrackId: 't2', range, mask: null }),
    { clearRange: false, clearMask: false },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'ruler', clickSec: 2, clickTrackId: null, range, mask: null }),
    { clearRange: false, clearMask: false },
  );
  // Half-open [start, end): the end edge is already outside.
  assert.deepEqual(
    highlightClearDecision({ surface: 'ruler', clickSec: 4, clickTrackId: null, range, mask: null }),
    { clearRange: true, clearMask: false },
  );
  // The scoped range holds on its own track.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 3, clickTrackId: 't1', range: scoped, mask: null }),
    { clearRange: false, clearMask: false },
  );

  // The inpaint mask: same clip inside keeps, same clip outside clears,
  // another clip clears, and any surface without a clip clears.
  assert.deepEqual(
    highlightClearDecision({ surface: 'clip-body', clickSec: 3, clickTrackId: 't1', clickClipId: 'a', range: null, mask }),
    { clearRange: false, clearMask: false },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'clip-body', clickSec: 3.8, clickTrackId: 't1', clickClipId: 'a', range: null, mask }),
    { clearRange: false, clearMask: true },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'clip-body', clickSec: 3, clickTrackId: 't2', clickClipId: 'b', range: null, mask }),
    { clearRange: false, clearMask: true },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 3, clickTrackId: 't2', range: null, mask }),
    { clearRange: false, clearMask: true },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'ruler', clickSec: 3, clickTrackId: null, range: null, mask }),
    { clearRange: false, clearMask: true },
  );
  // Half-open [start, end) for the mask too.
  assert.deepEqual(
    highlightClearDecision({ surface: 'clip-body', clickSec: 3.5, clickTrackId: 't1', clickClipId: 'a', range: null, mask }),
    { clearRange: false, clearMask: true },
  );

  // 7. A control never clears anything, wherever it sits.
  assert.deepEqual(
    highlightClearDecision({ surface: 'control', clickSec: 9, clickTrackId: 't2', range, mask }),
    { clearRange: false, clearMask: false },
  );

  // 5. A right-click never clears a highlight, inside or outside.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 9, clickTrackId: 't2', button: 'secondary', range, mask }),
    { clearRange: false, clearMask: false },
  );
  assert.deepEqual(
    highlightClearDecision({ surface: 'clip-body', clickSec: 9, clickTrackId: 't2', clickClipId: 'b', button: 'secondary', range, mask }),
    { clearRange: false, clearMask: false },
  );
  // ...and the default is the primary button.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 9, clickTrackId: 't2', button: 'primary', range, mask }),
    { clearRange: true, clearMask: true },
  );

  // Both highlights at once, one click outside both.
  assert.deepEqual(
    highlightClearDecision({ surface: 'empty-lane', clickSec: 9, clickTrackId: 't2', range, mask }),
    { clearRange: true, clearMask: true },
  );

  assert.throws(
    () => highlightClearDecision({ surface: 'empty-lane', clickSec: Number.NaN, clickTrackId: null, range, mask }),
    RangeError,
  );
}

console.log('timelineInteraction: ok');
