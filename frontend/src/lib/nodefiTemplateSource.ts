/**
 * Finds a Nodefi live set's source song in the WHOLE library.
 *
 * `resolveTemplateSource` (data/nodefiTemplates.ts) answers from a list in
 * hand. The LIBRARY tab's store holds only the pages of its own query, so a
 * set's song on no loaded page — or one the LIBRARY tab's search excludes —
 * would read as "import needed" although it is in the library. This asks the
 * backend instead, in the same order of preference: the set's known entry id,
 * then the newest song whose title contains the set's title query.
 */
import {
  DEFAULT_LIBRARY_QUERY,
  fetchLibraryList,
} from './backendLocalProvider';
import type { LibraryListFetcher } from './librarySearch';
import { resolveTemplateSource, type NodefiTemplate } from '../data/nodefiTemplates';
import type { LibraryEntry } from '../state/libraryEntry';
import { useLibraryStore } from '../state/libraryStore';

export interface TemplateSourceDeps {
  /** An entry by id, fetched when no loaded page holds it. */
  ensureEntry: (id: string) => Promise<LibraryEntry | null>;
  fetchList: LibraryListFetcher;
}

const defaultDeps = (): TemplateSourceDeps => ({
  ensureEntry: (id) => useLibraryStore.getState().ensureEntry(id),
  fetchList: fetchLibraryList,
});

/** Rows per title-search request, and how many pages are read at most. */
const PAGE = 200;
const MAX_PAGES = 5;

const isAudio = (e: LibraryEntry): boolean => (e.kind ?? 'audio') === 'audio';

export async function findTemplateSource(
  tpl: NodefiTemplate,
  deps: TemplateSourceDeps = defaultDeps(),
): Promise<LibraryEntry | null> {
  if (tpl.source.entryId) {
    const byId = await deps.ensureEntry(tpl.source.entryId);
    if (byId && isAudio(byId)) return byId;
  }
  const needle = tpl.source.titleQuery.toLowerCase();
  // The search finds every song whose text holds the title query's words;
  // the title test below keeps the ones whose TITLE contains it.
  const query = { ...DEFAULT_LIBRARY_QUERY, q: tpl.source.titleQuery, kind: 'audio', sort: 'created_desc' as const };
  let offset = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await deps.fetchList(query, offset, PAGE);
    if (!result.paged || !result.page) {
      // A backend that does not page answered with the whole library.
      return resolveTemplateSource(tpl, (result.entries ?? []).filter(isAudio));
    }
    const hit = result.page.entries.find((e) => (e.title || '').toLowerCase().includes(needle));
    if (hit) return hit;
    offset += result.page.entries.length;
    if (result.page.entries.length === 0 || offset >= result.page.total) break;
  }
  return null;
}
