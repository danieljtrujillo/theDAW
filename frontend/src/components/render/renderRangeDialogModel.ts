/**
 * Pure decision logic for the "Render range..." popover (F24-5): turns typed
 * form state (name, tail seconds, preroll seconds) plus the current timeline
 * selection into a RenderRange and a job title. No React, no store, no DOM:
 * the dialog component owns rendering and wiring; this module only decides.
 */
import { DEFAULT_PREROLL_SEC, MAX_TAIL_SEC, rangeFromSeconds, type RenderRange } from '../../lib/render/renderRange';

/** Seconds of preroll a user may dial in from this popover. Wider than the
 *  engine's tail cap because preroll is thrown away, never kept, so there is
 *  no render-length cost to allowing more of it. */
const MAX_PREROLL_SEC = 30;

/** Fixed wording for a non-zero tail (F24-5 does not vary it by value; only
 *  the zero/non-zero split is speced). */
const NONZERO_TAIL_HINT = 'Keeps 2.5 s of effect tail';

export interface RangeRenderForm {
  name: string;
  tailSec: number;
  prerollSec: number;
}

export const DEFAULT_RANGE_FORM: RangeRenderForm = {
  name: '',
  tailSec: 0,
  prerollSec: DEFAULT_PREROLL_SEC,
};

/** Clamp typed tail seconds into `[0, MAX_TAIL_SEC]`. Non-finite input (empty
 *  field, NaN, Infinity) falls back to 0, not the previous value. */
export function clampTailSec(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(MAX_TAIL_SEC, Math.max(0, v));
}

/** Clamp typed preroll seconds into `[0, MAX_PREROLL_SEC]`. Non-finite input
 *  falls back to `DEFAULT_PREROLL_SEC`. */
export function clampPrerollSec(v: number): number {
  if (!Number.isFinite(v)) return DEFAULT_PREROLL_SEC;
  return Math.min(MAX_PREROLL_SEC, Math.max(0, v));
}

/** Mirrors `mixdownTitle` in WaveformEditor.tsx: a trimmed typed name gains a
 *  `.wav` suffix when it lacks one; an empty (or whitespace-only) name gets a
 *  timestamped fallback. `now` is injectable so the fallback is deterministic
 *  in tests. */
export function rangeRenderTitle(typed: string, now: () => number = Date.now): string {
  const trimmed = typed.trim();
  if (trimmed) return trimmed.endsWith('.wav') ? trimmed : `${trimmed}.wav`;
  return `range_${String(now()).slice(-6)}.wav`;
}

export type RangeRenderPlanResult = { ok: true; title: string; range: RenderRange } | { ok: false; reason: string };

/**
 * Turns the popover's selection and form into a plan, or a reason the
 * "Render" button cannot proceed. Check order matches what the popover shows:
 * a missing selection first, then a selection that clamps to an empty range.
 */
export function planRangeRenderJob(
  sel: { startSec: number; endSec: number } | null,
  form: RangeRenderForm,
  now?: () => number,
): RangeRenderPlanResult {
  if (sel === null) return { ok: false, reason: 'Select a time range on the timeline first' };
  const range = rangeFromSeconds(sel.startSec, sel.endSec, {
    prerollSec: clampPrerollSec(form.prerollSec),
    tailSec: clampTailSec(form.tailSec),
  });
  if (range === null) return { ok: false, reason: 'The time range is empty' };
  return { ok: true, title: rangeRenderTitle(form.name, now), range };
}

/** Helper text under the tail-seconds control. */
export function tailHint(tailSec: number): string {
  return tailSec === 0 ? 'No effect tail' : NONZERO_TAIL_HINT;
}
