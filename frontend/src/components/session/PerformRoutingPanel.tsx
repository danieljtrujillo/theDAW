/**
 * Perform Routing panel.
 *
 * Assigns the Sway (or any MIDI controller) to the Perform grid. Three sections:
 *
 *  - Transport: learn a control for Scene Select (encoder), Launch, Stop,
 *    Scene +, Scene -. Turning the Scene Select encoder moves the highlighted
 *    scene; the Launch control fires it. Pads are intentionally NOT scene
 *    triggers here.
 *  - Scenes: bind any scene row to its own control for direct launch.
 *  - Modulation: route a Sway expressive dimension (the hand-tracking sensors)
 *    to a track's live Volume or Mute in the Perform mix.
 *
 * Learn is armed from here and captured by the grid's single MIDI listener, so
 * the panel and grid must both be mounted (they are: both live in the Perform
 * tab). Nothing is guessed — every binding is something the user performed.
 */
import React from 'react';
import type { DawProject } from '../../lib/dawImportClient';
import { performScenes, performTracks } from '../../lib/performModel';
import {
  usePerformRoutingStore,
  performCtrlLabel,
  PERFORM_FUNCTIONS,
  type PerformFn,
  type ModTarget,
} from '../../state/performRouting';
import { useSwayStore, SWAY_DIMS, type SwayDim } from '../../state/swayBus';
import { useMidiTriggerStore, enableMidi } from '../../state/midiTriggerStore';

const LearnButton: React.FC<{
  bound: string | null;
  listening: boolean;
  onLearn: () => void;
  onCancel: () => void;
  onClear: () => void;
  label: string;
}> = ({ bound, listening, onLearn, onCancel, onClear, label }) => (
  <span className="flex items-center gap-1 shrink-0">
    <button
      type="button"
      onClick={listening ? onCancel : onLearn}
      aria-label={listening ? `Cancel learning ${label}` : `Learn ${label}`}
      title={listening ? 'Listening — move the control to bind it' : 'Learn — bind the next control moved'}
      className={`px-1.5 py-0.5 rounded border text-[8px] font-black uppercase tracking-widest ${
        listening
          ? 'border-amber-400/60 bg-amber-400/15 text-amber-200 animate-pulse'
          : bound
            ? 'border-emerald-400/40 text-emerald-200/90 hover:border-emerald-400/70'
            : 'border-white/15 text-zinc-300 hover:border-emerald-400/50 hover:text-emerald-200'
      }`}
    >
      {listening ? 'Listen' : bound ? bound : 'Learn'}
    </button>
    {bound && !listening && (
      <button
        type="button"
        onClick={onClear}
        aria-label={`Clear ${label} binding`}
        title="Clear binding"
        className="text-[10px] leading-none text-zinc-600 hover:text-rose-300"
      >
        x
      </button>
    )}
  </span>
);

export const PerformRoutingPanel: React.FC<{ project: DawProject }> = ({ project }) => {
  const scenes = React.useMemo(() => performScenes(project), [project]);
  const tracks = React.useMemo(() => performTracks(project), [project]);

  const transport = usePerformRoutingStore((s) => s.transport);
  const sceneCtrls = usePerformRoutingStore((s) => s.sceneCtrls);
  const trackMods = usePerformRoutingStore((s) => s.trackMods);
  const learn = usePerformRoutingStore((s) => s.learn);
  const arm = usePerformRoutingStore((s) => s.arm);
  const clearFn = usePerformRoutingStore((s) => s.clearFn);
  const clearScene = usePerformRoutingStore((s) => s.clearScene);
  const addMod = usePerformRoutingStore((s) => s.addMod);
  const removeMod = usePerformRoutingStore((s) => s.removeMod);

  const swayValues = useSwayStore((s) => s.values);
  const midiEnabled = useMidiTriggerStore((s) => s.enabled);

  const [modDim, setModDim] = React.useState<SwayDim>('strike');
  const [modTrack, setModTrack] = React.useState(0);
  const [modTarget, setModTarget] = React.useState<ModTarget>('volume');

  const dimLabel = (dim: SwayDim): string => SWAY_DIMS.find((d) => d.id === dim)?.label ?? dim;
  const trackLabel = (index: number): string => `${String(index + 1).padStart(2, '0')} ${tracks[index]?.name ?? `Track ${index + 1}`}`;

  return (
    <div className="h-full overflow-y-auto p-2.5 text-zinc-200">
      {!midiEnabled && (
        <div className="mb-2 flex items-center gap-2">
          <button
            type="button"
            onClick={() => enableMidi()}
            className="shrink-0 px-2 py-0.5 rounded border border-amber-400/60 bg-amber-400/15 text-amber-200 text-[8px] font-black uppercase tracking-widest hover:bg-amber-400/25"
          >
            Enable MIDI
          </button>
          <span className="text-[9px] font-mono text-amber-300/80 leading-snug">
            MIDI input is off. Turn it on to receive the Sway, then Learn the controls below.
          </span>
        </div>
      )}

      <div className="grid gap-x-4 gap-y-3 lg:grid-cols-3">
        {/* Transport + scene control */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-300">Transport</h3>
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">encoder + buttons</span>
          </div>
          <div className="space-y-1">
            {PERFORM_FUNCTIONS.map((fn) => {
              const bound = transport[fn.id];
              const listening = learn?.kind === 'fn' && learn.fn === fn.id;
              return (
                <div key={fn.id} className="flex items-center gap-1.5 rounded border border-white/10 bg-white/3 px-1.5 py-1">
                  <span className="min-w-0 flex-1">
                    <span className="block text-[10px] font-bold uppercase tracking-wider text-emerald-200">{fn.label}</span>
                    <span className="block text-[8px] font-mono text-zinc-500 truncate">{fn.hint}</span>
                  </span>
                  <LearnButton
                    label={fn.label}
                    bound={bound ? performCtrlLabel(bound) : null}
                    listening={listening}
                    onLearn={() => arm({ kind: 'fn', fn: fn.id as PerformFn })}
                    onCancel={() => arm(null)}
                    onClear={() => clearFn(fn.id as PerformFn)}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* Per-scene direct launch */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-sky-300">Scenes</h3>
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">direct launch</span>
          </div>
          <div className="space-y-1 max-h-56 overflow-y-auto pr-0.5">
            {scenes.map((sceneName, sceneIndex) => {
              const bound = sceneCtrls[sceneIndex];
              const listening = learn?.kind === 'scene' && learn.scene === sceneIndex;
              return (
                <div key={`${sceneName}-${sceneIndex}`} className="flex items-center gap-1.5 rounded border border-white/10 bg-white/3 px-1.5 py-1">
                  <span className="min-w-0 flex-1 truncate text-[10px] font-bold text-sky-200">
                    {String(sceneIndex + 1).padStart(2, '0')} {sceneName}
                  </span>
                  <LearnButton
                    label={`scene ${sceneIndex + 1}`}
                    bound={bound ? performCtrlLabel(bound) : null}
                    listening={listening}
                    onLearn={() => arm({ kind: 'scene', scene: sceneIndex })}
                    onCancel={() => arm(null)}
                    onClear={() => clearScene(sceneIndex)}
                  />
                </div>
              );
            })}
          </div>
        </section>

        {/* Sway dim -> Perform-mix modulation */}
        <section>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-[10px] font-black uppercase tracking-[0.2em] text-fuchsia-300">Modulation</h3>
            <span className="text-[8px] font-mono uppercase tracking-widest text-zinc-500">hand sensors -&gt; mix</span>
          </div>

          {/* Live dim meters */}
          <div className="mb-2 grid grid-cols-2 gap-x-2 gap-y-0.5">
            {SWAY_DIMS.map((d) => (
              <div key={d.id} className="flex items-center gap-1">
                <span className="w-11 shrink-0 text-[8px] font-mono uppercase tracking-wider text-fuchsia-200/80">{d.label}</span>
                <div className="flex-1 h-1.5 rounded bg-black/50 overflow-hidden" aria-hidden="true">
                  <div className="h-full bg-fuchsia-500/70" style={{ width: `${Math.round((swayValues[d.id] ?? 0) * 100)}%` }} />
                </div>
              </div>
            ))}
          </div>

          {/* Add a modulation route */}
          <div className="flex flex-wrap items-center gap-1 rounded border border-white/10 bg-white/3 px-1.5 py-1.5">
            <label htmlFor="perform-mod-dim" className="sr-only">Sway dimension</label>
            <select
              id="perform-mod-dim"
              name="perform-mod-dim"
              value={modDim}
              onChange={(e) => setModDim(e.target.value as SwayDim)}
              className="bg-black/60 border border-white/10 rounded px-1 py-0.5 text-[9px] text-zinc-200 outline-none focus:border-fuchsia-500/50"
            >
              {SWAY_DIMS.map((d) => (
                <option key={d.id} value={d.id}>{d.label}</option>
              ))}
            </select>
            <span className="text-[9px] text-zinc-500">-&gt;</span>
            <label htmlFor="perform-mod-track" className="sr-only">Track</label>
            <select
              id="perform-mod-track"
              name="perform-mod-track"
              value={modTrack}
              onChange={(e) => setModTrack(Number(e.target.value))}
              className="bg-black/60 border border-white/10 rounded px-1 py-0.5 text-[9px] text-zinc-200 outline-none focus:border-fuchsia-500/50 max-w-32"
            >
              {tracks.map((t, i) => (
                <option key={`${t.name}-${i}`} value={i}>{trackLabel(i)}</option>
              ))}
            </select>
            <label htmlFor="perform-mod-target" className="sr-only">Modulation target</label>
            <select
              id="perform-mod-target"
              name="perform-mod-target"
              value={modTarget}
              onChange={(e) => setModTarget(e.target.value as ModTarget)}
              className="bg-black/60 border border-white/10 rounded px-1 py-0.5 text-[9px] text-zinc-200 outline-none focus:border-fuchsia-500/50"
            >
              <option value="volume">Volume</option>
              <option value="mute">Mute</option>
            </select>
            <button
              type="button"
              onClick={() => addMod(modDim, modTrack, modTarget)}
              disabled={tracks.length === 0}
              className="shrink-0 px-1.5 py-0.5 rounded border border-fuchsia-500/40 bg-fuchsia-500/10 text-[8px] font-black uppercase tracking-widest text-fuchsia-200 hover:bg-fuchsia-500/20 disabled:opacity-40"
            >
              Add
            </button>
          </div>

          {/* Existing modulation routes */}
          {trackMods.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {trackMods.map((m) => (
                <div key={m.id} className="flex items-center gap-1.5 text-[9px] font-mono">
                  <span className="text-fuchsia-200/90">{dimLabel(m.dim)}</span>
                  <span className="text-zinc-500">-&gt;</span>
                  <span className="min-w-0 flex-1 truncate text-zinc-300">
                    {trackLabel(m.trackIndex)} · {m.target === 'volume' ? 'Volume' : 'Mute'}
                  </span>
                  <button
                    type="button"
                    onClick={() => removeMod(m.id)}
                    aria-label={`Remove ${dimLabel(m.dim)} modulation of ${trackLabel(m.trackIndex)}`}
                    className="shrink-0 text-[10px] leading-none text-zinc-600 hover:text-rose-300"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <p className="mt-2.5 text-[8px] font-mono text-zinc-600 leading-snug">
        Modulation reads the Sway dims after they are learned in the SWAY panel (a dim with no CC sends nothing).
        Learn a control here by clicking Learn, then moving that control on the Sway.
      </p>
    </div>
  );
};
