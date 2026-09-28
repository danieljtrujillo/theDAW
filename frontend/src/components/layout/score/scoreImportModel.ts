/**
 * The SCORE rail's IMPORT SCORE FILE and BROWSE CORPUS controls, as data: which
 * files the picker takes, whether a query is searched yet, how a corpus piece
 * reads in the results list, and how the list's keyboard selection moves.
 * Pure: no React, no DOM, so the tsx test runs it under plain node.
 *
 * The extensions are the ones POST /api/notation/import takes
 * (backend/modules/notation/score_import.py KIND_FOR_IMPORT_SUFFIX); the
 * backend's capabilities answer them too (caps.score_import.extensions), and
 * that answer wins when it has come.
 */
import type { CorpusPiece, NotationCapabilities } from '../../../lib/notationClient';

/** What IMPORT SCORE FILE accepts when the backend has not said. */
export const SCORE_IMPORT_EXTENSIONS = ['.musicxml', '.xml', '.mxl', '.krn', '.abc'] as const;

/** The shortest query the corpus is searched for (the backend's MIN_QUERY_CHARS). */
export const CORPUS_MIN_QUERY = 2;

/** How long typing rests before the corpus is searched. */
export const CORPUS_SEARCH_DEBOUNCE_MS = 250;

/** The extensions the picker offers: the backend's list once it has answered. */
export function importExtensions(caps: NotationCapabilities | null): string[] {
  const listed = caps?.score_import?.extensions;
  return listed && listed.length > 0 ? listed.map((e) => e.toLowerCase()) : [...SCORE_IMPORT_EXTENSIONS];
}

/** The file input's `accept` attribute. */
export function acceptAttribute(caps: NotationCapabilities | null): string {
  return importExtensions(caps).join(',');
}

/** True when a file name ends in an extension the import takes. */
export function isImportableScoreName(name: string, caps: NotationCapabilities | null = null): boolean {
  const lower = name.trim().toLowerCase();
  return importExtensions(caps).some((ext) => lower.endsWith(ext));
}

/** Why a picked file is refused before it is sent, or null when it is fine. */
export function importRefusal(file: { name: string; size: number }, caps: NotationCapabilities | null): string | null {
  if (!isImportableScoreName(file.name, caps)) {
    return `${file.name} is not a score file. Import takes ${importExtensions(caps).join(', ')}.`;
  }
  if (file.size === 0) return `${file.name} is empty.`;
  const max = caps?.score_import?.max_bytes;
  if (max && file.size > max) {
    return `${file.name} is larger than ${Math.round(max / (1024 * 1024))} MB.`;
  }
  return null;
}

/** The query as it is sent: whitespace collapsed; null while too short. */
export function corpusQuery(raw: string): string | null {
  const q = raw.split(/\s+/).filter(Boolean).join(' ');
  return q.length >= CORPUS_MIN_QUERY ? q : null;
}

/** A results row: the title leads, then movement and composer. */
export interface CorpusRow {
  id: string;
  primary: string;
  secondary: string;
  /** The whole row read out for a screen reader and shown on hover. */
  label: string;
}

export function corpusRow(piece: CorpusPiece): CorpusRow {
  const primary = piece.title || piece.path;
  const bits: string[] = [];
  if (piece.movement) bits.push(piece.movement);
  bits.push(piece.composer || 'Composer unknown');
  if (piece.parts) bits.push(`${piece.parts} ${piece.parts === 1 ? 'part' : 'parts'}`);
  const secondary = bits.join(' · ');
  return { id: piece.id, primary, secondary, label: `${primary}, ${secondary}, ${piece.path}` };
}

/** The listbox's next active row for a key, or null when the key does not move it. */
export function nextActiveIndex(key: string, active: number, count: number): number | null {
  if (count <= 0) return null;
  switch (key) {
    case 'ArrowDown':
      return active < 0 ? 0 : Math.min(count - 1, active + 1);
    case 'ArrowUp':
      return active < 0 ? count - 1 : Math.max(0, active - 1);
    case 'Home':
      return 0;
    case 'End':
      return count - 1;
    case 'PageDown':
      return Math.min(count - 1, Math.max(0, active) + 10);
    case 'PageUp':
      return Math.max(0, Math.max(0, active) - 10);
    default:
      return null;
  }
}

/** The line under the results: how many matched and how many are shown. */
export function resultsSummary(query: string | null, total: number, shown: number, loading: boolean): string {
  if (!query) return `Type ${CORPUS_MIN_QUERY} or more letters to search the music21 corpus.`;
  if (loading) return `Searching for “${query}”…`;
  if (total === 0) return `Nothing in the corpus matches “${query}”.`;
  return total > shown ? `${total} pieces match; the first ${shown} are listed.` : `${total} ${total === 1 ? 'piece matches' : 'pieces match'}.`;
}
