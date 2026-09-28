/**
 * voiceOptions — one select for a track's voice, melodic instruments and drum
 * kits together.
 *
 * A GM program means an instrument on a melodic track and a kit on a drum
 * track, so a select that lists both has to say which one an option is. An
 * option's value is `gm:N` for melodic program N, `kit:N` for drum kit N, or
 * `default`. Choosing an option of the other kind flips the track's drum flag
 * (editorStore setTrackVoice). A bare number, the value these selects wrote
 * before, reads as a program of the track's current kind.
 *
 * Type imports only, so node tests load it.
 */

export interface VoicePick {
  /** The GM program, or undefined for the default instrument or kit. */
  program: number | undefined;
  /** True for a drum kit (the GM drum channel), false for a melodic instrument. */
  drums: boolean;
}

export const DEFAULT_VOICE_VALUE = 'default';

/** The option value for a program of a kind. */
export const voiceValue = (program: number | null | undefined, drums: boolean): string =>
  program === undefined || program === null ? DEFAULT_VOICE_VALUE : `${drums ? 'kit' : 'gm'}:${program}`;

/** What an option value picks; `currentDrums` is the track's flag, which the default and a bare number keep. */
export function parseVoiceValue(value: string, currentDrums: boolean): VoicePick {
  const m = /^(gm|kit):(\d{1,3})$/.exec(value);
  if (m) return { program: Math.max(0, Math.min(127, Number(m[2]))), drums: m[1] === 'kit' };
  const n = Number(value);
  if (value !== '' && Number.isInteger(n) && n >= 0 && n <= 127) return { program: n, drums: currentDrums };
  return { program: undefined, drums: currentDrums };
}
