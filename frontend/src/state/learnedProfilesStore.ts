/**
 * learnedProfilesStore — controller profiles BUILT from a live MIDI capture.
 *
 * Why this exists: MIDI (and Web MIDI) gives no standard way to read a device's
 * physical control layout from its firmware — `input.name` is the only metadata
 * a browser sees. (MIDI 2.0 Property Exchange could, but no browser exposes it
 * and almost no gear implements it.) So for custom / combined / unlisted rigs —
 * e.g. a 92-control setup — the only universal way to get an EXACT layout is to
 * listen to what the device actually sends and build from that. This is how
 * Mixxx/Traktor/Serato "learn" a controller too.
 *
 * Capture flow (driven by the UI):
 *   1. start() — begin listening to the global midiBus.
 *   2. user exercises every control once (twist knobs, push faders, hit pads).
 *   3. each distinct (kind, number, channel) is recorded; a CC whose value
 *      varies across a range is a CONTINUOUS control (knob/fader), a note-on is
 *      a PAD. We default ALL continuous controls to faders in one section and
 *      pads to a pad section — the user can re-label knob↔fader after, but the
 *      COUNT + the exact CC/note per slot are taken from the hardware.
 *   4. commit(name) — freeze into a ControllerProfile (+ a position→binding map
 *      seeded into controllerMapStore so the mapping is correct out of the box).
 *
 * The built profile's `sections` size the SLIDE/DJ surface to the real control
 * count; the seeded bindings mean every on-screen control already drives the
 * right physical one — no separate learn pass needed.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { ControllerProfile, ControllerSection } from './controllerProfiles';
import { setLearnedProfiles } from './controllerProfiles';
import { subscribeToMidi } from './midiBus';
import { useControllerMapStore, type MidiBinding } from './controllerMapStore';

/** A single captured physical control. */
export interface CapturedControl {
  kind: 'cc' | 'note';
  number: number;
  channel: number;
  /** For CC: min/max value seen — lets us tell a continuous sweep from a button. */
  min: number;
  max: number;
  /** How many messages seen (helps order by first-touched). */
  hits: number;
  /** order index (first-seen) so the built layout follows the order you touched. */
  order: number;
}

/** A frozen, learned profile + the position→binding map it implies. */
export interface LearnedProfile {
  profile: ControllerProfile;
  /** position (0-based, section order) → MIDI binding. */
  bindings: Record<number, MidiBinding>;
}

type Phase = 'idle' | 'capturing';

interface LearnedProfilesState {
  /** Persisted learned profiles. */
  profiles: LearnedProfile[];
  /** Live capture phase. Session only. */
  phase: Phase;
  /** Controls captured so far this session (keyed `${kind}:${number}:${ch}`). */
  captured: Record<string, CapturedControl>;

  start: () => void;
  cancel: () => void;
  /** Freeze the current capture into a learned profile. Returns its id, or null
   *  if nothing was captured. */
  commit: (name: string) => string | null;
  removeProfile: (id: string) => void;
}

let unsub: (() => void) | null = null;
let orderCounter = 0;

const key = (kind: 'cc' | 'note', number: number, channel: number) => `${kind}:${number}:${channel}`;

/** Continuous (knob/fader) vs momentary (pad): a CC that has moved across a
 *  span counts as continuous; a CC that only ever hit 0/127 (or a note) is a
 *  pad/button. Threshold keeps a single accidental two-value CC out of faders. */
function isContinuous(c: CapturedControl): boolean {
  if (c.kind === 'note') return false;
  return c.max - c.min > 4; // swept across a real range
}

/** Build a profile's sections from the captured set. One FADERS section for all
 *  continuous controls (8 cols, wrap to rows) + one PADS section for the rest. */
function buildSections(controls: CapturedControl[]): { sections: ControllerSection[]; ordered: CapturedControl[] } {
  const cont = controls.filter(isContinuous).sort((a, b) => a.order - b.order);
  const pads = controls.filter((c) => !isContinuous(c)).sort((a, b) => a.order - b.order);
  const sections: ControllerSection[] = [];
  const cols = 8;
  if (cont.length) {
    sections.push({ id: 'faders', kind: 'fader', label: 'CONTINUOUS', rows: Math.max(1, Math.ceil(cont.length / cols)), cols });
  }
  if (pads.length) {
    sections.push({ id: 'pads', kind: 'pad', label: 'PADS / BUTTONS', rows: Math.max(1, Math.ceil(pads.length / cols)), cols });
  }
  // Position order across the profile = continuous section first (in capture
  // order), then pads — matching how SlidePanel walks sections → positions.
  const ordered = [...cont, ...pads];
  return { sections, ordered };
}

export const useLearnedProfilesStore = create<LearnedProfilesState>()(
  persist(
    (set, get) => ({
      profiles: [],
      phase: 'idle',
      captured: {},

      start: () => {
        if (unsub) unsub();
        orderCounter = 0;
        set({ phase: 'capturing', captured: {} });
        unsub = subscribeToMidi((msg) => {
          if (get().phase !== 'capturing') return;
          const [status, data1, data2] = msg.data;
          if (typeof status !== 'number') return;
          const command = status & 0xf0;
          const channel = status & 0x0f;
          let kind: 'cc' | 'note' | null = null;
          let number = data1 ?? 0;
          let value = data2 ?? 0;
          if (command === 0xb0) kind = 'cc';
          else if (command === 0x90 && (data2 ?? 0) > 0) { kind = 'note'; value = data2 ?? 127; }
          else return; // ignore note-off / pitchbend / aftertouch for layout
          const k = key(kind, number, channel);
          set((s) => {
            const prev = s.captured[k];
            const c: CapturedControl = prev
              ? { ...prev, min: Math.min(prev.min, value), max: Math.max(prev.max, value), hits: prev.hits + 1 }
              : { kind, number, channel, min: value, max: value, hits: 1, order: orderCounter++ };
            return { captured: { ...s.captured, [k]: c } };
          });
        });
      },

      cancel: () => {
        if (unsub) { unsub(); unsub = null; }
        set({ phase: 'idle', captured: {} });
      },

      commit: (name) => {
        const captured = Object.values(get().captured);
        if (unsub) { unsub(); unsub = null; }
        if (captured.length === 0) { set({ phase: 'idle' }); return null; }

        const { sections, ordered } = buildSections(captured);
        const id = `learned-${Date.now()}`;
        const profile: ControllerProfile = {
          id,
          name: name.trim() || `Learned (${captured.length} controls)`,
          vendor: 'Learned',
          category: 'generic',
          match: [], // learned profiles are chosen manually, not name-detected
          sections,
        };
        // Seed position→binding from the captured order so the mapping is exact.
        const bindings: Record<number, MidiBinding> = {};
        ordered.forEach((c, pos) => {
          bindings[pos] = { kind: c.kind, number: c.number, channel: c.channel };
        });

        const learned: LearnedProfile = { profile, bindings };
        set((s) => ({ profiles: [...s.profiles, learned], phase: 'idle', captured: {} }));

        // Register with the profile catalog + seed the controller MAP so every
        // slot already drives the right physical control.
        const all = get().profiles.concat(learned).map((l) => l.profile);
        setLearnedProfiles(all);
        const mapStore = useControllerMapStore.getState();
        mapStore.clearProfile(id);
        for (const [posStr, b] of Object.entries(bindings)) {
          mapStore.bind(id, Number(posStr), b);
        }
        return id;
      },

      removeProfile: (id) => {
        set((s) => ({ profiles: s.profiles.filter((l) => l.profile.id !== id) }));
        setLearnedProfiles(get().profiles.map((l) => l.profile));
        useControllerMapStore.getState().clearProfile(id);
      },
    }),
    {
      name: 'stabledaw-learned-profiles-v1',
      partialize: (s) => ({ profiles: s.profiles }),
      // On rehydrate, push learned profiles into the catalog + re-seed their maps.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        setLearnedProfiles(state.profiles.map((l) => l.profile));
        const mapStore = useControllerMapStore.getState();
        for (const l of state.profiles) {
          for (const [posStr, b] of Object.entries(l.bindings)) {
            mapStore.bind(l.profile.id, Number(posStr), b);
          }
        }
      },
    },
  ),
);
