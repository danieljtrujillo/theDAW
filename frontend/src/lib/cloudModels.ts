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

// The value /api/storage/model-status reports for the lyria provider's `state`
// field before its sidecar app (StarskreamEXE/lyria-3-pro) has been cloned and
// installed — see ProviderCards.tsx's `state === 'needs_setup'` handling,
// which is the same signal this reads (LyriaProviderExtras' `installable` /
// `missing` fields go further, but the base `state` string is enough to gate
// "offer this in a switcher" and needs no import from settings/).
const LYRIA_NEEDS_SETUP_STATE = 'needs_setup';

/** True once the Lyria sidecar has something to actually switch to — a
 *  missing/unreachable probe reads true (fail open, same convention as
 *  generateStore's modelGateMessage: an absent status never blocks). */
export const isLyriaCheckedOut = (lyriaProviderState: string | null | undefined): boolean =>
  lyriaProviderState == null || lyriaProviderState !== LYRIA_NEEDS_SETUP_STATE;

/**
 * INT-005: a cloud panel's own model switcher offered Lyria even when its
 * sidecar was never checked out, so picking it stranded the user on a "didn't
 * start" screen with no visible reason. Drops the `lyria` entry unless it is
 * checked out — but never drops the CURRENTLY selected value out from under a
 * controlled <select>, or the element renders with no matching option.
 */
export function panelModelOptions(
  currentModel: string,
  lyriaCheckedOut: boolean,
): ReadonlyArray<{ value: string; label: string }> {
  if (lyriaCheckedOut) return PANEL_MODEL_OPTIONS;
  return PANEL_MODEL_OPTIONS.filter((o) => o.value !== 'lyria' || o.value === currentModel);
}

/**
 * FE-006: the cloud panels' own "switch back to a local model" dropdown only
 * patched `model`, leaving the RF-Inversion-era steps/cfg defaults on an ARC
 * selection (or vice versa) until the user opened MAKE's real dropdown and
 * touched it again. Mirrors AdvancedGenPanel's real Model select, which
 * always recomputes steps/cfg on change; PANEL_MODEL_OPTIONS never offers
 * magenta-* or a local checkpoint, so the ARC/RF filename convention is the
 * whole rule here.
 */
export function panelModelDefaults(model: string): { steps: number; cfg: number } {
  return model.endsWith('-rf') ? { steps: 50, cfg: 7.0 } : { steps: 8, cfg: 1.0 };
}
