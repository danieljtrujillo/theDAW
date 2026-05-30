import { create } from 'zustand';

interface PlaybackStoreState {
  volume: number; // 0..100
  muted: boolean;
  setVolume: (v: number) => void;
  toggleMute: () => void;
  /** Effective gain (0..1), honoring mute. */
  gain: () => number;
}

export const usePlaybackStore = create<PlaybackStoreState>()((set, get) => ({
  volume: 75,
  muted: false,
  setVolume: (v) => set({ volume: Math.max(0, Math.min(100, v)) }),
  toggleMute: () => set((s) => ({ muted: !s.muted })),
  gain: () => {
    const s = get();
    return s.muted ? 0 : s.volume / 100;
  },
}));

