/**
 * rollSelection — the piano roll's marquee geometry and its velocity lane maths.
 *
 * Two jobs, both pure so the roll's selection behaviour is testable without a
 * DOM:
 *
 *  1. The marquee. A drag across empty grid spans a rectangle in GRID space —
 *     steps on x (fractional, so a marquee can start mid-step) and MIDI note
 *     numbers on y — and every note whose own span overlaps that rectangle is
 *     in the selection. Overlap is half-open on a note's end: a marquee whose
 *     left edge sits exactly where a note ends does not take that note, which is
 *     what makes a drag that starts in the gap after a note feel right.
 *
 *  2. The velocity lane. The strip under the grid shares the grid's x scale, so
 *     each note's bar sits under the note itself; y is velocity, 1 at the floor
 *     and 127 at the ceiling. A drag reports a step SPAN rather than a point, so
 *     a fast sweep that skips pixels still draws every note it crossed.
 *
 * Design source (design only — no code copied): LMMS
 * `src/gui/editors/PianoRoll.cpp`, `PianoRoll::computeSelectedNotes` — the
 * normalise-the-rect-then-test-overlap selection model. LMMS is GPL-3.0; this
 * file is an independent implementation of that described behaviour.
 *
 * No Vite-only imports, so node tests load it.
 */
import type { PianoNote } from '../state/pianoRollStore';

/** A point on the grid: a (fractional) step on x, a MIDI note on y. */
export interface RollPoint {
  step: number;
  note: number;
}

/** A normalised marquee: steps half-open on `toStep`, MIDI notes inclusive. */
export interface MarqueeRect {
  fromStep: number;
  toStep: number;
  lowNote: number;
  highNote: number;
}

/** What it takes to turn grid pixels into steps and notes. */
export interface RollGeometry {
  /** Grid px per 16th-note step. */
  stepPx: number;
  /** Grid px per note row. */
  noteHeight: number;
  /** The MIDI note of the top row. */
  highestNote: number;
}

/** A drag shorter than this (px, either axis) is a click, not a marquee. */
export const MARQUEE_MIN_PX = 4;

/** The velocity strip's height in px — a 12px legend row and room to aim a bar. */
export const VELOCITY_LANE_HEIGHT = 56;
/** The lowest velocity a note can hold: 0 is a note-off in MIDI, never a note. */
export const VELOCITY_MIN = 1;
export const VELOCITY_MAX = 127;

const finite = (v: number, fallback = 0): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);

/** A whole velocity in 1..127. */
export const clampVelocity = (v: number): number =>
  Math.max(VELOCITY_MIN, Math.min(VELOCITY_MAX, Math.round(finite(v, VELOCITY_MIN))));

/** A note's drawn length: never zero or negative, whatever is stored. */
const spanOf = (n: PianoNote): number => Math.max(0, finite(n.length, 0));

/**
 * The grid point under a pixel inside the note area. `step` keeps its fraction
 * (a marquee edge can fall mid-step); `note` is the row, so it is whole.
 */
export function gridPointAt(x: number, y: number, geo: RollGeometry): RollPoint {
  const stepPx = Math.max(1e-6, geo.stepPx);
  const rowPx = Math.max(1e-6, geo.noteHeight);
  return {
    step: Math.max(0, finite(x) / stepPx),
    note: geo.highestNote - Math.floor(finite(y) / rowPx),
  };
}

/** The rectangle two grid points span, in either drag direction. */
export function marqueeRect(a: RollPoint, b: RollPoint): MarqueeRect {
  return {
    fromStep: Math.min(a.step, b.step),
    toStep: Math.max(a.step, b.step),
    lowNote: Math.min(a.note, b.note),
    highNote: Math.max(a.note, b.note),
  };
}

/** The rectangle's box in grid pixels, for the overlay that draws it. */
export function marqueeBox(
  rect: MarqueeRect,
  geo: RollGeometry,
): { left: number; top: number; width: number; height: number } {
  const rows = rect.highNote - rect.lowNote + 1;
  return {
    left: rect.fromStep * geo.stepPx,
    top: (geo.highestNote - rect.highNote) * geo.noteHeight,
    width: Math.max(0, (rect.toStep - rect.fromStep) * geo.stepPx),
    height: Math.max(0, rows * geo.noteHeight),
  };
}

/**
 * The ids of the notes the marquee touches, in the order they appear in `notes`.
 * A note is in when its pitch is inside the rows AND its span overlaps the step
 * range — half-open at both ends, so a marquee that starts exactly where a note
 * ends leaves it alone. A marquee with no width selects nothing: a rubber band
 * is a region, and a press with no drag is the roll's add / select click, which
 * never reaches here (see MARQUEE_MIN_PX).
 */
export function notesInMarquee(notes: readonly PianoNote[], rect: MarqueeRect): string[] {
  if (!(rect.toStep > rect.fromStep)) return [];
  const out: string[] = [];
  for (const n of notes) {
    if (n.note < rect.lowNote || n.note > rect.highNote) continue;
    if (n.step >= rect.toStep) continue;
    if (n.step + spanOf(n) <= rect.fromStep) continue;
    out.push(n.id);
  }
  return out;
}

/* ── the velocity lane ────────────────────────────────────────────────────── */

/** The usable height of a bar: the strip less a pixel of headroom at the top. */
const barRoom = (height: number): number => Math.max(1, height - 2);

/** How tall `velocity`'s bar draws in a strip `height` tall. */
export function velocityBarHeight(velocity: number, height: number): number {
  return (clampVelocity(velocity) / VELOCITY_MAX) * barRoom(height);
}

/** The y of the top of `velocity`'s bar in a strip `height` tall. */
export function velocityToY(velocity: number, height: number): number {
  return height - velocityBarHeight(velocity, height);
}

/** The velocity a pointer at `y` means in a strip `height` tall, clamped 1..127. */
export function yToVelocity(y: number, height: number): number {
  return clampVelocity(((height - finite(y)) / barRoom(height)) * VELOCITY_MAX);
}

/**
 * The ids of the notes a lane drag from step `a` to step `b` passes over, in the
 * order they appear in `notes`. The span is INCLUSIVE of both ends, so a
 * stationary press (a === b) picks up the notes sounding at that step, and a
 * sweep picks up every note it crossed even when the pointer skipped pixels.
 */
export function notesInStepSpan(notes: readonly PianoNote[], a: number, b: number): string[] {
  const lo = Math.min(finite(a), finite(b));
  const hi = Math.max(finite(a), finite(b));
  const out: string[] = [];
  for (const n of notes) {
    if (n.step > hi) continue;
    if (n.step + spanOf(n) <= lo) continue;
    out.push(n.id);
  }
  return out;
}

/**
 * The notes a velocity drag over `[a, b]` writes.
 *
 * The rule: when the sweep passes over a SELECTED note, only the selected notes
 * it passed take the new velocity — so a selection is how a user isolates one
 * voice of a chord whose bars sit on top of each other. When it passes over no
 * selected note at all, every note it passed takes it, which is the plain
 * behaviour with nothing selected.
 */
export function velocityTargets(
  notes: readonly PianoNote[],
  a: number,
  b: number,
  selectedIds: ReadonlySet<string>,
): string[] {
  const under = notesInStepSpan(notes, a, b);
  const selected = under.filter((id) => selectedIds.has(id));
  return selected.length > 0 ? selected : under;
}

/**
 * The writes an absolute velocity nudge of `delta` takes, as groups of notes
 * that land on the same velocity.
 *
 * The arrow keys move EVERY selected note by the same amount, so a selection
 * keeps its dynamic shape — a crescendo nudged up is still a crescendo. The
 * store sets one velocity across a set of ids, so the notes are grouped by
 * where they land: a handful of writes (usually one) instead of one per note,
 * which is also one undo step. A note already at the wall it is moving toward
 * drops out, so it cannot drag the rest of its group with it.
 */
export function velocityNudgeWrites(
  notes: readonly PianoNote[],
  ids: ReadonlySet<string>,
  delta: number,
): Array<{ velocity: number; ids: string[] }> {
  const groups = new Map<number, string[]>();
  const d = finite(delta, 0);
  for (const n of notes) {
    if (!ids.has(n.id)) continue;
    const to = clampVelocity(clampVelocity(n.velocity) + d);
    if (to === clampVelocity(n.velocity)) continue;
    const at = groups.get(to);
    if (at) at.push(n.id);
    else groups.set(to, [n.id]);
  }
  return [...groups].map(([velocity, gids]) => ({ velocity, ids: gids }));
}
