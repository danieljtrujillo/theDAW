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
 * A MIDI cell renders with its own column's voice, decided as EDIT decides a
 * clip's (lib/clipProgram `clipVoice`): the clip's program, else its track's,
 * else the global instrument picker's; the bank each program was picked in; and
 * a drum track's notes on the drum channel, where the program is the kit.
 *
 * Pure, so node tests load it.
 */
import type { DawClip, DawTrack } from './dawImportClient';
import type { RenderNote, RenderOptions } from './midiSynth';
import { clipVoice, type ClipVoice, type GlobalVoice } from './clipProgram';
import { DRUM_CHANNEL } from './editChannels';

type CellClip = Pick<DawClip, 'start_time' | 'end_time' | 'offset_into_source' | 'file_path' | 'loop_on'>;

/** The end of a cell's window in its source: the trim point plus the clip's length. */
export const cellWindowEndSec = (clip: CellClip): number =>
  Math.max(0, clip.offset_into_source ?? 0) + Math.max(0, (clip.end_time ?? 0) - (clip.start_time ?? 0));

/** How a MIDI cell's notes render. */
export const sessionMidiRenderOptions = (clip: CellClip): RenderOptions => ({ minDurationSec: cellWindowEndSec(clip) });

type VoiceClip = Pick<DawClip, 'instrument_program' | 'instrument_bank' | 'instrument_bank_id'>;
type VoiceTrack = Pick<DawTrack, 'instrument_program' | 'instrument_bank' | 'instrument_bank_id' | 'is_percussion'>;

const given = <T>(v: T | null | undefined): T | undefined => (v === null ? undefined : v);

/** The voice a MIDI cell sounds with: its clip's program, else its column's, else the picker's. */
export function sessionCellVoice(clip: VoiceClip, track: VoiceTrack | null | undefined, global: GlobalVoice): ClipVoice {
  return clipVoice(
    {
      instrumentProgram: given(clip.instrument_program),
      instrumentBank: given(clip.instrument_bank),
      instrumentBankId: given(clip.instrument_bank_id),
    },
    track
      ? {
          instrumentProgram: given(track.instrument_program),
          isPercussion: track.is_percussion === true,
          instrumentBank: given(track.instrument_bank),
          instrumentBankId: given(track.instrument_bank_id),
        }
      : null,
    global,
  );
}

/** A MIDI cell's render: its notes (on the drum channel for a drum column), the
 *  options naming its voice, and the voice itself. */
export function sessionMidiRender(
  clip: CellClip & VoiceClip,
  track: VoiceTrack | null | undefined,
  notes: readonly RenderNote[],
  global: GlobalVoice,
): { notes: RenderNote[]; options: RenderOptions; voice: ClipVoice } {
  const voice = sessionCellVoice(clip, track, global);
  return {
    notes: voice.percussion ? notes.map((n) => ({ ...n, channel: DRUM_CHANNEL })) : [...notes],
    options: {
      ...sessionMidiRenderOptions(clip),
      ...(voice.program !== undefined ? { program: voice.program } : {}),
      ...(voice.bank ? { bank: voice.bank } : {}),
    },
    voice,
  };
}

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
