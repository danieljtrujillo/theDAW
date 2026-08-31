/**
 * Perform routing — the SwayCommand deck schematic as the assignment surface,
 * collapsible to a slim bar.
 *
 * The deck (SwayDeck, a verbatim port of SwayCommand's surface) IS the UI:
 * click a pad to give it a scene, a knob / XY axis / gesture chip to route it
 * to a track's volume, mute or any live FX parameter, a button to bind a
 * transport function by pressing it. The ACTIVE ROUTE LIST lives in the
 * right rail's ROUTES tab (PerformRail) — no more chip wall under the deck.
 */
import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import type { DawProject } from '../../lib/dawImportClient';
import { usePerformRoutingStore } from '../../state/performRouting';
import { SwayDeck } from './SwayDeck';

export const PerformRoutingPanel: React.FC<{ project: DawProject }> = ({ project }) => {
  const [collapsed, setCollapsed] = React.useState(false);
  const routeCount = usePerformRoutingStore((s) => s.ccMods.length + s.trackMods.length);

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
          {routeCount > 0
            ? `${routeCount} route${routeCount === 1 ? '' : 's'} — listed in the right rail`
            : 'click a control to assign'}
        </span>
      </button>

      {!collapsed && <SwayDeck project={project} />}
    </div>
  );
};
