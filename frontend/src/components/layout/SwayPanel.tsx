/**
 * SWAY panel -- learn, meter, and route the Audima Sway's six expressive
 * dimensions, plus the VJ's six camera-pose channels. Each Sway row arms LEARN
 * (binds the dimension to the next CC the controller sends), shows the bound CC
 * (folded into the Learn button) and a live 0..1 meter, and routes the dimension
 * to a BindableTarget (DJ targets today). Lives as a tab in the global bottom
 * multi-tab panel, beside SLIDE.
 *
 * Laid out in two columns (Sway | Camera Pose) so the wide-but-short bottom
 * panel is filled horizontally instead of scrolling.
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
import { useMidiTriggerStore, enableMidi } from '../../state/midiTriggerStore';
import {
  useSwaySurfaceStore,
  SWAY_PAD_MODES,
  SWAY_PAD_MODE_LABELS,
  type SwayPadMode,
} from '../../state/swaySurfaceStore';
import { useSwayImportStore } from '../../state/swayImportStore';

const ctrlLabel = (isNote: boolean, channel: number, number: number): string =>
  `${channel < 0 ? 'omni' : `ch${channel + 1}`} ${isNote ? 'N' : 'CC'}${number}`;

const UNATTACHED_REASON: Record<string, string> = {
  macro: 'rack macro',
  instrument: 'instrument param',
  track: 'track not found',
  device: 'device not found',
  param: 'no matching param',
  effect: 'no live effect',
};

type TargetGroups = Array<[string, BindableTarget[]]>;

/** Shared route picker — both Sway dims and pose channels fan out to the same
 *  grouped target catalog. */
const RouteSelect: React.FC<{
  id: string;
  label: string;
  value: string;
  groups: TargetGroups;
  accent: 'fuchsia' | 'cyan';
  onChange: (v: string | null) => void;
}> = ({ id, label, value, groups, accent, onChange }) => (
  <>
    <label htmlFor={id} className="sr-only">{`Route ${label} to a target`}</label>
    <select
      id={id}
      name={id}
      value={value}
      onChange={(e) => onChange(e.target.value || null)}
      className={`shrink-0 w-28 bg-black/40 border border-zinc-800 rounded px-1 py-1 text-[9px] font-mono text-zinc-200 outline-none ${
        accent === 'fuchsia' ? 'focus:border-fuchsia-500/50' : 'focus:border-cyan-500/50'
      }`}
    >
      <option value="">route to</option>
      {groups.map(([g, list]) => (
        <optgroup key={g} label={g}>
          {list.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </optgroup>
      ))}
    </select>
  </>
);

const Meter: React.FC<{ value: number; accent: 'fuchsia' | 'cyan' }> = ({ value, accent }) => (
  <div className="flex-1 min-w-8 h-2 rounded bg-black/50 overflow-hidden" aria-hidden="true">
    <div
      className={`h-full ${accent === 'fuchsia' ? 'bg-fuchsia-500/70' : 'bg-cyan-500/70'}`}
      style={{ width: `${Math.round(value * 100)}%` }}
    />
  </div>
);

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
  const surfaceEnabled = useSwaySurfaceStore((s) => s.enabled);
  const setSurfaceEnabled = useSwaySurfaceStore((s) => s.setEnabled);
  const padMode = useSwaySurfaceStore((s) => s.padMode);
  const setPadMode = useSwaySurfaceStore((s) => s.setPadMode);
  const sustain = useSwaySurfaceStore((s) => s.sustain);
  const setSustain = useSwaySurfaceStore((s) => s.setSustain);
  const importedBindings = useSwayImportStore((s) => s.bindings);
  const importedUnattached = useSwayImportStore((s) => s.unattached);
  const importedSource = useSwayImportStore((s) => s.sourceName);
  const clearImported = useSwayImportStore((s) => s.clear);
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

  const groups = useMemo<TargetGroups>(() => {
    const m = new Map<string, BindableTarget[]>();
    for (const t of targets) {
      const arr = m.get(t.group) ?? [];
      arr.push(t);
      m.set(t.group, arr);
    }
    return Array.from(m.entries());
  }, [targets]);

  return (
    <div className="h-full overflow-y-auto p-2.5 text-zinc-200">
      {!midiEnabled && (
        <div className="mb-2 flex items-center gap-2">
          <button
            onClick={() => enableMidi()}
            className="shrink-0 px-2 py-0.5 rounded border border-amber-400/60 bg-amber-400/15 text-amber-200 text-[8px] font-black uppercase tracking-widest hover:bg-amber-400/25"
          >
            Enable MIDI
          </button>
          <span className="text-[9px] font-mono text-amber-300/80 leading-snug">
            MIDI input is off. Turn it on to receive the Sway, then Learn dims or use DAW Control below.
          </span>
        </div>
      )}

      <div className="grid gap-x-4 gap-y-3 md:grid-cols-2">
        {/* Sway dimensions */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-300">Sway</h3>
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">6-dim motion</span>
          </div>
          <div className="space-y-1">
            {SWAY_DIMS.map((d) => {
              const b = bindings[d.id];
              const learning = learningDim === d.id;
              return (
                <div key={d.id} className="flex items-center gap-1.5 rounded border border-white/10 bg-white/3 px-1.5 py-1">
                  <span className="w-11 shrink-0 text-[10px] font-bold uppercase tracking-wider text-fuchsia-200">{d.label}</span>
                  <button
                    onClick={() => (learning ? cancelLearn() : startLearn(d.id))}
                    aria-label={learning ? `Cancel learning ${d.label}` : `Learn ${d.label}`}
                    title={b ? `Bound to Ch${b.channel + 1} CC${b.cc} — click to relearn` : 'Learn — bind to the next CC'}
                    className={`shrink-0 w-14 px-1.5 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${
                      learning
                        ? 'border-amber-400/60 bg-amber-400/15 text-amber-200 animate-pulse'
                        : b
                          ? 'border-fuchsia-400/40 text-fuchsia-200/90 hover:border-fuchsia-400/70'
                          : 'border-white/15 text-zinc-300 hover:border-fuchsia-400/50 hover:text-fuchsia-200'
                    }`}
                  >
                    {learning ? 'Listen' : b ? `CC${b.cc}` : 'Learn'}
                  </button>
                  {b && (
                    <button
                      onClick={() => clearBinding(d.id)}
                      aria-label={`Clear ${d.label} binding`}
                      title="Clear binding"
                      className="shrink-0 text-[10px] text-zinc-600 hover:text-rose-300 leading-none"
                    >
                      x
                    </button>
                  )}
                  <Meter value={values[d.id] ?? 0} accent="fuchsia" />
                  <RouteSelect
                    id={`sway-route-${d.id}`}
                    label={d.label}
                    value={routes[d.id] ?? ''}
                    groups={groups}
                    accent="fuchsia"
                    onChange={(v) => setRoute(d.id, v)}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* Camera pose */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">Camera Pose</h3>
            <span className={`text-[8px] font-mono uppercase tracking-widest ${poseActive ? 'text-cyan-400' : 'text-zinc-600'}`}>
              {poseActive ? 'live' : 'enable GESTURE in the VJ'}
            </span>
          </div>
          <div className="space-y-1">
            {POSE_CHANNELS.map((c) => (
              <div key={c.id} className="flex items-center gap-1.5 rounded border border-white/10 bg-white/3 px-1.5 py-1">
                <span className="w-16 shrink-0 text-[10px] font-bold uppercase tracking-wider text-cyan-200">{c.label}</span>
                <Meter value={poseValues[c.id] ?? 0} accent="cyan" />
                <RouteSelect
                  id={`pose-route-${c.id}`}
                  label={c.label}
                  value={poseRoutes[c.id] ?? ''}
                  groups={groups}
                  accent="cyan"
                  onChange={(v) => setPoseRoute(c.id, v)}
                />
              </div>
            ))}
          </div>
        </section>
      </div>

      {/* DAW control surface: mirror the Sway hardware onto theDAW's EDIT mixer,
          transport and pads (distinct from the expressive-dim learn above). */}
      <section className="mt-3 rounded border border-white/10 bg-white/3 p-2">
        <div className="flex items-center justify-between gap-2 mb-1.5">
          <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300">DAW Control</h3>
          <button
            onClick={() => {
              if (!surfaceEnabled) enableMidi();
              setSurfaceEnabled(!surfaceEnabled);
            }}
            aria-pressed={surfaceEnabled}
            aria-label="Toggle Sway DAW-control mirror"
            className={`shrink-0 px-2 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${
              surfaceEnabled
                ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-200'
                : 'border-white/15 text-zinc-400 hover:border-emerald-400/50 hover:text-emerald-200'
            }`}
          >
            {surfaceEnabled ? 'On' : 'Off'}
          </button>
        </div>
        <p className="text-[9px] font-mono text-zinc-400 leading-snug mb-1.5">
          Mirror the Sway hardware onto theDAW: play/stop, 8 volume faders + 8 pan knobs over a
          selection-following bank of 8 EDIT tracks, and 16 pads. When on, these controls drive the
          DAW instead of being free for expressive-dimension learn above.
        </p>
        <div className="flex items-center gap-1.5">
          <label htmlFor="sway-pad-mode" className="text-[9px] font-bold uppercase tracking-wider text-emerald-200/90">
            Pads
          </label>
          <select
            id="sway-pad-mode"
            name="sway-pad-mode"
            value={padMode}
            onChange={(e) => setPadMode(e.target.value as SwayPadMode)}
            disabled={!surfaceEnabled}
            className="bg-black/40 border border-zinc-800 rounded px-1.5 py-1 text-[9px] font-mono text-zinc-200 outline-none focus:border-emerald-500/50 disabled:opacity-40"
          >
            {SWAY_PAD_MODES.map((m) => (
              <option key={m} value={m}>{SWAY_PAD_MODE_LABELS[m]}</option>
            ))}
          </select>
          <span className="text-[8px] font-mono text-zinc-600">
            {padMode === 'drums'
              ? '16 pads -> GM percussion'
              : padMode === 'track'
                ? 'pads play the selected track'
                : 'pads play the piano synth'}
          </span>
          <div className="flex-1" />
          <button
            onClick={() => setSustain(!sustain)}
            aria-pressed={sustain}
            aria-label="Toggle pad sustain (latch)"
            disabled={!surfaceEnabled}
            title="Sustain: a held/pressed pad rings until you press it again (latched), using a sustaining organ voice for melodic pads. Off = release on lift."
            className={`shrink-0 px-2 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest disabled:opacity-40 ${
              sustain
                ? 'border-emerald-400/60 bg-emerald-400/15 text-emerald-200'
                : 'border-white/15 text-zinc-400 hover:border-emerald-400/50 hover:text-emerald-200'
            }`}
          >
            Sustain
          </button>
        </div>
      </section>

      {(importedBindings.length > 0 || importedUnattached.length > 0) && (
        <section className="mt-3 rounded border border-white/10 bg-white/3 p-2">
          <div className="flex items-center justify-between gap-2 mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-amber-300">Imported Mappings</h3>
            <div className="flex items-center gap-2">
              <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">
                {importedSource ? `${importedSource} · ` : ''}{importedBindings.length} wired
                {importedUnattached.length ? ` · ${importedUnattached.length} not reproduced` : ''}
              </span>
              <button
                onClick={clearImported}
                aria-label="Clear imported controller mappings"
                className="shrink-0 px-1.5 py-0.5 rounded border border-white/15 text-[8px] font-black uppercase tracking-widest text-zinc-400 hover:border-rose-400/50 hover:text-rose-200"
              >
                Clear
              </button>
            </div>
          </div>
          <p className="text-[9px] font-mono text-zinc-400 leading-snug mb-1.5">
            The controller mappings from the imported project, attached to theDAW so the Sway plays it on Open.
          </p>
          <div className="max-h-40 overflow-y-auto space-y-0.5">
            {importedBindings.map((b, i) => (
              <div key={`b-${i}`} className="flex items-center gap-2 text-[9px] font-mono">
                <span className="w-16 shrink-0 text-amber-200/90">{ctrlLabel(b.isNote, b.channel, b.number)}</span>
                <span className="text-zinc-500">-&gt;</span>
                <span className="truncate text-zinc-300" title={b.label}>{b.label}</span>
              </div>
            ))}
            {importedUnattached.map((u, i) => (
              <div key={`u-${i}`} className="flex items-center gap-2 text-[9px] font-mono opacity-60">
                <span className="w-16 shrink-0 text-zinc-500">{ctrlLabel(false, u.channel, u.number)}</span>
                <span className="shrink-0 rounded bg-black/40 px-1 text-[8px] uppercase tracking-wider text-zinc-500">
                  {UNATTACHED_REASON[u.reason] ?? u.reason}
                </span>
                <span className="truncate text-zinc-500" title={u.detail}>{u.detail}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      <p className="mt-2.5 text-[8px] font-mono text-zinc-600 leading-snug">
        Learn binds a dimension to the next CC sent; routing drives DJ targets today (VJ, MAKE, and vocal join as the unified matrix lands). Camera pose comes from the VJ webcam (toggle GESTURE there) and routes like Sway, no learn needed.
      </p>
    </div>
  );
};
