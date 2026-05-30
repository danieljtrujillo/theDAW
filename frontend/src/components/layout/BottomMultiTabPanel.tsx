/**
 * Bottom multi-tab panel body — Visualize / Piano / Sequence / Details
 * / Media. Mounted above the dock strip when isOpen=true. The strip
 * itself (Shell.tsx ShellBottomDock) handles the open/close toggle,
 * so this component only renders the body shape: a tabs row + the
 * active tab's content. Height is the column's own `multiHeight`
 * from bottomPanelStore — independent of the LOG's `logHeight`.
 */
import React from 'react';
import {
  Activity, Info, Piano, Layers, FolderOpen,
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
  const activeTab = useBottomPanelStore((s) => s.activeTab);
  const setActiveTab = useBottomPanelStore((s) => s.setActiveTab);

  return (
    <div className="h-full flex flex-col bg-purple-500/2 min-h-0">
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

