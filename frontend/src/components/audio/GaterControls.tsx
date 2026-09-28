/**
 * GaterControls — custom UI for the Gater rack effect, rendered by FxRack in place
 * of the generic sliders. Adds a tempo-sync toggle: free-run uses the Rate (Hz)
 * knob, while sync derives the rate from a musical division plus BPM. Shape is a
 * proper dropdown (sine / square / saw).
 *
 * Values round-trip through the same ChainEntry.params the audio factory reads, so
 * the controls drive both the live preview and the offline bounce.
 */

import { SlideTrack } from './SlideTrack';
import { GATER_DIVISIONS } from '../../lib/rackEffects';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../../lib/tempoMap';

const SHAPES = ['Sine', 'Square', 'Saw'] as const;

interface GaterControlsProps {
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
  idPrefix: string;
  /** Current project tempo, offered for the "match project" button when synced. */
  projectBpm?: number;
  /** The panel's gesture boundary, straight through to the SLIDE sliders: one
   *  start before the first `onChange` of a drag / key press / wheel burst and
   *  one end after its last. Lets a consumer recording a gesture (automation
   *  touch) stop guessing it from a deadline. See lib/gestureTracker.ts. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
}

export function GaterControls({ params, onChange, idPrefix, projectBpm, onGestureStart, onGestureEnd }: GaterControlsProps) {
  const synced = (params.sync ?? 0) >= 0.5;
  const shape = Math.round(params.shape ?? 1);
  const depth = params.depth ?? 0.8;
  const rate = params.rate ?? 6;
  const div = Math.round(params.div ?? 3);
  const bpm = Math.round(params.bpm ?? 120);

  const set = (key: string, value: number) => onChange({ ...params, [key]: value });
  const shapeId = `${idPrefix}-gater-shape`;
  const divId = `${idPrefix}-gater-div`;
  const depthId = `${idPrefix}-gater-depth`;
  const rateId = `${idPrefix}-gater-rate`;
  const bpmId = `${idPrefix}-gater-bpm`;

  // Enabling sync seeds the BPM from the project tempo so it lines up immediately.
  const toggleSync = () => {
    if (synced) set('sync', 0);
    else onChange({ ...params, sync: 1, bpm: projectBpm ?? bpm });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center gap-2">
        <span className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0">Clock</span>
        {/* A fixed name with aria-pressed: the visible word flips with the
            state, so reading it as the name announced the opposite mode. */}
        <button
          onClick={toggleSync}
          aria-pressed={synced}
          aria-label="Clock: tempo sync"
          title={synced ? 'Tempo-synced: rate follows the division and BPM' : 'Free-run: rate set in Hz'}
          className={`font-display text-xs font-bold uppercase tracking-wider px-2 py-1 rounded border transition-colors ${synced ? 'border-purple-500/50 bg-purple-500/15 text-purple-100' : 'border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100'}`}
        >
          {synced ? 'SYNC' : 'FREE'}
        </button>
      </div>

      {synced ? (
        <>
          <div className="flex items-center gap-2">
            <label htmlFor={divId} className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0">Division</label>
            <select
              id={divId}
              name={divId}
              value={div}
              onChange={(e) => set('div', Number(e.target.value))}
              className="flex-1 form-select px-2 py-1 font-sans text-xs font-bold"
              style={{ colorScheme: 'dark' }}
            >
              {GATER_DIVISIONS.map((label, i) => (
                <option key={label} value={i}>{label}</option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-2">
            <span id={bpmId} className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0">BPM</span>
            <SlideTrack value={bpm} min={TEMPO_BPM_MIN} max={TEMPO_BPM_MAX} step={1} defaultValue={projectBpm ?? 120}
              ariaLabelledBy={bpmId} className="flex-1" onChange={(v) => set('bpm', v)}
              onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
            {projectBpm != null && projectBpm !== bpm && (
              <button
                onClick={() => set('bpm', projectBpm)}
                aria-label={`Match project tempo (${projectBpm})`}
                title={`Match the project tempo (${projectBpm})`}
                className="font-sans text-xs font-bold tabular-nums px-1.5 py-1 rounded border border-white/10 bg-black/30 text-zinc-400 hover:text-zinc-100 shrink-0"
              >
                ={projectBpm}
              </button>
            )}
            {(projectBpm == null || projectBpm === bpm) && (
              <span className="font-sans text-xs font-bold text-zinc-300 w-10 shrink-0 text-right tabular-nums">{bpm}</span>
            )}
          </div>
        </>
      ) : (
        <SliderRow labelId={rateId} label="Rate" value={rate} min={0.1} max={30} step={0.1} dflt={6} unit="Hz"
          onChange={(v) => set('rate', v)} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
      )}

      <SliderRow labelId={depthId} label="Depth" value={depth} min={0} max={1} step={0.01} dflt={0.8}
        onChange={(v) => set('depth', v)} onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />

      <div className="flex items-center gap-2">
        <label htmlFor={shapeId} className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0">Shape</label>
        <select
          id={shapeId}
          name={shapeId}
          value={shape}
          onChange={(e) => set('shape', Number(e.target.value))}
          className="flex-1 bg-zinc-900 border border-white/20 rounded px-2 py-1 font-sans text-xs font-bold text-zinc-100 outline-none focus:border-purple-500/60 cursor-pointer"
          style={{ colorScheme: 'dark' }}
        >
          {SHAPES.map((label, i) => (
            <option key={label} value={i}>{label}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

function SliderRow({
  labelId, label, value, min, max, step, dflt, unit, onChange, onGestureStart, onGestureEnd,
}: {
  labelId: string; label: string; value: number; min: number; max: number;
  step: number; dflt: number; unit?: string; onChange: (v: number) => void;
  onGestureStart?: () => void; onGestureEnd?: () => void;
}) {
  const decimals = step < 1 ? (step < 0.1 ? 2 : 1) : 0;
  return (
    <div className="flex items-center gap-2">
      <span id={labelId} className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0">{label}</span>
      <SlideTrack value={value} min={min} max={max} step={step} defaultValue={dflt}
        ariaLabelledBy={labelId} className="flex-1" onChange={onChange}
        onGestureStart={onGestureStart} onGestureEnd={onGestureEnd} />
      <span className="font-sans text-xs font-bold text-zinc-300 w-16 shrink-0 text-right tabular-nums">
        {value.toFixed(decimals)}{unit ? ` ${unit}` : ''}
      </span>
    </div>
  );
}
