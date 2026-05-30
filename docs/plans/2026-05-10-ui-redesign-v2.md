# theDAW AI — UI Redesign v2 Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the UI from the current broken 4-tab layout into a dense, polished, single-page-focused audio generation workstation that eliminates empty space and organizes controls by workflow logic, not technical category.

**Architecture:** Single primary workspace page with ALL generation controls visible. Separate pages only for things that are genuinely different workflows (library/history). Dense bento grid, compact controls, no dead space.

**Tech Stack:** React 19, Vite, Tailwind 4, Zustand, Lucide icons, Canvas (waveforms)

---

## Part 1: Information Architecture Redesign

### What's Wrong Now

| Problem | Why it's wrong |
|---------|---------------|
| 4 equal tabs | Generation is 90% of usage, shouldn't share equal weight with Library/Automation |
| Presets in their own tab | Generation presets belong IN the generation workflow, not a separate page |
| Init Audio / Inpainting in separate tab | These are generation MODES, not separate workflows — they use the same generate button |
| Automation in its own tab | Curve editing and advanced params belong in the generation view as collapsible sections |
| Massive empty space | Cards have too much padding, controls are spaced too far apart, output section takes too much room when empty |
| Output takes a full column | Before generation it's just dead space saying "Output will appear here" |

### New Structure

**Two pages, not four:**

**Page 1: STUDIO (default, 95% of time spent here)**
Everything needed to generate audio. One dense page. ALL params visible.

**Page 2: LIBRARY**
Saved outputs, generation history, preset management. You go here to find/load past work, not to generate.

### Studio Page Layout

The mockups show the right pattern — one dense page with these zones:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR: theDAW AI    [Studio] [Library]                    ? ⚙ ●     │
├─────────────────────────────────┬───────────────────────────────────────────┤
│ PROMPTING                       │ MAIN CONTROLS                             │
│ Prompt [━━━━━━━━━━━━━━━━━━━━━]  │ Seconds ━━━━  Steps [8]  CFG scale ━━━━  │
│ Negative [━━━━━━━━━━━━━━━━━━━]  │                                           │
├─────────────────┬───────────────┼─────────────────┬─────────────────────────┤
│ SAMPLER         │ GUIDANCE      │ SCHEDULE SHIFT  │ OUTPUT PREVIEW          │
│ Seed [____]     │ APG ━━━━━━━━  │ Type [▼LogSNR]  │ ▓▓▓▓▓▓▓ waveform ▓▓▓▓  │
│ Sampler [▼ping] │ CFG int ━━ ━━ │ P1━━ P2━━       │ ▶ 0:00 / 0:30   ↻     │
│ Sigma ━━━━━━━━  │ Rescale ━━━━  │ P3━━ P4━━       │ ▓▓░░▓▓▓ spectrogram    │
│ Padding ━━━━━━  │ Norm ━━━━━━━  │                 │                         │
│                 │               │ Tips: leave at   │ [↓ Download] [→ Init]  │
│                 │               │ default unless...│ [→ Inpaint]            │
├─────────────────┴───────────────┼─────────────────┴─────────────────────────┤
│ INIT AUDIO (collapsible)        │ INPAINTING (collapsible)                  │
│ [Upload ▲] Noise ━━━━ Type [○○] │ [Upload ▲] Start ━━━━━ End ━━━━━         │
│ Inv steps━━ Gamma━━ ○Uncond     │                                           │
├─────────────────────────────────┴───────────────────────────────────────────┤
│ BOTTOM BAR: [Randomize seed] [Preset: ▼ None] [Save settings]  [▶ GENERATE]│
└─────────────────────────────────────────────────────────────────────────────┘
```

**Key differences from current:**
1. Prompt + Main controls share the top row (prompt doesn't need full width)
2. Sampler, Guidance, Schedule Shift are side-by-side cards (not nested in accordions)
3. Output preview is ONE card in the grid, not a full column — compact until audio exists
4. Init Audio and Inpainting are collapsible bottom rows (visible but not eating space when unused)
5. Generate button is a sticky bottom bar with seed controls and preset selector
6. LoRA controls appear inline when LoRAs are loaded (inserted as a card in the grid)
7. Automation curves are an expandable section within the studio, not a separate tab
8. Tips/suggestions are small muted text under section headers, not separate guide paragraphs

### Library Page Layout

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ TOP BAR: theDAW AI    [Studio] [Library]                    ? ⚙ ●     │
├───────────┬────────────────────────────────┬────────────────────────────────┤
│ SIDEBAR   │ ITEMS                          │ DETAIL                         │
│ Search    │ Sort [▼Recent]                 │ Name + ★                       │
│ ─────     │                                │ Prompt text                    │
│ All       │ [mini-waveform] Ethereal 60s   │ Settings summary               │
│ Presets   │ [mini-waveform] Deep Sp  90s   │ Tags                           │
│ History   │ [mini-waveform] Night F  45s   │ [▶ Preview] [Load → Studio]   │
│ Favorites │                                │ [Duplicate] [Delete]           │
│ ─────     │                                │                                │
│ [Import]  │                                │                                │
└───────────┴────────────────────────────────┴────────────────────────────────┘
```

---

## Part 2: Visual Density Fixes

### Spacing Reduction

Current → Target:
```
Panel padding:     16-20px → 10-12px
Control gap:       10-14px → 6-8px
Section gap:       16-20px → 10-12px
Panel border-radius: 12px → 8px
Card margin:       12-16px → 8px
Slider height:     default → 24px total (label + track)
Font sizes:        13-15px → 11-13px for labels, 12px for values
```

### Control Compactness

Each slider should be ONE line: `Label ━━━━━━━━━━━━━━━ Value`
- Label left-aligned, value right-aligned, slider track in between
- Total height per control: 28-32px including label
- No separate label row — everything inline

Dropdowns: compact, 28px height, dark bg, no excess padding

Textareas: 3 rows for prompt, 2 rows for negative. Not giant boxes.

### Color Refinement

The design system says OLED dark. Current tokens are close but need refinement:

```css
--bg-app: #030508;        /* deeper black, not gray */
--bg-panel: #0a0e14;      /* darker panels */
--bg-panel-hover: #0f1520; /* subtle hover */
--border-soft: rgba(255,255,255,0.06); /* subtler borders */
--accent: #8b5cf6;        /* keep purple */
--accent-glow: rgba(139,92,246,0.15); /* subtle glow for active states */
--text-primary: #e8e4f0;  /* slightly warmer white */
--text-label: #9b95a8;    /* muted labels */
--text-value: #d4cfe0;    /* brighter values */
```

### Typography

The design system suggests Poppins/Open Sans but the frontend-design skill says avoid generic fonts. For an audio tool:

```css
font-family: 'JetBrains Mono', 'Fira Code', monospace; /* for values/numbers */
font-family: 'DM Sans', 'Inter', sans-serif; /* for labels/headers — Inter is okay here, it's a tool not a marketing page */
```

Values and numbers in monospace so they don't shift when changing. Labels in clean sans-serif.

---

## Part 3: Implementation Tasks

### Task 1: Restructure to 2-page layout (Studio + Library)

**Files:**
- Rewrite: `src/App.tsx` — 2 routes: `/` (Studio), `/library`
- Rewrite: `src/components/shell/TopBar.tsx` — 2 tabs not 4
- Rewrite: `src/components/shell/Sidebar.tsx` — remove tab nav, keep utility links
- Delete: `src/views/AutomationAdvancedView.tsx` (merge into Studio)
- Rename: `src/views/PresetsLibraryView.tsx` → rewrite as Library page
- Rewrite: `src/views/GenerateView.tsx` → becomes StudioView with everything

### Task 2: Rebuild StudioView with dense bento grid

**Files:**
- Rewrite: `src/views/GenerateView.tsx` → `src/views/StudioView.tsx`
- Layout: CSS Grid with named areas matching the ASCII diagram above
- ALL controls visible — no accordions for main params
- Init Audio and Inpainting as collapsible rows (not hidden, just compact)
- Sticky bottom bar with Generate button

### Task 3: Fix spacing/density in design tokens

**Files:**
- Rewrite: `src/styles/tokens.css` — tighter spacing, smaller padding, compact type scale
- Update: `src/index.css` — global density rules

### Task 4: Rebuild SliderWithValue as single-line compact control

**Files:**
- Rewrite: `src/components/controls/SliderWithValue.tsx`
- Single line: Label left, track center, value right
- Total height: 28px
- Monospace value display
- Editable value on click

### Task 5: Rebuild PanelCard as compact card

**Files:**
- Rewrite: `src/components/layout/PanelCard.tsx`
- Tighter padding (10px), smaller title (11px uppercase), subtle border
- Optional collapse toggle for Init Audio / Inpainting sections

### Task 6: Create StickyBottomBar component

**Files:**
- Create: `src/components/layout/StickyBottomBar.tsx`
- Contains: Randomize seed button, Preset dropdown, Save settings button, Generate button
- Fixed to bottom, full width, dark bg with top border
- Generate button: large, purple, right-aligned

### Task 7: Merge automation controls into Studio

**Files:**
- Move curve editor into Studio as an expandable "Advanced" section
- Move performance/VRAM display into the bottom bar or a small status area
- Move output format settings into the Output Preview card
- Delete AutomationAdvancedView

### Task 8: Rebuild Library page (presets + history unified)

**Files:**
- Rewrite: `src/views/LibraryView.tsx`
- 3-column: sidebar categories | item list | detail panel
- Unify presets and generation history into one browsable list
- Filter by: All, Presets, History, Favorites
- Load action sends settings back to Studio

### Task 9: Add polish — hover states, transitions, focus rings

**Files:**
- Update all interactive components per interaction-design skill
- 150ms transitions on hover
- Purple focus rings
- Subtle scale on Generate button press
- Skeleton loading state for output area during generation
- Progress bar in bottom bar during generation

### Task 10: Visual verification

- Screenshot all states with Playwright
- Compare against mockup inspiration images
- Fix any remaining density/spacing issues

---

## Part 4: Visual Reference Notes (from mockup analysis)

What the mockups consistently show:
1. **Prompt area shares row with main controls** — prompt left (60%), controls right (40%)
2. **Controls are TINY** — compact sliders, small labels, minimal padding
3. **Sections have thin borders** — 1px rgba borders, not thick card shadows
4. **Tips text is inline and muted** — small gray text under section headers or below controls
5. **Output preview is compact** — waveform + transport + spectrogram in one small card
6. **Generate button is bottom-pinned** — always visible, doesn't scroll
7. **Numbers are monospace** — values don't shift when changing
8. **Init Audio is bottom row** — upload zone + controls, collapsible, not a major section
9. **Color scheme** — true black backgrounds, purple accents only on active/interactive elements, NOT purple everywhere
10. **No wasted vertical space** — every pixel has purpose

---

## Execution Order

1. Task 3 (tokens/density) — foundation
2. Task 5 (PanelCard) + Task 4 (SliderWithValue) — building blocks
3. Task 6 (StickyBottomBar) — new component
4. Task 1 (restructure routes) — architecture
5. Task 2 (StudioView) — main page rebuild
6. Task 7 (merge automation) — cleanup
7. Task 8 (Library) — second page
8. Task 9 (polish) — interactions
9. Task 10 (verification) — QA

