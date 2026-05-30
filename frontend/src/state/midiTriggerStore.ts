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
  /** Master Web MIDI gate. Default OFF so the app never calls
   *  navigator.requestMIDIAccess() at load — that call triggers Chrome's
   *  Web MIDI permission prompt + a deprecation notice. We only request
   *  access once the user explicitly turns MIDI on (the "MIDI" toggle, or
   *  opening a MIDI mapper). */
  enabled: boolean;
  /** When true, MIDI note-on events do NOT fire the piano synth voice. */
  audioMuted: boolean;
  setEnabled: (enabled: boolean) => void;
  toggleEnabled: () => void;
  setAudioMuted: (muted: boolean) => void;
  toggleAudioMuted: () => void;
}

export const useMidiTriggerStore = create<MidiTriggerState>()(
  persist(
    (set) => ({
      enabled: false,
      audioMuted: false,
      setEnabled: (enabled) => set({ enabled }),
      toggleEnabled: () => set((s) => ({ enabled: !s.enabled })),
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

/** Turn MIDI on from non-React call sites (e.g. opening a MIDI mapper in
 *  the piano roll / sequencer) so mapping works without hunting for the
 *  toggle. No-op if already on. */
export function enableMidi(): void {
  if (!useMidiTriggerStore.getState().enabled) {
    useMidiTriggerStore.getState().setEnabled(true);
  }
}

