/**
 * arrangementMidiApp — the EDIT arrangement's MIDI export run against the live
 * stores: the export dialog's MIDI format and the assistant's
 * editor_export_midi both land here.
 *
 * The editor store's state is the source as it is (lib/arrangementMidi
 * ArrangementMidiSource is a structural slice of it), so the arrangement's
 * meter and tempo maps are read the moment the store holds them. The file is
 * saved through lib/saveFile as a `midi` file: a Save As on the machine the
 * backend runs on, which records the path so every MIDI import's Recent list
 * offers it, and a browser download anywhere else.
 *
 * The save and the picker's voice are loaded when an export runs (and can be
 * passed in), so node tests import this module without an audio engine.
 */
import { useEditorStore } from '../state/editorStore';
import { logInfo, logWarn } from '../state/logStore';
import { arrangementToMidiFile, type ArrangementMidiResult, type ArrangementMidiScope } from './arrangementMidi';
import type { GlobalVoice } from './clipProgram';
import { encodeMidi } from './midi';

export interface ArrangementMidiRequest {
  scope?: ArrangementMidiScope;
  range?: { startSec: number; endSec: number } | null;
  /** The file's name, without or with `.mid`; `arrangement` when blank. */
  name?: string;
}

/** Where the bytes go and whose voice a clip without a program takes. Left out, lib/saveFile and the picker's. */
export interface ArrangementMidiSeams {
  save?: (blob: Blob, fileName: string) => Promise<{ path: string | null; cancelled: boolean; downloaded: boolean }>;
  global?: GlobalVoice;
}

export type ArrangementMidiOutcome =
  | { ok: true; message: string; path: string | null; fileName: string; result: ArrangementMidiResult; error?: undefined }
  | { ok: false; error: string; message?: undefined; result?: ArrangementMidiResult };

/** `name` with a `.mid` ending, `arrangement.mid` when it is blank. */
export const midiFileName = (name: string | undefined): string => {
  const base = (name ?? '').trim() || 'arrangement';
  return /\.midi?$/i.test(base) ? base : `${base}.mid`;
};

/** The picker's voice, read from the soundfont engine when an export runs. */
async function pickerVoice(): Promise<GlobalVoice> {
  try {
    return (await import('./soundfontEngine')).getGlobalVoice();
  } catch {
    return { useSoundfont: false, activeProgram: 0 };
  }
}

/** Save through lib/saveFile as a `midi` file. */
async function saveMidi(blob: Blob, fileName: string) {
  const { saveFile } = await import('./saveFile');
  return saveFile({ blob, suggestedName: fileName, kind: 'midi' });
}

/** Build the arrangement's MIDI file and save it; the outcome says what was written and where. */
export async function exportArrangementMidi(req: ArrangementMidiRequest = {}, seams: ArrangementMidiSeams = {}): Promise<ArrangementMidiOutcome> {
  const global = seams.global ?? (await pickerVoice());
  const result = arrangementToMidiFile(useEditorStore.getState(), { scope: req.scope, range: req.range ?? null, global });
  if (result.noteCount === 0) {
    const why = result.mutedClips ? ` (${result.mutedClips} muted clip${result.mutedClips === 1 ? ' is' : 's are'} left out)` : '';
    return { ok: false, error: `There are no MIDI notes to export in that part of the arrangement${why}`, result };
  }
  const fileName = midiFileName(req.name);
  const blob = new Blob([encodeMidi(result.file)], { type: 'audio/midi' });
  const saved = await (seams.save ?? saveMidi)(blob, fileName);
  const what = `${result.noteCount} notes on ${result.trackCount} track${result.trackCount === 1 ? '' : 's'}`;
  if (saved.cancelled) return { ok: false, error: `The MIDI save was cancelled, so nothing was written (${what} were ready)`, result };
  if (!saved.path && !saved.downloaded) return { ok: false, error: `The MIDI file could not be saved (${what})`, result };
  if (result.articulationFallback.length) {
    logWarn('editor', `No MIDI channel was left for the articulations of ${result.articulationFallback.join(', ')}: their pizzicato, tremolo and muted notes play in the track's own program`);
  }
  if (result.mpeNoRoom) {
    logWarn('editor', 'No MIDI channel was left for an MPE zone: notes with their own expression play on their track\'s channel, without it');
  }
  if (result.sharedTracks.length) {
    logWarn('editor', `A MIDI file has 16 channels: ${result.sharedTracks.join(', ')} share channels, and a player sounds them on one program each`);
  }
  // The articulations that found no channel of their own ride in the result's message too.
  const fell = result.articulationFallback.length ? `; the articulations of ${result.articulationFallback.join(', ')} play in their track's program` : '';
  const message = saved.path ? `Exported ${what} as MIDI to ${saved.path}${fell}` : `Exported ${what} as MIDI (${fileName}, downloaded)${fell}`;
  logInfo('editor', message);
  return { ok: true, message, path: saved.path, fileName, result };
}
