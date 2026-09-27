/**
 * clipRenderWindow — where a MIDI clip's timeline window goes when its audio
 * is rendered again.
 *
 * A soundfont render lasts the clip's nominal length plus the ring-out of its
 * last notes (lib/renderTail), so a new render is rarely as long as the one it
 * replaces: a capture lands with the length of its notes, and an instrument
 * change from piano to strings adds a second of release. A clip that shows its
 * whole source (from the source's first second to its last) follows the new
 * render, so the ring-out is on the timeline and in playback and every export.
 * A clip the user trimmed keeps its window, shortened only where the new source
 * ends before it.
 *
 * Pure, so node tests load it.
 */
import type { AudioClip } from '../state/editorStore';

/** Seconds two lengths may differ by and still be the same length. */
const SAME_SEC = 1e-3;

export type RenderWindowClip = Pick<AudioClip, 'durationSec' | 'sourceDuration' | 'offsetIntoSource' | 'timeStretchRate'>;

const rateOf = (clip: RenderWindowClip): number =>
  clip.timeStretchRate !== undefined && Number.isFinite(clip.timeStretchRate) && clip.timeStretchRate > 0 ? clip.timeStretchRate : 1;

/** True when the clip plays its source from the first second to the last. */
export function showsWholeSource(clip: RenderWindowClip): boolean {
  return (
    Math.abs(clip.offsetIntoSource ?? 0) <= SAME_SEC &&
    Math.abs(clip.durationSec * rateOf(clip) - clip.sourceDuration) <= SAME_SEC
  );
}

/** The window fields to write with a render `renderedSec` long. */
export function renderedWindowFields(
  clip: RenderWindowClip,
  renderedSec: number,
): Pick<AudioClip, 'sourceDuration'> & Partial<Pick<AudioClip, 'durationSec'>> {
  const rate = rateOf(clip);
  if (showsWholeSource(clip)) return { sourceDuration: renderedSec, durationSec: renderedSec / rate };
  const room = Math.max(0, renderedSec - (clip.offsetIntoSource ?? 0)) / rate;
  return clip.durationSec > room ? { sourceDuration: renderedSec, durationSec: room } : { sourceDuration: renderedSec };
}
