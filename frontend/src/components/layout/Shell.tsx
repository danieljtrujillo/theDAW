import React, { useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Settings, ChevronRight, BookOpen } from 'lucide-react';
import { GenerateView } from '../../views/GenerateView';
import { StudioView } from '../../views/StudioView';
import { LibraryView } from '../../views/LibraryView';
import { TrainingView } from '../../views/TrainingView';
import { ResizablePanel } from './ResizablePanel';
import { DAWCenterPanel } from './DAWCenterPanel';
import { ProcessingLog } from './ProcessingLog';
import { GlobalGenerateBar } from './GlobalGenerateBar';
import { DocsModal } from './DocsModal';
import { useStatusBarStore } from '../../state/statusBarStore';
import { useAppUiStore } from '../../state/appUiStore';

export const Shell: React.FC = () => {
  const activeView = useAppUiStore((state) => state.activeView);
  const setActiveView = useAppUiStore((state) => state.setActiveView);
  const isLeftPanelOpen = useAppUiStore((state) => state.isLeftPanelOpen);
  const setIsLeftPanelOpen = useAppUiStore((state) => state.setLeftPanelOpen);
  const docsOpen = useAppUiStore((state) => state.docsOpen);
  const setDocsOpen = useAppUiStore((state) => state.setDocsOpen);
  const refreshHealth = useStatusBarStore((state) => state.refreshHealth);

  useEffect(() => {
    void refreshHealth();
    const timer = window.setInterval(() => {
      void refreshHealth();
    }, 30000);
    return () => window.clearInterval(timer);
  }, [refreshHealth]);

  useEffect(() => {
    const handler = (e: Event) => {
      const tab = (e as CustomEvent).detail?.tab;
      setActiveView(tab);
    };
    const openDocsHandler = () => setDocsOpen(true);
    const closeDocsHandler = () => setDocsOpen(false);
    const leftPanelHandler = (e: Event) => {
      const open = (e as CustomEvent).detail?.open;
      if (typeof open === 'boolean') setIsLeftPanelOpen(open);
    };
    window.addEventListener('stabledaw:navigate', handler);
    window.addEventListener('stabledaw:open-docs', openDocsHandler);
    window.addEventListener('stabledaw:close-docs', closeDocsHandler);
    window.addEventListener('stabledaw:set-left-panel', leftPanelHandler);
    return () => {
      window.removeEventListener('stabledaw:navigate', handler);
      window.removeEventListener('stabledaw:open-docs', openDocsHandler);
      window.removeEventListener('stabledaw:close-docs', closeDocsHandler);
      window.removeEventListener('stabledaw:set-left-panel', leftPanelHandler);
    };
  }, [setActiveView, setDocsOpen, setIsLeftPanelOpen]);

  const tabs = [
    { id: 'create', label: 'CREATE' },
    { id: 'edit', label: 'EDIT' },
    { id: 'train', label: 'TRAIN' },
    { id: 'library', label: 'LIBRARY' },
  ];

  return (
    <div
      className="flex flex-col w-full bg-[#07050a] text-[#f5f3ff] overflow-hidden font-sans dense-layout"
      style={{ height: 'calc((100vh - 5rem) / var(--layout-zoom))' }}
    >
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
            {/* Top utility row — keeps the collapse chevron without the logo block */}
            <div className="flex items-center justify-end mb-2">
              <button onClick={() => setIsLeftPanelOpen(false)} className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors" title="Collapse left panel">
                <ChevronRight className="w-4 h-4 rotate-180" />
              </button>
            </div>

            {/* Horizontal Tabs */}
            <div className="flex items-center gap-2 overflow-x-auto no-scrollbar mb-2 px-1">
              {tabs.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveView(tab.id)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded transition-all border whitespace-nowrap
                    ${activeView === tab.id ? 'bg-purple-600/20 border-purple-500/50 text-white' : 'border-white/5 text-zinc-500 hover:text-zinc-300'}`}
                >
                  <span className="text-[10px] font-black uppercase tracking-widest">{tab.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Render Active View */}
          <div className="flex-1 overflow-hidden relative min-h-0">
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

          {/* Pinned CREATE-tab CTA: output progress + RUN button. Hard structural
              attachment as flex sibling of ProcessingLog so it can't desync. */}
          {activeView === 'create' && <GlobalGenerateBar />}

          {/* Global Processing Log */}
          <ProcessingLog />
        </div>
      </ResizablePanel>

      {/* Main Canvas (DAW Center Panel) */}
      <main className="flex-1 h-full overflow-hidden flex flex-col relative bg-[#110e1a]/60">
        <header className="h-10 border-b border-white/5 flex items-center justify-between px-6 bg-[#0a080f]/80 backdrop-blur-md z-20 shrink-0 relative">
          
          {/* Centered App Name */}
          <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
            <span className="font-semibold text-[15px] font-sans text-zinc-100 tracking-wide">
              StableDAW
            </span>
          </div>

          <div className="flex items-center gap-6 relative z-10">
            <h2 className="text-[10px] font-black uppercase tracking-[0.4em] flex items-center gap-2.5">
              {!isLeftPanelOpen && (
                <button onClick={() => setIsLeftPanelOpen(true)} className="p-1 hover:bg-white/10 rounded mr-1 pointer-events-auto" title="Open left panel">
                   <ChevronRight className="w-4 h-4 text-zinc-500 hover:text-white transition-colors" />
                </button>
              )}
              <span className="w-1.5 h-1.5 rounded-full bg-purple-500 shadow-[0_0_8px_rgba(139,92,246,1)]" />
            </h2>
            <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-full border border-white/5">
               <Search className="w-3 h-3 text-zinc-600" />
               <input type="text" placeholder="G-SEARCH..." className="bg-transparent border-none outline-none text-[9px] text-zinc-500 w-32 font-mono" />
            </div>
          </div>

          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2.5">
               <button
                 onClick={() => setDocsOpen(true)}
                 className="p-1.5 rounded hover:bg-purple-500/15 transition-colors border border-purple-500/20 group flex items-center gap-1.5"
                 title="Open documentation"
               >
                  <BookOpen className="w-3.5 h-3.5 text-purple-300 group-hover:text-purple-200" />
                  <span className="text-[9px] font-black uppercase tracking-widest text-purple-300 group-hover:text-purple-200 pr-1">Docs</span>
               </button>
               <button className="p-1.5 rounded hover:bg-white/5 transition-colors border border-white/5 group">
                  <Settings className="w-3.5 h-3.5 text-zinc-500 group-hover:rotate-90 transition-transform duration-500" />
               </button>
               <div className="flex items-center gap-2.5 pl-2 border-l border-white/5">
                  <div className="w-7 h-7 rounded bg-linear-to-tr from-purple-500 to-indigo-600 border border-white/20 p-0.5 shadow-xl">
                     <div className="w-full h-full rounded bg-[#0a080f] flex items-center justify-center font-bold text-[10px]">U</div>
                  </div>
               </div>
            </div>
          </div>
        </header>

        <DAWCenterPanel onSwitchTab={(tab) => setActiveView(tab)} />
      </main>
      </div>
      <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
    </div>
  );
};


