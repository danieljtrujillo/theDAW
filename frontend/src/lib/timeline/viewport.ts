/**
 * Timeline viewport core: marker-anchored zoom, wheel-gesture profiles, and
 * clip-chrome geometry. Pure and DOM-free so every zoom entry point, the wheel
 * handler and the clip-header overlay share one set of rules.
 *
 * Units: times are SECONDS; distances are LOCAL CSS px (the space scrollLeft,
 * clientWidth and style widths live in — divide pointer/viewport px by the
 * cumulative CSS zoom before handing them in). `zoom` is px per second.
 *
 * Adapted from docs/design/repair-pack/repair/src/timelineGeometry.ts; the
 * wheel bindings follow plan decision D1
 * (docs/design/repair-expansion-report-and-plan.md §7).
 */

function finite(n: number, name: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${name} must be finite`);
  return n;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

// --- Zoom --------------------------------------------------------------------

export interface ZoomView {
  /** px per second. */
  zoom: number;
  /** Local px. */
  scrollLeft: number;
  /** Visible width of the scroller, local px. */
  viewportWidth: number;
  /** Length of the timeline content, seconds. */
  contentDurationSec: number;
}

/**
 * Zoom so `markerSec` sits at the horizontal centre of the viewport.
 * The zoom is clamped to `bounds`; scrollLeft is clamped to
 * `[0, contentWidth - viewportWidth]` where
 * `contentWidth = max(contentDurationSec * zoom, viewportWidth)`, so near the
 * start or end of the content the marker cannot be centred, and content
 * shorter than the viewport always yields scrollLeft 0.
 */
export function zoomAtMarker(
  view: ZoomView,
  requestedZoom: number,
  markerSec: number,
  bounds: { min: number; max: number },
): { zoom: number; scrollLeft: number } {
  finite(view.viewportWidth, 'viewportWidth');
  finite(view.contentDurationSec, 'contentDurationSec');
  finite(requestedZoom, 'requestedZoom');
  finite(markerSec, 'markerSec');
  finite(bounds.min, 'bounds.min');
  finite(bounds.max, 'bounds.max');
  if (view.viewportWidth <= 0) throw new RangeError('viewportWidth must be positive');
  if (view.contentDurationSec < 0) throw new RangeError('contentDurationSec must be non-negative');
  if (bounds.min <= 0 || bounds.max < bounds.min) throw new RangeError('invalid zoom bounds');
  const zoom = clamp(requestedZoom, bounds.min, bounds.max);
  const contentWidth = Math.max(view.contentDurationSec * zoom, view.viewportWidth);
  const scrollLeft = clamp(markerSec * zoom - view.viewportWidth / 2, 0, contentWidth - view.viewportWidth);
  return { zoom, scrollLeft };
}

/**
 * One discrete zoom step (buttons / keyboard): multiply ('in') or divide
 * ('out') px-per-second by `factor` (default 1.25). Not clamped — pass the
 * result through zoomAtMarker, which applies the bounds.
 */
export function zoomStep(zoom: number, direction: 'in' | 'out', factor = 1.25): number {
  finite(zoom, 'zoom');
  finite(factor, 'factor');
  if (zoom <= 0) throw new RangeError('zoom must be positive');
  if (factor <= 0) throw new RangeError('factor must be positive');
  return direction === 'in' ? zoom * factor : zoom / factor;
}

/** Seconds at a local-px x offset inside the scroller (never negative). */
export function timeAtLocalX(localX: number, scrollLeft: number, zoom: number): number {
  finite(localX, 'localX');
  finite(scrollLeft, 'scrollLeft');
  finite(zoom, 'zoom');
  if (zoom <= 0) throw new RangeError('zoom must be positive');
  return Math.max(0, (localX + scrollLeft) / zoom);
}

// --- Wheel -------------------------------------------------------------------

export type WheelAction = 'zoom-time' | 'zoom-time-fine' | 'resize-lanes' | 'pan-time' | 'pan-lanes' | 'none';
export type WheelProfileId = 'thedaw' | 'reaper';

/** Action per modifier combination. Meta (Cmd) counts as Ctrl. */
export interface WheelProfile {
  id: WheelProfileId;
  label: string;
  plain: WheelAction;
  ctrl: WheelAction;
  shift: WheelAction;
  alt: WheelAction;
  ctrlShift: WheelAction;
  ctrlAlt: WheelAction;
}

export const WHEEL_PROFILES: Readonly<Record<WheelProfileId, WheelProfile>> = Object.freeze({
  thedaw: Object.freeze<WheelProfile>({
    id: 'thedaw',
    label: 'theDAW (wheel zooms, Ctrl = fine zoom)',
    plain: 'zoom-time',
    ctrl: 'zoom-time-fine',
    shift: 'pan-time',
    alt: 'pan-lanes',
    ctrlShift: 'resize-lanes',
    ctrlAlt: 'pan-lanes',
  }),
  reaper: Object.freeze<WheelProfile>({
    id: 'reaper',
    label: 'REAPER default',
    plain: 'zoom-time',
    ctrl: 'resize-lanes',
    shift: 'pan-time',
    alt: 'pan-time',
    ctrlShift: 'zoom-time-fine',
    ctrlAlt: 'pan-lanes',
  }),
});

const LINE_HEIGHT_PX = 16;

/**
 * Wheel deltas in px: deltaMode 0 (pixels) as-is, 1 (lines) x16,
 * 2 (pages) x `pageHeightPx`. Unknown modes are treated as pixels.
 */
export function normalizeWheelDelta(
  e: { deltaX: number; deltaY: number; deltaMode: number },
  pageHeightPx: number,
): { dx: number; dy: number } {
  finite(e.deltaX, 'deltaX');
  finite(e.deltaY, 'deltaY');
  finite(pageHeightPx, 'pageHeightPx');
  const scale = e.deltaMode === 1 ? LINE_HEIGHT_PX : e.deltaMode === 2 ? pageHeightPx : 1;
  return { dx: e.deltaX * scale, dy: e.deltaY * scale };
}

export interface WheelIntent {
  action: WheelAction;
  /** Multiplier for px-per-second (>1 zooms in); 1 for non-zoom actions. */
  zoomFactor: number;
  /** Scroll delta in local px for pan-time / pan-lanes; 0 otherwise. */
  panPx: number;
  /** Lane-height delta in px for resize-lanes (wheel up grows); 0 otherwise. */
  lanePx: number;
}

const DEFAULT_COARSE_SPEED = 0.002;
const DEFAULT_FINE_SPEED = 0.0006;
const MAX_ZOOM_DELTA_PX = 400;

function speed(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  finite(value, name);
  if (value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

/**
 * Resolve a wheel event into an action under `profile`.
 *
 * Modifier resolution order: ctrl+shift, ctrl+alt, ctrl, alt, shift, plain
 * (meta counts as ctrl). With no modifiers and |dx| > |dy| (a horizontal
 * trackpad swipe) the result is pan-time by dx regardless of profile.
 * Otherwise the gesture's delta is dy, or dx when |dx| > |dy| (browsers turn
 * Shift+wheel into deltaX). zoomFactor = exp(-clamp(delta, -400, 400) * k),
 * k = coarseSpeed (0.002) or, for zoom-time-fine, fineSpeed (0.0006).
 */
export function wheelIntent(
  e: {
    deltaX: number;
    deltaY: number;
    deltaMode: number;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  profile: WheelProfile,
  pageHeightPx: number,
  opts?: { coarseSpeed?: number; fineSpeed?: number },
): WheelIntent {
  const { dx, dy } = normalizeWheelDelta(e, pageHeightPx);
  const coarse = speed(opts?.coarseSpeed, DEFAULT_COARSE_SPEED, 'coarseSpeed');
  const fine = speed(opts?.fineSpeed, DEFAULT_FINE_SPEED, 'fineSpeed');
  const ctrl = e.ctrlKey || e.metaKey;
  const horizontal = Math.abs(dx) > Math.abs(dy);

  if (!ctrl && !e.shiftKey && !e.altKey && horizontal) {
    return { action: 'pan-time', zoomFactor: 1, panPx: dx, lanePx: 0 };
  }

  const action: WheelAction =
    ctrl && e.shiftKey ? profile.ctrlShift
    : ctrl && e.altKey ? profile.ctrlAlt
    : ctrl ? profile.ctrl
    : e.altKey ? profile.alt
    : e.shiftKey ? profile.shift
    : profile.plain;
  const delta = horizontal ? dx : dy;

  switch (action) {
    case 'zoom-time':
    case 'zoom-time-fine': {
      const k = action === 'zoom-time-fine' ? fine : coarse;
      const zoomFactor = Math.exp(-clamp(delta, -MAX_ZOOM_DELTA_PX, MAX_ZOOM_DELTA_PX) * k);
      return { action, zoomFactor, panPx: 0, lanePx: 0 };
    }
    case 'pan-time':
    case 'pan-lanes':
      return { action, zoomFactor: 1, panPx: delta, lanePx: 0 };
    case 'resize-lanes':
      return { action, zoomFactor: 1, panPx: 0, lanePx: -delta };
    case 'none':
      return { action, zoomFactor: 1, panPx: 0, lanePx: 0 };
  }
}

const EXCLUDED_TAGS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

/**
 * True when a wheel event on `el` belongs to the element itself: form fields,
 * contentEditable, or anything inside `[data-wheel-passthrough]`.
 */
export function isWheelExcludedTarget(
  el: { tagName?: string; isContentEditable?: boolean; closest?: (sel: string) => unknown } | null,
): boolean {
  if (!el) return false;
  if (el.tagName && EXCLUDED_TAGS.has(el.tagName.toUpperCase())) return true;
  if (el.isContentEditable) return true;
  const hit = el.closest?.('[data-wheel-passthrough]');
  return hit !== undefined && hit !== null;
}

// --- Clip chrome --------------------------------------------------------------

/** Visible clip width (local px) at or above which the full header shows. */
export const CHROME_FULL_MIN_PX = 140;
/** Visible clip width (local px) at or above which the compact header shows. */
export const CHROME_COMPACT_MIN_PX = 48;

/**
 * Header bounds inside the visible part of a clip, so the title and controls
 * stay on screen while the clip scrolls. All inputs are local px in timeline
 * content coordinates; the result is relative to the clip's left edge, inset
 * by `padding` (default 4) on each side. Null when no part of the clip is
 * visible. Never changes audio geometry.
 */
export function visibleClipHeader(
  clipLeftPx: number,
  clipWidthPx: number,
  scrollLeft: number,
  viewportWidth: number,
  padding = 4,
): { leftInClip: number; width: number } | null {
  finite(clipLeftPx, 'clipLeftPx');
  finite(clipWidthPx, 'clipWidthPx');
  finite(scrollLeft, 'scrollLeft');
  finite(viewportWidth, 'viewportWidth');
  finite(padding, 'padding');
  const left = Math.max(clipLeftPx, scrollLeft);
  const right = Math.min(clipLeftPx + clipWidthPx, scrollLeft + viewportWidth);
  if (right <= left) return null;
  const inset = Math.min(Math.max(0, padding), (right - left) / 2);
  return { leftInClip: left - clipLeftPx + inset, width: Math.max(0, right - left - inset * 2) };
}

/** Which clip chrome fits a visible width in local px. */
export function clipChromeTier(visibleWidthPx: number): 'full' | 'compact' | 'handle' {
  finite(visibleWidthPx, 'visibleWidthPx');
  if (visibleWidthPx >= CHROME_FULL_MIN_PX) return 'full';
  if (visibleWidthPx >= CHROME_COMPACT_MIN_PX) return 'compact';
  return 'handle';
}
