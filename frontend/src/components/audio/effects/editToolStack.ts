/**
 * editToolStack — a static mirror of the offline Edit Tool Stack the backend
 * mounts under /api/edit/<family> (backend/modules/<family>/router.py). The
 * live source of truth is GET /api/edit/<family>/tools; this table exists so
 * the frontend can enumerate, link and TEST the stack without a running
 * backend (see editModulesContract.test.ts and public/edit-modules/tool.html).
 *
 * Keep in sync with the TOOLS lists in backend/modules/{mastering,restoration,
 * enhance,creative_fx,creative_neural,delivery}/router.py.
 */

export interface EditToolFamily {
  /** Python package / family id. */
  id: string;
  /** URL prefix (module.json api_prefix). */
  prefix: string;
  label: string;
  tools: readonly string[];
}

export const EDIT_TOOL_FAMILIES: readonly EditToolFamily[] = [
  {
    id: 'mastering',
    prefix: '/api/edit/mastering',
    label: 'Mastering & Tonal',
    tools: [
      'parametric_eq', 'maximizer', 'stereo_imager', 'dynamic_eq', 'match_eq', 'multiband_dynamics',
      'harmonic_exciter', 'transient_shaper', 'spectral_stabilizer', 'loudness_meter', 'master_assistant',
    ],
  },
  {
    id: 'restoration',
    prefix: '/api/edit/restoration',
    label: 'Restoration & Cleanup',
    tools: [
      'vocal_isolate', 'stem_separation', 'neural_denoise', 'dereverb', 'declip', 'restore_all',
      'spectral_repair', 'breath_removal', 'dehum', 'deess', 'declick',
    ],
  },
  {
    id: 'enhance',
    prefix: '/api/edit/enhance',
    label: 'Enhance / Super-Resolution',
    tools: ['super_res', 'uncrush', 'studio_enhance', 'neural_codec', 'classical_upsample'],
  },
  {
    id: 'creative_fx',
    prefix: '/api/edit/creative-fx',
    label: 'Creative FX & Character',
    tools: [
      'ghost_voice', 'alien_transmission', 'broken_tape', 'radio_room', 'tunnel_pa',
      'glitch_machine', 'neural_reverb', 'pitchlift',
    ],
  },
  {
    id: 'creative_neural',
    prefix: '/api/edit/creative-neural',
    label: 'Creative Neural / Spectral',
    tools: [
      'spectramorph', 'timbreforge', 'promptfx', 'tokensynth', 'grainlab', 'crossfade_morph',
      'ambientforge', 'voxsynth',
    ],
  },
  {
    id: 'delivery',
    prefix: '/api/edit/delivery',
    label: 'Delivery / Export',
    tools: ['codec_matrix', 'smart_export', 'high_quality_src', 'dither', 'metadata', 'batch_export'],
  },
];

/** Knob names of the five Character-FX macros (backend/modules/creative_fx
 *  MACROS). The Character FX module page must post exactly these keys. */
export const CHARACTER_MACRO_KNOBS: Record<string, readonly string[]> = {
  ghost_voice: ['ghostiness', 'size'],
  alien_transmission: ['mod', 'speed'],
  broken_tape: ['wow', 'tilt'],
  radio_room: ['distance', 'muffle', 'room'],
  tunnel_pa: ['harsh', 'distance'],
};

export const ALL_EDIT_TOOL_IDS: ReadonlySet<string> = new Set(EDIT_TOOL_FAMILIES.flatMap((f) => f.tools));

/** The module page that hosts a tool, when a bespoke one exists; else the
 *  generic schema-driven page. */
export function editToolPageFor(family: string, tool: string): string {
  const bespoke: Record<string, string> = {
    'mastering/parametric_eq': 'eq.html',
    'mastering/multiband_dynamics': 'dynamics.html',
    'mastering/transient_shaper': 'transient.html',
    'mastering/maximizer': 'maximizer.html',
    'mastering/stereo_imager': 'imager.html',
    'mastering/harmonic_exciter': 'exciter.html',
    'creative_fx/broken_tape': 'character-fx.html',
    'creative_fx/ghost_voice': 'character-fx.html',
    'creative_fx/radio_room': 'character-fx.html',
    'creative_fx/alien_transmission': 'character-fx.html',
    'creative_fx/tunnel_pa': 'character-fx.html',
    'restoration/neural_denoise': 'cleanup.html',
    'restoration/declip': 'cleanup.html',
    'restoration/dehum': 'cleanup.html',
    'restoration/declick': 'repair.html',
    'restoration/dereverb': 'repair.html',
    'enhance/super_res': 'enhance.html',
    'enhance/uncrush': 'enhance.html',
    'enhance/studio_enhance': 'enhance.html',
    'enhance/classical_upsample': 'enhance.html',
    'enhance/neural_codec': 'neural-codec.html',
    'creative_neural/voxsynth': 'vocoder.html',
    'creative_neural/grainlab': 'granular.html',
    'creative_neural/promptfx': 'promptfx.html',
  };
  return bespoke[`${family}/${tool}`] ?? `tool.html?family=${encodeURIComponent(family)}&tool=${encodeURIComponent(tool)}`;
}
