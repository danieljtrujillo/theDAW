/**
 * PERFORM's right rail — collapsible, expandable, drag-resizable. Two tabs:
 *
 *   ROUTES — the active Sway/CC route list that used to render as a giant
 *   chip wall above the grid. Now a searchable, grouped, scrollable list of
 *   compact rows (label + source + remove) that costs the grid no height.
 *
 *   PARAMS — the selected effect's parameters. Pick any track device; its
 *   rack descriptors render as tendril controls whose edits push straight
 *   into the grid's RUNNING chain instance (same entry ids the CC routes
 *   drive), so tweaks are audible live. VST3 devices are listed but inert,
 *   exactly as they are in the live graph.
 */
import React, { useMemo, useState } from 'react';
import { ChevronsRight, Search, X } from 'lucide-react';
import type { DawProject, DawTrack } from '../../lib/dawImportClient';
import { performTracks } from '../../lib/performModel';
import { dawDeviceToEffectNode } from '../../lib/dawEffectMap';
import { getRackEffect, rackEffectDefaults } from '../../lib/rackEffects';
import { effectiveZoom } from '../../lib/canvasScale';
import { usePerformRoutingStore } from '../../state/performRouting';
import { usePerformRailStore, pushPerformDeviceParams } from '../../state/performRailStore';
import { SWAY_DIMS, type SwayDim } from '../../state/swayBus';
import { TendrilParam } from '../nodefi/NodefiControls';

const PERFORM_ACCENT = '#34d399';

interface RailDevice {
  deviceIndex: number;
  name: string;
  effect: string;
  params: Record<string, number>;
  live: boolean;
}

/** The grid's device indexing: instruments/racks filtered out, order kept. */
function railDevices(track: DawTrack): RailDevice[] {
  return (track.devices ?? [])
    .filter((d) => !d.is_instrument && !d.is_rack)
    .map((d, i) => {
      const node = dawDeviceToEffectNode(d);
      return {
        deviceIndex: i,
        name: d.name || node.effect_name,
        effect: node.effect_name,
        params: (node.parameters ?? {}) as Record<string, number>,
        live: node.effect_name !== 'vst3' && !!getRackEffect(node.effect_name),
      };
    });
}

function RoutesTab({ tracks }: { tracks: DawTrack[] }): React.ReactElement {
  const ccMods = usePerformRoutingStore((s) => s.ccMods);
  const trackMods = usePerformRoutingStore((s) => s.trackMods);
  const removeCcMod = usePerformRoutingStore((s) => s.removeCcMod);
  const removeMod = usePerformRoutingStore((s) => s.removeMod);
  const [query, setQuery] = useState('');

  const dimLabel = (d: SwayDim): string => SWAY_DIMS.find((x) => x.id === d)?.label ?? d;
  const trackName = (i: number): string => tracks[i]?.name ?? `Track ${i + 1}`;
  const q = query.trim().toLowerCase();
  const cc = ccMods.filter((m) => !q || m.label.toLowerCase().includes(q));
  const dims = trackMods.filter(
    (m) => !q || `${dimLabel(m.dim)} ${trackName(m.trackIndex)} ${m.target}`.toLowerCase().includes(q),
  );

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <div className="shrink-0 p-2 pb-1">
        <label htmlFor="perform-route-search" className="sr-only">Filter routes</label>
        <div className="relative">
          <Search className="absolute left-1.5 top-1/2 -translate-y-1/2 w-3 h-3 text-zinc-600 pointer-events-none" />
          <input
            id="perform-route-search"
            name="perform-route-search"
            type="text"
            className="compact-input w-full pl-6"
            placeholder="Filter routes…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2 pb-2 space-y-2">
        {cc.length > 0 && (
          <div>
            <div className="mono-label mb-0.5">CC routes · {cc.length}</div>
            <div className="space-y-0.5">
              {cc.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-1 rounded border border-white/8 bg-white/2 pl-1.5 pr-0.5 py-0.5"
                  title={`${m.channel < 0 ? 'omni' : `ch${m.channel + 1}`} CC${m.number} — ${m.label}${m.id.startsWith('cc:') ? ' (auto, from the project file)' : ''}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[10px] font-mono font-semibold text-zinc-200">
                    {m.label}
                  </span>
                  <span className="shrink-0 text-[9px] font-mono text-zinc-500">CC{m.number}</span>
                  <button
                    type="button"
                    onClick={() => removeCcMod(m.id)}
                    aria-label={`Remove route ${m.label}`}
                    title="Remove"
                    className="shrink-0 h-4 w-4 grid place-items-center rounded text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {dims.length > 0 && (
          <div>
            <div className="mono-label mb-0.5">Sway dims · {dims.length}</div>
            <div className="space-y-0.5">
              {dims.map((m) => (
                <div
                  key={m.id}
                  className="flex items-center gap-1 rounded border border-white/8 bg-white/2 pl-1.5 pr-0.5 py-0.5"
                  title={`${dimLabel(m.dim)} drives ${trackName(m.trackIndex)} ${m.target}`}
                >
                  <span className="min-w-0 flex-1 truncate text-[10px] font-mono font-semibold text-zinc-200">
                    {dimLabel(m.dim)} — {trackName(m.trackIndex)} · {m.target}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeMod(m.id)}
                    aria-label={`Remove ${dimLabel(m.dim)} route to ${trackName(m.trackIndex)}`}
                    title="Remove"
                    className="shrink-0 h-4 w-4 grid place-items-center rounded text-zinc-500 hover:text-rose-300 hover:bg-rose-500/10"
                  >
                    <X className="w-2.5 h-2.5" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
        {cc.length === 0 && dims.length === 0 && (
          <div className="text-[10px] font-mono text-zinc-500 px-1 py-2">
            {q ? 'No routes match.' : 'No routes yet — click a control on the Sway deck to assign one.'}
          </div>
        )}
      </div>
    </div>
  );
}

function ParamsTab({ tracks }: { tracks: DawTrack[] }): React.ReactElement {
  const selTrack = usePerformRailStore((s) => s.selTrack);
  const selDevice = usePerformRailStore((s) => s.selDevice);
  const select = usePerformRailStore((s) => s.select);

  const perTrack = useMemo(
    () => tracks.map((t, ti) => ({ track: t, trackIndex: ti, devices: railDevices(t) })),
    [tracks],
  );
  const selected = useMemo(() => {
    if (selTrack === null || selDevice === null) return null;
    const d = perTrack[selTrack]?.devices.find((x) => x.deviceIndex === selDevice) ?? null;
    return d ? { trackIndex: selTrack, device: d } : null;
  }, [perTrack, selTrack, selDevice]);

  // Values start from the device's authored params over the effect defaults;
  // edits go straight into the running chain (which keeps sticky state).
  const [values, setValues] = useState<Record<string, number>>({});
  const selKey = selected ? `${selected.trackIndex}-${selected.device.deviceIndex}` : '';
  const lastKeyRef = React.useRef('');
  if (selKey !== lastKeyRef.current) {
    lastKeyRef.current = selKey;
    setValues(selected ? { ...rackEffectDefaults(selected.device.effect), ...selected.device.params } : {});
  }

  const def = selected ? getRackEffect(selected.device.effect) : undefined;

  return (
    <div className="flex-1 min-h-0 overflow-y-auto no-scrollbar px-2 pb-2 space-y-2">
      <div className="pt-1 space-y-1.5">
        {perTrack.map(({ track, trackIndex, devices }) =>
          devices.length ? (
            <div key={trackIndex}>
              <div className="mono-label mb-0.5 truncate">{track.name || `Track ${trackIndex + 1}`}</div>
              <div className="space-y-0.5">
                {devices.map((d) => {
                  const active = selected?.trackIndex === trackIndex && selected.device.deviceIndex === d.deviceIndex;
                  return (
                    <button
                      key={d.deviceIndex}
                      type="button"
                      onClick={() => select(trackIndex, d.deviceIndex)}
                      aria-pressed={active}
                      title={d.live ? `Edit ${d.name} live` : `${d.name} — VST/unknown device, preserved but not live-editable here`}
                      className={`w-full flex items-center gap-1.5 rounded border px-1.5 py-1 text-left transition-colors ${
                        active
                          ? 'text-(--text-primary)'
                          : 'border-white/8 bg-white/2 text-zinc-400 hover:text-zinc-100 hover:border-white/20'
                      }`}
                      style={active ? { borderColor: `${PERFORM_ACCENT}aa`, background: `${PERFORM_ACCENT}14` } : undefined}
                    >
                      <span className="min-w-0 flex-1 truncate text-[10px] font-mono font-semibold">{d.name}</span>
                      {!d.live && <span className="shrink-0 text-[9px] font-mono text-zinc-600">inert</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null,
        )}
        {perTrack.every((t) => t.devices.length === 0) && (
          <div className="text-[10px] font-mono text-zinc-500 px-1 py-2">No effect devices in this set.</div>
        )}
      </div>

      {selected && (
        <div className="border-t border-white/10 pt-1.5 space-y-2">
          <div className="mono-label truncate">
            {selected.device.name} — {def?.label ?? selected.device.effect}
          </div>
          {def && selected.device.live ? (
            def.params.map((p) => (
              <TendrilParam
                key={p.key}
                id={`perform-param-${selKey}-${p.key}`}
                label={p.label}
                value={Number(values[p.key] ?? p.default)}
                min={p.min}
                max={p.max}
                step={p.step}
                defaultValue={p.default}
                unit={p.unit}
                accent={PERFORM_ACCENT}
                onChange={(v) => {
                  setValues((cur) => ({ ...cur, [p.key]: v }));
                  pushPerformDeviceParams(selected.trackIndex, selected.device.deviceIndex, { [p.key]: v });
                }}
              />
            ))
          ) : (
            <div className="text-[10px] font-mono text-zinc-500">
              This device is preserved in the set but has no live parameters here.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export const PerformRail: React.FC<{ project: DawProject }> = ({ project }) => {
  const open = usePerformRailStore((s) => s.open);
  const width = usePerformRailStore((s) => s.width);
  const tab = usePerformRailStore((s) => s.tab);
  const setOpen = usePerformRailStore((s) => s.setOpen);
  const setTab = usePerformRailStore((s) => s.setTab);
  const railRef = React.useRef<HTMLDivElement | null>(null);
  const tracks = useMemo(() => performTracks(project), [project]);

  const startResize = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const ez = effectiveZoom(railRef.current);
    const startX = e.clientX;
    const startW = usePerformRailStore.getState().width;
    const onMove = (ev: PointerEvent) => {
      usePerformRailStore.getState().setWidth(startW - (ev.clientX - startX) / ez);
    };
    const onUp = () => window.removeEventListener('pointermove', onMove);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
  };

  // Closed = GONE. No second strip on the right edge (user mandate: the right
  // side is ONE rail) — the toggle lives in Perform's header instead.
  if (!open) return null;

  return (
    <div
      ref={railRef}
      className="relative shrink-0 border-l border-white/5 bg-black/30 flex flex-col min-h-0"
      style={{ width }}
    >
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize the rail"
        title="Drag to resize"
        onPointerDown={startResize}
        className="absolute inset-y-0 -left-1 w-2 cursor-col-resize z-10"
      />
      <div className="shrink-0 flex items-center border-b border-white/10">
        <button
          type="button"
          onClick={() => setTab('routes')}
          aria-pressed={tab === 'routes'}
          className={`flex-1 px-2 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors ${
            tab === 'routes' ? 'text-emerald-200 bg-emerald-400/10' : 'text-zinc-500 hover:text-zinc-200'
          }`}
        >
          Routes
        </button>
        <button
          type="button"
          onClick={() => setTab('params')}
          aria-pressed={tab === 'params'}
          className={`flex-1 px-2 py-1.5 text-[10px] font-mono font-bold uppercase tracking-widest transition-colors ${
            tab === 'params' ? 'text-emerald-200 bg-emerald-400/10' : 'text-zinc-500 hover:text-zinc-200'
          }`}
        >
          Params
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          title="Collapse the rail"
          aria-label="Collapse the rail"
          className="shrink-0 p-1 mx-0.5 rounded text-zinc-500 hover:text-white hover:bg-white/10 transition-colors"
        >
          <ChevronsRight className="w-3.5 h-3.5" />
        </button>
      </div>
      {tab === 'routes' ? <RoutesTab tracks={tracks} /> : <ParamsTab tracks={tracks} />}
    </div>
  );
};
