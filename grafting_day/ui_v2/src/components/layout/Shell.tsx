import React, { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Settings, Zap, ChevronRight } from 'lucide-react';
import { GenerateView } from '../../views/GenerateView';
import { StudioView } from '../../views/StudioView';
import { LibraryView } from '../../views/LibraryView';
import { TrainingView } from '../../views/TrainingView';
import { ResizablePanel } from './ResizablePanel';
import { DAWCenterPanel } from './DAWCenterPanel';
import { useStatusBarStore } from '../../state/statusBarStore';

export const Shell: React.FC = () => {
  const [activeView, setActiveView] = useState('create');
  const [isLeftPanelOpen, setIsLeftPanelOpen] = useState(true);
  const text = useStatusBarStore((state) => state.text);
  const healthy = useStatusBarStore((state) => state.healthy);
  const refreshHealth = useStatusBarStore((state) => state.refreshHealth);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => {
      void refreshHealth();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  const tabs = [
    { id: 'create', label: 'CREATE' },
    { id: 'edit', label: 'EDIT' },
    { id: 'train', label: 'TRAIN' },
    { id: 'library', label: 'LIBRARY' },
  ];

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] w-full bg-[#07050a] text-[#f5f3ff] overflow-hidden font-sans dense-layout">
      <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Left Panel */}
      <ResizablePanel
        position="left"
        isOpen={isLeftPanelOpen}
        onToggle={() => setIsLeftPanelOpen(false)}
        defaultWidth={400}
        minWidth={300}
        maxWidth={500}
      >
        <div className="h-full flex flex-col bg-[#07050a] relative">
          
          {/* Header & Tabs */}
          <div className="flex flex-col border-b border-white/5 pt-3 pb-0 px-3 bg-[#0a080f]">
            {/* Logo */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded bg-gradient-to-br from-purple-600 to-indigo-600 flex items-center justify-center shadow-[0_0_10px_rgba(139,92,246,0.5)]">
                  <Zap className="w-4 h-4 text-white fill-current" />
                </div>
                <div className="flex flex-col">
                  <span className="font-black text-[14px] tracking-widest uppercase italic leading-none text-white shadow-purple-500/50">STABLEDAW</span>
                  <span className="text-[8px] font-mono text-purple-500/80 tracking-tighter uppercase mt-0.5">V3.2 Engine</span>
                </div>
              </div>
              <button onClick={() => setIsLeftPanelOpen(false)} className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors">
                <ChevronRight className="w-4 h-4 rotate-180" />
              </button>
            </div>

            {/* Horizontal Tabs */}
            <div className="flex items-center gap-3 sm:gap-5 overflow-x-auto no-scrollbar">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveView(tab.id)}
                  className={`pb-1.5 border-b-2 font-black text-[14px] sm:text-[18px] tracking-widest uppercase transition-colors whitespace-nowrap
                    ${activeView === tab.id ? 'border-white text-white' : 'border-transparent text-zinc-600 hover:text-zinc-400'}`}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          </div>

          {/* Render Active View */}
          <div className="flex-1 overflow-hidden relative">
             <AnimatePresence mode="wait">
               <motion.div
                 key={activeView}
                 initial={{ opacity: 0, x: 10 }}
                 animate={{ opacity: 1, x: 0 }}
                 exit={{ opacity: 0, x: -10 }}
                 transition={{ duration: 0.15 }}
                 className="h-full absolute inset-0 overflow-y-auto overflow-x-hidden"
               >
                 {activeView === 'create' && <GenerateView />}
                 {activeView === 'edit' && <StudioView />}
                 {activeView === 'train' && <TrainingView />}
                 {activeView === 'library' && <LibraryView onSwitchTab={(tab: string) => setActiveView(tab)} />}
               </motion.div>
             </AnimatePresence>
          </div>
        </div>
      </ResizablePanel>

      {/* Main Canvas (DAW Center Panel) */}
      <main className="flex-1 h-full overflow-hidden flex flex-col relative bg-[#110e1a]/60">
        <header className="h-10 border-b border-white/5 flex items-center justify-between px-6 bg-[#0a080f]/80 backdrop-blur-md z-20 flex-shrink-0">
          <div className="flex items-center gap-6">
            <h2 className="text-[10px] font-black uppercase tracking-[0.4em] flex items-center gap-2.5">
              {!isLeftPanelOpen && (
                <button onClick={() => setIsLeftPanelOpen(true)} className="p-1 hover:bg-white/10 rounded mr-1">
                   <ChevronRight className="w-4 h-4 text-zinc-500 hover:text-white transition-colors" />
                </button>
              )}
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(139,92,246,1)]" />
              DAW Workspace
            </h2>
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-full border border-white/5">
               <Search className="w-3 h-3 text-zinc-600" />
               <input type="text" placeholder="G-SEARCH..." className="bg-transparent border-none outline-none text-[9px] text-zinc-500 w-32 font-mono" />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-5 mr-2">
               <div className="flex flex-col items-end">
                  <span className="text-[8px] font-mono text-zinc-600 uppercase">Latency</span>
                  <span className="text-[9px] font-mono text-green-500 tracking-tighter">12ms // 48k</span>
               </div>
               <div className="flex flex-col items-end">
                  <span className="text-[8px] font-mono text-zinc-600 uppercase">Buffer</span>
                  <span className="text-[9px] font-mono text-purple-400 tracking-tighter">98% OPT</span>
               </div>
            </div>
            
            <div className="h-5 w-px bg-white/10" />
            
            <div className="flex items-center gap-2.5">
               <button className="p-1.5 rounded hover:bg-white/5 transition-colors border border-white/5 group">
                  <Settings className="w-3.5 h-3.5 text-zinc-500 group-hover:rotate-90 transition-transform duration-500" />
               </button>
               <div className="flex items-center gap-2.5 pl-2 border-l border-white/5">
                  <div className="w-7 h-7 rounded bg-gradient-to-tr from-purple-500 to-indigo-600 border border-white/20 p-0.5 shadow-xl">
                     <div className="w-full h-full rounded bg-[#0a080f] flex items-center justify-center font-bold text-[10px]">U</div>
                  </div>
               </div>
            </div>
          </div>
        </header>

        <DAWCenterPanel />
      </main>
      </div>

      <div className="h-4 bg-[#0a080f] border-t border-white/5 flex items-center justify-between px-3 z-40 flex-shrink-0">
         <div className="flex items-center gap-3">
            <span className="text-[8px] font-mono text-zinc-600 flex items-center gap-1.5 uppercase">
            <div className={`w-1 h-1 rounded-full ${healthy === false ? 'bg-red-500' : 'bg-green-500'} animate-pulse`} /> {healthy === false ? 'Signal Degraded' : 'Signal Active'}
            </span>
            <span className="text-[8px] font-mono text-zinc-700">|</span>
          <span className="text-[8px] font-mono text-zinc-600 uppercase">{text}</span>
         </div>
         <div className="flex items-center gap-3">
            <span className="text-[8px] font-mono text-purple-500/80 uppercase">Stable Audio v3.0 RF</span>
            <span className="text-[8px] font-mono text-zinc-600">ID: 0x4F...7D</span>
         </div>
      </div>
    </div>
  );
};


