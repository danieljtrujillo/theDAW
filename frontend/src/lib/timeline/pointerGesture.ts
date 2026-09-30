/**
 * Pure pointer-gesture logic for empty timeline space: click vs marquee drag,
 * what a click does to the edit cursor and transport, and edge autoscroll speed.
 *
 * DOM-free. The DOM adapter owns pointer capture/release and converts events to
 * the two coordinate spaces used here:
 *  - `client` points are screen CSS px (used only for the zoom-independent drag threshold);
 *  - `model` points are whatever space the caller's hit test uses (e.g. content px,
 *    or seconds on x); this module never interprets them beyond normalizing a rect.
 */

/** Marquee combine mode. Structurally identical to the selection module's type. */
export type MarqueeMode = 'replace' | 'add' | 'subtract' | 'toggle';

/** Normalized rectangle in model space (x1 <= x2, y1 <= y2). */
export interface Rect {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/** A 2-D point; units depend on the argument (client CSS px or model space). */
export interface Pt {
  x: number;
  y: number;
}

export interface GestureState {
  pointerId: number;
  /** Pointer-down position in screen CSS px. */
  originClient: Pt;
  /** Pointer-down position in model space. */
  originModel: Pt;
  /** Latest pointer position in model space. */
  currentModel: Pt;
  /** Selection at pointer-down; every marquee update combines against this, never a running result. */
  baselineIds: readonly string[];
  mode: MarqueeMode;
  phase: 'pending' | 'marquee' | 'cancelled';
}

/** Combines the baseline selection with the ids under the marquee. */
export type Combine = (baseline: readonly string[], hits: readonly string[], mode: MarqueeMode) => string[];

type HitTest = (r: Rect) => readonly string[];

function finite(v: number, name: string): number {
  if (!Number.isFinite(v)) throw new RangeError(`${name} must be a finite number`);
  return v;
}

function finitePt(p: Pt, name: string): Pt {
  finite(p.x, `${name}.x`);
  finite(p.y, `${name}.y`);
  return p;
}

function rectFromPoints(a: Pt, b: Pt): Rect {
  return { x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y), x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y) };
}

/** Pointer down on empty space: a pending gesture that is a click until it travels `thresholdPx`. */
export function startGesture(
  pointerId: number,
  client: Pt,
  model: Pt,
  baselineIds: readonly string[],
  mode: MarqueeMode,
): GestureState {
  finite(pointerId, 'pointerId');
  finitePt(client, 'client');
  finitePt(model, 'model');
  return {
    pointerId,
    originClient: { x: client.x, y: client.y },
    originModel: { x: model.x, y: model.y },
    currentModel: { x: model.x, y: model.y },
    baselineIds: [...baselineIds],
    mode,
    phase: 'pending',
  };
}

/**
 * Pointer move. A different pointer id or a cancelled gesture returns the state unchanged.
 * While pending and the screen distance from the origin (hypot, CSS px) is below
 * `thresholdPx` (default 4) the gesture stays pending. At or past the threshold it becomes
 * 'marquee' and stays marquee for the rest of the gesture.
 */
export function moveGesture(
  s: GestureState,
  pointerId: number,
  client: Pt,
  model: Pt,
  hitTest: HitTest,
  combine: Combine,
  thresholdPx = 4,
): { state: GestureState; selectedIds: string[] | null; rect: Rect | null } {
  finitePt(client, 'client');
  finitePt(model, 'model');
  if (finite(thresholdPx, 'thresholdPx') < 0) throw new RangeError('thresholdPx must be >= 0');
  if (pointerId !== s.pointerId || s.phase === 'cancelled') return { state: s, selectedIds: null, rect: null };
  const currentModel = { x: model.x, y: model.y };
  if (s.phase === 'pending') {
    const dist = Math.hypot(client.x - s.originClient.x, client.y - s.originClient.y);
    if (dist < thresholdPx) return { state: { ...s, currentModel }, selectedIds: null, rect: null };
  }
  const state: GestureState = { ...s, phase: 'marquee', currentModel };
  const rect = rectFromPoints(state.originModel, currentModel);
  return { state, selectedIds: combine(state.baselineIds, hitTest(rect), state.mode), rect };
}

/**
 * Re-evaluates the marquee without pointer movement (e.g. after an autoscroll step moved
 * content under the rect). Null unless the gesture is in the 'marquee' phase.
 */
export function refreshMarquee(
  s: GestureState,
  hitTest: HitTest,
  combine: Combine,
): { selectedIds: string[] | null; rect: Rect | null } {
  if (s.phase !== 'marquee') return { selectedIds: null, rect: null };
  const rect = rectFromPoints(s.originModel, s.currentModel);
  return { selectedIds: combine(s.baselineIds, hitTest(rect), s.mode), rect };
}

/** Pointer up. 'click' if the gesture never passed the threshold; cancelled or other pointer → 'ignore'. */
export function finishGesture(s: GestureState, pointerId: number): 'click' | 'marquee' | 'ignore' {
  if (pointerId !== s.pointerId || s.phase === 'cancelled') return 'ignore';
  return s.phase === 'pending' ? 'click' : 'marquee';
}

/** Escape / pointercancel / lost capture: the gesture ends and the baseline selection is restored. */
export function cancelGesture(s: GestureState): { state: GestureState; restoreIds: string[] } {
  return { state: { ...s, phase: 'cancelled' }, restoreIds: [...s.baselineIds] };
}

/**
 * Whether a pointerdown may start a gesture: primary button only. On macOS a ctrl+click
 * with a mouse is a context-menu click, not a primary gesture. A missing pointerType is
 * treated as a mouse.
 */
export function isPrimaryGestureButton(
  e: { button: number; ctrlKey: boolean; pointerType?: string },
  isMac: boolean,
): boolean {
  if (e.button !== 0) return false;
  if (isMac && e.ctrlKey && (e.pointerType ?? 'mouse') === 'mouse') return false;
  return true;
}

export type ClickSurface = 'ruler' | 'empty-lane' | 'clip-body' | 'control';

/**
 * Click placement policy.
 *  - 'default': clicking a clip body while playing moves only the edit cursor.
 *  - 'clip-seeks': clip-body clicks always seek.
 *  - 'ruler-only': only the ruler (or an explicit seek) seeks the transport.
 */
export type ClickProfile = 'default' | 'clip-seeks' | 'ruler-only';

/**
 * What a click does. `moveEditCursor` places the edit cursor at the click time;
 * `seek` moves the transport playhead there. Neither field can start or stop playback.
 * Controls never place anything. `explicitSeek` is the caller's "seek anyway" modifier.
 */
export function placementIntent(a: {
  surface: ClickSurface;
  playing: boolean;
  explicitSeek: boolean;
  profile: ClickProfile;
}): { moveEditCursor: boolean; seek: boolean } {
  const { surface, playing, explicitSeek, profile } = a;
  if (surface === 'control') return { moveEditCursor: false, seek: false };
  if (surface === 'ruler') return { moveEditCursor: true, seek: true };
  if (profile === 'ruler-only') return { moveEditCursor: true, seek: explicitSeek };
  if (surface === 'empty-lane' || profile === 'clip-seeks') return { moveEditCursor: true, seek: true };
  return { moveEditCursor: true, seek: explicitSeek || !playing };
}

/** Signed speed for one axis: toward `lo` is negative, toward `hi` positive, 0 outside both bands. */
function axisVelocity(p: number, lo: number, hi: number, edge: number, max: number): number {
  const dLo = p - lo;
  const dHi = hi - p;
  if (dLo < edge && dLo <= dHi) return -max * Math.min(1, (edge - dLo) / edge);
  if (dHi < edge) return max * Math.min(1, (edge - dHi) / edge);
  return 0;
}

/**
 * Edge autoscroll velocity in CSS px per animation frame, per axis.
 * `p` and `vp` are in the same client CSS px space. Zero outside the edge bands; inside a
 * band of `edgePx` (default 32) the speed ramps linearly from 0 at the band's inner boundary
 * to `maxPxPerFrame` (default 24) at the viewport edge; at or beyond the edge it is capped.
 * Negative = scroll left/up, positive = right/down. Axes are independent.
 */
export function autoscrollVelocity(
  p: Pt,
  vp: { left: number; top: number; right: number; bottom: number },
  opts?: { edgePx?: number; maxPxPerFrame?: number },
): { vx: number; vy: number } {
  finitePt(p, 'p');
  finite(vp.left, 'vp.left');
  finite(vp.top, 'vp.top');
  finite(vp.right, 'vp.right');
  finite(vp.bottom, 'vp.bottom');
  const edge = finite(opts?.edgePx ?? 32, 'edgePx');
  const max = finite(opts?.maxPxPerFrame ?? 24, 'maxPxPerFrame');
  if (edge <= 0) throw new RangeError('edgePx must be > 0');
  if (max < 0) throw new RangeError('maxPxPerFrame must be >= 0');
  const vx = axisVelocity(p.x, vp.left, vp.right, edge, max);
  const vy = axisVelocity(p.y, vp.top, vp.bottom, edge, max);
  // Normalize -0 to 0 so callers can compare with ===/Object.is.
  return { vx: vx === 0 ? 0 : vx, vy: vy === 0 ? 0 : vy };
}
