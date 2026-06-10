import React from 'react';
import { Target, Layers } from 'lucide-react';
import { useGenerateParamsStore, type ChimeraAlignMode } from '../../state/generateParamsStore';

const ALIGN_LABELS: Record<ChimeraAlignMode, string> = {
  start: 'Start',
  downbeat: 'Downbeat',
  weave: 'Phrase Weave',
};

export const ChimeraControls: React.FC = () => {
  const clipsCount = useGenerateParamsStore((s) => s.chimera.clips.length);
  const targetBpm = useGenerateParamsStore((s) => s.chimera.targetBpm);
  const alignMode = useGenerateParamsStore((s) => s.chimera.alignMode);
  const weaveBars = useGenerateParamsStore((s) => s.chimera.weaveBars);
  const weaveTotalBars = useGenerateParamsStore((s) => s.chimera.weaveTotalBars);
  const weaveMaxPolyphony = useGenerateParamsStore((s) => s.chimera.weaveMaxPolyphony);
  const setChimeraField = useGenerateParamsStore((s) => s.setChimeraField);
  const updateChimeraClip = useGenerateParamsStore((s) => s.updateChimeraClip);
  const clips = useGenerateParamsStore((s) => s.chimera.clips);

  if (clipsCount === 0) return null;

  const isAuto = targetBpm === 'auto';

  const onAutoToggle = () => {
    if (isAuto) {
      setChimeraField('targetBpm', 120);
    } else {
      setChimeraField('targetBpm', 'auto');
      clips.forEach((c) => {
        if (c.isBase) updateChimeraClip(c.id, { isBase: false });
      });
    }
  };

  const onBpmChange = (raw: string) => {
    const n = parseFloat(raw);
    if (Number.isFinite(n) && n > 0) {
      setChimeraField('targetBpm', n);
      clips.forEach((c) => {
        if (c.isBase) updateChimeraClip(c.id, { isBase: false });
      });
    } else {
      setChimeraField('targetBpm', 'auto');
    }
  };

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[9px] font-mono">
      <div className="flex items-center gap-1">
        <Target className="w-2.5 h-2.5 text-purple-400" />
        <span className="text-zinc-400 uppercase tracking-widest">BPM</span>
        <input
          type="number"
          name="chimera-target-bpm"
          min={40}
          max={240}
          step={0.1}
          disabled={isAuto}
          value={isAuto ? '' : (typeof targetBpm === 'number' ? targetBpm : '')}
          placeholder={isAuto ? 'auto' : ''}
          onChange={(e) => onBpmChange(e.target.value)}
          className="compact-input w-16 disabled:opacity-40"
        />
        <button
          type="button"
          onClick={onAutoToggle}
          className={`px-1.5 py-0.5 rounded border text-[8px] uppercase tracking-widest transition-colors ${
            isAuto
              ? 'border-purple-400 bg-purple-500/20 text-purple-200'
              : 'border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5'
          }`}
          title="Auto = median of detected BPMs (or the Base clip's BPM if one is selected)"
        >
          Auto
        </button>
      </div>

      <div className="flex items-center gap-1">
        <Layers className="w-2.5 h-2.5 text-purple-400" />
        <span className="text-zinc-400 uppercase tracking-widest">Align</span>
        <select
          name="chimera-align-mode"
          value={alignMode}
          onChange={(e) => setChimeraField('alignMode', e.target.value as ChimeraAlignMode)}
          className="compact-input"
        >
          {(Object.keys(ALIGN_LABELS) as ChimeraAlignMode[]).map((m) => (
            <option key={m} value={m}>
              {ALIGN_LABELS[m]}
            </option>
          ))}
        </select>
      </div>

      {alignMode === 'weave' && (
        <>
          <div className="flex items-center gap-1">
            <span className="text-zinc-400 uppercase tracking-widest" title="Bars per chunk">Chunk</span>
            <input
              type="number"
              name="chimera-weave-bars"
              min={0}
              max={32}
              step={1}
              value={weaveBars}
              onChange={(e) => {
                const n = parseInt(e.target.value);
                setChimeraField('weaveBars', Number.isFinite(n) ? n : 0);
              }}
              className="compact-input w-12"
              title="Bars per chunk. 0 = auto (8)."
            />
          </div>
          <div className="flex items-center gap-1">
            <span className="text-zinc-400 uppercase tracking-widest" title="Minimum total length in bars">Total</span>
            <input
              type="number"
              name="chimera-weave-total-bars"
              min={0}
              max={256}
              step={4}
              value={weaveTotalBars}
              onChange={(e) => {
                const n = parseInt(e.target.value);
                setChimeraField('weaveTotalBars', Number.isFinite(n) ? n : 0);
              }}
              className="compact-input w-14"
              title="Minimum song length in bars. 0 = auto (90)."
            />
          </div>
          <div className="flex items-center gap-1">
            <span
              className="text-zinc-400 uppercase tracking-widest"
              title="Polyphony cap: how many source clips may overlap at any output moment (1-8). Lower = sparser; higher = denser."
            >
              Poly
            </span>
            <input
              type="number"
              name="chimera-weave-max-polyphony"
              min={1}
              max={8}
              step={1}
              value={weaveMaxPolyphony}
              onChange={(e) => {
                const n = parseInt(e.target.value);
                const clamped = Math.max(1, Math.min(8, Number.isFinite(n) ? n : 3));
                setChimeraField('weaveMaxPolyphony', clamped);
              }}
              className="compact-input w-10"
              title="Polyphony cap (1-8). Default 3."
            />
          </div>
        </>
      )}
    </div>
  );
};

