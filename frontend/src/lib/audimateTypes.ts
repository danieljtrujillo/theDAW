/**
 * Audimate — node-graph editor data model.
 *
 * A graph is a set of nodes (each wrapping an existing generation/effect
 * action) connected by edges through typed ports. The runner (audimateRunner.ts)
 * topologically walks the graph, drives each node's underlying async action, and
 * feeds output audio blobs downstream. This module is the library-agnostic data
 * model + the node-type catalog; it has no React or DOM dependency.
 */

export type PortType = 'audio';
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
  | 'effect'
  | 'merge'
  | 'feedback'
  | 'output';

export type ParamFieldType = 'text' | 'number' | 'select' | 'library' | 'effect';

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
  effect: {
    kind: 'effect',
    label: 'Effect',
    group: 'Process',
    accent: '#f59e0b',
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
      { key: 'name', label: 'Name', type: 'text', placeholder: 'audimate-output' },
    ],
    defaults: { save: '1', name: '' },
  },
};

export const NODE_ORDER: NodeKind[] = [
  'input',
  'generate',
  'magenta',
  'effect',
  'merge',
  'feedback',
  'output',
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
