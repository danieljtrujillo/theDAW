import React, { useEffect, useMemo } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Search, Settings, ChevronRight, BookOpen, Smartphone, X, Copy, ExternalLink } from 'lucide-react';
import { GenerateView } from '../../views/GenerateView';
import { StudioView } from '../../views/StudioView';
import { LibraryView } from '../../views/LibraryView';
import { TrainingView } from '../../views/TrainingView';
import { ResizablePanel } from './ResizablePanel';
import { DAWCenterPanel } from './DAWCenterPanel';
import { ProcessingLog } from './ProcessingLog';
import { DocsModal } from './DocsModal';
import { SettingsModal } from './SettingsModal';
import { useAppUiStore } from '../../state/appUiStore';

export const Shell: React.FC = () => {
  const activeView = useAppUiStore((state) => state.activeView);
  const setActiveView = useAppUiStore((state) => state.setActiveView);
  const isLeftPanelOpen = useAppUiStore((state) => state.isLeftPanelOpen);
  const setIsLeftPanelOpen = useAppUiStore((state) => state.setLeftPanelOpen);
  const docsOpen = useAppUiStore((state) => state.docsOpen);
  const setDocsOpen = useAppUiStore((state) => state.setDocsOpen);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [shareUrlOverride, setShareUrlOverride] = React.useState(() => {
    if (typeof window === 'undefined') return '';
    return window.localStorage.getItem('stabledaw.shareUrlOverride') ?? '';
  });
  const [copiedShareUrl, setCopiedShareUrl] = React.useState(false);

  const detectedShareUrl = typeof window === 'undefined' ? '' : window.location.origin;
  const shareUrl = shareUrlOverride.trim() || detectedShareUrl;
  const qrImageUrl = useMemo(
    () => `https://api.qrserver.com/v1/create-qr-code/?size=220x220&margin=12&data=${encodeURIComponent(shareUrl)}`,
    [shareUrl],
  );

  const updateShareUrlOverride = (value: string) => {
    setShareUrlOverride(value);
    if (typeof window === 'undefined') return;
    if (value.trim()) window.localStorage.setItem('stabledaw.shareUrlOverride', value);
    else window.localStorage.removeItem('stabledaw.shareUrlOverride');
  };

  const copyShareUrl = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedShareUrl(true);
      window.setTimeout(() => setCopiedShareUrl(false), 1400);
    } catch {
      setCopiedShareUrl(false);
    }
  };

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
    { id: 'edit', label: 'PROCESS' },
    { id: 'train', label: 'TRAIN' },
    { id: 'library', label: 'LIBRARY' },
  ];

  return (
    <div
      className="flex flex-col w-full bg-[#07050a] text-[#f5f3ff] overflow-hidden font-sans dense-layout"
      style={{ height: 'calc((100vh - 5rem) / var(--layout-zoom))' }}
    >
      {/* Full-width header — spans entire window including over the left panel */}
      <header className="h-10 border-b border-white/5 flex items-center justify-between px-6 bg-[#0a080f]/80 backdrop-blur-md z-10 shrink-0 relative">
        {/* Centered App Name */}
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 pointer-events-none">
          <span className="font-semibold text-[15px] font-sans text-zinc-100 tracking-wide">StableDAW</span>
        </div>
        <div className="flex items-center gap-6 relative z-10">
          <h2 className="text-[10px] font-black uppercase tracking-[0.4em] flex items-center gap-2.5">
            {isLeftPanelOpen ? (
              <button onClick={() => setIsLeftPanelOpen(false)} className="p-1 hover:bg-white/10 rounded mr-1 pointer-events-auto" title="Collapse left panel">
                <ChevronRight className="w-4 h-4 text-zinc-500 hover:text-white transition-colors rotate-180" />
              </button>
            ) : (
              <button onClick={() => setIsLeftPanelOpen(true)} className="p-1 hover:bg-white/10 rounded mr-1 pointer-events-auto" title="Open left panel">
                <ChevronRight className="w-4 h-4 text-zinc-500 hover:text-white transition-colors" />
              </button>
            )}
          </h2>
        </div>
        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-full border border-white/5">
            <Search className="w-3 h-3 text-zinc-600" />
            <input type="text" placeholder="G-SEARCH..." className="bg-transparent border-none outline-none text-[9px] text-zinc-500 w-32 font-mono" />
          </div>
          <button
            onClick={() => setDocsOpen(true)}
            className="p-1.5 rounded hover:bg-purple-500/15 transition-colors border border-purple-500/20 group flex items-center gap-1.5"
            title="Open documentation"
          >
            <BookOpen className="w-3.5 h-3.5 text-purple-300 group-hover:text-purple-200" />
            <span className="text-[9px] font-black uppercase tracking-widest text-purple-300 group-hover:text-purple-200 pr-1">Docs</span>
          </button>
          <button
            onClick={() => setShareOpen(true)}
            className="p-1.5 rounded hover:bg-emerald-500/15 transition-colors border border-emerald-500/20 group flex items-center gap-1.5"
            title="Open mobile access QR/link"
          >
            <Smartphone className="w-3.5 h-3.5 text-emerald-300 group-hover:text-emerald-200" />
            <span className="hidden md:inline text-[9px] font-black uppercase tracking-widest text-emerald-300 group-hover:text-emerald-200 pr-1">Mobile</span>
          </button>
          <button
            onClick={() => setSettingsOpen(true)}
            className="p-1.5 rounded hover:bg-white/5 transition-colors border border-white/5 group"
            title="Settings"
          >
            <Settings className="w-3.5 h-3.5 text-zinc-500 group-hover:rotate-90 transition-transform duration-500" />
          </button>
        </div>
      </header>

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
          
          {/* Tabs */}
          <div className="flex flex-col border-b border-white/5 pt-2 pb-0 px-3 bg-[#0a080f]">
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

          {/* Global Processing Log */}
          <ProcessingLog />
        </div>
      </ResizablePanel>

      {/* Main Canvas (DAW Center Panel) */}
      <main className="flex-1 h-full overflow-hidden flex flex-col relative bg-[#110e1a]/60">
        <DAWCenterPanel onSwitchTab={(tab) => setActiveView(tab)} />
      </main>
      </div>
      <DocsModal open={docsOpen} onClose={() => setDocsOpen(false)} />
      {shareOpen && (
        <div className="fixed inset-0 z-60 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/75 backdrop-blur-sm" onClick={() => setShareOpen(false)} />
          <div className="relative w-[min(420px,92vw)] bg-[#0c0a14] border border-emerald-500/30 rounded-lg shadow-2xl overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-linear-to-r from-emerald-900/25 to-purple-900/15">
              <div className="flex items-center gap-2">
                <Smartphone className="w-4 h-4 text-emerald-300" />
                <div className="flex flex-col leading-tight">
                  <span className="text-[11px] font-black uppercase tracking-widest text-emerald-200">Mobile Access</span>
                  <span className="text-[8px] font-mono uppercase tracking-wider text-emerald-300/60">QR + tunnel-friendly link</span>
                </div>
              </div>
              <button onClick={() => setShareOpen(false)} className="p-1 text-zinc-500 hover:text-white transition-colors rounded hover:bg-white/5" title="Close">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="p-4 flex flex-col gap-4">
              <div className="flex justify-center">
                <div className="p-3 rounded-lg bg-white shadow-[0_0_24px_rgba(16,185,129,0.16)]">
                  <img src={qrImageUrl} alt="StableDAW mobile access QR code" className="w-[220px] h-[220px]" />
                </div>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-black uppercase tracking-widest text-zinc-400">Share URL</label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={shareUrl}
                    readOnly
                    className="flex-1 bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 outline-none"
                  />
                  <button
                    onClick={() => void copyShareUrl()}
                    className="px-2 py-1.5 rounded border border-emerald-500/30 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-200 text-[9px] font-black uppercase tracking-widest flex items-center gap-1.5"
                    title="Copy share URL"
                  >
                    <Copy className="w-3 h-3" /> {copiedShareUrl ? 'Copied' : 'Copy'}
                  </button>
                </div>
                <a href={shareUrl} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 text-[9px] font-mono text-emerald-300/75 hover:text-emerald-200 transition-colors">
                  <ExternalLink className="w-2.5 h-2.5" /> Open link in new tab
                </a>
              </div>

              <div className="flex flex-col gap-1.5">
                <label className="text-[9px] font-black uppercase tracking-widest text-zinc-400">External URL override</label>
                <input
                  type="url"
                  value={shareUrlOverride}
                  onChange={(e) => updateShareUrlOverride(e.target.value)}
                  placeholder="Paste Cloudflare tunnel URL, e.g. https://name.trycloudflare.com"
                  className="bg-black/40 border border-white/10 rounded px-2 py-1.5 text-[10px] font-mono text-zinc-200 placeholder:text-zinc-600 outline-none focus:border-emerald-500/50 transition-colors"
                />
                <p className="text-[9px] leading-relaxed text-zinc-500">
                  By default this uses <span className="font-mono text-zinc-400">{detectedShareUrl}</span>. Paste a Cloudflare Tunnel or other public URL here when your phone is not on the same network.
                </p>
              </div>
            </div>
          </div>
        </div>
      )}
      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
};


