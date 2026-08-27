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
  /** Master Web MIDI gate. Default ON.
   *
   *  It used to default OFF to avoid Chrome's Web MIDI permission prompt and
   *  deprecation notice at load. The cost of that was worse than the prompt:
   *  theDAW owns the ONLY requestMIDIAccess() in the app and relays hardware to
   *  the SwayCommand cockpit over postMessage, so with the gate off a connected
   *  Sway was invisible to theDAW even while the standalone app saw it fine —
   *  the controller simply did nothing until you found an unrelated toggle.
   *  A hardware surface has to work when it is plugged in. */
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
      enabled: true,
      audioMuted: false,
      setEnabled: (enabled) => set({ enabled }),
      toggleEnabled: () => set((s) => ({ enabled: !s.enabled })),
      setAudioMuted: (audioMuted) => set({ audioMuted }),
      toggleAudioMuted: () => set((s) => ({ audioMuted: !s.audioMuted })),
    }),
    {
      name: 'thedaw.midiTrigger.v1',
      // v1 shipped with enabled:false persisted for everyone who ever loaded the
      // app, so changing the default alone would leave every existing install
      // still dark. Bumping the version re-runs migrate, which adopts the new
      // default once; audioMuted (a real preference) is carried across.
      version: 2,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as Partial<MidiTriggerState>;
        if (from < 2) return { ...p, enabled: true } as MidiTriggerState;
        return p as MidiTriggerState;
      },
    },
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

