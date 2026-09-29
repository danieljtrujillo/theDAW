/**
 * stemMidiSet — every stem MIDI of one library song brought in at once: the
 * LIBRARY's MIDI rows menu "All stems to piano roll" (one roll part a stem)
 * and "All stems to EDIT as tracks" (one EDIT track a stem).
 *
 * The library converts a song and each of its stems to MIDI
 * (backend/modules/midi/runner): the full mix's row (source "full") and one
 * row a stem (source "stem", `<stem>.mid`). The full mix holds the stems'
 * notes again, so it never joins them.
 *
 * Each stem file is read as the roll reads any file (lib/rollMidi
 * midiFileToRollParts) with its stem's name, so a basic-pitch stem plays its
 * stem's instrument (lib/stemRole) and the drum engine's file its kit on
 * channel 10, and each part is named for its stem and takes the next free
 * channel (every basic-pitch file writes channel 1). The files were written
 * apart: the pitched ones at the song's one stamped tempo, the drums on a
 * tempo map that follows its beats. The parts share one roll document, so
 * the file whose map holds the most tempo events gives the tempo map and the
 * meter, and every other file's notes move onto it keeping their seconds
 * (lib/tempoConform), so every part stays on the song. A pitch wheel is read
 * onto its notes (their own bends), since a lane's curve would bend every
 * part. Every part is marked as timed against the song's audio
 * (RollTrack `fromAudio`), so MATCH keeps their seconds.
 *
 * No Vite-only imports, so node tests replay it; the picker's voice for EDIT
 * comes in as a dep.
 */
import { useBottomPanelStore } from '../state/bottomPanelStore';
import { logInfo, logWarn } from '../state/logStore';
import { DEFAULT_LANES, activeTrackOf, usePianoRollStore } from '../state/pianoRollStore';
import { fetchMidiBytesWithRetry } from './fetchRetry';
import { midiRowPart, type LibraryMidiRow } from './libraryIndex';
import { parseMidi, type MidiFileData } from './midi';
import { importPartsAsTracks, importTracksReport, trackPartsOf, type MidiTracksDeps, type MidiTracksResult } from './midiImportTracks';
import { chordBendLog, midiFileToRollParts, type RollMidiPart, type RollMidiPartsImport } from './rollMidi';
import { KEPT_DOCUMENT_LOG, applyRollParts, pastEndLog, type PartsImportResult } from './rollPartsImport';
import { PERCUSSION_PART_CHANNEL, partColorAt } from './rollTracks';
import { stemPartName } from './stemRole';
import { conformControls, conformNotes, sameTiming } from './tempoConform';

/** One stem's MIDI file and the stem it transcribes. */
export interface StemMidiFile {
  stem: string;
  data: MidiFileData;
}

/** A library MIDI row as the LIBRARY lists it (an untyped record there). */
type MidiRowLike = Pick<LibraryMidiRow, 'id'> & Partial<LibraryMidiRow>;

/** The stem a row transcribes: its file's name ("vocals" from vocals.mid). */
export const stemOfRow = (row: MidiRowLike): string => midiRowPart(row as LibraryMidiRow);

/** A song's stem MIDI rows: every row but the full mix's, in the order the library lists them. */
export function stemMidiRows<T extends MidiRowLike>(rows: readonly T[]): T[] {
  return rows.filter((r) => typeof r.id === 'string' && r.id && r.source !== 'full' && stemOfRow(r).toLowerCase() !== 'full');
}

/**
 * The stem files read into one roll document (see the header): a part a
 * stem, named for it, on its stem's instrument, marked as timed against
 * audio, every file's notes on the tempo map of the file that holds the most
 * tempo events, at the seconds they were transcribed at.
 */
export function stemMidiDocument(files: readonly StemMidiFile[]): RollMidiPartsImport {
  const reads = files.map((f, i) => ({ stem: f.stem, read: midiFileToRollParts(f.data, `stem${i}`, { stem: f.stem, bendsOnNotes: true }) }));
  const ref = reads.reduce((best, r) => (r.read.tempoMap.length > best.read.tempoMap.length ? r : best), reads[0]);
  const parts: RollMidiPart[] = [];
  let noteBends = 0;
  let chordBends = 0;
  for (const { stem, read } of reads) {
    noteBends += read.noteBends;
    chordBends += read.chordBends;
    const c = { from: read.tempoMap, to: ref.read.tempoMap };
    const same = sameTiming(c);
    const sounding = read.parts.filter((p) => p.notes.length > 0);
    sounding.forEach((p, k) => {
      const controls = same ? p.track.controls : conformControls(p.track.controls, c);
      parts.push({
        track: {
          ...p.track,
          name: sounding.length > 1 ? `${stemPartName(stem)} ${k + 1}` : stemPartName(stem),
          color: partColorAt(parts.length),
          // Every basic-pitch file writes channel 1, so the stems would share it: each takes the next free channel, the drums 10.
          channel: p.track.channel === PERCUSSION_PART_CHANNEL ? PERCUSSION_PART_CHANNEL : null,
          fromAudio: true,
          ...(controls ? { controls } : {}),
        },
        notes: same ? p.notes : conformNotes(p.notes, c),
      });
    });
  }
  return {
    bpm: ref.read.bpm,
    // Every file's bends are its notes' own, so the document has lane A alone and no curve.
    meter: { ...ref.read.meter, lanes: DEFAULT_LANES.map((l) => ({ ...l })) },
    bends: [],
    tempoMap: ref.read.tempoMap,
    markers: ref.read.markers,
    noteBends,
    chordBends,
    parts,
  };
}

/** Fetch and parse each row's file; a row that fails is named in `failed` with why. */
export async function fetchStemMidis(
  rows: readonly MidiRowLike[],
  opts: { retries?: number } = {},
): Promise<{ files: StemMidiFile[]; failed: Array<{ stem: string; error: string }> }> {
  const got = await Promise.all(rows.map(async (row) => {
    const stem = stemOfRow(row);
    try {
      const bytes = await fetchMidiBytesWithRetry(`/api/midi/file/${encodeURIComponent(row.id)}`, { label: stem, ...(opts.retries !== undefined ? { retries: opts.retries } : {}) });
      return { stem, data: parseMidi(new Uint8Array(bytes)) };
    } catch (e) {
      return { stem, error: e instanceof Error ? e.message : String(e) };
    }
  }));
  const files: StemMidiFile[] = [];
  const failed: Array<{ stem: string; error: string }> = [];
  for (const g of got) {
    if ('data' in g && g.data) files.push({ stem: g.stem, data: g.data });
    else failed.push({ stem: g.stem, error: (g as { error: string }).error });
  }
  return { files, failed };
}

/** The LOG lines for stems that did not load. */
const logFailed = (title: string, failed: ReadonlyArray<{ stem: string; error: string }>): void => {
  for (const f of failed) logWarn('library', `"${title}": the ${f.stem} MIDI did not load (${f.error}); the other stems came in without it`);
};

/**
 * "All stems to piano roll": every stem MIDI of the song into the roll as
 * its parts (they replace the roll's parts; one stem alone goes into the part
 * being edited, as any one-part file does), then the MIDI tab. Logs what came
 * in. Null when no stem file loaded or held notes.
 */
export async function stemMidisToRoll(
  rows: readonly MidiRowLike[],
  title: string,
  opts: { retries?: number } = {},
): Promise<PartsImportResult | null> {
  const { files, failed } = await fetchStemMidis(rows, opts);
  logFailed(title, failed);
  const doc = files.length ? stemMidiDocument(files) : null;
  if (!doc || !doc.parts.length) {
    logWarn('library', `"${title}" has no stem MIDI with notes to bring into the piano roll`);
    return null;
  }
  const done = applyRollParts(doc.parts, doc.bpm, doc.meter, doc.bends, doc.tempoMap, doc.markers, { fromAudio: true });
  useBottomPanelStore.getState().showTab('midi');
  const names = done.into === 'parts' ? doc.parts.slice(0, done.parts).map((p) => p.track.name) : [activeTrackOf(usePianoRollStore.getState()).name];
  logInfo(
    'library',
    `All stems of "${title}" into the piano roll: ${done.parts} part${done.parts === 1 ? '' : 's'} (${names.join(', ')}), ${done.notes} notes at ${Math.round(doc.bpm * 100) / 100} BPM`
      + `${doc.tempoMap.length > 1 ? ` with ${doc.tempoMap.length - 1} tempo change${doc.tempoMap.length === 2 ? '' : 's'}` : ''}, each note at the second it was transcribed at`,
  );
  const bends = chordBendLog(title, doc);
  for (const line of bends.info) logInfo('library', line);
  for (const line of bends.warn) logWarn('library', line);
  if (done.pastEnd) logWarn('library', pastEndLog(done.pastEnd));
  if (done.keptDocument) logInfo('library', KEPT_DOCUMENT_LOG);
  return done;
}

/**
 * "All stems to EDIT as tracks": every stem MIDI of the song on an EDIT
 * track of its own from the timeline's start (lib/midiImportTracks), in one
 * undo step, the drums on a drum track. Logs what landed. Null when no stem
 * file loaded or held notes.
 */
export async function stemMidisToEdit(
  rows: readonly MidiRowLike[],
  title: string,
  deps: MidiTracksDeps,
  opts: { retries?: number; atSec?: number } = {},
): Promise<MidiTracksResult | null> {
  const { files, failed } = await fetchStemMidis(rows, opts);
  logFailed(title, failed);
  const doc = files.length ? stemMidiDocument(files) : null;
  const atSec = opts.atSec ?? 0;
  const done = doc ? importPartsAsTracks(trackPartsOf(doc), { label: title, atSec }, deps) : null;
  if (!done) {
    logWarn('editor', `"${title}" has no stem MIDI with notes to put on EDIT tracks`);
    return null;
  }
  const report = importTracksReport(done, title, atSec);
  for (const line of report.info) logInfo('editor', line);
  for (const line of report.warn) logWarn('editor', line);
  return done;
}
