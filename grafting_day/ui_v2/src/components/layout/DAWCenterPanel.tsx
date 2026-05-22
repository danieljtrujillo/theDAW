import React, { useState, useRef, useEffect } from 'react';
import { WaveformEditor } from '../audio/WaveformEditor';
import { StepSequencer } from '../audio/StepSequencer';
import { AdvancedVisualizer } from '../audio/AdvancedVisualizer';
import { 
  Scissors, Layers, Settings, ChevronRight, Eye, Activity, Terminal, GripHorizontal, ChevronDown, ChevronUp, Waves
} from 'lucide-react';

export const DAWCenterPanel: React.FC = () => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [workspaceMode, setWorkspaceMode] = useState<'editor' | 'sequencer'>('editor');
  const [bottomHeight, setBottomHeight] = useState(160);
  const [isResizing, setIsResizing] = useState(false);
  const [isBottomOpen, setIsBottomOpen] = useState(true);
  const [visualizerTab, setVisualizerTab] = useState<'spectral' | 'scope'>('spectral');

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
      if (newHeight > 60) setIsBottomOpen(true);
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
  }, [isResizing]);

  return (
    <div ref={containerRef} className="flex-1 h-full flex flex-col p-2 gap-2 bg-[#0a080f]/40 relative z-0 min-h-0">
      
      {/* Main Timeline Section (Now at Top) */}
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
           
           <div className="flex-1" />
           
           <div className="flex items-center gap-3">
              <div className="flex items-center gap-1.5">
                 <span className="text-[8px] font-mono text-zinc-600">SNAP</span>
                 <div className="w-8 h-4 bg-purple-500/10 rounded-full border border-purple-500/30 flex items-center px-0.5 cursor-pointer">
                    <div className="w-3 h-3 bg-purple-500 rounded-full ml-auto" />
                 </div>
              </div>
              <button className="p-1 px-1.5 bg-white/5 rounded border border-white/5 hover:bg-white/10 transition-colors">
                 <Settings className="w-3.5 h-3.5 text-zinc-500" />
              </button>
           </div>
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

      {/* Collapsible Header for Bottom Section (If Collapsed) */}
      {!isBottomOpen && (
        <div className="hardware-card border-white/10 bg-black/40 flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-white/5" onClick={() => setIsBottomOpen(true)}>
           <div className="flex items-center gap-2">
              <Activity className="w-3.5 h-3.5 text-purple-400" />
              <span className="text-[10px] font-black uppercase tracking-widest text-zinc-300">Analysis & Logs</span>
           </div>
           <ChevronUp className="w-4 h-4 text-zinc-500" />
        </div>
      )}

      {/* Bottom Section: Visualizers and Logs */}
      {isBottomOpen && (
        <div 
          className="grid grid-cols-12 gap-2 flex-shrink-0"
          style={{ height: `${bottomHeight}px` }}
        >
          <div className="col-span-12 lg:col-span-8 hardware-card border-purple-500/20 bg-purple-500/[0.02] flex flex-col min-h-0 relative">
             <div className="flex items-center justify-between border-b border-white/5 flex-shrink-0 bg-black/20">
                <div className="flex">
                   <button 
                     onClick={() => setVisualizerTab('spectral')}
                     className={`px-3 py-1.5 flex items-center gap-1.5 border-b-2 text-[9px] uppercase tracking-widest font-black transition-colors ${visualizerTab === 'spectral' ? 'border-purple-500 text-purple-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                   >
                     <Activity className="w-3 h-3" /> Real-time Spectral
                   </button>
                   <button 
                     onClick={() => setVisualizerTab('scope')}
                     className={`px-3 py-1.5 flex items-center gap-1.5 border-b-2 text-[9px] uppercase tracking-widest font-black transition-colors ${visualizerTab === 'scope' ? 'border-blue-500 text-blue-400' : 'border-transparent text-zinc-500 hover:text-zinc-300'}`}
                   >
                     <Waves className="w-3 h-3" /> Signal Scope
                   </button>
                </div>
                <div className="flex items-center gap-2 px-2">
                   <button onClick={() => setIsBottomOpen(false)} className="p-1 hover:bg-white/10 rounded">
                      <ChevronDown className="w-3.5 h-3.5 text-zinc-500" />
                   </button>
                </div>
             </div>
             <div className="flex-1 min-h-0 relative p-1">
                {visualizerTab === 'spectral' ? (
                   <AdvancedVisualizer />
                ) : (
                   <div className="h-full w-full rounded border border-white/5 bg-[#0a080f] flex items-center justify-center text-zinc-600 font-mono text-[10px] uppercase">
                      [ Signal Scope View Active ]
                   </div>
                )}
             </div>
          </div>

          <div className="col-span-12 lg:col-span-4 hardware-card border-zinc-500/20 flex flex-col min-h-0">
             <div className="flex items-center justify-between mb-1 px-1 flex-shrink-0 pt-1">
                <div className="flex items-center gap-1.5"><Terminal className="w-3 h-3 text-zinc-500" /><span className="mono-label">Processing Log</span></div>
                <span className="text-[8px] mono-tag">Ready</span>
             </div>
             <div className="flex-1 bg-black/40 rounded border border-white/5 p-2 font-mono text-[9px] text-zinc-500 overflow-y-auto mb-1 mx-1">
                <p className="border-l-2 border-purple-500 pl-2 mb-1 text-zinc-300 uppercase tracking-tighter">Engine init: successful [0x4F]</p>
                <p className="pl-2.5 opacity-60">Wait for signal input...</p>
                <p className="pl-2.5 space-y-1">
                   <span className="block text-purple-400">Loading module: Elastique Pro v3</span>
                   <span className="block text-emerald-400">Loading module: Convolution Reverb</span>
                </p>
                <p className="pl-2.5 opacity-60 mt-1">Ready for chopping / sequencing</p>
             </div>
          </div>
        </div>
      )}
    </div>
  );
};
