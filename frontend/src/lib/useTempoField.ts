/**
 * useTempoField: the typing behaviour of a number field that holds a tempo.
 *
 * A controlled field that clamps on every keystroke cannot be typed into: the
 * first digit of "140" is 1, which the 20 BPM floor raises to 20 and writes back
 * into the field, so the next digits land after it (20 -> 204 -> 300). This hook
 * keeps what the user types as a draft instead:
 *   - a draft that is already a tempo the app holds (20-300) is committed at
 *     once, so the music follows the typing and a spin-button or arrow step
 *     (always in range) still lands immediately;
 *   - a draft outside the range ("1", "12", "400") stays in the field and is
 *     clamped and committed on Enter or when the field loses focus;
 *   - Escape drops the draft and shows the tempo in force;
 *   - an empty or unreadable draft commits nothing (or calls `onEmpty` when
 *     the field gives an empty value a meaning, like Chimera's "auto").
 *
 * The piano roll's own tempo field (PianoRoll.tsx, bpmDraft/commitBpmDraft)
 * keeps a draft the same way.
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

/**
 * The props for a tempo `<input type="number">`: spread them onto the field.
 * `value` is the tempo in force; `commit` receives a tempo inside 20-300.
 */
export function useTempoField(value: number | '', commit: (bpm: number) => void, opts: TempoFieldOptions = {}): TempoFieldProps {
  const [draft, setDraft] = useState<string | null>(null);
  const finish = () => {
    if (draft === null) return;
    const out = tempoDraftCommit(draft);
    if (typeof out === 'number') commit(out);
    else if (out === 'empty') opts.onEmpty?.();
    setDraft(null);
  };
  return {
    value: draft ?? (value === '' ? '' : String(value)),
    onChange: (e) => {
      const raw = e.target.value;
      setDraft(raw);
      const n = parseFloat(raw);
      if (isTempoInRange(n)) commit(n);
    },
    onBlur: finish,
    onKeyDown: (e) => {
      if (e.key === 'Enter') finish();
      else if (e.key === 'Escape') setDraft(null);
    },
  };
}
