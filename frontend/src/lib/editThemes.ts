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
 *   --et-elevated: raised surfaces (zinc-600/700, #202329); light themes give
 *                  it a light value so they never carry dark islands
 *   Ink tiers — every hardcoded text utility is re-pointed onto one of these by
 *   index.css, so the values are chosen per theme against THAT theme's
 *   canvas / panel / popup / elevated surfaces (WCAG 2.1 contrast):
 *   --et-ink     : primary text            ≥ 7:1   (text-white, zinc-50…300)
 *   --et-ink-2   : secondary labels        ≥ 4.5:1 (zinc-400)
 *   --et-ink-3   : muted / meta text floor ≥ 4.5:1 (zinc-500…700, white/40…60)
 *   --et-ink-inv : text ON solid accent fills (stays white on light themes)
 *   --et-border  : interactive-control border floor ≥ 3:1
 */

export interface EditTheme {
  id: string;
  label: string;
  group: string;
  light?: boolean;
  /** Overrides merged over DEFAULT_ET_VARS. */
  vars: Record<string, string>;
}

/** Midnight / default. The surface/border values also drive the app design
 *  tokens (--bg / --panel / --panel-border) so every hardware-card and
 *  token-built box re-themes, not just the EDIT layout. */
export const DEFAULT_ET_VARS: Record<string, string> = {
  '--et-root-bg': '#07050a',
  '--et-shade': '0 0 0',
  '--et-canvas': '#07050a', // deepest surface -> --bg
  '--et-panel': '#110e1a', // primary panel -> --panel
  '--et-elevated': '#202329', // raised surfaces (zinc-600/700, #202329)
  '--et-popup': '#0a080f', // overlays / near-black panels
  '--et-line': '255 255 255',
  '--et-line-hex': '#231e38', // solid borders -> --panel-border
  '--et-tint': '255 255 255',
  '--et-ink': '245 243 255',
  '--et-ink-2': '206 202 222',
  '--et-ink-3': '176 172 192',
  '--et-ink-inv': '255 255 255',
  '--et-border': '142 138 158',
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
      '--et-ink': '240 242 248',
      '--et-ink-2': '202 206 218',
      '--et-ink-3': '172 176 190',
      '--et-border': '138 142 156',
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
      '--et-ink': '236 240 250',
      '--et-ink-2': '202 208 220',
      '--et-ink-3': '180 186 200',
      '--et-border': '150 156 170',
    },
  },
  // ── Silver / Metal ────────────────────────────────────────────────────
  {
    id: 'silver-black',
    label: 'Silver & Black',
    group: 'Metal',
    vars: {
      '--et-root-bg': 'linear-gradient(180deg,#101114 0%,#0a0a0c 100%)',
      '--et-shade': '72 78 90',
      '--et-canvas': '#0a0a0c',
      '--et-panel': '#17181c',
      '--et-popup': '#0a0a0c',
      '--et-line': '196 204 218',
      '--et-line-hex': '#333a44',
      '--et-tint': '200 208 222',
      '--et-ink': '240 243 248',
      '--et-ink-2': '214 220 232',
      '--et-ink-3': '190 197 210',
      '--et-border': '156 164 180',
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
      '--et-ink': '240 243 248',
      '--et-ink-2': '208 214 226',
      '--et-ink-3': '182 189 202',
      '--et-border': '150 157 172',
    },
  },
  {
    id: 'titanium',
    label: 'Titanium',
    group: 'Metal',
    vars: {
      '--et-root-bg': '#111316',
      '--et-shade': '64 70 80',
      '--et-canvas': '#16181b',
      '--et-panel': '#202329',
      '--et-popup': '#15171a',
      '--et-line': '188 198 210',
      '--et-line-hex': '#313640',
      '--et-tint': '198 206 218',
      '--et-ink': '238 242 248',
      '--et-ink-2': '214 220 232',
      '--et-ink-3': '188 195 208',
      '--et-border': '156 163 178',
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
      '--et-elevated': '#d3d0c8',
      '--et-ink': '28 26 34',
      '--et-ink-2': '58 56 66',
      '--et-ink-3': '66 64 76',
      '--et-border': '104 101 94',
    },
  },
  {
    id: 'ash',
    label: 'Ash Grey',
    group: 'Light',
    light: true,
    vars: {
      '--et-root-bg': '#d8dce0',
      '--et-shade': '168 176 186',
      '--et-canvas': '#dfe2e6',
      '--et-panel': '#d3d7dc',
      '--et-popup': '#e9ecef',
      '--et-line': '38 44 52',
      '--et-line-hex': '#bcc2c9',
      '--et-tint': '30 36 44',
      '--et-elevated': '#c3c8ce',
      '--et-ink': '24 30 38',
      '--et-ink-2': '48 54 64',
      '--et-ink-3': '52 58 68',
      '--et-border': '92 100 110',
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
      '--et-elevated': '#dbd2c1',
      '--et-ink': '40 32 22',
      '--et-ink-2': '68 58 44',
      '--et-ink-3': '78 68 54',
      '--et-border': '116 106 90',
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
      '--et-shade': '168 204 186',
      '--et-canvas': '#e6f1ea',
      '--et-panel': '#d8ebe0',
      '--et-popup': '#eef6f1',
      '--et-line': '26 66 50',
      '--et-line-hex': '#c0ded0',
      '--et-tint': '24 60 46',
      '--et-elevated': '#c6ddd0',
      '--et-ink': '18 44 32',
      '--et-ink-2': '40 72 58',
      '--et-ink-3': '48 80 66',
      '--et-border': '78 114 98',
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
      '--et-elevated': '#d1cae6',
      '--et-ink': '34 26 62',
      '--et-ink-2': '64 54 96',
      '--et-ink-3': '72 62 104',
      '--et-border': '106 94 142',
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
      '--et-elevated': '#e3cfc0',
      '--et-ink': '64 34 22',
      '--et-ink-2': '96 62 46',
      '--et-ink-3': '102 70 54',
      '--et-border': '142 102 84',
    },
  },
  {
    id: 'sky',
    label: 'Pastel Sky',
    group: 'Pastel',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#eaf2f9,#dce9f4)',
      '--et-shade': '168 198 226',
      '--et-canvas': '#e5eef6',
      '--et-panel': '#d8e6f2',
      '--et-popup': '#eef4fa',
      '--et-line': '24 52 84',
      '--et-line-hex': '#c2d6ea',
      '--et-tint': '22 50 82',
      '--et-elevated': '#c4d6e6',
      '--et-ink': '16 36 62',
      '--et-ink-2': '40 64 94',
      '--et-ink-3': '40 64 94',
      '--et-border': '78 110 142',
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
      '--et-ink': '240 238 255',
      '--et-ink-2': '204 200 234',
      '--et-ink-3': '176 172 210',
      '--et-border': '146 140 192',
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
      '--et-ink': '255 240 243',
      '--et-ink-2': '236 204 210',
      '--et-ink-3': '210 176 182',
      '--et-border': '180 140 148',
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
      '--et-ink': '232 246 250',
      '--et-ink-2': '190 218 228',
      '--et-ink-3': '160 194 206',
      '--et-border': '120 164 180',
    },
  },
  // ── Duotone (dark ground, one accent hue in the lines/tints) ──────────
  // Common two-colour pairings. The accent lives in --et-line / --et-tint so
  // dividers and subtle fills carry it; ink stays neutral for legibility.
  {
    id: 'navy-gold',
    label: 'Navy & Gold',
    group: 'Duotone',
    vars: {
      '--et-root-bg': 'linear-gradient(170deg,#0b1220 0%,#0d1526 55%,#080e1a 100%)',
      '--et-shade': '10 18 36',
      '--et-canvas': '#0c1322',
      '--et-panel': '#131c30',
      '--et-popup': '#0a1020',
      '--et-line': '226 196 120',
      '--et-line-hex': '#2a3350',
      '--et-tint': '230 200 130',
      '--et-ink': '244 240 228',
      '--et-ink-2': '214 206 184',
      '--et-ink-3': '186 178 156',
      '--et-border': '160 148 112',
    },
  },
  {
    id: 'charcoal-amber',
    label: 'Charcoal & Amber',
    group: 'Duotone',
    vars: {
      '--et-root-bg': '#17161a',
      '--et-shade': '28 26 30',
      '--et-canvas': '#1a191d',
      '--et-panel': '#232227',
      '--et-popup': '#151418',
      '--et-line': '240 190 110',
      '--et-line-hex': '#3a3532',
      '--et-tint': '240 200 130',
      '--et-ink': '246 240 232',
      '--et-ink-2': '216 206 190',
      '--et-ink-3': '188 178 162',
      '--et-border': '160 146 122',
    },
  },
  {
    id: 'forest-cream',
    label: 'Forest & Cream',
    group: 'Duotone',
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#0f1a14 0%,#12201a 50%,#0b140f 100%)',
      '--et-shade': '14 30 22',
      '--et-canvas': '#111d16',
      '--et-panel': '#182620',
      '--et-popup': '#0c1610',
      '--et-line': '236 226 200',
      '--et-line-hex': '#253a2e',
      '--et-tint': '230 222 196',
      '--et-ink': '242 240 228',
      '--et-ink-2': '206 210 192',
      '--et-ink-3': '178 186 166',
      '--et-border': '140 152 130',
    },
  },
  {
    id: 'burgundy-rose',
    label: 'Burgundy & Rose',
    group: 'Duotone',
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#1c0c12 0%,#22101a 50%,#150810 100%)',
      '--et-shade': '38 14 22',
      '--et-canvas': '#200e15',
      '--et-panel': '#2a141c',
      '--et-popup': '#180a10',
      '--et-line': '240 180 196',
      '--et-line-hex': '#46202c',
      '--et-tint': '240 186 200',
      '--et-ink': '250 238 242',
      '--et-ink-2': '226 202 210',
      '--et-ink-3': '200 176 184',
      '--et-border': '170 136 148',
    },
  },
  {
    id: 'slate-copper',
    label: 'Slate & Copper',
    group: 'Duotone',
    vars: {
      '--et-root-bg': '#151a20',
      '--et-shade': '28 36 46',
      '--et-canvas': '#181e25',
      '--et-panel': '#202830',
      '--et-popup': '#131820',
      '--et-line': '222 160 120',
      '--et-line-hex': '#303a46',
      '--et-tint': '226 170 132',
      '--et-ink': '240 242 246',
      '--et-ink-2': '208 212 220',
      '--et-ink-3': '182 188 198',
      '--et-border': '154 158 170',
    },
  },
  {
    id: 'ink-cyan',
    label: 'Ink & Cyan',
    group: 'Duotone',
    vars: {
      '--et-root-bg': 'radial-gradient(circle at 50% 0%, #0b1424 0%, #06090f 60%)',
      '--et-shade': '6 12 20',
      '--et-canvas': '#080c14',
      '--et-panel': '#0e141e',
      '--et-popup': '#05080e',
      '--et-line': '120 220 240',
      '--et-line-hex': '#14283a',
      '--et-tint': '130 222 240',
      '--et-ink': '232 246 250',
      '--et-ink-2': '190 220 230',
      '--et-ink-3': '160 196 208',
      '--et-border': '110 168 186',
    },
  },
  {
    id: 'plum-mint',
    label: 'Plum & Mint',
    group: 'Duotone',
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#170f1c 0%,#1d1324 50%,#120a16 100%)',
      '--et-shade': '30 18 38',
      '--et-canvas': '#1a1220',
      '--et-panel': '#231a2c',
      '--et-popup': '#140c18',
      '--et-line': '160 236 200',
      '--et-line-hex': '#382a44',
      '--et-tint': '170 236 206',
      '--et-ink': '244 240 248',
      '--et-ink-2': '212 208 224',
      '--et-ink-3': '184 180 200',
      '--et-border': '150 142 172',
    },
  },
  // ── Light Duotone (light ground, one deep accent in the lines/tints) ──
  {
    id: 'cocoa-sand',
    label: 'Cocoa & Sand',
    group: 'Light Duotone',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#ecdfcc,#e4d5bf)',
      '--et-shade': '190 170 144',
      '--et-canvas': '#eee3d2',
      '--et-panel': '#e2d4bf',
      '--et-popup': '#f4ece0',
      '--et-line': '70 44 26',
      '--et-line-hex': '#cdbba2',
      '--et-tint': '64 40 24',
      '--et-elevated': '#d6c6ad',
      '--et-ink': '46 30 18',
      '--et-ink-2': '78 58 42',
      '--et-ink-3': '86 66 50',
      '--et-border': '120 98 76',
    },
  },
  {
    id: 'olive-bone',
    label: 'Olive & Bone',
    group: 'Light Duotone',
    light: true,
    vars: {
      '--et-root-bg': '#e6e5d8',
      '--et-shade': '176 178 150',
      '--et-canvas': '#ebeadf',
      '--et-panel': '#dfdfcf',
      '--et-popup': '#f2f1e8',
      '--et-line': '46 52 30',
      '--et-line-hex': '#c6c7b0',
      '--et-tint': '42 48 28',
      '--et-elevated': '#d0d0bc',
      '--et-ink': '34 38 22',
      '--et-ink-2': '62 68 46',
      '--et-ink-3': '70 76 54',
      '--et-border': '104 110 84',
    },
  },
  {
    id: 'cream-navy',
    label: 'Cream & Navy',
    group: 'Light Duotone',
    light: true,
    vars: {
      '--et-root-bg': '#efeadf',
      '--et-shade': '200 190 170',
      '--et-canvas': '#f2eee5',
      '--et-panel': '#e7e1d3',
      '--et-popup': '#f7f4ec',
      '--et-line': '22 34 66',
      '--et-line-hex': '#cfc7b6',
      '--et-tint': '20 32 64',
      '--et-elevated': '#d9d2c2',
      '--et-ink': '18 28 56',
      '--et-ink-2': '48 58 86',
      '--et-ink-3': '56 66 94',
      '--et-border': '92 102 130',
    },
  },
  {
    id: 'blush-charcoal',
    label: 'Blush & Charcoal',
    group: 'Light Duotone',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#f4e8ea,#eddfe2)',
      '--et-shade': '214 184 190',
      '--et-canvas': '#f6ecee',
      '--et-panel': '#ecdde0',
      '--et-popup': '#f9f1f2',
      '--et-line': '48 40 44',
      '--et-line-hex': '#dcc9cd',
      '--et-tint': '46 38 42',
      '--et-elevated': '#e0cdd1',
      '--et-ink': '40 32 36',
      '--et-ink-2': '72 62 66',
      '--et-ink-3': '80 70 74',
      '--et-border': '118 104 108',
    },
  },
  {
    id: 'sage-terracotta',
    label: 'Sage & Terracotta',
    group: 'Light Duotone',
    light: true,
    vars: {
      '--et-root-bg': 'linear-gradient(160deg,#e6ece4,#dde6db)',
      '--et-shade': '170 190 168',
      '--et-canvas': '#e9efe7',
      '--et-panel': '#dce6da',
      '--et-popup': '#f0f5ef',
      '--et-line': '112 58 40',
      '--et-line-hex': '#c2d0bf',
      '--et-tint': '104 54 38',
      '--et-elevated': '#ccd8c9',
      '--et-ink': '30 42 30',
      '--et-ink-2': '58 72 58',
      '--et-ink-3': '66 80 64',
      '--et-border': '96 116 94',
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
  '--et-ink': '240 242 248',
  '--et-ink-2': '204 208 220',
  '--et-ink-3': '176 180 194',
  '--et-border': '146 150 166',
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
  const theme = editThemeById(id) ?? editThemeById('obsidian') ?? EDIT_THEMES[0];
  return {
    vars: { ...DEFAULT_ET_VARS, ...theme.vars },
    light: !!theme.light,
  };
}
