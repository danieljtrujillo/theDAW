/**
 * vstParamStore — what each hosted plugin says about its own parameters.
 *
 * The native host lists EVERY parameter the plugin's controller declares, in the controller's own
 * order, with the flags that say what each is for and the plugin's own display string for its
 * value ("-6.0 dB", "Hall 2", "On") — the way JUCE's VST3 host exposes them. This store is where
 * the app keeps that list, so the FX window can show a parameter panel for any plugin without its
 * native window (a remote page, a phone, a plugin with no editor at all).
 *
 * Its own store, not a field on `vstLiveStore`'s entry row: a value or a display string changes
 * many times a second while a knob turns, and every status badge in the app subscribes to that row.
 *
 * Values are NORMALIZED (0..1), as on the wire. `text` is what to show; never format a value here.
 */
import { create } from 'zustand';

export interface VstParamView {
  /** Position in the plugin's own parameter list: the index the wire protocol and `p<index>` use. */
  index: number;
  name: string;
  /** Units, as the plugin states them (often empty: most plugins put the unit into `text`). */
  label: string;
  defaultValue: number;
  value: number;
  /** 0 = continuous; n = n+1 discrete positions. */
  steps: number;
  automatable: boolean;
  discrete: boolean;
  boolean: boolean;
  /** The plugin's own book-keeping: never shown, never automated. */
  hidden: boolean;
  /** A meter or a display value: shown, never written. */
  readOnly: boolean;
  /** The plugin's own bypass switch. */
  bypass: boolean;
  /** Selects one of the plugin's programs. */
  programChange: boolean;
  /** The plugin's words for `value`; empty when it has none. */
  text: string;
}

/** One `params` list entry as the host sends it (snake_case flags, all optional on an older host). */
export interface VstParamWire {
  index: number;
  name: string;
  label: string;
  default: number;
  value: number;
  steps: number;
  automatable: boolean;
  discrete: boolean;
  boolean: boolean;
  hidden?: boolean;
  read_only?: boolean;
  bypass?: boolean;
  program_change?: boolean;
  text?: string;
}

export const paramFromWire = (w: VstParamWire): VstParamView => ({
  index: w.index,
  name: w.name,
  label: w.label,
  defaultValue: w.default,
  value: w.value,
  steps: w.steps,
  automatable: w.automatable,
  discrete: w.discrete,
  boolean: w.boolean,
  hidden: w.hidden === true,
  readOnly: w.read_only === true,
  bypass: w.bypass === true,
  programChange: w.program_change === true,
  text: w.text ?? '',
});

/** The `ChainEntry.params` key a plugin parameter is stored under. */
export const vstParamKey = (index: number): string => `p${index}`;

/** The key a value's display string is cached under. */
export const vstTextKey = (value: number): string => value.toFixed(6);

/**
 * A stepped parameter the panel shows as a LIST of the plugin's own names (a program, a mode, a
 * filter type) instead of a slider with positions nobody can read. Two positions is a switch.
 */
export const isVstChoiceParam = (p: VstParamView): boolean =>
  !p.boolean && p.steps >= 2 && p.steps <= 127 && (p.programChange || p.discrete);

/** The normalized value of position `i` of a stepped parameter. */
export const vstStepValue = (p: VstParamView, i: number): number => (p.steps > 0 ? i / p.steps : 0);

/** What a parameter panel lists: everything the plugin wants a user to see. */
export const visibleVstParams = (list: readonly VstParamView[]): VstParamView[] => list.filter((p) => !p.hidden);

interface VstParamState {
  /** Keyed by chain entry id. Absent = the plugin has not been asked yet. */
  lists: Record<string, VstParamView[]>;
  /** Every display string the plugin has given, by entry, parameter index and value key: the
   *  names of a program list or a mode switch are asked for once and read from here. */
  texts: Record<string, Record<number, Record<string, string>>>;
  setList: (entryId: string, list: VstParamWire[]) => void;
  /** One value moved (the plugin's editor, automation read back, a program change). */
  setValue: (entryId: string, index: number, value: number, text?: string) => void;
  /** The plugin's words for a value the panel is showing but has not been confirmed yet. */
  setText: (entryId: string, index: number, value: number, text: string) => void;
  clear: (entryId: string) => void;
}

const patchParam = (
  lists: Record<string, VstParamView[]>,
  entryId: string,
  index: number,
  patch: (p: VstParamView) => VstParamView,
): Record<string, VstParamView[]> => {
  const list = lists[entryId];
  if (!list) return lists;
  const at = list.findIndex((p) => p.index === index);
  if (at < 0) return lists;
  const next = patch(list[at]);
  if (next === list[at]) return lists;
  const copy = list.slice();
  copy[at] = next;
  return { ...lists, [entryId]: copy };
};

export const useVstParamStore = create<VstParamState>()((set) => ({
  lists: {},
  texts: {},
  setList: (entryId, list) => set((s) => ({ lists: { ...s.lists, [entryId]: list.map(paramFromWire) } })),
  setValue: (entryId, index, value, text) =>
    set((s) => ({
      lists: patchParam(s.lists, entryId, index, (p) =>
        p.value === value && (text === undefined || p.text === text) ? p : { ...p, value, text: text ?? p.text },
      ),
    })),
  setText: (entryId, index, value, text) =>
    set((s) => ({
      // Kept only for a LIST parameter (a few named positions). A continuous slider asks for the
      // text of every value it passes, and remembering all of those would grow without bound.
      texts: s.lists[entryId]?.some((p) => p.index === index && isVstChoiceParam(p))
        ? {
            ...s.texts,
            [entryId]: { ...s.texts[entryId], [index]: { ...s.texts[entryId]?.[index], [vstTextKey(value)]: text } },
          }
        : s.texts,
      // Only while the parameter still holds the value the text was asked for: a slow answer must
      // not label a newer value with an older string.
      lists: patchParam(s.lists, entryId, index, (p) => (Math.abs(p.value - value) > 1e-6 || p.text === text ? p : { ...p, text })),
    })),
  clear: (entryId) =>
    set((s) => {
      if (!(entryId in s.lists) && !(entryId in s.texts)) return s;
      const lists = { ...s.lists };
      const texts = { ...s.texts };
      delete lists[entryId];
      delete texts[entryId];
      return { lists, texts };
    }),
}));
