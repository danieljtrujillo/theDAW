/**
 * The three decisions behind double-clicking a clip, and behind putting a
 * separated stem next to the clip it came from. Pure and DOM-free: no React,
 * no store, no browser — every value in and out is a plain number or string.
 *
 * UNITS. `clipGesturePhase` measures VIEWPORT px (raw `clientX/Y` deltas), the
 * same unit `WaveformEditor`'s existing "was that a click?" tests use, because
 * a hand wobble is a physical distance and must not change meaning with the
 * timeline's CSS zoom. Everything in `stemClipPlacement` is TIMELINE seconds.
 *
 * ── Why the click band exists (F18) ────────────────────────────────────────
 * A press on a clip used to start a `move` op that applied from the FIRST
 * pointermove: one wobbled pixel between the two presses of a double-click
 * re-snapped the clip to the grid, and — when the press was inside the 10-px
 * lane-insert band that covers a clip's top and bottom few pixels — the
 * release also inserted a brand-new track and moved the clip onto it. Either
 * way the clip left the pointer, so the second press landed on the lanes and
 * the browser dispatched `dblclick` at the lanes rather than the clip: the
 * editor never opened. It looked flaky because it depended on where in the
 * clip you pressed and on whether the clip happened to sit on the grid.
 *
 * The rule below is the fix and the invariant: BELOW the slop a press writes
 * NOTHING — no move, no trim, no lane insert, no undo step — and the release
 * is a click. AT or ABOVE it the gesture is a drag and behaves exactly as it
 * always has. One threshold decides both halves, so there is no band in which
 * an op applied and the release still counted as a click.
 */

/**
 * How far a press may travel, in viewport px, and still be a click.
 *
 * Four px is the wobble a hand puts into a double-click on a normal mouse
 * while being far less than any deliberate drag. Owned here rather than in
 * `WaveformEditor` so the gate that suppresses the op and the tests that pin
 * it down read the same number.
 */
export const CLIP_CLICK_SLOP_PX = 4;

/**
 * The window event that closes the double-click round trip: a clip opened in
 * the AUDIO EDIT drawer asks the timeline to show it again.
 *
 * The name and its payload live in this module — which imports nothing — so
 * the drawer and the timeline can share them without the drawer pulling the
 * 7,000-line editor into its chunk. `WaveformEditor` listens; the drawer's
 * "Reveal in timeline" key dispatches.
 */
export const REVEAL_CLIP_EVENT = 'thedaw:reveal-clip';

/** `CustomEvent.detail` of a `REVEAL_CLIP_EVENT`. */
export interface RevealClipDetail {
  /** The clip to select, scroll to and park the edit cursor on. */
  clipId: string;
}

/** What a press has turned into. */
export type ClipGesturePhase = 'click' | 'drag';

function finite(n: number, what: string): number {
  if (!Number.isFinite(n)) throw new RangeError(`${what} must be finite (got ${n})`);
  return n;
}

/**
 * Whether a press that has travelled `(dxPx, dyPx)` viewport px from where it
 * went down is still a click or has become a drag.
 *
 * The comparison is on DISTANCE, not on either axis alone: a diagonal nudge of
 * 3 px on both axes is 4.2 px of travel and is a drag, while 2.8 px on both is
 * 3.96 px and is not. A `slopPx` of 0 leaves no click band at all, which is
 * what "every press is a drag" means.
 */
export function clipGesturePhase(
  dxPx: number,
  dyPx: number,
  slopPx: number = CLIP_CLICK_SLOP_PX,
): ClipGesturePhase {
  finite(dxPx, 'dxPx');
  finite(dyPx, 'dyPx');
  finite(slopPx, 'slopPx');
  if (slopPx < 0) throw new RangeError(`slopPx must not be negative (got ${slopPx})`);
  return Math.hypot(dxPx, dyPx) < slopPx ? 'click' : 'drag';
}

// ── Stems ──────────────────────────────────────────────────────────────────

/** The part of a `/api/stems/{entry}` row this module reads. `role` is a plain
 *  string so a role this build has never heard of is treated as a part (it is
 *  not the one name we know sums other rows) instead of failing to type. */
export interface StemRoleRow {
  readonly name: string;
  readonly role?: string;
}

/** Which stems go on the timeline, and which sums were left off. */
export interface StemInsertPlan<T extends StemRoleRow> {
  /** The rows to insert, in the order they arrived. */
  readonly insert: readonly T[];
  /** The names of the aggregate rows left out, in the order they arrived. */
  readonly skipped: readonly string[];
}

/**
 * Pick the stems to insert.
 *
 * An `aggregate` row is a SUM of other rows in the same run — `drums` over the
 * LARSNET kit parts, `no_vocals` over everything but the vocal — so inserting
 * it beside its members puts that audio on the timeline twice, at double
 * level. The parts are what a user separated for, so the sums are left off.
 *
 * Two deliberate exceptions:
 *  - NO row carries a role (an older backend, or a run with no manifest): the
 *    question cannot be answered, so every row is inserted, exactly as before
 *    roles existed. This is also why a row with no `role` of its own is kept —
 *    only a row that SAYS it is a sum is one.
 *  - Every row is an aggregate: the backend never reports that (it calls a row
 *    a sum only when its members are present), but a plan that inserted
 *    nothing would surface as "separation produced no stems", so the rows are
 *    kept and nothing is reported skipped.
 */
export function planStemInsert<T extends StemRoleRow>(rows: readonly T[]): StemInsertPlan<T> {
  const described = rows.some((r) => r.role !== undefined);
  if (!described) return { insert: [...rows], skipped: [] };
  const insert = rows.filter((r) => r.role !== 'aggregate');
  if (insert.length === 0) return { insert: [...rows], skipped: [] };
  return { insert, skipped: rows.filter((r) => r.role === 'aggregate').map((r) => r.name) };
}

/**
 * The clause a status or log line adds when sums were left off, or `''` when
 * none were. Names the stems rather than paraphrasing them, so the line says
 * exactly which audio is not on the timeline.
 */
export function skippedAggregatesNote(skipped: readonly string[]): string {
  if (skipped.length === 0) return '';
  return `skipped ${skipped.join(', ')} (aggregate${skipped.length === 1 ? '' : 's'})`;
}

/** The shortest clip the timeline keeps, in seconds. Below this a stem whose
 *  audio ends before the parent's read head would become a zero-length clip. */
export const STEM_MIN_CLIP_SEC = 0.05;

/** The parent clip a stem is being aligned to. All timeline seconds. */
export interface StemParentWindow {
  readonly startSec: number;
  readonly durationSec: number;
  readonly offsetIntoSource: number;
}

/** Where a stem clip goes. All timeline seconds. */
export interface StemPlacement {
  readonly startSec: number;
  readonly offsetIntoSource: number;
  readonly durationSec: number;
}

/**
 * Put a stem where its parent clip is: same start, same read head into the
 * source, same length — a stem is the same recording with parts removed, so
 * the window that framed the parent frames it too.
 *
 * `sourceDurationSec` is the stem's own decoded length, which can fall short
 * of the parent's window (a separator may trim trailing silence). The read
 * head is then pulled back to `STEM_MIN_CLIP_SEC` before the stem's end and
 * the clip covers whatever is left, so it is always placeable.
 *
 * `startSecOverride` is for the callers with no parent ON the timeline — the
 * library's "stems as EDIT tracks", which inserts at the edit cursor. Held at
 * or after zero.
 */
export function stemClipPlacement(
  parent: StemParentWindow,
  sourceDurationSec: number,
  startSecOverride?: number,
): StemPlacement {
  finite(parent.startSec, 'parent.startSec');
  finite(parent.durationSec, 'parent.durationSec');
  finite(parent.offsetIntoSource, 'parent.offsetIntoSource');
  finite(sourceDurationSec, 'sourceDurationSec');
  if (startSecOverride !== undefined) finite(startSecOverride, 'startSecOverride');

  const offsetIntoSource = Math.min(
    parent.offsetIntoSource,
    Math.max(0, sourceDurationSec - STEM_MIN_CLIP_SEC),
  );
  return {
    startSec: Math.max(0, startSecOverride ?? parent.startSec),
    offsetIntoSource,
    durationSec: Math.min(
      parent.durationSec,
      Math.max(STEM_MIN_CLIP_SEC, sourceDurationSec - offsetIntoSource),
    ),
  };
}
