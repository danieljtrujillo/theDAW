/**
 * Schema invariants for the generic effect panel. Run with:
 *   npx tsx src/components/audio/effects/effectSchema.test.ts   (from frontend/)
 */
import assert from 'node:assert/strict';

import { RACK_EFFECTS } from '../../../lib/rackEffects.ts';
import { PARAM_BOUNDS, PARAM_META, BACKEND_EFFECT_PRESETS } from '../../../lib/effectCatalog.ts';
import { EFFECT_DEFAULTS } from '../../../state/effectChainStore.ts';
import {
  applyPreset,
  matchPreset,
  paramGroups,
  schemaForBackendEffect,
  schemaForEditTool,
  schemaForRackEffect,
  type EditToolDto,
} from './effectSchema.ts';
import { formatParamValue, fromNorm, optionValue, paramKind, toNorm } from './paramFormat.ts';

const inRange = (v: number, min: number, max: number) => v >= min - 1e-9 && v <= max + 1e-9;

/* ── rack schemas ─────────────────────────────────────────────────────────── */
for (const def of RACK_EFFECTS) {
  const schema = schemaForRackEffect(def);
  const keys = new Set<string>();
  for (const p of def.params) {
    assert.ok(!keys.has(p.key), `${def.id}: duplicate param key ${p.key}`);
    keys.add(p.key);
    assert.ok(Number.isFinite(p.min) && Number.isFinite(p.max) && p.min < p.max, `${def.id}.${p.key}: bad range`);
    assert.ok(p.step > 0, `${def.id}.${p.key}: step must be > 0`);
    assert.ok(inRange(p.default, p.min, p.max), `${def.id}.${p.key}: default ${p.default} outside [${p.min}, ${p.max}]`);
    assert.ok(p.label.trim().length > 0, `${def.id}.${p.key}: empty label`);
    if (p.curve === 'log') assert.ok(p.min > 0, `${def.id}.${p.key}: log curve needs min > 0`);
    if (p.options) {
      assert.ok(p.options.length > 1, `${def.id}.${p.key}: options need at least two entries`);
      if (p.optionValues) {
        assert.equal(p.optionValues.length, p.options.length, `${def.id}.${p.key}: optionValues length`);
        for (const v of p.optionValues) assert.ok(inRange(v, p.min, p.max), `${def.id}.${p.key}: option value ${v} outside range`);
      } else {
        const n = Math.round((p.max - p.min) / p.step) + 1;
        assert.equal(n, p.options.length, `${def.id}.${p.key}: ${p.options.length} options do not cover ${n} steps`);
      }
      for (let i = 0; i < p.options.length; i += 1) {
        assert.ok(inRange(optionValue(p, i), p.min, p.max), `${def.id}.${p.key}: option ${i} value out of range`);
      }
      assert.equal(paramKind(p), 'select');
    }
    if (p.display === 'percent') assert.ok(p.min >= 0 && p.max <= 1, `${def.id}.${p.key}: percent display expects a 0..1 range`);
  }
  if (def.mixKey) {
    const mp = def.params.find((p) => p.key === def.mixKey);
    assert.ok(mp, `${def.id}: mixKey ${def.mixKey} is not a param`);
    assert.ok(mp!.min === 0 && mp!.max === 1, `${def.id}: mix param must be 0..1`);
  }
  for (const pad of def.xy ?? []) {
    for (const k of [pad.x, pad.y]) {
      const p = def.params.find((q) => q.key === k);
      assert.ok(p, `${def.id}: xy pad references unknown param ${k}`);
      assert.ok(paramKind(p!) === 'knob' || paramKind(p!) === 'slider', `${def.id}: xy axis ${k} must be continuous`);
    }
  }
  for (const preset of def.presets ?? []) {
    for (const [k, v] of Object.entries(preset.values)) {
      const p = def.params.find((q) => q.key === k);
      assert.ok(p, `${def.id} preset "${preset.label}": unknown key ${k}`);
      assert.ok(inRange(v, p!.min, p!.max), `${def.id} preset "${preset.label}": ${k}=${v} outside [${p!.min}, ${p!.max}]`);
    }
  }
  // Every param lands in some group; the mix key is excluded from the body.
  const grouped = paramGroups(schema, { excludeKeys: def.mixKey ? [def.mixKey] : [] }).flatMap((g) => g.params.map((p) => p.key));
  const expected = def.params.map((p) => p.key).filter((k) => k !== def.mixKey);
  assert.deepEqual(grouped.sort(), expected.sort(), `${def.id}: grouping lost or duplicated params`);
  // Defaults match 'Default'; applying a preset matches that preset.
  const defaults = Object.fromEntries(def.params.map((p) => [p.key, p.default]));
  assert.equal(matchPreset(schema, defaults), 'Default', `${def.id}: defaults should read as Default`);
  const first = (def.presets ?? [])[0];
  if (first && first.label !== 'Default') {
    const applied = applyPreset(schema, defaults, first);
    const m = matchPreset(schema, applied);
    assert.ok(m === first.label || m === 'Default', `${def.id}: applying "${first.label}" reads as "${m}"`);
  }
}

/* ── backend (MIX chain) schemas ─────────────────────────────────────────── */
for (const id of Object.keys(EFFECT_DEFAULTS)) {
  const schema = schemaForBackendEffect(id);
  assert.ok(schema, `backend schema missing for ${id}`);
  for (const [key, def] of Object.entries(EFFECT_DEFAULTS[id])) {
    const p = schema!.params.find((q) => q.key === key);
    assert.ok(p, `${id}: no control for param ${key}`);
    assert.ok(PARAM_BOUNDS[id]?.[key], `${id}.${key}: missing PARAM_BOUNDS entry`);
    assert.ok(inRange(def, p!.min, p!.max), `${id}.${key}: default ${def} outside bounds`);
    assert.ok(PARAM_META[id]?.[key], `${id}.${key}: missing PARAM_META (label/unit/group)`);
  }
  for (const key of Object.keys(PARAM_BOUNDS[id] ?? {})) assert.ok(key in EFFECT_DEFAULTS[id], `${id}.${key}: bound without a default`);
  for (const key of Object.keys(PARAM_META[id] ?? {})) assert.ok(key in EFFECT_DEFAULTS[id], `${id}.${key}: meta without a default`);
  for (const preset of BACKEND_EFFECT_PRESETS[id] ?? []) {
    for (const [k, v] of Object.entries(preset.values)) {
      const p = schema!.params.find((q) => q.key === k);
      assert.ok(p, `${id} preset "${preset.label}": unknown key ${k}`);
      assert.ok(inRange(v, p!.min, p!.max), `${id} preset "${preset.label}": ${k}=${v} outside bounds`);
    }
  }
}
for (const id of Object.keys(PARAM_META)) assert.ok(EFFECT_DEFAULTS[id], `PARAM_META for unknown effect ${id}`);

/* ── formatting + travel mapping ─────────────────────────────────────────── */
const hp = RACK_EFFECTS.find((d) => d.id === 'highpass')!.params.find((p) => p.key === 'frequency')!;
assert.equal(formatParamValue(hp, 3500), '3.50 kHz');
assert.equal(formatParamValue(hp, 120), '120 Hz');
assert.ok(Math.abs(fromNorm(hp, toNorm(hp, 500)) - 500) <= hp.step, 'log round trip');
assert.ok(toNorm(hp, 200) > 0.45 && toNorm(hp, 200) < 0.55, 'log midpoint of 20..2000 is ~200 Hz');
const eqLow = RACK_EFFECTS.find((d) => d.id === 'parametric_eq')!.params.find((p) => p.key === 'low')!;
assert.equal(formatParamValue(eqLow, 3), '+3.0 dB');
assert.equal(formatParamValue(eqLow, -6), '-6.0 dB');
const mix = RACK_EFFECTS.find((d) => d.id === 'reverb')!.params.find((p) => p.key === 'wet')!;
assert.equal(formatParamValue(mix, 0.35), '35%');
const shape = RACK_EFFECTS.find((d) => d.id === 'gater')!.params.find((p) => p.key === 'shape')!;
assert.equal(formatParamValue(shape, 2), 'Saw');
const aresType = RACK_EFFECTS.find((d) => d.id === 'ares')!.params.find((p) => p.key === 'filterType')!;
assert.equal(formatParamValue(aresType, 0.4), 'High-pass');
assert.equal(formatParamValue(aresType, 0.2), 'Low-pass', 'engine slot 1 (second low-pass) reads as Low-pass');

/* ── Edit Tool Stack DTO adapter ─────────────────────────────────────────── */
const dto: EditToolDto = {
  id: 'dehum', name: 'De-Hum', family: 'restoration', description: '', mode: 'filter', engine: 'ffmpeg', implemented: true,
  params: [
    { name: 'fundamental', type: 'enum', lo: null, hi: null, default: '60', unit: '', control: 'RoundToggle', label: 'Mains', options: ['50', '60'], help: '' },
    { name: 'harmonics', type: 'int', lo: 1, hi: 8, default: 5, unit: '', control: 'ParamKnob', label: 'Harmonics', options: null, help: '' },
    { name: 'reduction', type: 'float', lo: 0, hi: 1, default: 1, unit: '', control: 'ParamKnob', label: 'Depth', options: null, help: '' },
    { name: 'prompt', type: 'string', lo: null, hi: null, default: '', unit: '', control: 'TextInput', label: 'Prompt', options: null, help: '' },
  ],
};
const toolSchema = schemaForEditTool(dto);
assert.deepEqual(toolSchema.params.map((p) => p.key), ['fundamental', 'harmonics', 'reduction'], 'string params are skipped');
assert.equal(paramKind(toolSchema.params[0]), 'select');
assert.equal(toolSchema.params[0].default, 1, 'enum default maps to its option index');
assert.equal(toolSchema.params[1].step, 1, 'int params step by 1');

console.log('effect schema invariants passed');
