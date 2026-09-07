import React from 'react';
import {
  Sparkles,
  Scissors,
  Zap,
  Workflow,
  Tv2,
  Disc,
  Hammer,
  FlaskConical,
  Rows3,
  Waypoints,
  Route,
  Waves,
  Grid3x3,
} from 'lucide-react';
import { type CenterTab } from '../../state/appUiStore';

/** The five workspace tabs introduced in the top-bar restructure
 *  (plan step 3a). Centered, horizontally filling the bar with
 *  padding. The library-panel toggle now lives in the header icon
 *  cluster (Shell), so this bar is tabs-only. No left panel — removed
 *  per layout invariant. */

interface CenterTabBarProps {
  activeTab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  /** When true, render bare (no own bar chrome) so it can sit inside the
   *  combined header row instead of as its own strip. */
  embedded?: boolean;
}

const TABS: Array<{
  id: CenterTab;
  label: string;
  desc: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Per-tab accent color — used for active border + soft bg tint
   *  so each workspace gets a recognizable color at a glance. The -500
   *  border reads ≥ 3:1 on every theme's header (dark or light); the -100
   *  text is flipped to the hue's -800 on light themes by index.css. */
  accent: { border: string; bg: string; text: string; iconText: string; hoverBorder: string };
}> = [
  // Order locked by user: MAKE, EDIT, MIX, PERFORM, DJ, VJ, FOUNDRY, UNDERFIT, LEARN.
  {
    id: 'make',
    label: 'Make',
    desc: 'Generate audio from a text prompt with the AI models',
    icon: Sparkles,
    accent: {
      border: 'border-purple-500',
      bg: 'bg-purple-500/20',
      text: 'text-purple-100',
      iconText: 'text-purple-300',
      hoverBorder: 'hover:border-purple-400',
    },
  },
  {
    id: 'edit',
    label: 'Edit',
    desc: 'Arrange clips on a timeline, add effects and automation, export',
    icon: Scissors,
    accent: {
      border: 'border-emerald-500',
      bg: 'bg-emerald-500/20',
      text: 'text-emerald-100',
      iconText: 'text-emerald-300',
      hoverBorder: 'hover:border-emerald-400',
    },
  },
  {
    id: 'mix',
    label: 'Mix',
    desc: 'Process and master audio with the effect and module rack',
    icon: Zap,
    accent: {
      border: 'border-orange-500',
      bg: 'bg-orange-500/20',
      text: 'text-orange-100',
      iconText: 'text-orange-300',
      hoverBorder: 'hover:border-orange-400',
    },
  },
  {
    id: 'session',
    label: 'Perform',
    desc: 'Import a project and perform its scene/clip grid live',
    icon: Rows3,
    accent: {
      border: 'border-sky-500',
      bg: 'bg-sky-500/20',
      text: 'text-sky-100',
      iconText: 'text-sky-300',
      hoverBorder: 'hover:border-sky-400',
    },
  },
  {
    id: 'dj',
    label: 'DJ',
    desc: 'Two-deck DJ console: mix, cue, scratch, stems and automix',
    icon: Disc,
    accent: {
      border: 'border-pink-500',
      bg: 'bg-pink-500/20',
      text: 'text-pink-100',
      iconText: 'text-pink-300',
      hoverBorder: 'hover:border-pink-400',
    },
  },
  {
    id: 'vj',
    label: 'VJ',
    desc: 'Live visuals engine: sources, effects and output for performance',
    icon: Tv2,
    accent: {
      border: 'border-fuchsia-500',
      bg: 'bg-fuchsia-500/20',
      text: 'text-fuchsia-100',
      iconText: 'text-fuchsia-300',
      hoverBorder: 'hover:border-fuchsia-400',
    },
  },
  {
    id: 'sway',
    label: 'Sway',
    desc: 'SwayCommand: gesture VJ cockpit for the Audima Sway, plus theDAW’s Sway routing',
    icon: Waves,
    accent: {
      border: 'border-fuchsia-500',
      bg: 'bg-fuchsia-500/20',
      text: 'text-fuchsia-100',
      iconText: 'text-fuchsia-300',
      hoverBorder: 'hover:border-fuchsia-400',
    },
  },
  {
    id: 'foundry',
    label: 'Foundry',
    desc: 'Design and export custom VST / plugin interfaces on an infinite canvas',
    icon: Hammer,
    accent: {
      border: 'border-amber-500',
      bg: 'bg-amber-500/20',
      text: 'text-amber-100',
      iconText: 'text-amber-300',
      hoverBorder: 'hover:border-amber-400',
    },
  },
  {
    id: 'underfit',
    label: 'Underfit',
    desc: 'Train LoRA finetunes with the Underfit dashboard',
    icon: FlaskConical,
    accent: {
      border: 'border-sky-500',
      bg: 'bg-sky-500/20',
      text: 'text-sky-100',
      iconText: 'text-sky-300',
      hoverBorder: 'hover:border-sky-400',
    },
  },
  {
    id: 'nodefi',
    label: 'NodeFI',
    desc: 'NodeF.I. — wire node graphs: AI pipelines offline, stems + rack FX live',
    icon: Waypoints,
    accent: {
      border: 'border-teal-500',
      bg: 'bg-teal-500/20',
      text: 'text-teal-100',
      iconText: 'text-teal-300',
      hoverBorder: 'hover:border-teal-400',
    },
  },
  {
    id: 'loom',
    label: 'Loom',
    desc: 'LOOM — a Jacquard for your own catalogue: sequence shards of your songs on one beat clock',
    icon: Grid3x3,
    accent: {
      border: 'border-amber-500',
      bg: 'bg-amber-500/20',
      text: 'text-amber-100',
      iconText: 'text-amber-300',
      hoverBorder: 'hover:border-amber-400',
    },
  },
  {
    id: 'learn',
    label: 'Learn',
    desc: 'Guides, docs and the in-app assistant',
    icon: Workflow,
    accent: {
      border: 'border-rose-500',
      bg: 'bg-rose-500/20',
      text: 'text-rose-100',
      iconText: 'text-rose-300',
      hoverBorder: 'hover:border-rose-400',
    },
  },
  {
    id: 'tour',
    label: 'Tour',
    desc: 'Find venues and promoters by region, plan multi-stop tour routes',
    icon: Route,
    accent: {
      border: 'border-lime-500',
      bg: 'bg-lime-500/20',
      text: 'text-lime-100',
      iconText: 'text-lime-300',
      hoverBorder: 'hover:border-lime-400',
    },
  },
];

export const CenterTabBar: React.FC<CenterTabBarProps> = ({
  activeTab,
  onTabChange,
  embedded = false,
}) => {
  return (
    <div
      className={
        embedded
          ? 'flex items-stretch flex-1 min-w-0 h-8'
          : 'flex items-stretch h-9 border-b border-white/5 bg-[#0a080f] px-2 shrink-0'
      }
    >
      {/* Centered, fills width */}
      <div className="flex-1 flex items-center justify-center gap-1 px-2">
        {TABS.map((t) => {
          const active = activeTab === t.id;
          // Label only — the tabs have names, so no icon (user mandate: icons
          // stay only where they ARE the control, with no visible name).
          return (
            <button
              key={t.id}
              type="button"
              data-tour={`tab-${t.id}`}
              onClick={() => onTabChange(t.id)}
              className={[
                'flex-1 max-w-44 flex items-center justify-center px-3 py-1.5',
                'rounded border transition-colors',
                'text-[10px] font-black uppercase tracking-widest',
                // Keyboard focus: a 2px ink outline on every theme.
                'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:et-outline',
                active
                  // Unmistakable: solid accent border + tint + a 2px accent
                  // underline (currentColor = the accent text colour).
                  ? `${t.accent.border} ${t.accent.bg} ${t.accent.text} shadow-[inset_0_-2px_0_0_currentColor]`
                  // Inactive: primary ink (≥ 7:1) on a visible (≥ 3:1) themed
                  // border; hover lifts the fill and shows the tab's hue.
                  : `et-border et-ink hover:et-bg-tint ${t.accent.hoverBorder}`,
              ].join(' ')}
              title={t.desc}
              aria-pressed={active}
            >
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
