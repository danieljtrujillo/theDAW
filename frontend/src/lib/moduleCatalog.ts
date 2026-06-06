/* ── Studio Module catalog (Edit Tool Stack hero GUIs) ───────────────────────
   The 14 self-contained module GUIs that ship in frontend/public/edit-modules/.
   Each is a pixel-perfect 780×504 instrument with a live Web-Audio preview and a
   postMessage('stabledaw-audio') receiver, so the app embeds them verbatim in the
   MIX effect stage (see EffectGuiStage) — the EXACT GUI, no port. Mirrors the
   MODULES manifest from the scaffold's static/modules/index.html.

   `preview` keys the canvas thumbnail renderer in ModuleThumb. `effectIds` maps
   the existing /api/studio chain effects onto the module that best visualizes
   them, so selecting a chain entry opens the right instrument. */

export interface StudioModule {
  id: string;
  name: string;
  file: string;          // under /edit-modules/
  color: string;         // accent (hex)
  category: string;      // grouping label
  desc: string;
  preview: string;       // ModuleThumb renderer key
  effectIds?: string[];  // existing effectCatalog ids this module represents
}

export const STUDIO_MODULES: StudioModule[] = [
  { id: 'eq', name: 'EQ', file: 'eq.html', color: '#4dd0e1', category: 'EQ', preview: 'eq-bars',
    desc: '5-band parametric equalizer with draggable nodes', effectIds: ['eq_mid', 'highpass', 'lowpass'] },
  { id: 'dynamics', name: 'Dynamics', file: 'dynamics.html', color: '#66bb6a', category: 'Dynamics', preview: 'dynamics',
    desc: 'Compressor / gate / expander with transfer curve', effectIds: ['compression', 'loudnorm'] },
  { id: 'transient', name: 'Transient', file: 'transient.html', color: '#81c784', category: 'Dynamics', preview: 'transient',
    desc: 'Transient shaper — attack / sustain envelope' },
  { id: 'maximizer', name: 'Maximizer', file: 'maximizer.html', color: '#ffab40', category: 'Loudness', preview: 'maximizer',
    desc: 'Brick-wall limiter + loudness target', effectIds: ['mastering_chain', 'volume'] },
  { id: 'imager', name: 'Imager', file: 'imager.html', color: '#ab47bc', category: 'Spatial', preview: 'imager',
    desc: 'Stereo width + M/S processing', effectIds: ['stereo_widener', 'phase_isolation'] },
  { id: 'exciter', name: 'Exciter', file: 'exciter.html', color: '#ef5350', category: 'Color', preview: 'exciter',
    desc: 'Harmonic exciter + saturation', effectIds: ['sub_exciter'] },
  { id: 'character', name: 'Character FX', file: 'character-fx.html', color: '#ff7043', category: 'Color', preview: 'character',
    desc: 'Tape / tube / vinyl character', effectIds: ['lofi_vinyl'] },
  { id: 'cleanup', name: 'Cleanup', file: 'cleanup.html', color: '#26c6da', category: 'Repair', preview: 'cleanup',
    desc: 'Noise reduction + declip + dehum', effectIds: ['denoise', 'declick', 'silence_remove'] },
  { id: 'repair', name: 'Repair', file: 'repair.html', color: '#4dd0e1', category: 'Repair', preview: 'repair',
    desc: 'Spectral restoration + interpolation' },
  { id: 'enhance', name: 'Enhance', file: 'enhance.html', color: '#42a5f5', category: 'Enhance', preview: 'enhance',
    desc: 'Neural upscale + clarity boost', effectIds: ['vocal_processing'] },
  { id: 'vocoder', name: 'Vocoder', file: 'vocoder.html', color: '#e879f9', category: 'Creative', preview: 'vocoder',
    desc: 'Dual-spectrogram cross-synthesis vocoder' },
  { id: 'granular', name: 'Granular', file: 'granular.html', color: '#f59e0b', category: 'Creative', preview: 'granular',
    desc: 'Grain-cloud particle field with freeze', effectIds: ['reverb_delay', 'echo', 'delay'] },
  { id: 'promptfx', name: 'PromptFX', file: 'promptfx.html', color: '#8b5cf6', category: 'Creative', preview: 'promptfx',
    desc: 'Text-to-effect chain with keyword mapping' },
  { id: 'codec', name: 'Neural Codec', file: 'neural-codec.html', color: '#ef4444', category: 'Creative', preview: 'codec',
    desc: 'RVQ quantization explorer with glitch effects', effectIds: ['tempo', 'pitch_shift'] },
];

export const moduleById: Record<string, StudioModule> = Object.fromEntries(
  STUDIO_MODULES.map((m) => [m.id, m]),
);

/** Map an existing effectCatalog id → the module that best represents it. */
export const effectToModuleId: Record<string, string> = {};
STUDIO_MODULES.forEach((m) => (m.effectIds ?? []).forEach((fx) => { effectToModuleId[fx] = m.id; }));
