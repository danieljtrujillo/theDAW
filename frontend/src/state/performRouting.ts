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
import type { SwayDim } from './swayBus';

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
  /** Armed learn (session only). */
  learn: LearnArm;

  arm: (a: LearnArm) => void;
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
      learn: null,
      arm: (a) => set({ learn: a }),
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
      hydrate: (snapshot) =>
        set({
          transport: snapshot.transport ?? {},
          sceneCtrls: snapshot.sceneCtrls ?? {},
          trackMods: Array.isArray(snapshot.trackMods) ? snapshot.trackMods : [],
          learn: null,
        }),
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
    s.trackMods.length > 0;
  if (!has) return null;
  return { transport: s.transport, sceneCtrls: s.sceneCtrls, trackMods: s.trackMods };
}

/** True when an incoming MIDI message matches a stored control. */
export function ctrlMatches(c: PerformCtrl, isNote: boolean, channel: number, number: number): boolean {
  if (c.isNote !== isNote) return false;
  if (c.number !== number) return false;
  if (c.channel >= 0 && c.channel !== channel) return false;
  return true;
}
