import assert from 'node:assert/strict';
import {
  type ArrangementSelection,
  type TimeRange,
  combineMarquee,
  contextAt,
  makeRange,
  marqueeModeFor,
  normalizeRect,
  rangeContains,
  rangeDurationSec,
  rangesEqual,
  rectsIntersect,
  reduceSelection,
} from './timeSelection';

const ALL = { kind: 'all-tracks' } as const;

// makeRange
{
  // Default scope is all tracks; a/b are ordered.
  assert.deepEqual(makeRange(1, 3), { startSec: 1, endSec: 3, scope: ALL });
  assert.deepEqual(makeRange(3, 1), { startSec: 1, endSec: 3, scope: ALL });
  // Start clamps to 0.
  assert.deepEqual(makeRange(-2, 4), { startSec: 0, endSec: 4, scope: ALL });
  // Entirely negative collapses to empty.
  assert.equal(makeRange(-5, -1), null);
  // Empty / sub-epsilon ranges are null.
  assert.equal(makeRange(2, 2), null);
  assert.equal(makeRange(2, 2 + 1e-7), null);
  assert.notEqual(makeRange(2, 2 + 1e-5), null);
  // Explicit scope is kept.
  const scoped = makeRange(0, 1, { kind: 'tracks', ids: ['a'] });
  assert.deepEqual(scoped?.scope, { kind: 'tracks', ids: ['a'] });
  // Non-finite input throws.
  assert.throws(() => makeRange(Number.NaN, 1), RangeError);
  assert.throws(() => makeRange(0, Number.POSITIVE_INFINITY), RangeError);
}

// rangeContains / rangeDurationSec / rangesEqual
{
  const r = makeRange(1, 3) as TimeRange;
  assert.equal(rangeDurationSec(r), 2);
  // Half-open [start, end).
  assert.equal(rangeContains(r, 1, 't1'), true);
  assert.equal(rangeContains(r, 2.999, 't1'), true);
  assert.equal(rangeContains(r, 3, 't1'), false);
  assert.equal(rangeContains(r, 0.999, 't1'), false);
  assert.equal(rangeContains(null, 2, 't1'), false);
  assert.throws(() => rangeContains(r, Number.NaN, 't1'), RangeError);

  // Scope filtering; a null track id (header/ruler) ignores scope.
  const s = makeRange(1, 3, { kind: 'tracks', ids: ['a', 'b'] }) as TimeRange;
  assert.equal(rangeContains(s, 2, 'a'), true);
  assert.equal(rangeContains(s, 2, 'b'), true);
  assert.equal(rangeContains(s, 2, 'c'), false);
  assert.equal(rangeContains(s, 2, null), true);
  assert.equal(rangeContains(s, 3, null), false);

  assert.equal(rangesEqual(null, null), true);
  assert.equal(rangesEqual(r, null), false);
  assert.equal(rangesEqual(null, r), false);
  assert.equal(rangesEqual(r, makeRange(3, 1)), true);
  assert.equal(rangesEqual(r, makeRange(1, 4)), false);
  assert.equal(rangesEqual(r, s), false);
  assert.equal(rangesEqual(s, makeRange(1, 3, { kind: 'tracks', ids: ['b', 'a'] })), true);
  assert.equal(rangesEqual(s, makeRange(1, 3, { kind: 'tracks', ids: ['a'] })), false);
}

// reduceSelection
{
  const range = makeRange(1, 2) as TimeRange;
  const both: ArrangementSelection = { clipIds: ['c1', 'c2'], range };
  const none: ArrangementSelection = { clipIds: [], range: null };
  const onlyRange: ArrangementSelection = { clipIds: [], range };
  const onlyClips: ArrangementSelection = { clipIds: ['c1'], range: null };

  // Every no-op event returns the SAME object.
  for (const s of [both, none, onlyRange, onlyClips]) {
    assert.equal(reduceSelection(s, { type: 'focus-change' }), s);
    assert.equal(reduceSelection(s, { type: 'menu-open' }), s);
    assert.equal(reduceSelection(s, { type: 'menu-close' }), s);
    assert.equal(reduceSelection(s, { type: 'tab-switch' }), s);
    assert.equal(reduceSelection(s, { type: 'escape', gestureActive: true, menuOpen: false }), s);
    assert.equal(reduceSelection(s, { type: 'escape', gestureActive: false, menuOpen: true }), s);
  }
  assert.equal(reduceSelection(none, { type: 'escape', gestureActive: false, menuOpen: false }), none);
  assert.equal(reduceSelection(none, { type: 'clear-range' }), none);
  assert.equal(reduceSelection(none, { type: 'clear-clips' }), none);
  assert.equal(reduceSelection(onlyRange, { type: 'empty-click' }), onlyRange);
  assert.equal(reduceSelection(both, { type: 'set-range', range: makeRange(2, 1) }), both);
  assert.equal(reduceSelection(both, { type: 'set-clips', ids: ['c1', 'c2', 'c1'] }), both);

  // empty-click is the CLIP half of an empty-lane click: it clears clips and
  // leaves the range alone. Whether the click also clears the range is
  // highlightClearDecision's call (it does, whenever the click was outside it).
  assert.deepEqual(reduceSelection(both, { type: 'empty-click' }), { clipIds: [], range });
  assert.equal(reduceSelection(both, { type: 'empty-click' }).range, range);

  // Escape precedence: clips first, then range.
  const esc = { type: 'escape', gestureActive: false, menuOpen: false } as const;
  const afterOne = reduceSelection(both, esc);
  assert.deepEqual(afterOne, { clipIds: [], range });
  const afterTwo = reduceSelection(afterOne, esc);
  assert.deepEqual(afterTwo, { clipIds: [], range: null });
  assert.equal(reduceSelection(afterTwo, esc), afterTwo);

  // set / clear.
  assert.deepEqual(reduceSelection(none, { type: 'set-range', range }), { clipIds: [], range });
  assert.deepEqual(reduceSelection(both, { type: 'clear-range' }), { clipIds: ['c1', 'c2'], range: null });
  assert.deepEqual(reduceSelection(both, { type: 'clear-clips' }), { clipIds: [], range });
  assert.deepEqual(reduceSelection(both, { type: 'set-range', range: null }), {
    clipIds: ['c1', 'c2'],
    range: null,
  });
  // set-clips dedupes and keeps first-seen order.
  assert.deepEqual(reduceSelection(none, { type: 'set-clips', ids: ['b', 'a', 'b', 'c', 'a'] }).clipIds, [
    'b',
    'a',
    'c',
  ]);
  // Input is not mutated.
  assert.deepEqual(both, { clipIds: ['c1', 'c2'], range });
}

// marquee
{
  const no = { shiftKey: false, ctrlKey: false, metaKey: false, altKey: false };
  assert.equal(marqueeModeFor(no), 'replace');
  assert.equal(marqueeModeFor({ ...no, shiftKey: true }), 'add');
  assert.equal(marqueeModeFor({ ...no, ctrlKey: true }), 'toggle');
  assert.equal(marqueeModeFor({ ...no, metaKey: true }), 'toggle');
  assert.equal(marqueeModeFor({ ...no, altKey: true }), 'subtract');

  const base = ['a', 'b', 'c'];
  assert.deepEqual(combineMarquee(base, ['d', 'b', 'd'], 'replace'), ['d', 'b']);
  assert.deepEqual(combineMarquee(base, ['d', 'b', 'e'], 'add'), ['a', 'b', 'c', 'd', 'e']);
  assert.deepEqual(combineMarquee(base, ['b', 'z'], 'subtract'), ['a', 'c']);
  assert.deepEqual(combineMarquee(base, ['b', 'd', 'b'], 'toggle'), ['a', 'c', 'd']);
  assert.deepEqual(combineMarquee(['a', 'a'], [], 'add'), ['a']);

  // Re-applying identical hits from the same baseline is stable (no toggle flicker).
  for (const mode of ['replace', 'add', 'subtract', 'toggle'] as const) {
    const first = combineMarquee(base, ['b', 'd'], mode);
    const second = combineMarquee(base, ['b', 'd'], mode);
    assert.deepEqual(second, first);
  }
  assert.deepEqual(combineMarquee(base, ['b', 'd'], 'toggle'), ['a', 'c', 'd']);
  // Baseline is not mutated.
  assert.deepEqual(base, ['a', 'b', 'c']);
}

// rects
{
  assert.deepEqual(normalizeRect({ x1: 10, y1: 8, x2: 2, y2: 4 }), { x1: 2, y1: 4, x2: 10, y2: 8 });
  assert.throws(() => normalizeRect({ x1: Number.NaN, y1: 0, x2: 1, y2: 1 }), RangeError);

  const a = { x1: 0, y1: 0, x2: 10, y2: 10 };
  assert.equal(rectsIntersect(a, { x1: 5, y1: 5, x2: 15, y2: 15 }), true);
  // Reversed corners still intersect.
  assert.equal(rectsIntersect(a, { x1: 15, y1: 15, x2: 5, y2: 5 }), true);
  // Touching edges do not.
  assert.equal(rectsIntersect(a, { x1: 10, y1: 0, x2: 20, y2: 10 }), false);
  assert.equal(rectsIntersect(a, { x1: 0, y1: 10, x2: 10, y2: 20 }), false);
  assert.equal(rectsIntersect(a, { x1: 11, y1: 0, x2: 20, y2: 10 }), false);
  // Zero-area rects never intersect.
  assert.equal(rectsIntersect(a, { x1: 5, y1: 5, x2: 5, y2: 5 }), false);
}

// contextAt
{
  const range = makeRange(2, 4, { kind: 'tracks', ids: ['t1'] }) as TimeRange;
  const sel: ArrangementSelection = { clipIds: ['c1', 'c2'], range };

  // Control wins over everything.
  assert.deepEqual(contextAt(sel, { trackId: 't1', sec: 3, clipId: 'c1', onControl: true }), { kind: 'control' });
  // Inside the range: time-range, carrying the hit clip.
  assert.deepEqual(contextAt(sel, { trackId: 't1', sec: 3, clipId: 'c9' }), {
    kind: 'time-range',
    range,
    clipId: 'c9',
  });
  assert.deepEqual(contextAt(sel, { trackId: 't1', sec: 3 }), { kind: 'time-range', range });
  assert.deepEqual(contextAt(sel, { trackId: null, sec: 3 }), { kind: 'time-range', range });
  // Out of scope / at the end: falls through to clips.
  assert.deepEqual(contextAt(sel, { trackId: 't2', sec: 3, clipId: 'c1' }), { kind: 'clips', ids: ['c1', 'c2'] });
  assert.deepEqual(contextAt(sel, { trackId: 't1', sec: 4, clipId: 'c7' }), { kind: 'clips', ids: ['c7'] });
  // Track header.
  assert.deepEqual(contextAt(sel, { trackId: 't2', sec: 3, onTrackHeader: true }), { kind: 'track', trackId: 't2' });
  // Header without a track, or plain empty space: empty.
  assert.deepEqual(contextAt(sel, { trackId: null, sec: 9, onTrackHeader: true }), {
    kind: 'empty',
    trackId: null,
    sec: 9,
  });
  assert.deepEqual(contextAt(sel, { trackId: 't2', sec: 9 }), { kind: 'empty', trackId: 't2', sec: 9 });
  // No range at all.
  assert.deepEqual(contextAt({ clipIds: [], range: null }, { trackId: 't1', sec: 3 }), {
    kind: 'empty',
    trackId: 't1',
    sec: 3,
  });
  assert.throws(() => contextAt(sel, { trackId: 't1', sec: Number.NaN }), RangeError);
}

console.log('timeSelection: ok');
