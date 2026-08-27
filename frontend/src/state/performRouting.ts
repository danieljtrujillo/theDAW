/**
 * Perform-tab control routing.
 *
 * The Perform (session) grid is driven entirely by the assignments held here —
 * nothing is hardcoded. Two kinds of assignment:
 *
 *  1. Transport + scene launch. A learned MIDI control (an encoder push, a
 *     button, a key) is bound to a Perform FUNCTION: Scene Select (an encoder
 *     whose turn moves a highlighted scene), Launch (fires the highlighted
 *     scene), Stop, Scene +, Scene -. Additionally each scene ROW can be bound to
 *     its own control for direct launch. Pads deliberately do NOT launch scenes —
 *     they stay free for MIDI / the DAW-Control pad engine.
 *
 *  2. Modulation. Any of the Sway's six expressive dimensions (strike / sway /
 *     pulse / glide / press / sculpt, i.e. the hand-tracking sensors) can be
 *     routed to a Perform-mix function on a track: live Volume or Mute. These
 *     read the normalized 0..1 dim values off swayBus, so the same hand motion
 *     that the Sway learns in the SWAY panel modulates the Perform mix here.
 *
 * Bindings persist across reloads. Learn is armed from the panel and captured by
 * the grid's single MIDI listener, so only one handler touches each device.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { SWAY_DIMS, seedSwayBinding, type SwayDim } from './swayBus';

export type PerformFn = 'select' | 'launch' | 'stop' | 'next' | 'prev';

/** The assignable transport functions, in display order. `wantsCc` is a hint for
 *  the panel (Scene Select expects a continuous encoder), not an enforced type —
 *  learn captures whatever control the user moves. */
export const PERFORM_FUNCTIONS: { id: PerformFn; label: string; hint: string; wantsCc: boolean }[] = [
  { id: 'select', label: 'Scene Select', hint: 'Encoder: turn to move the highlighted scene', wantsCc: true },
  { id: 'launch', label: 'Launch', hint: 'Push / click: launch the highlighted scene', wantsCc: false },
  { id: 'stop', label: 'Stop', hint: 'Stop all clips', wantsCc: false },
  { id: 'next', label: 'Scene +', hint: 'Launch the next scene', wantsCc: false },
  { id: 'prev', label: 'Scene -', hint: 'Launch the previous scene', wantsCc: false },
];

/** A learned MIDI control. channel < 0 means omni (match any channel). */
export interface PerformCtrl {
  isNote: boolean;
  channel: number;
  number: number;
}

export type ModTarget = 'volume' | 'mute';

export interface TrackMod {
  id: string;
  dim: SwayDim;
  trackIndex: number;
  target: ModTarget;
}

/**
 * A DIRECT CC -> Perform-mix route, created automatically from an imported
 * project's own MIDI-learn mappings (a set built FOR the Sway carries them in
 * the .als/.swayproj/.tasmo) or assigned on the SwayCommand deck. Unlike
 * TrackMod this does not go through the dim layer at all: the project says
 * "CC 21 ch1 moves track 3's volume", so that exact control moves that exact
 * fader, faithful to the source DAW with zero setup. These belong to the
 * PROJECT, not the machine: never persisted globally (localStorage), but they
 * DO travel in the .tasmo's perform_routing snapshot so a saved set's knob /
 * XY / fx routes come back on open.
 */
export interface CcMod {
  id: string;
  /** 0-indexed channel; -1 = omni. */
  channel: number;
  number: number;
  isNote: boolean;
  trackIndex: number;
  target: 'volume' | 'mute' | 'fx';
  /** fx only: index into the track's flattened (non-instrument, non-rack)
   *  device list — the SAME indexing the Perform grid uses for its chain entry
   *  ids (`perform-<mix>-<i>`), so the route reaches the running effect. */
  deviceIndex?: number;
  /** fx only: the rack-effect parameter this CC drives, plus its range. */
  paramKey?: string;
  min?: number;
  max?: number;
  /** Note-driven routes only. Default (false) is MOMENTARY: note-on pushes
   *  `max`, note-off pushes `min` — a punch-in effect that releases with the
   *  pad. `latch: true` toggles between max and min on each note-on instead
   *  (note-off ignored), for effects that should stay on while both hands are
   *  busy. Ignored for CC routes, which are continuous. */
  latch?: boolean;
  /** Display label, e.g. "03 Bass · Volume". */
  label: string;
}

/** What the panel has armed for learn; captured by the grid's MIDI listener. */
export type LearnArm =
  | { kind: 'fn'; fn: PerformFn }
  | { kind: 'scene'; scene: number }
  | null;

/** The persistable slice of the routing (what travels in a .tasmo file). */
export interface PerformRoutingSnapshot {
  transport: Partial<Record<PerformFn, PerformCtrl>>;
  sceneCtrls: Record<number, PerformCtrl>;
  trackMods: TrackMod[];
  /** Project-scoped direct routes (knobs / XY / fx params). Absent in .tasmo
   *  files written before ccMods persisted. */
  ccMods?: CcMod[];
}

export const performCtrlLabel = (c: PerformCtrl): string =>
  `${c.channel < 0 ? 'omni' : `ch${c.channel + 1}`} ${c.isNote ? 'N' : 'CC'}${c.number}`;

const modId = (dim: SwayDim, trackIndex: number, target: ModTarget): string =>
  `${dim}:${trackIndex}:${target}`;

interface PerformRoutingState {
  /** Transport-function -> control. */
  transport: Partial<Record<PerformFn, PerformCtrl>>;
  /** Scene index -> control for direct launch. */
  sceneCtrls: Record<number, PerformCtrl>;
  /** Sway dim -> Perform-mix modulation targets. */
  trackMods: TrackMod[];
  /** Project-derived direct CC routes (replaced per project). */
  ccMods: CcMod[];
  /** True when the current ccMods came from a project's saved snapshot — the
   *  Session view's auto-router must not wipe them with its (empty) derived
   *  set right after a .tasmo load. */
  ccModsHydrated: boolean;
  /** Armed learn (session only). */
  learn: LearnArm;

  arm: (a: LearnArm) => void;
  setCcMods: (mods: CcMod[]) => void;
  removeCcMod: (id: string) => void;
  bindFn: (fn: PerformFn, ctrl: PerformCtrl) => void;
  bindScene: (scene: number, ctrl: PerformCtrl) => void;
  clearFn: (fn: PerformFn) => void;
  clearScene: (scene: number) => void;
  addMod: (dim: SwayDim, trackIndex: number, target: ModTarget) => void;
  removeMod: (id: string) => void;
  /** Replace transport + per-scene + modulation with a saved snapshot (on load). */
  hydrate: (snapshot: PerformRoutingSnapshot) => void;
}

export const usePerformRoutingStore = create<PerformRoutingState>()(
  persist(
    (set) => ({
      transport: {},
      sceneCtrls: {},
      trackMods: [],
      ccMods: [],
      ccModsHydrated: false,
      learn: null,
      arm: (a) => set({ learn: a }),
      setCcMods: (ccMods) => set({ ccMods, ccModsHydrated: false }),
      removeCcMod: (id) => set((s) => ({ ccMods: s.ccMods.filter((m) => m.id !== id) })),
      bindFn: (fn, ctrl) => set((s) => ({ transport: { ...s.transport, [fn]: ctrl }, learn: null })),
      bindScene: (scene, ctrl) => set((s) => ({ sceneCtrls: { ...s.sceneCtrls, [scene]: ctrl }, learn: null })),
      clearFn: (fn) =>
        set((s) => {
          const transport = { ...s.transport };
          delete transport[fn];
          return { transport };
        }),
      clearScene: (scene) =>
        set((s) => {
          const sceneCtrls = { ...s.sceneCtrls };
          delete sceneCtrls[scene];
          return { sceneCtrls };
        }),
      addMod: (dim, trackIndex, target) =>
        set((s) => {
          const id = modId(dim, trackIndex, target);
          if (s.trackMods.some((m) => m.id === id)) return s;
          return { trackMods: [...s.trackMods, { id, dim, trackIndex, target }] };
        }),
      removeMod: (id) => set((s) => ({ trackMods: s.trackMods.filter((m) => m.id !== id) })),
      hydrate: (snapshot) => {
        const ccMods = Array.isArray(snapshot.ccMods) ? snapshot.ccMods : [];
        set({
          transport: snapshot.transport ?? {},
          sceneCtrls: snapshot.sceneCtrls ?? {},
          trackMods: Array.isArray(snapshot.trackMods) ? snapshot.trackMods : [],
          ccMods,
          ccModsHydrated: ccMods.length > 0,
          learn: null,
        });
      },
    }),
    {
      name: 'thedaw-perform-routing-v1',
      partialize: (s) => ({ transport: s.transport, sceneCtrls: s.sceneCtrls, trackMods: s.trackMods }),
    },
  ),
);

/** Snapshot the persistable routing slice (for saving into a .tasmo). Returns
 *  null when nothing is assigned, so an empty routing adds no file bloat. */
export function capturePerformRouting(): PerformRoutingSnapshot | null {
  const s = usePerformRoutingStore.getState();
  const has =
    Object.keys(s.transport).length > 0 ||
    Object.keys(s.sceneCtrls).length > 0 ||
    s.trackMods.length > 0 ||
    s.ccMods.length > 0;
  if (!has) return null;
  return {
    transport: s.transport,
    sceneCtrls: s.sceneCtrls,
    trackMods: s.trackMods,
    ccMods: s.ccMods,
  };
}

/** True when an incoming MIDI message matches a stored control. */
export function ctrlMatches(c: PerformCtrl, isNote: boolean, channel: number, number: number): boolean {
  if (c.isNote !== isNote) return false;
  if (c.number !== number) return false;
  if (c.channel >= 0 && c.channel !== channel) return false;
  return true;
}

/**
 * Build the automatic Perform routing for a freshly loaded project.
 *
 * A set designed for the Sway ships its MIDI-learn mappings inside the project
 * file. Loading it should make the hardware work immediately — not present a
 * blank routing panel. Two things happen here:
 *
 *  1. Every resolvable MIXER mapping becomes a direct CcMod on the Perform mix
 *     (that exact channel+CC moves that exact track's live volume).
 *  2. Any mapping whose names mention one of the Sway's six dimensions seeds
 *     that dim's CC binding on swayBus — so the dim meters, the XR mirror and
 *     dim-based modulation all light up with the project's own layout instead
 *     of waiting for a learn (or for auto-bind order to happen to match).
 *
 * Non-mixer mappings (device/FX params) are NOT dropped — they are handled by
 * the editor-side auto-attach (swayImportResolve) which owns FX faithfully.
 */
export function autoRoutePerformFromProject(project: {
  controller_mappings?: {
    is_note: boolean;
    channel: number;
    number: number;
    target_kind: string;
    track_name: string;
    track_index: number;
    device_name: string;
    param_name: string;
  }[] | null;
  tracks: { name: string }[];
}): { ccMods: CcMod[]; seededDims: number } {
  const mods: CcMod[] = [];
  const seen = new Set<string>();
  let seededDims = 0;
  const maps = project.controller_mappings ?? [];
  for (const m of maps) {
    // Dim seeding by name: "Strike", "SWAY Pulse Macro", etc.
    const haystack = `${m.param_name} ${m.device_name} ${m.track_name}`.toLowerCase();
    if (!m.is_note) {
      if (trySeedSwayDim(haystack, m.channel, m.number)) seededDims += 1;
    }
    // What counts as "this CC is the track's loudness" in real Sway sets:
    // a true mixer mapping, a Utility gain, OR a device/rack param literally
    // named Volume/Level/Gain — the Ableton Sway templates put per-part volume
    // on instrument-rack macros named "Volume", not on the track fader, and a
    // mixer-only filter routed NOTHING from them.
    const pn = m.param_name.toLowerCase();
    const isMixer = m.target_kind === 'mixer' || m.device_name.toLowerCase().replace(/[^a-z]/g, '') === 'utility';
    const isDeviceVolume = m.target_kind === 'device' && /(^|[^a-z])(volume|level|gain)([^a-z]|$)/.test(pn);
    if ((!isMixer && !isDeviceVolume) || m.is_note || m.track_index < 0 || m.track_index >= project.tracks.length) continue;
    if (pn.includes('pan')) continue; // perform mix has no pan lane
    const id = `cc:${m.channel}:${m.number}:${m.track_index}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const trackName = project.tracks[m.track_index]?.name ?? m.track_name ?? `Track ${m.track_index + 1}`;
    mods.push({
      id,
      channel: m.channel,
      number: m.number,
      isNote: false,
      trackIndex: m.track_index,
      target: 'volume',
      label: `${String(m.track_index + 1).padStart(2, '0')} ${trackName} · Vol`,
    });
  }
  return { ccMods: mods, seededDims };
}

function trySeedSwayDim(haystack: string, channel: number, cc: number): boolean {
  for (const { id } of SWAY_DIMS) {
    if (haystack.includes(id)) {
      return seedSwayBinding(id, channel, cc);
    }
  }
  return false;
}
