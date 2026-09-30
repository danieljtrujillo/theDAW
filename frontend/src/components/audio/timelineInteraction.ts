/**
 * Pure glue between the EDIT timeline (WaveformEditor) and the batch-11
 * timeline libs: clip hit rects for the marquee, the ruler's click-vs-drag
 * rule, readouts, and the right-click range menu model.
 *
 * DOM-free, React-free, store-free. Units:
 *  - `*Sec` values are seconds on the arrangement timeline;
 *  - rects and row geometry are LOCAL CSS px of the lanes content (x = seconds
 *    times `zoom`, y measured from the top of the first lane);
 *  - `zoom` is px per second;
 *  - ruler press points are client (screen) CSS px, used only for the
 *    zoom-independent drag threshold.
 */
import { makeRange, rangeContains, rectsIntersect, type Rect, type TimeRange } from '../../lib/timeline/timeSelection';
import type { ClickSurface } from '../../lib/timeline/pointerGesture';
import type { Row } from '../../lib/timeline/trackOrder';

/** Vertical inset (local CSS px) between a lane's edges and the clips drawn in it. */
export const CLIP_INSET_PX = 6;
/** splitClipAt refuses a cut closer than this (seconds) to either clip edge. */
export const SPLIT_EDGE_MARGIN_SEC = 0.05;
/** The inpaint mask's minimum length in seconds (same rule as the clip-body drag). */
export const INPAINT_MIN_SEC = 0.1;
/** Screen CSS px a ruler press must travel before it is a drag, not a click. */
export const RULER_DRAG_THRESHOLD_PX = 4;

function finite(v: number, name: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be finite, got ${v}`);
  return v;
}

/** The clip fields hit testing needs. Seconds. */
export interface HitClip {
  id: string;
  trackId: string;
  startSec: number;
  durationSec: number;
}

/** A clip's rectangle in lanes-content local CSS px. */
export interface ClipHitRect {
  id: string;
  trackId: string;
  rect: Rect;
}

/**
 * Model-space rect for every clip whose track is laid out in `rows`, in clip
 * order. No viewport culling: a clip scrolled far offscreen still has a rect,
 * so a marquee that autoscrolls onto it selects it. The rect matches the drawn
 * clip: `[startSec*zoom, row.top+6, (startSec+durationSec)*zoom, row.top+row.height-6]`.
 * Throws RangeError for a non-positive or non-finite `zoom` (px/s) or a clip
 * with non-finite timing.
 */
export function buildClipHitRects(clips: readonly HitClip[], rows: readonly Row[], zoom: number): ClipHitRect[] {
  if (!(finite(zoom, 'zoom') > 0)) throw new RangeError('zoom must be > 0');
  const rowById = new Map(rows.map((r) => [r.id, r]));
  const out: ClipHitRect[] = [];
  for (const c of clips) {
    finite(c.startSec, 'startSec');
    finite(c.durationSec, 'durationSec');
    const row = rowById.get(c.trackId);
    if (!row) continue;
    const y1 = row.top + CLIP_INSET_PX;
    out.push({
      id: c.id,
      trackId: c.trackId,
      rect: {
        x1: c.startSec * zoom,
        y1,
        x2: (c.startSec + c.durationSec) * zoom,
        y2: Math.max(y1, row.top + row.height - CLIP_INSET_PX),
      },
    });
  }
  return out;
}

/** Ids of the clips whose rect strictly overlaps `marquee` (any corner order), in rect order. */
export function hitTestClipRects(rects: readonly ClipHitRect[], marquee: Rect): string[] {
  return rects.filter((r) => rectsIntersect(r.rect, marquee)).map((r) => r.id);
}

/**
 * A ruler press between pointer-down (`origin`) and now (`current`), both
 * client CSS px: 'drag' once the straight-line distance reaches `thresholdPx`
 * (default 4), else 'click'. Throws RangeError on non-finite input or a
 * negative threshold.
 */
export function classifyRulerPress(
  origin: { x: number; y: number },
  current: { x: number; y: number },
  thresholdPx: number = RULER_DRAG_THRESHOLD_PX,
): 'click' | 'drag' {
  finite(origin.x, 'origin.x');
  finite(origin.y, 'origin.y');
  finite(current.x, 'current.x');
  finite(current.y, 'current.y');
  if (finite(thresholdPx, 'thresholdPx') < 0) throw new RangeError('thresholdPx must be >= 0');
  return Math.hypot(current.x - origin.x, current.y - origin.y) >= thresholdPx ? 'drag' : 'click';
}

/**
 * The all-tracks range a ruler drag from `anchorSec` to `currentSec` (seconds)
 * describes, each edge passed through `snap` first (identity when omitted).
 * Null when the snapped edges coincide. Throws RangeError on non-finite input.
 */
export function rulerDragRange(
  anchorSec: number,
  currentSec: number,
  snap: (sec: number) => number = (s) => s,
): TimeRange | null {
  finite(anchorSec, 'anchorSec');
  finite(currentSec, 'currentSec');
  return makeRange(snap(anchorSec), snap(currentSec));
}

/** Seconds as `mm:ss.mmm` (milliseconds truncated; negatives read as 0). Throws RangeError on non-finite. */
export function formatCursorTime(sec: number): string {
  finite(sec, 'sec');
  const total = Math.floor(Math.max(0, sec) * 1000 + 1e-6);
  const ms = total % 1000;
  const s = Math.floor(total / 1000) % 60;
  const m = Math.floor(total / 60000);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/** `start – end · duration` for the ruler band, e.g. `00:01.500 – 00:04.000 · 2.500s`. */
export function formatRangeReadout(r: TimeRange): string {
  return `${formatCursorTime(r.startSec)} – ${formatCursorTime(r.endSec)} · ${(r.endSec - r.startSec).toFixed(3)}s`;
}

function inScope(range: TimeRange, trackId: string): boolean {
  return range.scope.kind === 'all-tracks' || range.scope.ids.includes(trackId);
}

/**
 * The cuts "Split clips at range edges" makes: for every clip on a track in
 * the range's scope, each range edge that falls strictly inside it (more than
 * 50 ms from both clip edges, the rule splitClipAt enforces). Per clip the END
 * edge comes first: splitClipAt keeps the original id on the LEFT piece, which
 * still covers the start edge, so both cuts can name the same id.
 *
 * That first cut shortens the piece the second one lands in, so a range no
 * longer than the margin leaves the start edge within 50 ms of the new right
 * edge — splitClipAt would refuse it and log a cut-too-close error. The start
 * cut is dropped instead, and the range is left cut at its end edge alone.
 */
export function rangeSplitPlan(clips: readonly HitClip[], range: TimeRange): Array<{ clipId: string; atSec: number }> {
  const plan: Array<{ clipId: string; atSec: number }> = [];
  const rangeFitsACut = range.endSec - range.startSec > SPLIT_EDGE_MARGIN_SEC;
  for (const c of clips) {
    if (!inScope(range, c.trackId)) continue;
    let cutAtEnd = false;
    for (const edge of [range.endSec, range.startSec]) {
      const isStartEdge = edge === range.startSec && cutAtEnd;
      if (isStartEdge && !rangeFitsACut) continue;
      const rel = edge - c.startSec;
      if (rel > SPLIT_EDGE_MARGIN_SEC && rel < c.durationSec - SPLIT_EDGE_MARGIN_SEC) {
        plan.push({ clipId: c.id, atSec: edge });
        if (edge === range.endSec) cutAtEnd = true;
      }
    }
  }
  return plan;
}

/** The clip-scoped inpaint mask: `[startSec, endSec)` on one clip. Seconds. */
export interface InpaintMask {
  clipId: string;
  startSec: number;
  endSec: number;
}

/** What a timeline click does to the two highlights. */
export interface HighlightClearDecision {
  clearRange: boolean;
  clearMask: boolean;
}

/**
 * Whether a finished timeline CLICK (press + release under the click slop, not
 * a drag) clears the highlights it lands away from.
 *
 * A highlight is the user's current focus, not a pinned annotation: clicking
 * away from one puts it away. "Away" is per highlight —
 *  - the time range: `clickSec` outside `[startSec, endSec)`, or `clickTrackId`
 *    outside a track-scoped range (a null track id — ruler/header — ignores the
 *    scope, as `rangeContains` defines it);
 *  - the inpaint mask: any other clip (including no clip at all: empty lane,
 *    ruler), or the mask's own clip at a time outside `[startSec, endSec)`.
 *
 * Two surfaces never clear anything, wherever they sit: `surface: 'control'`
 * (clip chrome, track headers, the playhead handle, markers, fade/trim handles,
 * faders, panels) and a `button: 'secondary'` press, which is on its way to a
 * context menu — the range menu's own "Clear range" row is the only way a
 * right-click removes a range.
 *
 * Pure and store-free; the caller decides the click happened and applies the
 * result. Throws RangeError on a non-finite `clickSec`.
 */
export function highlightClearDecision(a: {
  surface: ClickSurface;
  clickSec: number;
  clickTrackId: string | null;
  clickClipId?: string;
  button?: 'primary' | 'secondary';
  range: TimeRange | null;
  mask: InpaintMask | null;
}): HighlightClearDecision {
  finite(a.clickSec, 'clickSec');
  if (a.surface === 'control' || a.button === 'secondary') return { clearRange: false, clearMask: false };
  const insideMask =
    a.mask !== null &&
    a.clickClipId === a.mask.clipId &&
    a.clickSec >= a.mask.startSec &&
    a.clickSec < a.mask.endSec;
  return {
    clearRange: a.range !== null && !rangeContains(a.range, a.clickSec, a.clickTrackId),
    clearMask: a.mask !== null && !insideMask,
  };
}

/** A clip as the range menu sees it: timing plus whether it is a MIDI (piano-roll) clip. */
export interface RangeMenuClip extends HitClip {
  midi: boolean;
}

export type InpaintFromRange =
  | { ok: true; selection: { clipId: string; startSec: number; endSec: number } }
  | { ok: false; reason: string };

/**
 * "Copy range to inpaint": the range clamped to the ONE non-MIDI clip on
 * `trackId` that overlaps it. Anything else (no track, track out of scope, no
 * audio clip, several, or less than 0.1 s of overlap) returns the reason the
 * menu row shows.
 */
export function inpaintFromRange(
  clips: readonly RangeMenuClip[],
  range: TimeRange,
  trackId: string | null,
): InpaintFromRange {
  if (trackId === null) return { ok: false, reason: 'Right-click on a track lane to pick the clip' };
  if (!inScope(range, trackId)) return { ok: false, reason: 'This track is outside the range' };
  const under = clips.filter(
    (c) => c.trackId === trackId && !c.midi && c.startSec < range.endSec && c.startSec + c.durationSec > range.startSec,
  );
  if (under.length === 0) return { ok: false, reason: 'No audio clip on this track is under the range' };
  if (under.length > 1) return { ok: false, reason: 'More than one clip on this track is under the range' };
  const clip = under[0];
  const startSec = Math.max(range.startSec, clip.startSec);
  const endSec = Math.min(range.endSec, clip.startSec + clip.durationSec);
  if (endSec - startSec < INPAINT_MIN_SEC) return { ok: false, reason: 'Less than 0.1 s of the clip is under the range' };
  return { ok: true, selection: { clipId: clip.id, startSec, endSec } };
}

export type RangeMenuAction =
  | 'play'
  | 'loop'
  | 'zoom'
  | 'split'
  | 'copy-to-inpaint'
  | 'clip-actions'
  | 'render'
  | 'send-assistant'
  | 'clear';

/** One row of the range menu. A disabled row always carries the reason it shows. */
export interface RangeMenuEntry {
  action: RangeMenuAction;
  label: string;
  enabled: boolean;
  reason?: string;
}

function row(action: RangeMenuAction, label: string, reason?: string): RangeMenuEntry {
  return reason === undefined ? { action, label, enabled: true } : { action, label, enabled: false, reason };
}

/**
 * The rows of the menu a right-click inside the time range opens, in display
 * order. `trackId` is the lane under the pointer (null = none); `clipId` the
 * clip under it, which adds "Clip actions…" to reach that clip's own menu.
 */
export function buildRangeMenu(a: {
  range: TimeRange;
  clips: readonly RangeMenuClip[];
  trackId: string | null;
  clipId?: string;
}): RangeMenuEntry[] {
  const inpaint = inpaintFromRange(a.clips, a.range, a.trackId);
  const entries: RangeMenuEntry[] = [
    row('play', 'Play selection'),
    row('loop', 'Loop selection'),
    row('zoom', 'Zoom to selection'),
    row(
      'split',
      'Split clips at range edges',
      rangeSplitPlan(a.clips, a.range).length === 0 ? 'No clip in range crosses an edge' : undefined,
    ),
    row('copy-to-inpaint', 'Copy range to inpaint', inpaint.ok === false ? inpaint.reason : undefined),
  ];
  if (a.clipId !== undefined) entries.push(row('clip-actions', 'Clip actions…'));
  entries.push(
    // F24-7: a range render is the full mix over the time span, not a
    // per-track bounce, so it never depends on trackId/clipId — only on
    // whether the range covers any time at all.
    row('render', 'Render range…', a.range.endSec <= a.range.startSec ? 'The time range is empty' : undefined),
    // Live: the menu only exists while a range does, so `referenceForTimeSelection()`
    // always has a span to describe and the row never needs a reason.
    row('send-assistant', 'Send range to gantasmob0t'),
    row('clear', 'Clear range'),
  );
  return entries;
}
