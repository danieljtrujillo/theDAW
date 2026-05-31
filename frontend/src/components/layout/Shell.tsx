import React, { useEffect, useMemo, useState } from 'react';
import { Search, Settings, BookOpen, Smartphone, X, Copy, ExternalLink, ChevronUp, ChevronDown, Terminal } from 'lucide-react';
import { LibraryView } from '../../views/LibraryView';
import { DAWCenterPanel } from './DAWCenterPanel';
import { LogBody, LogActionButton, LogStripCompactInfo } from './ProcessingLog';
import { BottomMultiTabPanel } from './BottomMultiTabPanel';
import { DocsModal } from './DocsModal';
import { SettingsModal } from './SettingsModal';
import { useAppUiStore } from '../../state/appUiStore';
import { useLibraryStore } from '../../state/libraryStore';
import { useLogStore } from '../../state/logStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';
import { GripHorizontal } from 'lucide-react';

const RIGHT_RAIL_MIN = 280;
const RIGHT_RAIL_MAX = 640;

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

  // LAN-reachable URL for this app (host:frontend-port), auto-detected
  // from the backend so the QR points phones at a real address instead
  // of localhost. Falls back to window.location.origin when there's no
  // LAN IP (e.g. offline). Mirrors how the VJ tab builds its mobile QR.
  const [lanUrl, setLanUrl] = React.useState('');
  React.useEffect(() => {
    let cancelled = false;
    void fetch('/api/vj/lan-ip')
      .then((r) => (r.ok ? r.json() : null))
      .then((j: { lan_ip?: string | null } | null) => {
        if (cancelled || !j?.lan_ip || typeof window === 'undefined') return;
        const port = window.location.port || '5173';
        setLanUrl(`http://${j.lan_ip}:${port}`);
      })
      .catch(() => {
        /* no backend / no LAN — keep the origin fallback */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const detectedShareUrl =
    lanUrl || (typeof window === 'undefined' ? '' : window.location.origin);
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

  return (
    <div
      className="flex flex-col w-full bg-[#07050a] text-[#f5f3ff] overflow-hidden font-sans dense-layout"
      style={{ height: 'calc((100vh - 5rem) / var(--layout-zoom))' }}
    >
      {/* Full-width header — spans entire window including over the left panel */}
      <header className="h-10 border-b border-white/5 flex items-center justify-between px-3 bg-[#0a080f]/80 backdrop-blur-md z-10 shrink-0 relative">
        {/* Logo block — user moved "theDAW" branding out of the
            header center into this two-line logo at the left edge.
            Matches the SUBSTRATA / BY GANTASMO reference screenshot:
            an isometric stacked-cube icon + a chunky title + a
            mono-style "by GANTASMO" subtitle. */}
        <div className="flex items-center gap-2 relative z-10 select-none">
          <BrandLogo />
          <div className="flex flex-col leading-none">
            <span className="text-[13px] font-black tracking-[0.18em] text-zinc-100">theDAW</span>
            <span className="text-[8px] font-mono uppercase tracking-[0.3em] text-zinc-500">by GANTASMO</span>
          </div>
        </div>
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
          {/* Library toggle removed from the header — the only library
              show/hide handle now lives at the right edge of the
              CenterTabBar (the PanelRightOpen/Close arrow), matching
              the user's "one handle, one place" preference. */}
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

      {/* Library rail — ONLY mounts when isRightPanelOpen. The
          ProcessingLog is NOT inside this rail (it's the global
          bottom strip below) — user explicitly flagged that the log
          must stay anchored regardless of library state. */}
      {isRightPanelOpen && (
        <aside
          className="h-full min-h-0 shrink-0 flex flex-col bg-[#0a080f] border-l border-purple-500/20 shadow-[inset_1px_0_0_rgba(168,85,247,0.08)] z-20 relative"
          style={{
            width: rightPanelWidth,
            transition: isResizingRail ? 'none' : 'width 220ms cubic-bezier(.2,.7,.2,1)',
          }}
        >
          {/* Resize handle at the left edge of the rail. */}
          <div
            className="absolute top-0 bottom-0 -left-1 w-2 cursor-col-resize z-30 group"
            onMouseDown={(e) => {
              e.preventDefault();
              setIsResizingRail(true);
            }}
          >
            <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-0.5 h-8 bg-white/10 group-hover:bg-purple-500/50 rounded-full transition-colors" />
          </div>

          <div className="flex-1 overflow-hidden relative min-h-0">
            <LibraryView onSwitchTab={(tab: string) => setActiveView(tab)} />
          </div>
        </aside>
      )}
      </div>

      {/* Global bottom dock — BottomMultiTabPanel (left, flex-1) and
          ProcessingLog (right, width = rightPanelWidth) live
          side-by-side at the bottom of the app. INDEPENDENT of the
          library panel state. Each column has its OWN height +
          collapse toggle + resize handle (multiHeight / logHeight in
          bottomPanelStore) — expanding or resizing one does NOT
          affect the other. */}
      <ShellBottomDock />
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
                  <img src={qrImageUrl} alt="theDAW mobile access QR code" className="w-55 h-55" />
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
 * Global bottom dock.
 *
 * Layout (always one horizontal strip at the bottom):
 *
 *   ┌─────────── canvas / main ────────────┬── library rail ──┐
 *   │                                       │                 │
 *   │  (multi body if isBottomOpen)         │  (log body if   │
 *   │                                       │   isLogOpen)    │
 *   ├───────────────────────────────────────┼─────────┬───────┤
 *   │   ^   multi toggle  (flex-1)          │ ^ LOG[N]│ CREATE│  <- the strip
 *   └───────────────────────────────────────┴─────────┴───────┘
 *                                            ←── rightPanelWidth ──→
 *                                            ← 40% ─→← 60% ──────→
 *
 * - Multi-tab body and LOG body each have their OWN height
 *   (multiHeight / logHeight) and their OWN resize handle. Toggling
 *   or resizing one never affects the other.
 * - The strip is fixed-height and always visible. The `^` collapses
 *   the multi-tab body without touching the LOG, and the LOG's `^`
 *   (on the LEFT of the LOG header per user spec) collapses the LOG
 *   body without touching the multi-tab.
 * - The CREATE / PROCESS / TRAIN action button stays pinned in the
 *   right 60% of the LOG strip section so the user's most-used
 *   affordance never moves.
 */
const STRIP_HEIGHT = 36;
const DOCK_MIN_HEIGHT = 60;
const DOCK_MAX_FRACTION = 0.85;
const LOG_HEADER_FRACTION = '40%';
const CREATE_FRACTION = '60%';

const ShellBottomDock: React.FC = () => {
  const multiHeight = useBottomPanelStore((s) => s.multiHeight);
  const setMultiHeight = useBottomPanelStore((s) => s.setMultiHeight);
  const logHeight = useBottomPanelStore((s) => s.logHeight);
  const setLogHeight = useBottomPanelStore((s) => s.setLogHeight);
  const rightPanelWidth = useAppUiStore((s) => s.rightPanelWidth);
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen);
  const setBottomOpen = useBottomPanelStore((s) => s.setOpen);
  const isLogOpen = useBottomPanelStore((s) => s.isLogOpen);
  const setLogOpen = useBottomPanelStore((s) => s.setLogOpen);
  const multiMaximized = useBottomPanelStore((s) => s.multiMaximized);
  const logEntryCount = useLogStore((s) => s.entries.length);

  const showBodyRow = isBottomOpen || isLogOpen;
  // The STRIP row always shows both toggle affordances side-by-side, so
  // it keeps the canonical two-column split (flex multi toggle on the
  // left, rightPanelWidth LOG strip on the right).
  const stripGridStyle = { gridTemplateColumns: `minmax(0, 1fr) ${rightPanelWidth}px` };
  // The BODY row keeps the left (multi) column flexible at all times and
  // only collapses the right (LOG) column when the log is closed. This
  // keeps the LOG body pinned to the right edge — column-aligned with the
  // LOG section of the always-visible strip below — instead of drifting
  // to the left when the multi panel is collapsed:
  //   - only LOG open   → left column flexes as an empty spacer (multi
  //     body height 0), LOG pinned right at rightPanelWidth.
  //   - only multi open → right (LOG) column 0px, multi spans full width.
  //   - both open       → flex multi + rightPanelWidth LOG.
  // Without the always-flex left column, `0px <rightPanelWidth>` would
  // left-align the LOG body and break alignment with the strip, which is
  // the horizontal-stretch/misalignment bug this dock previously had.
  const bodyGridStyle = {
    gridTemplateColumns: `minmax(0, 1fr) ${isLogOpen ? `${rightPanelWidth}px` : '0px'}`,
  };



  return (
    <div className="shrink-0 flex flex-col z-30 pointer-events-none">
      {/* Body row — only mounted when at least one panel is open. */}
      {showBodyRow && (
        <div className="shrink-0 grid items-end pointer-events-auto" style={bodyGridStyle}>

          {/* Multi body — flex-1, height = multiHeight. */}
          <div
            className={`min-w-0 relative bg-[#0a080f] overflow-hidden shadow-[0_-1px_0_rgba(168,85,247,0.08)] ${isLogOpen && !multiMaximized ? 'border-r border-purple-500/15' : ''}`}
            // Maximized: the multi body fills the work area (tall height pushes
            // the flex-1 canvas above it to ~0). Restore returns to multiHeight.
            style={{ height: isBottomOpen ? (multiMaximized ? 'calc(100vh - 7rem)' : `${multiHeight}px`) : 0 }}
          >
            {isBottomOpen && (
              <>
                <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
                {/* No manual resize handle while maximized. */}
                {!multiMaximized && (
                  <ColumnResizeHandle
                    currentHeight={multiHeight}
                    onSet={setMultiHeight}
                    title="Drag to resize the bottom multi-tab panel"
                  />
                )}
                <BottomMultiTabPanel />
              </>
            )}
          </div>
          {/* LOG body — width = rightPanelWidth, height = logHeight. */}
          <div
            className="min-w-0 relative bg-[#0a080f] overflow-hidden shadow-[0_-1px_0_rgba(168,85,247,0.08)]"
            style={{ height: isLogOpen ? `${logHeight}px` : 0 }}
          >
            {isLogOpen && (
              <>
                <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
                <ColumnResizeHandle
                  currentHeight={logHeight}
                  onSet={setLogHeight}
                  title="Drag to resize the log panel"
                />
                <LogBody />
              </>
            )}
          </div>
        </div>
      )}

      {/* Single horizontal strip — always visible. */}
      <div className="shrink-0 grid items-stretch pointer-events-auto" style={{ ...stripGridStyle, height: STRIP_HEIGHT }}>

        {/* Multi-tab toggle — left, flex-1 */}
        <button
          type="button"
          onClick={() => setBottomOpen(!isBottomOpen)}
          className="min-w-0 bg-[#0a080f] flex items-center justify-center gap-2 group hover:bg-purple-500/8 transition-colors border-t border-r border-purple-500/15 shadow-[0_-1px_0_rgba(168,85,247,0.08)]"
          title={isBottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
          aria-label={isBottomOpen ? 'Collapse bottom panel' : 'Expand bottom panel'}
        >
          {isBottomOpen
            ? <ChevronDown className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors" />
            : <ChevronUp className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors" />
          }
        </button>

        {/* LOG strip section — right, width = rightPanelWidth.
            Internally: 40% LOG header (chevron-LEFT + label + count)
            | 60% CREATE action button. */}
        <div className="min-w-0 bg-[#0a080f] flex items-stretch border-t border-purple-500/15 shadow-[0_-1px_0_rgba(168,85,247,0.08)]">
          {/* LOG header — 40%. Chevron on the LEFT per user spec. */}
          <button
            type="button"
            onClick={() => setLogOpen(!isLogOpen)}
            className="flex items-center gap-1.5 px-2 group hover:bg-purple-500/8 transition-colors border-r border-purple-500/15 min-w-0"
            style={{ width: LOG_HEADER_FRACTION }}
            title={isLogOpen ? 'Collapse log' : 'Expand log'}
            aria-label={isLogOpen ? 'Collapse log' : 'Expand log'}
          >
            {isLogOpen
              ? <ChevronDown className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
              : <ChevronUp className="w-3.5 h-3.5 text-purple-300 group-hover:text-white transition-colors shrink-0" />
            }
            <Terminal className="w-3.5 h-3.5 text-purple-400 shrink-0" />
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-200">LOG</span>
            <span className="text-[9px] font-mono text-zinc-600 shrink-0">[{logEntryCount}]</span>
            {!isLogOpen && (
              <span className="flex items-center gap-1.5 min-w-0">
                <LogStripCompactInfo />
              </span>
            )}
          </button>
          {/* CREATE — 60%. */}
          <div className="flex items-stretch" style={{ width: CREATE_FRACTION }}>
            <LogActionButton />
          </div>
        </div>
      </div>
    </div>
  );
};

/**
 * Per-column resize handle. Lives at the TOP edge of the column it
 * controls. Dragging up grows that column only; the other column is
 * untouched. Clamped to [DOCK_MIN_HEIGHT, viewport * DOCK_MAX_FRACTION].
 */
interface ColumnResizeHandleProps {
  currentHeight: number;
  onSet: (h: number) => void;
  title: string;
}
const ColumnResizeHandle: React.FC<ColumnResizeHandleProps> = ({ currentHeight, onSet, title }) => {
  const [dragging, setDragging] = useState(false);
  const startY = React.useRef(0);
  const startH = React.useRef(currentHeight);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dy = startY.current - e.clientY; // up = positive
      const max = Math.floor(window.innerHeight * DOCK_MAX_FRACTION);
      const clamped = Math.max(DOCK_MIN_HEIGHT, Math.min(max, startH.current + dy));
      onSet(clamped);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = 'row-resize';
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      document.body.style.cursor = 'default';
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragging, onSet]);

  return (
    <>
      {/* While dragging, a full-window overlay sits ABOVE the center iframe
          (VJ) so the iframe can't swallow mousemove/mouseup — that swallow was
          what left the resize "stuck" as if the mouse never released. */}
      {dragging && <div className="fixed inset-0 z-50 cursor-row-resize" />}
      <div
        className="absolute inset-x-0 top-0 h-1.5 -mt-0.5 cursor-row-resize flex items-center justify-center group z-40"
        onMouseDown={(e) => {
          e.preventDefault();
          startY.current = e.clientY;
          startH.current = currentHeight;
          setDragging(true);
        }}
        title={title}
      >
        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2 h-0.5 group-hover:bg-purple-500/40 transition-colors" />
        <GripHorizontal className="w-3.5 h-3.5 text-zinc-700 group-hover:text-purple-300 opacity-0 group-hover:opacity-100 transition-opacity" />
      </div>
    </>
  );
};

/**
 * Brand logo — references the SAME SVG that index.html wires up as
 * the browser-tab favicon (frontend/public/favicon.svg). Browser
 * caches it after the first paint so the header logo, the tab icon,
 * and any other site reference all stay byte-identical with no
 * inline duplication. The file is too detailed (2723×2723 viewBox,
 * ~40KB) to inline cheaply, hence the <img> reference.
 */
const BrandLogo: React.FC = () => (
  <img
    src="/favicon.svg?v=4"
    alt="theDAW logo"
    className="w-7 h-7 shrink-0 rounded-md shadow-[0_0_12px_rgba(124,58,237,0.35)]"
    draggable={false}
  />
);

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




