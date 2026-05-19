import React, { useState, useRef, useEffect } from 'react';
import { WaveformEditor } from '../audio/WaveformEditor';
import { StepSequencer } from '../audio/StepSequencer';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { PianoRoll } from '../audio/PianoRoll';
import { DetailsView } from './DetailsView';
import { MediaBucketView } from './MediaBucketView';
import {
  Scissors, Layers, Activity, GripHorizontal, ChevronDown, ChevronUp,
  Info, Piano, FolderOpen,
} from 'lucide-react';
import { useBottomPanelStore, type BottomPanelTab } from '../../state/bottomPanelStore';

const TAB_DEFS: Array<{ id: BottomPanelTab; label: string; icon: React.ComponentType<{ className?: string }>; colorActive: string }> = [
  { id: 'spectral',   label: 'Real-time Spectral', icon: Activity,   colorActive: 'border-purple-500 text-purple-300' },
  { id: 'details',    label: 'Details',            icon: Info,       colorActive: 'border-emerald-500 text-emerald-300' },
  { id: 'piano-roll', label: 'Piano Roll',         icon: Piano,      colorActive: 'border-cyan-500 text-cyan-300' },
  { id: 'bucket',     label: 'Media Bucket',       icon: FolderOpen, colorActive: 'border-amber-500 text-amber-300' },
];

export const DAWCenterPanel: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'editor' | 'sequencer'>('editor');
  const [bottomHeight, setBottomHeight] = useState(260);
  const [isResizing, setIsResizing] = useState(false);
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen);
  const setBottomOpen = useBottomPanelStore((s) => s.setOpen);
  const activeTab = useBottomPanelStore((s) => s.activeTab);
  const setActiveTab = useBottomPanelStore((s) => s.setActiveTab);

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
    <div ref={containerRef} className="flex-1 h-full flex flex-col pt-2 px-2 pb-0 gap-2 bg-[#0a080f]/40 relative z-0 min-h-0">

      {/* Main Timeline Section */}
      <div className="flex-1 min-h-0 hardware-card flex flex-col pt-1">

        {/* Toolbar */}
        <div className="flex items-center gap-2 mb-1 px-2 border-b border-white/5 pb-1 flex-shrink-0">
           <button
             onClick={() => setWorkspaceMode('editor')}
             className={`flex items-center gap-2 px-3 py-1.5 rounded transition-all border
               ${workspaceMode === 'editor' ? 'bg-purple-600/20 border-purple-500/50 text-white' : 'border-white/5 text-zinc-500 hover:text-zinc-300'}`}
           >
              <Scissors className="w-3.5 h-3.5" />
              <span className="text-[10px] font-black uppercase tracking-widest">Waveform Editor</span>
           </button>
           <button
             onClick={() => setWorkspaceMode('sequencer')}
             className={`flex items-center gap-2 px-3 py-1.5 rounded transition-all border
               ${workspaceMode === 'sequencer' ? 'bg-cyan-600/20 border-cyan-500/50 text-white' : 'border-white/5 text-zinc-500 hover:text-zinc-300'}`}
           >
              <Layers className="w-3.5 h-3.5" />
              <span className="text-[10px] font-black uppercase tracking-widest">Step Sequencer</span>
           </button>
        </div>

        {/* Timeline body */}
        <div className="flex-1 min-h-0 relative">
           {workspaceMode === 'editor' ? <WaveformEditor /> : <StepSequencer />}
        </div>
      </div>

      {/* Resize Handle */}
      {isBottomOpen && (
        <div
          className="h-2 -my-2 flex items-center justify-center cursor-row-resize z-10 group relative"
          onMouseDown={() => setIsResizing(true)}
        >
          <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-1 group-hover:bg-purple-500/30 transition-colors" />
          <GripHorizontal className="w-4 h-4 text-zinc-600 group-hover:text-purple-400 absolute opacity-0 group-hover:opacity-100 transition-opacity bg-[#07050a] px-0.5 rounded" />
        </div>
      )}

      {/* Collapsible Header (When Collapsed) */}
      {!isBottomOpen && (
        <button
          type="button"
          onClick={() => setBottomOpen(true)}
          className="hardware-card border-purple-500/40 bg-purple-500/10 hover:bg-purple-500/20 flex items-center justify-between px-3 py-2 cursor-pointer transition-colors group/restore"
        >
           <div className="flex items-center gap-2">
              <Activity className="w-4 h-4 text-purple-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-purple-200">Expand Bottom Panel</span>
           </div>
           <div className="flex items-center gap-1.5 text-purple-300 group-hover/restore:text-white transition-colors">
              <span className="text-[9px] font-mono uppercase tracking-widest">Show</span>
              <ChevronUp className="w-4 h-4" />
           </div>
        </button>
      )}

      {/* Bottom Panel — multi-tab */}
      {isBottomOpen && (
        <div
          className="flex-shrink-0"
          style={{ height: `${bottomHeight}px` }}
        >
          <div className="hardware-card border-purple-500/20 bg-purple-500/[0.02] flex flex-col min-h-0 relative h-full !p-0">
             {/* Tabs row */}
             <div className="flex items-center justify-between border-b border-white/5 flex-shrink-0 bg-black/30">
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
