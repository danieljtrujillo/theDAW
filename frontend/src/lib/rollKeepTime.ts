/**
 * rollKeepTime — the MIDI tab's KEEP TIME choice, and the roll's BPM set by
 * hand through it.
 *
 * KEEP TIME decides what a new BPM does to the notes: on, every note keeps its
 * time in seconds (the store's setTempoKeepingTime, lib/tempoConform), so a
 * transcription stays on the audio it came from; off, every note keeps its
 * place in the bar (setBpm). It starts on for a roll whose parts came from a
 * song's audio (RollTrack `fromAudio`) and off for one written on the grid. A
 * press sets it for the roll document it is pressed in (`rollDocId`), and a new
 * document starts from its own parts again.
 *
 * The choice lives here, outside the strip that shows it, so it stays while
 * the MIDI tab is closed and opened again, and every control that sets the BPM
 * by hand reads the same one: the BPM field and a controller knob mapped to
 * BPM (MAP).
 */
import { create } from 'zustand';
import { usePianoRollStore } from '../state/pianoRollStore';
import { rollHasAudioParts } from './meterFace';

/** A KEEP TIME press: the roll document it was made in, and on or off. */
export interface KeepTimeChoice {
  doc: string;
  on: boolean;
}

interface RollKeepTimeState {
  choice: KeepTimeChoice | null;
  /** Set KEEP TIME for roll document `doc`. */
  choose: (doc: string, on: boolean) => void;
}

export const useRollKeepTime = create<RollKeepTimeState>()((set) => ({
  choice: null,
  choose: (doc, on) => set({ choice: { doc, on } }),
}));

/** KEEP TIME for roll document `doc`: the press made in it, else on when its parts came from audio. */
export const keepTimeOn = (choice: KeepTimeChoice | null, doc: string, hasAudioParts: boolean): boolean =>
  choice?.doc === doc ? choice.on : hasAudioParts;

/** KEEP TIME for the roll as it is now. */
export function rollKeepsTime(): boolean {
  const s = usePianoRollStore.getState();
  return keepTimeOn(useRollKeepTime.getState().choice, s.rollDocId, rollHasAudioParts(s));
}

/**
 * A BPM typed, stepped or turned on a knob: through KEEP TIME (see the
 * header), every part keeping its seconds when it is on. Returns how many
 * notes kept their time (0 with KEEP TIME off, or for a BPM that is not a
 * positive number).
 */
export function setRollBpmByHand(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  const roll = usePianoRollStore.getState();
  if (!rollKeepsTime()) {
    roll.setBpm(bpm);
    return 0;
  }
  return roll.setTempoKeepingTime({ bpm }, { parts: 'all' });
}
