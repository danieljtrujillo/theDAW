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
 * is gone, keeps the choice as its own voice (pianoRollStore voiceProgram), one
 * roll undo step, and the project turns dirty since a .tasmo saves it.
 * `null` is "follow the instrument picker" either way.
 *
 * A roll of several parts: the choice lands on the ACTIVE part. When that part
 * has a program of its own (the parts column's Sound), the choice replaces it,
 * one roll undo step; otherwise it goes where it always went, as above.
 */
import { useEditorStore, type AudioClip, type EditorTrack } from '../state/editorStore';
import { activeTrackOf, usePianoRollStore } from '../state/pianoRollStore';
import { isPercussionTrack } from './clipProgram';
import { isPercussionPart } from './rollTracks';

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
  part: { program: number | null; channel: number | null } | null = null,
): RollVoiceChoice {
  // The active part's own program comes first: it is what the part plays.
  if (part && part.program !== null) return { track: null, drums: isPercussionPart(part), program: part.program };
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
 * landed: `part` for an active part with a program of its own, `track` for a
 * linked roll, `roll` for an unlinked one.
 *
 * `drums` says what the program is: true for a drum kit, false for a melodic
 * instrument. On a linked roll a choice of the other kind than the linked
 * track flips its drum flag (editorStore setTrackVoice, with a LOG line), so a
 * melodic instrument chosen for a drum track turns drums off; on an active
 * part with a program of its own it moves the part onto the percussion channel
 * or off it (pianoRollStore setTrackProgram). Left out, the program keeps the
 * track's or the part's kind, as before. An unlinked roll has no drum flag and
 * ignores it.
 */
export function chooseRollVoice(program: number | null, drums?: boolean): 'part' | 'track' | 'roll' {
  const value = program === null || !Number.isFinite(program) ? undefined : Math.max(0, Math.min(127, Math.round(program)));
  const roll = usePianoRollStore.getState();
  const part = activeTrackOf(roll);
  if (part.program !== null) {
    // A kit goes on the percussion channel and a melodic instrument off it; left out, the part keeps its channel.
    roll.setTrackProgram(part.id, value ?? null, drums);
    return 'part';
  }
  const editor = useEditorStore.getState();
  const linked = linkedRollTarget(roll.editingClipId, editor.clips, editor.tracks);
  if (!linked) {
    usePianoRollStore.getState().setVoiceProgram(value ?? null);
    return 'roll';
  }
  const kind = drums ?? isPercussionTrack(linked.track);
  editor.undoGroup(() => {
    editor.setTrackVoice(linked.track.id, value, kind);
    // A flip clears the clip's own program; one of the same kind is set with the track's.
    // The bank the old program was chosen in goes with it (lib/clipProgram clipBank).
    const clip = useEditorStore.getState().clips.find((c) => c.id === linked.clip.id);
    if (clip && clip.instrumentProgram !== undefined) editor.updateClip(clip.id, { instrumentProgram: value, instrumentBank: undefined });
  });
  return 'track';
}
