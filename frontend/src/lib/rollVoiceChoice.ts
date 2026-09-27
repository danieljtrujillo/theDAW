/**
 * rollVoiceChoice — where a voice chosen for the piano roll lands.
 *
 * The Vocal2MIDI panel's Roll voice select and its assistant's instrument
 * choice pick the voice the roll plays. A roll linked to an EDIT clip plays
 * that clip's voice (lib/clipProgram rollVoice), so there the choice sets the
 * clip's TRACK instrument, the program every clip on the track follows, and
 * EDIT's instrument sync re-renders the clip through it. A clip that carries a
 * program of its own sounds that one over its track's, so the choice sets it
 * too. Both writes are one EDIT undo step. An unlinked roll, or one whose clip
 * is gone, keeps the choice as its own voice (pianoRollStore voiceProgram).
 * `null` is "follow the instrument picker" either way.
 */
import { useEditorStore, type AudioClip, type EditorTrack } from '../state/editorStore';
import { usePianoRollStore } from '../state/pianoRollStore';
import { isPercussionTrack } from './clipProgram';

/** The EDIT clip the roll is linked to and its track, or null when the roll is unlinked or its clip is gone. */
export function linkedRollTarget(
  editingClipId: string | null,
  clips: readonly AudioClip[],
  tracks: readonly EditorTrack[],
): { clip: AudioClip; track: EditorTrack } | null {
  const clip = editingClipId ? clips.find((c) => c.id === editingClipId) : undefined;
  const track = clip ? tracks.find((t) => t.id === clip.trackId) : undefined;
  return clip && track ? { clip, track } : null;
}

/** What the Roll voice select shows: the linked clip's program (its own, else
 *  its track's), or the roll's own; null when it follows the picker. */
export interface RollVoiceChoice {
  /** The linked clip's track, or null for the roll's own voice. */
  track: EditorTrack | null;
  /** True when the linked track is a drum track, so a program is a kit. */
  drums: boolean;
  program: number | null;
}

export function rollVoiceChoice(
  editingClipId: string | null,
  clips: readonly AudioClip[],
  tracks: readonly EditorTrack[],
  rollProgram: number | null,
): RollVoiceChoice {
  const linked = linkedRollTarget(editingClipId, clips, tracks);
  if (!linked) return { track: null, drums: false, program: rollProgram };
  return {
    track: linked.track,
    drums: isPercussionTrack(linked.track),
    program: linked.clip.instrumentProgram ?? linked.track.instrumentProgram ?? null,
  };
}

/**
 * Put the roll on `program` (null: the instrument picker). Returns where it
 * landed: `track` for a linked roll, `roll` for an unlinked one.
 */
export function chooseRollVoice(program: number | null): 'track' | 'roll' {
  const value = program === null || !Number.isFinite(program) ? undefined : Math.max(0, Math.min(127, Math.round(program)));
  const editor = useEditorStore.getState();
  const linked = linkedRollTarget(usePianoRollStore.getState().editingClipId, editor.clips, editor.tracks);
  if (!linked) {
    usePianoRollStore.getState().setVoiceProgram(value ?? null);
    return 'roll';
  }
  editor.undoGroup(() => {
    editor.updateTrack(linked.track.id, { instrumentProgram: value });
    if (linked.clip.instrumentProgram !== undefined) editor.updateClip(linked.clip.id, { instrumentProgram: value });
  });
  return 'track';
}
