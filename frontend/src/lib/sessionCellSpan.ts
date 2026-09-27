/**
 * sessionCellSpan — what part of its audio a Perform-grid cell plays.
 *
 * A cell is a WINDOW onto its sample: it starts at the trim point and runs for
 * the clip's own length, not the file's, and loops over that window when Live
 * says it loops. A MIDI cell has no file: its notes are rendered, at least to
 * the end of the window so a loop with rests after its last note keeps its
 * length, and with no fixed tail so the render rings for its instrument's
 * release (lib/renderTail). A one-shot MIDI cell whose notes all start inside
 * the window plays that ring-out past the window, as a DAW lets a released
 * note ring after its clip ends; past the window that render holds nothing
 * else.
 *
 * Pure, so node tests load it.
 */
import type { DawClip } from './dawImportClient';
import type { RenderNote, RenderOptions } from './midiSynth';

type CellClip = Pick<DawClip, 'start_time' | 'end_time' | 'offset_into_source' | 'file_path' | 'loop_on'>;

/** The end of a cell's window in its source: the trim point plus the clip's length. */
export const cellWindowEndSec = (clip: CellClip): number =>
  Math.max(0, clip.offset_into_source ?? 0) + Math.max(0, (clip.end_time ?? 0) - (clip.start_time ?? 0));

/** How a MIDI cell's notes render. */
export const sessionMidiRenderOptions = (clip: CellClip): RenderOptions => ({ minDurationSec: cellWindowEndSec(clip) });

export interface CellSpan {
  /** Seconds into the audio the cell starts at. */
  offset: number;
  /** Seconds a one-shot plays for (a looping cell ignores it). */
  duration: number;
  /** Seconds of source one pass of the cell covers: its window, without the
   *  ring-out, which is what a follow action counts plays by. */
  passSec: number;
  /** The loop's end in the audio, or null for a one-shot. */
  loopEnd: number | null;
}

/** The span of `bufferSec` of audio a cell plays. `notes` are a MIDI cell's (empty for an audio cell). */
export function sessionCellSpan(clip: CellClip, bufferSec: number, notes: readonly RenderNote[]): CellSpan {
  const maxOffset = Math.max(0, bufferSec - 0.01);
  const offset = Math.min(Math.max(0, clip.offset_into_source ?? 0), maxOffset);
  const span = Math.max(0, (clip.end_time ?? 0) - (clip.start_time ?? 0));
  const available = Math.max(0, bufferSec - offset);
  const passSec = span > 0.02 ? Math.min(span, available) : available;
  const ringsOut = !clip.file_path && !clip.loop_on && notes.every((n) => n.startSec < cellWindowEndSec(clip));
  const duration = ringsOut ? available : passSec;
  // `loop_on == null` means the set didn't say, so it plays as a one-shot
  // rather than looping material never meant to repeat.
  const loopEnd = clip.loop_on ? Math.min(bufferSec, offset + (duration || available)) : null;
  return { offset, duration, passSec: passSec || available, loopEnd };
}
