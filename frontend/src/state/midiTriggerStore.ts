/**
 * MIDI audio-trigger store.
 *
 * Separates two concerns that were previously coupled:
 *   1. MIDI *communication* — raw messages published on midiBus and
 *      forwarded to the VJ iframe so a controller can still drive
 *      visual effects.
 *   2. MIDI *audio triggering* — the built-in piano-synth voice that
 *      App.tsx fires on note-on.
 *
 * When `audioMuted` is true, App.tsx skips the synth voice but still
 * publishes every message on the bus. This lets a performer use a
 * MIDI controller purely as an effects trigger in VJ mode without
 * also hearing synthesized notes layered over the set.
 *
 * Persisted so the preference survives a reload during a performance.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

interface MidiTriggerState {
  /** When true, MIDI note-on events do NOT fire the piano synth voice. */
  audioMuted: boolean;
  setAudioMuted: (muted: boolean) => void;
  toggleAudioMuted: () => void;
}

export const useMidiTriggerStore = create<MidiTriggerState>()(
  persist(
    (set) => ({
      audioMuted: false,
      setAudioMuted: (audioMuted) => set({ audioMuted }),
      toggleAudioMuted: () => set((s) => ({ audioMuted: !s.audioMuted })),
    }),
    { name: 'thedaw.midiTrigger.v1' },
  ),
);

/** Non-React read for App.tsx's MIDI message handler. */
export function isMidiAudioMuted(): boolean {
  return useMidiTriggerStore.getState().audioMuted;
}
