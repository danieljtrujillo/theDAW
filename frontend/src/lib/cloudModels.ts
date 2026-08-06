// Model identity in MAKE is encoded by string convention, not a provider
// descriptor: `magenta-*` is the WSL2 engine, `*-rf` is rectified-flow,
// `local:*` is a registered checkpoint, and everything else is a bundled SA3
// model. Cloud providers are the exception that convention can't express, so
// they were spelled out inline as `model !== 'suno'` in several places.
//
// This set exists so adding a provider is one edit rather than a hunt. Cloud
// models share three properties that local models don't:
//   * nothing to pre-load onto the GPU (no LOAD pill)
//   * no GPU engine swap on select
//   * CREATE must not report "this model isn't on this machine"
export const CLOUD_MODELS: ReadonlySet<string> = new Set(['suno', 'lyria']);

export const isCloudModel = (model: string): boolean => CLOUD_MODELS.has(model);

// A cloud panel replaces the WHOLE Make surface, which hides AdvancedGenPanel —
// and with it the real model dropdown. So each cloud panel must carry its own
// way back, or selecting one strands the user with no route to any other model.
//
// This list deliberately OMITS magenta-*: the panels patch `model` directly
// without calling swapEngineForModel, so offering Magenta here would select it
// while silently skipping the GPU engine swap. Local checkpoints are omitted
// too — they're fetched per-session and don't belong in a static list.
export const PANEL_MODEL_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: 'small', label: 'Small (ARC)' },
  { value: 'medium', label: 'Medium (ARC)' },
  { value: 'small-rf', label: 'Small-RF' },
  { value: 'medium-rf', label: 'Medium-RF' },
  { value: 'suno', label: 'Suno (Cloud)' },
  { value: 'lyria', label: 'Lyria 3 Pro (Cloud)' },
];
