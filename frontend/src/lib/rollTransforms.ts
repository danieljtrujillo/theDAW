/**
 * rollTransforms — the motif transforms (lib/motif) as edits of the piano
 * roll's selected notes.
 *
 * Each takes the roll's whole note list and the ids of the selected notes, and
 * returns a new list: every note outside the selection is the same object at
 * the same place in the list, each selected note is replaced by its
 * transformed self (same id, same lane and other fields), a note a transform
 * leaves out (a fragment) is gone, and a note a transform adds (a sequence's
 * copies) comes at the end with a new id.
 *
 * Positions anchor on the selection: inversion mirrors about its first note
 * (the lowest note of its first onset) unless an axis is given; retrograde
 * reverses inside the selection's span; augmentation and diminution stretch
 * from its first onset; a sequence follows it; a fragment starts where the
 * selection did. With a scale (motif.scaleOf) inversion and sequence move by
 * scale degree, without one by semitones.
 *
 * A note's `tick`/`ticks` (960 PPQ) are the position when present, its
 * `step`/`length` (sixteenths) otherwise; both are written back.
 *
 * Pure: nothing here touches a store.
 */
import {
  augment,
  diminish,
  extractCell,
  fragment,
  invert,
  invertDiatonic,
  realizeCell,
  retrograde,
  sequence,
  TICKS_PER_STEP,
  type MotifCell,
  type Scale,
} from './motif';

export interface RollNoteLike {
  id: string;
  note: number;
  step: number;
  length: number;
  velocity?: number;
  tick?: number;
  ticks?: number;
}

export type Selection = ReadonlySet<string> | readonly string[];

const asSet = (sel: Selection): ReadonlySet<string> => (sel instanceof Set ? sel : new Set(sel as readonly string[]));

/**
 * Runs `transform` on the selected notes' cell and writes the result back:
 * a note whose id comes back is replaced in place, a selected note whose id
 * does not is dropped, and a new id is appended as a copy of the note it was
 * made from.
 */
function applyToSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection, transform: (cell: MotifCell) => MotifCell): T[] {
  const sel = asSet(selection);
  const picked = notes.filter((n) => sel.has(n.id));
  if (!picked.length) return [...notes];
  const cell = extractCell(picked);
  const origin = cell.place?.tick ?? 0;
  const done = realizeCell(transform(cell), origin);
  const byId = new Map(picked.map((n) => [n.id, n]));
  const out = new Map<string, T>();
  for (const r of done) {
    const id = r.id ?? '';
    const src = byId.get(id) ?? byId.get(id.replace(/~seq\d+$/, ''));
    if (!src) continue;
    const tick = Math.max(0, r.tick);
    const next: T = {
      ...src,
      id,
      note: r.note,
      tick,
      ticks: r.ticks,
      step: tick / TICKS_PER_STEP,
      length: r.ticks / TICKS_PER_STEP,
      ...(src.velocity !== undefined ? { velocity: r.velocity } : {}),
    };
    out.set(id, next);
  }
  const kept: T[] = [];
  for (const n of notes) {
    if (!sel.has(n.id)) kept.push(n);
    else if (out.has(n.id)) kept.push(out.get(n.id) as T);
  }
  for (const [id, n] of out) if (!byId.has(id)) kept.push(n);
  return kept;
}

export interface InvertOpts {
  /** The pitch to mirror about; default the selection's first note. */
  axis?: number;
  /** Mirror by scale degree in this scale; default chromatic. */
  scale?: Scale | null;
}

export function invertSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection, opts: InvertOpts = {}): T[] {
  return applyToSelection(notes, selection, (c) => (opts.scale ? invertDiatonic(c, opts.scale, opts.axis) : invert(c, opts.axis)));
}

export function retrogradeSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection): T[] {
  return applyToSelection(notes, selection, retrograde);
}

export function augmentSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection, factor = 2): T[] {
  return applyToSelection(notes, selection, (c) => augment(c, factor));
}

export function diminishSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection, factor = 2): T[] {
  return applyToSelection(notes, selection, (c) => diminish(c, factor));
}

export interface SequenceOpts {
  /** Statements after the selection itself. */
  steps: number;
  /** Scale steps with a scale, semitones without. */
  interval: number;
  scale?: Scale | null;
}

/** The selection, then `steps` more statements after it; a copy's id is `id~seqN`. */
export function sequenceSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection, opts: SequenceOpts): T[] {
  return applyToSelection(notes, selection, (c) => sequence(c, opts.steps, opts.interval, opts.scale));
}

export interface FragmentOpts {
  part: 'head' | 'tail';
  /** Onsets to keep; a chord counts once. */
  count: number;
}

/** Keeps the first or last `count` onsets of the selection, moved to where the selection started. */
export function fragmentSelection<T extends RollNoteLike>(notes: readonly T[], selection: Selection, opts: FragmentOpts): T[] {
  return applyToSelection(notes, selection, (c) => fragment(c, opts.part, opts.count));
}
