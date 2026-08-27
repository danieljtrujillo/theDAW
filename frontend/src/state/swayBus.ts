/**
 * Sway control bus.
 *
 * Normalizes the Audima Sway's six expressive dimensions (Strike / Sway / Pulse /
 * Glide / Press / Sculpt) from raw MIDI CCs into 0..1 signals other subsystems can
 * route. The Sway is class-compliant MIDI, so its CCs already arrive on the global
 * midiBus; this bus adds the named-dimension layer plus learn. The CC numbers are
 * firmware-configurable and there is no MIDI 1.0 way to query a device's layout,
 * so every dimension binds by LEARN rather than a hardcoded CC (the same reason
 * controllerProfiles never hardcodes CCs).
 *
 * The six dims are target-agnostic: the same 0..1 signals can drive VFX (shader
 * uniforms, the akvj cloud, VJ FX), 3D audio placement (the Spatializer), and
 * MUSIC and VOICE targets (MAKE / Magenta generation and the vocal / SoulX path)
 * once those consumers subscribe. swayControlSource publishes them onto the XR
 * control bus so a headset can see and bind them too.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { subscribeToMidi } from './midiBus';

export type SwayDim = 'strike' | 'sway' | 'pulse' | 'glide' | 'press' | 'sculpt';

export const SWAY_DIMS: { id: SwayDim; label: string }[] = [
  { id: 'strike', label: 'Strike' },
  { id: 'sway', label: 'Sway' },
  { id: 'pulse', label: 'Pulse' },
  { id: 'glide', label: 'Glide' },
  { id: 'press', label: 'Press' },
  { id: 'sculpt', label: 'Sculpt' },
];

/** A CC binding for one dimension. channel < 0 = omni. `source` records where
 *  it came from, which sets its authority: a user-learned binding (no source)
 *  beats a project seed beats the factory default. */
export interface SwayBinding {
  channel: number;
  cc: number;
  source?: 'factory' | 'project';
}

interface SwayState {
  /** Persisted dim -> CC bindings (learned). */
  bindings: Partial<Record<SwayDim, SwayBinding>>;
  /** Live normalized values 0..1 (session only). */
  values: Record<SwayDim, number>;
  /** The dimension currently armed for learn, or null. Session only. */
  learningDim: SwayDim | null;

  startLearn: (dim: SwayDim) => void;
  cancelLearn: () => void;
  clearBinding: (dim: SwayDim) => void;
}

const ZERO_VALUES: Record<SwayDim, number> = {
  strike: 0,
  sway: 0,
  pulse: 0,
  glide: 0,
  press: 0,
  sculpt: 0,
};

/**
 * The Sway's FACTORY layout, from SwayCommand's recovered map
 * (SwayCommand/src/renderer/midi/swaymap.js — Base Project V2 + the official
 * Ableton/Cubase remote scripts): gestures pulse=35 press=36 sway=37, hand
 * tracking xy = 50/38, X-trigger/Y-mod = 73/74, knobs 20..27.
 *
 * theDAW's three dims without a dedicated gesture CC map onto the tracking
 * surfaces: STRIKE is the X-trigger hit region, GLIDE is lateral hand travel
 * (xy.x), SCULPT is vertical (xy.y). Channel is omni — pads/CCs have been
 * observed on ch1 or ch16 depending on firmware/project, and a Sway is the
 * only thing sending these CCs in practice.
 *
 * These are DEFAULTS, not law: a learned binding, a project seed, or auto-bind
 * has already filled the slot and is never overwritten (see migrate below —
 * factory values only ever fill EMPTY slots). A device with remapped firmware
 * CCs still binds by moving its controls.
 */
export const FACTORY_BINDINGS: Record<SwayDim, SwayBinding> = {
  strike: { channel: -1, cc: 73, source: 'factory' },
  sway: { channel: -1, cc: 37, source: 'factory' },
  pulse: { channel: -1, cc: 35, source: 'factory' },
  glide: { channel: -1, cc: 50, source: 'factory' },
  press: { channel: -1, cc: 36, source: 'factory' },
  sculpt: { channel: -1, cc: 38, source: 'factory' },
};

export const useSwayStore = create<SwayState>()(
  persist(
    (set) => ({
      bindings: { ...FACTORY_BINDINGS },
      values: { ...ZERO_VALUES },
      learningDim: null,
      startLearn: (dim) => set({ learningDim: dim }),
      cancelLearn: () => set({ learningDim: null }),
      clearBinding: (dim) =>
        set((s) => {
          const next = { ...s.bindings };
          delete next[dim];
          return { bindings: next };
        }),
    }),
    {
      name: 'thedaw-sway-bindings-v1',
      partialize: (s) => ({ bindings: s.bindings }),
      // v2: factory-layout defaults arrived. Fill only the slots the persisted
      // state left EMPTY — anything the user learned stays exactly as learned.
      version: 2,
      migrate: (persisted, from) => {
        const p = (persisted ?? {}) as { bindings?: Partial<Record<SwayDim, SwayBinding>> };
        if (from < 2) {
          return { ...p, bindings: { ...FACTORY_BINDINGS, ...(p.bindings ?? {}) } };
        }
        return p;
      },
    },
  ),
);

/** Raw 0..1 value subscribers (high-rate, no React) for the control sources. */
type ValueListener = (dim: SwayDim, value: number) => void;
const valueListeners = new Set<ValueListener>();

export function subscribeSwayValue(cb: ValueListener): () => void {
  valueListeners.add(cb);
  return () => {
    valueListeners.delete(cb);
  };
}

/** Current normalized value for a dimension (0..1). */
export function getSwayValue(dim: SwayDim): number {
  return useSwayStore.getState().values[dim] ?? 0;
}

/**
 * Auto-binding.
 *
 * The Sway's CC numbers are user-configurable on the device, so nothing can be
 * hardcoded — that is why this bus was learn-only. But the per-dimension Learn
 * UI lived in the SWAY tab's rail, and that rail is gone (the tab is the
 * SwayCommand cockpit now), which would leave a plugged-in Sway permanently
 * unbound and PERFORM permanently dead.
 *
 * So: while any dimension is still unbound, the first time a NEW (channel, cc)
 * pair moves it claims the next unbound dimension, in SWAY_DIMS order. Moving
 * the six controls once binds all six, with no UI at all. A CC that is already
 * bound never re-binds, and once all six are bound auto-binding stops
 * completely — so ordinary playing can never silently re-map the surface.
 *
 * Explicit learn still wins when armed, and clearBinding re-opens a slot.
 */
function nextUnboundDim(bindings: Partial<Record<SwayDim, SwayBinding>>): SwayDim | null {
  for (const { id } of SWAY_DIMS) if (!bindings[id]) return id;
  return null;
}

/**
 * Seed one dim's binding from an imported project's own mapping (channel may be
 * -1 = omni, matched accordingly). Only fills an EMPTY slot — a binding the
 * user learned, or one already seeded, is never overwritten by a file load.
 * Returns true when the seed took.
 */
export function seedSwayBinding(dim: SwayDim, channel: number, cc: number): boolean {
  const st = useSwayStore.getState();
  const cur = st.bindings[dim];
  // A project seed replaces the factory default (the project is more specific)
  // but never a binding the user learned or auto-bound by moving the control.
  if (cur && cur.source !== 'factory') return false;
  useSwayStore.setState((s) => ({
    bindings: { ...s.bindings, [dim]: { channel, cc, source: 'project' } },
  }));
  return true;
}

function isCcBound(bindings: Partial<Record<SwayDim, SwayBinding>>, channel: number, cc: number): boolean {
  return SWAY_DIMS.some(({ id }) => {
    const b = bindings[id];
    return !!b && (b.channel < 0 || b.channel === channel) && b.cc === cc;
  });
}

function ingestCc(channel: number, cc: number, value01: number): void {
  const st = useSwayStore.getState();
  // Learn: bind the armed dimension to the first CC it sees, then disarm.
  if (st.learningDim) {
    const dim = st.learningDim;
    useSwayStore.setState((s) => ({
      bindings: { ...s.bindings, [dim]: { channel, cc } },
      learningDim: null,
    }));
    return;
  }

  // Auto-bind an unclaimed CC to the next unbound dimension.
  if (!isCcBound(st.bindings, channel, cc)) {
    const dim = nextUnboundDim(st.bindings);
    if (dim) {
      useSwayStore.setState((s) => ({ bindings: { ...s.bindings, [dim]: { channel, cc } } }));
      // Fall through so this very first move also produces a value, rather than
      // being swallowed as a binding-only event.
    }
  }
  // Route: update every dimension bound to this (channel, cc) and notify the raw
  // value subscribers (the XR mirror, future matrix consumers).
  // Re-read: an auto-bind above wrote through setState, so the snapshot taken at
  // the top of this function no longer has the binding we just created and the
  // first movement would otherwise be dropped.
  const cur = useSwayStore.getState();
  let changed = false;
  const nextValues = { ...cur.values };
  for (const { id } of SWAY_DIMS) {
    const b = cur.bindings[id];
    if (b && (b.channel < 0 || b.channel === channel) && b.cc === cc) { // channel<0 = omni (project-seeded)
      nextValues[id] = value01;
      changed = true;
      for (const cb of valueListeners) {
        try {
          cb(id, value01);
        } catch {
          /* one faulty subscriber never breaks the bus */
        }
      }
    }
  }
  if (changed) useSwayStore.setState({ values: nextValues });
}

let unsub: (() => void) | null = null;

/** Start listening to the global midiBus for Sway CCs. Idempotent. The caller
 *  gates this behind the master MIDI toggle (App registers it in the midiEnabled
 *  effect, matching djControlSource). Returns a stop function. */
export function startSwayBus(): () => void {
  if (unsub) return () => {};
  unsub = subscribeToMidi((msg) => {
    const [status, data1, data2] = msg.data;
    if (typeof status !== 'number') return;
    if ((status & 0xf0) !== 0xb0) return; // control-change only
    const channel = status & 0x0f;
    const cc = data1 ?? 0;
    const value01 = Math.max(0, Math.min(1, (data2 ?? 0) / 127));
    ingestCc(channel, cc, value01);
  });
  return stopSwayBus;
}

export function stopSwayBus(): void {
  if (unsub) {
    unsub();
    unsub = null;
  }
}
