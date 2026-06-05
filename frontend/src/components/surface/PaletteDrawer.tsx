/**
 * Floating palette of registered-but-unplaced widgets, shown only in Design
 * Mode. Each chip is a WIDGET_MIME drag source (drag into a panel to place it).
 * The drawer is also the "remove" target: dropping a placed widget onto it
 * unplaces the widget (it reappears here). Pinned/fixed-content widgets never
 * appear in the palette.
 */
import React, { useMemo, useState } from 'react';
import { Inbox, ChevronDown, ChevronUp } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { WIDGET_MIME, encode, decodeWidget } from './dnd';
import { collectPlacedWidgets } from '../../state/surfaceLayoutStore';

export const PaletteDrawer: React.FC = () => {
  const { surfaceId, store, registry } = useSurface();
  const layout = store((s) => s.layout);
  const [open, setOpen] = useState(true);
  const [over, setOver] = useState(false);

  const groups = useMemo(() => {
    const placed = collectPlacedWidgets(layout);
    const byGroup: Record<string, { id: string; label: string }[]> = {};
    for (const def of Object.values(registry)) {
      if (placed.has(def.id) || def.kind === 'fixed') continue;
      (byGroup[def.group] ??= []).push({ id: def.id, label: def.label });
    }
    return byGroup;
  }, [layout, registry]);

  const groupNames = Object.keys(groups).sort();
  const count = groupNames.reduce((a, g) => a + groups[g].length, 0);

  return (
    <div
      className={`absolute left-2 bottom-2 z-60 w-56 rounded border bg-[#150f22]/95 shadow-xl ${over ? 'border-rose-400/70' : 'border-purple-400/40'}`}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(WIDGET_MIME)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        setOver(false);
        if (!e.dataTransfer.types.includes(WIDGET_MIME)) return;
        const p = decodeWidget(e.dataTransfer.getData(WIDGET_MIME));
        if (!p || p.surfaceId !== surfaceId) return;
        e.preventDefault();
        if (p.fromPanelId) store.getState().removeWidget(p.widgetId);
      }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center gap-1.5 px-2 py-1 border-b border-white/10 text-purple-200"
        title="Palette — drag controls into panels; drop a control here to remove it"
      >
        <Inbox className="w-3 h-3" />
        <span className="text-[9px] font-black uppercase tracking-widest">Palette</span>
        <span className="text-[8px] font-mono text-zinc-500">{count}</span>
        <span className="ml-auto">{open ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />}</span>
      </button>

      {open && (
        <div className="max-h-56 overflow-y-auto p-1.5 flex flex-col gap-1.5">
          {count === 0 ? (
            <span className="text-[8px] font-mono text-zinc-600 px-1 py-2 text-center">
              All controls are placed. Drag a control here to remove it.
            </span>
          ) : (
            groupNames.map((g) => (
              <div key={g} className="flex flex-col gap-1">
                <span className="text-[7px] font-black uppercase tracking-widest text-zinc-500 px-0.5">{g}</span>
                <div className="flex flex-wrap gap-1">
                  {groups[g].map((w) => (
                    <div
                      key={w.id}
                      draggable
                      onDragStart={(e) => {
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData(
                          WIDGET_MIME,
                          encode({ surfaceId, widgetId: w.id, fromPanelId: null }),
                        );
                      }}
                      title={`Drag "${w.label}" into a panel`}
                      className="px-1.5 py-0.5 rounded border border-white/10 bg-white/5 text-zinc-200 text-[8px] font-bold cursor-grab active:cursor-grabbing hover:border-purple-400/60 hover:bg-purple-500/15"
                    >
                      {w.label}
                    </div>
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
};
