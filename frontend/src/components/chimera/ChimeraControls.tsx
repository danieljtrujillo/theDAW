import React from 'react';
import { Target, Layers } from 'lucide-react';
import { TEMPO_BPM_MAX, TEMPO_BPM_MIN } from '../../lib/tempoMap';
import { useTempoField } from '../../lib/useTempoField';
import {
  useGenerateParamsStore,
  type ChimeraAlignMode,
  type ChimeraArc,
  type ChimeraHarmonyMode,
  type ChimeraHealMode,
} from '../../state/generateParamsStore';

const ALIGN_LABELS: Record<ChimeraAlignMode, string> = {
  start: 'Start',
  downbeat: 'Downbeat',
  weave: 'CRISPR',
};

/** Bars per phrase; phrases start on real downbeats. */
const PHRASE_OPTIONS = [4, 8, 16];

const HARMONY_LABELS: Record<ChimeraHarmonyMode, string> = {
  auto: 'Auto',
  off: 'Off',
};

const ARC_LABELS: Record<ChimeraArc, string> = {
  song: 'Song',
  rise: 'Rise',
  flat: 'Flat',
};

const HEAL_LABELS: Record<ChimeraHealMode, string> = {
  off: 'Off',
  preserve: 'Preserve',
  polish: 'Polish',
};

const LABEL = 'text-zinc-400 uppercase tracking-widest cursor-default';
/** The row's value fields: compact-input's box, with its 11px mono face replaced by 12px bold sans
 *  (utilities win over the components layer compact-input lives in). */
const FIELD = 'compact-input text-xs font-sans font-bold';

export const ChimeraControls: React.FC = () => {
  const clipsCount = useGenerateParamsStore((s) => s.chimera.clips.length);
  const targetBpm = useGenerateParamsStore((s) => s.chimera.targetBpm);
  const alignMode = useGenerateParamsStore((s) => s.chimera.alignMode);
  const weaveBars = useGenerateParamsStore((s) => s.chimera.weaveBars);
  const weaveTotalBars = useGenerateParamsStore((s) => s.chimera.weaveTotalBars);
  const weaveMaxPolyphony = useGenerateParamsStore((s) => s.chimera.weaveMaxPolyphony);
  // v2 fields: read with fallbacks so a stale in-memory store (hot reload)
  // cannot render an undefined select value
  const harmony = useGenerateParamsStore((s) => s.chimera.harmony ?? 'auto');
  const arc = useGenerateParamsStore((s) => s.chimera.arc ?? 'song');
  const heal = useGenerateParamsStore((s) => s.chimera.heal ?? 'off');
  const engine = useGenerateParamsStore((s) => s.chimera.engine ?? 'v2');
  const setChimeraField = useGenerateParamsStore((s) => s.setChimeraField);
  const updateChimeraClip = useGenerateParamsStore((s) => s.updateChimeraClip);
  const clips = useGenerateParamsStore((s) => s.chimera.clips);

  // Above the early return, so the hook runs on every render. Typing keeps a draft (lib/useTempoField)
  // that lands on Enter or blur, clamped to 20-300; an arrow or spin step lands at once. An emptied
  // field means auto, as it always has.
  const bpmField = useTempoField(
    typeof targetBpm === 'number' ? targetBpm : '',
    (bpm) => {
      setChimeraField('targetBpm', bpm);
      clips.forEach((c) => {
        if (c.isBase) updateChimeraClip(c.id, { isBase: false });
      });
    },
    { onEmpty: () => setChimeraField('targetBpm', 'auto') },
  );

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

  // a stored phrase length outside the preset set is shown as an extra
  // option so nothing is silently changed under the user
  const phraseOptions = PHRASE_OPTIONS.includes(weaveBars)
    ? PHRASE_OPTIONS
    : [...PHRASE_OPTIONS, weaveBars].sort((a, b) => a - b);

  return (
    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-xs font-sans font-bold">
      <div className="flex items-center gap-1">
        <Target className="w-2.5 h-2.5 text-purple-400" />
        <label htmlFor="chimera-target-bpm" className={LABEL}>BPM</label>
        <input
          id="chimera-target-bpm"
          type="number"
          name="chimera-target-bpm"
          min={TEMPO_BPM_MIN}
          max={TEMPO_BPM_MAX}
          step={0.1}
          disabled={isAuto}
          {...bpmField}
          value={isAuto ? '' : bpmField.value}
          placeholder={isAuto ? 'auto' : ''}
          className={`${FIELD} w-16 disabled:opacity-40`}
        />
        <button
          type="button"
          onClick={onAutoToggle}
          aria-pressed={isAuto}
          className={`px-1.5 py-0.5 rounded border text-xs font-display font-bold uppercase tracking-wider transition-colors ${
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
        <label htmlFor="chimera-align-mode" className={LABEL}>Align</label>
        <select
          id="chimera-align-mode"
          name="chimera-align-mode"
          value={alignMode}
          onChange={(e) => setChimeraField('alignMode', e.target.value as ChimeraAlignMode)}
          className={FIELD}
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
            <label
              htmlFor="chimera-weave-bars"
              className={LABEL}
              title="Bars per phrase; phrases start on real downbeats."
            >
              Phrase
            </label>
            <select
              id="chimera-weave-bars"
              name="chimera-weave-bars"
              value={weaveBars}
              onChange={(e) => {
                const n = parseInt(e.target.value);
                setChimeraField('weaveBars', Number.isFinite(n) ? n : 8);
              }}
              className={FIELD}
              title="Bars per phrase; phrases start on real downbeats."
            >
              {phraseOptions.map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'auto' : n}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <label
              htmlFor="chimera-weave-total-bars"
              className={LABEL}
              title="0 = size the mashup to the generation Length so the whole arc reaches the model"
            >
              Total
            </label>
            <input
              id="chimera-weave-total-bars"
              type="number"
              name="chimera-weave-total-bars"
              min={0}
              max={256}
              step={4}
              value={weaveTotalBars}
              placeholder="match length"
              onChange={(e) => {
                const n = parseInt(e.target.value);
                setChimeraField('weaveTotalBars', Number.isFinite(n) ? n : 0);
              }}
              className={`${FIELD} w-14`}
              title="0 = match the generation Length"
            />
          </div>
          <div className="flex items-center gap-1">
            <label
              htmlFor="chimera-weave-max-polyphony"
              className={LABEL}
              title="Polyphony cap: how many source clips may overlap at any output moment (1-8), transition tails included. Lower = sparser; higher = denser."
            >
              Poly
            </label>
            <input
              id="chimera-weave-max-polyphony"
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
              className={`${FIELD} w-10`}
              title="Polyphony cap (1-8). Default 3."
            />
          </div>
          <div className="flex items-center gap-1">
            <label
              htmlFor="chimera-harmony"
              className={LABEL}
              title="Auto picks one Camelot-compatible key and pitch-shifts clips by at most 2 semitones; drums and uncertain keys are never shifted."
            >
              Key
            </label>
            <select
              id="chimera-harmony"
              name="chimera-harmony"
              value={harmony}
              onChange={(e) => setChimeraField('harmony', e.target.value as ChimeraHarmonyMode)}
              className={FIELD}
              title="Auto picks one Camelot-compatible key and pitch-shifts clips by at most 2 semitones; drums and uncertain keys are never shifted."
            >
              {(Object.keys(HARMONY_LABELS) as ChimeraHarmonyMode[]).map((m) => (
                <option key={m} value={m}>
                  {HARMONY_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <label
              htmlFor="chimera-arc"
              className={LABEL}
              title="Song = intro/build/peak/release/outro; Rise = continuous build; Flat = DJ blend."
            >
              Arc
            </label>
            <select
              id="chimera-arc"
              name="chimera-arc"
              value={arc}
              onChange={(e) => setChimeraField('arc', e.target.value as ChimeraArc)}
              className={FIELD}
              title="Song = intro/build/peak/release/outro; Rise = continuous build; Flat = DJ blend."
            >
              {(Object.keys(ARC_LABELS) as ChimeraArc[]).map((m) => (
                <option key={m} value={m}>
                  {ARC_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="flex items-center gap-1">
            <label
              htmlFor="chimera-heal"
              className={LABEL}
              title="Off = init audio only (today). Preserve = one pass that regenerates only the seams and keeps phrase bodies. Polish = a second pass on the result (about 2x model time)."
            >
              Heal
            </label>
            <select
              id="chimera-heal"
              name="chimera-heal"
              value={heal}
              onChange={(e) => setChimeraField('heal', e.target.value as ChimeraHealMode)}
              className={FIELD}
              title="Off = today; Preserve = regenerate only the seams in one pass; Polish = a second pass on the result (2x model time)"
            >
              {(Object.keys(HEAL_LABELS) as ChimeraHealMode[]).map((m) => (
                <option key={m} value={m}>
                  {HEAL_LABELS[m]}
                </option>
              ))}
            </select>
          </div>
          <button
            type="button"
            aria-pressed={engine === 'v1'}
            onClick={() => setChimeraField('engine', engine === 'v1' ? 'v2' : 'v1')}
            className={`px-1.5 py-0.5 rounded border text-xs font-display font-bold uppercase tracking-wider transition-colors ${
              engine === 'v1'
                ? 'border-amber-400 bg-amber-500/20 text-amber-200'
                : 'border-white/10 bg-black/30 text-zinc-400 hover:bg-white/5'
            }`}
            title="A/B: render with the v1 weave engine (chunk splice, no key matching, no song arc) instead of the v2 phrase engine"
          >
            v1
          </button>
        </>
      )}
    </div>
  );
};
