/**
 * Virtuoso composer state — a non-destructive morph layer over the piano roll.
 *
 * It keeps a SOURCE phrase separate from what's shown and re-renders the roll
 * from that source so the four transform sliders can be dialed live without
 * compounding. Two modes:
 *  - phrase mode (default): sliders morph the captured phrase in place.
 *  - song mode (after Build Song): the source phrase is grown into a full
 *    multi-section arrangement; the SAME sliders now reshape the whole song
 *    (rebuilt, debounced) instead of collapsing it back to the short phrase.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { usePianoRollStore, type PianoNote } from './pianoRollStore';
import {
  renderVirtuoso,
  buildSong as buildSongNotes,
  STYLES,
  ZERO_AMOUNTS,
  defaultSections,
  type VirtuosoAmounts,
  type StyleName,
  type SectionSpec,
  type Role,
  type GrooveTemplate,
} from '../lib/virtuosoTransform';
import { buildGrooveFromMidiBytes } from '../lib/grooveExtract';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const cloneNotes = (notes: PianoNote[]): PianoNote[] => notes.map((n) => ({ ...n }));

interface VirtuosoState {
  source: PianoNote[] | null;
  amounts: VirtuosoAmounts;
  key: string;
  mode: string;
  style: StyleName;
  /** True once a full song has been built; sliders then reshape the whole song. */
  songMode: boolean;
  /** User-configured section layout, or null to follow the style's default. */
  sections: SectionSpec[] | null;
  /** Reference groove pocket driving the humanizer, or null for synthesized feel. */
  groove: GrooveTemplate | null;
  captureSource: () => void;
  setAmount: (k: keyof VirtuosoAmounts, v: number) => void;
  nudge: (k: keyof VirtuosoAmounts, delta: number) => void;
  setKey: (key: string) => void;
  setMode: (mode: string) => void;
  setStyle: (style: StyleName) => void;
  resetToSource: () => void;
  buildSong: () => void;
  /** The effective section list (explicit, else the style default). */
  effectiveSections: () => SectionSpec[];
  setSectionRole: (index: number, role: Role) => void;
  setSectionBars: (index: number, bars: number) => void;
  addSection: () => void;
  removeSection: (index: number) => void;
  moveSection: (index: number, dir: -1 | 1) => void;
  resetSections: () => void;
  /** Extract a groove pocket from reference MIDI bytes; returns false if empty. */
  setGrooveFromBytes: (buf: ArrayBuffer, name: string) => boolean;
  clearGroove: () => void;
}

// Rebuilding a full song on every slider tick is heavy; coalesce drags.
let _rebuildTimer: number | null = null;

export const useVirtuosoStore = create<VirtuosoState>()(
  persist(
    (set, get) => {
      const renderPhrase = (
        source: PianoNote[] | null,
        amounts: VirtuosoAmounts,
        key: string,
        mode: string,
      ): void => {
        if (!source || !source.length) return;
        usePianoRollStore
          .getState()
          .replaceAll(renderVirtuoso(source, amounts, { key, mode }, 0, get().groove ?? undefined));
      };

      const rebuildSongNow = (): void => {
        const s = get();
        if (!s.source || !s.source.length) return;
        const bpm = usePianoRollStore.getState().bpm;
        usePianoRollStore
          .getState()
          .importNotes(
            buildSongNotes(s.source, {
              key: s.key,
              mode: s.mode,
              style: s.style,
              amounts: s.amounts,
              bpm,
              sections: s.sections ?? undefined,
              groove: s.groove ?? undefined,
            }),
            bpm,
          );
      };

      const scheduleSongRebuild = (): void => {
        if (_rebuildTimer !== null) window.clearTimeout(_rebuildTimer);
        _rebuildTimer = window.setTimeout(() => {
          _rebuildTimer = null;
          rebuildSongNow();
        }, 140);
      };

      /** Re-render after a change, honoring the current mode. */
      const refresh = (): void => {
        const s = get();
        if (s.songMode) scheduleSongRebuild();
        else renderPhrase(s.source, s.amounts, s.key, s.mode);
      };

      return {
        source: null,
        amounts: { ...ZERO_AMOUNTS },
        key: 'C',
        mode: 'major',
        style: 'romantic',
        songMode: false,
        sections: null,
        groove: null,

        captureSource: () => {
          set({ source: cloneNotes(usePianoRollStore.getState().notes), songMode: false });
          renderPhrase(get().source, get().amounts, get().key, get().mode);
        },

        setAmount: (k, v) => {
          const s = get();
          const source = s.source ?? cloneNotes(usePianoRollStore.getState().notes);
          set({ source, amounts: { ...s.amounts, [k]: clamp01(v) } });
          refresh();
        },

        nudge: (k, delta) => get().setAmount(k, get().amounts[k] + delta),

        setKey: (key) => {
          set({ key });
          refresh();
        },

        setMode: (mode) => {
          set({ mode });
          refresh();
        },

        setStyle: (style) => {
          // Adopt the style's scale and structure so its idiom reads correctly;
          // a custom section layout is dropped in favour of the new style's.
          set({ style, mode: STYLES[style]?.mode ?? get().mode, sections: null });
          refresh();
        },

        resetToSource: () => {
          set({ amounts: { ...ZERO_AMOUNTS }, songMode: false });
          const s = get();
          if (s.source) usePianoRollStore.getState().replaceAll(cloneNotes(s.source));
        },

        buildSong: () => {
          const s = get();
          const source = s.source ?? cloneNotes(usePianoRollStore.getState().notes);
          if (!source.length) return;
          set({ source, songMode: true });
          rebuildSongNow();
        },

        effectiveSections: () => get().sections ?? defaultSections(get().style),

        setSectionRole: (index, role) => {
          const secs = get().effectiveSections().map((x) => ({ ...x }));
          if (!secs[index]) return;
          secs[index].role = role;
          set({ sections: secs });
          if (get().songMode) scheduleSongRebuild();
        },

        setSectionBars: (index, bars) => {
          const secs = get().effectiveSections().map((x) => ({ ...x }));
          if (!secs[index]) return;
          secs[index].bars = Math.max(1, Math.min(16, Math.round(bars)));
          set({ sections: secs });
          if (get().songMode) scheduleSongRebuild();
        },

        addSection: () => {
          const secs = get().effectiveSections().map((x) => ({ ...x }));
          secs.push({ role: 'theme', bars: 4 });
          set({ sections: secs });
          if (get().songMode) scheduleSongRebuild();
        },

        removeSection: (index) => {
          const secs = get().effectiveSections().filter((_, i) => i !== index);
          set({ sections: secs.length ? secs : null });
          if (get().songMode) scheduleSongRebuild();
        },

        moveSection: (index, dir) => {
          const secs = get().effectiveSections().map((x) => ({ ...x }));
          const j = index + dir;
          if (j < 0 || j >= secs.length) return;
          [secs[index], secs[j]] = [secs[j], secs[index]];
          set({ sections: secs });
          if (get().songMode) scheduleSongRebuild();
        },

        resetSections: () => {
          set({ sections: null });
          if (get().songMode) scheduleSongRebuild();
        },

        setGrooveFromBytes: (buf, name) => {
          const groove = buildGrooveFromMidiBytes(buf, name);
          if (!groove) return false;
          set({ groove });
          refresh();
          return true;
        },

        clearGroove: () => {
          set({ groove: null });
          refresh();
        },
      };
    },
    {
      name: 'thedaw-virtuoso-v1',
      partialize: (s) => ({
        amounts: s.amounts,
        key: s.key,
        mode: s.mode,
        style: s.style,
        sections: s.sections,
        groove: s.groove,
      }),
    },
  ),
);
