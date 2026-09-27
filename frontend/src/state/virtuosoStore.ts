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
import type { Meter } from '../lib/colony';
import { meterEquals, normalizeMeterMap, sanitizeMeter, takeBarsFrom, type MeterSegment } from '../lib/meterMap';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const cloneNotes = (notes: PianoNote[]): PianoNote[] => notes.map((n) => ({ ...n }));
const sameMeterMap = (a: readonly MeterSegment[], b: readonly MeterSegment[]): boolean =>
  a.length === b.length && a.every((s, i) => s.bar === b[i].bar && meterEquals(s.meter, b[i].meter));

/** A stored section with its meter kept only when it is a valid time signature. */
const sectionFromStorage = (s: SectionSpec): SectionSpec => {
  const meter = sanitizeMeter(s.meter);
  const { meter: _drop, ...rest } = s;
  return meter ? { ...rest, meter } : rest;
};

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
  /** Give a section its own time signature, or null to follow the roll's meter map. */
  setSectionMeter: (index: number, meter: Meter | null) => void;
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

// Build Song writes its own meter map into the roll. `_songBase` is the roll's
// map from before the song, which sections without a meter follow; `_songMap`
// is the map the last build wrote, and `_songOwned` the bars a section meter
// wrote in it. A rebuild adopts the roll's map as the new base only when the
// roll no longer shows `_songMap`, so a section meter that was removed does not
// linger through the previous song's map. The adopted map keeps the old base on
// the owned bars: the roll shows the section's meter there, not the user's.
let _songBase: MeterSegment[] | null = null;
let _songMap: MeterSegment[] | null = null;
let _songOwned: number[] = [];

/** The bars (0-based) whose meter a section wrote: explicit sections laid end to end, as buildSong lays them. */
const sectionMeterBars = (sections: SectionSpec[] | null): number[] => {
  const out: number[] = [];
  let bar = 0;
  for (const sec of sections ?? []) {
    const n = Math.max(1, Math.round(sec.bars));
    if (sanitizeMeter(sec.meter)) for (let k = 0; k < n; k += 1) out.push(bar + k);
    bar += n;
  }
  return out;
};

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
        const roll = usePianoRollStore.getState();
        roll.replaceAll(
          renderVirtuoso(
            source,
            amounts,
            { key, mode, meterMap: roll.meterMap, pickupSteps: roll.pickupSteps },
            0,
            get().groove ?? undefined,
          ),
        );
      };

      /**
       * Build the song from the source into the roll. A new song clears the
       * roll's bend points; a rebuild of the song the roll already holds
       * (`keepBends`) keeps the curves drawn over it.
       */
      const rebuildSongNow = (keepBends = false): void => {
        const s = get();
        if (!s.source || !s.source.length) return;
        const roll = usePianoRollStore.getState();
        if (!_songBase || !_songMap) _songBase = roll.meterMap;
        else if (!sameMeterMap(roll.meterMap, _songMap)) _songBase = takeBarsFrom(roll.meterMap, _songBase, _songOwned);
        const song = buildSongNotes(s.source, {
          key: s.key,
          mode: s.mode,
          style: s.style,
          amounts: s.amounts,
          bpm: roll.bpm,
          sections: s.sections ?? undefined,
          groove: s.groove ?? undefined,
          meterMap: _songBase,
          pickupSteps: roll.pickupSteps,
        });
        _songMap = normalizeMeterMap(song.meterMap);
        _songOwned = sectionMeterBars(s.sections);
        // The song is built at the roll's tempo, so the roll keeps its tempo map as it is.
        roll.importNotes(song.notes, roll.bpm, { meterMap: song.meterMap }, keepBends ? roll.bends : undefined, roll.tempoMap);
      };

      const scheduleSongRebuild = (): void => {
        if (_rebuildTimer !== null) window.clearTimeout(_rebuildTimer);
        _rebuildTimer = window.setTimeout(() => {
          _rebuildTimer = null;
          rebuildSongNow(true);
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
          _songBase = null;
          _songMap = null;
          _songOwned = [];
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
          const roll = usePianoRollStore.getState();
          if (s.source) roll.replaceAll(cloneNotes(s.source));
          // The source phrase goes back under the map it had before the song.
          if (_songBase && _songMap && sameMeterMap(roll.meterMap, _songMap)) roll.setMeterMap(_songBase);
          _songBase = null;
          _songMap = null;
          _songOwned = [];
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

        setSectionMeter: (index, meter) => {
          const secs = get().effectiveSections().map((x) => ({ ...x }));
          if (!secs[index]) return;
          const clean = sanitizeMeter(meter);
          if (clean) secs[index].meter = clean;
          else delete secs[index].meter;
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
      // State saved before sync, accent and section meters existed loads with
      // those amounts at 0 and its sections without a meter.
      merge: (persisted, current) => {
        const p = (persisted ?? {}) as Partial<VirtuosoState>;
        return {
          ...current,
          ...p,
          amounts: { ...ZERO_AMOUNTS, ...p.amounts },
          sections: Array.isArray(p.sections) ? p.sections.map(sectionFromStorage) : (p.sections ?? current.sections),
        };
      },
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
