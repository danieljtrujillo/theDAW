/**
 * Map a parsed DAW device/effect onto theDAW's effect vocabulary.
 *
 * Two realities shape this:
 *  - VST3/AU plugins carry a real on-disk path, so they map to a VST node that
 *    theDAW can re-host (full fidelity, processable via the freeze/render path).
 *  - A DAW's proprietary stock effects (Ableton EQ Eight, FL Fruity Reverb, …)
 *    can't be recreated. Where a close creative/spatial equivalent exists in
 *    theDAW's live rack (bitcrush, ringmod, stereo widener, exciter, gater, …)
 *    we approximate it. EQ/compressor/reverb/delay map to theDAW's catalog ids
 *    for labelling + persistence, but theDAW has no LIVE per-track engine for
 *    them yet, so the loader marks those preserved-but-inactive. Nothing is
 *    silently dropped — every device becomes a node in the saved .tasmo.
 */
import type { DawDevice } from './dawImportClient';
import type { EffectChainNode } from './projectClient';
import type { ChainEntry, VstNode } from '../state/effectChainStore';
import { getRackEffect, type RackParamDescriptor } from './rackEffects';

/**
 * A plugin's saved state and the host that captured it, in the store's
 * `VstNode` shape: a non-empty `raw_state`, and a `state_host` the app knows.
 * Anything else is left out, so the plugin opens at its defaults and reads the
 * default host (effectChainStore `vstStateHost`). One reader for every place a
 * saved state comes back: a .tasmo insert, a master-chain entry, an instrument
 * slot, and a PERFORM device opened from a .tasmo.
 */
export function savedVstState(raw: { raw_state?: unknown; state_host?: unknown } | null | undefined): Pick<VstNode, 'raw_state' | 'state_host'> {
  if (!raw) return {};
  return {
    ...(typeof raw.raw_state === 'string' && raw.raw_state ? { raw_state: raw.raw_state } : {}),
    ...(raw.state_host === 'thedaw' || raw.state_host === 'pedalboard' ? { state_host: raw.state_host } : {}),
  };
}

/** Ordered name patterns -> theDAW effect id. Specific before generic. */
const NATIVE_FX_PATTERNS: Array<[RegExp, string]> = [
  // Creative / spatial — these have a LIVE rack equivalent (real approximation).
  [/bitcrush|redux|decimat|crush|downsample|erosion/i, 'bitcrush'],
  [/ring\s*mod|ringmod|frequency\s*shift/i, 'ringmod'],
  [/auto\s*pan|tremolo|trance\s*gate|trancegate/i, 'gater'],
  [/chop|slice|stutter|beat\s*repeat|glitch/i, 'chop'],
  [/widen|imager|dimension|stereo|haas|m\/?s\b/i, 'stereo_widener'],
  [/exciter|enhancer|aural|harmonic|saturat|overdrive|distort|drive|warmth|tape|tube/i, 'exciter'],
  [/sub\s*bass|subharmonic|phantom|bass\s*enhance/i, 'phantom_bass'],
  [/crossfeed|headphone/i, 'crossfeed'],
  [/spatial|binaural|surround|ambisonic|3d\s*pan/i, 'spatializer'],
  [/maxim|brickwall|loudness|loud/i, 'loudness_contour'],
  // Standard mix tools — now LIVE per-track rack effects (real Web-Audio nodes).
  [/multiband|compress|\bcomp\b|glue|limiter|limit|clipper|\bott\b|dynamics?/i, 'compressor'],
  [/parametric|equal|\beq\b|equaliser|equalizer/i, 'parametric_eq'],
  [/reverb|\bverb\b|hall|room|plate|cathedral|convolv/i, 'reverb'],
  [/ping\s*pong|delay|echo/i, 'delay'],
  [/auto\s*filter|autofilter/i, 'lowpass'],
  [/low\s*pass|lowpass|lpf/i, 'lowpass'],
  [/high\s*pass|highpass|hpf/i, 'highpass'],
  // No live equivalent yet — preserved + labelled on the track.
  [/lofi|lo-fi|vinyl|cassette|degrade/i, 'lofi_vinyl'],
  [/pitch|transpose|shifter|harmoniz/i, 'pitch_shift'],
];

/** Keep only finite numeric params (the backend EffectChainNode.parameters is
 *  dict[str, float]; a stray non-number would fail validation for the whole save). */
function numericParams(params: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(params ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

/** Best theDAW effect id for a native device name, or null if nothing fits. */
export function matchNativeEffect(name: string): string | null {
  const n = (name || '').trim();
  if (!n) return null;
  for (const [re, id] of NATIVE_FX_PATTERNS) {
    if (re.test(n)) return id;
  }
  return null;
}

/** A device name that is ALREADY a theDAW rack id (a `.tasmo` round-trip) wins
 *  over the fuzzy patterns — "gater" would otherwise fail to match itself. */
export function resolveLiveEffectId(name: string): string | null {
  const n = (name || '').trim();
  if (getRackEffect(n)) return n;
  return matchNativeEffect(n);
}

/* ── Parameter-name translation ──────────────────────────────────────────────
 * Ableton emits `Threshold`, `DryWet`, `DecayTime`, `MacroControls.3`; the rack
 * expects `threshold`, `wet`, `decay`. Without this, every mapped effect
 * instantiated at rack defaults and every device-FX controller mapping routed
 * nothing. Names are folded (lower-case, alphanumerics only) and looked up per
 * effect first, then in the generic table; the result is validated against the
 * effect's own descriptor so a translation can never name a param that does
 * not exist. `__mix` is a stand-in for "this effect's wet/dry key".
 */
const fold = (s: string) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

const GENERIC_PARAM_ALIASES: Record<string, string> = {
  // wet / dry / amount-of-effect
  drywet: '__mix', wetdry: '__mix', wet: '__mix', mix: '__mix', amount: '__mix', on: '__mix', deviceon: '__mix',
  // filters
  frequency: 'frequency', freq: 'frequency', cutoff: 'frequency', cutofffrequency: 'frequency', midfreq: 'frequency',
  resonance: 'resonance', reso: 'resonance', q: 'resonance',
  // dynamics
  threshold: 'threshold', thresh: 'threshold', ratio: 'ratio', knee: 'knee',
  attack: 'attack', attacktime: 'attack', release: 'release', releasetime: 'release',
  gain: 'makeup', outputgain: 'makeup', makeup: 'makeup', makeupgain: 'makeup',
  // time-based
  feedback: 'feedback', fb: 'feedback',
  time: 'time', delaytime: 'time', delay: 'time', delayline: 'time',
  decay: 'decay', decaytime: 'decay', size: 'decay', roomsize: 'decay',
  predelay: 'predelay', predelaytime: 'predelay',
  tone: 'tone', damping: 'tone', highcut: 'tone', lowpass: 'tone',
  // rhythm
  rate: 'rate', speed: 'rate', lforate: 'rate', depth: 'depth', shape: 'shape', waveform: 'shape',
  // colour
  bits: 'bits', bitdepth: 'bits', bit: 'bits', drive: 'drive', width: 'width', stereowidth: 'width',
};

/** Per-effect overrides, applied before the generic table. */
const EFFECT_PARAM_ALIASES: Record<string, Record<string, string>> = {
  parametric_eq: { lowgain: 'low', low: 'low', lowshelf: 'low', midgain: 'mid', mid: 'mid', highgain: 'high', high: 'high', highshelf: 'high', frequency: 'midFreq', midfreq: 'midFreq' },
  exciter: { drive: 'amount', amount: 'amount', frequency: 'frequency', mix: 'mix', drywet: 'mix' },
  phantom_bass: { drive: 'drive', harmonics: 'drive', amount: 'blend', blend: 'blend', drywet: 'blend', crossover: 'crossover', frequency: 'crossover' },
  stereo_widener: { amount: 'width', width: 'width', bassmono: 'bassMonoFreq', frequency: 'bassMonoFreq' },
  gater: { amount: 'depth', depth: 'depth', rate: 'rate', frequency: 'rate', shape: 'shape', waveform: 'shape', sync: 'sync', division: 'div', div: 'div' },
  chop: { interval: 'rate', grid: 'slice', gate: 'gate', chance: 'mix', mix: 'mix', drywet: 'mix' },
  bitcrush: { samplerate: 'bits', bitdepth: 'bits', bits: 'bits' },
  ringmod: { fine: 'frequency', coarse: 'frequency', frequency: 'frequency' },
  loudness_contour: { amount: 'amount', level: 'level' },
  crossfeed: { amount: 'amount', cut: 'cutFreq', frequency: 'cutFreq' },
};

/** Unit conversions from the DAW's native scale to the rack's descriptor scale,
 *  keyed `<effectId>.<rackKey>`. Ableton stores reverb/delay times in ms and the
 *  rack's `decay` is seconds; everything else already agrees. */
const UNIT_CONVERT: Record<string, (v: number) => number> = {
  'reverb.decay': (v) => (v > 20 ? v / 1000 : v),
};

export interface TranslatedParam {
  key: string;
  descriptor: RackParamDescriptor;
}

/**
 * Translate a DAW parameter name onto one of `effectId`'s rack params.
 * Rack macros (`is_macro`, or names like `MacroControls.N`) land on the effect's
 * wet/dry key when it has one — a macro's fan-out is not recoverable from the
 * mapping alone, and "how much of this effect" is what a macro almost always
 * means on a performance rack.
 */
export function translateDawParam(effectId: string, dawName: string, isMacro = false): TranslatedParam | null {
  const def = getRackEffect(effectId);
  if (!def) return null;
  const folded = fold(dawName);
  const byKey = (k: string): TranslatedParam | null => {
    const key = k === '__mix' ? def.mixKey : k;
    if (!key) return null;
    const d = def.params.find((p) => p.key === key);
    return d ? { key, descriptor: d } : null;
  };
  if (isMacro || /^macrocontrols?\d*$/.test(folded)) return byKey('__mix') ?? byKey(def.params[0]?.key ?? '');
  // The exact rack key itself (a .tasmo round-trip).
  const direct = def.params.find((p) => fold(p.key) === folded || fold(p.label) === folded);
  if (direct) return { key: direct.key, descriptor: direct };
  const specific = EFFECT_PARAM_ALIASES[effectId]?.[folded];
  if (specific) { const r = byKey(specific); if (r) return r; }
  const generic = GENERIC_PARAM_ALIASES[folded];
  if (generic) { const r = byKey(generic); if (r) return r; }
  // Partial match on the folded rack label ("delaytime" ⊇ "time", "reverbdecay" ⊇ "decay").
  const partial = def.params.find((p) => folded.endsWith(fold(p.key)) || folded.endsWith(fold(p.label)));
  return partial ? { key: partial.key, descriptor: partial } : null;
}

/** Re-key a device's native parameter dict onto the rack's keys, converting
 *  units where the two scales differ and clamping to the descriptor range.
 *  Unknown names are kept verbatim (harmless to the rack, useful to the user). */
export function translateDawParams(effectId: string, params: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [name, raw] of Object.entries(params)) {
    const t = translateDawParam(effectId, name);
    if (!t) { out[name] = raw; continue; }
    const conv = UNIT_CONVERT[`${effectId}.${t.key}`];
    const v = conv ? conv(raw) : raw;
    const { min, max } = t.descriptor;
    out[t.key] = Math.max(min, Math.min(max, v));
  }
  return out;
}

/**
 * Convert one parsed DAW device into a persisted EffectChainNode.
 *  - VST3/AU with a resolvable path  -> a VST node (re-hostable).
 *  - everything else                 -> a builtin node whose effect_name is the
 *    mapped theDAW id, or the raw device name when nothing maps (preserved).
 *
 * A device PERFORM opened from a .tasmo (lib/tasmoToSession) also carries the
 * plugin state theDAW captured (`raw_state`, `state_host`), and the node
 * written back keeps it. A DAW import's own preset chunk (`state`) is never
 * taken for that state: neither host reads it.
 */
export function dawDeviceToEffectNode(device: DawDevice): EffectChainNode {
  const params = numericParams(device.parameters);
  const bypass = device.bypass ?? false;
  const isPlugin =
    !!device.plugin_path && (device.plugin_type === 'vst3' || device.plugin_type === 'audiounit');

  if (isPlugin) {
    return {
      node_type: device.plugin_type,
      effect_name: device.name,
      parameters: params,
      bypass,
      vst_state: {
        plugin_path: device.plugin_path as string,
        plugin_name: device.name,
        parameters: params,
        ...savedVstState(device),
      },
    };
  }

  const mapped = resolveLiveEffectId(device.name);
  return {
    node_type: 'builtin',
    // A mapped theDAW id when we recognized it, else the original name so the
    // user still sees what the source project had (loader shows it inactive).
    effect_name: mapped ?? device.name,
    // Translate the DAW's parameter names onto the rack's so the mapped effect
    // instantiates with the SOURCE settings instead of rack defaults.
    parameters: mapped ? translateDawParams(mapped, params) : params,
    bypass,
  };
}

/**
 * The same parsed device as a LIVE chain entry — what `buildEffectChain` needs
 * to actually put it in the Perform graph.
 *
 * `dawDeviceToEffectNode` above stays exactly as it was: it produces the
 * PERSISTED interchange node (`EffectChainNode`, mirroring the backend's
 * model), where a plugin keeps its own `effect_name` (the device's name, which
 * is what the user sees in the loader) and carries its identity in
 * `vst_state`. Changing that shape would change the .tasmo format for every
 * consumer, so the live conversion is a second, additive step rather than an
 * edit to the first.
 *
 * The difference that matters: a live entry uses the chain builder's vocabulary
 * — `effect: 'vst3'` plus a `vst` node — which is the ONLY shape
 * `buildEffectChain`'s hosted-plugin branch recognises. Built from the device
 * name alone (as the Perform views used to), a plugin resolved to no rack
 * effect and no plugin path, so it could only ever be inert.
 *
 * `id` is supplied by the caller because it is load-bearing beyond this
 * function: the live VST session registry is keyed by chain-entry id, so the id
 * has to be stable across chain rebuilds, and Perform's controller mappings
 * already address slots by `perform-<track>-<device>`.
 *
 * The plugin is spawned with the state theDAW captured for it when the device
 * carries one (a .tasmo opened in PERFORM), so the set plays the sound it was
 * saved with. An imported DAW project carries only the plugin's own preset
 * data, in a format neither host reads, so that plugin starts at its defaults
 * and the user dials it in from its own GUI.
 */
export function dawDeviceToChainEntry(device: DawDevice, id: string): ChainEntry {
  const node = dawDeviceToEffectNode(device);
  const params = node.parameters ?? {};
  const enabled = !node.bypass;
  const vs = node.vst_state;
  if (vs?.plugin_path) {
    return {
      id,
      effect: 'vst3',
      params,
      enabled,
      vst: { plugin_path: vs.plugin_path, plugin_name: vs.plugin_name, ...savedVstState(vs) },
      label: vs.plugin_name || node.effect_name,
    };
  }
  return { id, effect: node.effect_name, params, enabled };
}

/** Whether a parsed device is a re-hostable plugin (as opposed to a stock
 *  effect this importer maps onto the rack, or one it can only preserve). */
export function isHostedPluginDevice(device: DawDevice): boolean {
  return !!dawDeviceToEffectNode(device).vst_state?.plugin_path;
}
