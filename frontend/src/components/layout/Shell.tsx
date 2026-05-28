import React, { useEffect, useMemo, useState } from 'react';
import { Search, Settings, ChevronRight, Library as LibraryIcon, BookOpen, Smartphone, X, Copy, ExternalLink } from 'lucide-react';
import { LibraryView } from '../../views/LibraryView';
import { DAWCenterPanel } from './DAWCenterPanel';
import { ProcessingLog } from './ProcessingLog';
import { DocsModal } from './DocsModal';
import { SettingsModal } from './SettingsModal';
import { useAppUiStore } from '../../state/appUiStore';
import { useLibraryStore } from '../../state/libraryStore';

const RIGHT_RAIL_MIN = 280;
const RIGHT_RAIL_MAX = 640;
/** Width the right rail collapses to when the user hides the Library.
 *  Big enough to fit the LOG / ACTION buttons in ProcessingLog without
 *  truncating; the 45° clip-path runs in the leftmost ~56px. */
const RIGHT_RAIL_COLLAPSED = 288;

export const Shell: React.FC = () => {
  const setActiveView = useAppUiStore((state) => state.setActiveView);
  const isRightPanelOpen = useAppUiStore((state) => state.isRightPanelOpen);
  const setIsRightPanelOpen = useAppUiStore((state) => state.setRightPanelOpen);
  const rightPanelWidth = useAppUiStore((state) => state.rightPanelWidth);
  const setRightPanelWidth = useAppUiStore((state) => state.setRightPanelWidth);
  const docsOpen = useAppUiStore((state) => state.docsOpen);
  const setDocsOpen = useAppUiStore((state) => state.setDocsOpen);
  const setLibrarySearch = useLibraryStore((s) => s.setSearchQuery);
  const librarySearch = useLibraryStore((s) => s.searchQuery);
  const globalSearchInputRef = React.useRef<HTMLInputElement | null>(null);

  // Cmd-K / Ctrl-K focuses the global search bar. Matches the keybinding
  // convention used by VS Code / Notion / Linear so users have one less
  // thing to learn.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        globalSearchInputRef.current?.focus();
        globalSearchInputRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
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
    window.addEventListener('stabledaw:navigate', handler);
    window.addEventListener('stabledaw:open-docs', openDocsHandler);
    window.addEventListener('stabledaw:close-docs', closeDocsHandler);
    return () => {
      window.removeEventListener('stabledaw:navigate', handler);
      window.removeEventListener('stabledaw:open-docs', openDocsHandler);
      window.removeEventListener('stabledaw:close-docs', closeDocsHandler);
    };
  }, [setActiveView, setDocsOpen]);

  // ── Right rail drag-resize. When the Library is open, dragging the
  // rail's left edge widens / narrows the rail. The collapsed-rail
  // state is fixed-width (RIGHT_RAIL_COLLAPSED) and not resizable.
  const [isResizingRail, setIsResizingRail] = useState(false);
  useEffect(() => {
    if (!isResizingRail) return;
    const onMove = (e: MouseEvent) => {
      const next = window.innerWidth - e.clientX;
      const clamped = Math.max(RIGHT_RAIL_MIN, Math.min(RIGHT_RAIL_MAX, next));
      setRightPanelWidth(clamped);
    };
    const onUp = () => setIsResizingRail(false);
    document.body.style.cursor = 'col-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [isResizingRail, setRightPanelWidth]);

  const railWidth = isRightPanelOpen ? rightPanelWidth : RIGHT_RAIL_COLLAPSED;

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
        {/* Left side of the header is intentionally empty now —
            the side-panel collapse arrows live in the CenterTabBar
            below (plan step 3a). The legacy chevron here was the only
            inhabitant; removing it tightens the header. */}
        <div className="flex items-center gap-6 relative z-10" />
        <div className="flex items-center gap-2.5">
          <div className="hidden sm:flex items-center gap-2 px-2.5 py-1 bg-white/5 rounded-full border border-white/5">
            <Search className="w-3 h-3 text-zinc-600" />
            <input
              id="global-search"
              name="global-search"
              ref={globalSearchInputRef}
              type="search"
              aria-label="Global library search (Ctrl-K / Cmd-K)"
              placeholder="G-SEARCH (ctrl-k)"
              className="bg-transparent border-none outline-none text-[9px] text-zinc-300 w-32 font-mono placeholder:text-zinc-500"
              value={librarySearch}
              onChange={(e) => {
                setLibrarySearch(e.target.value);
                // Typing into G-Search auto-opens the right-side
                // Library panel so the filtered list is visible.
                if (e.target.value && !isRightPanelOpen) setIsRightPanelOpen(true);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  setLibrarySearch('');
                  (e.target as HTMLInputElement).blur();
                }
              }}
            />
          </div>
          <TopBarButton
            onClick={() => setDocsOpen(true)}
            icon={<BookOpen className="w-3.5 h-3.5" />}
            label="Docs"
            title="Open documentation"
            accent="purple"
          />
          <TopBarButton
            onClick={() => setShareOpen(true)}
            icon={<Smartphone className="w-3.5 h-3.5" />}
            label="Mobile"
            hideLabelBelowMd
            title="Open mobile access QR/link"
            accent="emerald"
          />
          <TopBarButton
            onClick={() => setIsRightPanelOpen(!isRightPanelOpen)}
            icon={<LibraryIcon className="w-3.5 h-3.5" />}
            label="Library"
            hideLabelBelowMd
            title={isRightPanelOpen ? 'Hide library' : 'Show library'}
            accent="purple"
            active={isRightPanelOpen}
            trailing={<ChevronRight className="w-3 h-3" />}
          />
          <TopBarButton
            onClick={() => setSettingsOpen(true)}
            icon={<Settings className="w-3.5 h-3.5 group-hover:rotate-90 transition-transform duration-500" />}
            title="Settings"
            accent="neutral"
          />
        </div>
      </header>

      <div className="flex-1 flex min-h-0 overflow-hidden">
      {/* Main Canvas (DAW Center Panel) — no left panel; the user
          removed it per layout invariant. */}
      <main className="flex-1 h-full overflow-hidden flex flex-col relative bg-[#110e1a]/60">
        <DAWCenterPanel onSwitchTab={(tab) => setActiveView(tab)} />
      </main>

      {/* Right rail — single column on the right side of the app.
          Library section sits on top (collapsible via the CenterTabBar
          toggle). Log section is pinned to the bottom and stays
          visible even when the Library is collapsed. When collapsed
          the whole rail narrows to RIGHT_RAIL_COLLAPSED with a 45°
          beveled left edge so the strip reads as deliberate. */}
      <aside
        className="h-full min-h-0 shrink-0 flex flex-col bg-[#0a080f] border-l border-purple-500/20 shadow-[inset_1px_0_0_rgba(168,85,247,0.08)] z-20 relative"
        style={{
          width: railWidth,
          transition: isResizingRail ? 'none' : 'width 220ms cubic-bezier(.2,.7,.2,1)',
          clipPath: isRightPanelOpen
            ? undefined
            : 'polygon(56px 0, 100% 0, 100% 100%, 0 100%)',
        }}
      >
        {/* Resize handle — only when the Library is showing; the
            collapsed-rail width is fixed. */}
        {isRightPanelOpen && (
          <div
            className="absolute top-0 bottom-0 -left-1 w-2 cursor-col-resize z-30 group"
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizingRail(true);
            }}
          >
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-white/10 group-hover:bg-purple-500/50 rounded-full transition-colors" />
          </div>
        )}

        {/* Library section — collapsed when isRightPanelOpen is false. */}
        {isRightPanelOpen && (
          <>
            <div className="h-9 flex items-center justify-between border-b border-white/5 px-3 bg-[#0a080f] shrink-0">
              <div className="flex items-center gap-2">
                <LibraryIcon className="w-3 h-3 text-purple-400" />
                <span className="text-[10px] font-black uppercase tracking-widest text-purple-300">Library</span>
              </div>
              <button
                onClick={() => setIsRightPanelOpen(false)}
                className="p-1 hover:bg-white/10 rounded text-zinc-500 hover:text-white transition-colors"
                title="Collapse library"
              >
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden relative min-h-0">
              <LibraryView onSwitchTab={(tab: string) => setActiveView(tab)} />
            </div>
          </>
        )}

        {/* Log section — always visible. Sits at the bottom of the
            rail. ProcessingLog itself is shrink-0 with its own internal
            collapsible body, so this is just the dock. */}
        <div className="shrink-0">
          <ProcessingLog />
        </div>
      </aside>
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
                  <img src={qrImageUrl} alt="StableDAW mobile access QR code" className="w-55 h-55" />
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

/**
 * Shared top-bar button used by the header strip. Unifies the
 * typography + hover/active treatment across Docs / Mobile / Library /
 * Settings. Accent is one of the canonical hues; `active` flips on
 * the filled treatment for toggle-style buttons (Library). Icon-only
 * buttons (no label) get tighter padding.
 */
type TopBarAccent = 'purple' | 'emerald' | 'rose' | 'neutral';

interface TopBarButtonProps {
  onClick: () => void;
  icon: React.ReactNode;
  title: string;
  label?: string;
  /** Hide the label on viewports narrower than md (matches the
   *  existing Mobile / Library button behaviour). */
  hideLabelBelowMd?: boolean;
  accent?: TopBarAccent;
  active?: boolean;
  /** Trailing element (e.g. ChevronRight on Library). */
  trailing?: React.ReactNode;
}

const ACCENT_CLS: Record<TopBarAccent, { idle: string; idleText: string; active: string }> = {
  purple: {
    idle: 'border-purple-500/20 hover:bg-purple-500/15',
    idleText: 'text-purple-300 group-hover:text-purple-200',
    active: 'border-purple-500/40 bg-purple-500/15 text-purple-200',
  },
  emerald: {
    idle: 'border-emerald-500/20 hover:bg-emerald-500/15',
    idleText: 'text-emerald-300 group-hover:text-emerald-200',
    active: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-200',
  },
  rose: {
    idle: 'border-rose-500/20 hover:bg-rose-500/15',
    idleText: 'text-rose-300 group-hover:text-rose-200',
    active: 'border-rose-500/40 bg-rose-500/15 text-rose-200',
  },
  neutral: {
    idle: 'border-white/5 hover:bg-white/5',
    idleText: 'text-zinc-500 group-hover:text-zinc-200',
    active: 'border-white/20 bg-white/10 text-zinc-100',
  },
};

const TopBarButton: React.FC<TopBarButtonProps> = ({
  onClick,
  icon,
  title,
  label,
  hideLabelBelowMd = false,
  accent = 'neutral',
  active = false,
  trailing,
}) => {
  const cls = ACCENT_CLS[accent];
  const stateCls = active ? cls.active : `${cls.idle} ${cls.idleText}`;
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className={`p-1.5 rounded border transition-colors group flex items-center gap-1.5 ${stateCls}`}
    >
      {icon}
      {label && (
        <span
          className={`text-[9px] font-black uppercase tracking-widest pr-1 ${
            hideLabelBelowMd ? 'hidden md:inline' : ''
          }`}
        >
          {label}
        </span>
      )}
      {trailing}
    </button>
  );
};


