/**
 * clipRerender — re-render an EDIT MIDI clip's audio through the voice it now
 * has.
 *
 * Live playback synthesises a MIDI clip from its note list and honours its
 * program, but every offline bounce reads the pre-rendered `audioBlob`. So
 * without this, assigning "Cello" to a clip made it PLAY cello and EXPORT
 * whatever was selected when it was inserted. WaveformEditor runs this for
 * every clip whose render is stale (lib/clipProgram clipRenderIsStale), which
 * keeps the blob and the voice in step for every export path at once.
 *
 * The new render rings out for the new instrument's release, so an untrimmed
 * clip takes the new render's length (lib/clipRenderWindow).
 *
 * The render, the peak scan, the picker and the soundfont warm-up are passed
 * in (WaveformEditor gives lib/midiSynth, editorStore and soundfontEngine's),
 * so node tests replay a re-render against the real editor store.
 */
import { useEditorStore } from '../state/editorStore';
import { clipRenderIsStale, clipVoice, renderedVoiceFields, type GlobalVoice } from './clipProgram';
import { renderedWindowFields } from './clipRenderWindow';
import { roundUpToBar } from './meterMap';
import type { RollRenderBends } from './pitchBend';
import { clipRenderInput } from './rollClip';

export interface ClipRerenderDeps {
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
  /** soundfontEngine ensureSoundfontReady, awaited before the render. */
  ensureReady: () => Promise<unknown>;
}

const voiceNow = (clipId: string, global: GlobalVoice) => {
  const { clips, tracks } = useEditorStore.getState();
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) return null;
  const track = tracks.find((t) => t.id === clip.trackId);
  return { clip, track, voice: clipVoice(clip, track, global) };
};

/**
 * Re-render `clipId` when its audio was rendered with another voice than it
 * now has. Resolves true when a new render was written, false when there was
 * nothing to do or the clip changed voice or went away mid-render. Rejects
 * when the render fails, leaving the clip as it was.
 */
export async function rerenderStaleMidiClip(clipId: string, deps: ClipRerenderDeps): Promise<boolean> {
  const before = voiceNow(clipId, deps.global());
  if (!before) return false;
  const { clip, track, voice } = before;
  if (clip.sourceKind !== 'piano-roll' || !clip.sourcePianoRoll?.length) return false;
  if (!clipRenderIsStale(clip, track, deps.global())) return false;
  await deps.ensureReady();
  const bpm = clip.sourceBpm ?? useEditorStore.getState().bpm;
  // A clip with no grid length renders to the bar line after its last note.
  const totalSteps = clip.sourceTotalSteps
    ?? roundUpToBar(
      clip.sourceMeterMap ?? [],
      Math.max(1, ...clip.sourcePianoRoll.map((n) => n.step + n.length)),
      clip.sourcePickupSteps ?? 0,
    );
  // A clip whose lanes bend renders each note in its lane, so the bend survives the re-render.
  const input = clipRenderInput(clip, totalSteps);
  const rendered = await deps.render(input.notes, bpm, totalSteps, {
    program: voice.program,
    percussion: voice.percussion,
    bends: input.bends,
  });
  const { peaks } = await deps.computePeaks(rendered.blob, 240);
  // Re-read: the user may have deleted, trimmed or re-assigned the clip mid-render.
  const after = voiceNow(clipId, deps.global());
  if (!after || after.voice.program !== voice.program || after.voice.percussion !== voice.percussion) return false;
  // Derived audio, so no undo step: undo restores clips whose bounce is
  // stale, and this write then follows the undo with the redo stack intact.
  useEditorStore.getState().applyClipRender(clipId, {
    audioBlob: rendered.blob,
    mimeType: 'audio/wav',
    ...renderedWindowFields(after.clip, rendered.duration),
    ...renderedVoiceFields(voice),
  }, peaks);
  return true;
}
