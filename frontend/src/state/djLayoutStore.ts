import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* DJ Design Mode layout (user-editable, persisted). The DJ tab's regions are
 * laid out as a few CSS-grid "rows" whose tracks are fr weights keyed by panel
 * id, plus two fixed band heights. Design Mode lets the user drag the splitters
 * to RESIZE and drag whole panels to REORDER within a row; everything persists
 * (localStorage) so it sticks, and `exportJSON()` dumps the config so the
 * arrangement can be baked in as the shipped default. Defaults below reproduce
 * the current hand-tuned layout exactly, so nothing moves until the user drags. */

export type RowKey = 'outer' | 'deckRow' | 'bottomRow' | 'rightCol' | 'mixerChan';
export type PanelId =
  | 'sampler' | 'center' | 'browser'
  | 'deckA' | 'mixer' | 'deckB'
  | 'fxA' | 'next' | 'fxB'
  | 'sourceTree' | 'library'
  // mixer internals (control groups) — editable within the mixer panel
  | 'pchA' | 'eqA' | 'chA' | 'chB' | 'eqB' | 'pchB';

export interface LayoutRowDef {
  /** Panel ids in display order. */
  order: PanelId[];
  /** fr weight per panel id (relative track size). */
  fr: Record<string, number>;
}

interface DjLayoutState {
  designMode: boolean;
  heroH: number;   // waveform band height (px)
  bottomH: number; // FX·NEXT·FX rack row height (px)
  rows: Record<RowKey, LayoutRowDef>;
  setDesignMode: (v: boolean) => void;
  setHeroH: (px: number) => void;
  setBottomH: (px: number) => void;
  /** Transfer `frac` (of the row's total fr) from rightId to leftId — i.e. a
   *  splitter drag where positive frac grows the left panel. */
  resize: (row: RowKey, leftId: PanelId, rightId: PanelId, frac: number) => void;
  /** Move the panel at `from` to index `to` within a row. */
  reorder: (row: RowKey, from: number, to: number) => void;
  reset: () => void;
  exportJSON: () => string;
}

const cloneRows = (r: Record<RowKey, LayoutRowDef>): Record<RowKey, LayoutRowDef> => ({
  outer: { order: [...r.outer.order], fr: { ...r.outer.fr } },
  deckRow: { order: [...r.deckRow.order], fr: { ...r.deckRow.fr } },
  bottomRow: { order: [...r.bottomRow.order], fr: { ...r.bottomRow.fr } },
  rightCol: { order: [...r.rightCol.order], fr: { ...r.rightCol.fr } },
  mixerChan: { order: [...r.mixerChan.order], fr: { ...r.mixerChan.fr } },
});

const DEFAULT_HERO_H = 138;
const DEFAULT_BOTTOM_H = 190;
const DEFAULT_ROWS: Record<RowKey, LayoutRowDef> = {
  // 186px / 1fr / 320px  →  proportional fr weights
  outer: { order: ['sampler', 'center', 'browser'], fr: { sampler: 1.86, center: 13.9, browser: 3.2 } },
  // 1fr / 320px / 1fr (at ~1390px center)
  deckRow: { order: ['deckA', 'mixer', 'deckB'], fr: { deckA: 5.3, mixer: 3.2, deckB: 5.3 } },
  // 1fr / 1.5fr / 1fr
  bottomRow: { order: ['fxA', 'next', 'fxB'], fr: { fxA: 1, next: 1.5, fxB: 1 } },
  // SourceTree flex-2 / Library flex-3
  rightCol: { order: ['sourceTree', 'library'], fr: { sourceTree: 2, library: 3 } },
  // mixer control groups: PCH-A · EQ-A · GAIN+VOL A · GAIN+VOL B · EQ-B · PCH-B
  mixerChan: { order: ['pchA', 'eqA', 'chA', 'chB', 'eqB', 'pchB'], fr: { pchA: 1, eqA: 1.5, chA: 2.4, chB: 2.4, eqB: 1.5, pchB: 1 } },
};

const MIN_FR = 0.45;
const clampPx = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export const useDjLayout = create<DjLayoutState>()(
  persist(
    (set, get) => ({
      designMode: false,
      heroH: DEFAULT_HERO_H,
      bottomH: DEFAULT_BOTTOM_H,
      rows: cloneRows(DEFAULT_ROWS),
      setDesignMode: (v) => set({ designMode: v }),
      setHeroH: (px) => set({ heroH: clampPx(Math.round(px), 64, 420) }),
      setBottomH: (px) => set({ bottomH: clampPx(Math.round(px), 90, 520) }),
      resize: (rowKey, leftId, rightId, frac) => set((s) => {
        const row = s.rows[rowKey];
        const total = row.order.reduce((a, id) => a + (row.fr[id] ?? 1), 0);
        const d = frac * total;
        const l = (row.fr[leftId] ?? 1) + d;
        const r = (row.fr[rightId] ?? 1) - d;
        if (l < MIN_FR || r < MIN_FR) return s;
        return { rows: { ...s.rows, [rowKey]: { ...row, fr: { ...row.fr, [leftId]: l, [rightId]: r } } } };
      }),
      reorder: (rowKey, from, to) => set((s) => {
        const row = s.rows[rowKey];
        if (from === to || to < 0 || from < 0 || to >= row.order.length || from >= row.order.length) return s;
        const order = [...row.order];
        const [moved] = order.splice(from, 1);
        order.splice(to, 0, moved);
        return { rows: { ...s.rows, [rowKey]: { ...row, order } } };
      }),
      reset: () => set({ heroH: DEFAULT_HERO_H, bottomH: DEFAULT_BOTTOM_H, rows: cloneRows(DEFAULT_ROWS) }),
      exportJSON: () => JSON.stringify({ heroH: get().heroH, bottomH: get().bottomH, rows: get().rows }, null, 2),
    }),
    {
      name: 'thedaw.dj.layout.v1',
      // designMode is session-only; never persist it.
      partialize: (s) => ({ heroH: s.heroH, bottomH: s.bottomH, rows: s.rows }),
      // Deep-merge so a persisted layout that predates a newly-added row still
      // gets the new row from the defaults (otherwise the shallow merge drops it).
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<DjLayoutState>;
        return { ...current, ...p, rows: { ...current.rows, ...(p.rows ?? {}) } };
      },
    },
  ),
);
