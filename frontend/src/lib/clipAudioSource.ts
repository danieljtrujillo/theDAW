/**
 * clipAudioSource — which library entry describes an EDIT clip's audio, and
 * which entry holds it.
 *
 * `libraryEntryId` is where the clip came from. Its analysis gives the clip's
 * tempo, key and beats, and its style and lyrics fill the track header menu.
 * Time/Pitch replaces the clip's audio with a render of it, after which the
 * entry still describes the take but no longer holds what the clip plays. Such
 * a clip is marked `audioRendered`, and `renderTempo` / `renderSemitones` say
 * how far the render sits from the entry, so the tempo and key readouts move
 * with it. Split to stems needs the audio itself, so a rendered clip's audio is
 * imported as its own entry (`stemsEntryId`) and separated from there.
 *
 * An accepted inpaint is saved by the backend as an entry of its own, so the
 * clip points at that entry and is no longer a render of anything.
 *
 * Tested in clipAudioSource.test.ts.
 */
import { pitchClass } from './loomKey';

/** The clip fields this module reads and writes. */
export interface ClipAudioSource {
  libraryEntryId?: string;
  audioRendered?: boolean;
  stemsEntryId?: string;
  renderTempo?: number;
  renderSemitones?: number;
}

/** Time/Pitch replaced the clip's audio with a render at `tempo` x and
 *  `semitones`. The entry stays; the offsets add up over repeated renders, and
 *  the stems entry of the previous audio no longer applies. */
export const timePitchSource = (
  clip: ClipAudioSource,
  tempo: number,
  semitones: number,
): Partial<ClipAudioSource> => ({
  audioRendered: true,
  stemsEntryId: undefined,
  renderTempo: (clip.audioRendered ? clip.renderTempo ?? 1 : 1) * tempo,
  renderSemitones: (clip.audioRendered ? clip.renderSemitones ?? 0 : 0) + semitones,
});

/** The clip now plays exactly the audio of `entryId`. */
export const savedEntrySource = (entryId: string): Partial<ClipAudioSource> => ({
  libraryEntryId: entryId,
  audioRendered: undefined,
  stemsEntryId: undefined,
  renderTempo: undefined,
  renderSemitones: undefined,
});

/** The clip's audio was replaced by audio no library entry holds. The entry
 *  stays as provenance, at the tempo and key the clip already had. */
export const unsavedAudioSource = (): Partial<ClipAudioSource> => ({
  audioRendered: true,
  stemsEntryId: undefined,
});

/** The entry whose audio is the clip's own audio, which Split to stems
 *  separates; null when none is known yet and the clip must be imported. */
export const stemsEntryIdOf = (clip: ClipAudioSource): string | null =>
  (clip.audioRendered ? clip.stemsEntryId : clip.libraryEntryId) ?? null;

/** Where the entry imported from the clip's own audio is recorded, so the next
 *  Split to stems finds it. A rendered clip keeps its provenance entry. */
export const stemsEntryPatch = (clip: ClipAudioSource, entryId: string): Partial<ClipAudioSource> =>
  clip.audioRendered ? { stemsEntryId: entryId } : { libraryEntryId: entryId };

/** Whether the entry's beat list maps onto the clip's audio. A render starts
 *  at the clip's window and runs at its own tempo, so it does not. */
export const entryBeatsFit = (clip: ClipAudioSource): boolean => !clip.audioRendered;

/** The tempo the clip plays at, from its entry's analysed tempo. */
export const entryBpmForClip = (clip: ClipAudioSource, entryBpm: number | null | undefined): number | null => {
  if (!entryBpm || !(entryBpm > 0)) return null;
  return entryBpm * (clip.audioRendered ? clip.renderTempo ?? 1 : 1);
};

/** Note names in the backend analysis's own spelling (analysis/key.py). */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const;

/** `key` moved by `semitones`. The name is returned as given when the shift is a
 *  whole number of octaves, and null when it is not a note name. */
export const transposeKeyName = (key: string, semitones: number): string | null => {
  const shift = ((Math.round(semitones) % 12) + 12) % 12;
  if (shift === 0) return key;
  const pc = pitchClass(key);
  return pc === null ? null : NOTE_NAMES[(pc + shift) % 12];
};

/** The key readout for the clip ('Am', 'F#'), from its entry's analysed key
 *  and scale, moved by any Time/Pitch transpose. Null when unknown. */
export const entryKeyForClip = (
  clip: ClipAudioSource,
  key: string | null | undefined,
  scale: string | null | undefined,
): string | null => {
  if (!key) return null;
  const name = transposeKeyName(key, clip.audioRendered ? clip.renderSemitones ?? 0 : 0);
  if (!name) return null;
  return `${name}${(scale ?? '').toLowerCase().startsWith('min') ? 'm' : ''}`;
};
