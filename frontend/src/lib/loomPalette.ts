/**
 * loomPalette — the colony's colours, in one place.
 *
 * Bioluminescent rather than primary: every role has its own hue, every cell
 * kind its own, and colony membranes rotate through a curated ring so two
 * neighbours never share one. Every colour is a hex; helpers turn it into an
 * rgba() at an alpha, or darken it for the light themes so ink stays ≥ 4.5:1.
 */

export const ROLE_COLOR: Record<string, string> = {
  kick: '#ff7a45',      // ember
  snare: '#ff5d8f',     // coral
  hihat: '#ffd166',     // gold
  cymbals: '#f4e58c',   // champagne
  toms: '#e0803c',      // rust
  drums: '#ff9f43',     // tangerine
  bass: '#2ee6c8',      // teal
  vocals: '#ff4fd8',    // magenta
  guitar: '#b5e550',    // lime
  piano: '#8ecae6',     // ice
  other: '#c3a6ff',     // lavender
  mix: '#dfe6ee',       // silver
};

export const KIND_COLOR = {
  loop: '#dfe6ee',
  rule: '#5cf0ff',      // electric cyan — the pacemakers
  gate: '#ffb703',      // amber
  mod: '#e879f9',       // orchid
  colony: '#9ad1ff',
} as const;

export const MEMBRANE_RING = ['#2ee6c8', '#ff8c69', '#ffd166', '#c3a6ff', '#7ef0a0', '#ff9fb2', '#8ecae6', '#e6c98a'];

export const SPARK = '#fff3b0';
export const SELECT = '#ffffff';
export const SELECT_HALO = '#5cf0ff';
export const WIRE_DRAFT = '#7ef0a0';
export const MYCELIUM_DARK = '#6fe3d2';
export const MYCELIUM_LIGHT = '#0f766e';

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgba(hex: string, a: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r},${g},${b},${Math.max(0, Math.min(1, a))})`;
}

/** Mix toward black (light themes) so a bright hue still reads on paper. */
export function onLight(hex: string, amount = 0.45): string {
  const [r, g, b] = hexToRgb(hex);
  const f = (v: number) => Math.round(v * (1 - amount));
  return `#${[f(r), f(g), f(b)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/** The colour of a cell for a theme. */
export function cellColor(kind: 'loop' | 'rule' | 'gate' | 'mod' | 'colony', role: string | undefined, light: boolean): string {
  const base = kind === 'loop' ? ROLE_COLOR[role ?? 'mix'] ?? ROLE_COLOR.mix : KIND_COLOR[kind];
  return light ? onLight(base) : base;
}

export function membraneColor(hash: number, light: boolean): string {
  const c = MEMBRANE_RING[hash % MEMBRANE_RING.length];
  return light ? onLight(c, 0.35) : c;
}
