/**
 * clipProgram — the General MIDI program a MIDI clip sounds with, and whether it
 * sounds on the drum channel, decided in one place for every path that plays or
 * renders a clip: EDIT's live scheduler, the instrument re-render in the
 * timeline, the piano roll's bounce and a linked roll's audition.
 *
 * The precedence is the clip's own program, else its track's, else the global
 * instrument picker while soundfonts are on. With the picker on Basic or a synth
 * voice and no program on the clip or its track, there is no program: the clip
 * plays the audio it was bounced with.
 *
 * A percussion track's clips play on the drum channel, where the program picks
 * the kit. They never fall back to the picker, whose pick is a melodic
 * instrument and not a kit: with no program of their own they use the Standard
 * kit.
 *
 * A clip with a program of its own may carry the bank that program was chosen
 * in (`instrumentBank`, a roll part's Bank written by the bounce): the voice
 * selects that bank before the program, live and in every render. A bank never
 * applies to a program it was not chosen with (the track's or the picker's),
 * nor on the drum channel, where the kit is chosen by program.
 *
 * A voice picked from a sound bank (lib/bankRegistry) carries the bank's id
 * beside its program and bank select: the clip's `instrumentBankId`, the
 * track's `instrumentBank` and `instrumentBankId`, the picker's active bank.
 * The bank select the voice sends is that bank's offset plus its own bank
 * select, so a user bank's preset plays from the bank it was picked in, live
 * and in every render. Each program carries the bank it was picked with and
 * no other: the clip's, then the track's, then the picker's.
 *
 * No store and no DOM, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';
import { bankSelectFor } from './bankRegistry';

/** The global picker's state, as `useSoundfontStore` holds it. */
export interface GlobalVoice {
  useSoundfont: boolean;
  activeProgram: number;
  /** The bank the picker's program is picked from; absent is the bundled bank. */
  activeBankId?: string;
  /** Its bank select inside that bank; absent is 0. */
  activeBank?: number;
}

export type ProgramClip = Pick<AudioClip, 'instrumentProgram' | 'instrumentBank'> & Partial<Pick<AudioClip, 'instrumentBankId'>>;
export type ProgramTrack = Pick<EditorTrack, 'instrumentProgram' | 'isPercussion'> & Partial<Pick<EditorTrack, 'instrumentBank' | 'instrumentBankId'>>;

/** The General MIDI Standard drum kit. */
export const GM_STANDARD_KIT = 0;

/** The General MIDI drum kits, by program. The names are the bundled soundfont's. */
export const GM_DRUM_KITS: ReadonlyArray<{ program: number; name: string }> = Object.freeze([
  { program: 0, name: 'Standard' },
  { program: 8, name: 'Room' },
  { program: 16, name: 'Power' },
  { program: 24, name: 'Electronic' },
  { program: 25, name: '808/909' },
  { program: 26, name: 'Dance' },
  { program: 32, name: 'Jazz' },
  { program: 40, name: 'Brush' },
  { program: 48, name: 'Orchestral' },
  { program: 56, name: 'SFX' },
]);

/** A kit's name, or "Kit n" for a program the bundled soundfont has no kit at. */
export const drumKitName = (program: number): string =>
  GM_DRUM_KITS.find((k) => k.program === program)?.name ?? `Kit ${program + 1}`;

export const isPercussionTrack = (track: ProgramTrack | null | undefined): boolean => track?.isPercussion === true;

/** The program a clip sounds with, or undefined when it has none and plays its bounce. */
export function effectiveProgramFor(
  clip: ProgramClip,
  track: ProgramTrack | null | undefined,
  global: GlobalVoice,
): number | undefined {
  if (isPercussionTrack(track)) return clip.instrumentProgram ?? track?.instrumentProgram ?? GM_STANDARD_KIT;
  return clip.instrumentProgram ?? track?.instrumentProgram ?? (global.useSoundfont ? global.activeProgram : undefined);
}

/** A clip's voice: its program (effectiveProgramFor), whether it is on the drum channel, and the bank its own program is selected in (absent: 0). */
export interface ClipVoice {
  program: number | undefined;
  percussion: boolean;
  /** Bank select (MSB) sent before the program, 1-127; absent for bank 0, the General MIDI set. */
  bank?: number;
}

/**
 * The bank select a clip's voice sends on a melodic track: its own program's
 * bank (instrumentBank in instrumentBankId, at that bank's offset), else the
 * track's program's, else 0. A drum track selects none: a kit is chosen by
 * its program.
 */
export const clipBank = (clip: ProgramClip, track: ProgramTrack | null | undefined): number => {
  if (isPercussionTrack(track)) return 0;
  if (clip.instrumentProgram !== undefined) return bankSelectFor(clip.instrumentBankId, clip.instrumentBank);
  if (track?.instrumentProgram !== undefined) return bankSelectFor(track.instrumentBankId, track.instrumentBank);
  return 0;
};

/** The bank select the global picker's program sends. */
export const globalBank = (global: GlobalVoice): number => bankSelectFor(global.activeBankId, global.activeBank);

export function clipVoice(clip: ProgramClip, track: ProgramTrack | null | undefined, global: GlobalVoice): ClipVoice {
  const fromPicker = !isPercussionTrack(track) && clip.instrumentProgram === undefined && track?.instrumentProgram === undefined;
  const bank = fromPicker ? (global.useSoundfont ? globalBank(global) : 0) : clipBank(clip, track);
  return { program: effectiveProgramFor(clip, track, global), percussion: isPercussionTrack(track), ...(bank > 0 ? { bank } : {}) };
}

/**
 * The voice the piano roll auditions and renders with. A roll linked to an
 * EDIT clip (`editingClipId`) plays through that clip's voice, so what the roll
 * sounds is what EDIT plays. An unlinked roll, or one whose clip is gone, plays
 * its own program (`rollProgram`, the roll store's voiceProgram) when it has
 * one, else the global picker's (none on Basic or a synth voice).
 */
export function rollVoice(
  editingClipId: string | null,
  clips: ReadonlyArray<ProgramClip & Pick<AudioClip, 'id' | 'trackId'>>,
  tracks: ReadonlyArray<ProgramTrack & Pick<EditorTrack, 'id'>>,
  global: GlobalVoice,
  rollProgram: number | null = null,
): ClipVoice {
  const clip = editingClipId ? clips.find((c) => c.id === editingClipId) : undefined;
  if (!clip) {
    if (rollProgram !== null) return { program: rollProgram, percussion: false };
    const bank = global.useSoundfont ? globalBank(global) : 0;
    return { program: global.useSoundfont ? global.activeProgram : undefined, percussion: false, ...(bank > 0 ? { bank } : {}) };
  }
  return clipVoice(clip, tracks.find((t) => t.id === clip.trackId), global);
}

/** The clip fields that record a render made with `voice`: its program, its drum channel and its bank. */
export function renderedVoiceFields(voice: ClipVoice): Pick<AudioClip, 'renderedProgram' | 'renderedPercussion' | 'renderedBank'> {
  return {
    renderedProgram: voice.program,
    renderedPercussion: voice.percussion ? true : undefined,
    renderedBank: voice.bank ? voice.bank : undefined,
  };
}

/**
 * True when a MIDI clip's bounced audio was rendered with a voice other than
 * the one it now has, so every offline bounce would disagree with live
 * playback. A clip with no program plays its bounce as it was rendered, so it
 * is never stale.
 */
export function clipRenderIsStale(
  clip: ProgramClip & Pick<AudioClip, 'renderedProgram' | 'renderedPercussion' | 'renderedBank'>,
  track: ProgramTrack | null | undefined,
  global: GlobalVoice,
): boolean {
  const voice = clipVoice(clip, track, global);
  if (voice.program === undefined) return false;
  return (
    voice.program !== clip.renderedProgram
    || voice.percussion !== (clip.renderedPercussion === true)
    || (voice.bank ?? 0) !== (clip.renderedBank ?? 0)
  );
}
