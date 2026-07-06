/**
 * EDIT-layout color themes.
 *
 * The WaveformEditor root carries the `edit-theme-scope` class. A block of
 * unlayered CSS in index.css remaps the layout's neutral chrome — every
 * `bg-black/*` surface, `bg-white/*` fill, and `border-white/*` / hex border —
 * onto the CSS custom properties defined here. Because the default "Midnight"
 * theme's variables reproduce the original hardcoded palette exactly, an
 * un-themed editor is pixel-identical; every other theme just swaps the
 * variable values. Only backgrounds + borders (+ text legibility on light
 * themes) are affected — semantic accents (purple/red/amber/…) are untouched.
 *
 * Variable roles:
 *   --et-root-bg : the editor canvas backdrop (solid, gradient, or image)
 *   --et-shade   : rgb triple that all `bg-black/α` surfaces resolve to
 *   --et-canvas  : the scrolling timeline background (`#07050a`)
 *   --et-panel   : the track-header column (`#0c0a12`)
 *   --et-popup   : floating panels (`#0a080f`)
 *   --et-line    : rgb triple for `border-white/α` dividers
 *   --et-line-hex: the track-header hex border (`#1a1528`)
 *   --et-tint    : rgb triple for `bg-white/α` subtle fills
 *   --et-ink     : rgb triple for text on light themes
 */

export interface EditTheme {
  id: string;
  label: string;
  group: string;
  light?: boolean;
  /** Overrides merged over DEFAULT_ET_VARS. */
  vars: Record<string, string>;
}

/** Midnight / default — these values reproduce the original EDIT palette. */
export const DEFAULT_ET_VARS: Record<string, string> = {
  '--et-root-bg': '#07050a',
  '--et-shade': '0 0 0',
  '--et-canvas': '#07050a',
  '--et-panel': '#0c0a12',
  '--et-popup': '#0a080f',
  '--et-line': '255 255 255',
  '--et-line-hex': '#1a1528',
  '--et-tint': '255 255 255',
  '--et-ink': '245 243 255',
};

export const EDIT_THEMES: EditTheme[] = [
  // ── Dark ──────────────────────────────────────────────────────────────
  { id: 'midnight', label: 'Midnight', group: 'Dark', vars: {} },
  {
    id: 'obsidian',
    label: 'Obsidian',
    group: 'Dark',
    vars: {
      '--et-root-bg': 'radial-gradient(circle at 50% -10%, #14141c 0%, #050507 62%)',
      '--et-shade': '0 0 0',
      '--et-canvas': '#050507',
      '--et-panel': '#0a0a0d',
      '--et-popup': '#050506',
      '--et-line': '236 239 246',
      '--et-line-hex': '#191922',
      '--et-tint': '236 239 246',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    group: 'Dark',
    vars: {
      '--et-root-bg': '#111216',
      '--et-shade': '18 20 26',
      '--et-canvas': '#15161a',
      '--et-panel': '#1d1f24',
      '--et-popup': '#131418',
      '--et-line': '212 218 230',
      '--et-line-hex': '#2a2d34',
      '--et-tint': '236 240 250',
    },
  },
  // ── Silver / Metal ────────────────────────────────────────────────────
  {
    id: 'silver-black',
    label: 'Silver & Black',
    group: 'Metal',
    vars: {
      '--et-root-bg': 'linear-gradient(180deg,#101114 0%,#0a0a0c 100%)',
      '--et-shade': '120 128 145',
      '--et-canvas': '#0a0a0c',
      '--et-panel': '#17181c',
      '--et-popup': '#0a0a0c',
      '--et-line': '196 204 218',
      '--et-line-hex': '#333a44',
      '--et-tint': '200 208 222',
    },
  },
  {
    id: 'brushed-steel',
    label: 'Brushed Steel',
    group: 'Metal',
    vars: {
      '--et-root-bg': 'linear-gradient(135deg,#2b2e34 0%,#16181c 45%,#2b2e34 100%)',
      '--et-shade': '70 76 88',
      '--et-canvas': 'rgba(14,15,18,0.72)',
      '--et-panel': 'rgba(30,33,39,0.9)',
      '--et-popup': 'rgba(16,17,20,0.94)',
      '--et-line': '205 212 224',
      '--et-line-hex': '#3a3f49',
      '--et-tint': '210 216 228',
    },
  },
  {
    id: 'titanium',
    label: 'Titanium',
    group: 'Metal',
    vars: {
      '--et-root-bg': '#111316',
      '--et-shade': '90 98 110',
      '--et-canvas': '#16181b',
      '--et-panel': '#202329',
      '--et-popup': '#15171a',
      '--et-line': '188 198 210',
      '--et-line-hex': '#313640',
      '--et-tint': '198 206 218',
    },
  },
  // ── Light / Off-white ─────────────────────────────────────────────────
  {
    id: 'porcelain',
    label: 'Porcelain',
    group: 'Light',
    light: true,
    vars: {
      '--et-root-bg': '#e8e6e1',
      '--et-shade': '176 172 164',
      '--et-canvas': '#eceae7',
      '--et-panel': '#e2e0da',
      '--et-popup': '#f2f1ed',
      '--et-line': '40 38 44',
      '--et-line-hex': '#c7c4bc',
      '--et-tint': '30 28 34',
      '--et-ink': '46 44 52',
    },
  },
  {
    id: 'ash',
    label: 'Ash Grey',
    group: 'Light',
    light: true,
    vars: {
      '--et-root-bg': '#d8dce0',
      '--et-shade': '150 158 168',
      '--et-canvas': '#dfe2e6',
      '--et-panel': '#d3d7dc',
      '--et-popup': '#e9ecef',
      '--et-line': '38 44 52',
      '--et-line-hex': '#bcc2c9',
      '--et-tint': '30 36 44',
      '--et-ink': '40 46 54',
    },
  },
  {
    id: 'paper',
    label: 'Paper',
    group: 'Light',
    light: true,
    vars: {
      '--et-root-bg': '#efe8db',
      '--et-shade': '196 184 162',
      '--et-canvas': '#f2ece1',
      '--et-panel': '#e9e2d4',
      '--et-popup': '#f6f1e8',
      '--et-line': '58 48 34',
      '--et-line-hex': '#d4cbb9',
      '--et-tint': '46 38 26',
      '--et-ink': '56 46 34',
    },
  },
  // ── Pastel ────────────────────────────────────────────────────────────
  {
    id: 'mint',
    label: 'Pastel Mint',
    group: 'Pastel',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#eaf4ee,#dcefe4)',
      '--et-shade': '150 194 172',
      '--et-canvas': '#e6f1ea',
      '--et-panel': '#d8ebe0',
      '--et-popup': '#eef6f1',
      '--et-line': '26 66 50',
      '--et-line-hex': '#c0ded0',
      '--et-tint': '24 60 46',
      '--et-ink': '28 62 48',
    },
  },
  {
    id: 'lavender',
    label: 'Pastel Lavender',
    group: 'Pastel',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#efedf9,#e4def2)',
      '--et-shade': '176 166 216',
      '--et-canvas': '#ece9f5',
      '--et-panel': '#e2ddf1',
      '--et-popup': '#f3f0fb',
      '--et-line': '48 38 84',
      '--et-line-hex': '#d3ccec',
      '--et-tint': '46 36 82',
      '--et-ink': '50 40 84',
    },
  },
  {
    id: 'peach',
    label: 'Pastel Peach',
    group: 'Pastel',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#f8efe8,#f1e2d6)',
      '--et-shade': '224 176 150',
      '--et-canvas': '#f6ece4',
      '--et-panel': '#f0e0d4',
      '--et-popup': '#faf2ec',
      '--et-line': '86 50 34',
      '--et-line-hex': '#e6d2c4',
      '--et-tint': '84 48 32',
      '--et-ink': '86 52 38',
    },
  },
  {
    id: 'sky',
    label: 'Pastel Sky',
    group: 'Pastel',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#eaf2f9,#dce9f4)',
      '--et-shade': '150 186 220',
      '--et-canvas': '#e5eef6',
      '--et-panel': '#d8e6f2',
      '--et-popup': '#eef4fa',
      '--et-line': '24 52 84',
      '--et-line-hex': '#c2d6ea',
      '--et-tint': '22 50 82',
      '--et-ink': '26 54 86',
    },
  },
  // ── Gradient ──────────────────────────────────────────────────────────
  {
    id: 'aurora',
    label: 'Aurora',
    group: 'Gradient',
    vars: {
      '--et-root-bg': 'linear-gradient(135deg,#0d1030 0%,#241a3e 45%,#0b1a2e 100%)',
      '--et-shade': '30 26 60',
      '--et-canvas': 'rgba(8,8,18,0.66)',
      '--et-panel': 'rgba(20,18,38,0.86)',
      '--et-popup': 'rgba(10,8,20,0.92)',
      '--et-line': '150 140 210',
      '--et-line-hex': '#2c2650',
      '--et-tint': '160 150 220',
    },
  },
  {
    id: 'sunset',
    label: 'Sunset',
    group: 'Gradient',
    vars: {
      '--et-root-bg': 'linear-gradient(135deg,#2a1020 0%,#3a1a22 45%,#160810 100%)',
      '--et-shade': '60 24 34',
      '--et-canvas': 'rgba(16,6,12,0.68)',
      '--et-panel': 'rgba(38,18,26,0.86)',
      '--et-popup': 'rgba(18,8,12,0.92)',
      '--et-line': '224 150 150',
      '--et-line-hex': '#4a2028',
      '--et-tint': '224 160 150',
    },
  },
  {
    id: 'deepsea',
    label: 'Deep Sea',
    group: 'Gradient',
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#04121a 0%,#062634 45%,#03101a 100%)',
      '--et-shade': '18 44 56',
      '--et-canvas': 'rgba(4,14,20,0.66)',
      '--et-panel': 'rgba(8,30,40,0.86)',
      '--et-popup': 'rgba(4,16,22,0.92)',
      '--et-line': '130 190 210',
      '--et-line-hex': '#123642',
      '--et-tint': '140 196 214',
    },
  },
];

/** Translucent-scrim vars used when a custom background image is active, so the
 *  image shows through the timeline while surfaces stay readable. */
const CUSTOM_IMAGE_VARS: Record<string, string> = {
  '--et-shade': '10 10 16',
  '--et-canvas': 'rgba(8,8,12,0.62)',
  '--et-panel': 'rgba(14,14,20,0.84)',
  '--et-popup': 'rgba(8,8,12,0.92)',
  '--et-line': '220 224 235',
  '--et-line-hex': '#2a2a34',
  '--et-tint': '224 228 238',
};

export const CUSTOM_IMAGE_ID = 'custom-image';

export const editThemeById = (id: string): EditTheme | undefined =>
  EDIT_THEMES.find((t) => t.id === id);

export interface ResolvedEditTheme {
  vars: Record<string, string>;
  light: boolean;
}

/**
 * Merge a theme id (and optional custom image data URL) into the full set of
 * `--et-*` variables to spread onto the editor root's inline style.
 */
export function resolveEditThemeVars(
  id: string,
  customImage: string | null,
): ResolvedEditTheme {
  if (id === CUSTOM_IMAGE_ID && customImage) {
    return {
      vars: {
        ...DEFAULT_ET_VARS,
        ...CUSTOM_IMAGE_VARS,
        // Scrim gradient over the image keeps foreground content legible.
        '--et-root-bg': `linear-gradient(rgba(6,6,10,0.45), rgba(6,6,10,0.45)), url("${customImage}") center / cover no-repeat`,
      },
      light: false,
    };
  }
  const theme = editThemeById(id) ?? EDIT_THEMES[0];
  return {
    vars: { ...DEFAULT_ET_VARS, ...theme.vars },
    light: !!theme.light,
  };
}
