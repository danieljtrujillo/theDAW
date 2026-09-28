/**
 * EDIT's track templates: a list of the templates and the key that adds the
 * chosen one to the arrangement (state/editorTools). Today the list holds the
 * "Symphony orchestra" in its two seatings (lib/symphonyTemplate). The result
 * goes to the LOG through the tool, and a refusal is shown under the key.
 */
import React, { useState } from 'react';
import { LayoutTemplate } from 'lucide-react';
import { createSymphonyTemplate, type ToolResult } from '../../state/editorTools';
import { SEATINGS, type Seating } from '../../lib/symphonyTemplate';

export interface TrackTemplate {
  id: string;
  label: string;
  /** One line for the tooltip. */
  description: string;
  apply: () => ToolResult;
}

export const TRACK_TEMPLATES: readonly TrackTemplate[] = SEATINGS.map((s) => ({
  id: `symphony-${s.id}`,
  label: `Symphony orchestra, ${s.label}`,
  description:
    'Sixteen section tracks on their orchestral programs, panned to their seats, on five section buses that send to one Detmold Konzerthaus hall; synth reverb off on every track.',
  apply: () => createSymphonyTemplate({ seating: s.id as Seating }),
}));

export const TrackTemplatePicker: React.FC<{ idBase: string }> = ({ idBase }) => {
  const [choice, setChoice] = useState(TRACK_TEMPLATES[0].id);
  const [error, setError] = useState<string | null>(null);
  const selectId = `${idBase}-track-template`;
  const errorId = `${idBase}-track-template-error`;
  const chosen = TRACK_TEMPLATES.find((t) => t.id === choice) ?? TRACK_TEMPLATES[0];
  const add = () => {
    const r = chosen.apply();
    setError(r.ok ? null : r.error);
  };
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={selectId} className="font-sans text-xs font-bold text-zinc-400">
        Track template
      </label>
      <div className="flex items-center gap-1">
        <select
          id={selectId}
          name={selectId}
          value={choice}
          onChange={(e) => { setChoice(e.target.value); setError(null); }}
          title={chosen.description}
          className="flex-1 min-w-0 form-select px-1 py-0.5 text-xs font-bold"
          style={{ colorScheme: 'dark' }}
        >
          {TRACK_TEMPLATES.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
        </select>
        <button
          type="button"
          onClick={add}
          aria-label={`Add template: ${chosen.label}`}
          aria-describedby={error ? errorId : undefined}
          title={chosen.description}
          className="shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded border border-white/10 bg-black/40 font-sans text-xs font-bold text-zinc-300 hover:text-purple-300 hover:border-purple-500/50"
        >
          <LayoutTemplate aria-hidden="true" className="w-3.5 h-3.5" />
          Add
        </button>
      </div>
      {error && (
        <p id={errorId} role="alert" className="font-sans text-xs font-bold text-red-300">{error}</p>
      )}
    </div>
  );
};
