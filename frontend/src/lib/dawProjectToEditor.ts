import { dawImportAudioUrl, type DawClip, type DawProject, type DawTrack } from './dawImportClient';
import { computePeaks, useEditorStore } from '../state/editorStore';
import { useAppUiStore } from '../state/appUiStore';
import { useStatusBarStore } from '../state/statusBarStore';
import { logError, logInfo } from '../state/logStore';
import { renderNotesToBlob, type RenderNote, type RenderOptions } from './midiSynth';
import { withRenderTurn } from '../state/midiRenderQueue';
import { midiRenderSig } from './midiRender';
import type { PianoNote } from '../state/pianoRollStore';
import { takeToRoll } from './takeNotes';
import { clampTempoBpm } from './tempoMap';
import { validTimeSignature } from './timeSignatureIO';
import { pairingHeader } from './pairing';

const DEFAULT_CLIP_SECONDS = 4;

const dbToLinear = (db: number): number => {
  if (!Number.isFinite(db)) return 0.8;
  return Math.max(0, Math.min(1, 10 ** (db / 20)));
};

const clipDuration = (clip: DawClip): number =>
  Math.max(0.05, (clip.end_time ?? 0) - (clip.start_time ?? 0));

const isArrangementClip = (clip: DawClip): boolean =>
  clip.scene_index == null && clip.slot_index == null && (clip.start_time > 0 || clip.end_time > 0);

/** The project's tempo as EDIT holds it (20-300 BPM, 120 when the file has
 *  none), so every note and clip lands where EDIT's grid and clock put it. */
const dawBpm = (tempo: number | undefined): number => clampTempoBpm(tempo || 120);

const sceneStartSec = (clip: DawClip, project: DawProject): number => {
  const sceneIndex = clip.scene_index ?? clip.slot_index ?? 0;
  const beatSec = 60 / dawBpm(project.tempo);
  return sceneIndex * 4 * beatSec;
};

const notesFromDawClip = (clip: DawClip): RenderNote[] => {
  if (!Array.isArray(clip.midi_notes)) return [];
  return clip.midi_notes.flatMap((raw) => {
    if (!raw || typeof raw !== 'object') return [];
    const note = raw as Record<string, unknown>;
    const midi = Number(note.midi ?? note.note ?? note.pitch);
    const startSec = Number(note.startSec ?? note.start_sec ?? note.start ?? 0);
    const durationSec = Number(note.durationSec ?? note.duration_sec ?? note.duration ?? 0.25);
    const velocityRaw = Number(note.velocity ?? 0.8);
    if (!Number.isFinite(midi) || !Number.isFinite(startSec) || !Number.isFinite(durationSec)) return [];
    return [{
      midi,
      startSec: Math.max(0, startSec),
      durationSec: Math.max(0.02, durationSec),
      // < 1, not <= 1: a raw value of exactly 1 is a legitimate (very quiet)
      // MIDI velocity, and treating it as normalised 1.0 turned it into 127.
      velocity: velocityRaw < 1 ? Math.round(velocityRaw * 127) : Math.round(velocityRaw),
    }];
  });
};

/**
 * An imported DAW clip's notes as piano-roll notes at `bpm`, each at the tick
 * it sits on in the project (lib/takeNotes), never snapped to a 16th: a swung
 * or triplet part opens in the roll as it was written, and the roll's APPLY
 * quantises it when the player asks. The grid is at least 16 steps long.
 *
 * Velocity is MIDI 1-127 here: notesFromDawClip has already normalised it up to
 * that range, and dividing by 127 again pushed every note to velocity 1.
 */
export const pianoNotesFromRenderNotes = (notes: RenderNote[], bpm: number): { rollNotes: PianoNote[]; totalSteps: number } => {
  const { rollNotes, totalSteps } = takeToRoll(
    notes.map((n) => ({ note: n.midi, velocity: n.velocity, startSec: n.startSec, endSec: n.startSec + n.durationSec })),
    { bpm: dawBpm(bpm), idPrefix: 'als-note' },
  );
  return { rollNotes, totalSteps: Math.max(16, totalSteps) };
};

/** Where an imported clip's window starts in its source: the trim point
 *  ableton.py stores as the clip's loop_start. */
const trimPointSec = (clip: DawClip): number => Math.max(0, clip.loop_start ?? 0);

/**
 * How a DAW MIDI clip renders: at least to the end of its own window (trim
 * point plus length), so the rests after its last note are in the audio, and
 * with no fixed tail, so the soundfont render rings for the longest release
 * among the instruments it plays (lib/renderTail).
 */
export const dawMidiRenderOptions = (clip: DawClip): RenderOptions => ({
  minDurationSec: trimPointSec(clip) + clipDuration(clip),
});

/**
 * An arrangement MIDI clip's length on the EDIT timeline: its own length, and
 * past it the ring-out of its last notes when every note starts inside the
 * window (so the audio past the window is release and nothing else), as a
 * DAW lets a released note ring after its clip ends. Never longer than the
 * render from the trim point.
 */
export const dawMidiWindowSec = (clip: DawClip, notes: readonly RenderNote[], sourceDuration: number): number => {
  const own = clipDuration(clip);
  const available = Math.max(0, sourceDuration - trimPointSec(clip));
  const windowEnd = trimPointSec(clip) + own;
  const allInside = notes.every((n) => n.startSec < windowEnd);
  return Math.min(available, allInside ? Math.max(own, available) : own);
};

const loadClipAudio = async (clip: DawClip, project: DawProject): Promise<{
  blob: Blob;
  mimeType: string;
  duration: number;
  sourceKind?: 'audio' | 'piano-roll';
  sourcePianoRoll?: PianoNote[];
  sourceTotalSteps?: number;
  /** A MIDI clip's notes as they were rendered. */
  renderNotes?: RenderNote[];
}> => {
  if (clip.file_path) {
    const response = await fetch(dawImportAudioUrl(clip.file_path), { headers: pairingHeader() });
    if (!response.ok) throw new Error(`Could not load ${clip.name}`);
    // arrayBuffer + new Blob, never response.blob(): blob() spools through
    // disk and fails outright on a full disk for large media (fetchRetry.ts
    // documents the same convention).
    const buf = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'audio/wav';
    const blob = new Blob([buf], { type: contentType });
    const { duration } = await computePeaks(blob, 16);
    return { blob, mimeType: blob.type || 'audio/wav', duration };
  }

  const notes = notesFromDawClip(clip);
  if (notes.length === 0) throw new Error(`Clip has no audio or MIDI notes: ${clip.name}`);
  const options = dawMidiRenderOptions(clip);
  // In the MIDI render queue's turn, so it never overlaps another render.
  const rendered = await withRenderTurn('', clip.name || 'Imported MIDI clip', () => renderNotesToBlob(notes, options));
  const { rollNotes, totalSteps } = pianoNotesFromRenderNotes(notes, project.tempo);
  // The grid covers the whole window too, so a later re-render (an instrument
  // change in EDIT) keeps the rests after the last note.
  const stepSec = 60 / dawBpm(project.tempo) / 4;
  return {
    blob: rendered.blob,
    mimeType: 'audio/wav',
    duration: rendered.duration,
    sourceKind: 'piano-roll',
    sourcePianoRoll: rollNotes,
    sourceTotalSteps: Math.max(totalSteps, Math.ceil((options.minDurationSec ?? 0) / stepSec - 1e-6)),
    renderNotes: notes,
  };
};

export async function importDawProjectToEditor(project: DawProject): Promise<number> {
  const editor = useEditorStore.getState();
  editor.setBpm(dawBpm(project.tempo));
  // The source DAW's meter comes across with its tempo. This is a merge into
  // the open session, not a document load, so an unreported or unusable pair
  // leaves the session's meter alone instead of forcing 4/4.
  const pair = project.time_signature;
  const meter = Array.isArray(pair) && pair.length >= 2 ? validTimeSignature(pair[0], pair[1]) : null;
  if (meter) editor.setTimeSignature(meter.num, meter.den);

  const playableTracks = project.tracks.filter((track) => track.type === 'audio' || track.type === 'midi');
  const hasArrangement = playableTracks.some((track) => track.clips.some(isArrangementClip));
  let imported = 0;

  for (const [trackIndex, dawTrack] of playableTracks.entries()) {
    const dawClips = hasArrangement
      ? dawTrack.clips.filter(isArrangementClip)
      : dawTrack.clips.filter((clip) => clip.file_path || notesFromDawClip(clip).length > 0);
    if (dawClips.length === 0) continue;

    const trackId = editor.addTrack({
      name: dawTrack.name || `Track ${trackIndex + 1}`,
      nameAutoGenerated: false,
      volume: dbToLinear(dawTrack.volume_db),
      pan: Math.max(-1, Math.min(1, dawTrack.pan || 0)),
      mute: dawTrack.mute,
      solo: dawTrack.solo,
    });
    const trackColor = useEditorStore.getState().tracks.find((track) => track.id === trackId)?.color ?? '#8b5cf6';

    for (const clip of dawClips) {
      try {
        const loaded = await loadClipAudio(clip, project);
        const { peaks, duration } = await computePeaks(loaded.blob, 240);
        const sourceDuration = loaded.duration || duration || clipDuration(clip);
        const startSec = hasArrangement ? Math.max(0, clip.start_time || 0) : sceneStartSec(clip, project);
        const durationSec = hasArrangement
          ? loaded.renderNotes
            ? dawMidiWindowSec(clip, loaded.renderNotes, sourceDuration)
            : Math.min(sourceDuration, clipDuration(clip) || sourceDuration)
          : sourceDuration || DEFAULT_CLIP_SECONDS;
        const clipId = useEditorStore.getState().addClipToTrack({
          trackId,
          label: clip.name || dawTrack.name || 'Imported clip',
          audioBlob: loaded.blob,
          mimeType: loaded.mimeType,
          sourceDuration,
          // The trim point is already parsed — ableton.py stores it as the clip's
          // loop_start (it handles the attribute, child and Loop/LoopStart forms).
          // Hardcoding 0 here made every trimmed clip play the head of its source
          // instead of the region the user actually kept.
          offsetIntoSource: Math.max(0, Math.min(trimPointSec(clip), Math.max(0, sourceDuration - 0.01))),
          durationSec,
          startSec,
          color: trackColor,
          sourceKind: loaded.sourceKind,
          sourcePianoRoll: loaded.sourcePianoRoll,
          sourceBpm: loaded.sourceKind === 'piano-roll' ? dawBpm(project.tempo) : undefined,
          sourceTotalSteps: loaded.sourceTotalSteps,
          // A MIDI clip's render is made because its new track has no
          // instrument to play it live: it records what it was made from, so a
          // note edit marks it stale, and why it is held, so EDIT drops it once
          // the part plays live (lib/midiRender).
          ...(loaded.sourceKind === 'piano-roll'
            ? {
                renderSig: midiRenderSig({
                  sourceKind: 'piano-roll',
                  sourcePianoRoll: loaded.sourcePianoRoll,
                  sourceBpm: dawBpm(project.tempo),
                  sourceTotalSteps: loaded.sourceTotalSteps,
                }),
                renderAuto: true,
              }
            : {}),
        });
        useEditorStore.getState().cachePeaks(clipId, peaks);
        imported += 1;
      } catch (error) {
        logError('dawimport', error instanceof Error ? error.message : String(error));
      }
    }
  }

  if (project.locators.length > 0) {
    const store = useEditorStore.getState();
    project.locators.forEach((locator) => store.addMarker(locator.position, locator.name));
  }

  useAppUiStore.getState().setCenterTab('edit');
  useStatusBarStore.getState().setText(
    imported > 0 ? `IMPORTED ${imported} CLIP(S) TO EDIT TIMELINE` : 'NO PLAYABLE CLIPS FOUND FOR TIMELINE',
  );
  logInfo('dawimport', `Imported ${imported} clip(s) from ${project.name} to the editor timeline`);
  return imported;
}

