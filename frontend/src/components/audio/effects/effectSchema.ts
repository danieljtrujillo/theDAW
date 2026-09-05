/**
 * effectSchema — ONE parameter schema for every kind of effect the app can
 * host, so a single control panel (EffectControls) renders all of them:
 *
 *   rack      live Web-Audio rack effects (lib/rackEffects RACK_EFFECTS)
 *   backend   MIX chain effects rendered offline by /api/studio
 *             (effectChainStore EFFECT_DEFAULTS + lib/effectCatalog bounds/meta)
 *   tool      the offline Edit Tool Stack (/api/edit/<family>/tools manifests)
 *   preserved an imported DAW device theDAW stores but cannot render live
 *
 * The rack descriptor IS the schema shape (RackParamDescriptor); the other
 * sources are adapted onto it here.
 */
import {
  RACK_EFFECTS,
  getRackEffect,
  type RackEffectDef,
  type RackEffectPreset,
  type RackParamDescriptor,
  type RackXYPad,
} from '../../../lib/rackEffects';
import { EFFECT_CATALOG, PARAM_BOUNDS, PARAM_META, BACKEND_EFFECT_PRESETS } from '../../../lib/effectCatalog';
import { EFFECT_DEFAULTS, EFFECT_LABELS } from '../../../state/effectChainStore';
import { optionIndex, optionValue, paramKind, snapParam } from './paramFormat';

export type ParamSchema = RackParamDescriptor;
export type EffectEngine = 'rack' | 'backend' | 'tool' | 'preserved';

export interface EffectSchema {
  id: string;
  label: string;
  description?: string;
  engine: EffectEngine;
  params: ParamSchema[];
  mixKey?: string;
  presets?: readonly RackEffectPreset[];
  xy?: readonly RackXYPad[];
  /** One-line note shown under the header (e.g. why nothing is heard live). */
  note?: string;
}

export interface ParamGroup {
  name: string;
  params: ParamSchema[];
}

/* ── rack ──────────────────────────────────────────────────────────────────── */

export function schemaForRackEffect(def: RackEffectDef): EffectSchema {
  return {
    id: def.id,
    label: def.label,
    description: def.description,
    engine: 'rack',
    params: def.params,
    mixKey: def.mixKey,
    presets: def.presets,
    xy: def.xy,
  };
}

/* ── backend (MIX chain / /api/studio) ─────────────────────────────────────── */

const backendDesc = (id: string): string | undefined => {
  for (const list of Object.values(EFFECT_CATALOG)) {
    const hit = list.find((fx) => fx.id === id);
    if (hit) return hit.desc;
  }
  return undefined;
};

/** Fallback label from a camelCase key: "highpassFreq" → "Highpass Freq". */
export const prettyKey = (key: string): string =>
  key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

/**
 * Schema for a backend effect id, or null when the id is unknown. Every key
 * in EFFECT_DEFAULTS gets a control; bounds come from PARAM_BOUNDS (falling
 * back to a 0..1 range so an undocumented param is still reachable) and
 * presentation from PARAM_META.
 */
export function schemaForBackendEffect(id: string, engine: EffectEngine = 'backend'): EffectSchema | null {
  const defaults = EFFECT_DEFAULTS[id];
  if (!defaults) return null;
  const bounds = PARAM_BOUNDS[id] ?? {};
  const meta = PARAM_META[id] ?? {};
  const keys = Array.from(new Set([...Object.keys(defaults), ...Object.keys(bounds)]));
  const params: ParamSchema[] = keys.map((key) => {
    const [min, max, step] = bounds[key] ?? [0, 1, 0.01];
    const m = meta[key];
    return {
      key,
      label: m?.label ?? prettyKey(key),
      min,
      max,
      step,
      default: defaults[key] ?? min,
      unit: m?.unit,
      group: m?.group,
      curve: m?.curve,
      bipolar: m?.bipolar,
      display: m?.display,
      tip: m?.tip,
    };
  });
  return {
    id,
    label: EFFECT_LABELS[id] ?? prettyKey(id),
    description: backendDesc(id),
    engine,
    params,
    presets: BACKEND_EFFECT_PRESETS[id],
    note:
      engine === 'preserved'
        ? 'Preserved from the imported project — saved with the track, not rendered live.'
        : 'Offline effect: applied when the chain is processed, not heard in the live preview.',
  };
}

/** Rack first, then backend. Used by hosts that only know an effect id. */
export function schemaForEffectId(id: string, opts?: { preserved?: boolean }): EffectSchema | null {
  const rack = getRackEffect(id);
  if (rack) return schemaForRackEffect(rack);
  return schemaForBackendEffect(id, opts?.preserved ? 'preserved' : 'backend');
}

/* ── Edit Tool Stack (/api/edit/<family>/tools) ────────────────────────────── */

/** One ParamSpec as served by backend/lib/params.py ToolSpec.to_dict(). */
export interface EditToolParamDto {
  name: string;
  type: 'float' | 'int' | 'bool' | 'enum' | 'string';
  lo: number | null;
  hi: number | null;
  default: number | string | boolean | null;
  unit: string;
  control: string;
  label: string;
  options: string[] | null;
  help: string;
}

export interface EditToolDto {
  id: string;
  name: string;
  family: string;
  description: string;
  mode: string;
  engine: string;
  implemented: boolean;
  params: EditToolParamDto[];
}

const stepFor = (lo: number, hi: number, isInt: boolean): number => {
  if (isInt) return 1;
  const span = hi - lo;
  if (span <= 2) return 0.01;
  if (span <= 50) return 0.1;
  if (span <= 2000) return 1;
  return 10;
};

/**
 * Numeric schema for an Edit Tool Stack tool. Enums become selects (value =
 * option index), bools toggles; free-text params carry no numeric value and
 * are skipped (the module page hosts those itself).
 */
export function schemaForEditTool(tool: EditToolDto): EffectSchema {
  const params: ParamSchema[] = [];
  for (const p of tool.params) {
    if (p.type === 'string') continue;
    const label = p.label || prettyKey(p.name);
    if (p.type === 'bool') {
      params.push({ key: p.name, label, min: 0, max: 1, step: 1, default: p.default ? 1 : 0, kind: 'toggle', tip: p.help || undefined });
      continue;
    }
    if (p.type === 'enum') {
      const options = p.options ?? [];
      const idx = Math.max(0, options.indexOf(String(p.default ?? options[0] ?? '')));
      params.push({ key: p.name, label, min: 0, max: Math.max(0, options.length - 1), step: 1, default: idx, options, kind: 'select', tip: p.help || undefined });
      continue;
    }
    const lo = p.lo ?? 0;
    const hi = p.hi ?? 1;
    const isInt = p.type === 'int';
    const unit = p.unit || undefined;
    const looksLog = unit === 'Hz' || (unit === 'ms' && hi / Math.max(lo, 0.001) >= 50);
    params.push({
      key: p.name,
      label,
      min: lo,
      max: hi,
      step: stepFor(lo, hi, isInt),
      default: typeof p.default === 'number' ? p.default : lo,
      unit,
      kind: p.control === 'ParamSlider' || p.control === 'ParamFader' ? 'slider' : undefined,
      curve: looksLog && lo > 0 ? 'log' : undefined,
      bipolar: lo < 0 && hi > 0 && Math.abs(lo) === Math.abs(hi),
      tip: p.help || undefined,
    });
  }
  return {
    id: `${tool.family}/${tool.id}`,
    label: tool.name,
    description: tool.description,
    engine: 'tool',
    params,
    note: tool.implemented ? undefined : 'Scaffolded on the backend — processing returns 501 until its handler lands.',
  };
}

/* ── shared helpers ────────────────────────────────────────────────────────── */

/** Params in declaration order, split into named sections (mix key excluded
 *  when the caller renders it in the header). */
export function paramGroups(schema: EffectSchema, opts?: { excludeKeys?: readonly string[] }): ParamGroup[] {
  const skip = new Set(opts?.excludeKeys ?? []);
  const groups: ParamGroup[] = [];
  for (const p of schema.params) {
    if (skip.has(p.key)) continue;
    const name = p.group ?? '';
    let g = groups.find((x) => x.name === name);
    if (!g) { g = { name, params: [] }; groups.push(g); }
    g.params.push(p);
  }
  return groups;
}

export function schemaDefaults(schema: EffectSchema): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of schema.params) out[p.key] = p.default;
  return out;
}

const near = (a: number, b: number, step: number) => Math.abs(a - b) <= Math.max(step / 2, 1e-6);

/** 'Default' when every param sits at its default, else the label of the first
 *  preset whose values all match `values`, else null (custom). */
export function matchPreset(schema: EffectSchema, values: Record<string, number>): string | null {
  const byKey = new Map(schema.params.map((p) => [p.key, p]));
  const isDefault = schema.params.every((p) => near(values[p.key] ?? p.default, p.default, p.step));
  if (isDefault) return 'Default';
  for (const preset of schema.presets ?? []) {
    const ok = Object.entries(preset.values).every(([k, v]) => {
      const p = byKey.get(k);
      return p ? near(values[k] ?? p.default, v, p.step) : true;
    });
    if (ok) return preset.label;
  }
  return null;
}

/** Merge a preset's values onto `values`, snapped into each param's grid. */
export function applyPreset(schema: EffectSchema, values: Record<string, number>, preset: RackEffectPreset): Record<string, number> {
  const byKey = new Map(schema.params.map((p) => [p.key, p]));
  const next = { ...values };
  for (const [k, v] of Object.entries(preset.values)) {
    const p = byKey.get(k);
    next[k] = p ? snapParam(p, v) : v;
  }
  return next;
}

/** Cycle a select param to its next/previous option (wraps). */
export function stepOption(p: ParamSchema, v: number, dir: 1 | -1): number {
  const n = p.options?.length ?? 0;
  if (n === 0) return v;
  const i = (optionIndex(p, v) + dir + n) % n;
  return optionValue(p, i);
}

/** Every effect id that has some schema (rack + backend), for inventories/tests. */
export function allSchemaIds(): string[] {
  const ids = new Set<string>(RACK_EFFECTS.map((d) => d.id));
  for (const id of Object.keys(EFFECT_DEFAULTS)) ids.add(id);
  return Array.from(ids);
}

export { paramKind };
