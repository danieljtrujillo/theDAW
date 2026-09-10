/**
 * The header's icon button.
 *
 * One treatment for every control in the top-bar cluster — mobile access, the
 * help search, the app menu — so the row reads as one set of buttons instead of
 * three lookalikes. `accent` picks the hue; `active` is the filled state a
 * popover trigger wears while its panel is open.
 *
 * It sits in its own file rather than inside Shell because the help-search
 * popover renders one for its own trigger while Shell renders the popover:
 * leaving the button private to Shell would make that pair import each other.
 */
import React from 'react';

export type TopBarAccent = 'purple' | 'emerald' | 'sky' | 'rose' | 'neutral';

export interface TopBarButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  /** Tooltip AND accessible name — these buttons carry no visible text. */
  title: string;
  accent?: TopBarAccent;
  /** Filled treatment. A popover trigger wears it while its panel is open. */
  active?: boolean;
  /** Popover wiring, for a trigger that owns a panel. */
  ariaHasPopup?: 'dialog' | 'menu' | 'listbox';
  ariaExpanded?: boolean;
  /**
   * Pass the panel's id only while the panel is actually rendered:
   * aria-controls naming an element that does not exist is worse than no
   * aria-controls at all.
   */
  ariaControls?: string;
  /** So a popover can hand focus back to its trigger when it closes. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

const ACCENT_CLS: Record<TopBarAccent, { idle: string; idleText: string; active: string }> = {
  purple: {
    idle: 'border-purple-500/30 hover:bg-purple-500/15 shadow-[0_0_10px_rgba(168,85,247,0.3)]',
    idleText: 'text-purple-300 group-hover:text-purple-200',
    active: 'border-purple-500/50 bg-purple-500/15 text-purple-200 shadow-[0_0_12px_rgba(168,85,247,0.45)]',
  },
  emerald: {
    idle: 'border-emerald-500/30 hover:bg-emerald-500/15 shadow-[0_0_10px_rgba(16,185,129,0.3)]',
    idleText: 'text-emerald-300 group-hover:text-emerald-200',
    active: 'border-emerald-500/50 bg-emerald-500/15 text-emerald-200 shadow-[0_0_12px_rgba(16,185,129,0.45)]',
  },
  sky: {
    idle: 'border-sky-500/30 hover:bg-sky-500/15 shadow-[0_0_10px_rgba(14,165,233,0.3)]',
    idleText: 'text-sky-300 group-hover:text-sky-200',
    active: 'border-sky-500/50 bg-sky-500/15 text-sky-200 shadow-[0_0_12px_rgba(14,165,233,0.45)]',
  },
  rose: {
    idle: 'border-rose-500/30 hover:bg-rose-500/15 shadow-[0_0_10px_rgba(244,63,94,0.3)]',
    idleText: 'text-rose-300 group-hover:text-rose-200',
    active: 'border-rose-500/50 bg-rose-500/15 text-rose-200 shadow-[0_0_12px_rgba(244,63,94,0.45)]',
  },
  neutral: {
    idle: 'border-white/5 hover:bg-white/5',
    idleText: 'text-zinc-500 group-hover:text-zinc-200',
    active: 'border-white/20 bg-white/10 text-zinc-100',
  },
};

export const TopBarButton: React.FC<TopBarButtonProps> = ({
  onClick,
  icon,
  title,
  accent = 'neutral',
  active = false,
  ariaHasPopup,
  ariaExpanded,
  ariaControls,
  buttonRef,
}) => {
  const cls = ACCENT_CLS[accent];
  const stateCls = active ? cls.active : `${cls.idle} ${cls.idleText}`;
  return (
    <button
      type="button"
      ref={buttonRef}
      onClick={onClick}
      title={title}
      aria-label={title}
      aria-haspopup={ariaHasPopup}
      aria-expanded={ariaExpanded}
      aria-controls={ariaControls}
      className={`p-1.5 rounded border transition-colors group flex items-center gap-1.5 outline-none focus-visible:ring-1 focus-visible:ring-purple-400/60 ${stateCls}`}
    >
      {icon}
    </button>
  );
};
