/**
 * VstEmbedHost - host box for an EMBEDDED native VST3 editor, shared by MIX's
 * Effect Stage and EDIT's floating plugin popup. The backend sidecar pins the
 * plugin's real OS window (owned by Electron, positioned over this box) and CLIPS
 * it to the box, so an oversized editor keeps its natural size and is reachable by
 * SCROLLING this container (the inner spacer is sized to the plugin). EXPAND grows
 * the box to a large overlay for big GUIs. We only REPORT geometry + scroll here;
 * the editor is closed explicitly (Close / its own window), NEVER on React unmount,
 * so StrictMode / panel re-renders can't kill it.
 */
import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, Minimize2, X } from 'lucide-react';
import { vstApi, getContentBounds } from '../../lib/vstClient';

// The header label reuses MIX's section-title styling so the host reads the
// same in every view that mounts it.
const sectionTitle = 'text-[10px] font-black uppercase tracking-widest text-purple-300';

export const VstEmbedHost: React.FC<{
  pluginPath: string;
  pluginName: string;
  error?: string;
  onClose: () => void;
  /** Reports the plugin's natural editor size (CSS px) whenever it changes, so
   *  a hosting popup can size itself to the plugin instead of a fixed box. */
  onNaturalSize?: (w: number, h: number) => void;
}> = ({ pluginPath, pluginName, error, onClose, onNaturalSize }) => {
  const ref = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);
  // Plugin's natural size in CSS px (from the backend, which knows the real
  // window size); drives the scrollable inner spacer.
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  // The callback rides a ref so the polling effect below keeps its
  // [pluginPath, error] dependency list even when the parent re-creates it.
  const onNaturalSizeRef = useRef(onNaturalSize);
  onNaturalSizeRef.current = onNaturalSize;

  useEffect(() => {
    const el = ref.current;
    if (!el || error) return; // a load failure has no window to track
    let alive = true;
    const report = () => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      void getContentBounds().then((cb) => {
        if (!alive) return;
        // Viewport origin in absolute physical screen px (content-area screen
        // origin (DIP) + element offset (CSS px, approximately DIP), scaled by dpr). Use the
        // client box (excludes the scrollbar) so the native window doesn't cover
        // the scrollbar; pass the scroll offset so it pans as we scroll.
        const ox = cb ? cb.x : 0;
        const oy = cb ? cb.y : 0;
        void vstApi.editorRect(pluginPath, {
          x: (ox + r.left) * dpr,
          y: (oy + r.top) * dpr,
          w: el.clientWidth * dpr,
          h: el.clientHeight * dpr,
          sx: el.scrollLeft * dpr,
          sy: el.scrollTop * dpr,
          dpr: 1, // values are already physical px
        });
      });
    };
    report();
    const ro = new ResizeObserver(report);
    ro.observe(el);
    el.addEventListener('scroll', report, { passive: true });
    window.addEventListener('resize', report);
    // Poll so the window follows Electron moves too (a move fires no 'resize').
    const iv = window.setInterval(report, 250);
    return () => {
      alive = false;
      ro.disconnect();
      el.removeEventListener('scroll', report);
      window.removeEventListener('resize', report);
      window.clearInterval(iv);
    };
  }, [pluginPath, error, expanded]);

  // Poll the plugin's natural size so the scroll area matches it (and tracks a
  // plugin that resizes its own window).
  useEffect(() => {
    if (error) return;
    let alive = true;
    const dpr = window.devicePixelRatio || 1;
    let last: { w: number; h: number } | null = null;
    const poll = () => {
      vstApi.editorSize(pluginPath)
        .then((res) => {
          if (!alive) return;
          if (res.status === 'ok' && res.w && res.h) {
            const w = Math.round(res.w / dpr);
            const h = Math.round(res.h / dpr);
            // Only propagate a real change; the poll fires every second and a
            // fresh object each tick would re-render the host (and the parent
            // popup) for nothing.
            if (!last || last.w !== w || last.h !== h) {
              last = { w, h };
              setNatural((prev) => (prev && prev.w === w && prev.h === h ? prev : { w, h }));
              onNaturalSizeRef.current?.(w, h);
            }
          }
          if (alive) window.setTimeout(poll, 1000);
        })
        .catch(() => { if (alive) window.setTimeout(poll, 1500); });
    };
    poll();
    return () => { alive = false; };
  }, [pluginPath, error]);

  const shell = expanded
    ? 'fixed inset-6 z-50 bg-[#0c0a14] border border-teal-500/40 rounded-lg shadow-2xl flex flex-col min-h-0 overflow-hidden p-2 gap-2'
    : 'h-full w-full flex flex-col min-h-0 overflow-hidden p-2 gap-2';

  return (
    <div className={shell}>
      <div className="flex items-center gap-2 shrink-0">
        <span className={sectionTitle}>{pluginName}</span>
        <span className="text-[8px] font-mono text-zinc-600">{error ? 'plugin error' : 'native VST GUI'}</span>
        {!error && (
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            title={expanded ? 'Collapse' : 'Expand'}
            aria-label={expanded ? 'Collapse plugin editor' : 'Expand plugin editor'}
            aria-pressed={expanded}
            className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-teal-300 transition-colors shrink-0"
          >
            {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />} {expanded ? 'Collapse' : 'Expand'}
          </button>
        )}
        <button onClick={onClose} title="Close the plugin editor" className={`inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-red-400 transition-colors shrink-0 ${error ? 'ml-auto' : ''}`}>
          <X className="w-3.5 h-3.5" /> Close
        </button>
      </div>
      {error ? (
        <div className="flex-1 min-h-0 rounded border border-red-500/30 bg-red-950/20 grid place-items-center p-3">
          <div className="text-center max-w-md">
            <span className="text-[11px] font-semibold text-red-300 block mb-1">This plugin could not be loaded</span>
            <span className="text-[9px] font-mono text-red-200/70 wrap-break-word">{error}</span>
          </div>
        </div>
      ) : (
        <div ref={ref} className="flex-1 min-h-0 overflow-auto rounded border border-teal-500/30 bg-black/60 relative">
          {/* Spacer sized to the plugin so the area scrolls; the native window is
              positioned over the visible viewport by the backend watcher. */}
          <div style={natural ? { width: natural.w, height: natural.h } : { width: '100%', height: '100%' }} />
          {!natural && (
            <span className="absolute inset-0 grid place-items-center text-[10px] font-mono text-zinc-600 pointer-events-none">loading plugin editor...</span>
          )}
        </div>
      )}
    </div>
  );
};
