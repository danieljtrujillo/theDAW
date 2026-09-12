/**
 * One answer to "what did the user just drop here?" for every surface that
 * takes a library track: the EDIT timeline, the MIDI song box, the DJ sampler
 * pads and NEXT queue, and the Library list itself. Each of those used to
 * accept only its in-app drag mime; now a Finder / Explorer drop lands the
 * same way — the audio files are imported to the library first (the one place
 * imports live) and the caller runs its usual per-entry action on the result.
 *
 * Pure: no React, nothing of the DOM beyond the DataTransfer it is handed, so
 * the test runs under plain node with a fake DataTransfer and a fake
 * `importEntry`.
 *
 * Read everything off the DataTransfer before the first `await`. During the
 * drop event it is readable; once the handler yields, the browser flips it to
 * protected mode — `getData` returns '' and `files` comes back empty.
 */
import type { LibraryEntry } from '../state/libraryEntry';
import { logWarn } from '../state/logStore';
import {
  importAudioFiles,
  isAudioFile,
  type AudioImportOrigin,
  type ImportAudioDeps,
} from './importAudioFiles';

/** What a Library row puts on a drag (LibraryView / CatalogueGrid / CatalogueList). */
export const LIBRARY_ID_MIME = 'application/x-thedaw-library-id';

/** The provenance every desktop drop records, whichever surface took it. */
export const DESKTOP_DROP_ORIGIN: AudioImportOrigin = {
  prompt: 'Imported from Finder drop',
  tags: ['finder-drop'],
};

/**
 * A file item that may be audio. Windows reports an empty type for many audio
 * files during dragover (a .wav with no registered handler, a float .wav from
 * another DAW), so an empty type has to count — the extension check happens at
 * drop time, when the File objects exist.
 */
const isAudioFileItem = (item: DataTransferItem): boolean =>
  item.kind === 'file' && (item.type.startsWith('audio/') || item.type === '');

/**
 * The dragover gate: true when the drag carries one of `mimes`, or files from
 * the OS. Callers that must not react to an in-app library drag (the Library
 * list, where that drop is a no-op) pass `[]`.
 */
export function dropHasLibraryOrFiles(
  dt: DataTransfer,
  mimes: readonly string[] = [LIBRARY_ID_MIME],
): boolean {
  const types = Array.from(dt.types ?? []);
  if (mimes.some((m) => types.includes(m))) return true;
  if (types.includes('Files')) return true;
  return Array.from(dt.items ?? []).some(isAudioFileItem);
}

export interface EntriesFromDropOptions {
  /** In-app drag mimes that carry a library entry id. Default: the library mime. */
  mimes?: readonly string[];
  /** The library as the caller sees it, for resolving a dropped id. */
  entries: readonly LibraryEntry[];
  /** Provenance recorded on imported files. Default: DESKTOP_DROP_ORIGIN. */
  origin?: AudioImportOrigin;
  /** Injectable import, for the test. */
  deps?: ImportAudioDeps;
  /**
   * Import at most this many of the dropped audio files — a single-slot target
   * (a sampler pad, the MIDI song box) takes one. The rest are named in one
   * warning so the user knows they did not land.
   */
  max?: number;
}

/**
 * The library entries a drop stands for. An in-app drag resolves to the entry
 * its id names (empty when the id is unknown). An OS drop imports its audio
 * files to the library and returns them in file order; non-audio files are
 * skipped with one warning naming them. Never throws for an empty drop.
 */
export async function entriesFromDrop(
  dt: DataTransfer,
  opts: EntriesFromDropOptions,
): Promise<LibraryEntry[]> {
  const mimes = opts.mimes ?? [LIBRARY_ID_MIME];
  // Synchronous reads first — see the header comment on protected mode.
  for (const mime of mimes) {
    const id = dt.getData(mime);
    if (id) {
      const hit = opts.entries.find((e) => e.id === id);
      return hit ? [hit] : [];
    }
  }
  const files = Array.from(dt.files ?? []);

  const audio = files.filter(isAudioFile);
  const skipped = files.filter((f) => !isAudioFile(f));
  if (skipped.length > 0) {
    logWarn('import', `${skipped.length} non-audio file(s) skipped: ${skipped.map((f) => f.name).join(', ')}`);
  }
  const take = opts.max != null ? audio.slice(0, Math.max(0, opts.max)) : audio;
  if (take.length < audio.length) {
    const rest = audio.slice(take.length);
    logWarn('import', `${rest.length} more file(s) ignored — this target takes ${take.length}: ${rest.map((f) => f.name).join(', ')}`);
  }
  if (take.length === 0) return [];

  const { imported } = await importAudioFiles(take, opts.origin ?? DESKTOP_DROP_ORIGIN, opts.deps);
  return imported;
}
