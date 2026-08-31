/**
 * Nodefi — node-graph editor data model.
 *
 * A graph is a set of nodes (each wrapping an existing generation/effect
 * action) connected by edges through typed ports. The runner (nodefiRunner.ts)
 * topologically walks the graph, drives each node's underlying async action, and
 * feeds output audio blobs downstream. This module is the library-agnostic data
 * model + the node-type catalog; it has no React or DOM dependency.
 */

export type PortType = 'audio' | 'mod';
export type PortDir = 'in' | 'out';

export interface Port {
  id: string;
  label: string;
  type: PortType;
  dir: PortDir;
  /** Accepts more than one incoming edge (used by Merge). */
  variadic?: boolean;
  /** An input that is not required for the node to run (e.g. Generate init). */
  optional?: boolean;
}

export type NodeKind =
  | 'input'
  | 'generate'
  | 'magenta'
  | 'suno'
  | 'effect'
  | 'merge'
  | 'feedback'
  | 'output'
  // Live performance kinds — run in real time through Web Audio (nodefiLive),
  // no AI model involved. Offline Run rejects them (except 'stem', which also
  // works offline as a source).
  | 'stem'
  | 'lfilter'
  | 'lgain'
  | 'ldelay'
  | 'xfade'
  | 'lfo'
  | 'lrack'
  | 'lout';

export type ParamFieldType = 'text' | 'number' | 'select' | 'library' | 'effect' | 'stem' | 'rackeffect';

export interface ParamField {
  key: string;
  label: string;
  type: ParamFieldType;
  min?: number;
  max?: number;
  step?: number;
  options?: Array<{ value: string; label: string }>;
  placeholder?: string;
}

export interface NodeDef {
  kind: NodeKind;
  label: string;
  group: string;
  accent: string;
  /** One-line description shown in the palette rail. */
  hint?: string;
  inputs: Port[];
  outputs: Port[];
  fields: ParamField[];
  defaults: Record<string, string | number>;
}

export interface GraphNode {
  id: string;
  kind: NodeKind;
  x: number;
  y: number;
  title?: string;
  params: Record<string, string | number>;
}

export interface GraphEdge {
  id: string;
  from: string;
  fromPort: string;
  to: string;
  toPort: string;
}

export type NodeRunStatus = 'idle' | 'queued' | 'running' | 'done' | 'error';

const SA3_MODELS = [
  { value: 'small', label: 'Small (ARC)' },
  { value: 'medium', label: 'Medium (ARC)' },
];

const AUDIO_IN = (extra?: Partial<Port>): Port => ({
  id: 'in',
  label: 'in',
  type: 'audio',
  dir: 'in',
  ...extra,
});
const AUDIO_OUT: Port = { id: 'out', label: 'out', type: 'audio', dir: 'out' };

export const NODE_DEFS: Record<NodeKind, NodeDef> = {
  input: {
    kind: 'input',
    label: 'Library',
    group: 'Sources',
    accent: '#38bdf8',
    hint: 'Pull a track from your library',
    inputs: [],
    outputs: [AUDIO_OUT],
    fields: [{ key: 'libraryId', label: 'Entry', type: 'library' }],
    defaults: { libraryId: '' },
  },
  generate: {
    kind: 'generate',
    label: 'Generate',
    group: 'Generate',
    accent: '#a855f7',
    hint: 'Stable Audio from a prompt (+ optional init)',
    inputs: [AUDIO_IN({ id: 'init', label: 'init', optional: true })],
    outputs: [AUDIO_OUT],
    fields: [
      { key: 'prompt', label: 'Prompt', type: 'text', placeholder: 'a warm analog pad…' },
      { key: 'model', label: 'Model', type: 'select', options: SA3_MODELS },
      { key: 'duration', label: 'Duration (s)', type: 'number', min: 1, max: 47, step: 1 },
      { key: 'steps', label: 'Steps', type: 'number', min: 1, max: 100, step: 1 },
      { key: 'cfg', label: 'CFG', type: 'number', min: 0, max: 15, step: 0.1 },
      { key: 'seed', label: 'Seed (-1 random)', type: 'number', min: -1, step: 1 },
      { key: 'initNoise', label: 'Init noise', type: 'number', min: 0, max: 1, step: 0.05 },
    ],
    defaults: { prompt: '', model: 'medium', duration: 8, steps: 8, cfg: 1, seed: -1, initNoise: 0.7 },
  },
  magenta: {
    kind: 'magenta',
    label: 'Magenta',
    group: 'Generate',
    accent: '#22d3ee',
    hint: 'Magenta RT2 (+ optional style clone)',
    inputs: [AUDIO_IN({ id: 'style', label: 'style', optional: true })],
    outputs: [AUDIO_OUT],
    fields: [
      { key: 'prompt', label: 'Prompt', type: 'text', placeholder: 'lofi hip-hop drums…' },
      {
        key: 'model',
        label: 'Model',
        type: 'select',
        options: [{ value: 'magenta-small', label: 'Magenta RT2' }],
      },
      { key: 'duration', label: 'Duration (s)', type: 'number', min: 1, max: 30, step: 1 },
      { key: 'magTemperature', label: 'Temperature', type: 'number', min: 0.1, max: 2, step: 0.05 },
    ],
    defaults: { prompt: '', model: 'magenta-small', duration: 8, magTemperature: 1.1 },
  },
  suno: {
    kind: 'suno',
    label: 'Suno (Cloud)',
    group: 'Generate',
    accent: '#7dd3fc',
    hint: 'Cloud generation via the Suno API — no local GPU',
    inputs: [],
    outputs: [AUDIO_OUT],
    fields: [
      {
        key: 'mode',
        label: 'Mode',
        type: 'select',
        options: [
          { value: 'simple', label: 'Simple (describe it)' },
          { value: 'custom', label: 'Custom (style + lyrics)' },
        ],
      },
      { key: 'prompt', label: 'Description / Style', type: 'text', placeholder: 'dusty boom-bap with detuned rhodes…' },
      { key: 'lyrics', label: 'Lyrics (Custom mode)', type: 'text', placeholder: 'optional lyrics' },
      {
        key: 'instrumental',
        label: 'Instrumental',
        type: 'select',
        options: [
          { value: '1', label: 'Yes' },
          { value: '0', label: 'No' },
        ],
      },
      { key: 'title', label: 'Title', type: 'text', placeholder: 'optional title' },
    ],
    defaults: { mode: 'simple', prompt: '', lyrics: '', instrumental: '1', title: '' },
  },
  effect: {
    kind: 'effect',
    label: 'Effect',
    group: 'Process',
    accent: '#f59e0b',
    hint: 'Studio effect — EQ, space, lo-fi, master',
    inputs: [AUDIO_IN()],
    outputs: [AUDIO_OUT],
    fields: [{ key: 'effect', label: 'Effect', type: 'effect' }],
    defaults: { effect: 'mastering_chain' },
  },
  merge: {
    kind: 'merge',
    label: 'Merge / Mix',
    group: 'Process',
    accent: '#34d399',
    hint: 'Sum any number of inputs into one',
    inputs: [AUDIO_IN({ label: 'ins', variadic: true })],
    outputs: [AUDIO_OUT],
    fields: [
      {
        key: 'normalize',
        label: 'Normalize',
        type: 'select',
        options: [
          { value: '1', label: 'On' },
          { value: '0', label: 'Off' },
        ],
      },
    ],
    defaults: { normalize: '1' },
  },
  feedback: {
    kind: 'feedback',
    label: 'Feedback',
    group: 'Process',
    accent: '#fb7185',
    hint: 'Loop a signal back N passes',
    inputs: [AUDIO_IN()],
    outputs: [AUDIO_OUT],
    fields: [{ key: 'iterations', label: 'Iterations', type: 'number', min: 1, max: 8, step: 1 }],
    defaults: { iterations: 3 },
  },
  output: {
    kind: 'output',
    label: 'Output',
    group: 'Output',
    accent: '#e879f9',
    hint: 'Render + save into the library',
    inputs: [AUDIO_IN()],
    outputs: [],
    fields: [
      {
        key: 'save',
        label: 'Save to library',
        type: 'select',
        options: [
          { value: '1', label: 'Yes' },
          { value: '0', label: 'No' },
        ],
      },
      { key: 'name', label: 'Name', type: 'text', placeholder: 'nodefi-output' },
    ],
    defaults: { save: '1', name: '' },
  },

  // ── Live performance kinds ─────────────────────────────────────────────────
  stem: {
    kind: 'stem',
    label: 'Stem',
    group: 'Sources',
    accent: '#2dd4bf',
    hint: 'A separated stem, looping live',
    inputs: [],
    outputs: [AUDIO_OUT],
    fields: [
      { key: 'libraryId', label: 'Song', type: 'library' },
      { key: 'stem', label: 'Stem', type: 'stem' },
      { key: 'gain', label: 'Gain', type: 'number', min: 0, max: 2, step: 0.05 },
    ],
    defaults: { libraryId: '', stem: 'drums', gain: 1 },
  },
  lfilter: {
    kind: 'lfilter',
    label: 'Filter (Live)',
    group: 'Live FX',
    accent: '#60a5fa',
    hint: 'Real-time filter — sweepable',
    inputs: [AUDIO_IN(), { id: 'freq', label: 'freq mod', type: 'mod', dir: 'in', optional: true }],
    outputs: [AUDIO_OUT],
    fields: [
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: [
          { value: 'lowpass', label: 'Low-pass' },
          { value: 'highpass', label: 'High-pass' },
          { value: 'bandpass', label: 'Band-pass' },
          { value: 'notch', label: 'Notch' },
        ],
      },
      { key: 'freq', label: 'Freq (Hz)', type: 'number', min: 20, max: 20000, step: 1 },
      { key: 'q', label: 'Resonance (Q)', type: 'number', min: 0.1, max: 30, step: 0.1 },
    ],
    defaults: { type: 'lowpass', freq: 800, q: 1.2 },
  },
  lgain: {
    kind: 'lgain',
    label: 'VCA (Live)',
    group: 'Live FX',
    accent: '#a3e635',
    hint: 'Real-time gain — gate, duck, pump',
    inputs: [AUDIO_IN(), { id: 'gain', label: 'gain mod', type: 'mod', dir: 'in', optional: true }],
    outputs: [AUDIO_OUT],
    fields: [{ key: 'gain', label: 'Gain', type: 'number', min: 0, max: 2, step: 0.05 }],
    defaults: { gain: 1 },
  },
  ldelay: {
    kind: 'ldelay',
    label: 'Echo (Live)',
    group: 'Live FX',
    accent: '#fb923c',
    hint: 'Real-time echo — mod the mix for throws',
    inputs: [AUDIO_IN(), { id: 'mix', label: 'mix mod', type: 'mod', dir: 'in', optional: true }],
    outputs: [AUDIO_OUT],
    fields: [
      { key: 'time', label: 'Time (s)', type: 'number', min: 0.01, max: 2, step: 0.005 },
      { key: 'feedback', label: 'Feedback', type: 'number', min: 0, max: 0.95, step: 0.05 },
      { key: 'mix', label: 'Mix', type: 'number', min: 0, max: 1, step: 0.05 },
    ],
    defaults: { time: 0.375, feedback: 0.5, mix: 0.35 },
  },
  xfade: {
    kind: 'xfade',
    label: 'Crossfade (Live)',
    group: 'Live FX',
    accent: '#c084fc',
    hint: 'Morph between two inputs',
    inputs: [
      { id: 'a', label: 'a', type: 'audio', dir: 'in' },
      { id: 'b', label: 'b', type: 'audio', dir: 'in' },
      { id: 'pos', label: 'pos mod', type: 'mod', dir: 'in', optional: true },
    ],
    outputs: [AUDIO_OUT],
    fields: [{ key: 'pos', label: 'Position (A→B)', type: 'number', min: 0, max: 1, step: 0.01 }],
    defaults: { pos: 0.5 },
  },
  lrack: {
    kind: 'lrack',
    label: 'Rack FX',
    group: 'Live FX',
    accent: '#f472b6',
    hint: 'Any rack effect live — Kargyraa, Gater, Chop, Ares…',
    inputs: [AUDIO_IN(), { id: 'mod', label: 'param mod', type: 'mod', dir: 'in', optional: true }],
    outputs: [AUDIO_OUT],
    fields: [
      { key: 'effect', label: 'Effect', type: 'rackeffect' },
      { key: 'modParam', label: 'Mod target param', type: 'text', placeholder: 'param key an LFO drives (e.g. vowel, depth, x)' },
    ],
    defaults: { effect: 'gater', modParam: '' },
  },
  lfo: {
    kind: 'lfo',
    label: 'LFO',
    group: 'Automation',
    accent: '#facc15',
    hint: 'Automation — wire to a mod port',
    inputs: [],
    outputs: [{ id: 'out', label: 'mod', type: 'mod', dir: 'out' }],
    fields: [
      {
        key: 'shape',
        label: 'Shape',
        type: 'select',
        options: [
          { value: 'sine', label: 'Sine' },
          { value: 'triangle', label: 'Triangle' },
          { value: 'square', label: 'Square' },
          { value: 'sawtooth', label: 'Saw' },
        ],
      },
      {
        key: 'sync',
        label: 'Sync',
        type: 'select',
        options: [
          { value: 'free', label: 'Free (Hz)' },
          { value: '1/16', label: '1/16 note' },
          { value: '1/8', label: '1/8 note' },
          { value: '1/4', label: '1/4 note' },
          { value: '1/2', label: '1/2 note' },
          { value: '1bar', label: '1 bar' },
          { value: '2bar', label: '2 bars' },
          { value: '4bar', label: '4 bars' },
        ],
      },
      { key: 'rate', label: 'Rate (Hz, when Free)', type: 'number', min: 0.01, max: 40, step: 0.01 },
      { key: 'depth', label: 'Depth (target units)', type: 'number', step: 0.05 },
    ],
    defaults: { shape: 'sine', sync: '1bar', rate: 0.5, depth: 0.5 },
  },
  lout: {
    kind: 'lout',
    label: 'Live Out',
    group: 'Output',
    accent: '#f43f5e',
    hint: 'Live master — sets the BPM for sync',
    inputs: [AUDIO_IN({ label: 'ins', variadic: true })],
    outputs: [],
    fields: [
      { key: 'gain', label: 'Master gain', type: 'number', min: 0, max: 1.5, step: 0.05 },
      { key: 'bpm', label: 'BPM (LFO sync)', type: 'number', min: 40, max: 220, step: 0.01 },
    ],
    defaults: { gain: 0.9, bpm: 120 },
  },
};

export const NODE_ORDER: NodeKind[] = [
  'input',
  'stem',
  'generate',
  'magenta',
  'suno',
  'effect',
  'merge',
  'feedback',
  'lfilter',
  'lgain',
  'ldelay',
  'xfade',
  'lrack',
  'lfo',
  'output',
  'lout',
];

export const nodeDef = (kind: NodeKind): NodeDef => NODE_DEFS[kind];

/** Grouped node kinds for the palette. */
export function paletteGroups(): Array<{ group: string; kinds: NodeKind[] }> {
  const seen: string[] = [];
  const by: Record<string, NodeKind[]> = {};
  for (const k of NODE_ORDER) {
    const g = NODE_DEFS[k].group;
    if (!by[g]) {
      by[g] = [];
      seen.push(g);
    }
    by[g].push(k);
  }
  return seen.map((group) => ({ group, kinds: by[group] }));
}
