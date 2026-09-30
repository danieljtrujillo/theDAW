/**
 * The library's client-side search test, for a backend that does not page.
 *
 * A paged backend answers a search in SQL (`backend/modules/library/db.py`,
 * `_search_rids_sql`), and that search finds everything this one finds. This is
 * the same test for the rows a client holds when the backend hands it the
 * whole library instead: the LIBRARY tab's store and every other surface that
 * searches the library (`librarySearch.ts`) use it, so the answers agree.
 *
 * A query matches when it occurs, case-insensitively, in any text field of the
 * entry — title, prompt, negative prompt, model, notes, source, provider, MIME
 * type, rating, tags, chimera sources, every analysis value (BPM and key
 * included) and every embedded file tag (artist, album, ...) — or, when it
 * reads as a number, when the duration rounds to that many seconds or
 * minutes.
 */
import type { LibraryEntry } from '../state/libraryEntry';
import { providerSearchText } from './providerLabel';

export function entryMatchesSearch(entry: LibraryEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const haystack: string[] = [
    entry.title,
    entry.prompt,
    entry.negativePrompt,
    entry.model,
    entry.notes,
    entry.source,
    // The provider reads like a source to a searching user, so "suno" finds
    // Suno tracks exactly as "import" finds imports. Same helper the
    // Catalogue's own haystack uses.
    providerSearchText(entry),
    entry.mimeType,
    entry.rating ?? '',
    ...entry.tags,
    ...(entry.chimeraSources ?? []),
  ];
  // Analysis values stashed by the backend; the field names mirror the
  // SQLite `analysis` columns.
  const analysis = entry.analysis;
  if (analysis && typeof analysis === 'object') {
    for (const v of Object.values(analysis)) {
      if (v == null) continue;
      haystack.push(String(v));
    }
  }
  // Embedded ID3/iTunes/etc tags surfaced by the import pipeline.
  const embedded = entry.embeddedTags;
  if (embedded && typeof embedded === 'object') {
    for (const v of Object.values(embedded)) {
      if (v == null) continue;
      haystack.push(String(v));
    }
  }
  if (haystack.join(' ​ ').toLowerCase().includes(q)) return true;
  // Numeric queries — "120", "5min", "3:30" — also try the duration.
  const num = parseFloat(q);
  if (!Number.isNaN(num)) {
    if (Math.round(entry.duration) === Math.round(num)) return true;
    if (Math.round(entry.duration / 60) === Math.round(num)) return true;
  }
  return false;
}
