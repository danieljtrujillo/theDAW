import React from 'react';
import {
  Brain,
  Sparkles,
  Scissors,
  Zap,
  Workflow,
  ChevronLeft,
  ChevronRight,
  PanelLeftOpen,
  PanelLeftClose,
  PanelRightOpen,
  PanelRightClose,
} from 'lucide-react';
import { type CenterTab } from '../../state/appUiStore';

/** The five workspace tabs introduced in the top-bar restructure
 *  (plan step 3a). Centered, horizontally filling the bar with
 *  padding; the side-panel collapse/expand arrows live at the inner
 *  edges. */

interface CenterTabBarProps {
  activeTab: CenterTab;
  onTabChange: (tab: CenterTab) => void;
  isLeftPanelOpen: boolean;
  isRightPanelOpen: boolean;
  onToggleLeftPanel: () => void;
  onToggleRightPanel: () => void;
}

const TABS: Array<{
  id: CenterTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  /** Per-tab accent color — used for active border + soft bg tint
   *  so each workspace gets a recognizable color at a glance. */
  accent: { border: string; bg: string; text: string; iconText: string };
}> = [
  {
    id: 'train',
    label: 'Train',
    icon: Brain,
    accent: {
      border: 'border-cyan-500/50',
      bg: 'bg-cyan-500/15',
      text: 'text-cyan-100',
      iconText: 'text-cyan-300',
    },
  },
  {
    id: 'make',
    label: 'Make',
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
    icon: Zap,
    accent: {
      border: 'border-orange-500/50',
      bg: 'bg-orange-500/15',
      text: 'text-orange-100',
      iconText: 'text-orange-300',
    },
  },
  {
    id: 'learn',
    label: 'Learn',
    icon: Workflow,
    accent: {
      border: 'border-rose-500/50',
      bg: 'bg-rose-500/15',
      text: 'text-rose-100',
      iconText: 'text-rose-300',
    },
  },
];

export const CenterTabBar: React.FC<CenterTabBarProps> = ({
  activeTab,
  onTabChange,
  isLeftPanelOpen,
  isRightPanelOpen,
  onToggleLeftPanel,
  onToggleRightPanel,
}) => {
  return (
    <div className="flex items-stretch h-9 border-b border-white/5 bg-[#0a080f] px-2 shrink-0">
      {/* Left side-panel toggle */}
      <SidePanelToggle
        position="left"
        isOpen={isLeftPanelOpen}
        onToggle={onToggleLeftPanel}
      />

      {/* Centered, fills width */}
      <div className="flex-1 flex items-center justify-center gap-1 px-2">
        {TABS.map((t) => {
          const Icon = t.icon;
          const active = activeTab === t.id;
          return (
            <button
              key={t.id}
              type="button"
              onClick={() => onTabChange(t.id)}
              className={[
                'flex-1 max-w-44 flex items-center justify-center gap-2 px-3 py-1.5',
                'rounded border transition-colors',
                'text-[10px] font-black uppercase tracking-widest',
                active
                  ? `${t.accent.border} ${t.accent.bg} ${t.accent.text}`
                  : 'border-white/5 text-zinc-500 hover:text-zinc-200 hover:bg-white/3',
              ].join(' ')}
              title={t.label}
            >
              <Icon className={`w-3.5 h-3.5 ${active ? t.accent.iconText : ''}`} />
              <span>{t.label}</span>
            </button>
          );
        })}
      </div>

      {/* Right side-panel toggle */}
      <SidePanelToggle
        position="right"
        isOpen={isRightPanelOpen}
        onToggle={onToggleRightPanel}
      />
    </div>
  );
};

interface SidePanelToggleProps {
  position: 'left' | 'right';
  isOpen: boolean;
  onToggle: () => void;
}

const SidePanelToggle: React.FC<SidePanelToggleProps> = ({ position, isOpen, onToggle }) => {
  const IconOpen = position === 'left' ? PanelLeftOpen : PanelRightOpen;
  const IconClose = position === 'left' ? PanelLeftClose : PanelRightClose;
  const Chevron = position === 'left'
    ? (isOpen ? ChevronLeft : ChevronRight)
    : (isOpen ? ChevronRight : ChevronLeft);
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex items-center justify-center w-9 self-stretch text-zinc-500 hover:text-zinc-200 hover:bg-white/5 transition-colors rounded"
      title={`${isOpen ? 'Collapse' : 'Expand'} ${position} panel`}
      aria-label={`${isOpen ? 'Collapse' : 'Expand'} ${position} panel`}
    >
      {isOpen ? <IconClose className="w-4 h-4" /> : <IconOpen className="w-4 h-4" />}
      <Chevron className="w-3 h-3 opacity-60 -ml-0.5" />
    </button>
  );
};
