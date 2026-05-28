/**
 * Bottom multi-tab panel — Visualize / Piano / Sequence / Details /
 * Media. Lives in the global footer (Shell.tsx) side-by-side with
 * ProcessingLog. Was previously embedded in DAWCenterPanel.
 *
 * Height is read from the shared bottomPanelStore so the panel and
 * the log resize in lock-step (the footer's resize handle writes
 * `bottomHeight` and both surfaces re-render at the new height).
 */
import React from 'react';
import {
  Activity, Info, Piano, Layers, FolderOpen,
  ChevronDown, ChevronUp,
} from 'lucide-react';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { PianoRoll } from '../audio/PianoRoll';
import { StepSequencer } from '../audio/StepSequencer';
import { DetailsView } from './DetailsView';
import { MediaBucketView } from './MediaBucketView';
import { useBottomPanelStore, type BottomPanelTab } from '../../state/bottomPanelStore';

const TAB_DEFS: Array<{ id: BottomPanelTab; label: string; icon: React.ComponentType<{ className?: string }>; colorActive: string }> = [
  { id: 'spectral',   label: 'Visualize',    icon: Activity,   colorActive: 'border-purple-500 text-purple-300' },
  { id: 'piano-roll', label: 'Piano',        icon: Piano,      colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'step-seq',   label: 'Sequence',     icon: Layers,     colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'details',    label: 'Details',      icon: Info,       colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'bucket',     label: 'Media',        icon: FolderOpen, colorActive: 'border-amber-500 text-amber-300' },
];

export const BottomMultiTabPanel: React.FC = () => {
  const isOpen = useBottomPanelStore((s) => s.isOpen);
  const setOpen = useBottomPanelStore((s) => s.setOpen);
  const activeTab = useBottomPanelStore((s) => s.activeTab);
  const setActiveTab = useBottomPanelStore((s) => s.setActiveTab);

  if (!isOpen) {
    // Collapsed: thin header strip at TOP of the column, matching the
    // LOG's header height so the two panels line up visually. Click
    // anywhere on the strip to expand. Body area below the strip is
    // empty (no full-height button) so it doesn't compete for space
    // with whatever the LOG is showing on the other side.
    return (
      <div className="h-full flex flex-col min-h-0">
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="flex items-center justify-center gap-1.5 px-2 py-1.5 border-b border-purple-500/20 bg-purple-500/4 hover:bg-purple-500/10 transition-colors group shrink-0"
          title="Expand bottom panel (Visualize / Piano / Sequence / Details / Media)"
          aria-label="Expand bottom panel"
        >
          <ChevronUp className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors" />
        </button>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-purple-500/2 border-t border-purple-500/15 min-h-0">
      {/* Tabs row */}
      <div className="flex items-center justify-between border-b border-white/5 shrink-0 bg-black/30">
        <div className="flex overflow-x-auto no-scrollbar">
          {TAB_DEFS.map((t) => {
            const Icon = t.icon;
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                onClick={() => setActiveTab(t.id)}
                className={`px-3 py-1.5 flex items-center gap-1.5 border-b-2 text-[9px] uppercase tracking-widest font-black transition-colors whitespace-nowrap ${active ? t.colorActive : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                title={t.label}
              >
                <Icon className="w-3 h-3" /> {t.label}
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2 px-2 shrink-0">
          <button
            onClick={() => setOpen(false)}
            className="p-1 hover:bg-white/10 rounded"
            title="Collapse bottom panel"
            aria-label="Collapse bottom panel"
          >
            <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
          </button>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 relative">
        {activeTab === 'spectral' && (
          <div className="absolute inset-0 p-1">
            <AdvancedVisualizer />
          </div>
        )}
        {activeTab === 'details' && (
          <div className="absolute inset-0">
            <DetailsView />
          </div>
        )}
        {activeTab === 'piano-roll' && (
          <div className="absolute inset-0">
            <PianoRoll />
          </div>
        )}
        {activeTab === 'step-seq' && (
          <div className="absolute inset-0 overflow-y-auto">
            <StepSequencer />
          </div>
        )}
        {activeTab === 'bucket' && (
          <div className="absolute inset-0">
            <MediaBucketView />
          </div>
        )}
      </div>
    </div>
  );
};
