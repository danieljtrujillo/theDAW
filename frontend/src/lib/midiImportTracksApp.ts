/**
 * midiImportTracksApp — "Import as tracks" wired to the running app: the
 * soundfont render, the editor's peak scan and the picker (lib/midiImportTracks
 * takes them as deps, so node tests replay it without an audio engine), and
 * the LOG lines a user reads.
 *
 * Both entry points share this: the MIDI tab's IMPORT flyout ("As EDIT
 * tracks", at the start of the timeline) and EDIT's add-to-track menu ("MIDI
 * file as tracks", where the timeline was clicked).
 */
import { computePeaks } from '../state/editorStore';
import { logError, logInfo, logWarn } from '../state/logStore';
import { midiFileLabel } from './fileFilters';
import { parseMidi } from './midi';
import { importMidiAsTracks, type MidiTracksResult } from './midiImportTracks';
import { renderStepNotesToBlob } from './midiSynth';
import { ensureSoundfontReady, getGlobalVoice } from './soundfontEngine';

/** The tempo in a LOG line, to the hundredth. */
const bpmText = (bpm: number): string => String(Math.round(bpm * 100) / 100);

/**
 * Put a MIDI file's parts on EDIT tracks of their own at `atSec` and log what
 * landed. Resolves null (and logs why) when the bytes are not a MIDI file or
 * hold no notes.
 */
export async function importMidiBytesAsTracks(bytes: ArrayBuffer, label: string, atSec: number): Promise<MidiTracksResult | null> {
  let data;
  try {
    data = parseMidi(new Uint8Array(bytes));
  } catch (e) {
    logError('editor', `Import as tracks: "${label}" is not a MIDI file (${e instanceof Error ? e.message : String(e)})`);
    return null;
  }
  const started = performance.now();
  const done = importMidiAsTracks(data, { label, atSec }, {
    render: renderStepNotesToBlob,
    computePeaks,
    global: getGlobalVoice,
    ensureReady: ensureSoundfontReady,
    onRendered: (n, of, name) => {
      if (n === of) logInfo('editor', `Import as tracks: audio ready for all ${of} parts of "${label}" in ${(performance.now() - started).toFixed(0)}ms`);
      else if (of > 1) logInfo('editor', `Import as tracks: audio ready for ${name} (${n} of ${of})`);
    },
    onRenderError: (name, e) =>
      logWarn('editor', `Import as tracks: ${name} did not render (${e instanceof Error ? e.message : String(e)}); its clip keeps its notes and plays live`),
  });
  if (!done) {
    logError('editor', `Import as tracks: no notes in "${label}"`);
    return null;
  }
  const tempoChanges = Math.max(0, (data.tempos?.length ?? 1) - 1);
  const meters = data.timeSignatures?.length ?? 0;
  const drums = done.parts.filter((p) => p.percussion).length;
  const controllers = done.parts.reduce((n, p) => n + p.controlCount, 0);
  logInfo(
    'editor',
    `Import as tracks: ${done.parts.length} part${done.parts.length === 1 ? '' : 's'} of "${label}" on new tracks at ${atSec.toFixed(2)}s ` +
      `(${done.noteCount} notes${drums ? `, ${drums} on drum tracks` : ''}${controllers ? `, ${controllers} controller changes` : ''}, ` +
      `${bpmText(data.bpm)} BPM${tempoChanges ? ` with ${tempoChanges} tempo change${tempoChanges === 1 ? '' : 's'}` : ''}` +
      `${meters > 1 ? `, ${meters} time signatures` : ''}); rendering audio in the background`,
  );
  return done;
}

/** A picked MIDI file as EDIT tracks at `atSec` (the start of the timeline when left out). */
export function importMidiFileAsTracks(file: File, atSec = 0): void {
  file
    .arrayBuffer()
    .then((bytes) => importMidiBytesAsTracks(bytes, midiFileLabel(file.name), atSec))
    .catch((e) => logError('editor', `Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`));
}
