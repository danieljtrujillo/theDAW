/** A labelled row of toggle chips (aria-pressed buttons under a small
 *  normal-case label). Used for genre / venue type / energy in the WHAT step. */
import React from 'react';

export const ChipGroup: React.FC<{
  id: string;
  label: string;
  labels: string[];
  selected: Set<string>;
  onToggle: (label: string) => void;
  /** Rendered instead of chips when there are none (backend not up yet). */
  empty?: string;
}> = ({ id, label, labels, selected, onToggle, empty }) => (
  <div role="group" aria-labelledby={`${id}-label`}>
    <p id={`${id}-label`} className="mb-1 text-[11px] text-zinc-400">{label}</p>
    {labels.length === 0 ? (
      <p className="text-[11px] text-zinc-600">{empty ?? 'None yet'}</p>
    ) : (
      <div className="flex flex-wrap gap-1">
        {labels.map((l) => {
          const on = selected.has(l);
          return (
            <button
              key={l}
              type="button"
              aria-pressed={on}
              onClick={() => onToggle(l)}
              className={`rounded-full border px-2 py-0.5 text-[11px] capitalize transition-colors ${
                on
                  ? 'border-lime-500/50 bg-lime-500/15 text-lime-200'
                  : 'border-white/10 bg-white/5 text-zinc-400 hover:border-white/20 hover:text-zinc-200'
              }`}
            >
              {l}
            </button>
          );
        })}
      </div>
    )}
  </div>
);
