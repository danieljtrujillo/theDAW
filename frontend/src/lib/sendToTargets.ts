/**
 * Shared "send audio / midi to <target>" helpers.
 *
 * Right-click menus on the library tracks list, stems sub-tab, midi sub-tab,
 * and the mic recorder all need the same set of destinations:
 *
 *   - Editor (append to first track / new track)
 *   - Init audio (the generation panel's init slot)
 *   - Inpaint audio (the generation panel's inpaint slot)
 *   - Chimera (for multi-clip batching)
 *   - Piano roll / Step sequencer (MIDI only)
 *
 * Without this module each call site re-implements blob fetching + editor
 * peak caching + bottom-panel switching, which is how `LibraryView.tsx`
 * grew to 1100+ lines. Centralizing keeps the right-click menus thin and
 * makes mic-recorded blobs reusable.
 */
import { useEditorStore, computePeaks } from '../state/editorStore';
import { useGenerateParamsStore } from '../state/generateParamsStore';
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { usePianoRollStore } from '../state/pianoRollStore';
import { addBlobsToChimera } from './chimeraClient';
import { parseMidi } from './midi';
import { chordBendLog, midiFileToRoll } from './rollMidi';
import { KEPT_DOCUMENT_LOG, importMidiParts, pastEndLog } from './rollPartsImport';
import { renderMidiBufferToBlob } from './midiSynth';
import { fetchMidiBytesWithRetry, fetchBlobWithRetry } from './fetchRetry';
import { logError, logInfo, logWarn } from '../state/logStore';

/** Default mime for stems / mic recordings when none provided. */
const DEFAULT_AUDIO_MIME = 'audio/wav';

export interface SendableAudio {
  /** Human label shown in the editor / chimera / init source pill. */
  label: string;
  /** A fetcher that resolves the audio bytes the first time it's used. */
  fetcher: () => Promise<Blob>;
  /** Mime hint for the resulting File / source label. */
  mimeType?: string;
  /** Library entry id when the audio is a library take — lets Chimera reuse
   *  the cached analysis row (BPM / key / beats) and cached stems. */
  entryId?: string;
}

export type AudioSendTarget =
  | 'editor-first-track'
  | 'editor-new-track'
  | 'init'
  | 'inpaint'
  | 'chimera';

export type MidiSendTarget = 'piano-roll' | 'step-seq';

/**
 * Put an audio blob on the EDIT timeline. The first empty lane takes it, so a
 * fresh timeline fills from lane 1 down. When every lane holds something,
 * 'editor-new-track' adds a lane and 'editor-first-track' appends after the
 * last clip on lane 1. Decodes peaks so the waveform shows up immediately.
 */
export async function sendAudioToEditor(
  audio: SendableAudio,
  target: 'editor-first-track' | 'editor-new-track' = 'editor-first-track',
): Promise<string | null> {
  try {
    const editor = useEditorStore.getState();
    const taken = new Set(editor.clips.map((c) => c.trackId));
    const empty = editor.tracks.find((t) => !taken.has(t.id));
    let trackId: string;
    let tail = 0;
    if (empty) {
      trackId = empty.id;
    } else if (target === 'editor-new-track' || editor.tracks.length === 0) {
      trackId = editor.addTrack({ name: audio.label });
    } else {
      trackId = editor.tracks[0].id;
      tail = Math.max(
        0,
        ...editor.clips
          .filter((c) => c.trackId === trackId)
          .map((c) => c.startSec + c.durationSec),
      );
    }
    const blob = await audio.fetcher();
    const { peaks, duration } = await computePeaks(blob, 240);
    const trackColor =
      useEditorStore.getState().tracks.find((t) => t.id === trackId)?.color ?? '#8b5cf6';
    const clipId = editor.addClipToTrack({
      trackId,
      label: audio.label,
      audioBlob: blob,
      mimeType: audio.mimeType || DEFAULT_AUDIO_MIME,
      sourceDuration: duration,
      offsetIntoSource: 0,
      durationSec: duration,
      startSec: tail,
      color: trackColor,
      // Keeps the clip tied to its library entry, so EDIT's Separate Stems
      // reuses that entry's cached stems instead of importing the clip again.
      libraryEntryId: audio.entryId,
    });
    editor.cachePeaks(clipId, peaks);
    return clipId;
  } catch (e) {
    logError('send-to', `Could not send to editor: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/** Stash a single blob in the generate panel's init slot. */
export async function sendAudioToInit(audio: SendableAudio): Promise<void> {
  try {
    const blob = await audio.fetcher();
    const file = new File([blob], audio.label, { type: audio.mimeType || DEFAULT_AUDIO_MIME });
    useGenerateParamsStore.getState().patch({
      initAudioFile: file,
      initAudioEnabled: true,
      initAudioSourceLabel: audio.label,
      initAudioSourceClipLabels: [],
    });
    logInfo('send-to', `Sent "${audio.label}" → Init audio`);
  } catch (e) {
    logError('send-to', `Could not send to init: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Stash a blob in the inpaint slot with a zero-length mask (user picks the window). */
export async function sendAudioToInpaint(audio: SendableAudio): Promise<void> {
  try {
    const blob = await audio.fetcher();
    const file = new File([blob], audio.label, { type: audio.mimeType || DEFAULT_AUDIO_MIME });
    useGenerateParamsStore.getState().patch({
      inpaintAudioFile: file,
      inpaintEnabled: true,
      maskStart: 0,
      maskEnd: 0,
    });
    logInfo('send-to', `Sent "${audio.label}" → Inpaint`);
  } catch (e) {
    logError('send-to', `Could not send to inpaint: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Push 1+ blobs into the chimera mashup bucket. */
export async function sendAudioToChimera(items: SendableAudio[]): Promise<void> {
  try {
    const resolved = await Promise.all(
      items.map(async (it) => ({
        blob: await it.fetcher(),
        mimeType: it.mimeType || DEFAULT_AUDIO_MIME,
        label: it.label,
        entryId: it.entryId,
      })),
    );
    addBlobsToChimera(resolved);
    logInfo('send-to', `Sent ${items.length} clip(s) → Chimera`);
  } catch (e) {
    logError('send-to', `Could not send to chimera: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Decode a MIDI byte buffer into the piano roll's note grid, then surface
 * the chosen bottom-panel tab. Used by:
 *   - Library MIDI sub-tab right-click → Send to piano roll / step seq
 *   - The mic recorder / external midi dropzone
 */
export function loadMidiIntoPianoRoll(
  buf: ArrayBuffer | Uint8Array,
  target: MidiSendTarget = 'piano-roll',
  labelForLog = 'midi',
  opts: { fromAudio?: boolean; stem?: string } = {},
): boolean {
  try {
    const midi = parseMidi(buf);
    // Every track's notes, and the file's time signatures set the roll's meter (a file with no FF 58 is
    // 4/4 by the MIDI spec). A channel whose pitch wheel moves gets its own lane and curve; every other
    // note is in lane A (lib/rollMidi).
    const read = midiFileToRoll(midi, 'pn');
    const { notes, bpm, meter, bends, tempoMap, markers } = read;
    if (notes.length === 0) {
      logError('send-to', `MIDI ${labelForLog} parsed empty — no note-on events`);
      return false;
    }
    // Auto-fits length + pitch range to the import; the file's tempo changes become the roll's tempo map.
    // The piano roll takes a file of several tracks as one part each, on its own
    // instrument (lib/rollPartsImport); the step sequencer's hand-off keeps the
    // notes in one layer, as it always has. A new file is a new document: its
    // markers (FF 06) replace the previous one's, unless other parts keep the document.
    // A library song's MIDI was timed against its audio: the parts are marked so MATCH keeps their seconds.
    const audio = opts.fromAudio === true ? { fromAudio: true } : {};
    // A stem's transcription plays its stem's instrument, not basic-pitch's stock Electric Piano (lib/stemRole).
    const parts = target === 'piano-roll' ? importMidiParts(midi, 'pn', { ...audio, stem: opts.stem }) : null;
    const kept = parts
      ? parts.keptDocument
      : usePianoRollStore.getState().importNotes(notes, bpm, meter, bends, tempoMap, { markers, part: audio }).keptDocument;
    useBottomPanelStore.getState().showTab(target === 'piano-roll' ? 'midi' : 'step-seq');
    const totalSteps = usePianoRollStore.getState().totalSteps;
    const partText = parts && parts.into === 'parts' ? `, ${parts.parts} parts` : '';
    logInfo(
      'send-to',
      `Loaded ${notes.length} note(s) → ${target === 'piano-roll' ? 'piano roll' : 'step sequencer'} (bpm=${midi.bpm.toFixed(0)}, ${totalSteps} steps${partText})`,
    );
    // A one-part file into a roll whose other parts hold notes leaves the roll's own tempo, meter and bends in place.
    if (kept) logInfo('send-to', KEPT_DOCUMENT_LOG);
    if (parts?.pastEnd) logWarn('send-to', pastEndLog(parts.pastEnd));
    // A channel's wheel under chords: each lone note's bend became its own, the chords' left out.
    const chordBends = chordBendLog(labelForLog, read);
    for (const line of chordBends.info) logInfo('send-to', line);
    for (const line of chordBends.warn) logWarn('send-to', line);
    return true;
  } catch (e) {
    logError('send-to', `MIDI parse failed for ${labelForLog}: ${e instanceof Error ? e.message : String(e)}`);
    return false;
  }
}

/** Fetch a midi file from the backend by id, then load it into the piano roll. */
export async function sendMidiIdToTarget(midiId: string, target: MidiSendTarget): Promise<void> {
  try {
    const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${midiId}`, { label: midiId });
    // Every library MIDI row is a transcription of the song's audio (backend/modules/midi/runner).
    // Its id names its stem (`<entry>__<stem>_midi`), which gives the part its instrument.
    loadMidiIntoPianoRoll(buf, target, midiId, { fromAudio: true, stem: midiId });
  } catch (e) {
    logError('send-to', `Send MIDI failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/**
 * Build a SendableAudio that synthesizes a library MIDI row into audio on
 * demand. Lets MIDI flow into every audio destination (editor / init / inpaint
 * / chimera) the same way a stem or track does. Rendering is lazy — the synth
 * only runs when a consumer actually pulls the blob.
 */
export function midiIdToSendable(midiId: string, label = 'midi'): SendableAudio {
  return {
    label,
    mimeType: 'audio/wav',
    fetcher: async () => {
      const buf = await fetchMidiBytesWithRetry(`/api/midi/file/${midiId}`, { label });
      const { blob } = await renderMidiBufferToBlob(buf);
      return blob;
    },
  };
}

/** Build a SendableAudio from a stem row pulled from /api/library/_all/stems. */
export function stemRowToSendable(row: Record<string, unknown>): SendableAudio {
  const stemId = String(row.id ?? '');
  const stemName = String(row.stem_name ?? 'stem');
  const parentTitle = String(row.parent_title ?? '');
  const label = parentTitle ? `${parentTitle} · ${stemName}` : stemName;
  return {
    label,
    mimeType: 'audio/wav',
    fetcher: () => fetchBlobWithRetry(`/api/library/stems/${stemId}/audio`, { label }),
  };
}

