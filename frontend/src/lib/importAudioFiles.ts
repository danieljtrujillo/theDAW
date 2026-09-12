/**
 * Audio files -> library entries, the one implementation behind every import
 * surface: the header IMPORT button (picker and drop), HOME's Import Audio,
 * and the DJ deck / set drops. Before this file the DJ view carried its own
 * copy of the decode + request shape and each new surface would have copied it
 * again; now only the provenance (`AudioImportOrigin`) differs per caller.
 *
 * Logging: `libraryStore.importEntry` already writes one `Imported: <title>`
 * line per entry, so this file logs only failures and a multi-file summary —
 * a per-file success line here would show every file twice in the LOG.
 *
 * `deps` is injectable so the pure test can run under plain node with a fake
 * `importEntry` (no fetch) and no Web Audio (no duration decode).
 */
import type { ImportRequest, LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';
import { logError, logInfo } from '../state/logStore';
import { hasAudioExt } from './fileFilters';

/** Where the file came from, as the library records it. */
export interface AudioImportOrigin {
  prompt: string;
  tags: string[];
}

/**
 * Mime OR extension: Windows hands many audio files over with an empty mime
 * type (fileFilters.ts explains), so a mime-only check would drop a .wav.
 */
export const isAudioFile = (file: File): boolean =>
  file.type.startsWith('audio/') || hasAudioExt(file.name);

/**
 * Decode just far enough to read the duration. Undefined when there is no
 * Web Audio (node, or a browser without it); callers treat a decode failure
 * the same way, so an undecodable file still imports — only without a length.
 */
export const decodeAudioDuration = async (file: File): Promise<number | undefined> => {
  if (typeof window === 'undefined') return undefined;
  const AudioContextCtor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextCtor) return undefined;
  const ctx = new AudioContextCtor();
  try {
    const decoded = await ctx.decodeAudioData(await file.arrayBuffer());
    return decoded.duration;
  } finally {
    await ctx.close().catch(() => undefined);
  }
};

/** The request the library provider uploads. Pure: no I/O, no store. */
export const audioImportRequest = (
  file: File,
  origin: AudioImportOrigin,
  duration?: number,
): ImportRequest => ({
  blob: file,
  filename: file.name,
  mimeType: file.type || undefined,
  metadata: {
    title: file.name.replace(/\.[^.]+$/, '') || file.name,
    prompt: origin.prompt,
    model: 'imported',
    duration,
    source: 'import',
    tags: origin.tags,
  },
});

export interface ImportAudioDeps {
  /** Defaults to the library store's importEntry, read at call time. */
  importEntry?: (req: ImportRequest) => Promise<LibraryEntry>;
  /** Defaults to decodeAudioDuration. */
  decodeDuration?: (file: File) => Promise<number | undefined>;
}

export const importAudioFile = async (
  file: File,
  origin: AudioImportOrigin,
  deps: ImportAudioDeps = {},
): Promise<LibraryEntry> => {
  const decode = deps.decodeDuration ?? decodeAudioDuration;
  const importEntry = deps.importEntry ?? useLibraryStore.getState().importEntry;
  const duration = await decode(file).catch(() => undefined);
  return importEntry(audioImportRequest(file, origin, duration));
};

export interface ImportAudioFilesResult {
  /** In file order. */
  imported: LibraryEntry[];
  failed: Array<{ file: File; error: string }>;
}

/**
 * Import several files, one after another (the backend upload is sequential
 * anyway, and it keeps the library order equal to the pick order). One file
 * failing does not stop the rest: its error is logged and recorded in
 * `failed`, and the loop moves on.
 */
export const importAudioFiles = async (
  files: Iterable<File>,
  origin: AudioImportOrigin,
  deps: ImportAudioDeps = {},
): Promise<ImportAudioFilesResult> => {
  const imported: LibraryEntry[] = [];
  const failed: ImportAudioFilesResult['failed'] = [];
  let count = 0;
  for (const file of files) {
    count += 1;
    try {
      imported.push(await importAudioFile(file, origin, deps));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      failed.push({ file, error });
      logError('import', `${file.name}: ${error}`);
    }
  }
  if (count > 1) logInfo('import', `${imported.length} file(s) imported, ${failed.length} failed`);
  return { imported, failed };
};
