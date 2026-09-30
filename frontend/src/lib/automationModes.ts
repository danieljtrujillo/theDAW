/**
 * automationModes — the automation MODEL: four record modes, the held-target
 * write, and the per-point segment curve.
 *
 * Before this module the editor had one `automationWrite` boolean. While it was
 * on and the transport rolled, moving a fader appended a breakpoint and cancelled
 * the live envelope for the rest of the pass. The comment called that "latch",
 * but nothing held after release, nothing punched out, and nothing overwrote what
 * was already in the lane — a "write" pass left the old breakpoints sitting
 * inside the region it had just ridden over. Breakpoints were linear only.
 *
 * This file is the model, kept pure so it can be tested without a store, a clock
 * or an AudioContext: predicates that say what each mode does, the span write
 * that makes an overwrite an actual overwrite, and the curve that shapes one
 * segment. `editorStore` owns the state; `automationModes` owns the rules.
 *
 * DESIGN SOURCE (read for its design only — NO code was copied from it):
 *   - Tracktion Engine `modules/tracktion_engine/model/automation/
 *     tracktion_AutomationMode.h` (GPL-3.0 or commercial) — the four-mode model
 *     and its punch-out rules: read never writes; touch punches out at the end
 *     of the gesture; latch punches out when play stops; write starts writing at
 *     play start. That is a behavioural description; every line below (the
 *     predicates, the rational curve, the span write) was written here from it.
 *
 * The curve is deliberately NOT a power curve (`u^p`). A power curve satisfies
 * most of the laws a segment shape needs but not the mirror law
 * `f(u,c) = 1 - f(1-u,-c)`, so dragging a segment up by n px and back down by n
 * px would not return the original shape. The rational form below satisfies all
 * seven laws exactly, and both ends are exact (0 and 1, not 0.9999).
 */

/** Structural twin of `editorStore`'s `AutomationPoint`. Declared here because
 *  this module must not import the store; the two shapes are identical and
 *  assignable in both directions, and `editorStore.automation.test.ts` pins that. */
export interface CurvePoint {
  /** Timeline seconds. */
  t: number;
  /** Value in the parameter's natural units. */
  v: number;
  /** Shape of the segment that STARTS at this point, in [-1, 1]. Absent = 0 =
   *  linear. Positive reaches the next value early, negative late. */
  curve?: number;
}

/* ── Modes ────────────────────────────────────────────────────────────────── */

export type AutomationMode = 'read' | 'touch' | 'latch' | 'write';

/** Ordered weakest-to-strongest, which is also the order the UI shows them in. */
export const AUTOMATION_MODES: AutomationMode[] = ['read', 'touch', 'latch', 'write'];

/** Does moving a control record, for as long as it is held? True for everything
 *  except `read`, which is the "the lane drives, hands off" mode. */
export const recordsWhileHeld = (mode: AutomationMode): boolean => mode !== 'read';

/** Does the target keep writing its last value after the control is RELEASED?
 *  `touch` punches out on release (later playback reads the lane again); `latch`
 *  and `write` hold the released value until the transport stops. */
export const holdsAfterRelease = (mode: AutomationMode): boolean => mode === 'latch' || mode === 'write';

/** Does play start arm every existing enabled lane, whether or not anything is
 *  touched? Only `write` — that is exactly what makes a write pass overwrite
 *  everything it passes over. */
export const writesUntouched = (mode: AutomationMode): boolean => mode === 'write';

/** The mode a stop leaves behind. `write` demotes itself to `latch` so the pass
 *  after a write pass does not silently overwrite the whole project again — the
 *  user has to ask for that a second time. Every other mode is unchanged. */
export const modeAfterStop = (mode: AutomationMode): AutomationMode => (mode === 'write' ? 'latch' : mode);

/* ── Curve ────────────────────────────────────────────────────────────────── */

const clamp01 = (x: number): number => (Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0);

/** A curve is always a usable number in [-1, 1]; junk (NaN, a hand-edited
 *  project, ±Infinity) reads as linear or as the nearest extreme. */
export const clampCurve = (c: number | undefined): number => {
  if (c === undefined || Number.isNaN(c)) return 0;
  return Math.max(-1, Math.min(1, c));
};

/** How far through the value change a full (+1) curve is at the halfway point.
 *  The one number the seven laws leave free — it sets how strong "full curve"
 *  feels. 0.9 makes +1 a pronounced-but-usable ease, and the mirror law then
 *  makes -1 sit at 0.1. */
export const CURVE_HALFWAY_AT_FULL = 0.9;

/** `r` at curve = 1. Derived from CURVE_HALFWAY_AT_FULL: solving
 *  `0.5 / (r*0.5 + 0.5) = h` gives `r = (1 - h) / h`. */
const CURVE_R_AT_FULL = (1 - CURVE_HALFWAY_AT_FULL) / CURVE_HALFWAY_AT_FULL;

/**
 * The segment shape: maps normalised position `u` in [0,1] to normalised value.
 *
 * `f(u,c) = u / (r(1-u) + u)` with `r = (1/9)^c`. All seven laws hold by
 * construction:
 *   f(0,c) = 0, f(1,c) = 1 (both exact — the denominator is exactly `r` and
 *   exactly 1); f(u,0) = u because r = 1; monotone increasing because
 *   `df/du = r / (r(1-u)+u)^2 > 0`; the denominator is `r(1-u) + u`, which is
 *   below 1 when r < 1 (c > 0) and above it when r > 1 (c < 0), giving
 *   f > u and f < u respectively; and `1 - f(1-u,-c)` reduces algebraically to
 *   `u / (r(1-u) + u)`, which is f(u,c) — the mirror law, exactly.
 */
export const curveShape = (u: number, curve: number): number => {
  const c = clampCurve(curve);
  const x = clamp01(u);
  if (c === 0) return x;
  const r = Math.pow(CURVE_R_AT_FULL, c);
  return x / (r * (1 - x) + x);
};

/** Value at `t` on the segment from `p0` to `p1`, shaped by `p0.curve` (a point's
 *  curve describes the run FROM it).
 *
 *  `t` is CLAMPED to the segment (by `curveShape`), where the inline code this
 *  replaced extrapolated past both ends. That is not a behaviour change for any
 *  lane caller: `sampleCurve` handles the outside-the-range cases itself and only
 *  ever calls this with `p0.t <= t < p1.t`, and the 1e-6 divisor guard — the one
 *  `sampleLane` has always had, so two breakpoints at the same instant cannot
 *  divide by zero — keeps the ratio inside [0,1) even then. Clamping only
 *  changes what a DIRECT caller gets for an out-of-range `t`: the nearer end's
 *  value instead of an extrapolation. */
export const interpolatePoints = (p0: CurvePoint, p1: CurvePoint, t: number): number => {
  const u = (t - p0.t) / Math.max(1e-6, p1.t - p0.t);
  return p0.v + (p1.v - p0.v) * curveShape(u, p0.curve ?? 0);
};

/**
 * Lane value at `t`, or null when there are no points.
 *
 * The edge semantics are exactly the ones `sampleLane` shipped with — first
 * value held before the first point, last value held after the last, binary
 * search between — because live playback, the offline bounces and the lane
 * drawing all depend on them. The only change is that the interior segment is
 * shaped by its left point's curve, which for a curve-less lane is the identical
 * linear ramp (`curveShape(u, 0) === u`).
 */
export const sampleCurve = (points: readonly CurvePoint[], t: number): number | null => {
  if (points.length === 0) return null;
  if (t <= points[0].t) return points[0].v;
  const last = points[points.length - 1];
  if (t >= last.t) return last.v;
  let lo = 0;
  let hi = points.length - 1;
  while (lo + 1 < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t <= t) lo = mid;
    else hi = mid;
  }
  return interpolatePoints(points[lo], points[hi], t);
};

/* ── Writing ──────────────────────────────────────────────────────────────── */

/**
 * Insert `(t, v)`, keeping `points` sorted and thinned: a neighbour closer than
 * `minDt` keeps ITS time and takes the new value instead of a second point being
 * added, so a 50 Hz gesture does not pile up hundreds of breakpoints.
 *
 * This is the store's `upsertPoint` rule, lifted here so the span write and the
 * store share ONE definition of it rather than drifting apart.
 *
 * Curve: an explicitly passed `curve` wins (including an explicit 0, which
 * clears the shape). With none passed, a merged neighbour keeps its own — a
 * fader ride overwrites values, it does not flatten a shape somebody drew. A
 * resolved curve of 0 is stored as an ABSENT key, so linear points keep the
 * exact `{t, v}` shape they have always had on disk.
 */
export const upsertAutomationPoint = (
  points: readonly CurvePoint[],
  t: number,
  v: number,
  minDt: number,
  curve?: number,
): CurvePoint[] => {
  let lo = 0;
  let hi = points.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid].t < t) lo = mid + 1;
    else hi = mid;
  }
  const idx = lo;
  const left = idx > 0 ? points[idx - 1] : null;
  const right = idx < points.length ? points[idx] : null;
  const next = points.slice();
  if (left && t - left.t < minDt) next[idx - 1] = makePoint(left.t, v, curve === undefined ? left.curve : curve);
  else if (right && right.t - t < minDt) next[idx] = makePoint(right.t, v, curve === undefined ? right.curve : curve);
  else next.splice(idx, 0, makePoint(t, v, curve));
  return next;
};

/** A point with the curve key present only when it actually bends something. */
const makePoint = (t: number, v: number, curve: number | undefined): CurvePoint => {
  const c = clampCurve(curve);
  return c === 0 ? { t, v } : { t, v, curve: c };
};

/**
 * Write `v` forward across `(fromT, toT]` — what a HELD target does to a lane.
 *
 * Every point strictly inside the span is removed and `(toT, v)` is upserted, so
 * an overwrite leaves no stale breakpoint behind for playback to ramp towards.
 * The point AT `fromT` survives: it is the pass's own previous write (or what was
 * there before the pass started), and it anchors the ramp into the span.
 *
 * `fromT >= toT` (a stopped transport, a backwards seek, the first frame of a
 * gesture) is just the upsert — there is no span to clear.
 */
export const writeSpan = (
  points: readonly CurvePoint[],
  fromT: number,
  toT: number,
  v: number,
  minDt: number,
): CurvePoint[] => {
  const base = toT > fromT ? points.filter((p) => !(p.t > fromT && p.t <= toT)) : points;
  return upsertAutomationPoint(base, toT, v, minDt);
};

/** New curve for a segment handle dragged `dyPx` from where it was grabbed.
 *  Screen y grows downward, so dragging UP is a negative delta and makes the
 *  segment faster (a larger curve). */
export const curveFromDrag = (startCurve: number, dyPx: number, pxPerUnit = 100): number => {
  const start = Number.isFinite(startCurve) ? startCurve : 0;
  const delta = Number.isFinite(dyPx) && pxPerUnit > 0 ? dyPx / pxPerUnit : 0;
  return clampCurve(start - delta);
};
