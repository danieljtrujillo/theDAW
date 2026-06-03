import React, { useEffect, useMemo, useState } from 'react';
import { Settings, BookOpen, Smartphone, X, Copy, ExternalLink, ChevronUp, ChevronDown, GripHorizontal, GripVertical } from 'lucide-react';
import { LibraryView } from '../../views/LibraryView';
import { DAWCenterPanel } from './DAWCenterPanel';
import { CenterTabBar } from './CenterTabBar';
import { LogBody, LogActionButton, LogStripCompactInfo } from './ProcessingLog';
import { BottomMultiTabPanel } from './BottomMultiTabPanel';
import { DocsModal } from './DocsModal';
import { SettingsModal } from './SettingsModal';
import { useAppUiStore } from '../../state/appUiStore';
import { useBottomPanelStore } from '../../state/bottomPanelStore';

const RIGHT_RAIL_MIN = 280;
const RIGHT_RAIL_MAX = 640;

export const Shell: React.FC = () => {
  const setActiveView = useAppUiStore((state) => state.setActiveView);
  const centerTab = useAppUiStore((state) => state.centerTab);
  const setCenterTab = useAppUiStore((state) => state.setCenterTab);
  const isRightPanelOpen = useAppUiStore((state) => state.isRightPanelOpen);
  const setIsRightPanelOpen = useAppUiStore((state) => state.setRightPanelOpen);
  const rightPanelWidth = useAppUiStore((state) => state.rightPanelWidth);
  const setRightPanelWidth = useAppUiStore((state) => state.setRightPanelWidth);
  const docsOpen = useAppUiStore((state) => state.docsOpen);
  const setDocsOpen = useAppUiStore((state) => state.setDocsOpen);
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
      {/* Combined header + tab bar — logo (left), workspace tabs (center),
          Docs / Mobile / Settings icons (right). G-Search moved to the footer. */}
      <header className="h-11 border-b border-white/5 flex items-center gap-3 px-3 bg-[#0a080f]/80 backdrop-blur-md z-10 shrink-0 relative">
        <div className="flex items-center gap-2 relative z-10 select-none shrink-0">
          <BrandLogo />
          <div className="flex flex-col leading-none">
            <span className="text-[13px] font-black tracking-[0.18em] text-zinc-100">theDAW</span>
            <span className="text-[8px] font-mono uppercase tracking-[0.3em] text-zinc-500">by GANTASMO</span>
          </div>
        </div>

        {/* Workspace tabs — embedded so they share this row instead of a
            separate strip below. */}
        <CenterTabBar
          activeTab={centerTab}
          onTabChange={setCenterTab}
          isRightPanelOpen={isRightPanelOpen}
          onToggleRightPanel={() => setIsRightPanelOpen(!isRightPanelOpen)}
          embedded
        />

        <div className="flex items-center gap-2.5 shrink-0">
          {/* Icon-only — the hover tooltip (title) names each one. */}
          <TopBarButton
            onClick={() => setDocsOpen(true)}
            icon={<BookOpen className="w-3.5 h-3.5" />}
            title="Open documentation"
            accent="purple"
          />
          <TopBarButton
            onClick={() => setShareOpen(true)}
            icon={<Smartphone className="w-3.5 h-3.5" />}
            title="Open mobile access QR/link"
            accent="emerald"
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
 *   ┌─────────── canvas / main ────────────┬│┬── log body ──────┐
 *   │                                       ││                   │
 *   │  (multi body if isBottomOpen)         ││ (log body if      │
 *   │                                       ││  isLogOpen)       │
 *   ├───────────────────────────────────────┼─────────┬─────────┤
 *   │   ^   multi toggle  (flex-1)          │ ^ LOG …│ CREATE  │  <- the strip
 *   └───────────────────────────────────────┴─────────┴─────────┘
 *                                            ←──── logWidth ─────→
 *                                            ← 40% ─→← 60% ──────→
 *
 * - The dock body has ONE shared height (multiHeight) via a single vertical
 *   handle, so the LOG can never grow taller than the dock and push into the
 *   center work area; LOG content scrolls internally instead.
 * - The LOG has its OWN width (logWidth) with a horizontal handle at its left
 *   edge (the `│` above). Dragging it also nudges the library rail above so
 *   they stay aligned — one-way: the rail's own handle never changes logWidth.
 * - The strip is fixed-height and always visible. The left `^` collapses the
 *   multi-tab body; the LOG's `^` collapses the LOG body.
 * - The CREATE / PROCESS / TRAIN action button stays pinned in the right 60%
 *   of the LOG strip section so the user's most-used affordance never moves.
 */
const STRIP_HEIGHT = 36;
const DOCK_MIN_HEIGHT = 60;
const DOCK_MAX_FRACTION = 0.85;
const LOG_HEADER_FRACTION = '40%';
const CREATE_FRACTION = '60%';
const LOG_MIN_WIDTH = 220;
const LOG_MAX_WIDTH = 720;

const ShellBottomDock: React.FC = () => {
  const multiHeight = useBottomPanelStore((s) => s.multiHeight);
  const setMultiHeight = useBottomPanelStore((s) => s.setMultiHeight);
  const logWidth = useBottomPanelStore((s) => s.logWidth);
  const setLogWidth = useBottomPanelStore((s) => s.setLogWidth);
  const setRightPanelWidth = useAppUiStore((s) => s.setRightPanelWidth);
  const isBottomOpen = useBottomPanelStore((s) => s.isOpen);
  const setBottomOpen = useBottomPanelStore((s) => s.setOpen);
  const isLogOpen = useBottomPanelStore((s) => s.isLogOpen);
  const setLogOpen = useBottomPanelStore((s) => s.setLogOpen);
  const multiMaximized = useBottomPanelStore((s) => s.multiMaximized);

  const showBodyRow = isBottomOpen || isLogOpen;
  // ONE shared dock-body height — the LOG can never grow taller than the dock
  // and push into the center work area. Maximized fills the work area.
  const bodyHeight = multiMaximized ? 'calc(100vh - 7rem)' : `${multiHeight}px`;
  // The LOG column has its OWN width (logWidth); the strip + body both use it so
  // they stay column-aligned with each other (decoupled from the right Library
  // rail). Dragging the LOG handle also nudges the rail above — one-way: the
  // rail's own handle never changes logWidth.
  const stripGridStyle = { gridTemplateColumns: `minmax(0, 1fr) ${logWidth}px` };
  const bodyGridStyle = {
    gridTemplateColumns: `minmax(0, 1fr) ${isLogOpen ? `${logWidth}px` : '0px'}`,
  };
  const setLogWidthCoupled = (w: number) => {
    setLogWidth(w);
    setRightPanelWidth(w);
  };

  return (
    <div className="shrink-0 flex flex-col z-30 pointer-events-none">
      {/* Body row — one shared height; multi (flex) + LOG (logWidth) side-by-side. */}
      {showBodyRow && (
        <div
          className="relative shrink-0 grid items-stretch pointer-events-auto"
          style={{ ...bodyGridStyle, height: bodyHeight }}
        >
          {/* One vertical resize handle for the whole dock body (top edge).
              z-40 (inside the handle) keeps it above the cells regardless of
              DOM order. Hidden while maximized. */}
          {!multiMaximized && (
            <ColumnResizeHandle
              currentHeight={multiHeight}
              onSet={setMultiHeight}
              title="Drag to resize the bottom dock"
            />
          )}

          {/* Multi body — flexible column, fills the shared height. Transparent
              when collapsed so only the LOG block shows. */}
          <div
            className={`min-w-0 relative overflow-hidden ${isBottomOpen ? 'bg-[#0a080f] shadow-[0_-1px_0_rgba(168,85,247,0.08)]' : ''} ${isLogOpen && isBottomOpen && !multiMaximized ? 'border-r border-purple-500/15' : ''}`}
          >
            {isBottomOpen && (
              <>
                <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
                <BottomMultiTabPanel />
              </>
            )}
          </div>

          {/* LOG body — independent width, fills the shared height. */}
          {isLogOpen && (
            <div className="min-w-0 relative bg-[#0a080f] overflow-hidden shadow-[0_-1px_0_rgba(168,85,247,0.08)]">
              <div className="absolute inset-x-0 top-0 h-px bg-purple-500/20 pointer-events-none" />
              {/* Horizontal handle between the multi panel and the LOG. */}
              <WidthResizeHandle
                currentWidth={logWidth}
                onSet={setLogWidthCoupled}
                title="Drag to resize the log width"
              />
              <LogBody />
            </div>
          )}
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
            <span className="text-[10px] font-black uppercase tracking-widest text-purple-200 shrink-0">LOG</span>
            {/* Live CPU · GPU · TEMP · VRAM · RAM. Truncates when the LOG column
                is narrow — widen it with the horizontal handle to see them all. */}
            <span className="flex-1 min-w-0 overflow-hidden">
              <LogStripCompactInfo />
            </span>
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
 * Horizontal resize handle between the multi panel and the LOG. Lives at the
 * LEFT edge of the LOG cell; dragging left widens the LOG, right narrows it.
 * Same `dragging` full-window overlay trick as the vertical handle so the VJ
 * iframe can't swallow the drag. Width grows as the pointer moves left, so the
 * new width = (current right edge) - clientX, derived from the start geometry.
 */
interface WidthResizeHandleProps {
  currentWidth: number;
  onSet: (w: number) => void;
  title: string;
}
const WidthResizeHandle: React.FC<WidthResizeHandleProps> = ({ currentWidth, onSet, title }) => {
  const [dragging, setDragging] = useState(false);
  const startX = React.useRef(0);
  const startW = React.useRef(currentWidth);
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: MouseEvent) => {
      const dx = startX.current - e.clientX; // drag left = positive = wider
      const clamped = Math.max(LOG_MIN_WIDTH, Math.min(LOG_MAX_WIDTH, startW.current + dx));
      onSet(clamped);
    };
    const onUp = () => setDragging(false);
    document.body.style.cursor = 'col-resize';
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
      {dragging && <div className="fixed inset-0 z-50 cursor-col-resize" />}
      <div
        className="absolute inset-y-0 left-0 w-1.5 -ml-0.5 cursor-col-resize flex items-center justify-center group z-40"
        onMouseDown={(e) => {
          e.preventDefault();
          startX.current = e.clientX;
          startW.current = currentWidth;
          setDragging(true);
        }}
        title={title}
      >
        <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-0.5 group-hover:bg-purple-500/40 transition-colors" />
        <GripVertical className="w-3.5 h-3.5 text-zinc-700 group-hover:text-purple-300 opacity-0 group-hover:opacity-100 transition-opacity" />
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




