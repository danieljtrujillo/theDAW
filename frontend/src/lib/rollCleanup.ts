/**
 * rollCleanup — the MIDI tab's CLEAN key: a transcription's notes tidied in
 * the part being edited, the selected notes when there are some, else every
 * note of the part.
 *
 * ONE AT A TIME reduces the notes to one line (lib/clipNotes oneAtATime: the
 * top line, the bottom line or the latest note wins where two overlap). KEEP
 * RANGE removes every note below a low pitch or above a high one
 * (lib/clipNotes filterNotes), which clears the sub-bass rumble and the
 * whistle-register blips a transcriber hears outside the range anything
 * played. The notes outside the selection stay as they are.
 *
 * Pure: the store writes the result (runRollCleanup, components/audio/RollCleanup).
 */
import type { PianoNote } from '../state/pianoRollStore';
import { filterNotes, oneAtATime, type OneAtATimeKeep } from './clipNotes';

export type RollCleanup =
  | { kind: 'one-at-a-time'; keep: OneAtATimeKeep }
  | { kind: 'keep-range'; low: number; high: number };

export interface RollCleanupResult {
  /** Every note of the part after the clean-up, the untouched ones included. */
  notes: PianoNote[];
  /** The notes the clean-up worked on: the selection's, else the part's. */
  scope: 'selection' | 'part';
  /** How many notes it worked on. */
  in: number;
  /** How many of them it removed. */
  removed: number;
  /** How many of them it cut short. */
  shortened: number;
  /** The ids of the worked-on notes that are left (the selection a clean-up of a selection keeps). */
  kept: string[];
}

/** A pitch 0-127, whole. */
const pitch = (v: number): number => Math.max(0, Math.min(127, Math.round(Number.isFinite(v) ? v : 0)));

/** Apply `cleanup` to the selected notes of `notes` (every note when `selected` is empty). */
export function cleanRollNotes(notes: readonly PianoNote[], selected: ReadonlySet<string>, cleanup: RollCleanup): RollCleanupResult {
  const scope = selected.size > 0 && notes.some((n) => selected.has(n.id)) ? 'selection' : 'part';
  const inScope = scope === 'selection' ? notes.filter((n) => selected.has(n.id)) : [...notes];
  const rest = scope === 'selection' ? notes.filter((n) => !selected.has(n.id)) : [];
  let out: PianoNote[];
  let shortened = 0;
  if (cleanup.kind === 'one-at-a-time') {
    const res = oneAtATime(inScope, cleanup.keep);
    out = res.notes;
    shortened = res.shortened;
  } else {
    const low = pitch(Math.min(cleanup.low, cleanup.high));
    const high = pitch(Math.max(cleanup.low, cleanup.high));
    out = filterNotes(inScope, { minPitch: low, maxPitch: high }).kept;
  }
  const all = [...rest, ...out].sort((a, b) => a.step - b.step);
  return { notes: all, scope, in: inScope.length, removed: inScope.length - out.length, shortened, kept: out.map((n) => n.id) };
}

/** The words for each ONE AT A TIME choice: the flyout's options and the LOG line. */
export const ONE_AT_A_TIME_LABELS: Readonly<Record<OneAtATimeKeep, string>> = Object.freeze({
  top: 'Top line',
  bottom: 'Bottom line',
  latest: 'Latest note',
});

/** The LOG line a clean-up writes. */
export function rollCleanupLog(cleanup: RollCleanup, res: RollCleanupResult, rangeText: (p: number) => string): string {
  const what = res.scope === 'selection' ? `${res.in} selected note${res.in === 1 ? '' : 's'}` : `${res.in} note${res.in === 1 ? '' : 's'} of the part`;
  if (cleanup.kind === 'one-at-a-time') {
    return `One at a time (${ONE_AT_A_TIME_LABELS[cleanup.keep].toLowerCase()}): ${what}, ${res.removed} removed, ${res.shortened} shortened`;
  }
  const low = Math.min(cleanup.low, cleanup.high);
  const high = Math.max(cleanup.low, cleanup.high);
  return `Keep range ${rangeText(low)} to ${rangeText(high)}: ${what}, ${res.removed} outside it removed`;
}
