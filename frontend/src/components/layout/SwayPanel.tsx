/**
 * SWAY panel -- learn, meter, and route the Audima Sway's six expressive
 * dimensions. Each row arms LEARN (binds the dimension to the next CC the
 * controller sends), shows the bound CC and a live 0..1 meter, and routes the
 * dimension to a BindableTarget (DJ targets today). Lives as a tab in the global
 * bottom multi-tab panel, beside SLIDE.
 *
 * Works with ANY MIDI controller via learn, not only a physical Sway; the Sway
 * profile just labels the surface.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { useSwayStore, SWAY_DIMS } from '../../state/swayBus';
import { useSwayRoutingStore, loadSwayTargets } from '../../state/swayRouting';
import { usePoseStore, POSE_CHANNELS } from '../../state/poseBus';
import { usePoseRoutingStore } from '../../state/poseRouting';
import type { BindableTarget } from '../surface/widgetTypes';
import { useMidiTriggerStore } from '../../state/midiTriggerStore';

export const SwayPanel: React.FC = () => {
  const bindings = useSwayStore((s) => s.bindings);
  const values = useSwayStore((s) => s.values);
  const learningDim = useSwayStore((s) => s.learningDim);
  const startLearn = useSwayStore((s) => s.startLearn);
  const cancelLearn = useSwayStore((s) => s.cancelLearn);
  const clearBinding = useSwayStore((s) => s.clearBinding);
  const routes = useSwayRoutingStore((s) => s.routes);
  const setRoute = useSwayRoutingStore((s) => s.setRoute);
  const poseValues = usePoseStore((s) => s.values);
  const poseActive = usePoseStore((s) => s.active);
  const poseRoutes = usePoseRoutingStore((s) => s.routes);
  const setPoseRoute = usePoseRoutingStore((s) => s.setRoute);
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);
  const [targets, setTargets] = useState<BindableTarget[]>([]);

  useEffect(() => {
    let alive = true;
    void loadSwayTargets().then((t) => {
      if (alive) setTargets(t);
    });
    return () => {
      alive = false;
    };
  }, []);

  const groups = useMemo(() => {
    const m = new Map<string, BindableTarget[]>();
    for (const t of targets) {
      const arr = m.get(t.group) ?? [];
      arr.push(t);
      m.set(t.group, arr);
    }
    return Array.from(m.entries());
  }, [targets]);

  return (
    <div className="h-full overflow-y-auto p-3 text-zinc-200">
      <div className="flex items-center justify-between mb-2">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-300">Sway</h3>
        <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">Audima 6-dimension motion</span>
      </div>
      {!midiEnabled && (
        <p className="mb-2 text-[9px] font-mono text-amber-300/80 leading-snug">
          MIDI is off. Turn on the master MIDI toggle to receive Sway input, then Learn each dimension.
        </p>
      )}
      <div className="space-y-1.5">
        {SWAY_DIMS.map((d) => {
          const b = bindings[d.id];
          const v = values[d.id] ?? 0;
          const learning = learningDim === d.id;
          const routeId = routes[d.id] ?? '';
          const selectId = `sway-route-${d.id}`;
          return (
            <div key={d.id} className="flex items-center gap-2 rounded border border-white/10 bg-white/3 px-2 py-1.5">
              <span className="w-14 shrink-0 text-[10px] font-bold uppercase tracking-wider text-fuchsia-200">{d.label}</span>
              <button
                onClick={() => (learning ? cancelLearn() : startLearn(d.id))}
                aria-label={learning ? `Cancel learning ${d.label}` : `Learn ${d.label}`}
                className={`shrink-0 px-2 py-1 rounded border text-[8px] font-black uppercase tracking-widest ${
                  learning
                    ? 'border-amber-400/60 bg-amber-400/15 text-amber-200 animate-pulse'
                    : 'border-white/15 text-zinc-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200'
                }`}
              >
                {learning ? 'Listening' : 'Learn'}
              </button>
              <span className="w-16 shrink-0 text-[8px] font-mono text-zinc-500">
                {b ? `Ch${b.channel + 1} CC${b.cc}` : 'unmapped'}
              </span>
              {b && (
                <button
                  onClick={() => clearBinding(d.id)}
                  aria-label={`Clear ${d.label} binding`}
                  className="shrink-0 text-[10px] text-zinc-600 hover:text-rose-300 leading-none"
                >
                  x
                </button>
              )}
              <div className="flex-1 min-w-12 h-2 rounded bg-black/50 overflow-hidden" aria-hidden="true">
                <div className="h-full bg-fuchsia-500/70" style={{ width: `${Math.round(v * 100)}%` }} />
              </div>
              <label htmlFor={selectId} className="sr-only">{`Route ${d.label} to a target`}</label>
              <select
                id={selectId}
                name={selectId}
                value={routeId}
                onChange={(e) => setRoute(d.id, e.target.value || null)}
                className="shrink-0 w-36 bg-black/40 border border-zinc-800 rounded px-1.5 py-1 text-[9px] font-mono text-zinc-200 focus:border-fuchsia-500/50 outline-none"
              >
                <option value="">route to...</option>
                {groups.map(([g, list]) => (
                  <optgroup key={g} label={g}>
                    {list.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[8px] font-mono text-zinc-600 leading-snug">
        Learn binds a dimension to the next CC the controller sends. Routing drives DJ targets today; VJ, MAKE, and vocal targets join as the unified mapping matrix lands.
      </p>

      <div className="mt-3 mb-2 flex items-center justify-between">
        <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">Camera Pose</h3>
        <span className={`text-[8px] font-mono uppercase tracking-widest ${poseActive ? 'text-cyan-400' : 'text-zinc-600'}`}>
          {poseActive ? 'live' : 'enable GESTURE in the VJ'}
        </span>
      </div>
      <div className="space-y-1.5">
        {POSE_CHANNELS.map((c) => {
          const v = poseValues[c.id] ?? 0;
          const routeId = poseRoutes[c.id] ?? '';
          const selectId = `pose-route-${c.id}`;
          return (
            <div key={c.id} className="flex items-center gap-2 rounded border border-white/10 bg-white/3 px-2 py-1.5">
              <span className="w-16 shrink-0 text-[10px] font-bold uppercase tracking-wider text-cyan-200">{c.label}</span>
              <div className="flex-1 min-w-12 h-2 rounded bg-black/50 overflow-hidden" aria-hidden="true">
                <div className="h-full bg-cyan-500/70" style={{ width: `${Math.round(v * 100)}%` }} />
              </div>
              <label htmlFor={selectId} className="sr-only">{`Route ${c.label} to a target`}</label>
              <select
                id={selectId}
                name={selectId}
                value={routeId}
                onChange={(e) => setPoseRoute(c.id, e.target.value || null)}
                className="shrink-0 w-36 bg-black/40 border border-zinc-800 rounded px-1.5 py-1 text-[9px] font-mono text-zinc-200 focus:border-cyan-500/50 outline-none"
              >
                <option value="">route to...</option>
                {groups.map(([g, list]) => (
                  <optgroup key={g} label={g}>
                    {list.map((t) => (
                      <option key={t.id} value={t.id}>{t.label}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[8px] font-mono text-zinc-600 leading-snug">
        Camera pose comes from the VJ's webcam body tracking (toggle GESTURE in the VJ). The six channels route to targets like Sway; no learn needed.
      </p>
    </div>
  );
};
