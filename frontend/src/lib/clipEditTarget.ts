/**
 * clipEditTarget — the ONE answer to "what does double-clicking this clip open?"
 *
 * The app asked that question in four places and got three different answers.
 * `liveMixer`, `midiCapture` and the timeline's own clip body all required
 * `sourceKind === 'piano-roll'` AND a non-empty `sourcePianoRoll`; the
 * double-click handler required only that `sourcePianoRoll` be truthy, so an
 * audio clip that had ever carried notes opened the piano roll, and an audio
 * clip that never had carried them opened nothing at all.
 *
 * The rule here is the one the rest of the app meant, with one deliberate
 * correction: an EMPTY roll is still a roll. `sourcePianoRoll.length > 0` reads
 * "has notes", but a clip whose notes were all deleted is a valid editable
 * document — opening the roll on it is how you put notes back. The kind of a
 * clip is decided by what it IS, never by how much of it is filled in.
 *
 * Pure and DOM-free: the parameter is structural, so `AudioClip` satisfies it
 * without `lib/` importing `state/`.
 */

/** What a clip's double-click / "edit" gesture should reach. */
export type ClipEditKind = 'midi' | 'audio';

/**
 * The part of a clip the classifier reads.
 *
 * `sourceKind` is typed as a plain string rather than `ClipSourceKind` so a
 * hand-edited project file carrying a kind this build has never heard of is
 * classified (as 'audio') instead of rejected by the type system at the call
 * site. The two note lists are `readonly unknown[]` because only their
 * PRESENCE is the question here — nothing about a note's shape matters.
 */
export interface ClipEditTargetLike {
  /** How the clip was produced. 'piano-roll' is the only kind with a document. */
  readonly sourceKind?: string;
  /** The notes as they sound (looping lanes written out). */
  readonly sourcePianoRoll?: readonly unknown[];
  /** The roll's own notes with their lanes; absent on clips bounced before
   *  lanes existed, which is why either list counts. */
  readonly sourceRollNotes?: readonly unknown[];
}

/** A clip carries an editable roll when it has one of the two note lists. Both
 *  are "the notes"; which one is present is an age-of-the-bounce detail. */
const hasNoteList = (clip: ClipEditTargetLike): boolean =>
  Array.isArray(clip.sourcePianoRoll) || Array.isArray(clip.sourceRollNotes);

/**
 * Which editor owns this clip.
 *
 * 'midi' requires BOTH halves: the clip was produced by the roll
 * (`sourceKind === 'piano-roll'`) and it still carries the note list that is
 * the document. Everything else — including a roll-kind clip whose note list
 * was lost, and an audio clip carrying leftover notes — is 'audio', because
 * every clip has bytes and the audio editor can always open those.
 */
export const clipEditKind = (clip: ClipEditTargetLike): ClipEditKind =>
  clip.sourceKind === 'piano-roll' && hasNoteList(clip) ? 'midi' : 'audio';

/** `clipEditKind(clip) === 'midi'`, for the call sites that read as a guard. */
export const isMidiClip = (clip: ClipEditTargetLike): boolean => clipEditKind(clip) === 'midi';
