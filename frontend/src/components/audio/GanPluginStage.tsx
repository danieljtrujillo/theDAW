/**
 * GanPluginStage — renders a loaded .gan web-plugin in the MIX Effect Stage
 * footprint (the same spot Studio Modules land). The plugin's UI is served from
 * the backend runtime (/api/plugin/<id>/runtime/index.html) and iframed here;
 * its control postMessages bubble to the app (a host can route them later). The
 * Owl is a separate native case; this is the generic loader surface.
 *
 * The runtime letterboxes its canvas to fit (aspect-ratio preserved), so an
 * oversized plugin never overflows — it just shrinks. EXPAND pops the iframe to a
 * near-fullscreen overlay so a dense surface (e.g. Ares) is readable; the iframe
 * keeps the SAME src (no reload) so its control state and wiring persist.
 */
import { useState } from 'react';
import { Blocks, Maximize2, Minimize2 } from 'lucide-react';

export function GanPluginStage({ url, name }: { url: string | null; name: string | null }) {
  const [expanded, setExpanded] = useState(false);

  if (!url) {
    return (
      <div className="h-full w-full min-h-0 flex flex-col items-center justify-center gap-2 text-center px-4">
        <Blocks className="w-6 h-6 text-zinc-700" />
        <span className="text-[11px] text-zinc-500">Open a .gan plugin to load it here.</span>
        <span className="text-[9px] font-mono text-zinc-600">portable GANTASMO web-plugins</span>
      </div>
    );
  }

  const shell = expanded
    ? 'fixed inset-6 z-50 bg-[#07080c] border border-indigo-500/40 rounded-lg shadow-2xl flex flex-col min-h-0 overflow-hidden'
    : 'h-full w-full min-h-0 flex flex-col overflow-hidden bg-[#07080c]';

  return (
    <div className={shell}>
      <div className="flex items-center gap-2 px-2 py-1 shrink-0">
        <Blocks className="w-3 h-3 text-indigo-300 shrink-0" />
        <span className="text-[10px] font-black uppercase tracking-widest text-indigo-300 truncate">{name ?? 'GAN plugin'}</span>
        <button
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? 'Collapse' : 'Expand to a large overlay'}
          aria-label={expanded ? 'Collapse plugin' : 'Expand plugin'}
          aria-pressed={expanded}
          className="ml-auto inline-flex items-center gap-1 text-[10px] text-zinc-500 hover:text-indigo-300 transition-colors shrink-0"
        >
          {expanded ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />} {expanded ? 'Collapse' : 'Expand'}
        </button>
      </div>
      <iframe
        key={url}
        id="gan-stage-frame"
        src={url}
        title={name ?? 'GAN plugin'}
        className="w-full flex-1 min-h-0 border-0 block"
      />
    </div>
  );
}
