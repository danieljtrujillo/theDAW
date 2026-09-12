/**
 * The library's non-entry indexes — converted MIDI and separated stems — in
 * one place.
 *
 * Before this module three components each carried their own copy of the same
 * `MidiRow` interface, the same `rowLabel` helper and the same
 * `fetch('/api/library/_all/midi')` (LibraryMidiPicker, MidiImportPopover,
 * LibraryView). A row label that improved in one of them stayed wrong in the
 * other two, and nothing outside a mounted picker could answer "is there any
 * library MIDI?" — which the EDIT add-to-track menu needs in order to say why
 * a row is greyed out.
 *
 * Each index is cached in module scope, so a menu can read a count
 * synchronously (`cachedLibraryMidiCount`) once something has loaded it and a
 * reopened picker paints instantly. Callers that must be current — a picker
 * opening — pass `{ force: true }`, which refetches and refreshes the cache.
 *
 * Audio takes are NOT here: those live in `libraryStore.entries`, already
 * loaded and already reactive.
 */
import { logError } from '../state/logStore';

/** A converted-MIDI row from `GET /api/library/_all/midi`. */
export interface LibraryMidiRow {
  id: string;
  source?: string;
  midi_path?: string;
  notes_count?: number;
  favorite?: number;
  parent_title?: string;
  parent_id?: string;
}

/** A separated-stem row from `GET /api/library/_all/stems`. */
export interface LibraryStemRow {
  id: string;
  stem_name?: string;
  model?: string;
  duration?: number;
  favorite?: number;
  parent_title?: string;
  parent_id?: string;
}

/** "<parent title> · <midi filename>" — the label every MIDI surface shows. */
export const midiRowLabel = (m: LibraryMidiRow): string => {
  const part =
    (m.midi_path || '').split(/[\\/]/).pop()?.replace(/\.midi?$/i, '') ||
    m.source ||
    'midi';
  const title = (m.parent_title || m.parent_id || 'Untitled').replace(/\.[a-z0-9]+$/i, '');
  return `${title} · ${part}`;
};

/** "<parent title> · <stem name>" — matches `stemRowToSendable`'s label, so a
 *  stem placed from the picker is named like one sent from the LIBRARY tab. */
export const stemRowLabel = (s: LibraryStemRow): string => {
  const stem = s.stem_name || 'stem';
  const parent = (s.parent_title || '').replace(/\.[a-z0-9]+$/i, '');
  return parent ? `${parent} · ${stem}` : stem;
};

/** Where a stem's audio is fetched from. */
export const stemAudioUrl = (s: LibraryStemRow): string => `/api/library/stems/${s.id}/audio`;

export interface LoadIndexOpts {
  /** Refetch even when a cached copy exists (a picker opening). */
  force?: boolean;
}

/** One cached index: the rows, plus the request in flight so two pickers
 *  opening at once share a single fetch. */
interface IndexCache<T> {
  rows: T[] | null;
  inFlight: Promise<T[]> | null;
}

const midiIndex: IndexCache<LibraryMidiRow> = { rows: null, inFlight: null };
const stemIndex: IndexCache<LibraryStemRow> = { rows: null, inFlight: null };

async function fetchRows<T>(url: string, key: string): Promise<T[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const json = (await res.json()) as Record<string, unknown>;
  return (json[key] as T[] | undefined) ?? [];
}

function loadIndex<T>(
  cache: IndexCache<T>,
  url: string,
  key: string,
  what: string,
  opts: LoadIndexOpts,
): Promise<T[]> {
  if (!opts.force && cache.rows) return Promise.resolve(cache.rows);
  if (cache.inFlight) return cache.inFlight;
  const request = fetchRows<T>(url, key)
    .then((rows) => {
      cache.rows = rows;
      return rows;
    })
    .catch((e: unknown) => {
      // The previous rows (if any) stay cached — a failed refresh must not
      // empty a list the user is looking at.
      logError('library', `Could not load ${what}: ${e instanceof Error ? e.message : String(e)}`);
      throw e;
    })
    .finally(() => {
      cache.inFlight = null;
    });
  cache.inFlight = request;
  return request;
}

/** Every converted MIDI in the library. Rejects on a failed fetch (the caller
 *  shows the error; the LOG line is already written here). */
export const loadLibraryMidi = (opts: LoadIndexOpts = {}): Promise<LibraryMidiRow[]> =>
  loadIndex(midiIndex, '/api/library/_all/midi', 'midis', 'library MIDI', opts);

/** Every separated stem in the library. */
export const loadLibraryStems = (opts: LoadIndexOpts = {}): Promise<LibraryStemRow[]> =>
  loadIndex(stemIndex, '/api/library/_all/stems', 'stems', 'library stems', opts);

/** Rows already loaded, or null when the index has never been read. A menu uses
 *  this to tell "empty library" (disable the row, say why) from "not fetched
 *  yet" (leave it offered). */
export const cachedLibraryMidi = (): LibraryMidiRow[] | null => midiIndex.rows;
export const cachedLibraryStems = (): LibraryStemRow[] | null => stemIndex.rows;
export const cachedLibraryMidiCount = (): number | null => midiIndex.rows?.length ?? null;
export const cachedLibraryStemCount = (): number | null => stemIndex.rows?.length ?? null;

/** Test seam: drop both caches so a suite starts from a known state. */
export const resetLibraryIndexCache = (): void => {
  midiIndex.rows = null;
  midiIndex.inFlight = null;
  stemIndex.rows = null;
  stemIndex.inFlight = null;
};
