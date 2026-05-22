import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { uuid } from '../orb-kit/utils';

export interface SavedPrompt {
  id: string;
  label: string;
  prompt: string;
  negativePrompt: string;
  tags: string[];
  createdAt: string;
}

interface PromptLibraryState {
  prompts: SavedPrompt[];
  searchQuery: string;
  save: (p: Omit<SavedPrompt, 'id' | 'createdAt'>) => void;
  remove: (id: string) => void;
  update: (id: string, updates: Partial<SavedPrompt>) => void;
  setSearch: (q: string) => void;
  getFiltered: () => SavedPrompt[];
}

export const usePromptLibraryStore = create<PromptLibraryState>()(
  persist(
    (set, get) => ({
      prompts: [],
      searchQuery: '',
      save: (p) => set((s) => ({
        prompts: [{ ...p, id: uuid(), createdAt: new Date().toISOString() }, ...s.prompts],
      })),
      remove: (id) => set((s) => ({ prompts: s.prompts.filter((x) => x.id !== id) })),
      update: (id, updates) => set((s) => ({
        prompts: s.prompts.map((x) => (x.id === id ? { ...x, ...updates } : x)),
      })),
      setSearch: (searchQuery) => set({ searchQuery }),
      getFiltered: () => {
        const { prompts, searchQuery } = get();
        if (!searchQuery.trim()) return prompts;
        const q = searchQuery.toLowerCase();
        return prompts.filter(
          (p) => p.label.toLowerCase().includes(q) || p.prompt.toLowerCase().includes(q) || p.tags.some((t) => t.toLowerCase().includes(q)),
        );
      },
    }),
    { name: 'stabledaw-prompt-library' },
  ),
);
