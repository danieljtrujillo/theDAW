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
 *
 * A song also writes the roll's tempo map: each section's own tempo and a
 * ritardando over each section's last bar (lib/virtuosoTransform songTempoMap),
 * on top of the map the roll had before the song. RESET puts that map back.
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
  sanitizeSectionTempo,
  type VirtuosoAmounts,
  type StyleName,
  type SectionSpec,
  type Role,
  type GrooveTemplate,
} from '../lib/virtuosoTransform';
import { buildGrooveFromMidiBytes } from '../lib/grooveExtract';
import type { Meter } from '../lib/colony';
import { meterEquals, normalizeMeterMap, sanitizeMeter, takeBarsFrom, type MeterSegment } from '../lib/meterMap';
import { sanitizeRollTempoMap, startTempoOf } from '../lib/rollTempo';
import type { TempoEvent } from '../lib/tempoMap';

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v));
const cloneNotes = (notes: PianoNote[]): PianoNote[] => notes.map((n) => ({ ...n }));
const sameMeterMap = (a: readonly MeterSegment[], b: readonly MeterSegment[]): boolean =>
  a.length === b.length && a.every((s, i) => s.bar === b[i].bar && meterEquals(s.meter, b[i].meter));

/** A stored section with its meter kept only when it is a valid time signature, and its tempo only inside 20..300. */
const sectionFromStorage = (s: SectionSpec): SectionSpec => {
  const meter = sanitizeMeter(s.meter);
  const bpm = sanitizeSectionTempo(s.bpm);
  const { meter: _dropMeter, bpm: _dropBpm, ...rest } = s;
  return { ...rest, ...(meter ? { meter } : {}), ...(bpm !== undefined ? { bpm } : {}) };
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
  /** Give a section its own tempo (20..300), or null to follow the roll's tempo map. */
  setSectionTempo: (index: number, bpm: number | null) => void;
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

// The tempo half. `_tempoBase` is the roll's tempo map from before the song
// (sections without a tempo follow it) and `_tempoMap` the map the last build
// wrote (the store's own array, so identity says whether the roll still shows
// it). When the roll no longer shows `_tempoMap` (the header's BPM, a point
// drawn, moved or removed in the TEMPO lane), a rebuild carries those edits
// into the base (adoptTempo), so the next song follows them and a ritardando is
// never laid over the previous song's ritardando.
let _tempoBase: readonly TempoEvent[] | null = null;
let _tempoMap: readonly TempoEvent[] | null = null;

const kindOf = (e: TempoEvent): string => (e.fermata ? 'f' : 't');
const samePoint = (a: TempoEvent, b: TempoEvent): boolean =>
  a.beat === b.beat
  && kindOf(a) === kindOf(b)
  && a.bpm === b.bpm
  && (a.curve ?? 'step') === (b.curve ?? 'step')
  && a.fermata?.beats === b.fermata?.beats
  && a.fermata?.stretch === b.fermata?.stretch;

/**
 * `base` with the edits made to the song's map since the last build: a point
 * the roll holds and the song did not write is added (replacing the base's
 * point of its kind on that beat), and a point the song wrote that the roll no
 * longer holds is taken out of the base too. The base's points a section tempo
 * covered in the song stay in it, so they come back when that tempo is removed.
 */
const adoptTempo = (roll: readonly TempoEvent[], song: readonly TempoEvent[], base: readonly TempoEvent[]): TempoEvent[] => {
  const added = roll.filter((e) => !song.some((s) => samePoint(s, e)));
  const removed = song.filter((s) => !roll.some((e) => samePoint(s, e)));
  const touched = (e: TempoEvent): boolean => [...added, ...removed].some((x) => x.beat === e.beat && kindOf(x) === kindOf(e));
  const next = [...base.filter((e) => !touched(e)), ...added];
  return sanitizeRollTempoMap(next, startTempoOf(next) ?? startTempoOf(base) ?? 120);
};

const clearSongMaps = (): void => {
  _songBase = null;
  _songMap = null;
  _songOwned = [];
  _tempoBase = null;
  _tempoMap = null;
};

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

/**
 * The roll part the source phrase was taken from. Every render, song build and
 * reset writes into that part: when another part is being edited, the roll
 * turns back to it first, so a slider moved after switching parts never pours
 * one part's phrase into another. Null (a source from before a reload) writes
 * into the part being edited.
 */
let _sourcePart: string | null = null;

/** Remember the part being edited as the source's. */
const takeSourcePart = (): void => {
  _sourcePart = usePianoRollStore.getState().activeTrackId;
};

/** Turn the roll to the source's part, when it still has it and is on another. */
const toSourcePart = (): void => {
  const roll = usePianoRollStore.getState();
  if (_sourcePart && _sourcePart !== roll.activeTrackId && roll.tracks.some((t) => t.id === _sourcePart)) roll.setActiveTrack(_sourcePart);
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
        toSourcePart();
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
        toSourcePart();
        const roll = usePianoRollStore.getState();
        if (!_songBase || !_songMap) _songBase = roll.meterMap;
        else if (!sameMeterMap(roll.meterMap, _songMap)) _songBase = takeBarsFrom(roll.meterMap, _songBase, _songOwned);
        if (!_tempoBase || !_tempoMap) _tempoBase = roll.tempoMap;
        else if (roll.tempoMap !== _tempoMap) _tempoBase = adoptTempo(roll.tempoMap, _tempoMap, _tempoBase);
        const baseBpm = startTempoOf(_tempoBase) ?? roll.bpm;
        const song = buildSongNotes(s.source, {
          key: s.key,
          mode: s.mode,
          style: s.style,
          amounts: s.amounts,
          bpm: baseBpm,
          sections: s.sections ?? undefined,
          groove: s.groove ?? undefined,
          meterMap: _songBase,
          pickupSteps: roll.pickupSteps,
          tempoMap: _tempoBase,
        });
        _songMap = normalizeMeterMap(song.meterMap);
        _songOwned = sectionMeterBars(s.sections);
        // The song's tempo map goes in with its notes, so one undo takes back both.
        // The song owns the meters and tempos of its sections' bars, which it
        // builds over the roll's own maps, so they apply while other parts hold
        // notes too; the bends it leaves out stay (pianoRollStore importNotes).
        roll.importNotes(
          song.notes,
          startTempoOf(song.tempoMap) ?? baseBpm,
          { meterMap: song.meterMap },
          keepBends ? roll.bends : undefined,
          song.tempoMap,
          { document: true },
        );
        _tempoMap = usePianoRollStore.getState().tempoMap;
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
          clearSongMaps();
          takeSourcePart();
          set({ source: cloneNotes(usePianoRollStore.getState().notes), songMode: false });
          renderPhrase(get().source, get().amounts, get().key, get().mode);
        },

        setAmount: (k, v) => {
          const s = get();
          if (!s.source) takeSourcePart();
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
          if (s.source) toSourcePart();
          const roll = usePianoRollStore.getState();
          if (s.source) roll.replaceAll(cloneNotes(s.source));
          // The source phrase goes back under the maps it had before the song.
          if (_songBase && _songMap && sameMeterMap(roll.meterMap, _songMap)) roll.setMeterMap(_songBase);
          if (_tempoBase && _tempoMap && usePianoRollStore.getState().tempoMap === _tempoMap) roll.setTempoMap(_tempoBase);
          clearSongMaps();
        },

        buildSong: () => {
          const s = get();
          if (!s.source) takeSourcePart();
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

        setSectionTempo: (index, bpm) => {
          const secs = get().effectiveSections().map((x) => ({ ...x }));
          if (!secs[index]) return;
          const clean = sanitizeSectionTempo(bpm);
          if (clean !== undefined) secs[index].bpm = clean;
          else delete secs[index].bpm;
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
