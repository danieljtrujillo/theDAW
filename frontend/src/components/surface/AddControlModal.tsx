/**
 * The Add-Control picker. Opened from a panel header in Design Mode, it lets the
 * user create a control and wire it to the backend without code: pick a backend
 * TARGET (grouped, pre-selecting the fitting control kind), optionally override
 * the KIND and STYLE tint, name it, and Add — or drop in a VISUALIZER instead.
 * On confirm it calls `addCustomWidget(panelId, def)`, which places a live,
 * bound control into that panel.
 */
import React, { useMemo, useState } from 'react';
import { X, Plus, Activity } from 'lucide-react';
import { useSurface } from './surfaceContext';
import { colorAt, rgb } from '../../lib/trackColor';
import type { BindableTarget, ControlKind, CustomWidgetDef } from './widgetTypes';

const KINDS: { k: ControlKind; label: string }[] = [
  { k: 'knob', label: 'Knob' },
  { k: 'fader', label: 'Fader' },
  { k: 'toggle', label: 'Toggle' },
  { k: 'pad', label: 'Pad' },
  { k: 'crossfader', label: 'X-Fader' },
];
// Style swatches: undefined = value-driven (auto), the rest are fixed accents.
const TINTS: (number | undefined)[] = [undefined, 0.02, 0.16, 0.32, 0.5, 0.62, 0.8, 0.95];

export const AddControlModal: React.FC<{ panelId: string; onClose: () => void }> = ({ panelId, onClose }) => {
  const { store, targets } = useSurface();
  const [mode, setMode] = useState<'control' | 'visualizer'>('control');
  const [targetId, setTargetId] = useState('');
  const [kind, setKind] = useState<ControlKind>('knob');
  const [tint, setTint] = useState<number | undefined>(undefined);
  const [label, setLabel] = useState('');

  const groups = useMemo(() => {
    const m = new Map<string, BindableTarget[]>();
    for (const t of targets) {
      const arr = m.get(t.group);
      if (arr) arr.push(t);
      else m.set(t.group, [t]);
    }
    return Array.from(m.entries());
  }, [targets]);

  const selectTarget = (t: BindableTarget) => {
    setTargetId(t.id);
    setKind(t.kind);
    setLabel(t.label);
  };

  const canAdd = mode === 'visualizer' || !!targetId;
  const add = () => {
    if (!canAdd) return;
    const def: Omit<CustomWidgetDef, 'id'> =
      mode === 'visualizer'
        ? { mode: 'visualizer', label: label.trim() || 'Spectrum', visualizer: 'spectrum' }
        : { mode: 'control', label: label.trim() || 'Control', kind, targetId, tint };
    store.getState().addCustomWidget(panelId, def);
    onClose();
  };

  const chip = (active: boolean) =>
    `px-2 py-1 rounded text-[9px] font-bold uppercase tracking-wider border transition-colors ${
      active ? 'border-purple-400 bg-purple-500/20 text-purple-100' : 'border-white/10 text-zinc-400 hover:text-zinc-200 hover:border-white/25'
    }`;

  return (
    <div className="fixed inset-0 z-200 grid place-items-center bg-black/60" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-136 max-w-[92vw] max-h-[82vh] flex flex-col rounded-lg border border-purple-400/40 bg-[#140e20] shadow-2xl"
      >
        <div className="shrink-0 flex items-center justify-between px-3 py-2 border-b border-white/10">
          <span className="flex items-center gap-1.5 text-[11px] font-black uppercase tracking-widest text-purple-200">
            <Plus className="w-3.5 h-3.5" /> Add Control
          </span>
          <button onClick={onClose} title="Close" className="text-zinc-400 hover:text-rose-300">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* mode tabs */}
        <div className="shrink-0 flex gap-1 px-3 py-2">
          <button onClick={() => setMode('control')} className={chip(mode === 'control')}>Bound Control</button>
          <button onClick={() => setMode('visualizer')} className={chip(mode === 'visualizer')}>Visualizer</button>
        </div>

        {mode === 'control' ? (
          <div className="min-h-0 flex-1 flex flex-col gap-2 px-3 pb-2">
            <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">1 · Bind to</div>
            <div className="min-h-0 flex-1 overflow-y-auto rounded border border-white/10 bg-black/30 p-1">
              {groups.map(([g, list]) => (
                <div key={g} className="mb-1">
                  <div className="px-1 py-0.5 text-[8px] font-black uppercase tracking-widest text-purple-300/80">{g}</div>
                  <div className="grid grid-cols-2 gap-0.5">
                    {list.map((t) => (
                      <button
                        key={t.id}
                        onClick={() => selectTarget(t)}
                        title={`${t.label}${t.unit ? ` (${t.unit})` : ''}`}
                        className={`text-left px-1.5 py-1 rounded text-[9px] font-medium truncate border transition-colors ${
                          targetId === t.id ? 'border-purple-400 bg-purple-500/20 text-purple-100' : 'border-transparent text-zinc-300 hover:bg-white/5'
                        }`}
                      >
                        {t.label}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
              {!targets.length && <div className="p-3 text-[9px] font-mono text-zinc-500">No bindable targets on this surface yet.</div>}
            </div>

            <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">2 · As a</div>
            <div className="flex flex-wrap gap-1">
              {KINDS.map(({ k, label: kl }) => (
                <button key={k} onClick={() => setKind(k)} className={chip(kind === k)}>{kl}</button>
              ))}
            </div>

            <div className="text-[9px] font-mono uppercase tracking-widest text-zinc-500">3 · Style</div>
            <div className="flex items-center gap-1.5">
              {TINTS.map((tn, i) => (
                <button
                  key={i}
                  onClick={() => setTint(tn)}
                  title={tn === undefined ? 'Auto (colour follows value)' : 'Fixed accent colour'}
                  className={`w-6 h-6 rounded-full border-2 transition-transform ${tint === tn ? 'border-white scale-110' : 'border-white/20'}`}
                  style={tn === undefined ? { background: 'conic-gradient(from 0deg, #f43f5e, #eab308, #22c55e, #06b6d4, #8b5cf6, #f43f5e)' } : { background: rgb(colorAt(tn)) }}
                />
              ))}
            </div>
          </div>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center gap-2 px-3 pb-2 text-center">
            <Activity className="w-8 h-8 text-purple-300" />
            <div className="text-[11px] font-bold text-zinc-200">Spectrum / Scope</div>
            <div className="text-[9px] font-mono text-zinc-500 max-w-72">A live analyser visualizer reading the master output. Drop it into any panel cell.</div>
          </div>
        )}

        {/* label + actions */}
        <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-white/10">
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="Label"
            title="Control label"
            className="flex-1 min-w-0 bg-black/40 border border-white/10 rounded px-2 py-1 text-[10px] text-zinc-200 focus:outline-none focus:border-purple-400/50"
          />
          <button onClick={onClose} className="px-2.5 py-1 rounded border border-white/10 text-zinc-300 hover:text-zinc-100 text-[9px] font-bold uppercase tracking-wider">
            Cancel
          </button>
          <button
            onClick={add}
            disabled={!canAdd}
            className="flex items-center gap-1 px-3 py-1 rounded border border-emerald-400/50 bg-emerald-500/15 text-emerald-200 enabled:hover:bg-emerald-500/25 disabled:opacity-40 text-[9px] font-black uppercase tracking-wider"
          >
            <Plus className="w-3 h-3" /> Add
          </button>
        </div>
      </div>
    </div>
  );
};
