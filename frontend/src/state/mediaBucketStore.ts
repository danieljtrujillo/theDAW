import { create } from 'zustand';
import { logInfo } from './logStore';

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
  add: (file) => {
    const item: BucketItem = {
      id: uid(),
      name: file.name,
      blob: file,
      mimeType: file.type || 'application/octet-stream',
      size: file.size,
      addedAt: Date.now(),
    };
    set((s) => ({ items: [item, ...s.items] }));
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
    set((s) => ({ items: [...next, ...s.items] }));
    logInfo('bucket', `Added ${arr.length} file${arr.length === 1 ? '' : 's'}`);
  },
  remove: (id) =>
    set((s) => ({ items: s.items.filter((i) => i.id !== id) })),
  clear: () => set({ items: [] }),
}));
