# theDAW — UI/UX Design Principles

> Distilled from the MAKE-tab rebuild, written to be applied to **every** tab
> (EDIT, MIX, DJ, VJ, Library, future ones). When a new layout/control question
> comes up, answer it against this doc first. If a choice here ever conflicts
> with `CLAUDE.md`'s HARD RULES, the HARD RULES win.

The north star: **one screen, no scroll, no cutoff, nothing wasted, everything
live.** A tab should read like a piece of pro hardware — dense but legible, every
control where your hand expects it, every number telling you something.

**Wireframe:** [DESIGN_WIREFRAME.svg](DESIGN_WIREFRAME.svg) is the annotated
template these rules describe — open it alongside this doc.

---

## 0. The unified visual ruleset (holds on EVERY tab)

These are the invariants the user should feel the instant they switch tabs — the
"same app" signature. Break them only with explicit sign-off.

1. **Waveforms / inputs always live up top**, full width, before anything else.
2. **Left → right reading & signal flow:** inputs → transform/hero → output.
3. **Symmetry wherever possible** — equal-width rails, mirrored paired elements,
   a clean center axis through the hero/prompt.
4. **The same basic shape on every tab:** fixed top band · elastic working band
   (rails flanking a centered hero) · fixed bottom band · the global footer.
5. **The same panel / column / row vocabulary** — `hardware-card` sections,
   shared column widths, aligned rows, shared type/spacing tokens.
6. **The SLIDE control surface everywhere** — the same knobs, faders, and round
   toggles (value-colored, lag-free) on every tab that has parameters.

Everything below is the detailed "how" behind these six.

---

## 1. Spatial layout

**Fit the window. No page scroll, no bleed, no clipped controls.** This is the
non-negotiable that drove the whole MAKE rebuild.

- The tab root is a fixed flex column that owns the viewport:
  `h-full w-full overflow-hidden flex flex-col gap-1.5 p-1.5`.
- Compose a tab from **a few fixed-height bands + one `flex-1 min-h-0` band** that
  absorbs the slack. MAKE is three bands:
  1. **TOP** — `shrink-0`, fixed height: inputs/context (the INIT | INPAINT
     waveforms).
  2. **UPPER** — `flex-1 min-h-0`: the working area (rails + hero).
  3. **BOTTOM** — `shrink-0`, fixed height: the prompt flanked by visualizers.
- Inside a band, use CSS grid with explicit track sizes for the rails and
  `minmax(0,1fr)` for the elastic middle, e.g.
  `gridTemplateColumns: '190px minmax(0,1fr) 190px'`.
- **`min-h-0` / `min-w-0` on every flex/grid child that should be allowed to
  shrink** — without it, content forces overflow and you get the bleed we kept
  fighting. Internal lists scroll *within* their card (`overflow-y-auto` +
  `max-h`/`flex-1`), never the page.
- **Hero in the center, controls flank it.** The most important thing (chimera
  stack, timeline, deck, video) gets the elastic center; supporting controls live
  in the side rails and in columns immediately beside the hero.
- **Group controls with what they affect — don't span.** TEMP rides *over* the
  SAMPLER column; FX rides *over* the SCHEDULE column. A control block sits above
  or beside the thing it modifies, never stretched across unrelated regions.
- **Relative size language: M·S·L·S·M.** Center columns sized in relation to each
  other (advanced=M, knobs=S, hero list=L, knobs=S, advanced/output=M). Think in
  proportions, not pixels.
- **Mirror paired elements toward the center.** The two visualizer panels mirror
  (render flip + control icons on the inward side) so the layout reads symmetric
  around the prompt.

### Shell invariants (don't violate without asking)
- No standalone left panel; the **log lives inside the right panel's bottom**.
- The **bottom multi-tab panel is global**.
- The **3D graph keeps its fullscreen toggle.**
- The **footer is the master transport.** CREATE / play / stop / seek live in the
  footer. Do **not** add redundant Generate/Play buttons inside a tab — wire the
  tab's action into the footer instead.

---

## 2. The control surface (SLIDE language)

Controls should feel like a physical desk: lag-free, glanceable, and colored by
their own value.

- **Reuse the SLIDE surface**, don't reinvent it: the glass-capsule fader
  (`.ts-*`) and conic-arc knob (`.tk-*`) in
  [track-controls.css](../frontend/src/components/layout/track-controls.css), via
  the prop-driven components
  [SlideKnob](../frontend/src/components/audio/SlideKnob.tsx),
  [SlideFader](../frontend/src/components/audio/SlideFader.tsx), and the
  horizontal `SlideRow` in
  [AdvancedGenPanel](../frontend/src/views/AdvancedGenPanel.tsx).
- **Lag-free is mandatory.** Drive position/rotation inline from the live value
  with **no CSS transition during drag** (`transition: dragging ? 'none' : …`).
  Easing on a control you're dragging reads as latency — we removed it everywhere.
- **Color is data.** Map `t = (value-min)/span` and color the fill / arc / pointer
  / readout from the SAME ramp via `colorAt(t)` + `accentVars(t)` from
  [lib/trackColor](../frontend/src/lib/trackColor.ts). A control's hue tells you
  its level before you read the number.
- **Readouts bulge / center on focus.** Numbers magnify + glow on hover/drag
  (the fader ruler "bulge"); a prominent knob can render its value **centered in
  the dial, tinted by value** (`centerReadout` on SlideKnob, used by NORM THR).
- **Toggles match the knobs** — circular LED-style buttons (icon + glow when on),
  not stray checkboxes/pills, so the row reads as one instrument.
- **Align everything to a column.** Fixed-width slots for label / track / value so
  every row's numbers line up. Value fields are **narrow and flush to the panel
  edge** to maximize slider travel.
- **Every control is tip'd** — `HoverTip` / `InfoTip` with `HOVER_TOOLTIPS` /
  `RICH_TOOLTIPS`. If a label is cryptic (e.g. "NORM THR"), give it a real
  tooltip (and consider a clearer label).

---

## 3. Visual language

- **Tailwind v4 canonical forms only** (see `CLAUDE.md` table + the
  `feedback_tailwind_v4_classes` memory): `className!` not `!className`,
  `shrink-0`, `grow`, `bg-linear-to-*`, opacity modifiers (`bg-black/50`,
  `bg-white/3`), **scale tokens not arbitrary px** (`w-75`, `h-3.5`, `left-4`,
  `z-15`). Mentally check every class string against the table before writing it.
- **Type scale is tiny and deliberate:** `text-[8px]`/`[9px]`/`[10px]`/`[11px]`.
  Section titles are `text-[10px] font-black uppercase tracking-widest
  text-purple-300` (the `sectionTitle` const); sub-labels `subTitle`. Reuse the
  shared constants, don't hand-roll each header.
- **Purple is the brand accent**; zinc for neutrals; cyan as the secondary neon.
  Active = purple border + fill + glow (`shadow-[0_0_8px_rgba(168,85,247,…)]`),
  inactive = `border-white/10 bg-black/40 text-zinc-400`.
- **Cards, not bare divs:** `hardware-card` for sections; `compact-input` for all
  inputs/selects; `btn-ghost` for icon buttons; `mono-tag` for ON/OFF chips.
- **Tight, consistent rhythm:** `gap-1.5`, `p-1.5`/`p-2`, rounded-lg. Subtle
  separators (`border-white/5`/`/8`).

---

## 4. Unify the panels

The two side rails (and equivalents on other tabs) must look like siblings.

- **Both rails are a vertical stack of `hardware-card` sections** with horizontal
  `sectionTitle` headers — no outer wrapper card, **no rotated/vertical rail
  labels**, equal widths.
- **Reuse one dropdown pattern.** The PRESETS button (icon + label + chevron that
  expands a panel downward) is the template; LoRA reuses it verbatim. New
  collapsible pickers should mirror it, not invent a new look.
- A section that can be empty still says so (`No LoRAs added`, `No templates`).

---

## 5. Interaction & affordances

- **Icons-only where space is tight, with a consistent chip style.** Visualizer
  mode switches + the fullscreen button are 6×6 rounded bordered icon buttons,
  stacked in a corner, active one glowing. Same `iconBtn(active)` style across the
  set.
- **Auto-advance to the relevant view.** MAKE auto-flips to the Compare tab when a
  render finishes. Surface results without making the user hunt.
- **Don't auto-open heavy/secondary panels** on selection (we removed the
  auto-open of Details on track click). Respect the user's current focus.
- **State is honest.** Disabled when not actionable (Quick Actions until there's
  output); counts in labels (`LoRA (2)`); spinners on async work.

---

## 6. Visualizers / canvases

- **Size to the container, never the window.** Measure with a `ResizeObserver` on
  the host element; full-bleed canvas (`renderer.setSize(w, h, false)` so CSS owns
  display size). See
  [CymaticsVisualizer](../frontend/src/components/audio/CymaticsVisualizer.tsx).
- **Let the renderer own a fresh canvas per mount** and tear everything down on
  unmount (cancel RAF, dispose geometries/materials/render targets, `dispose()` +
  `forceContextLoss()`, remove the canvas). Reusing a canvas across React
  StrictMode remounts hands you a dead WebGL context.
- **No headings on a visual** unless asked — controls are corner icon stacks.
- **Mirror paired visuals** (panel-level `scaleX(-1)`), keep the control overlay
  un-mirrored.
- **React to real audio.** Tap the shared engine, don't build a side graph
  (see §7).

---

## 7. Data flow & wiring

- **One audio engine.** Everything audible routes through the player master gain
  + analyser in [playerStore](../frontend/src/state/playerStore.ts)
  (`getMasterGain()` / `getAnalyser()`), so visualizers/HUD always reflect what's
  playing. Don't spin up parallel `AudioContext`s.
- **Controls are functional, not decorative — wire end-to-end.** When you add a
  control, thread it the whole way: store field → `buildGenerateJobFormData` →
  backend `Form(...)` → behavior. The output **NAME** field is the reference
  example (`outputName` → `custom_name` → `_make_generation_filename`).
- **Zustand stores are the source of truth** (`generateParamsStore`, etc.);
  components read/`setField`. Defaults live in the store (e.g. default length 110).
- **Persisted vs session:** know which store persists before relying on a default
  change taking effect.

---

## 8. Performance (optimize because it's smart — not for any one machine)

Don't design around a specific GPU/VRAM budget, and never use hardware as an
excuse to cut a feature or quality. Just keep things as efficient as is sensible —
it's good engineering and it pays off on every machine.

- Cap `renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5))`; pause RAF when
  `document.hidden`; skip work on a lost context.
- Gate expensive effects; only the active mesh/mode renders.
- Smooth audio-driven motion with an **envelope** (slow lerp) instead of raw
  per-frame values — calmer *and* cheaper, and it kills jitter.
- Dispose GPU resources on unmount; two side-by-side canvases means two contexts —
  free them.
- Take the free wins (cache DOM/ref lookups, write only on change, reuse buffers),
  but don't sacrifice the look or a feature chasing micro-optimizations.
- If you must cap coverage (mesh density, list length), say so; don't silently
  truncate.

---

## 9. Motion & "feel"

From tuning the visualizers, but it generalizes to any animated UI:

- **Ebb, don't flicker.** Animated elements should have a **persistent base** and
  change **slowly** (slow lerp / low-freq drift), never pop in and out in a
  fraction of a second.
- **Coherent over random.** Patterns should look arranged (phyllotaxis /
  quasicrystal / aligned grid), not scattered noise.
- **Reactivity is layered:** a gentle idle baseline + an audio-driven boost on
  top, crossfaded so silence still breathes.

---

## 10. Process guardrails (cross-cutting, from CLAUDE.md + memory)

- **Never downgrade** external models/APIs/libs; fetch live docs, ask before
  removing catalog entries.
- **Ruff: one pinned version**; run `uv run ruff check .` **and**
  `uv run ruff format --check .` at the **repo root** before any Python commit.
- **`tsc --noEmit` clean** (and a `vite build`) before calling frontend work done.
- **No hidden warnings** — fix the root cause of any IDE/Pylance/ruff warning the
  user could see; don't defer as "cosmetic."
- **No `Co-Authored-By`/AI trailers** in commits. Push SA3 to `new_origin`
  (`origin` is read-only upstream).
- **Plan before patching**; don't drop/defer scope without approval.
- **MAKE and MIX stay distinct** (CREATE→MAKE, PROCESS→MIX); never merge them.

---

## 11. Per-tab application checklist

When laying out or revising any tab, confirm:

1. Root is `h-full overflow-hidden flex flex-col`; fixed bands + one `flex-1
   min-h-0`; **no page scroll, no clipped control** at 1920×1080.
2. Hero centered; supporting controls flank it; control blocks sit with what they
   affect.
3. Rails are unified `hardware-card` stacks (no vertical labels); paired elements
   mirror toward center.
4. Sliders/knobs use the SLIDE surface: lag-free, value-colored, aligned columns,
   tooltips.
5. Tailwind v4 canonical classes; shared type/color/component tokens.
6. The tab's primary action runs through the **footer**, not a local button.
7. Any control is wired end-to-end to real behavior.
8. Canvases are container-sized, disposed on unmount, audio-reactive off the
   shared engine.
9. Animations ebb (persistent base, slow), never flicker.
10. `tsc`/`ruff` clean; no new warnings; commit to `new_origin` with no AI trailer.
