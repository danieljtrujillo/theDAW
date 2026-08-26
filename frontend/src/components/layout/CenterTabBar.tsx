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
   *  so each workspace gets a recognizable color at a glance. */
  accent: { border: string; bg: string; text: string; iconText: string };
}> = [
  // Order locked by user: MAKE, EDIT, MIX, PERFORM, DJ, VJ, FOUNDRY, UNDERFIT, LEARN.
  {
    id: 'make',
    label: 'Make',
    desc: 'Generate audio from a text prompt with the AI models',
    icon: Sparkles,
    accent: {
      border: 'border-purple-500/50',
      bg: 'bg-purple-500/15',
      text: 'text-purple-100',
      iconText: 'text-purple-300',
    },
  },
  {
    id: 'edit',
    label: 'Edit',
    desc: 'Arrange clips on a timeline, add effects and automation, export',
    icon: Scissors,
    accent: {
      border: 'border-emerald-500/50',
      bg: 'bg-emerald-500/15',
      text: 'text-emerald-100',
      iconText: 'text-emerald-300',
    },
  },
  {
    id: 'mix',
    label: 'Mix',
    desc: 'Process and master audio with the effect and module rack',
    icon: Zap,
    accent: {
      border: 'border-orange-500/50',
      bg: 'bg-orange-500/15',
      text: 'text-orange-100',
      iconText: 'text-orange-300',
    },
  },
  {
    id: 'session',
    label: 'Perform',
    desc: 'Import a project and perform its scene/clip grid live',
    icon: Rows3,
    accent: {
      border: 'border-sky-500/50',
      bg: 'bg-sky-500/15',
      text: 'text-sky-100',
      iconText: 'text-sky-300',
    },
  },
  {
    id: 'dj',
    label: 'DJ',
    desc: 'Two-deck DJ console: mix, cue, scratch, stems and automix',
    icon: Disc,
    accent: {
      border: 'border-pink-500/50',
      bg: 'bg-pink-500/15',
      text: 'text-pink-100',
      iconText: 'text-pink-300',
    },
  },
  {
    id: 'vj',
    label: 'VJ',
    desc: 'Live visuals engine: sources, effects and output for performance',
    icon: Tv2,
    accent: {
      border: 'border-fuchsia-500/50',
      bg: 'bg-fuchsia-500/15',
      text: 'text-fuchsia-100',
      iconText: 'text-fuchsia-300',
    },
  },
  {
    id: 'sway',
    label: 'Sway',
    desc: 'SwayCommand: gesture VJ cockpit for the Audima Sway, plus theDAW’s Sway routing',
    icon: Waves,
    accent: {
      border: 'border-fuchsia-500/50',
      bg: 'bg-fuchsia-500/15',
      text: 'text-fuchsia-100',
      iconText: 'text-fuchsia-300',
    },
  },
  {
    id: 'foundry',
    label: 'Foundry',
    desc: 'Design and export custom VST / plugin interfaces on an infinite canvas',
    icon: Hammer,
    accent: {
      border: 'border-amber-500/50',
      bg: 'bg-amber-500/15',
      text: 'text-amber-100',
      iconText: 'text-amber-300',
    },
  },
  {
    id: 'underfit',
    label: 'Underfit',
    desc: 'Train LoRA finetunes with the Underfit dashboard',
    icon: FlaskConical,
    accent: {
      border: 'border-sky-500/50',
      bg: 'bg-sky-500/15',
      text: 'text-sky-100',
      iconText: 'text-sky-300',
    },
  },
  {
    id: 'audimate',
    label: 'Audimate',
    desc: 'Build generation pipelines as a wired node graph, then run them',
    icon: Waypoints,
    accent: {
      border: 'border-teal-500/50',
      bg: 'bg-teal-500/15',
      text: 'text-teal-100',
      iconText: 'text-teal-300',
    },
  },
  {
    id: 'learn',
    label: 'Learn',
    desc: 'Guides, docs and the in-app assistant',
    icon: Workflow,
    accent: {
      border: 'border-rose-500/50',
      bg: 'bg-rose-500/15',
      text: 'text-rose-100',
      iconText: 'text-rose-300',
    },
  },
  {
    id: 'tour',
    label: 'Tour',
    desc: 'Find venues and promoters by region, plan multi-stop tour routes',
    icon: Route,
    accent: {
      border: 'border-lime-500/50',
      bg: 'bg-lime-500/15',
      text: 'text-lime-100',
      iconText: 'text-lime-300',
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
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              data-tour={`tab-${t.id}`}
              onClick={() => onTabChange(t.id)}
              className={[
                'flex-1 max-w-44 flex items-center justify-center gap-2 px-3 py-1.5',
                'rounded border transition-colors',
                'text-[10px] font-black uppercase tracking-widest',
                active
                  ? `${t.accent.border} ${t.accent.bg} ${t.accent.text}`
                  : 'border-white/5 text-zinc-500 hover:text-zinc-200 hover:bg-white/3',
              ].join(' ')}
              title={t.desc}
            >
              <Icon className={`w-3.5 h-3.5 ${active ? t.accent.iconText : ''}`} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
};
