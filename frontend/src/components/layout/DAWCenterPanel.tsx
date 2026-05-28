import React, { useState, useRef, useEffect } from 'react';
import { WaveformEditor } from '../audio/WaveformEditor';
import { StepSequencer } from '../audio/StepSequencer';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { PianoRoll } from '../audio/PianoRoll';
import { DetailsView } from './DetailsView';
import { MediaBucketView } from './MediaBucketView';
import {
  Layers, Activity, GripHorizontal, ChevronDown, ChevronUp,
  Info, Piano, FolderOpen,
} from 'lucide-react';
import { AdvancedView } from '../../views/AdvancedView';
import { AdvancedEditorPanel } from '../../views/AdvancedEditorPanel';
import { TrainingView } from '../../views/TrainingView';
import { LineageView } from '../library/LineageModal';
import { CenterTabBar } from './CenterTabBar';
import { useAppUiStore } from '../../state/appUiStore';
import { useBottomPanelStore, type BottomPanelTab } from '../../state/bottomPanelStore';

const TAB_DEFS: Array<{ id: BottomPanelTab; label: string; icon: React.ComponentType<{ className?: string }>; colorActive: string }> = [
  { id: 'spectral',   label: 'Real-time Spectral', icon: Activity,   colorActive: 'border-purple-500 text-purple-300' },
  { id: 'details',    label: 'Details',            icon: Info,       colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'piano-roll', label: 'Piano Roll',         icon: Piano,      colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'step-seq',   label: 'Step Sequencer',     icon: Layers,     colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'bucket',     label: 'Media Bucket',       icon: FolderOpen, colorActive: 'border-amber-500 text-amber-300' },
];

export const DAWCenterPanel: React.FC<{ onSwitchTab?: (tab: string) => void }> = ({ onSwitchTab }) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const centerTab = useAppUiStore((s) => s.centerTab);
  const setCenterTab = useAppUiStore((s) => s.setCenterTab);
  const isLeftPanelOpen = useAppUiStore((s) => s.isLeftPanelOpen);
  const setLeftPanelOpen = useAppUiStore((s) => s.setLeftPanelOpen);
  const isRightPanelOpen = useAppUiStore((s) => s.isRightPanelOpen);
  const setRightPanelOpen = useAppUiStore((s) => s.setRightPanelOpen);
  const [bottomHeight, setBottomHeight] = useState(260);
  const [isResizing, setIsResizing] = useState(false);
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen);
  const setBottomOpen = useBottomPanelStore((s) => s.setOpen);
  const activeTab = useBottomPanelStore((s) => s.activeTab);
  const setActiveTab = useBottomPanelStore((s) => s.setActiveTab);

  // The MAKE / MIX / LEARN tabs use full-bleed workspaces and don't
  // pair well with the bottom multi-tab panel (which is timeline-
  // adjacent: spectral, details, piano roll, step seq, media bucket).
  // Only EDIT keeps that bottom panel; TRAIN/MAKE/MIX/LEARN render
  // their content fullscreen inside the center.
  const showBottomPanel = centerTab === 'edit' && isBottomOpen;

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!isResizing) return;
      const containerRect = containerRef.current?.getBoundingClientRect();
      if (!containerRect) return;
      const pointerDistanceFromTop = e.clientY - containerRect.top;
      const maxBottomHeight = Math.max(100, containerRect.height - 140);
      const nextHeight = Math.round(containerRect.height - pointerDistanceFromTop);
      const newHeight = Math.max(60, Math.min(nextHeight, maxBottomHeight));
      setBottomHeight(newHeight);
      if (newHeight > 60) setBottomOpen(true);
    };

    const handleMouseUp = () => setIsResizing(false);

    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'row-resize';
    } else {
      document.body.style.cursor = 'default';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'default';
    };
  }, [isResizing, setBottomOpen]);

  return (
    <div ref={containerRef} className="flex-1 h-full flex flex-col pt-0 px-0 pb-0 gap-2 bg-[#0a080f]/40 relative z-0 min-h-0">

      {/* New center tab bar — replaces the old 3-button inner toolbar.
          Hosts the 5 workspace tabs (Train / Make / Edit / Mix / Learn)
          centered, plus the side-panel collapse arrows at the inner
          edges. Plan step 3a. */}
      <CenterTabBar
        activeTab={centerTab}
        onTabChange={setCenterTab}
        isLeftPanelOpen={isLeftPanelOpen}
        isRightPanelOpen={isRightPanelOpen}
        onToggleLeftPanel={() => setLeftPanelOpen(!isLeftPanelOpen)}
        onToggleRightPanel={() => setRightPanelOpen(!isRightPanelOpen)}
      />

      {/* Main workspace — fills below the tab bar. Edit keeps the
          waveform + bottom multi-tab panel; the other tabs render
          their workspace full-bleed. */}
      <div className="flex-1 min-h-0 hardware-card flex flex-col mx-2 pt-1">
        <div className="flex-1 min-h-0 relative">
          {centerTab === 'train' && (
            <div className="absolute inset-0 overflow-y-auto">
              <TrainingView />
            </div>
          )}
          {centerTab === 'make' && (
            <div className="absolute inset-0 overflow-hidden">
              <AdvancedView />
            </div>
          )}
          {centerTab === 'edit' && (
            <WaveformEditor onSwitchTab={onSwitchTab} />
          )}
          {centerTab === 'mix' && (
            <div className="absolute inset-0 overflow-y-auto">
              <AdvancedEditorPanel />
            </div>
          )}
          {centerTab === 'learn' && (
            <LineageView rootEntryId={null} />
          )}
        </div>
      </div>

      {/* Resize Handle — only relevant when the bottom panel is in use
          (Edit tab + bottom open). */}
      {showBottomPanel && (
        <div
          className="h-2 -my-2 flex items-center justify-center cursor-row-resize z-10 group relative mx-2"
          onMouseDown={() => setIsResizing(true)}
        >
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 group-hover:bg-purple-500/30 transition-colors" />
          <GripHorizontal className="w-4 h-4 text-zinc-600 group-hover:text-purple-400 absolute opacity-0 group-hover:opacity-100 transition-opacity bg-[#07050a] px-0.5 rounded" />
        </div>
      )}

      {/* "Open bottom panel" pill (Edit tab, panel collapsed) */}
      {centerTab === 'edit' && !isBottomOpen && (
        <button
          type="button"
          onClick={() => setBottomOpen(true)}
          className="hardware-card border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 flex items-center justify-center py-2 cursor-pointer transition-colors group/restore mx-2"
        >
           <ChevronUp className="w-4 h-4 text-purple-300 group-hover/restore:text-white transition-colors" />
        </button>
      )}

      {/* Bottom Panel — multi-tab (Edit only) */}
      {showBottomPanel && (
        <div
          className="shrink-0 mx-2"
          style={{ height: `${bottomHeight}px` }}
        >
          <div className="hardware-card border-purple-500/20 bg-purple-500/2 flex flex-col min-h-0 relative h-full p-0!">
             {/* Tabs row */}
             <div className="flex items-center justify-between border-b border-white/5 shrink-0 bg-black/30">
                <div className="flex">
                   {TAB_DEFS.map((t) => {
                     const Icon = t.icon;
                     const active = activeTab === t.id;
                     return (
                       <button
                         key={t.id}
                         onClick={() => setActiveTab(t.id)}
                         className={`px-3 py-1.5 flex items-center gap-1.5 border-b-2 text-[9px] uppercase tracking-widest font-black transition-colors ${active ? t.colorActive : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                         title={t.label}
                       >
                         <Icon className="w-3 h-3" /> {t.label}
                       </button>
                     );
                   })}
                </div>
                <div className="flex items-center gap-2 px-2">
                   <button onClick={() => setBottomOpen(false)} className="p-1 hover:bg-white/10 rounded" title="Collapse bottom panel">
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
        </div>
      )}
    </div>
  );
};
