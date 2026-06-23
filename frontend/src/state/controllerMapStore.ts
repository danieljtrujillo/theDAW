/**
 * Controller MAP store — binds each PHYSICAL control on the connected MIDI
 * device to a device POSITION in the SLIDE controller layout, so incoming MIDI
 * lands on the right on-screen knob / fader / button.
 *
 * Why position-based (not catalog-item-based): a hardware control at grid
 * position P should always drive "whatever's in slot P on the current page".
 * Paging (bank) shifts which catalog item position P addresses — exactly how
 * banked controllers work. So the binding is `position → MidiBinding`, stable
 * across pages, stored per controller profile.
 *
 * MAP mode (controller view): the user either
 *   - hits Auto-map and wiggles each control in order (auto-advance), or
 *   - clicks a single slot's chip and wiggles that one control (click-to-learn).
 * Either way the next CC / note-on seen binds to the target position. Bindings
 * persist per profile so the setup survives reloads.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export interface MidiBinding {
  kind: 'cc' | 'note';
  /** CC# or note number, 0-127. */
  number: number;
  /** MIDI channel 0-15 the binding was learned on. */
  channel: number;
}

/** Short chip label for a binding (or — when unmapped). */
export function bindingLabel(b?: MidiBinding | null): string {
  if (!b) return '—';
  return `${b.kind === 'cc' ? 'CC' : 'N'}${b.number}`;
}

type ProfileBindings = Record<number, MidiBinding>; // position → binding

interface ControllerMapState {
  /** profileId → (position → binding). Persisted. */
  bindings: Record<string, ProfileBindings>;
  /** MAP mode active (controller view shows chips + accepts learn). Session. */
  mapMode: boolean;
  /** Position currently waiting to learn, or null when idle. Session. */
  learnPos: number | null;
  /** True while the Auto-map walk is advancing through positions. Session. */
  autoWalk: boolean;

  setMapMode: (on: boolean) => void;
  setLearnPos: (pos: number | null) => void;
  setAutoWalk: (on: boolean) => void;
  bind: (profileId: string, pos: number, binding: MidiBinding) => void;
  clearPos: (profileId: string, pos: number) => void;
  clearProfile: (profileId: string) => void;
}

export const useControllerMapStore = create<ControllerMapState>()(
  persist(
    (set) => ({
      bindings: {},
      mapMode: false,
      learnPos: null,
      autoWalk: false,

      setMapMode: (mapMode) =>
        set(mapMode ? { mapMode } : { mapMode, learnPos: null, autoWalk: false }),
      setLearnPos: (learnPos) => set({ learnPos }),
      setAutoWalk: (autoWalk) => set({ autoWalk }),

      bind: (profileId, pos, binding) =>
        set((s) => ({
          bindings: {
            ...s.bindings,
            [profileId]: { ...(s.bindings[profileId] ?? {}), [pos]: binding },
          },
        })),

      clearPos: (profileId, pos) =>
        set((s) => {
          const prof = { ...(s.bindings[profileId] ?? {}) };
          delete prof[pos];
          return { bindings: { ...s.bindings, [profileId]: prof } };
        }),

      clearProfile: (profileId) =>
        set((s) => ({ bindings: { ...s.bindings, [profileId]: {} } })),
    }),
    {
      name: 'thedaw-controller-map-v1',
      // Only the learned bindings persist; map-mode/learn state is per session.
      partialize: (s) => ({ bindings: s.bindings }),
    },
  ),
);

/** Non-React read of a profile's bindings (for the MIDI routing runtime). */
export function getProfileBindings(profileId: string): ProfileBindings {
  return useControllerMapStore.getState().bindings[profileId] ?? {};
}
