// capabilities: what each generator that actually exists in this app can take
// as input, and what parameters it exposes. The candidates UI reads this
// registry to label a set and to decide whether 'Generate variations…' is
// offered for a given selection — it never re-derives that from the
// generation stores directly, so a new provider is one registry entry away
// from showing up correctly everywhere that asks.
//
// Pure data + pure functions only: no React, no imports from state/, no
// network calls. Every param key below is a REAL key read by (or written
// into) the generator's own store/panel — each entry carries a `source`
// comment naming exactly where it was verified.

export type ProviderInputKind = 'none' | 'clip' | 'clip-range' | 'library-entry' | 'clips';

export type ProviderId = 'sa3' | 'magenta' | 'chimera' | 'lyria' | 'suno';

export interface ProviderParamSpec {
  key: string;
  label: string;
  kind: 'number' | 'text' | 'enum' | 'boolean';
}

export interface ProviderCapability {
  id: ProviderId;
  label: string;
  inputs: ProviderInputKind[];
  params: ProviderParamSpec[];
  producesAudio: boolean;
  supportsVariations: boolean;
}

export const PROVIDER_CAPABILITIES: Readonly<Record<ProviderId, ProviderCapability>> = {
  // source: frontend/src/state/generateParamsStore.ts:182-241 (GenerateParamsState)
  // source: frontend/src/views/AdvancedGenPanel.tsx:933-1077 (model select, Length/Steps/CFG/Seed/Sampler controls)
  sa3: {
    id: 'sa3',
    label: 'Stable Audio 3',
    inputs: ['none', 'clip', 'clip-range', 'library-entry'],
    params: [
      { key: 'prompt', label: 'Prompt', kind: 'text' },
      { key: 'negativePrompt', label: 'Negative Prompt', kind: 'text' },
      { key: 'model', label: 'Model', kind: 'enum' },
      { key: 'duration', label: 'Length (s)', kind: 'number' },
      { key: 'steps', label: 'Steps', kind: 'number' },
      { key: 'cfg', label: 'CFG', kind: 'number' },
      { key: 'seed', label: 'Seed', kind: 'number' },
      { key: 'batch', label: 'Batch', kind: 'number' },
      { key: 'samplerType', label: 'Sampler', kind: 'enum' },
      { key: 'sigmaMax', label: 'Sigma Max', kind: 'number' },
      { key: 'durationPaddingSec', label: 'Duration Padding (s)', kind: 'number' },
      { key: 'apgScale', label: 'APG Scale', kind: 'number' },
      { key: 'cfgRescale', label: 'CFG Rescale', kind: 'number' },
      { key: 'initNoise', label: 'Init Noise', kind: 'number' },
      { key: 'initType', label: 'Init Type', kind: 'enum' },
      { key: 'initAudioEnabled', label: 'Init Audio', kind: 'boolean' },
      { key: 'inpaintEnabled', label: 'Inpaint', kind: 'boolean' },
      { key: 'maskStart', label: 'Mask Start', kind: 'number' },
      { key: 'maskEnd', label: 'Mask End', kind: 'number' },
    ],
    producesAudio: true,
    supportsVariations: true,
  },

  // source: frontend/src/state/generateParamsStore.ts:183,186,189 (prompt/duration/seed — shared with sa3)
  // source: frontend/src/views/AdvancedGenPanel.tsx:935,941 (isMag forces steps: 1, cfg: 1.0 — not user-adjustable)
  magenta: {
    id: 'magenta',
    label: 'Magenta RT2',
    inputs: ['none', 'clip'],
    params: [
      { key: 'prompt', label: 'Prompt', kind: 'text' },
      { key: 'duration', label: 'Length (s)', kind: 'number' },
      { key: 'seed', label: 'Seed', kind: 'number' },
    ],
    producesAudio: true,
    supportsVariations: true,
  },

  // source: frontend/src/state/generateParamsStore.ts:158-177 (ChimeraState)
  chimera: {
    id: 'chimera',
    label: 'Chimera',
    inputs: ['clips'],
    params: [
      { key: 'targetBpm', label: 'Target BPM', kind: 'number' },
      { key: 'alignMode', label: 'Align Mode', kind: 'enum' },
      { key: 'weaveBars', label: 'Weave Bars', kind: 'number' },
      { key: 'harmony', label: 'Harmony', kind: 'enum' },
      { key: 'arc', label: 'Arc', kind: 'enum' },
      { key: 'heal', label: 'Heal', kind: 'enum' },
      { key: 'engine', label: 'Engine', kind: 'enum' },
    ],
    producesAudio: true,
    supportsVariations: true,
  },

  // source: frontend/src/views/LyriaPanel.tsx:19-50 (embedded iframe reached via /api/lyria/url; no local input or params)
  lyria: {
    id: 'lyria',
    label: 'Lyria 3 Pro',
    inputs: ['none'],
    params: [],
    producesAudio: true,
    supportsVariations: false,
  },

  // source: frontend/src/suno/sunoStore.ts:28-38 (SunoFormState: description, style, sourceId)
  suno: {
    id: 'suno',
    label: 'Suno',
    inputs: ['none', 'library-entry'],
    params: [
      { key: 'description', label: 'Description', kind: 'text' },
      { key: 'style', label: 'Style', kind: 'text' },
    ],
    producesAudio: true,
    supportsVariations: true,
  },
};

export function providerFor(id: string): ProviderCapability | null {
  return Object.prototype.hasOwnProperty.call(PROVIDER_CAPABILITIES, id)
    ? PROVIDER_CAPABILITIES[id as ProviderId]
    : null;
}

export function acceptsInput(id: string, kind: ProviderInputKind): boolean {
  return providerFor(id)?.inputs.includes(kind) ?? false;
}

export function providersForInput(kind: ProviderInputKind): ProviderCapability[] {
  return Object.values(PROVIDER_CAPABILITIES).filter(
    (cap) => cap.supportsVariations && cap.inputs.includes(kind),
  );
}

/** Renders a value the same way regardless of where it came from: booleans as
 *  On/Off (never 'true'/'false' in a UI string), finite numbers as-is, and
 *  anything else (including non-finite numbers) as an em dash rather than
 *  'NaN' or 'undefined' leaking into the drawer. */
function formatParamValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'On' : 'Off';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '—';
  if (value === null || value === undefined) return '—';
  return String(value);
}

export function paramSummary(id: string, params: Record<string, unknown>): string {
  const cap = providerFor(id);
  if (!cap) return '';
  const parts: string[] = [];
  for (const spec of cap.params) {
    if (!Object.prototype.hasOwnProperty.call(params, spec.key)) continue;
    const value = params[spec.key];
    if (value === undefined) continue;
    parts.push(`${spec.label} ${formatParamValue(value)}`);
  }
  return parts.join(' · ');
}
