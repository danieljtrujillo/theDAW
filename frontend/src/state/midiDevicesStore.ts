/**
 * midiDevicesStore — the names of currently-connected MIDI input devices.
 *
 * App.tsx owns the single Web MIDI listener; it also calls `setMidiInputs()`
 * here whenever the device list changes (initial enumerate + hot-plug
 * `onstatechange`). Consumers (the SLIDE controller picker, the DJ tab) read
 * this to auto-detect a controller profile by name and to show what's plugged
 * in — without each opening its own MIDIAccess.
 *
 * Names only: this is a UI/detection convenience, not the MIDI data path (that
 * stays on midiBus). Session state, not persisted.
 */
import { create } from 'zustand';

interface MidiDevicesState {
  /** Reported names of connected MIDI INPUTS, in enumeration order. */
  inputs: string[];
  setMidiInputs: (names: string[]) => void;
}

export const useMidiDevicesStore = create<MidiDevicesState>()((set) => ({
  inputs: [],
  setMidiInputs: (names) =>
    set((s) => {
      // Avoid churn: only update when the set actually changed (onstatechange
      // can fire for unrelated reasons).
      if (s.inputs.length === names.length && s.inputs.every((n, i) => n === names[i])) {
        return s;
      }
      return { inputs: names };
    }),
}));

/** Non-React read for module-level callers. */
export function getMidiInputs(): string[] {
  return useMidiDevicesStore.getState().inputs;
}
