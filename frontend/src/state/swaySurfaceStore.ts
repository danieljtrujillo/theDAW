/**
 * State for the Audima Sway DAW-control surface mirror.
 *
 * The physical "Audima Labs The Sway" controller ships an Ableton Remote Script
 * that maps it to a conventional mixer/transport/pad surface. This store gates a
 * mode that mirrors that surface onto theDAW's EDIT timeline (see swaySurface.ts).
 * It is distinct from the expressive-dimension use of the same device (swayBus),
 * which reads its CCs as learnable 0..1 signals; the DAW-control toggle picks
 * which way the one controller is used.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type SwayPadMode = 'drums' | 'track' | 'piano';

/** Human labels for the pad-behavior selector. */
export const SWAY_PAD_MODE_LABELS: Record<SwayPadMode, string> = {
  drums: 'GM Drum Kit',
  track: 'Selected Track',
  piano: 'Piano Synth',
};

export const SWAY_PAD_MODES: SwayPadMode[] = ['drums', 'track', 'piano'];

interface SwaySurfaceState {
  /** When on, the Sway's faders/knobs/pads/play drive theDAW's mixer, transport,
   *  and pads instead of being free for expressive-dimension learn. */
  enabled: boolean;
  /** Set once the user explicitly toggles, so auto-detect stops overriding. */
  touched: boolean;
  /** What the 16 pads trigger. */
  padMode: SwayPadMode;
  /** Sustain: latch pad notes (hold until the pad is pressed again) and voice
   *  melodic pads with a sustaining patch, so a held pad rings indefinitely. */
  sustain: boolean;
  setEnabled: (v: boolean) => void;
  setPadMode: (m: SwayPadMode) => void;
  setSustain: (v: boolean) => void;
  /** Enable from device auto-detection; a no-op once the user has toggled. */
  autoEnable: () => void;
}

export const useSwaySurfaceStore = create<SwaySurfaceState>()(
  persist(
    (set, get) => ({
      enabled: false,
      touched: false,
      padMode: 'drums',
      sustain: false,
      setEnabled: (v) => set({ enabled: v, touched: true }),
      setPadMode: (m) => set({ padMode: m }),
      setSustain: (v) => set({ sustain: v }),
      autoEnable: () => {
        if (!get().touched) set({ enabled: true });
      },
    }),
    { name: 'thedaw-sway-surface-v1' },
  ),
);

/** Non-React reads for the module-level engine. */
export const isSwaySurfaceEnabled = (): boolean => useSwaySurfaceStore.getState().enabled;
export const getSwayPadMode = (): SwayPadMode => useSwaySurfaceStore.getState().padMode;
export const isSwaySustain = (): boolean => useSwaySurfaceStore.getState().sustain;
