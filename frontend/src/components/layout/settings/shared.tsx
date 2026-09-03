/**
 * Shared building blocks for the Settings modal sections.
 *
 * One type scale for the whole modal: 12 px (`text-xs`) for titles, labels
 * and body copy, 11 px mono for meta/chips. Nothing smaller — the old 8-9 px
 * greys read as background noise. Long explanations live in hover titles /
 * InfoTips, never in inline paragraphs, so every section stays a few rows
 * tall and the modal fits one screen.
 */
import React from 'react';
import { ToggleLeft, ToggleRight, Loader2 } from 'lucide-react';
import { InfoTip } from '../../ui/Tooltip';

export const SECTION_TITLE = 'text-xs font-black uppercase tracking-widest text-zinc-200';
export const SECTION_META = 'text-[11px] font-mono text-zinc-400';
export const FIELD_LABEL = 'text-[11px] font-mono uppercase tracking-wider text-zinc-300';
export const BODY = 'text-xs text-zinc-300';
export const CARD = 'rounded border border-white/8 bg-white/3';
export const INPUT =
  'min-w-0 rounded border border-white/10 bg-black/40 px-1.5 py-1 text-xs font-mono text-zinc-200 placeholder:text-zinc-500 outline-none focus:border-purple-500/50';

const BTN_BASE =
  'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-black uppercase tracking-widest transition-colors disabled:opacity-40 disabled:cursor-default focus-visible:outline-none focus-visible:ring-1';
export const BTN_GHOST = `${BTN_BASE} border-white/10 text-zinc-300 hover:text-white hover:bg-white/5 focus-visible:ring-white/30`;
export const BTN_PURPLE = `${BTN_BASE} border-purple-500/40 bg-purple-500/15 text-purple-200 hover:bg-purple-500/25 focus-visible:ring-purple-400/70`;
export const BTN_AMBER = `${BTN_BASE} border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 hover:text-amber-100 focus-visible:ring-amber-400/70`;
export const BTN_ROSE = `${BTN_BASE} border-rose-500/40 bg-rose-500/10 text-rose-200 hover:bg-rose-500/20 hover:text-rose-100 focus-visible:ring-rose-400/70`;
export const BTN_SKY = `${BTN_BASE} border-sky-500/40 bg-sky-500/10 text-sky-200 hover:bg-sky-500/20 hover:text-sky-100 focus-visible:ring-sky-400/70`;

/** Section header: icon + terse title + InfoTip with the long copy + optional
 *  right-aligned meta chip + optional extra controls. */
export const SectionHeader: React.FC<{
  icon: React.ReactNode;
  title: string;
  tip?: string;
  meta?: string;
  children?: React.ReactNode;
}> = ({ icon, title, tip, meta, children }) => (
  <div className="flex items-center gap-1.5 mb-1.5 min-w-0">
    {icon}
    <span className={SECTION_TITLE}>{title}</span>
    {tip && <InfoTip title={title} body={tip} />}
    {children}
    {meta && <span className={`${SECTION_META} ml-auto shrink-0`}>{meta}</span>}
  </div>
);

/** Segmented option toggle: a labelled group of pressed/unpressed buttons. */
export const Segmented: React.FC<{
  value: string;
  options: ReadonlyArray<readonly string[]>;
  onChange: (v: string) => void;
  ariaLabel: string;
}> = ({ value, options, onChange, ariaLabel }) => (
  <div role="group" aria-label={ariaLabel} className="flex items-center gap-1">
    {options.map(([v, lbl]) => (
      <button
        key={v}
        type="button"
        onClick={() => onChange(v)}
        aria-pressed={value === v}
        className={`text-[11px] font-mono uppercase tracking-widest px-1.5 py-0.5 rounded border transition-colors ${
          value === v ? 'bg-purple-500/25 border-purple-400/60 text-purple-100' : 'border-white/10 text-zinc-300 hover:text-white hover:bg-white/5'
        }`}
      >
        {lbl}
      </button>
    ))}
  </div>
);

/** A switch drawn as the toggle glyph. Custom control, so it carries its own
 *  accessible name and pressed state instead of relying on a <label>. */
export const IconToggle: React.FC<{
  enabled: boolean;
  onToggle: () => void;
  /** Accessible name, e.g. "Analyze on import". */
  label: string;
  title?: string;
  busy?: boolean;
  disabled?: boolean;
  /** Optional visible caption to the right of the glyph. */
  caption?: string;
  className?: string;
}> = ({ enabled, onToggle, label, title, busy, disabled, caption, className = '' }) => (
  <button
    type="button"
    onClick={onToggle}
    disabled={busy || disabled}
    aria-pressed={enabled}
    aria-label={label}
    title={title ?? (enabled ? `Disable: ${label}` : `Enable: ${label}`)}
    className={`inline-flex items-center gap-1 group disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-purple-400/70 rounded ${className}`}
  >
    {busy ? (
      <Loader2 className="w-4 h-4 text-zinc-400 animate-spin" />
    ) : enabled ? (
      <ToggleRight className="w-5 h-5 text-purple-400 group-hover:text-purple-300" />
    ) : (
      <ToggleLeft className="w-5 h-5 text-zinc-500 group-hover:text-zinc-400" />
    )}
    {caption && (
      <span className={`text-[11px] font-mono uppercase tracking-widest ${enabled ? 'text-purple-200' : 'text-zinc-400'}`}>
        {caption}
      </span>
    )}
  </button>
);

/** POST a fix endpoint, surfacing the backend's own detail on failure. */
export const postFix = async (url: string, init?: RequestInit): Promise<unknown> => {
  const r = await fetch(url, { method: 'POST', ...(init ?? {}) });
  if (!r.ok) {
    const detail = await r.json().then((j) => j?.detail).catch(() => null);
    throw new Error(
      (typeof detail === 'string' ? detail : detail?.message) || `HTTP ${r.status}`,
    );
  }
  return r.json().catch(() => null);
};

export const sleep = (ms: number): Promise<void> => new Promise((res) => setTimeout(res, ms));
