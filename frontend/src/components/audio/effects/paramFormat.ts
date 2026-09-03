/**
 * paramFormat — value <-> travel mapping and readout formatting for the
 * schema-driven effect controls. Pure functions, shared by the knob, the XY
 * pad and the tests.
 */
import type { RackParamDescriptor } from '../../../lib/rackEffects';

export type ParamSchema = RackParamDescriptor;

const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));

/** Log travel is only meaningful on a strictly positive range. */
export const isLog = (p: ParamSchema): boolean => p.curve === 'log' && p.min > 0 && p.max > p.min;

/** Snap into the param's grid and range. */
export function snapParam(p: ParamSchema, v: number): number {
  if (!Number.isFinite(v)) return p.default;
  const step = p.step > 0 ? p.step : 0.001;
  const snapped = p.min + Math.round((v - p.min) / step) * step;
  // Round away float dust (0.30000000000000004) without losing fine steps.
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(step)) + 1));
  return clamp(+snapped.toFixed(decimals), p.min, p.max);
}

/** Value -> normalized travel 0..1 (log-aware). */
export function toNorm(p: ParamSchema, v: number): number {
  const span = p.max - p.min || 1;
  if (isLog(p)) return clamp(Math.log(clamp(v, p.min, p.max) / p.min) / Math.log(p.max / p.min), 0, 1);
  return clamp((v - p.min) / span, 0, 1);
}

/** Normalized travel 0..1 -> snapped value (log-aware). */
export function fromNorm(p: ParamSchema, t: number): number {
  const u = clamp(t, 0, 1);
  const raw = isLog(p) ? p.min * Math.pow(p.max / p.min, u) : p.min + u * (p.max - p.min);
  return snapParam(p, raw);
}

/** The control kind a param renders as (explicit `kind` wins). */
export function paramKind(p: ParamSchema): 'knob' | 'slider' | 'toggle' | 'select' {
  if (p.kind) return p.kind;
  if (p.options && p.options.length > 0) return 'select';
  if (p.min === 0 && p.max === 1 && p.step === 1) return 'toggle';
  return 'knob';
}

/** The concrete value of option index i. */
export function optionValue(p: ParamSchema, i: number): number {
  if (p.optionValues && p.optionValues[i] != null) return p.optionValues[i];
  return p.min + i * (p.step || 1);
}

/** Index of the option nearest to v (options may sit at irregular values). */
export function optionIndex(p: ParamSchema, v: number): number {
  const n = p.options?.length ?? 0;
  if (n === 0) return 0;
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < n; i += 1) {
    const d = Math.abs(optionValue(p, i) - v);
    if (d < bestD) { bestD = d; best = i; }
  }
  return best;
}

const decimalsFor = (step: number): number => (step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3);

const sign = (v: number, s: string): string => (v > 0 ? `+${s}` : s);

/** Human readout with unit: "1.2 kHz", "-6.0 dB", "45 %", "Square", "350 ms". */
export function formatParamValue(p: ParamSchema, v: number): string {
  if (!Number.isFinite(v)) return '—';
  if (p.options && p.options.length > 0) return p.options[optionIndex(p, v)] ?? String(v);
  if (paramKind(p) === 'toggle') return v >= 0.5 ? 'On' : 'Off';
  if (p.display === 'percent') return `${Math.round(v * 100)}%`;
  const unit = p.unit ?? '';
  const d = decimalsFor(p.step);
  switch (unit) {
    case 'Hz':
      return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${v.toFixed(d)} Hz`;
    case 'ms':
      return v >= 1000 ? `${(v / 1000).toFixed(2)} s` : `${v.toFixed(d)} ms`;
    case 'dB':
      return p.bipolar ? `${sign(v, v.toFixed(Math.max(1, d)))} dB` : `${v.toFixed(Math.max(1, d))} dB`;
    case 'st':
    case 'cents':
    case 'deg':
      return p.bipolar ? `${sign(v, v.toFixed(d))} ${unit}` : `${v.toFixed(d)} ${unit}`;
    case ':1':
      return `${v.toFixed(d)}:1`;
    case '×':
      return `×${v.toFixed(Math.max(2, d))}`;
    case '':
      return v.toFixed(d);
    default:
      return `${v.toFixed(d)} ${unit}`;
  }
}

/** Short label for a param inside its own group ("Delay Time" in "Delay" → "Time"). */
export function labelInGroup(p: ParamSchema, group?: string): string {
  if (!group) return p.label;
  const g = group.toLowerCase();
  const l = p.label.toLowerCase();
  if (l.startsWith(`${g} `) && p.label.length > group.length + 1) return p.label.slice(group.length + 1);
  return p.label;
}
