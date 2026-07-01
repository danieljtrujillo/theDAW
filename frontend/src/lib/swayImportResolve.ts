/**
 * Resolve a DAW project's controller (MIDI-learn) mappings onto theDAW's imported
 * editor tracks/effects, so a hardware controller (the Audima Sway) drives the
 * same targets on Open — without guessing.
 *
 * Each parsed DawControllerMapping already carries the resolved target track
 * (track_index) and the device's slot in the flattened chain (device_index). Here
 * we turn that into a concrete SwayBinding against the LIVE editor state: a track
 * volume/pan, a track FX parameter (Ableton param name -> theDAW rack param key
 * via a table built from the real names), or an FX enable toggle. Anything that
 * can't attach faithfully (rack macros pending fan-out, instrument internals, an
 * untranslatable param) is returned as `unattached` with a reason — nothing is
 * silently dropped. Where a mapped device imported inert, it is rebuilt into a
 * live rack effect so the parameter exists.
 */
import type { DawProject } from './dawImportClient';
import { getRackEffect } from './rackEffects';
import { matchNativeEffect } from './dawEffectMap';
import { useEditorStore } from '../state/editorStore';

export interface SwayBinding {
  /** 0-indexed MIDI channel, or -1 for omni (any channel). */
  channel: number;
  number: number;
  isNote: boolean;
  trackId: string;
  target: 'volume' | 'pan' | 'fx' | 'fxEnable';
  entryId?: string;
  paramKey?: string;
  min: number;
  max: number;
  /** Human-readable target for the review panel. */
  label: string;
}

export interface SwayUnattached {
  channel: number;
  number: number;
  reason: 'macro' | 'instrument' | 'track' | 'device' | 'param' | 'effect';
  detail: string;
}

export interface SwayResolveResult {
  bindings: SwayBinding[];
  unattached: SwayUnattached[];
}

/**
 * Ableton parameter name -> theDAW rack-effect parameter key, per mapped effect.
 * Keys are the Ableton names lowercased with non-alphanumerics stripped. Grounded
 * in the parameter names actually seen across the Sway projects.
 */
const PARAM_MAP: Record<string, Record<string, string>> = {
  lowpass: { cutoff: 'frequency', frequency: 'frequency', freq: 'frequency', resonance: 'resonance' },
  highpass: { cutoff: 'frequency', frequency: 'frequency', freq: 'frequency', resonance: 'resonance' },
  gater: { beatrate: 'rate', rate: 'rate', frequency: 'rate', lfoamount: 'depth', amount: 'depth' },
  exciter: { predrive: 'amount', drive: 'amount', amount: 'amount', drywet: 'mix', mix: 'mix' },
  bitcrush: { amplitude: 'mix', drywet: 'mix', mix: 'mix', bits: 'bits' },
  reverb: { drywet: 'wet', mixdirect: 'wet', wet: 'wet', decay: 'decay', predelay: 'predelay' },
  delay: { drywet: 'wet', wet: 'wet', feedback: 'feedback', delaylinetimel: 'time', time: 'time' },
  parametric_eq: { gain: 'mid', gainmid: 'mid', globalgain: 'mid', mid: 'mid', freqhi: 'high', freqlo: 'low' },
  compressor: { threshold: 'threshold', ratio: 'ratio', drywet: 'makeup', makeup: 'makeup' },
  ringmod: { frequency: 'frequency', drywet: 'mix', mix: 'mix' },
  stereo_widener: { width: 'width' },
};

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');

/** First candidate key that actually exists on the effect, or null. */
function pickKey(effectId: string, candidates: string[]): string | null {
  const def = getRackEffect(effectId);
  if (!def) return null;
  for (const c of candidates) if (def.params.some((p) => p.key === c)) return c;
  return null;
}

/** Translate an Ableton param name to a theDAW rack param key, or null. */
function translateParam(effectId: string, abletonParam: string): string | null {
  const ap = norm(abletonParam);
  let key = PARAM_MAP[effectId]?.[ap] ?? null;
  if (!key && (ap.includes('drywet') || ap.includes('mixdirect'))) key = pickKey(effectId, ['wet', 'mix']);
  if (!key) return null;
  const def = getRackEffect(effectId);
  return def && def.params.some((p) => p.key === key) ? key : null;
}

const isOnParam = (p: string): boolean => {
  const n = norm(p);
  return n === 'on' || n === 'ison';
};

/**
 * Resolve every controller mapping in the imported project against the current
 * editor state. Must be called AFTER the project is loaded into the editor.
 */
export function resolveControllerMappings(project: DawProject): SwayResolveResult {
  const bindings: SwayBinding[] = [];
  const unattached: SwayUnattached[] = [];
  const ed = useEditorStore.getState();
  const tracks = ed.tracks;

  for (const m of project.controller_mappings ?? []) {
    const base = { channel: m.channel, number: m.number };
    if (m.is_instrument_target) {
      unattached.push({ ...base, reason: 'instrument', detail: `${m.track_name} / ${m.device_name} / ${m.param_name}` });
      continue;
    }
    if (m.is_macro) {
      unattached.push({ ...base, reason: 'macro', detail: `${m.track_name} / ${m.device_name} / ${m.param_name}` });
      continue;
    }
    const track = tracks[m.track_index];
    if (!track) {
      unattached.push({ ...base, reason: 'track', detail: `track #${m.track_index} (${m.track_name})` });
      continue;
    }

    // Mixer volume/pan (Utility gain also routes to the track fader).
    if (m.target_kind === 'mixer' || norm(m.device_name) === 'utility') {
      const isPan = norm(m.param_name).includes('pan');
      bindings.push({
        ...base,
        isNote: m.is_note,
        trackId: track.id,
        target: isPan ? 'pan' : 'volume',
        min: isPan ? -1 : 0,
        max: 1,
        label: `${track.name} · ${isPan ? 'Pan' : 'Volume'}`,
      });
      continue;
    }

    const chain = track.fxChain ?? [];
    const entry = chain[m.device_index];
    if (!entry) {
      unattached.push({ ...base, reason: 'device', detail: `${m.track_name} / ${m.device_name} (slot ${m.device_index})` });
      continue;
    }

    // "On" -> the effect's enable toggle.
    if (isOnParam(m.param_name)) {
      bindings.push({
        ...base,
        isNote: m.is_note,
        trackId: track.id,
        target: 'fxEnable',
        entryId: entry.id,
        min: 0,
        max: 1,
        label: `${track.name} · ${entry.label || m.device_name} · On`,
      });
      continue;
    }

    // Ensure the target is a live rack effect; rebuild an inert import when the
    // device maps to one so the parameter has a live home.
    let effectId = entry.effect;
    if (!getRackEffect(effectId)) {
      const rebuilt = matchNativeEffect(m.device_name);
      if (rebuilt && getRackEffect(rebuilt)) {
        ed.rebuildTrackEffect(track.id, entry.id, rebuilt);
        effectId = rebuilt;
      }
    }
    const def = getRackEffect(effectId);
    if (!def) {
      unattached.push({ ...base, reason: 'effect', detail: `${m.track_name} / ${m.device_name} (no live effect)` });
      continue;
    }
    const key = translateParam(effectId, m.param_name);
    if (!key) {
      unattached.push({ ...base, reason: 'param', detail: `${m.device_name} / ${m.param_name}` });
      continue;
    }
    const spec = def.params.find((p) => p.key === key);
    bindings.push({
      ...base,
      isNote: m.is_note,
      trackId: track.id,
      target: 'fx',
      entryId: entry.id,
      paramKey: key,
      min: spec?.min ?? 0,
      max: spec?.max ?? 1,
      label: `${track.name} · ${entry.label || def.label} · ${key}`,
    });
  }

  return { bindings, unattached };
}
