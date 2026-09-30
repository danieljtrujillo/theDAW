/**
 * EffectControls — ONE schema-driven control panel for any effect.
 *
 * Give it an EffectSchema (rack effect, MIX backend effect, Edit Tool Stack
 * tool, or an imported/preserved device) plus the current params and it
 * renders a complete, grouped UI: the right control per param (log/bipolar
 * knob, slider, toggle, select), declared XY pads, unit readouts, double-click
 * reset, presets (Default + the schema's), a fixed wet/dry slot for the mix
 * key, and an optional bypass. Two layouts: `compact` for rack tiles and
 * side rails, `expanded` for floating windows and stages.
 *
 * Writes are whole-param-object callbacks (`onChange({...params, key: v})`),
 * the same contract FxRack / the stores already use, so automation recording,
 * live rack pushes and persistence all keep working unchanged. `display`
 * overrides what is SHOWN (automation follow) without touching what is written.
 * Optional `onGestureStart` / `onGestureEnd` report the panel's gesture
 * boundary around those writes (see the props below).
 *
 * Widgets: EffectKnob (the SLIDE tk-dial skin), SlideTrack (SLIDE capsule
 * slider), SlidePad (SLIDE pad button), native <select> for enums. Every
 * native control carries a stable id/name + label; custom controls carry
 * aria-label/aria-labelledby and are never wrapped in <label>.
 */
import React, { useMemo } from 'react';
import { Power, RotateCcw } from 'lucide-react';
import { SlideTrack } from '../SlideTrack';
import { SlidePad } from '../SlidePad';
import { EffectKnob } from './EffectKnob';
import { EffectXYPad } from './EffectXYPad';
import {
  applyPreset,
  matchPreset,
  paramGroups,
  schemaDefaults,
  type EffectSchema,
  type ParamSchema,
} from './effectSchema';
import { formatParamValue, isLog, labelInGroup, optionIndex, optionValue, paramKind } from './paramFormat';

export type EffectControlsLayout = 'compact' | 'expanded';

export interface EffectControlsProps {
  schema: EffectSchema;
  /** Stored params — the values writes are merged onto. */
  params: Record<string, number>;
  /** Optional display overrides (automation follow); never written back. */
  display?: Record<string, number>;
  onChange: (next: Record<string, number>) => void;
  /** Stable, unique prefix for control ids (one per mounted panel). */
  idPrefix: string;
  layout?: EffectControlsLayout;
  /** When both given, the header shows a bypass toggle. */
  enabled?: boolean;
  onToggleEnabled?: () => void;
  /** Hide the identity row (name/badge/bypass) when the host already shows it;
   *  the tools row (presets/reset/mix) always renders. */
  hideHeader?: boolean;
  /** Extra host actions rendered at the end of the tools row. */
  headerExtra?: React.ReactNode;
  /** The panel's GESTURE boundary: one start before the first `onChange` of a
   *  drag / key press / wheel burst on any of its controls, one end after its
   *  last. Every control forwards it — the knobs and XY pads through their own
   *  `lib/gestureTracker`, the SLIDE sliders through theirs, and the discrete
   *  controls (toggle pad, enum select, preset, reset) as a pair around their
   *  single change. The boundary is per PANEL, not per param key, because one
   *  surface writes several keys (an XY drag moves both axes, a preset moves
   *  many) and a consumer recording automation opens and closes them together.
   *
   *  Both are optional, and a host that omits them (MixView's rack tiles, which
   *  are not on the automation path) leaves the consumer on the idle-deadline
   *  fallback in `lib/automationGesture.ts` — which is why that fallback stays. */
  onGestureStart?: () => void;
  onGestureEnd?: () => void;
  className?: string;
}

const ENGINE_BADGE: Record<EffectSchema['engine'], { text: string; cls: string }> = {
  rack: { text: 'Live', cls: 'border-emerald-500/30 text-emerald-300' },
  backend: { text: 'Offline', cls: 'border-sky-500/30 text-sky-300' },
  tool: { text: 'Tool', cls: 'border-amber-500/30 text-amber-300' },
  preserved: { text: 'Imported', cls: 'border-zinc-500/30 text-zinc-400' },
};

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

export const EffectControls: React.FC<EffectControlsProps> = ({
  schema,
  params,
  display,
  onChange,
  idPrefix,
  layout = 'compact',
  enabled,
  onToggleEnabled,
  hideHeader,
  headerExtra,
  onGestureStart,
  onGestureEnd,
  className,
}) => {
  const expanded = layout === 'expanded';
  const shown = useMemo(() => ({ ...schemaDefaults(schema), ...params, ...(display ?? {}) }), [schema, params, display]);
  const byKey = useMemo(() => new Map(schema.params.map((p) => [p.key, p])), [schema]);
  const mixParam = schema.mixKey ? byKey.get(schema.mixKey) : undefined;
  const groups = useMemo(
    () => paramGroups(schema, { excludeKeys: mixParam ? [mixParam.key] : [] }),
    [schema, mixParam],
  );
  const pads = useMemo(
    () => (schema.xy ?? []).filter((pad) => byKey.has(pad.x) && byKey.has(pad.y)),
    [schema, byKey],
  );
  const presetMatch = matchPreset(schema, shown);
  const presets = schema.presets ?? [];
  const showGroupCaptions = groups.length > 1 || (groups.length === 1 && groups[0].name !== '' && expanded);

  const set = (key: string, v: number) => onChange({ ...params, [key]: v });
  const setMany = (patch: Record<string, number>) => onChange({ ...params, ...patch });
  /** A DISCRETE control — a toggle, an enum pick, a preset, the reset — writes
   *  once and is over, so it reports a gesture of exactly one change rather
   *  than leaving the consumer to time one out. (The `SlideTrack` double-click
   *  reset is the same shape: no tracker, no state, just the pair.) */
  const discrete = (write: () => void) => {
    onGestureStart?.();
    write();
    onGestureEnd?.();
  };
  const resetAll = () => discrete(() => onChange({ ...params, ...schemaDefaults(schema) }));
  const onPreset = (label: string) => {
    if (!label) return;
    if (label === '__default') { resetAll(); return; }
    const preset = presets.find((p) => p.label === label);
    if (preset) discrete(() => onChange(applyPreset(schema, params, preset)));
  };

  const knobSize = expanded ? 46 : 38;
  const padSize = expanded ? 132 : 104;
  const presetId = `${idPrefix}-preset`;
  const badge = ENGINE_BADGE[schema.engine];

  const renderControl = (p: ParamSchema, groupName: string) => {
    const value = shown[p.key] ?? p.default;
    const kind = paramKind(p);
    const label = labelInGroup(p, groupName || undefined);
    const ctlId = `${idPrefix}-${slug(p.key)}`;
    if (kind === 'toggle') {
      const on = value >= 0.5;
      // The legend names the pad; its visible On / Off is the state, which
      // aria-pressed already carries.
      const legendId = `${ctlId}-label`;
      return (
        <div key={p.key} className="flex flex-col items-center gap-1 min-w-0" title={p.tip}>
          <span id={legendId} className="font-sans text-xs font-bold text-zinc-400 leading-none truncate max-w-full">{label}</span>
          <SlidePad on={on} onClick={() => discrete(() => set(p.key, on ? 0 : 1))} title={p.tip ?? `${label}: ${on ? 'on' : 'off'}`} ariaLabelledBy={legendId} textSize="text-xs" className="min-w-12 h-7 font-sans">
            {on ? 'On' : 'Off'}
          </SlidePad>
        </div>
      );
    }
    if (kind === 'select' && p.options && p.options.length > 0) {
      const idx = optionIndex(p, value);
      return (
        <div key={p.key} className="flex flex-col gap-1 min-w-0" title={p.tip}>
          <label htmlFor={ctlId} className="font-sans text-xs font-bold text-zinc-400 leading-none truncate">{label}</label>
          <select
            id={ctlId}
            name={ctlId}
            value={idx}
            onChange={(e) => discrete(() => set(p.key, optionValue(p, Number(e.target.value))))}
            className="form-select px-1.5 py-1 font-sans text-xs font-bold min-w-24"
            style={{ colorScheme: 'dark' }}
          >
            {p.options.map((opt, i) => (
              <option key={`${opt}-${i}`} value={i}>{opt}</option>
            ))}
          </select>
        </div>
      );
    }
    if (kind === 'slider' && !isLog(p)) {
      const labelId = `${ctlId}-label`;
      return (
        <div key={p.key} className="flex items-center gap-2 basis-full min-w-0" title={p.tip}>
          <span id={labelId} className="font-sans text-xs font-bold text-zinc-400 w-16 shrink-0 truncate">{label}</span>
          <SlideTrack
            id={ctlId}
            value={value}
            min={p.min}
            max={p.max}
            step={p.step}
            defaultValue={p.default}
            ariaLabelledBy={labelId}
            className="flex-1"
            onChange={(v) => set(p.key, v)}
            onGestureStart={onGestureStart}
            onGestureEnd={onGestureEnd}
          />
          <span className="font-sans text-xs font-bold text-zinc-300 w-16 shrink-0 text-right tabular-nums">{formatParamValue(p, value)}</span>
        </div>
      );
    }
    return (
      <EffectKnob
        key={p.key}
        param={p}
        label={label}
        value={value}
        size={knobSize}
        onChange={(v) => set(p.key, v)}
        onGestureStart={onGestureStart}
        onGestureEnd={onGestureEnd}
      />
    );
  };

  return (
    <div className={`flex flex-col gap-2 min-w-0 ${className ?? ''}`} data-effect-controls={schema.id}>
      {/* Identity row: bypass · name · engine badge. */}
      {!hideHeader && (
        <div className="flex items-center gap-1.5 min-w-0">
          {onToggleEnabled && (
            <button
              type="button"
              onClick={onToggleEnabled}
              aria-pressed={!!enabled}
              aria-label={enabled ? `Bypass ${schema.label}` : `Enable ${schema.label}`}
              title={enabled ? 'Bypass' : 'Enable'}
              className={`p-0.5 rounded border transition-colors shrink-0 ${
                enabled ? 'border-emerald-500/40 text-emerald-300 bg-emerald-500/10' : 'border-white/10 text-zinc-600 hover:text-zinc-300'
              }`}
            >
              <Power className="w-3 h-3" />
            </button>
          )}
          <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-200 truncate" title={schema.description}>{schema.label}</span>
          <span className={`font-display text-xs font-bold uppercase tracking-wide px-1 rounded border bg-black/40 shrink-0 ${badge.cls}`}>{badge.text}</span>
        </div>
      )}

      {/* Tools row: presets · reset · (mix) · host extras. */}
      <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
        {presets.length > 0 && (
          <>
            <label htmlFor={presetId} className="sr-only">Preset</label>
            <select
              id={presetId}
              name={presetId}
              value=""
              onChange={(e) => { onPreset(e.target.value); e.target.value = ''; }}
              className="form-select px-1.5 py-0.5 font-sans text-xs font-bold min-w-0 max-w-40"
              style={{ colorScheme: 'dark' }}
              title="Load a preset (merged onto the current settings)"
            >
              <option value="">{presetMatch ? `Preset: ${presetMatch}` : 'Preset: Custom'}</option>
              <option value="__default">Default</option>
              {presets.map((pr) => (
                <option key={pr.label} value={pr.label}>{pr.label}</option>
              ))}
            </select>
          </>
        )}
        <button
          type="button"
          onClick={resetAll}
          aria-label={`Reset ${schema.label} to defaults`}
          title="Reset all controls to their defaults"
          className="p-1 rounded text-zinc-500 hover:text-white hover:bg-white/10 shrink-0"
        >
          <RotateCcw className="w-3 h-3" />
        </button>
        {headerExtra}
        {mixParam && (
          <div className="ml-auto shrink-0">
            <EffectKnob
              param={mixParam}
              label={mixParam.label}
              value={shown[mixParam.key] ?? mixParam.default}
              size={expanded ? 40 : 34}
              tint={0.62}
              onChange={(v) => set(mixParam.key, v)}
              onGestureStart={onGestureStart}
              onGestureEnd={onGestureEnd}
            />
          </div>
        )}
      </div>

      {schema.note && (
        <p className="font-sans text-xs font-bold text-zinc-500 leading-snug">{schema.note}</p>
      )}

      {/* XY pads (declared pairs). */}
      {pads.length > 0 && (
        <div className={`flex flex-wrap gap-3 ${expanded ? 'justify-start' : 'justify-center'}`}>
          {pads.map((pad) => {
            const xp = byKey.get(pad.x)!;
            const yp = byKey.get(pad.y)!;
            return (
              <EffectXYPad
                key={`${pad.x}-${pad.y}`}
                label={pad.label}
                xParam={xp}
                yParam={yp}
                x={shown[xp.key] ?? xp.default}
                y={shown[yp.key] ?? yp.default}
                size={padSize}
                onChange={({ x, y }) => setMany({ [xp.key]: x, [yp.key]: y })}
                onGestureStart={onGestureStart}
                onGestureEnd={onGestureEnd}
              />
            );
          })}
        </div>
      )}

      {/* Grouped controls. */}
      <div className={expanded ? 'grid gap-2 grid-cols-[repeat(auto-fit,minmax(9.5rem,1fr))]' : 'flex flex-col gap-2'}>
        {groups.map((g) => (
          <section
            key={g.name || '__main'}
            aria-label={g.name || schema.label}
            className={expanded ? 'rounded border border-white/5 bg-black/30 p-2 flex flex-col gap-1.5 min-w-0' : 'flex flex-col gap-1 min-w-0'}
          >
            {showGroupCaptions && g.name && (
              <span className="font-display text-xs font-bold uppercase tracking-wider text-zinc-400 leading-none">{g.name}</span>
            )}
            <div className={`flex flex-wrap items-end gap-x-2 gap-y-2 ${expanded ? '' : 'justify-start'}`}>
              {g.params.map((p) => renderControl(p, g.name))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
};
