/**
 * Arrangement time selection, marquee combination and right-click context
 * precedence. Pure: no DOM, no React, no store.
 *
 * A time range is the user's current focus, not a pinned annotation: a click
 * away from it puts it away. That rule lives in `highlightClearDecision`
 * (components/audio/timelineInteraction.ts), which needs the surface and the
 * clip under the pointer; the events here only say what to do once it is made.
 *
 * Units: every `*Sec` value is seconds on the arrangement timeline. `Rect`
 * coordinates are local CSS px of whatever surface the caller measures in.
 */

/** Which tracks a time range applies to. */
export type TrackScope = { kind: 'all-tracks' } | { kind: 'tracks'; ids: readonly string[] };

/** A half-open time range `[startSec, endSec)` in seconds, limited to `scope`. */
export interface TimeRange {
  startSec: number;
  endSec: number;
  scope: TrackScope;
}

/** Ranges shorter than this (seconds) are treated as empty. */
const MIN_RANGE_SEC = 1e-6;

function finite(v: number, name: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be finite, got ${v}`);
  return v;
}

/**
 * Build a range from two edges in seconds, in either order. The start clamps
 * to 0. Returns null when the result is shorter than 1e-6 s. Throws RangeError
 * on non-finite input. The scope defaults to all tracks.
 */
export function makeRange(aSec: number, bSec: number, scope?: TrackScope): TimeRange | null {
  finite(aSec, 'aSec');
  finite(bSec, 'bSec');
  const startSec = Math.max(0, Math.min(aSec, bSec));
  const endSec = Math.max(aSec, bSec);
  if (endSec - startSec < MIN_RANGE_SEC) return null;
  return { startSec, endSec, scope: scope ?? { kind: 'all-tracks' } };
}

/**
 * True when `sec` (seconds) lies in the half-open range and `trackId` is in its
 * scope. A null `trackId` (track header area / ruler) ignores the scope.
 * Throws RangeError on a non-finite `sec`.
 */
export function rangeContains(range: TimeRange | null, sec: number, trackId: string | null): boolean {
  finite(sec, 'sec');
  if (range === null) return false;
  if (sec < range.startSec || sec >= range.endSec) return false;
  if (trackId === null || range.scope.kind === 'all-tracks') return true;
  return range.scope.ids.includes(trackId);
}

/** Length of the range in seconds. */
export function rangeDurationSec(r: TimeRange): number {
  return r.endSec - r.startSec;
}

function scopesEqual(a: TrackScope, b: TrackScope): boolean {
  if (a.kind === 'all-tracks' || b.kind === 'all-tracks') return a.kind === b.kind;
  const sa = new Set(a.ids);
  const sb = new Set(b.ids);
  if (sa.size !== sb.size) return false;
  for (const id of sa) if (!sb.has(id)) return false;
  return true;
}

/**
 * Structural equality: same edges (exact) and same scope. Track id order and
 * duplicates in a `tracks` scope do not matter. Two nulls are equal.
 */
export function rangesEqual(a: TimeRange | null, b: TimeRange | null): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return a.startSec === b.startSec && a.endSec === b.endSec && scopesEqual(a.scope, b.scope);
}

/** The arrangement's selection: selected clips plus an independent time range. */
export interface ArrangementSelection {
  clipIds: readonly string[];
  range: TimeRange | null;
}

export type SelectionEvent =
  | { type: 'set-range'; range: TimeRange | null }
  | { type: 'clear-range' }
  | { type: 'set-clips'; ids: readonly string[] }
  | { type: 'clear-clips' }
  | { type: 'focus-change' }
  | { type: 'menu-open' }
  | { type: 'menu-close' }
  | { type: 'tab-switch' }
  | { type: 'empty-click' }
  | { type: 'escape'; gestureActive: boolean; menuOpen: boolean };

function dedupe(ids: readonly string[]): string[] {
  return [...new Set(ids)];
}

function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Apply one selection event. Returns the SAME object whenever nothing changes,
 * so callers can skip store writes by reference comparison.
 *
 * - focus-change / menu-open / menu-close / tab-switch never change selection.
 * - empty-click is the CLIP half of an empty-lane click: it clears clips and
 *   leaves the range to the caller. That is not "the range survives a click" —
 *   the caller clears it too whenever the click landed outside it
 *   (`highlightClearDecision`); it is kept here so a click INSIDE a range can
 *   drop the clip selection without taking the range with it.
 * - escape is ignored while a menu is open or a gesture is active; otherwise it
 *   clears clips first, then (on a later press) the range.
 */
export function reduceSelection(s: ArrangementSelection, e: SelectionEvent): ArrangementSelection {
  switch (e.type) {
    case 'focus-change':
    case 'menu-open':
    case 'menu-close':
    case 'tab-switch':
      return s;
    case 'set-range':
      return rangesEqual(s.range, e.range) ? s : { ...s, range: e.range };
    case 'clear-range':
      return s.range === null ? s : { ...s, range: null };
    case 'set-clips': {
      const ids = dedupe(e.ids);
      return sameIds(ids, s.clipIds) ? s : { ...s, clipIds: ids };
    }
    case 'clear-clips':
    case 'empty-click':
      return s.clipIds.length === 0 ? s : { ...s, clipIds: [] };
    case 'escape':
      if (e.menuOpen || e.gestureActive) return s;
      if (s.clipIds.length > 0) return { ...s, clipIds: [] };
      if (s.range !== null) return { ...s, range: null };
      return s;
  }
}

export type MarqueeMode = 'replace' | 'add' | 'subtract' | 'toggle';

/** Modifier keys to marquee mode: shift adds, ctrl/meta toggles, alt subtracts, none replaces. */
export function marqueeModeFor(m: {
  shiftKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}): MarqueeMode {
  if (m.shiftKey) return 'add';
  if (m.ctrlKey || m.metaKey) return 'toggle';
  if (m.altKey) return 'subtract';
  return 'replace';
}

/**
 * Combine marquee hits with the selection captured at pointerdown. Always pass
 * that BASELINE, never the previous pointermove result, or toggle mode would
 * flicker. Output order: baseline order (minus removed ids), then new hits in
 * hit order; no duplicates.
 */
export function combineMarquee(
  baselineIds: readonly string[],
  hitIds: readonly string[],
  mode: MarqueeMode,
): string[] {
  const result = new Set(mode === 'replace' ? [] : baselineIds);
  for (const id of new Set(hitIds)) {
    if (mode === 'subtract') result.delete(id);
    else if (mode === 'toggle' && result.has(id)) result.delete(id);
    else result.add(id);
  }
  return [...result];
}

/** Axis-aligned rectangle by two corners, in local CSS px. Corners may be in any order. */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** Reorder corners so x1 <= x2 and y1 <= y2. Throws RangeError on non-finite input. */
export function normalizeRect(r: Rect): Rect {
  finite(r.x1, 'x1');
  finite(r.y1, 'y1');
  finite(r.x2, 'x2');
  finite(r.y2, 'y2');
  return {
    x1: Math.min(r.x1, r.x2),
    y1: Math.min(r.y1, r.y2),
    x2: Math.max(r.x1, r.x2),
    y2: Math.max(r.y1, r.y2),
  };
}

/**
 * Strict overlap of two rects (any corner order). Touching edges do not count,
 * and a zero-width or zero-height rect never intersects anything.
 */
export function rectsIntersect(a: Rect, b: Rect): boolean {
  const p = normalizeRect(a);
  const q = normalizeRect(b);
  if (p.x1 === p.x2 || p.y1 === p.y2 || q.x1 === q.x2 || q.y1 === q.y2) return false;
  return p.x1 < q.x2 && q.x1 < p.x2 && p.y1 < q.y2 && q.y1 < p.y2;
}

export type MenuContext =
  | { kind: 'control' }
  | { kind: 'time-range'; range: TimeRange; clipId?: string }
  | { kind: 'clips'; ids: readonly string[] }
  | { kind: 'track'; trackId: string }
  | { kind: 'empty'; trackId: string | null; sec: number };

/**
 * Which context menu a right-click at `hit` opens. `hit.sec` is seconds;
 * `trackId` null means the ruler/header area. Precedence:
 * control > time range (containing the point) > clips > track header > empty.
 * A hit clip that is already selected yields the whole clip selection.
 * Throws RangeError on a non-finite `sec`.
 */
export function contextAt(
  sel: ArrangementSelection,
  hit: { trackId: string | null; sec: number; clipId?: string; onControl?: boolean; onTrackHeader?: boolean },
): MenuContext {
  finite(hit.sec, 'sec');
  if (hit.onControl) return { kind: 'control' };
  if (sel.range !== null && rangeContains(sel.range, hit.sec, hit.trackId)) {
    return hit.clipId !== undefined
      ? { kind: 'time-range', range: sel.range, clipId: hit.clipId }
      : { kind: 'time-range', range: sel.range };
  }
  if (hit.clipId !== undefined) {
    return { kind: 'clips', ids: sel.clipIds.includes(hit.clipId) ? sel.clipIds : [hit.clipId] };
  }
  if (hit.onTrackHeader && hit.trackId !== null) return { kind: 'track', trackId: hit.trackId };
  return { kind: 'empty', trackId: hit.trackId, sec: hit.sec };
}
