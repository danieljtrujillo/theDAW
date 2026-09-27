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
 * Type imports only, so node tests load it.
 */
import type { AudioClip, EditorTrack } from '../state/editorStore';

/** The global picker's state, as `useSoundfontStore` holds it. */
export interface GlobalVoice {
  useSoundfont: boolean;
  activeProgram: number;
}

export type ProgramClip = Pick<AudioClip, 'instrumentProgram'>;
export type ProgramTrack = Pick<EditorTrack, 'instrumentProgram' | 'isPercussion'>;

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

/** A clip's voice: its program (effectiveProgramFor) and whether it is on the drum channel. */
export interface ClipVoice {
  program: number | undefined;
  percussion: boolean;
}

export function clipVoice(clip: ProgramClip, track: ProgramTrack | null | undefined, global: GlobalVoice): ClipVoice {
  return { program: effectiveProgramFor(clip, track, global), percussion: isPercussionTrack(track) };
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
  if (!clip) return { program: rollProgram ?? (global.useSoundfont ? global.activeProgram : undefined), percussion: false };
  return clipVoice(clip, tracks.find((t) => t.id === clip.trackId), global);
}

/** The clip fields that record a render made with `voice`. */
export function renderedVoiceFields(voice: ClipVoice): Pick<AudioClip, 'renderedProgram' | 'renderedPercussion'> {
  return { renderedProgram: voice.program, renderedPercussion: voice.percussion ? true : undefined };
}

/**
 * True when a MIDI clip's bounced audio was rendered with a voice other than
 * the one it now has, so every offline bounce would disagree with live
 * playback. A clip with no program plays its bounce as it was rendered, so it
 * is never stale.
 */
export function clipRenderIsStale(
  clip: ProgramClip & Pick<AudioClip, 'renderedProgram' | 'renderedPercussion'>,
  track: ProgramTrack | null | undefined,
  global: GlobalVoice,
): boolean {
  const voice = clipVoice(clip, track, global);
  if (voice.program === undefined) return false;
  return voice.program !== clip.renderedProgram || voice.percussion !== (clip.renderedPercussion === true);
}
