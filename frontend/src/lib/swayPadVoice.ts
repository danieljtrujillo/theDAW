/**
 * swayPadVoice — what a Sway pad plays in each pad mode: the preview-synth
 * channel, the program and the note.
 *
 *   drums  the General MIDI drum channel with the Standard kit, the pads laid
 *          out MPC-style.
 *   track  the selected EDIT track's voice (lib/clipProgram): its instrument,
 *          else the global picker's, as pitched notes; on a drum track its kit
 *          on the drum channel with the drum layout, since a drum track's
 *          program is a kit number and would otherwise play an unrelated
 *          instrument.
 *   piano  the Acoustic Grand.
 *
 * With sustain (latch) on, a melodic pad plays a sustaining organ so a held
 * pad rings until it is pressed again; drums are hits and keep their kit.
 *
 * Pure, so node tests load it.
 */
import { clipVoice, GM_STANDARD_KIT, type GlobalVoice, type ProgramTrack } from './clipProgram';
import { DRUM_CHANNEL } from './editChannels';
import type { SwayPadMode } from '../state/swaySurfaceStore';

/** The lowest pad's note on the Sway (16 pads, notes 24-39). */
export const PAD_LO = 24;
/** 16 pads -> General MIDI percussion, MPC-style layout. */
export const GM_DRUM_FOR_PAD: readonly number[] = Object.freeze([
  36, 38, 42, 46, // kick, snare, closed hat, open hat
  41, 45, 48, 39, // low/mid/high tom, hand clap
  37, 56, 54, 51, // rim shot, cowbell, tambourine, ride
  49, 55, 70, 63, // crash, splash, maracas, high conga
]);
/** Preview-synth channel for "selected track instrument" pad mode. */
export const TRACK_PAD_CH = 0;
/** Preview-synth channel for "piano" pad mode (GM Acoustic Grand). */
export const PIANO_PAD_CH = 1;
/** GM Drawbar Organ — rings forever while a note is on. */
export const SUSTAIN_PROGRAM = 16;

export interface PadVoice {
  channel: number;
  program: number;
  note: number;
}

/** The voice pad `padIdx` (0-15) plays. `track` is the selected EDIT track (track mode only). */
export function swayPadVoice(
  mode: SwayPadMode,
  padIdx: number,
  sustain: boolean,
  track: ProgramTrack | null | undefined,
  global: GlobalVoice,
): PadVoice {
  const drumNote = GM_DRUM_FOR_PAD[Math.max(0, Math.min(GM_DRUM_FOR_PAD.length - 1, padIdx))];
  if (mode === 'drums') return { channel: DRUM_CHANNEL, program: GM_STANDARD_KIT, note: drumNote };
  if (mode === 'track') {
    const voice = clipVoice({}, track, global);
    if (voice.percussion) return { channel: DRUM_CHANNEL, program: voice.program ?? GM_STANDARD_KIT, note: drumNote };
    return { channel: TRACK_PAD_CH, program: sustain ? SUSTAIN_PROGRAM : (voice.program ?? 0), note: PAD_LO + padIdx };
  }
  return { channel: PIANO_PAD_CH, program: sustain ? SUSTAIN_PROGRAM : 0, note: PAD_LO + padIdx };
}
