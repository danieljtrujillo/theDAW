/**
 * EDIT-layout theme selection. Persists which color theme the multitrack
 * editor uses, plus an optional custom background image (stored as a data URL
 * so it survives reloads without a disk path). Consumed by WaveformEditor via
 * resolveEditThemeVars() in lib/editThemes.ts.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { CUSTOM_IMAGE_ID } from '../lib/editThemes';

interface EditThemeState {
  themeId: string;
  customImage: string | null; // data URL of a user-picked background image
  setTheme: (id: string) => void;
  setCustomImage: (dataUrl: string | null) => void;
}

export const useEditThemeStore = create<EditThemeState>()(
  persist(
    (set) => ({
      themeId: 'midnight',
      customImage: null,
      setTheme: (id) => set({ themeId: id }),
      setCustomImage: (dataUrl) =>
        set({
          customImage: dataUrl,
          themeId: dataUrl ? CUSTOM_IMAGE_ID : 'midnight',
        }),
    }),
    { name: 'thedaw-edit-theme-v1', version: 1 },
  ),
);
