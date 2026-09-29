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

/**
 * What a MIDI row in the library's MIDI sub-tab puts on a drag. Deliberately
 * NOT `LIBRARY_ID_MIME`: the value is a row id in the `midis` table, not a
 * library entry id, so `entriesFromDrop` could never resolve it — it would
 * look the id up in the entries array, miss, and the drop would die silently
 * as "entry not found". A separate mime makes a target opt in explicitly.
 */
export const MIDI_ID_MIME = 'application/x-thedaw-midi-id';

/**
 * What a Library track row puts on a drag when it is part of a multi-selection:
 * a `JSON.stringify(string[])` of the selected entry ids, in selection order
 * with the dragged row FIRST. `LIBRARY_ID_MIME` is still written alongside it
 * (the single dragged id) so legacy single-id targets keep working; a target
 * that understands multi reads this one first. Only library entry ids go here.
 */
export const LIBRARY_IDS_MIME = 'application/x-thedaw-library-ids';

/**
 * What a separated-stem row in the library's stem sub-tab puts on a drag. Like
 * `MIDI_ID_MIME`, deliberately NOT `LIBRARY_ID_MIME`: the value is a row id in
 * the `stems` table, not a library entry id, so `entriesFromDrop` could never
 * resolve it. A target opts in explicitly and fetches the stem's audio.
 */
export const STEM_ID_MIME = 'application/x-thedaw-stem-id';

/**
 * Written beside `STEM_ID_MIME`: the library entry id of the song the stem was
 * separated from. The stem is that song's own time, so the clip it lands as is
 * tied to the song's analysis (lib/clipSongTime) and SYNC and "Use song tempo"
 * read the song's tempo, beats and downbeats for it.
 */
export const STEM_SONG_MIME = 'application/x-thedaw-stem-song';

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

/**
 * What a drop on a list OF the library means: 'import' for files off the
 * desktop, 'ignore' for anything else — including an in-app library row,
 * which is already in the library, so dropping it back is a no-op.
 *
 * Both the dragover gate and the drop handler ask this one question, so a
 * surface can never highlight for a drag it will then refuse (or the reverse).
 */
export type LibraryListDropIntent = 'import' | 'ignore';

export function libraryListDropIntent(dt: DataTransfer): LibraryListDropIntent {
  const types = Array.from(dt.types ?? []);
  if (types.includes(LIBRARY_ID_MIME)) return 'ignore';
  // `[]`: no in-app mime counts here, only files from the OS.
  return dropHasLibraryOrFiles(dt, []) ? 'import' : 'ignore';
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
  // A multi-selection library drag carries every selected id (dragged row
  // first). Only honoured for a library-mime caller; a >0 id list resolves to
  // its entries, skipping misses. An empty/malformed payload falls through to
  // the single-id branch below, so single drags are untouched.
  if (mimes.includes(LIBRARY_ID_MIME)) {
    const raw = dt.getData(LIBRARY_IDS_MIME);
    if (raw) {
      let ids: unknown;
      try {
        ids = JSON.parse(raw);
      } catch {
        ids = null;
      }
      if (Array.isArray(ids) && ids.length > 0) {
        const resolved = ids
          .map((id) => opts.entries.find((e) => e.id === id))
          .filter((e): e is LibraryEntry => e != null);
        // `max` binds here exactly as it does on the file path below: a
        // single-slot target (a sampler pad, the MIDI song box) takes the first.
        return opts.max != null ? resolved.slice(0, Math.max(0, opts.max)) : resolved;
      }
    }
  }
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
