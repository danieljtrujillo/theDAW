/**
 * tuningStore — the project's tuning: A4's pitch and the temperament
 * (lib/tuning). A project saves it (`.tasmo` `tuning`) and a project load puts
 * it back; a new session starts at A = 440 in equal temperament.
 *
 * Every voice follows it from the moment it changes: the procedural voices
 * read lib/tuning keyHz, soundfontEngine sends the MIDI Tuning Standard
 * messages to every live synth and puts them at the start of every render,
 * and MIDI exports write the same messages (tuningForExport).
 */
import { create } from 'zustand';
import {
  DEFAULT_TUNING,
  cleanTuning,
  isStandardTuning,
  parseScala,
  setCurrentTuning,
  tuningMessages,
  withSysexAtStart,
  type ProjectTuning,
  type TemperamentId,
} from '../lib/tuning';

interface TuningState {
  tuning: ProjectTuning;
  /** The last Scala import's failure, in words to show. */
  scalaError: string | null;
  setReference: (hz: number) => void;
  setTemperament: (id: TemperamentId) => void;
  setRoot: (pitchClass: number) => void;
  /** Read a .scl file's text and switch to it; false (and scalaError) when it is not a scale. */
  importScala: (text: string, fileName: string) => boolean;
  /** Replace the whole tuning (a project load). */
  setTuning: (t: unknown) => void;
}

const apply = (tuning: ProjectTuning): ProjectTuning => {
  setCurrentTuning(tuning);
  return tuning;
};

export const useTuningStore = create<TuningState>((set, get) => ({
  tuning: apply({ ...DEFAULT_TUNING }),
  scalaError: null,
  setReference: (hz) => set({ tuning: apply(cleanTuning({ ...get().tuning, referenceHz: hz })) }),
  setTemperament: (id) => set({ tuning: apply(cleanTuning({ ...get().tuning, temperament: id })) }),
  setRoot: (pitchClass) => set({ tuning: apply(cleanTuning({ ...get().tuning, root: pitchClass })) }),
  importScala: (text, fileName) => {
    try {
      const scala = parseScala(text, fileName);
      set({ tuning: apply(cleanTuning({ ...get().tuning, temperament: 'scala', scala })), scalaError: null });
      return true;
    } catch (e) {
      set({ scalaError: `${fileName}: ${e instanceof Error ? e.message : String(e)}` });
      return false;
    }
  },
  setTuning: (t) => set({ tuning: apply(cleanTuning(t)), scalaError: null }),
}));

/** The project's tuning now. */
export const getProjectTuning = (): ProjectTuning => useTuningStore.getState().tuning;

/** A MIDI file with the project's tuning messages at its start (unchanged at A = 440 equal temperament). */
export function tuningForExport(smf: Uint8Array<ArrayBuffer>, tuning: ProjectTuning = getProjectTuning()): Uint8Array<ArrayBuffer> {
  return isStandardTuning(tuning) ? smf : withSysexAtStart(smf, tuningMessages(tuning));
}

/** The tuning as a `.tasmo` file carries it, or null at A = 440 in equal temperament. */
export function tuningToTasmo(tuning: ProjectTuning = getProjectTuning()): Record<string, unknown> | null {
  if (isStandardTuning(tuning)) return null;
  return {
    reference_hz: tuning.referenceHz,
    temperament: tuning.temperament,
    root: tuning.root,
    ...(tuning.scala ? { scala: { name: tuning.scala.name, description: tuning.scala.description, cents: tuning.scala.cents } } : {}),
  };
}

/** Put a loaded project's tuning in place: its own, or standard tuning when the file has none. */
export function applyTasmoTuning(raw: unknown): void {
  useTuningStore.getState().setTuning(raw ?? DEFAULT_TUNING);
}
