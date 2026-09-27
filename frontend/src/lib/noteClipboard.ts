/**
 * noteClipboard — the piano roll's copy / cut / paste / duplicate arithmetic.
 *
 * This is an IN-APP clipboard, not the system one. The roll's note is an
 * internal shape (`PianoNote`: id, MIDI note, step, length, velocity, lane) with
 * no agreed text form, and `navigator.clipboard` only carries strings or blobs —
 * a round trip through it needs a serialisation format (which other apps would
 * then see and paste into), a parser and a version, which is its own ticket. So
 * the roll keeps a module-level payload: no permission prompt, no clipboard
 * read, and nothing of the user's notes leaves the page.
 *
 * Everything here is pure: no DOM, no store state, no ids drawn from anywhere
 * but the injected generator, so the node test checks the arithmetic directly.
 */
import { MIN_NOTE_STEPS, type PianoNote } from '../state/pianoRollStore';

/** What a copy or a cut puts on the roll's clipboard. */
export interface NoteClipboardPayload {
  /** The copied notes, in step order, as copies of the store's objects. */
  readonly notes: readonly PianoNote[];
  /** The earliest copied note's step; every paste is measured from here. */
  readonly anchorStep: number;
}

/** The bounds a paste lands in — the roll's visible pitch range and length. */
export interface RollRange {
  lowestNote: number;
  highestNote: number;
  totalSteps: number;
  /**
   * The longest the roll may grow to hold a paste (the roll passes
   * MAX_ROLL_STEPS and grows with appendNotes). Left out, the paste stays
   * inside `totalSteps`.
   */
  maxSteps?: number;
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

const EPS = 1e-9;

const newId = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `pn-${Math.random().toString(36).slice(2)}-${Date.now()}`;

/** Earliest first, then lowest pitch, so an anchor and a paste order are stable. */
const byStepThenPitch = (a: PianoNote, b: PianoNote): number => a.step - b.step || a.note - b.note;

/**
 * The selected notes as a clipboard payload, or null when nothing in
 * `selectedIds` is in `notes` — an empty selection is a no-op, so the caller
 * leaves whatever is already on the clipboard alone.
 */
export const copyNotes = (
  notes: readonly PianoNote[],
  selectedIds: Iterable<string>,
): NoteClipboardPayload | null => {
  const want = new Set(selectedIds);
  if (want.size === 0) return null;
  const picked = notes.filter((n) => want.has(n.id)).map((n) => ({ ...n }));
  if (picked.length === 0) return null;
  picked.sort(byStepThenPitch);
  return { notes: picked, anchorStep: picked[0].step };
};

/**
 * The payload placed at `atStep`: relative timing, pitch, length, velocity and
 * lane preserved, ids fresh, pitch clamped into `range`. The insertion point is
 * clamped FIRST so the set keeps its shape when it lands off the left edge.
 *
 * The right edge is `range.maxSteps` (the roll grows up to it), or the roll's
 * own length without one. A note that starts at or past that edge is left out,
 * never piled onto the last step, and a note that runs past it loses the
 * overhang. Lengths keep their own size down to one tick: a sub-step note
 * (a triplet 16th, a 32nd) pastes as it was copied.
 */
export const pasteNotes = (
  payload: NoteClipboardPayload,
  atStep: number,
  range: RollRange,
  makeId: () => string = newId,
): PianoNote[] => {
  if (payload.notes.length === 0) return [];
  const limit = Math.max(1, range.totalSteps, range.maxSteps ?? 0);
  const base = clamp(Math.round(atStep), 0, Math.ceil(limit) - 1);
  const lo = Math.min(range.lowestNote, range.highestNote);
  const hi = Math.max(range.lowestNote, range.highestNote);
  const out: PianoNote[] = [];
  for (const n of payload.notes) {
    const step = Math.max(0, base + (n.step - payload.anchorStep));
    if (step >= limit - EPS) continue;
    out.push({
      ...n,
      id: makeId(),
      note: clamp(n.note, lo, hi),
      step,
      length: clamp(n.length, MIN_NOTE_STEPS, limit - step),
    });
  }
  return out;
};

/**
 * The selected notes copied in place, landing at the selection's END (the
 * latest selected note's step + length, a sub-step length included) so a
 * repeated duplicate marches forward instead of stacking. Empty selection → no
 * notes.
 */
export const duplicateNotes = (
  notes: readonly PianoNote[],
  selectedIds: Iterable<string>,
  range: RollRange,
  makeId: () => string = newId,
): PianoNote[] => {
  const payload = copyNotes(notes, selectedIds);
  if (!payload) return [];
  const end = payload.notes.reduce((m, n) => Math.max(m, n.step + n.length), 0);
  return pasteNotes(payload, end, range, makeId);
};
