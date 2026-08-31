/**
 * PERFORM's right rail — UI state (persisted) plus the bridge that lets the
 * rail push effect-parameter edits into DawSessionGrid's LIVE per-track
 * chains without owning them.
 *
 * The grid registers a push function on mount (it holds the lazily-built
 * ChainHandles); the rail calls pushPerformDeviceParams with the same
 * track/device indexing the CC routes use (`perform-{track}-{device}` entry
 * ids), so a rail edit and a hardware knob land on the same live instance —
 * and chain instances keep sticky param state, so single-key pushes merge.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type PerformRailTab = 'routes' | 'params';

interface PerformRailState {
  open: boolean;
  width: number;
  tab: PerformRailTab;
  /** Session-only: the device whose params the PARAMS tab edits. */
  selTrack: number | null;
  selDevice: number | null;
  setOpen: (open: boolean) => void;
  setWidth: (w: number) => void;
  setTab: (tab: PerformRailTab) => void;
  select: (trackIndex: number | null, deviceIndex: number | null) => void;
}

export const usePerformRailStore = create<PerformRailState>()(
  persist(
    (set) => ({
      // DEFAULT CLOSED (user mandate) — the rail opens only when asked.
      open: false,
      width: 264,
      tab: 'routes',
      selTrack: null,
      selDevice: null,
      setOpen: (open) => set({ open }),
      setWidth: (w) => set({ width: Math.round(Math.max(208, Math.min(440, w))) }),
      setTab: (tab) => set({ tab }),
      select: (selTrack, selDevice) => set({ selTrack, selDevice, tab: 'params' }),
    }),
    {
      name: 'thedaw-perform-rail-v1',
      // v2 forces the closed default once onto profiles that briefly stored
      // the v1 open-by-default state; explicit choices persist from then on.
      version: 2,
      migrate: (persisted) => {
        const p = (persisted ?? {}) as Partial<PerformRailState>;
        return { ...p, open: false } as PerformRailState;
      },
      partialize: (s) => ({ open: s.open, width: s.width, tab: s.tab }),
    },
  ),
);

/* ── live-chain bridge ───────────────────────────────────────────────────── */

type ChainPush = (trackIndex: number, deviceIndex: number, params: Record<string, number>) => void;

let chainPush: ChainPush | null = null;

/** DawSessionGrid registers its live-chain writer here (null on unmount). */
export const registerPerformChainPush = (fn: ChainPush | null): void => {
  chainPush = fn;
};

/** Push param values onto a track device's RUNNING chain instance (no-op when
 *  the grid is not mounted). */
export const pushPerformDeviceParams: ChainPush = (trackIndex, deviceIndex, params) => {
  chainPush?.(trackIndex, deviceIndex, params);
};
