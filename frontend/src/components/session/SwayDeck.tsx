/**
 * The Sway deck in PERFORM — the EXACT SwayCommand schematic (surface.js,
 * ported verbatim) acting as the assignment surface for the loaded project.
 *
 * Click any control on the deck and the panel beside it shows what that
 * control does and lets you add routes:
 *   pads      -> launch a scene (bound by the pad's chromatic note)
 *   knobs / XY / gestures -> a track's volume or mute, or ANY parameter of the
 *                            track's live FX chain (the same chain the grid
 *                            plays through), on the factory CC for that control
 *   buttons   -> a transport function, bound by learn (press the real button)
 *
 * Live values animate the schematic exactly as the cockpit draws them: knob
 * arcs, pad flashes, the XY dot riding the sensor field, gesture bars, LEDs.
 */
import React from 'react';
import { X, Zap } from 'lucide-react';
import type { DawProject } from '../../lib/dawImportClient';
import { performScenes, performTracks } from '../../lib/performModel';
import { dawDeviceToEffectNode } from '../../lib/dawEffectMap';
import { getRackEffect } from '../../lib/rackEffects';
import {
  usePerformRoutingStore,
  performCtrlLabel,
  PERFORM_FUNCTIONS,
  type CcMod,
  type PerformFn,
} from '../../state/performRouting';
import { createSurface, type SurfaceHandle } from './swaydeck/surface';
import { startDeckState, getDeckIo, deckMonitor, ctlToCc, padToNote } from './swaydeck/deckState';
import './swaydeck/swaydeck.css';

/** Human name for a control id. */
const ctlLabel = (ctl: string): string => {
  if (ctl.startsWith('pad:')) return `PAD ${ctl.slice(4)}`;
  if (ctl.startsWith('knob:')) return `KNOB ${ctl.slice(5)}`;
  if (ctl.startsWith('button:')) return `BUTTON ${ctl.slice(7)}`;
  if (ctl === 'xy:x') return 'X';
  if (ctl === 'xy:y') return 'Y';
  return ctl.replace('gesture:', '').toUpperCase();
};

interface FxParamOption {
  deviceIndex: number;
  deviceLabel: string;
  effect: string;
  paramKey: string;
  min: number;
  max: number;
}

/** The routable FX params of one track, indexed EXACTLY like the Perform
 *  grid's chain entries (flattened non-instrument, non-rack devices; vst3
 *  entries exist in the index but are not routable). */
function fxParamsForTrack(project: DawProject, trackIndex: number): FxParamOption[] {
  const track = performTracks(project)[trackIndex];
  if (!track) return [];
  const out: FxParamOption[] = [];
  const devices = (track.devices ?? []).filter((d) => !d.is_instrument && !d.is_rack);
  devices.forEach((d, i) => {
    const node = dawDeviceToEffectNode(d);
    if (node.effect_name === 'vst3') return;
    const def = getRackEffect(node.effect_name);
    if (!def) return;
    for (const p of def.params) {
      out.push({
        deviceIndex: i,
        deviceLabel: d.name || def.label,
        effect: node.effect_name,
        paramKey: p.key,
        min: p.min,
        max: p.max,
      });
    }
  });
  return out;
}

export const SwayDeck: React.FC<{ project: DawProject }> = ({ project }) => {
  const hostRef = React.useRef<HTMLDivElement | null>(null);
  const surfRef = React.useRef<SurfaceHandle | null>(null);
  const [selected, setSelected] = React.useState<string | null>(null);

  const scenes = React.useMemo(() => performScenes(project), [project]);
  const tracks = React.useMemo(() => performTracks(project), [project]);

  const ccMods = usePerformRoutingStore((s) => s.ccMods);
  const setCcMods = usePerformRoutingStore((s) => s.setCcMods);
  const removeCcMod = usePerformRoutingStore((s) => s.removeCcMod);
  const sceneCtrls = usePerformRoutingStore((s) => s.sceneCtrls);
  const bindScene = usePerformRoutingStore((s) => s.bindScene);
  const clearScene = usePerformRoutingStore((s) => s.clearScene);
  const transport = usePerformRoutingStore((s) => s.transport);
  const learn = usePerformRoutingStore((s) => s.learn);
  const arm = usePerformRoutingStore((s) => s.arm);
  const clearFn = usePerformRoutingStore((s) => s.clearFn);

  // ── mount the verbatim surface + drive it per frame ──────────────────────
  React.useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    startDeckState();
    const surf = createSurface(host, { onSelect: (ctl) => setSelected((cur) => (cur === ctl ? null : ctl)) });
    surfRef.current = surf;
    let raf = 0;
    const tick = () => {
      raf = requestAnimationFrame(tick);
      surf.update(getDeckIo(), deckMonitor);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      surfRef.current = null;
      host.innerHTML = '';
    };
  }, []);

  // Reticle follows the selection.
  React.useEffect(() => {
    surfRef.current?.select(selected);
    surfRef.current?.setArmed(!!learn);
  }, [selected, learn]);

  // Pad labels = the scene each pad launches (bound by its chromatic note).
  React.useEffect(() => {
    const labels: (string | null)[] = new Array(16).fill(null);
    for (let padIdx = 0; padIdx < 16; padIdx++) {
      const note = padToNote(padIdx);
      for (const [sceneKey, ctrl] of Object.entries(sceneCtrls)) {
        if (ctrl.isNote && ctrl.number === note) {
          labels[padIdx] = scenes[Number(sceneKey)] ?? `Scene ${Number(sceneKey) + 1}`;
          break;
        }
      }
    }
    const lit = PERFORM_FUNCTIONS.map((f) => !!transport[f.id]);
    surfRef.current?.refresh(labels, lit);
    surfRef.current?.setStatus(`${scenes.length} scenes · ${tracks.length} tracks`);
  }, [sceneCtrls, scenes, tracks.length, transport]);

  // ── assignment state for the panel ───────────────────────────────────────
  const cc = selected ? ctlToCc(selected) : null;
  const isPad = !!selected?.startsWith('pad:');
  const isButton = !!selected?.startsWith('button:');
  const padIdx = isPad ? Number(selected!.slice(4)) : -1;

  /** Routes already on the selected CC control. */
  const ctlRoutes = React.useMemo(
    () => (cc == null ? [] : ccMods.filter((m) => !m.isNote && m.number === cc)),
    [cc, ccMods],
  );
  /** Scene bound to the selected pad, if any. */
  const padScene = React.useMemo(() => {
    if (padIdx < 0) return null;
    const note = padToNote(padIdx);
    for (const [k, ctrl] of Object.entries(sceneCtrls)) {
      if (ctrl.isNote && ctrl.number === note) return Number(k);
    }
    return null;
  }, [padIdx, sceneCtrls]);

  const [pickTrack, setPickTrack] = React.useState(0);
  const [pickKind, setPickKind] = React.useState<'volume' | 'mute' | 'fx'>('volume');
  const [pickFx, setPickFx] = React.useState(0);
  const fxOptions = React.useMemo(
    () => fxParamsForTrack(project, pickTrack),
    [project, pickTrack],
  );

  const addRoute = () => {
    if (cc == null) return;
    const trackName = tracks[pickTrack]?.name ?? `Track ${pickTrack + 1}`;
    const base = { channel: -1, number: cc, isNote: false, trackIndex: pickTrack };
    let mod: CcMod;
    if (pickKind === 'fx') {
      const fx = fxOptions[pickFx];
      if (!fx) return;
      mod = {
        ...base,
        id: `deck:${cc}:${pickTrack}:fx:${fx.deviceIndex}:${fx.paramKey}`,
        target: 'fx',
        deviceIndex: fx.deviceIndex,
        paramKey: fx.paramKey,
        min: fx.min,
        max: fx.max,
        label: `${trackName} · ${fx.deviceLabel} · ${fx.paramKey}`,
      };
    } else {
      mod = {
        ...base,
        id: `deck:${cc}:${pickTrack}:${pickKind}`,
        target: pickKind,
        label: `${trackName} · ${pickKind === 'volume' ? 'Vol' : 'Mute'}`,
      };
    }
    if (!ccMods.some((m) => m.id === mod.id)) setCcMods([...ccMods, mod]);
  };

  return (
    <div className="flex items-stretch gap-2 min-h-0">
      {/* the schematic */}
      <div ref={hostRef} className="sway-deck min-w-0 grow" style={{ height: 168 }} />

      {/* assignment panel — SwayCommand's right-rail idea, compact */}
      <aside className="w-64 shrink-0 border-l border-white/10 pl-2 py-1 flex flex-col gap-1.5 text-zinc-200 overflow-y-auto">
        {!selected ? (
          <p className="text-[9px] font-mono leading-relaxed text-zinc-500 m-auto px-2 text-center">
            click a control on the deck —<br />
            pads launch scenes, knobs / XY / gestures drive volume, mute or any
            FX parameter, buttons bind transport
          </p>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-cyan-300">{ctlLabel(selected)}</span>
              {cc != null && <span className="text-[8px] font-mono text-zinc-500">CC{cc}</span>}
              {isPad && <span className="text-[8px] font-mono text-zinc-500">note {padToNote(padIdx)}</span>}
              <button
                type="button"
                onClick={() => setSelected(null)}
                aria-label="Deselect"
                className="ml-auto h-4 w-4 grid place-items-center text-zinc-600 hover:text-zinc-200"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            {/* pad -> scene */}
            {isPad && (
              <div className="flex flex-col gap-0.5 min-h-0 overflow-y-auto">
                {padScene != null && (
                  <button
                    type="button"
                    onClick={() => clearScene(padScene)}
                    className="flex items-center gap-1 rounded border border-sky-400/40 bg-sky-400/10 px-1.5 py-0.5 text-[9px] font-mono text-sky-200 hover:border-rose-400/50"
                    title="Click to unassign"
                  >
                    <Zap className="w-2.5 h-2.5" /> launches {scenes[padScene]} <X className="w-2.5 h-2.5 ml-auto" />
                  </button>
                )}
                {scenes.map((name, i) => (
                  <button
                    key={`${name}-${i}`}
                    type="button"
                    onClick={() => bindScene(i, { isNote: true, channel: -1, number: padToNote(padIdx) })}
                    disabled={padScene === i}
                    className="text-left rounded border border-white/10 px-1.5 py-0.5 text-[9px] font-mono text-zinc-300 hover:border-sky-400/50 hover:text-sky-200 disabled:opacity-40"
                  >
                    {String(i + 1).padStart(2, '0')} {name}
                  </button>
                ))}
              </div>
            )}

            {/* button -> transport fn (learn: press the physical button) */}
            {isButton && (
              <div className="flex flex-col gap-0.5">
                {PERFORM_FUNCTIONS.map((fn) => {
                  const bound = transport[fn.id];
                  const listening = learn?.kind === 'fn' && learn.fn === fn.id;
                  return (
                    <button
                      key={fn.id}
                      type="button"
                      onClick={() => arm(listening ? null : { kind: 'fn', fn: fn.id as PerformFn })}
                      onContextMenu={(e) => { e.preventDefault(); clearFn(fn.id as PerformFn); }}
                      title={`${fn.hint}${bound ? ` · bound ${performCtrlLabel(bound)} · right-click clears` : ''}`}
                      className={`text-left rounded border px-1.5 py-0.5 text-[9px] font-mono ${
                        listening
                          ? 'border-amber-400/70 bg-amber-400/15 text-amber-200 animate-pulse'
                          : bound
                            ? 'border-emerald-400/40 text-emerald-200'
                            : 'border-white/10 text-zinc-300 hover:border-white/25'
                      }`}
                    >
                      {fn.label}
                      {listening ? ' — press the button…' : bound ? ` · ${performCtrlLabel(bound)}` : ''}
                    </button>
                  );
                })}
              </div>
            )}

            {/* CC control -> volume / mute / fx param */}
            {cc != null && (
              <>
                {ctlRoutes.length > 0 && (
                  <div className="flex flex-col gap-0.5">
                    {ctlRoutes.map((m) => (
                      <span
                        key={m.id}
                        className="flex items-center gap-1 rounded border border-emerald-400/25 bg-emerald-400/5 px-1.5 py-0.5 text-[8px] font-mono text-emerald-200"
                      >
                        <Zap className="w-2.5 h-2.5 shrink-0" />
                        <span className="truncate">{m.label}</span>
                        <button
                          type="button"
                          onClick={() => removeCcMod(m.id)}
                          aria-label={`Remove route ${m.label}`}
                          className="ml-auto h-3.5 w-3.5 grid place-items-center text-zinc-500 hover:text-rose-300"
                        >
                          <X className="w-2.5 h-2.5" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="flex flex-col gap-1">
                  <label htmlFor="deck-route-track" className="sr-only">Track</label>
                  <select
                    id="deck-route-track"
                    name="deck-route-track"
                    value={pickTrack}
                    onChange={(e) => { setPickTrack(Number(e.target.value)); setPickFx(0); }}
                    className="bg-black/60 border border-white/10 rounded px-1 py-0.5 text-[9px] text-zinc-200 outline-none focus:border-cyan-500/50"
                  >
                    {tracks.map((t, i) => (
                      <option key={`${t.name}-${i}`} value={i}>{String(i + 1).padStart(2, '0')} {t.name}</option>
                    ))}
                  </select>
                  <div className="flex items-center gap-1">
                    {(['volume', 'mute', 'fx'] as const).map((k) => (
                      <button
                        key={k}
                        type="button"
                        onClick={() => setPickKind(k)}
                        aria-pressed={pickKind === k}
                        className={`h-5 px-1.5 rounded border text-[8px] font-black uppercase tracking-wider ${
                          pickKind === k
                            ? 'border-cyan-400/60 bg-cyan-400/10 text-cyan-200'
                            : 'border-white/15 text-zinc-400 hover:border-white/30'
                        }`}
                      >
                        {k}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={addRoute}
                      disabled={pickKind === 'fx' && fxOptions.length === 0}
                      aria-label="Add route"
                      title="Add this route"
                      className="ml-auto h-5 w-6 grid place-items-center rounded border border-cyan-500/40 bg-cyan-500/10 text-cyan-200 hover:bg-cyan-500/25 disabled:opacity-40"
                    >
                      <Zap className="w-3 h-3" />
                    </button>
                  </div>
                  {pickKind === 'fx' && (
                    <>
                      <label htmlFor="deck-route-fx" className="sr-only">Effect parameter</label>
                      <select
                        id="deck-route-fx"
                        name="deck-route-fx"
                        value={pickFx}
                        onChange={(e) => setPickFx(Number(e.target.value))}
                        className="bg-black/60 border border-white/10 rounded px-1 py-0.5 text-[9px] text-zinc-200 outline-none focus:border-cyan-500/50"
                      >
                        {fxOptions.length === 0 ? (
                          <option value={0}>no live FX on this track</option>
                        ) : (
                          fxOptions.map((f, i) => (
                            <option key={`${f.deviceIndex}-${f.paramKey}`} value={i}>
                              {f.deviceLabel} · {f.paramKey}
                            </option>
                          ))
                        )}
                      </select>
                    </>
                  )}
                </div>
              </>
            )}
          </>
        )}
      </aside>
    </div>
  );
};
