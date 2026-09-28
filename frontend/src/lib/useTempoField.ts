/**
 * useTempoField: the typing behaviour of a number field that holds a tempo.
 *
 * A controlled field that clamps on every keystroke cannot be typed into: the
 * first digit of "140" is 1, which the 20 BPM floor raises to 20 and writes back
 * into the field, so the next digits land after it (20 -> 204 -> 300). This hook
 * types the way the app's other tempo fields do (the piano roll's BPM field,
 * PianoRoll.tsx bpmDraft/commitBpmDraft, and EDIT's EditorBpmField):
 *   - typing arrives as an InputEvent (it carries `inputType`) and stays a draft
 *     in the field, so nothing moves while a tempo is half typed: the "25" of a
 *     typed 250 never sets 25 BPM on its way;
 *   - Enter, or the field losing focus, clamps the draft to 20-300 and commits it;
 *   - a step from the arrow keys, the spin buttons or the wheel (a plain input
 *     event, no `inputType`) applies at once, clamped;
 *   - Escape drops the draft and shows the tempo in force;
 *   - an empty or unreadable draft commits nothing (or calls `onEmpty` when the
 *     field gives an empty value a meaning, like Chimera's "auto").
 * The tempo in force shows to the hundredth, so a MIDI file's exact 96.99995
 * reads 97 and a typed 97.3 reads 97.3.
 */
import { useState } from 'react';
import type React from 'react';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN, clampTempoBpm } from './tempoMap';

export interface TempoFieldOptions {
  /** Called on Enter or blur when the field was emptied. Without it an empty field keeps the tempo in force. */
  onEmpty?: () => void;
}

export interface TempoFieldProps {
  value: string;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}

/** True for a tempo the app holds: finite and inside TEMPO_BPM_MIN..TEMPO_BPM_MAX. */
export const isTempoInRange = (n: number): boolean => Number.isFinite(n) && n >= TEMPO_BPM_MIN && n <= TEMPO_BPM_MAX;

/**
 * What a typed tempo draft commits on Enter or blur: the clamped tempo, 'empty'
 * for a blank field, or null for text that is no positive number (the field
 * then shows the tempo in force again).
 */
export const tempoDraftCommit = (draft: string): number | 'empty' | null => {
  if (draft.trim() === '') return 'empty';
  const n = parseFloat(draft);
  return Number.isFinite(n) && n > 0 ? clampTempoBpm(n) : null;
};

/** True for the input event of typing (an InputEvent, which names its `inputType`); false for a step. */
export const isTypedInput = (e: { nativeEvent: Event }): boolean => 'inputType' in e.nativeEvent;

/** The tempo in force as the field shows it: to the hundredth, or blank. */
export const tempoFieldText = (value: number | ''): string => (value === '' ? '' : String(Math.round(value * 100) / 100));

/**
 * The props for a tempo `<input type="number">`: spread them onto the field.
 * `value` is the tempo in force; `commit` receives a tempo inside 20-300.
 */
export function useTempoField(value: number | '', commit: (bpm: number) => void, opts: TempoFieldOptions = {}): TempoFieldProps {
  const [draft, setDraft] = useState<string | null>(null);
  const land = (text: string) => {
    const out = tempoDraftCommit(text);
    if (typeof out === 'number') commit(out);
    else if (out === 'empty') opts.onEmpty?.();
  };
  const finish = () => {
    if (draft === null) return;
    setDraft(null);
    land(draft);
  };
  return {
    value: draft ?? tempoFieldText(value),
    onChange: (e) => {
      if (isTypedInput(e)) {
        setDraft(e.target.value);
        return;
      }
      setDraft(null);
      land(e.target.value);
    },
    onBlur: finish,
    onKeyDown: (e) => {
      if (e.key === 'Enter') finish();
      else if (e.key === 'Escape') setDraft(null);
    },
  };
}
