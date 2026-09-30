/**
 * midiImportTracksApp — "Import as tracks" wired to the running app: the
 * picker (lib/midiImportTracks takes it as a dep, so node tests replay it
 * without an audio engine; a part that cannot play live renders through EDIT's
 * MIDI render queue, which App configures at load), and the LOG lines a user
 * reads.
 *
 * Both entry points share this: the MIDI tab's IMPORT flyout ("As EDIT
 * tracks", at the start of the timeline) and EDIT's add-to-track menu ("MIDI
 * file as tracks", where the timeline was clicked).
 */
import { logError, logInfo, logWarn } from '../state/logStore';
import { midiFileLabel } from './fileFilters';
import { parseMidi } from './midi';
import { importMidiAsTracks, importTracksReport, type MidiTracksResult } from './midiImportTracks';
import { getGlobalVoice } from './soundfontEngine';

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
    global: getGlobalVoice,
    onRendered: (n, of, name) => {
      if (n === of) logInfo('editor', `Import as tracks: audio ready for ${of === 1 ? name : `all ${of} parts`} of "${label}" that cannot play live, in ${(performance.now() - started).toFixed(0)}ms`);
      else logInfo('editor', `Import as tracks: audio ready for ${name} (${n} of ${of})`);
    },
    onRenderError: (name, e) =>
      logWarn('editor', `Import as tracks: ${name} did not render (${e instanceof Error ? e.message : String(e)}); its clip keeps its notes, and EDIT renders it again`),
  });
  if (!done) {
    logError('editor', `Import as tracks: no notes in "${label}"`);
    return null;
  }
  const report = importTracksReport(done, label, atSec);
  for (const line of report.info) logInfo('editor', line);
  for (const line of report.warn) logWarn('editor', line);
  return done;
}

/** A picked MIDI file as EDIT tracks at `atSec` (the start of the timeline when left out). */
export function importMidiFileAsTracks(file: File, atSec = 0): void {
  file
    .arrayBuffer()
    .then((bytes) => importMidiBytesAsTracks(bytes, midiFileLabel(file.name), atSec))
    .catch((e) => logError('editor', `Could not read ${file.name}: ${e instanceof Error ? e.message : String(e)}`));
}
