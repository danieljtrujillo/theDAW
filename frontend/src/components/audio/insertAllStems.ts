/**
 * F14 — "Insert all stems" (every already-separated stem of a clip's library
 * entry at once, in a folder, one undo step, the parent clip muted).
 *
 * Which stems to insert is unchanged: `clipDoubleClick.planStemInsert` still
 * decides that (aggregates skipped), reused as-is. This module is the small
 * amount that F14 ADDS on top — the menu gate + label count, a folder name,
 * and the label/color each new stem track gets — kept pure and DOM-free like
 * `clipDoubleClick.ts` so the rules are tested without mounting the editor or
 * touching the store. The actual store writes (one folder track + one
 * track+clip per stem, all in one undo burst, then the parent clip muted) are
 * thin glue in `WaveformEditor.tsx`, mirroring `explodeClipToStems`'s
 * established pattern for "several stem tracks from one clip, one undo step".
 */

import { planStemInsert, type StemRoleRow } from './clipDoubleClick';

export interface AllStemsMenuInfo {
  /** Whether the "All N stems" row belongs in the menu at all. `false` when
   *  `planStemInsert` would actually insert one row or fewer — offering a
   *  bulk action that inserts the same single stem the row right below it
   *  already offers would be a pointless duplicate, not a real bulk option. */
  readonly offer: boolean;
  /** The count the menu label shows: how many stems would ACTUALLY land on
   *  the timeline (aggregate sums excluded), not the raw row count — an
   *  aggregate is never part of what "All stems" inserts, so it must not be
   *  part of what the label claims it will insert either. */
  readonly insertCount: number;
}

/** The "All N stems" menu row's gate + count, for `rows` as `warmClipStems`
 *  returned them (same rows `planStemInsert` reads). */
export function allStemsMenuInfo<T extends StemRoleRow>(rows: readonly T[]): AllStemsMenuInfo {
  const insertCount = planStemInsert(rows).insert.length;
  return { offer: insertCount > 1, insertCount };
}

/** The part of a stem ref this module reads. */
export interface StemLikeRef {
  readonly name: string;
}

/** The folder name for a clip's stem tracks. A blank/whitespace-only label
 *  (an untitled clip) still gets a real name, so the folder is never blank. */
export function stemsFolderName(clipLabel: string): string {
  const trimmed = clipLabel.trim();
  return `${trimmed || 'Clip'} stems`;
}

export interface StemTrackSpec<T extends StemLikeRef> {
  /** The original ref, unchanged, so the caller can still reach `ref.url` etc. */
  readonly ref: T;
  /** Track/clip label: "<clip label> · <stem name>" — the same pattern
   *  `insertStemBesideClip` uses for a single stem, so both name tracks the
   *  same way whichever path put them there. */
  readonly label: string;
  /** `stemColors[ref.name]` when known, else the clip's own color. */
  readonly color: string;
}

/** The label + color every stem track gets, in `refs` order; length and
 *  order match `refs` exactly. */
export function stemTrackSpecs<T extends StemLikeRef>(
  clipLabel: string,
  clipColor: string,
  stemColors: Readonly<Record<string, string>>,
  refs: readonly T[],
): Array<StemTrackSpec<T>> {
  return refs.map((ref) => ({
    ref,
    label: `${clipLabel} · ${ref.name}`,
    color: stemColors[ref.name] ?? clipColor,
  }));
}
