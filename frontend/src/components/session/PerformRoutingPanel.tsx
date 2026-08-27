/**
 * Perform routing — the SwayCommand deck schematic as the assignment surface,
 * collapsible to a slim bar.
 *
 * The deck (SwayDeck, a verbatim port of SwayCommand's surface) IS the UI:
 * click a pad to give it a scene, a knob / XY axis / gesture chip to route it
 * to a track's volume, mute or any live FX parameter, a button to bind a
 * transport function by pressing it. Under the deck, one chip row lists every
 * active route (⚡ = auto-created from the project file) with one-click remove.
 */
import React from 'react';
import { ChevronDown, ChevronUp, X, Zap } from 'lucide-react';
import type { DawProject } from '../../lib/dawImportClient';
import { performTracks } from '../../lib/performModel';
import { usePerformRoutingStore } from '../../state/performRouting';
import { SWAY_DIMS, type SwayDim } from '../../state/swayBus';
import { SwayDeck } from './SwayDeck';

export const PerformRoutingPanel: React.FC<{ project: DawProject }> = ({ project }) => {
  const [collapsed, setCollapsed] = React.useState(false);
  const tracks = React.useMemo(() => performTracks(project), [project]);
  const ccMods = usePerformRoutingStore((s) => s.ccMods);
  const trackMods = usePerformRoutingStore((s) => s.trackMods);
  const removeCcMod = usePerformRoutingStore((s) => s.removeCcMod);
  const removeMod = usePerformRoutingStore((s) => s.removeMod);

  const dimLabel = (d: SwayDim): string => SWAY_DIMS.find((x) => x.id === d)?.label ?? d;
  const trackName = (i: number): string => tracks[i]?.name ?? `Track ${i + 1}`;
  const routeCount = ccMods.length + trackMods.length;

  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => setCollapsed((v) => !v)}
        aria-expanded={!collapsed}
        title={collapsed ? 'Expand the Sway deck' : 'Collapse the Sway deck'}
        className="flex items-center gap-2 px-2 py-0.5 text-left hover:bg-white/5"
      >
        {collapsed ? <ChevronUp className="w-3 h-3 text-cyan-300" /> : <ChevronDown className="w-3 h-3 text-cyan-300" />}
        <span className="text-[9px] font-black uppercase tracking-[0.25em] text-cyan-200">Sway</span>
        <span className="text-[8px] font-mono text-zinc-500">
          {routeCount > 0 ? `${routeCount} route${routeCount === 1 ? '' : 's'}` : 'click a control to assign'}
        </span>
      </button>

      {!collapsed && (
        <>
          <SwayDeck project={project} />
          {routeCount > 0 && (
            <div className="flex items-center flex-wrap gap-1 px-2 pb-1.5" role="group" aria-label="Active routes">
              {ccMods.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 h-5 pl-1 pr-0.5 rounded border border-emerald-400/25 bg-emerald-400/5 text-[8px] font-mono text-emerald-200"
                  title={`${m.channel < 0 ? 'omni' : `ch${m.channel + 1}`} CC${m.number} → ${m.label}${m.id.startsWith('cc:') ? ' (auto, from the project file)' : ''}`}
                >
                  <Zap className="w-2.5 h-2.5" aria-hidden="true" />
                  {m.label}
                  <button
                    type="button"
                    onClick={() => removeCcMod(m.id)}
                    aria-label={`Remove route ${m.label}`}
                    title="Remove"
                    className="h-3.5 w-3.5 grid place-items-center text-zinc-500 hover:text-rose-300"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
              {trackMods.map((m) => (
                <span
                  key={m.id}
                  className="inline-flex items-center gap-1 h-5 pl-1 pr-0.5 rounded border border-fuchsia-400/25 bg-fuchsia-400/5 text-[8px] font-mono text-fuchsia-200"
                  title={`${dimLabel(m.dim)} → ${trackName(m.trackIndex)} · ${m.target}`}
                >
                  {dimLabel(m.dim)}⇢{trackName(m.trackIndex)}
                  <button
                    type="button"
                    onClick={() => removeMod(m.id)}
                    aria-label={`Remove ${dimLabel(m.dim)} route to ${trackName(m.trackIndex)}`}
                    title="Remove"
                    className="h-3.5 w-3.5 grid place-items-center text-zinc-500 hover:text-rose-300"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
};
