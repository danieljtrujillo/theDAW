import { create } from 'zustand';

interface AdvancedEditorSourceState {
  sourceFile: File | null;
  outputUrl: string | null;
  setSource: (file: File | null) => void;
  setOutputUrl: (url: string | null) => void;
  clear: () => void;
}

export const useAdvancedEditorSourceStore = create<AdvancedEditorSourceState>()((set, get) => ({
  sourceFile: null,
  outputUrl: null,
  setSource: (sourceFile) => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({ sourceFile, outputUrl: null });
  },
  setOutputUrl: (outputUrl) => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({ outputUrl });
  },
  clear: () => {
    const prev = get().outputUrl;
    if (prev) URL.revokeObjectURL(prev);
    set({ sourceFile: null, outputUrl: null });
  },
}));
