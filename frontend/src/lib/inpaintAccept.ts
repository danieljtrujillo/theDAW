/**
 * inpaintAccept — what Accept writes onto a clip when an EDIT inpaint result
 * comes back, and when it must refuse.
 *
 * submitInpaint sends the model only the clip's visible window: cropAudioBlob
 * cuts [offsetIntoSource, offsetIntoSource + durationSec) out of the source. The
 * result therefore starts at the window's first sample and is the window's
 * length, and the accepted clip plays it from 0. Accept used to write the blob
 * alone, so a trimmed or split clip kept its old offset and sourceDuration and
 * read the short result at the wrong place (or only its last 10 ms, once the
 * playback clamp kicked in). The patch below resets the offset and takes both
 * durations from the decoded result.
 *
 * The job runs while the timeline stays editable. The result was cut for the
 * window and the audio the clip had at submit, so Accept refuses when either has
 * changed since or the clip is gone. Moving the clip along the timeline or to
 * another lane keeps its window and its audio, so the result still fits it.
 *
 * The backend saves every generate job's result as the library entry
 * `<job id>_00` before it reports the job done, so the accepted clip points at
 * that entry (inpaintResultEntryId) and nothing is imported a second time.
 *
 * The component decodes the result and reads the entry, this module decides;
 * what a library entry means to a clip is lib/clipAudioSource's.
 * Tested in inpaintAccept.test.ts.
 */
import { savedEntrySource, unsavedAudioSource, type ClipAudioSource } from './clipAudioSource';

/** The parts of a timeline clip the accept decision reads. */
export interface InpaintClipLike {
  id: string;
  offsetIntoSource: number;
  durationSec: number;
  /** Compared by identity: any edit that replaces the clip's audio (Time/Pitch,
   *  another accept) makes a new Blob, and undo restores the old instance. */
  audioBlob: unknown;
}

/** The clip as it was when the crop was cut, carried through the job. */
export interface InpaintSnapshot {
  clipId: string;
  offsetIntoSource: number;
  durationSec: number;
  audioBlob: unknown;
}

/** Window drift below this is float noise from a drag, not an edit. */
const WINDOW_EPSILON_SEC = 1e-3;

export const snapshotInpaintClip = (clip: InpaintClipLike): InpaintSnapshot => ({
  clipId: clip.id,
  offsetIntoSource: clip.offsetIntoSource,
  durationSec: clip.durationSec,
  audioBlob: clip.audioBlob,
});

export interface RenderedWindowGeometry {
  offsetIntoSource: 0;
  sourceDuration: number;
  durationSec: number;
}

/** Geometry for a clip whose audio was just replaced by a render of its own
 *  window. The render starts at the window's first sample and is the whole
 *  source now, so the offset resets and both lengths are the render's. Shared
 *  by the inpaint accept and Time/Pitch. */
export const renderedWindowGeometry = (durationSec: number): RenderedWindowGeometry => ({
  offsetIntoSource: 0,
  sourceDuration: durationSec,
  durationSec,
});

export type InpaintAcceptPatch = RenderedWindowGeometry & Partial<ClipAudioSource>;

/** Narrow with `ok === true` / `ok === false`: the app's tsconfig is not
 *  strict, and a bare `!res.ok` does not narrow the union there. */
export type InpaintAcceptResolution =
  | { ok: true; patch: InpaintAcceptPatch }
  | { ok: false; reason: string };

/** The library entry id the backend saves a single-take generate job's result
 *  under (server.py, the post-save library sync; MAKE reads the same id). */
export const inpaintResultEntryId = (jobId: string): string => `${jobId}_00`;

/** `savedEntryId` is the library entry holding the result, or null when the
 *  backend has none for it. */
export function resolveInpaintAccept(
  clipNow: InpaintClipLike | undefined,
  snapshot: InpaintSnapshot,
  decodedDurationSec: number,
  savedEntryId: string | null,
): InpaintAcceptResolution {
  if (!clipNow || clipNow.id !== snapshot.clipId) {
    return {
      ok: false,
      reason: 'The clip this was made for is gone. Undo the delete to accept it, or reject it.',
    };
  }
  if (clipNow.audioBlob !== snapshot.audioBlob) {
    return {
      ok: false,
      reason:
        "The clip's audio was replaced while this generated (Time/Pitch or another inpaint). " +
        'Undo that change to accept it, or reject it and inpaint again.',
    };
  }
  if (
    Math.abs(clipNow.offsetIntoSource - snapshot.offsetIntoSource) > WINDOW_EPSILON_SEC ||
    Math.abs(clipNow.durationSec - snapshot.durationSec) > WINDOW_EPSILON_SEC
  ) {
    return {
      ok: false,
      reason:
        'The clip was trimmed or split while this generated, so the result no longer lines up with it. ' +
        'Undo that edit to accept it, or reject it and inpaint again.',
    };
  }
  if (!(decodedDurationSec > 0)) {
    return { ok: false, reason: 'The result decoded to no audio. Reject it and generate again.' };
  }
  // The saved entry holds the result, so its analysis and its stems are the
  // clip's. Without one the clip keeps its entry as provenance, marked as
  // playing audio that entry does not hold: Split to stems then separates the
  // result itself, never the entry's audio from before the inpaint.
  const source = savedEntryId ? savedEntrySource(savedEntryId) : unsavedAudioSource();
  return { ok: true, patch: { ...renderedWindowGeometry(decodedDurationSec), ...source } };
}
