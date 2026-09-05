/** One numbered, collapsible step of the TOUR rail. The rail reads as a
 *  workflow (where -> when -> what -> venues -> route), so every step carries
 *  a number (a check once done), an uppercase title, one line of normal-case
 *  helper text while open, and a one-line summary while collapsed. The header
 *  toggle is a real button (aria-expanded/aria-controls); step-level actions
 *  ("Clear filters", "Clear route") are SIBLINGS of that button, never nested
 *  inside it. */
import React from 'react';
import { Check, ChevronDown } from 'lucide-react';

/** active: the step the user should work on next (lime rail + title).
 *  done: requirement met (check badge, summary when collapsed).
 *  optional: never blocks the flow ("optional" meta while untouched).
 *  todo: not reachable yet (dim badge, helper explains what unlocks it). */
export type StepState = 'active' | 'done' | 'optional' | 'todo';

export const RailStep: React.FC<{
  n: number;
  id: string;
  title: string;
  helper: string;
  state: StepState;
  open: boolean;
  onToggle: () => void;
  /** Shown under the title while collapsed (what this step currently holds). */
  summary?: string;
  /** Right-aligned 10 px meta inside the header (counts, "optional"). */
  meta?: React.ReactNode;
  /** Header actions rendered beside the toggle button. */
  actions?: React.ReactNode;
  /** The step that owns the rail's remaining height (the venue list). */
  grow?: boolean;
  children: React.ReactNode;
}> = ({ n, id, title, helper, state, open, onToggle, summary, meta, actions, grow, children }) => {
  const bodyId = `${id}-body`;
  const titleId = `${id}-title`;
  const growing = grow && open;
  return (
    <section
      aria-labelledby={titleId}
      data-step-state={state}
      className={`border-b border-white/8 border-l-2 ${
        growing ? 'flex min-h-48 flex-1 flex-col' : 'shrink-0'
      } ${state === 'active' ? 'border-l-lime-400 bg-lime-500/4' : 'border-l-transparent'}`}
    >
      <div className="flex items-center gap-2 py-2 pr-3 pl-2.5">
        <button
          type="button"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={onToggle}
          className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline focus-visible:outline-lime-400/70"
        >
          <span
            aria-hidden="true"
            className={`grid h-4.5 w-4.5 shrink-0 place-items-center rounded-full text-[10px] font-black ${
              state === 'done'
                ? 'bg-lime-400 text-[#0a080f]'
                : state === 'active'
                  ? 'bg-lime-500/25 text-lime-200 ring-1 ring-lime-400/60'
                  : 'bg-white/8 text-zinc-400'
            }`}
          >
            {state === 'done' ? <Check className="h-3 w-3" strokeWidth={3} /> : n}
          </span>
          <span className="min-w-0 flex-1">
            <span
              id={titleId}
              className={`block text-[11px] font-black uppercase tracking-wide ${
                state === 'active' ? 'text-lime-200' : state === 'todo' ? 'text-zinc-500' : 'text-zinc-200'
              }`}
            >
              <span className="sr-only">{`Step ${n}${state === 'done' ? ', done' : ''}: `}</span>
              {title}
            </span>
            {!open && summary && (
              <span className="block truncate text-[11px] text-zinc-400" title={summary}>{summary}</span>
            )}
          </span>
          {meta !== undefined && meta !== null && (
            <span className="shrink-0 text-[10px] text-zinc-500">{meta}</span>
          )}
          <ChevronDown
            aria-hidden="true"
            className={`h-3.5 w-3.5 shrink-0 text-zinc-500 transition-transform ${open ? '' : '-rotate-90'}`}
          />
        </button>
        {actions}
      </div>
      <div
        id={bodyId}
        hidden={!open}
        className={`pr-3 pb-3 pl-2.5 ${growing ? 'flex min-h-0 flex-1 flex-col' : ''}`}
      >
        <p className="mb-2 text-[11px] leading-snug text-zinc-500">{helper}</p>
        {children}
      </div>
    </section>
  );
};
