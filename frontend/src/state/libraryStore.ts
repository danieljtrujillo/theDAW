import { create } from 'zustand';
import { logError, logInfo } from './logStore';

export interface LibraryEntry {
  id: string;
  title: string;
  prompt: string;
  negativePrompt: string;
  model: string;
  duration: number;
  steps: number;
  cfg: number;
  seed: number;
  audioBlob: Blob;
  mimeType: string;
  timestamp: string;
  favorite: boolean;
  rating: 'like' | 'dislike' | null;
  tags: string[];
  notes: string;
  source: 'generate' | 'studio' | 'import';
}

const DB_NAME = 'sa3-library';
const DB_VERSION = 2;
const STORE_NAME = 'generations';

const openDB = (): Promise<IDBDatabase> =>
  new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('timestamp', 'timestamp', { unique: false });
        store.createIndex('favorite', 'favorite', { unique: false });
      } else if (event.oldVersion < 2) {
        // No-op; version bump for any future migration hooks.
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });

const getAllEntries = async (): Promise<LibraryEntry[]> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const store = tx.objectStore(STORE_NAME);
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result as LibraryEntry[]);
    req.onerror = () => reject(req.error);
  });
};

const putEntry = async (entry: LibraryEntry): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

const deleteEntry = async (id: string): Promise<void> => {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
};

// Blob URL rehydration cache — one URL per entry id for the lifetime of the page.
const blobUrlCache = new Map<string, string>();

const urlFor = (entry: LibraryEntry): string => {
  const existing = blobUrlCache.get(entry.id);
  if (existing) return existing;
  const url = URL.createObjectURL(entry.audioBlob);
  blobUrlCache.set(entry.id, url);
  return url;
};

const releaseUrl = (id: string): void => {
  const url = blobUrlCache.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    blobUrlCache.delete(id);
  }
};

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
  addEntry: (entry: LibraryEntry) => Promise<void>;
  removeEntry: (id: string) => Promise<void>;
  updateEntry: (id: string, updates: Partial<LibraryEntry>) => Promise<void>;
  toggleFavorite: (id: string) => Promise<void>;
  setRating: (id: string, rating: 'like' | 'dislike' | null) => Promise<void>;
  setSearchQuery: (q: string) => void;
  setOnlyFavorites: (v: boolean) => void;
  setSortBy: (s: LibraryState['sortBy']) => void;
  setPlayingId: (id: string | null) => void;
  setSelectedEntry: (id: string | null) => void;
  getAudioUrl: (entry: LibraryEntry) => string;
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
      const entries = await getAllEntries();
      set({ entries, loaded: true, loading: false });
      logInfo('library', `Loaded ${entries.length} entries from IndexedDB`);
    } catch (e) {
      set({ loading: false });
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Failed to load entries: ${msg}`);
    }
  },

  addEntry: async (entry) => {
    try {
      await putEntry(entry);
      set((s) => ({ entries: [entry, ...s.entries] }));
      logInfo('library', `Saved: ${entry.title} (${Math.round(entry.audioBlob.size / 1024)}KB)`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Save failed: ${msg}`);
    }
  },

  removeEntry: async (id) => {
    try {
      await deleteEntry(id);
      releaseUrl(id);
      set((s) => ({
        entries: s.entries.filter((e) => e.id !== id),
        playingId: s.playingId === id ? null : s.playingId,
      }));
      logInfo('library', `Removed entry: ${id.slice(0, 8)}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Remove failed: ${msg}`);
    }
  },

  updateEntry: async (id, updates) => {
    const state = get();
    const entry = state.entries.find((e) => e.id === id);
    if (!entry) return;
    const updated = { ...entry, ...updates };
    try {
      await putEntry(updated);
      set((s) => ({ entries: s.entries.map((e) => (e.id === id ? updated : e)) }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Unknown error';
      logError('library', `Update failed: ${msg}`);
    }
  },

  toggleFavorite: async (id) => {
    const entry = get().entries.find((e) => e.id === id);
    if (!entry) return;
    await get().updateEntry(id, { favorite: !entry.favorite });
  },

  setRating: async (id, rating) => {
    await get().updateEntry(id, { rating });
  },

  setSearchQuery: (searchQuery) => set({ searchQuery }),
  setOnlyFavorites: (onlyFavorites) => set({ onlyFavorites }),
  setSortBy: (sortBy) => set({ sortBy }),
  setPlayingId: (playingId) => set({ playingId }),
  setSelectedEntry: (selectedEntryId) => set({ selectedEntryId }),

  getAudioUrl: (entry) => urlFor(entry),

  getFiltered: () => {
    const { entries, searchQuery, onlyFavorites, sortBy } = get();
    let filtered = [...entries];
    if (onlyFavorites) filtered = filtered.filter((e) => e.favorite);
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toLowerCase();
      filtered = filtered.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.prompt.toLowerCase().includes(q) ||
          e.model.toLowerCase().includes(q) ||
          e.tags.some((t) => t.toLowerCase().includes(q)) ||
          e.notes.toLowerCase().includes(q),
      );
    }
    if (sortBy === 'newest') filtered.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
    else if (sortBy === 'oldest') filtered.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    else if (sortBy === 'duration') filtered.sort((a, b) => b.duration - a.duration);
    else if (sortBy === 'title') filtered.sort((a, b) => a.title.localeCompare(b.title));
    return filtered;
  },
}));
