/**
 * Nodefi live sets — one ready-to-perform rig per GANTASMO song, titled by
 * the SONG (nothing else). Every set is a pure LIVE graph: stems or the full
 * mix looping through Live FX and Rack FX (Kargyraa, Gater, Chop, Ring Mod,
 * Bitcrush, Ares, The Owl, Phantom Bass…) with LFO automation on both
 * audio-rate ports and control-rate rack params. No AI model runs — press
 * LIVE and play the inspector. The AI node kinds stay available in the rail
 * for hand-built graphs.
 *
 * Source songs resolve AT LOAD TIME against the live library: the known entry
 * id is tried first, then a case-insensitive title match, so a set survives a
 * re-imported library. A set whose song is missing still loads — its source
 * nodes are left unset (and the rail shows "needs import").
 *
 * The store's loadTemplate seeds every effect/rack node's full default param
 * set under the authored overrides, so a set can never instantiate with holes.
 */
import type { LibraryEntry } from '../state/libraryStore';
import type { NodeKind } from '../lib/nodefiTypes';

export interface NodefiTemplateNode {
  /** Local wiring key — replaced by a fresh node id on load. */
  key: string;
  kind: NodeKind;
  x: number;
  y: number;
  title?: string;
  params?: Record<string, string | number>;
}

/** [fromKey, fromPort, toKey, toPort] */
export type NodefiTemplateEdge = [string, string, string, string];

export interface NodefiTemplate {
  id: string;
  /** The row title — always the song's name, nothing else. */
  name: string;
  song: string;
  description: string;
  accent: string;
  /** How the song's Library entry is found: exact id first, then title match. */
  source: { entryId?: string; titleQuery: string };
  /** Which node keys are source (stem/input) nodes fed by `source`. */
  sourceKeys: string[];
  nodes: NodefiTemplateNode[];
  edges: NodefiTemplateEdge[];
}

/** Resolve a template's source song against the loaded library entries. */
export function resolveTemplateSource(
  tpl: NodefiTemplate,
  entries: LibraryEntry[],
): LibraryEntry | null {
  const byId = tpl.source.entryId ? entries.find((e) => e.id === tpl.source.entryId) : undefined;
  if (byId) return byId;
  const q = tpl.source.titleQuery.toLowerCase();
  return entries.find((e) => (e.title || '').toLowerCase().includes(q)) ?? null;
}

export const NODEFI_TEMPLATES: NodefiTemplate[] = [
  {
    id: 'set-will-i-dream',
    name: 'Will I Dream',
    song: 'Will I Dream',
    description:
      'Six stems in a cathedral: gated drums breathing on a two-bar LFO, Phantom Bass under the low end, the vox re-grained through Ares into a dub tail, a four-bar filter sweep on guitar, and the keys orbiting the head through The Owl.',
    accent: '#38bdf8',
    source: { entryId: '22fd324b5f404689a196529454925777', titleQuery: 'will i dream' },
    sourceKeys: ['sD', 'sB', 'sG', 'sK', 'sT', 'sV'],
    nodes: [
      { key: 'sD', kind: 'stem', x: 40, y: 40, title: 'Drums', params: { stem: 'drums', gain: 1 } },
      { key: 'sB', kind: 'stem', x: 40, y: 180, title: 'Bass', params: { stem: 'bass', gain: 1 } },
      { key: 'sG', kind: 'stem', x: 40, y: 320, title: 'Guitar', params: { stem: 'guitar', gain: 0.9 } },
      { key: 'sK', kind: 'stem', x: 40, y: 460, title: 'Keys', params: { stem: 'piano', gain: 0.9 } },
      { key: 'sT', kind: 'stem', x: 40, y: 600, title: 'Tex', params: { stem: 'other', gain: 0.7 } },
      { key: 'sV', kind: 'stem', x: 40, y: 740, title: 'Vox', params: { stem: 'vocals', gain: 1 } },
      { key: 'rGate', kind: 'lrack', x: 280, y: 40, title: 'Breath Gate', params: { effect: 'gater', rate: 3.33, depth: 0.35, shape: 0, sync: 0, modParam: 'depth' } },
      { key: 'rPhantom', kind: 'lrack', x: 280, y: 180, title: 'Phantom Low', params: { effect: 'phantom_bass', drive: 8, blend: 0.7, crossover: 95 } },
      { key: 'fGtr', kind: 'lfilter', x: 280, y: 320, title: 'Gtr Sweep', params: { type: 'lowpass', freq: 1400, q: 2.5 } },
      { key: 'rOwl', kind: 'lrack', x: 280, y: 460, title: 'Orbiting Keys', params: { effect: 'spatializer', motion: 2, motionRate: 0.12, motionDepth: 3, distance: 2 } },
      { key: 'gTex', kind: 'lgain', x: 280, y: 600, title: 'Tex Trim', params: { gain: 0.7 } },
      { key: 'rAres', kind: 'lrack', x: 280, y: 740, title: 'Ares Vox', params: { effect: 'ares', wetDry: 0.7, grainsMix: 0.7, delayMix: 0.4, modParam: 'grainsDensity' } },
      { key: 'dVox', kind: 'ldelay', x: 520, y: 740, title: 'Dream Tail', params: { time: 0.45, feedback: 0.5, mix: 0.25 } },
      { key: 'loGate', kind: 'lfo', x: 520, y: 40, title: 'Breathe 2bar', params: { shape: 'sine', sync: '2bar', rate: 0.21, depth: 0.5 } },
      { key: 'loSweep', kind: 'lfo', x: 520, y: 320, title: 'Sweep 4bar', params: { shape: 'sine', sync: '4bar', rate: 0.1, depth: 1100 } },
      { key: 'loGrain', kind: 'lfo', x: 520, y: 600, title: 'Grain Drift', params: { shape: 'triangle', sync: '4bar', rate: 0.1, depth: 0.35 } },
      { key: 'out', kind: 'lout', x: 760, y: 390, title: 'Master', params: { gain: 0.9, bpm: 100 } },
    ],
    edges: [
      ['sD', 'out', 'rGate', 'in'],
      ['sB', 'out', 'rPhantom', 'in'],
      ['sG', 'out', 'fGtr', 'in'],
      ['sK', 'out', 'rOwl', 'in'],
      ['sT', 'out', 'gTex', 'in'],
      ['sV', 'out', 'rAres', 'in'],
      ['rAres', 'out', 'dVox', 'in'],
      ['rGate', 'out', 'out', 'in'],
      ['rPhantom', 'out', 'out', 'in'],
      ['fGtr', 'out', 'out', 'in'],
      ['rOwl', 'out', 'out', 'in'],
      ['gTex', 'out', 'out', 'in'],
      ['dVox', 'out', 'out', 'in'],
      ['loGate', 'out', 'rGate', 'mod'],
      ['loSweep', 'out', 'fGtr', 'freq'],
      ['loGrain', 'out', 'rAres', 'mod'],
    ],
  },
  {
    id: 'set-eacc',
    name: 'EACC',
    song: 'EACC',
    description:
      'Industrial pressure on six stems: bitcrushed drums pulsing per bar, the bass rebuilt as a Kargyraa throat-growl with an LFO morphing its vowel, ring-modded guitar sidebands, a resonant keys band, widened textures, and dotted-eighth vox throws.',
    accent: '#22d3ee',
    source: { entryId: '19e259419ad94beab511d668650b32ef', titleQuery: 'eacc' },
    sourceKeys: ['sD', 'sB', 'sG', 'sK', 'sT', 'sV'],
    nodes: [
      { key: 'sD', kind: 'stem', x: 40, y: 40, title: 'Drums', params: { stem: 'drums', gain: 1 } },
      { key: 'sB', kind: 'stem', x: 40, y: 180, title: 'Bass', params: { stem: 'bass', gain: 1 } },
      { key: 'sG', kind: 'stem', x: 40, y: 320, title: 'Guitar', params: { stem: 'guitar', gain: 0.85 } },
      { key: 'sK', kind: 'stem', x: 40, y: 460, title: 'Keys', params: { stem: 'piano', gain: 0.85 } },
      { key: 'sT', kind: 'stem', x: 40, y: 600, title: 'Tex', params: { stem: 'other', gain: 0.75 } },
      { key: 'sV', kind: 'stem', x: 40, y: 740, title: 'Vox', params: { stem: 'vocals', gain: 1 } },
      { key: 'rCrush', kind: 'lrack', x: 280, y: 40, title: 'Crushed Kit', params: { effect: 'bitcrush', bits: 6, mix: 0.35, modParam: 'mix' } },
      { key: 'rKarg', kind: 'lrack', x: 280, y: 180, title: 'Throat Bass', params: { effect: 'kargyraa', mix: 0.8, modParam: 'vowel' } },
      { key: 'rRing', kind: 'lrack', x: 280, y: 320, title: 'Sideband Gtr', params: { effect: 'ringmod', frequency: 220, mix: 0.3, modParam: 'frequency' } },
      { key: 'fKeys', kind: 'lfilter', x: 280, y: 460, title: 'Keys Band', params: { type: 'bandpass', freq: 900, q: 3 } },
      { key: 'rWide', kind: 'lrack', x: 280, y: 600, title: 'Wide Tex', params: { effect: 'stereo_widener', width: 1.8 } },
      { key: 'dVox', kind: 'ldelay', x: 280, y: 740, title: 'Vox Throw', params: { time: 0.348, feedback: 0.55, mix: 0.2 } },
      { key: 'loCrush', kind: 'lfo', x: 520, y: 40, title: 'Crush 1bar', params: { shape: 'square', sync: '1bar', rate: 0.54, depth: 0.3 } },
      { key: 'loVowel', kind: 'lfo', x: 520, y: 180, title: 'Vowel 1bar', params: { shape: 'sine', sync: '1bar', rate: 0.54, depth: 1.6 } },
      { key: 'loRing', kind: 'lfo', x: 520, y: 320, title: 'Carrier 2bar', params: { shape: 'sawtooth', sync: '2bar', rate: 0.27, depth: 160 } },
      { key: 'loKeys', kind: 'lfo', x: 520, y: 460, title: 'Band 1bar', params: { shape: 'sine', sync: '1bar', rate: 0.54, depth: 600 } },
      { key: 'loThrow', kind: 'lfo', x: 520, y: 740, title: 'Throw 2bar', params: { shape: 'triangle', sync: '2bar', rate: 0.27, depth: 0.5 } },
      { key: 'out', kind: 'lout', x: 760, y: 390, title: 'Master', params: { gain: 0.9, bpm: 129.49 } },
    ],
    edges: [
      ['sD', 'out', 'rCrush', 'in'],
      ['sB', 'out', 'rKarg', 'in'],
      ['sG', 'out', 'rRing', 'in'],
      ['sK', 'out', 'fKeys', 'in'],
      ['sT', 'out', 'rWide', 'in'],
      ['sV', 'out', 'dVox', 'in'],
      ['rCrush', 'out', 'out', 'in'],
      ['rKarg', 'out', 'out', 'in'],
      ['rRing', 'out', 'out', 'in'],
      ['fKeys', 'out', 'out', 'in'],
      ['rWide', 'out', 'out', 'in'],
      ['dVox', 'out', 'out', 'in'],
      ['loCrush', 'out', 'rCrush', 'mod'],
      ['loVowel', 'out', 'rKarg', 'mod'],
      ['loRing', 'out', 'rRing', 'mod'],
      ['loKeys', 'out', 'fKeys', 'freq'],
      ['loThrow', 'out', 'dVox', 'mix'],
    ],
  },
  {
    id: 'set-just-give-up',
    name: 'Just Give Up',
    song: 'Just Give Up',
    description:
      'The undertow: four-bar low-pass dives on the drums, a quarter-note sidechain duck on the bass, guitar and keys drifting through a crossfade, textures shuffled by an MPC-style Chop, and the vox soaked in reverb before dotted-eighth throw blocks.',
    accent: '#60a5fa',
    source: { entryId: 'b59f702915204c2b9543893d136ac196', titleQuery: 'just give up' },
    sourceKeys: ['sD', 'sB', 'sG', 'sK', 'sT', 'sV'],
    nodes: [
      { key: 'sD', kind: 'stem', x: 40, y: 40, title: 'Drums', params: { stem: 'drums', gain: 1 } },
      { key: 'sB', kind: 'stem', x: 40, y: 180, title: 'Bass', params: { stem: 'bass', gain: 1 } },
      { key: 'sG', kind: 'stem', x: 40, y: 320, title: 'Guitar', params: { stem: 'guitar', gain: 0.9 } },
      { key: 'sK', kind: 'stem', x: 40, y: 460, title: 'Keys', params: { stem: 'piano', gain: 0.9 } },
      { key: 'sT', kind: 'stem', x: 40, y: 600, title: 'Tex', params: { stem: 'other', gain: 0.7 } },
      { key: 'sV', kind: 'stem', x: 40, y: 740, title: 'Vox', params: { stem: 'vocals', gain: 1 } },
      { key: 'fDr', kind: 'lfilter', x: 280, y: 40, title: 'Drum Dive', params: { type: 'lowpass', freq: 9000, q: 0.8 } },
      { key: 'gBass', kind: 'lgain', x: 280, y: 180, title: 'Bass Duck', params: { gain: 1 } },
      { key: 'xGP', kind: 'xfade', x: 280, y: 390, title: 'Gtr–Keys Drift', params: { pos: 0.5 } },
      { key: 'rChop', kind: 'lrack', x: 280, y: 600, title: 'Tex Shuffle', params: { effect: 'chop', program: 1, rate: 4.6, slice: 0.5, mix: 0.4, latch: 1, modParam: 'mix' } },
      { key: 'rVerb', kind: 'lrack', x: 280, y: 740, title: 'Drown', params: { effect: 'reverb', decay: 4, wet: 0.35 } },
      { key: 'dVox', kind: 'ldelay', x: 520, y: 740, title: 'Undertow', params: { time: 0.305, feedback: 0.6, mix: 0.25 } },
      { key: 'loDive', kind: 'lfo', x: 520, y: 40, title: 'Dive 4bar', params: { shape: 'sine', sync: '4bar', rate: 0.15, depth: 7000 } },
      { key: 'loDuck', kind: 'lfo', x: 520, y: 180, title: 'Duck 1/4', params: { shape: 'sawtooth', sync: '1/4', rate: 2.46, depth: -0.5 } },
      { key: 'loDrift', kind: 'lfo', x: 520, y: 390, title: 'Drift 4bar', params: { shape: 'triangle', sync: '4bar', rate: 0.15, depth: 0.5 } },
      { key: 'loChop', kind: 'lfo', x: 520, y: 600, title: 'Blocks 2bar', params: { shape: 'square', sync: '2bar', rate: 0.31, depth: 0.35 } },
      { key: 'out', kind: 'lout', x: 760, y: 390, title: 'Master', params: { gain: 0.9, bpm: 147.55 } },
    ],
    edges: [
      ['sD', 'out', 'fDr', 'in'],
      ['sB', 'out', 'gBass', 'in'],
      ['sG', 'out', 'xGP', 'a'],
      ['sK', 'out', 'xGP', 'b'],
      ['sT', 'out', 'rChop', 'in'],
      ['sV', 'out', 'rVerb', 'in'],
      ['rVerb', 'out', 'dVox', 'in'],
      ['fDr', 'out', 'out', 'in'],
      ['gBass', 'out', 'out', 'in'],
      ['xGP', 'out', 'out', 'in'],
      ['rChop', 'out', 'out', 'in'],
      ['dVox', 'out', 'out', 'in'],
      ['loDive', 'out', 'fDr', 'freq'],
      ['loDuck', 'out', 'gBass', 'gain'],
      ['loDrift', 'out', 'xGP', 'pos'],
      ['loChop', 'out', 'rChop', 'mod'],
    ],
  },
  {
    id: 'set-gravy',
    name: 'Gravy',
    song: 'Gravy',
    description:
      'The full mix split three ways: a squeezed compressor lane crossfading against a chopped glitch lane (chop rate ridden by a one-bar saw), then the blend thickened through Phantom Bass and finished with an aural exciter.',
    accent: '#f59e0b',
    source: { titleQuery: 'gravy' },
    sourceKeys: ['src'],
    nodes: [
      { key: 'src', kind: 'stem', x: 40, y: 300, title: 'Gravy', params: { stem: 'mix', gain: 1 } },
      { key: 'rComp', kind: 'lrack', x: 280, y: 160, title: 'Squeeze', params: { effect: 'compressor', threshold: -30, ratio: 6, makeup: 4 } },
      { key: 'rChop', kind: 'lrack', x: 280, y: 440, title: 'Glitch Lane', params: { effect: 'chop', program: 2, rate: 8, slice: 0.4, mix: 1, latch: 1, modParam: 'rate' } },
      { key: 'fChop', kind: 'lfilter', x: 520, y: 440, title: 'Glitch Thin', params: { type: 'highpass', freq: 300, q: 1 } },
      { key: 'xMix', kind: 'xfade', x: 700, y: 300, title: 'Ladle', params: { pos: 0.25 } },
      { key: 'rPhantom', kind: 'lrack', x: 880, y: 300, title: 'Thicken', params: { effect: 'phantom_bass', drive: 10, blend: 0.8 } },
      { key: 'rExcite', kind: 'lrack', x: 1060, y: 300, title: 'Shine', params: { effect: 'exciter', amount: 12, mix: 0.5 } },
      { key: 'loDrift', kind: 'lfo', x: 520, y: 160, title: 'Blend 2bar', params: { shape: 'sine', sync: '2bar', rate: 0.4, depth: 0.3 } },
      { key: 'loRate', kind: 'lfo', x: 280, y: 620, title: 'Chop Ride', params: { shape: 'sawtooth', sync: '1bar', rate: 0.8, depth: 6 } },
      { key: 'out', kind: 'lout', x: 1240, y: 300, title: 'Master', params: { gain: 0.9, bpm: 96 } },
    ],
    edges: [
      ['src', 'out', 'rComp', 'in'],
      ['src', 'out', 'rChop', 'in'],
      ['rChop', 'out', 'fChop', 'in'],
      ['rComp', 'out', 'xMix', 'a'],
      ['fChop', 'out', 'xMix', 'b'],
      ['xMix', 'out', 'rPhantom', 'in'],
      ['rPhantom', 'out', 'rExcite', 'in'],
      ['rExcite', 'out', 'out', 'in'],
      ['loDrift', 'out', 'xMix', 'pos'],
      ['loRate', 'out', 'rChop', 'mod'],
    ],
  },
  {
    id: 'set-18301208',
    name: '18301208',
    song: '18301208',
    description:
      'A numbers-station scanner over the mix: an EQ-tilted body orbiting through The Owl, against a high-Q band scanned by a four-bar LFO into a ring-modded carrier and a one-beat echo well. D minor transmission at 107.67.',
    accent: '#a855f7',
    source: { entryId: '512d47b28fd94fd5869c802b10342acb', titleQuery: '18301208' },
    sourceKeys: ['src'],
    nodes: [
      { key: 'src', kind: 'stem', x: 40, y: 300, title: '18301208', params: { stem: 'mix', gain: 1 } },
      { key: 'rEq', kind: 'lrack', x: 280, y: 160, title: 'Body Tilt', params: { effect: 'parametric_eq', low: 2, midFreq: 800, mid: -3, high: 3 } },
      { key: 'rOwl', kind: 'lrack', x: 520, y: 160, title: 'Orbit', params: { effect: 'spatializer', motion: 5, motionRate: 0.2, motionDepth: 2.5 } },
      { key: 'fScan', kind: 'lfilter', x: 280, y: 440, title: 'Scanner', params: { type: 'bandpass', freq: 1800, q: 8 } },
      { key: 'rRing', kind: 'lrack', x: 520, y: 440, title: 'Carrier', params: { effect: 'ringmod', frequency: 130, mix: 0.6, modParam: 'frequency' } },
      { key: 'dEcho', kind: 'ldelay', x: 700, y: 440, title: 'Echo Well', params: { time: 0.557, feedback: 0.65, mix: 0.5 } },
      { key: 'loScan', kind: 'lfo', x: 40, y: 560, title: 'Scan 4bar', params: { shape: 'sine', sync: '4bar', rate: 0.11, depth: 1400 } },
      { key: 'loCarrier', kind: 'lfo', x: 280, y: 620, title: 'Detune 2bar', params: { shape: 'triangle', sync: '2bar', rate: 0.22, depth: 90 } },
      { key: 'out', kind: 'lout', x: 880, y: 300, title: 'Master', params: { gain: 0.9, bpm: 107.67 } },
    ],
    edges: [
      ['src', 'out', 'rEq', 'in'],
      ['rEq', 'out', 'rOwl', 'in'],
      ['src', 'out', 'fScan', 'in'],
      ['fScan', 'out', 'rRing', 'in'],
      ['rRing', 'out', 'dEcho', 'in'],
      ['rOwl', 'out', 'out', 'in'],
      ['dEcho', 'out', 'out', 'in'],
      ['loScan', 'out', 'fScan', 'freq'],
      ['loCarrier', 'out', 'rRing', 'mod'],
    ],
  },
  {
    id: 'set-dollar',
    name: "I'd Buy That For A Dollar",
    song: "I'd Buy That For A Dollar",
    description:
      'Consumer dystopia in three lanes: a bitcrusher whose depth is ridden by a two-bar saw into a pumping gate, a 55 Hz ring-mod robot band swept through a resonant filter, and a dry lane underneath to keep the product on the shelf.',
    accent: '#34d399',
    source: { titleQuery: 'buy that for a dollar' },
    sourceKeys: ['src'],
    nodes: [
      { key: 'src', kind: 'stem', x: 40, y: 300, title: 'For A Dollar', params: { stem: 'mix', gain: 1 } },
      { key: 'rCrush', kind: 'lrack', x: 280, y: 120, title: 'Bargain Crush', params: { effect: 'bitcrush', bits: 5, mix: 0.5, modParam: 'bits' } },
      { key: 'rGate', kind: 'lrack', x: 520, y: 120, title: 'Checkout Pump', params: { effect: 'gater', rate: 7.87, depth: 0.7, shape: 1, sync: 0, modParam: 'depth' } },
      { key: 'rVoc', kind: 'lrack', x: 280, y: 440, title: 'Robot Band', params: { effect: 'ringmod', frequency: 55, mix: 0.4 } },
      { key: 'fVoc', kind: 'lfilter', x: 520, y: 440, title: 'Robo Sweep', params: { type: 'bandpass', freq: 1200, q: 5 } },
      { key: 'gDry', kind: 'lgain', x: 280, y: 620, title: 'Shelf Stock', params: { gain: 0.5 } },
      { key: 'loBits', kind: 'lfo', x: 40, y: 120, title: 'Decay 2bar', params: { shape: 'sawtooth', sync: '2bar', rate: 0.49, depth: 5 } },
      { key: 'loPump', kind: 'lfo', x: 700, y: 120, title: 'Pump 1bar', params: { shape: 'sine', sync: '1bar', rate: 0.98, depth: 0.3 } },
      { key: 'loSweep', kind: 'lfo', x: 700, y: 440, title: 'Sweep 1bar', params: { shape: 'triangle', sync: '1bar', rate: 0.98, depth: 700 } },
      { key: 'out', kind: 'lout', x: 880, y: 300, title: 'Master', params: { gain: 0.9, bpm: 118 } },
    ],
    edges: [
      ['src', 'out', 'rCrush', 'in'],
      ['rCrush', 'out', 'rGate', 'in'],
      ['src', 'out', 'rVoc', 'in'],
      ['rVoc', 'out', 'fVoc', 'in'],
      ['src', 'out', 'gDry', 'in'],
      ['rGate', 'out', 'out', 'in'],
      ['fVoc', 'out', 'out', 'in'],
      ['gDry', 'out', 'out', 'in'],
      ['loBits', 'out', 'rCrush', 'mod'],
      ['loPump', 'out', 'rGate', 'mod'],
      ['loSweep', 'out', 'fVoc', 'freq'],
    ],
  },
  {
    id: 'set-renegade',
    name: 'Renegade',
    song: 'Renegade',
    description:
      'Cop-chase dub: a compressed pursuit lane crossfaded against a Kargyraa growl of the whole mix (its growl depth breathing on a one-bar sine), the blend thrown into a feeding dub delay and widened on the way out.',
    accent: '#e879f9',
    source: { entryId: 'aed1ca105ac94d9790698d270c0d07a1', titleQuery: 'renegade' },
    sourceKeys: ['src'],
    nodes: [
      { key: 'src', kind: 'stem', x: 40, y: 300, title: 'Renegade', params: { stem: 'mix', gain: 1 } },
      { key: 'rComp', kind: 'lrack', x: 280, y: 160, title: 'Pursuit', params: { effect: 'compressor', threshold: -28, ratio: 4, makeup: 3 } },
      { key: 'rKarg', kind: 'lrack', x: 280, y: 440, title: 'Growl Unit', params: { effect: 'kargyraa', mix: 0.9, vowel: 1.4, modParam: 'growlDepth' } },
      { key: 'xAB', kind: 'xfade', x: 520, y: 300, title: 'Two Lanes', params: { pos: 0.3 } },
      { key: 'dDub', kind: 'ldelay', x: 700, y: 300, title: 'Dub Tail', params: { time: 0.375, feedback: 0.62, mix: 0.3 } },
      { key: 'rWide', kind: 'lrack', x: 880, y: 300, title: 'All Points', params: { effect: 'stereo_widener', width: 1.6 } },
      { key: 'loGrowl', kind: 'lfo', x: 40, y: 560, title: 'Growl 1bar', params: { shape: 'sine', sync: '1bar', rate: 0.42, depth: 0.3 } },
      { key: 'loLaw', kind: 'lfo', x: 520, y: 560, title: 'Sirens 4bar', params: { shape: 'square', sync: '4bar', rate: 0.1, depth: 0.4 } },
      { key: 'loThrow', kind: 'lfo', x: 700, y: 560, title: 'Throw 2bar', params: { shape: 'triangle', sync: '2bar', rate: 0.21, depth: 0.45 } },
      { key: 'out', kind: 'lout', x: 1060, y: 300, title: 'Master', params: { gain: 0.9, bpm: 100 } },
    ],
    edges: [
      ['src', 'out', 'rComp', 'in'],
      ['src', 'out', 'rKarg', 'in'],
      ['rComp', 'out', 'xAB', 'a'],
      ['rKarg', 'out', 'xAB', 'b'],
      ['xAB', 'out', 'dDub', 'in'],
      ['dDub', 'out', 'rWide', 'in'],
      ['rWide', 'out', 'out', 'in'],
      ['loGrowl', 'out', 'rKarg', 'mod'],
      ['loLaw', 'out', 'xAB', 'pos'],
      ['loThrow', 'out', 'dDub', 'mix'],
    ],
  },
];
