# Themes

theDAW recolours the whole app, not just one tab. Open the app menu (the ☰
button at the top right) and choose **Change Theme**. Picking a swatch applies
it immediately, so the modal doubles as a live preview; Escape closes it. Your
choice persists across launches.

There are 28 themes in seven groups, plus a custom background image.

| Group | Themes |
|---|---|
| Dark | Midnight, Obsidian, Graphite |
| Metal | Silver & Black, Brushed Steel, Titanium |
| Duotone | Navy & Gold, Charcoal & Amber, Forest & Cream, Burgundy & Rose, Slate & Copper, Ink & Cyan, Plum & Mint |
| Light | Porcelain, Ash Grey, Paper |
| Light Duotone | Cocoa & Sand, Olive & Bone, Cream & Navy, Blush & Charcoal, Sage & Terracotta |
| Pastel | Pastel Mint, Pastel Lavender, Pastel Peach, Pastel Sky |
| Gradient | Aurora, Sunset, Deep Sea |

**Obsidian** is the default. **Midnight** reproduces the app's original
hardcoded palette exactly, so it is the "no theme" option.

## A custom background image

**Choose an image…** in the modal picks a picture from disk and uses it as the
app's backdrop. It is stored as a data URL so it survives a reload without
depending on a file path that might move. A scrim gradient is laid over it and
every surface switches to translucent values, so the image shows through the
timeline while the panels stay readable. Clearing the image returns you to
Obsidian.

## What a theme changes, and what it does not

A theme changes **neutral chrome only**: backgrounds, borders, subtle fills, and
the text tiers that have to stay legible on them. It does not touch semantic
colour. Purple still means selection, red still means danger, amber still means
warning, and a stem's colour is still that stem's colour — a theme that repainted
those would be changing what the app is telling you.

Modals portaled to `<body>` sit outside the themed subtree and keep the default
dark chrome.

## The accent

One thing a theme *does* get to recolour is the accent: the hue the footer's
latched transport keys, PLAY's playing edge, the scrub fill, the model chip, the
master-FX pill and the CREATE / PROCESS button all draw in.

It is derived rather than hand-picked (`withAccent` in
`frontend/src/lib/editThemes.ts`):

- A **hued** theme uses its own tint — Navy & Gold's gold, Sage & Terracotta's
  clay — so the chrome stops fighting the theme it sits in.
- A **neutral** theme (one whose tint channels spread by less than 30) keeps the
  app's purple: `168 85 247` on dark grounds, a darker `126 34 206` on light
  ones so it still carries contrast.
- A theme that sets `--et-accent` itself is left alone.

`--et-accent-ink` — the text that sits *on* a solid fill of the accent — is
computed from the accent's relative luminance, so a pale gold accent gets black
text and a deep navy one gets white.

## For developers

### How it is wired

The Shell root and the player footer carry the class `edit-theme-scope` plus the
resolved `--et-*` variables as inline style. A block of **unlayered** CSS in
`frontend/src/index.css` remaps the neutral chrome onto those variables — every
`bg-black/α` surface, every `bg-white/α` fill, every `border-white/α` or hex
border, and every hardcoded text utility onto an ink tier.

Unlayered rules beat Tailwind's utilities layer, which is the whole trick: no
per-element class edits were needed to make the app themeable, and because
Midnight's values reproduce the original palette exactly, an un-themed app is
pixel-identical to what it was before themes existed.

The scope also drives the app design tokens (`--bg`, `--panel`,
`--panel-border`), so token-built boxes and hardware cards re-theme along with
the hardcoded-utility surfaces rather than staying dark islands.

### The variables

| Variable | Role |
|---|---|
| `--et-root-bg` | The app backdrop: a solid colour, a gradient, or an image |
| `--et-shade` | The rgb triple every `bg-black/α` surface resolves to |
| `--et-canvas` | The deepest surface — the scrolling timeline background |
| `--et-panel` | The primary panel surface (the track-header column) |
| `--et-popup` | Floating panels and overlays |
| `--et-elevated` | Raised surfaces. Light themes give this a light value so they never carry dark islands |
| `--et-line` | The rgb triple for `border-white/α` dividers |
| `--et-line-hex` | The solid hex border |
| `--et-tint` | The rgb triple for `bg-white/α` subtle fills |
| `--et-ink` | Primary text — at least 7:1 against this theme's surfaces |
| `--et-ink-2` | Secondary labels — at least 4.5:1 |
| `--et-ink-3` | Muted and meta text floor — at least 4.5:1 |
| `--et-ink-inv` | Text on solid accent fills (stays white on light themes) |
| `--et-border` | The interactive-control border floor — at least 3:1 |
| `--et-accent` / `--et-accent-ink` | Derived; see [The accent](#the-accent) |

The ink tiers are chosen **per theme** against that theme's own canvas, panel,
popup and elevated surfaces, to WCAG 2.1 contrast. That is why they are listed
explicitly on every theme rather than computed: a ratio that holds on Obsidian
does not hold on Paper.

### Adding a theme

Add an entry to `EDIT_THEMES` in `frontend/src/lib/editThemes.ts` with an `id`,
a `label`, a `group` from the list above, `light: true` if it is a light theme,
and a `vars` object holding only the overrides — everything unset falls back to
`DEFAULT_ET_VARS`. Pick the four ink values against *your* surfaces and check
the contrast; do not copy another theme's. Leave `--et-accent` out unless the
derived one is wrong for the theme.
