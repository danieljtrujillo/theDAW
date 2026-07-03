# BrandTitle — portable "better CLAUDE CODE" brand lockup

A self-contained React brand/logo component: a tintable robot mark next to a
stacked wordmark — a small pixel-font word floating over a big uppercase title,
with a `by …` byline whose `0` runs an animated gradient. On hover the robot
head wiggles angrily with a red outline and the pixel word nudges up.

It's deliberately tiny and dependency-free (just React + one CSS file + two
static assets). Drop the whole `brand-title/` folder into any React app.

---

## What's in this folder

```
brand-title/
├── BrandTitle.tsx                 # the component
├── BrandTitle.css                 # all styles + animations + tunable CSS vars
├── README.md                      # this file
└── assets/
    ├── brand-icon.png             # robot head silhouette (used as a CSS mask)
    └── fonts/
        └── press-start-2p.woff2   # pixel font for the small word
```

The icon is **not** drawn as an image — it's used as a CSS `mask`, and the
visible color comes from `background-color`. That's why you can recolor the
robot to anything without editing the PNG. The PNG just needs to be a
silhouette on a transparent background.

---

## Install / use

1. Copy the whole `brand-title/` folder into your project (e.g.
   `src/components/brand-title/`).
2. Import and render:

```tsx
import BrandTitle from "./components/brand-title/BrandTitle";

export default function Header() {
  return <BrandTitle />;
}
```

That's it — `BrandTitle.tsx` imports its own CSS, and the CSS references the
assets relatively, so nothing else needs wiring.

**Requirements:** React 17+ and a bundler that resolves `url()` in CSS
(Vite, webpack, Parcel, Next.js, CRA — all do by default). TypeScript is
optional; rename to `.jsx` and strip the prop types if you're on plain JS.

---

## Props

| Prop        | Type                      | Default        | What it does |
|-------------|---------------------------|----------------|--------------|
| `pixelWord` | `string`                  | `"better"`     | Small pixel-font word floating above the title. |
| `mainWord`  | `string`                  | `"CLAUDE CODE"`| The big uppercase title. |
| `byline`    | `string`                  | `"StarskreamEXE"` | Text after `by`. The first `0` in it gets the animated gradient automatically. |
| `variant`   | `"default" \| "purple"`   | `"default"`    | `"purple"` tints the robot mark purple instead of the default white "ink". |
| `iconOnly`  | `boolean`                 | `false`        | Render just the robot mark (no text) — handy for collapsed sidebars/rails. |

```tsx
<BrandTitle mainWord="MY APP" pixelWord="super" byline="acme0corp" />
<BrandTitle variant="purple" iconOnly />
```

> The gradient only appears if the `byline` contains a `0`. A byline without a
> `0` renders fine — it just won't have the animated character.

---

## Theming (the easy way)

Everything you'd normally want to change is a CSS variable declared on `.brand`
at the top of `BrandTitle.css`. **Override them from your app instead of
editing the component**, so future updates to this folder don't clobber your
branding. Put these anywhere your app's CSS loads:

```css
.brand {
  --brand-icon-color: #22d3ee;   /* robot mark fill                       */
  --brand-accent: #22d3ee;       /* pixel-word drop shadow                */
  --brand-mad: #f97316;          /* hover "angry" outline color           */
  --brand-grad-a: #0ea5e9;       /* byline "0" gradient — edge color      */
  --brand-grad-b: #a5f3fc;       /* byline "0" gradient — middle color    */
  --brand-icon-size: 28px;       /* robot mark width & height             */
  --brand-title-size: 20px;      /* big title size                        */
  --brand-pixel-size: 11px;      /* pixel word size                       */
  --brand-wiggle-speed: 0.16s;   /* hover wiggle cadence (lower = faster) */
  --brand-gradient-speed: 2s;    /* byline "0" gradient sweep duration    */
}
```

A few extra notes:

- **Title text color** is *inherited* from wherever you place the component
  (it uses the surrounding text color). To pin it, add `color: #fff;` to your
  `.brand` override.
- **Byline font** uses `var(--mono, …)` with a monospace fallback. If your app
  defines a `--mono` font-family variable, the byline picks it up automatically.
- **Disable the hover animation** entirely: `.brand:hover .brandImg { animation: none; filter: none; }`.

---

## Swapping the assets

### Change the robot icon
Replace `assets/brand-icon.png` with your own silhouette PNG (transparent
background; the shape is what shows, color is applied via CSS). Keep the same
filename, or update both `mask` URLs in `.brandImg` if you rename it. Square
art works best because the mask is sized `contain`.

### Change the pixel font
Replace `assets/fonts/press-start-2p.woff2` and update the `@font-face` `src`
in `BrandTitle.css`. If you also change the `font-family` name, update the
`font-family` in `.brandPixel` to match.

---

## Asset paths

The CSS references assets **relative to the CSS file** (`./assets/...`). This
is the most portable form and works with every common bundler.

If your toolchain serves assets from a public root instead and can't resolve
relative `url()` in CSS, do this:

1. Copy `assets/brand-icon.png` → `public/brand-icon.png`
2. Copy `assets/fonts/press-start-2p.woff2` → `public/fonts/press-start-2p.woff2`
3. In `BrandTitle.css`, change the three asset URLs from `./assets/...` to
   root paths:
   - `url("./assets/fonts/press-start-2p.woff2")` → `url("/fonts/press-start-2p.woff2")`
   - both `url("./assets/brand-icon.png")` → `url("/brand-icon.png")`

---

## How the animations work

- **Hover wiggle** (`@keyframes mad-wiggle`): the mark rotates/skews back and
  forth on an `alternate` loop while four `drop-shadow` filters paint a
  1px outline in `--brand-mad`. Speed = `--brand-wiggle-speed`.
- **Pixel-word nudge**: on hover the pixel word shifts up-left 1px and its
  drop shadow grows, for a subtle "lift".
- **Byline gradient** (`@keyframes text-gradient`): a 200%-wide linear gradient
  is clipped to the `0` glyph and its `background-position` sweeps forever.
  Speed = `--brand-gradient-speed`.

All three are pure CSS — no JS, no runtime cost beyond compositing.

---

## Using it outside React

The markup is trivial; the styling does all the work. To use it in plain HTML,
keep `BrandTitle.css` + `assets/`, and hand-write the structure the component
produces:

```html
<div class="brand">
  <span class="brandImg" aria-hidden="true"></span>
  <div class="brandText">
    <span class="brandPixel">better</span>
    <h1 class="brandTitle">CLAUDE CODE</h1>
    <span class="brandBy">by skreamb<span class="brandZero">0</span>t</span>
  </div>
</div>
```

Add `class="brand--purple"` and/or `class="brand--iconOnly"` to the root
`.brand` element for those variants (drop the `.brandText` block for icon-only).
