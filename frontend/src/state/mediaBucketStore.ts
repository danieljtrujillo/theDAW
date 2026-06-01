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

export const useMediaBucketStore = create<MediaBucketState>()((set) => ({
  items: [],
  hydrated: false,
  hydrate: async () => {
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
    const cleanedMeta: PersistedBucketMeta[] = restored.map((item) => ({
      id: item.id,
      name: item.name,
      mimeType: item.mimeType,
      size: item.size,
      addedAt: item.addedAt,
    }));
    saveBucketMeta(cleanedMeta);
    set({ items: restored, hydrated: true });
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

