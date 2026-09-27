/**
 * rollBounce — the piano roll's EDIT key: render the roll's notes and put them
 * on the EDIT timeline.
 *
 * A roll linked to an EDIT clip (`editingClipId`) re-renders that clip in place
 * through the clip's own voice (lib/clipProgram rollVoice). An unlinked roll,
 * or one whose clip is gone, renders through its own program (the Vocal2MIDI
 * panel's voice) or else the global picker's, and lands on a new track that
 * holds that program, so changing the picker later does not re-voice the part. Either way the clip records the voice its audio
 * was rendered with (`renderedProgram`, `renderedPercussion`), so EDIT's
 * instrument sync sees the audio is current.
 *
 * The render and the peak scan are passed in (PianoRoll gives lib/midiSynth and
 * editorStore's), so node tests replay a bounce against the real stores.
 */
import { useEditorStore } from '../state/editorStore';
import { usePianoRollStore } from '../state/pianoRollStore';
import { renderedVoiceFields, rollVoice, type GlobalVoice } from './clipProgram';
import { unrollLanes } from './meterMap';
import { rollRenderBends, type RollRenderBends } from './pitchBend';
import { rollClipFields } from './rollClip';

export interface RollBounceDeps {
  /** lib/midiSynth renderStepNotesToBlob. */
  render: (
    notes: Array<{ note: number; velocity: number; step: number; length: number; lane?: number }>,
    bpm: number,
    totalSteps: number,
    opts: { program?: number; percussion?: boolean; bends?: RollRenderBends },
  ) => Promise<{ blob: Blob; duration: number }>;
  /** editorStore computePeaks. */
  computePeaks: (blob: Blob, bins?: number) => Promise<{ peaks: Float32Array }>;
  /** The global picker's state (soundfontEngine getGlobalVoice). */
  global: () => GlobalVoice;
}

export interface RollBounceResult {
  /** `updated` re-rendered the linked clip; `created` added a clip on a new track. */
  kind: 'updated' | 'created';
  clipId: string;
  duration: number;
  noteCount: number;
}

/** Bounce the roll to EDIT. Resolves null when the roll has no notes. */
export async function bounceRollToEditor(deps: RollBounceDeps): Promise<RollBounceResult | null> {
  const roll = usePianoRollStore.getState();
  const { bpm, totalSteps, editingClipId } = roll;
  if (roll.notes.length === 0) return null;
  // The editor plays a clip's notes once, so it gets the lane repeats written
  // out (sourcePianoRoll). The roll's own notes, meter map, pickup, lanes and
  // bends are copied beside them, so re-editing later sees the exact same state.
  const fields = rollClipFields(roll);
  const noteCount = fields.sourcePianoRoll.length;
  const before = useEditorStore.getState();
  const voice = rollVoice(editingClipId, before.clips, before.tracks, deps.global(), roll.voiceProgram);
  // Each note renders in its own lane, so a lane's pitch bend bends its notes in the audio too.
  const { blob, duration } = await deps.render(unrollLanes(roll.notes, roll.lanes, totalSteps), bpm, totalSteps, {
    program: voice.program,
    percussion: voice.percussion,
    bends: rollRenderBends(roll.bends, roll.lanes, totalSteps),
  });
  const { peaks } = await deps.computePeaks(blob, 240);
  const editor = useEditorStore.getState();

  if (editingClipId) {
    const existing = editor.clips.find((c) => c.id === editingClipId);
    if (existing) {
      editor.updateClip(editingClipId, {
        audioBlob: blob,
        mimeType: 'audio/wav',
        sourceDuration: duration,
        durationSec: duration,
        offsetIntoSource: 0,
        peaks,
        ...fields,
        ...renderedVoiceFields(voice),
        sourceKind: 'piano-roll',
        label: existing.label.startsWith('roll_') ? `roll_${bpm}bpm_${noteCount}n` : existing.label,
      });
      return { kind: 'updated', clipId: editingClipId, duration, noteCount };
    }
    // The clip the roll was bound to is gone — fall through to create a new one.
    usePianoRollStore.getState().setEditingClip(null);
  }

  // Here the voice is the roll's own or the picker's (rollVoice found no linked clip).
  const trackId = editor.addTrack({ name: `Piano ${bpm} BPM`, instrumentProgram: voice.program });
  const trackColor = useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#a855f7';
  const clipId = editor.addClipToTrack({
    trackId,
    label: `roll_${bpm}bpm_${noteCount}n`,
    audioBlob: blob,
    mimeType: 'audio/wav',
    sourceDuration: duration,
    offsetIntoSource: 0,
    durationSec: duration,
    startSec: 0,
    color: trackColor,
    sourceKind: 'piano-roll',
    ...fields,
    ...renderedVoiceFields(voice),
  });
  editor.cachePeaks(clipId, peaks);
  // Bind the roll to the new clip so subsequent Send-to-Editor edits in place.
  usePianoRollStore.getState().setEditingClip(clipId);
  return { kind: 'created', clipId, duration, noteCount };
}
