/**
 * The EDIT toolbar's BPM field, beside the snap picker: the arrangement's start
 * tempo (its tempo map's beat-0 event, editorStore setBpm), 20-300 BPM with its
 * fraction to the hundredth. Tempo changes after it live in the Meter and tempo
 * panel (EditTimeMapPanel).
 *
 * A typed tempo applies on Enter or when the field loses focus, so the "1" of
 * a typed 140 is never clamped to 20 first; Escape drops what was typed. A
 * step from the arrow keys or the spin buttons applies at once.
 */
import React, { useState } from 'react';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../../lib/tempoMap';

export interface EditorBpmFieldProps {
  bpm: number;
  onChange: (bpm: number) => void;
}

export function EditorBpmField({ bpm, onChange }: EditorBpmFieldProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const apply = (text: string) => {
    const v = Number.parseFloat(text);
    if (Number.isFinite(v) && v > 0) onChange(v);
  };
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    apply(draft);
  };
  return (
    <>
      <label htmlFor="editor-bpm" className="text-xs font-bold uppercase text-zinc-400">BPM</label>
      <input
        id="editor-bpm"
        name="editor-bpm"
        type="number"
        min={TEMPO_BPM_MIN}
        max={TEMPO_BPM_MAX}
        step="any"
        // A detected or typed tempo keeps its fraction to the hundredth (97.3, 24.25).
        value={draft ?? Math.round(bpm * 100) / 100}
        onChange={(e) => {
          // Typing arrives as an InputEvent and waits for Enter or blur.
          if ('inputType' in e.nativeEvent) {
            setDraft(e.target.value);
            return;
          }
          setDraft(null);
          apply(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit();
          else if (e.key === 'Escape') setDraft(null);
        }}
        className="w-14 bg-transparent border-none outline-none text-xs font-bold text-zinc-100 tabular-nums"
        title={`Start tempo, ${TEMPO_BPM_MIN}-${TEMPO_BPM_MAX}: the first tempo of the arrangement's tempo map. Tempo changes after it are in Meter · Tempo`}
      />
    </>
  );
}
