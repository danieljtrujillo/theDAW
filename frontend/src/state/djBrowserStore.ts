import { create } from 'zustand';
import { persist } from 'zustand/middleware';

/* DJ TrackBrowser column layout — persisted order, widths, and sort so the
 * library grid the user arranges survives reloads. The 'title' column flexes
 * to fill slack; the others are fixed pixel widths the user can drag-resize
 * (or double-click to auto-fit) and drag-reorder. 'index' is the row number. */

export type DjColKey = 'index' | 'title' | 'bpm' | 'key' | 'len';
export type SortDir = 'asc' | 'desc';

export const DJ_COL_DEFAULT_ORDER: DjColKey[] = ['index', 'title', 'bpm', 'key', 'len'];
export const DJ_COL_DEFAULT_WIDTHS: Record<DjColKey, number> = {
  index: 26,
  title: 0, // flexes (1fr); width is unused for the flexible column
  bpm: 42,
  key: 38,
  len: 42,
};
export const DJ_COL_MIN_WIDTH: Record<DjColKey, number> = {
  index: 22,
  title: 60,
  bpm: 30,
  key: 28,
  len: 34,
};

interface DjBrowserState {
  order: DjColKey[];
  widths: Record<DjColKey, number>;
  sortKey: DjColKey;
  sortDir: SortDir;
  setWidth: (key: DjColKey, width: number) => void;
  resetWidth: (key: DjColKey) => void;
  moveColumn: (key: DjColKey, beforeKey: DjColKey | null) => void;
  toggleSort: (key: DjColKey) => void;
  resetLayout: () => void;
}

export const useDjBrowser = create<DjBrowserState>()(
  persist(
    (set) => ({
      order: [...DJ_COL_DEFAULT_ORDER],
      widths: { ...DJ_COL_DEFAULT_WIDTHS },
      sortKey: 'index',
      sortDir: 'asc',
      setWidth: (key, width) =>
        set((s) => ({
          widths: { ...s.widths, [key]: Math.max(DJ_COL_MIN_WIDTH[key], Math.round(width)) },
        })),
      resetWidth: (key) =>
        set((s) => ({ widths: { ...s.widths, [key]: DJ_COL_DEFAULT_WIDTHS[key] } })),
      moveColumn: (key, beforeKey) =>
        set((s) => {
          const order = s.order.filter((k) => k !== key);
          if (beforeKey == null) order.push(key);
          else {
            const i = order.indexOf(beforeKey);
            order.splice(i < 0 ? order.length : i, 0, key);
          }
          return { order };
        }),
      toggleSort: (key) =>
        set((s) =>
          s.sortKey === key
            ? { sortDir: s.sortDir === 'asc' ? 'desc' : 'asc' }
            : { sortKey: key, sortDir: key === 'title' || key === 'key' ? 'asc' : 'desc' },
        ),
      resetLayout: () =>
        set({
          order: [...DJ_COL_DEFAULT_ORDER],
          widths: { ...DJ_COL_DEFAULT_WIDTHS },
          sortKey: 'index',
          sortDir: 'asc',
        }),
    }),
    { name: 'thedaw.dj.browser.v1' },
  ),
);
