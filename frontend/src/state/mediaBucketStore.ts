import { create } from 'zustand';
import { logInfo } from './logStore';
import {
  clearBucketBlobs,
  deleteBucketBlob,
  getBucketBlob,
  loadBucketMeta,
  putBucketBlob,
  saveBucketMeta,
  type PersistedBucketMeta,
} from '../lib/mediaBucketPersistence';

export interface BucketItem {
  id: string;
  name: string;
  blob: Blob;
  mimeType: string;
  size: number;
  addedAt: number;
}

interface MediaBucketState {
  items: BucketItem[];
  hydrated: boolean;
  hydrate: () => Promise<void>;
  add: (file: File) => void;
  addMany: (files: FileList | File[]) => void;
  remove: (id: string) => void;
  clear: () => void;
}

const uid = (): string =>
  typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `b-${Math.random().toString(36).slice(2)}-${Date.now()}`;

// Module-level (not store state): several call sites can mount before the
// store has hydrated (MediaBucketView.tsx, SlidePanel.tsx) and each used to
// kick off its own full IndexedDB read + meta rewrite. Shared across every
// `hydrate()` caller so concurrent calls await the SAME in-flight work
// instead of racing duplicate reads/writes.
let hydratePromise: Promise<void> | null = null;

export const useMediaBucketStore = create<MediaBucketState>()((set, get) => ({
  items: [],
  hydrated: false,
  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    if (hydratePromise) return hydratePromise;
    hydratePromise = (async () => {
      const meta = loadBucketMeta();
      const restored: BucketItem[] = [];
      for (const item of meta) {
        const blob = await getBucketBlob(item.id);
        if (!blob) continue;
        restored.push({
          id: item.id,
          name: item.name,
          blob,
          mimeType: item.mimeType,
          size: item.size,
          addedAt: item.addedAt,
        });
      }
      // `restored` is a snapshot built from a `meta` read taken before all of
      // the above awaits. An `add()`/`addMany()` landing while hydrate was
      // still in flight (a caller that doesn't await hydrate first, e.g.
      // trackMenuActions.ts) already applied its own `set()` — replacing
      // `items` outright here would silently discard that item (and orphan
      // the blob its own `add()` already wrote). Merge instead: keep
      // whatever is in the LIVE store now that isn't already accounted for
      // by `restored`, and persist meta for the merged list.
      const liveItems = get().items;
      const addedMeanwhile = liveItems.filter((item) => !restored.some((r) => r.id === item.id));
      const merged = [...addedMeanwhile, ...restored];
      const cleanedMeta: PersistedBucketMeta[] = merged.map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        size: item.size,
        addedAt: item.addedAt,
      }));
      saveBucketMeta(cleanedMeta);
      set({ items: merged, hydrated: true });
    })().finally(() => {
      hydratePromise = null;
    });
    return hydratePromise;
  },
  add: (file) => {
    const item: BucketItem = {
      id: uid(),
      name: file.name,
      blob: file,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      addedAt: Date.now(),
    };
    set((s) => {
      const items = [item, ...s.items];
      saveBucketMeta(
        items.map((x) => ({
          id: x.id,
          name: x.name,
          mimeType: x.mimeType,
          size: x.size,
          addedAt: x.addedAt,
        })),
      );
      return { items };
    });
    void putBucketBlob(item.id, file);
    logInfo('bucket', `Added: ${file.name} (${Math.round(file.size / 1024)} KB)`);
  },
  addMany: (filesIn) => {
    const arr = Array.from(filesIn);
    const next: BucketItem[] = arr.map((file) => ({
      id: uid(),
      name: file.name,
      blob: file,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      addedAt: Date.now(),
    }));
    set((s) => {
      const items = [...next, ...s.items];
      saveBucketMeta(
        items.map((x) => ({
          id: x.id,
          name: x.name,
          mimeType: x.mimeType,
          size: x.size,
          addedAt: x.addedAt,
        })),
      );
      return { items };
    });
    next.forEach((item) => void putBucketBlob(item.id, item.blob));
    logInfo('bucket', `Added ${arr.length} file${arr.length === 1 ? '' : 's'}`);
  },
  remove: (id) => {
    set((s) => {
      const items = s.items.filter((i) => i.id !== id);
      saveBucketMeta(
        items.map((x) => ({
          id: x.id,
          name: x.name,
          mimeType: x.mimeType,
          size: x.size,
          addedAt: x.addedAt,
        })),
      );
      return { items };
    });
    void deleteBucketBlob(id);
  },
  clear: () => {
    set({ items: [] });
    saveBucketMeta([]);
    void clearBucketBlobs();
  },
}));

