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

/** Ordered name patterns -> theDAW effect id. Specific before generic. */
const NATIVE_FX_PATTERNS: Array<[RegExp, string]> = [
  // Creative / spatial — these have a LIVE rack equivalent (real approximation).
  [/bitcrush|redux|decimat|crush|downsample/i, 'bitcrush'],
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

/**
 * Convert one parsed DAW device into a persisted EffectChainNode.
 *  - VST3/AU with a resolvable path  -> a VST node (re-hostable).
 *  - everything else                 -> a builtin node whose effect_name is the
 *    mapped theDAW id, or the raw device name when nothing maps (preserved).
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
      },
    };
  }

  const mapped = matchNativeEffect(device.name);
  return {
    node_type: 'builtin',
    // A mapped theDAW id when we recognized it, else the original name so the
    // user still sees what the source project had (loader shows it inactive).
    effect_name: mapped ?? device.name,
    parameters: params,
    bypass,
  };
}
