/**
 * Zustand store wrapping the active StorageProvider.
 *
 * The provider is the source of truth — this store is just an in-memory
 * cache + React-reactive surface. No IndexedDB, no Cache API, no blob
 * lifetimes: all of that moved to the backend. The local-dev default
 * provider talks to `/api/library/*` and stores audio on disk.
 */

import { create } from 'zustand';
import { logError, logInfo } from './logStore';
import type { LibraryEntry, LibraryEntryPatch, ImportRequest } from './libraryEntry';
import { getStorageProvider } from '../lib/backendLocalProvider';

export type { LibraryEntry, LibraryEntryPatch, ImportRequest } from './libraryEntry';

export interface LibraryState {
  entries: LibraryEntry[];
  loaded: boolean;
  loading: boolean;
  searchQuery: string;
  onlyFavorites: boolean;
  sortBy: 'newest' | 'oldest' | 'duration' | 'title';
  playingId: string | null;
  selectedEntryId: string | null;

  load: () => Promise<void>;
  refresh: () => Promise<void>;
  /** Add an entry that's already been persisted server-side (e.g. just
   * fetched a single record by id). Inserts at the head if new. */
  upsertEntry: (entry: LibraryEntry) => void;
  /** Upload a blob via the active provider. */
  importEntry: (req: ImportRequest) => Promise<LibraryEntry>;
  removeEntry: (id: string) => Promise<void>;
  removeMany: (ids: string[]) => Promise<{ deleted: number; failed: number }>;
  clearAll: () => Promise<{ deleted: number; failed: number }>;
  updateEntry: (id: string, updates: LibraryEntryPatch) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  setRating: (id: string, rating: 'like' | 'dislike' | null) => Promise<void>;
  setSearchQuery: (q: string) => void;
  setOnlyFavorites: (v: boolean) => void;
  setSortBy: (s: LibraryState['sortBy']) => void;
  setPlayingId: (id: string | null) => void;
  setSelectedEntry: (id: string | null) => void;
  getAudioUrl: (entry: LibraryEntry) => string;
  fetchAudioBlob: (entry: LibraryEntry) => Promise<Blob>;
  getFiltered: () => LibraryEntry[];
}

export const useLibraryStore = create<LibraryState>()((set, get) => ({
  entries: [],
  loaded: false,
  loading: false,
  searchQuery: '',
  onlyFavorites: false,
  sortBy: 'newest',
  playingId: null,
  selectedEntryId: null,

  load: async () => {
    if (get().loading) return;
    set({ loading: true });
    try {
      const entries = await getStorageProvider().list();
      set({ entries, loaded: true, loading: false });
      logInfo('library', `Loaded ${entries.length} entries from ${getStorageProvider().name}`);
    } catch (e) {
      set({ loading: false });
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Failed to load entries: ${msg}`);
    }
  },

  refresh: async () => {
    try {
      const entries = await getStorageProvider().list();
      set({ entries, loaded: true });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `refresh failed: ${msg}`);
    }
  },

  upsertEntry: (entry) => {
    set((s) => {
      const existing = s.entries.find((e) => e.id === entry.id);
      if (existing) {
        return { entries: s.entries.map((e) => (e.id === entry.id ? entry : e)) };
      }
      return { entries: [entry, ...s.entries] };
    });
  },

  importEntry: async (req) => {
    const entry = await getStorageProvider().import(req);
    set((s) => ({ entries: [entry, ...s.entries.filter((e) => e.id !== entry.id)] }));
    logInfo(
      'library',
      `Imported: ${entry.title} (${Math.round(entry.fileSizeBytes / 1024)}KB, ${entry.source})`,
    );
    return entry;
  },

  removeEntry: async (id) => {
    try {
      await getStorageProvider().delete(id);
      set((s) => ({
        entries: s.entries.filter((e) => e.id !== id),
        playingId: s.playingId === id ? null : s.playingId,
        selectedEntryId: s.selectedEntryId === id ? null : s.selectedEntryId,
      }));
      logInfo('library', `Removed entry: ${id.slice(0, 8)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Remove failed: ${msg}`);
    }
  },

  removeMany: async (ids) => {
    const provider = getStorageProvider();
    let deleted = 0;
    let failed = 0;
    for (const id of ids) {
      try {
        await provider.delete(id);
        deleted += 1;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        logError('library', `removeMany: failed to delete ${id}: ${msg}`);
        failed += 1;
      }
    }
    set((s) => ({
      entries: s.entries.filter((e) => !ids.includes(e.id)),
      playingId: s.playingId && ids.includes(s.playingId) ? null : s.playingId,
      selectedEntryId:
        s.selectedEntryId && ids.includes(s.selectedEntryId)
          ? null
          : s.selectedEntryId,
    }));
    logInfo(
      'library',
      `removeMany: ${deleted} deleted, ${failed} failed (of ${ids.length} requested)`,
    );
    return { deleted, failed };
  },

  clearAll: async () => {
    const ids = get().entries.map((e) => e.id);
    return get().removeMany(ids);
  },

  updateEntry: async (id, updates) => {
    try {
      const updated = await getStorageProvider().update(id, updates);
      set((s) => ({ entries: s.entries.map((e) => (e.id === id ? updated : e)) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Update failed: ${msg}`);
    }
  },

  toggleFavorite: async (id) => {
    const current = get().entries.find((e) => e.id === id);
    if (!current) return;
    await get().updateEntry(id, { favorite: !current.favorite });
  },

  setRating: async (id, rating) => {
    await get().updateEntry(id, { rating });
  },

  setSearchQuery: (q) => set({ searchQuery: q }),
  setOnlyFavorites: (v) => set({ onlyFavorites: v }),
  setSortBy: (s) => set({ sortBy: s }),
  setPlayingId: (id) => set({ playingId: id }),
  setSelectedEntry: (id) => set({ selectedEntryId: id }),

  getAudioUrl: (entry) => getStorageProvider().getAudioUrl(entry),

  fetchAudioBlob: (entry) => getStorageProvider().fetchAudioBlob(entry),

  getFiltered: () => {
    const { entries, searchQuery, onlyFavorites, sortBy } = get();
    let filtered = [...entries];
    if (onlyFavorites) filtered = filtered.filter((e) => e.favorite);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      // Numeric search: queries like "120 bpm", "key c", "5min", "30s" or
      // a plain number try to match BPM / duration / key / etc. via
      // analysis_json so users can find tracks by their musical features.
      const num = parseFloat(q);
      const queryIsNumeric = !Number.isNaN(num);
      filtered = filtered.filter((e) => {
        const haystack: string[] = [
          e.title,
          e.prompt,
          e.negativePrompt,
          e.model,
          e.notes,
          e.source,
          e.mimeType,
          e.rating ?? '',
          ...e.tags,
          ...(e.chimeraSources ?? []),
        ];
        // Pull analysis bits stashed by the backend (best-effort; field
        // names mirror the SQLite `analysis` columns we already persist).
        const analysis = (e as unknown as { analysis?: Record<string, unknown> }).analysis;
        if (analysis && typeof analysis === 'object') {
          for (const v of Object.values(analysis)) {
            if (v == null) continue;
            haystack.push(String(v));
          }
        }
        // Embedded ID3/iTunes/etc tags surfaced by the import pipeline.
        const embedded = (e as unknown as { embeddedTags?: Record<string, unknown> }).embeddedTags;
        if (embedded && typeof embedded === 'object') {
          for (const v of Object.values(embedded)) {
            if (v == null) continue;
            haystack.push(String(v));
          }
        }
        const hayLower = haystack.join(' ​ ').toLowerCase();
        if (hayLower.includes(q)) return true;

        // Convenience numeric matches.
        if (queryIsNumeric) {
          if (Math.round(e.duration) === Math.round(num)) return true;
          if (Math.round(e.duration / 60) === Math.round(num)) return true;
        }
        return false;
      });
    }
    if (sortBy === 'newest') filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    else if (sortBy === 'oldest') filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    else if (sortBy === 'duration') filtered.sort((a, b) => b.duration - a.duration);
    else if (sortBy === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title));
    return filtered;
  },
}));
