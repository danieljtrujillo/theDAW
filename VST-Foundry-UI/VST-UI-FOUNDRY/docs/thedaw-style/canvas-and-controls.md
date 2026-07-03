# Canvas and Controls — The Designer Surface

Reference for the heart of VST Foundry: the infinite design canvas, the control
elements you drag onto it, and the panels that edit them. This is where a plugin
face is actually laid out — knobs, sliders, meters, artwork, and their wiring.
Plain descriptions of what each piece does and where it lives in the source, for
anyone editing Foundry's front end or trying to understand how a placed control
turns into a live, routable widget.

For the app around this surface (tabs, AI orb, export flow) see
[foundry-overview.md](foundry-overview.md). For the image/skin layers referenced
here in depth, see [textures-and-skins.md](textures-and-skins.md). For CustomCode
elements, [custom-code.md](custom-code.md). For how a laid-out canvas becomes a
plugin, [gan-format.md](gan-format.md) and [vst3-export.md](vst3-export.md).

## The element model

Everything on the canvas is a `UIElement` (`src/types.ts`). The set of element
types is declared once as `ELEMENT_TYPES` — the TypeScript union `ElementType`
is *derived* from that array, so adding a type there updates every consumer that
iterates it (the assistant's capability map, the export param builders, etc.).

There are 17 element types:

| Type | Rendered by | Role |
|---|---|---|
| `Button` | `controls/ButtonControl` | Momentary / trigger push button |
| `Knob` | `controls/KnobControl` | Rotary continuous control |
| `Slider` | `controls/SliderControl` | Linear fader |
| `Label` | `controls/LabelControl` | Static or live text / LCD readout |
| `Select` | `controls/SelectControl` | Dropdown option picker |
| `Toggle` | `controls/ToggleControl` | Two-state switch |
| `Image` | `Canvas` → `ProcessedImage` | Placed artwork / cutout |
| `Group` | `Canvas` (recursive) | Container frame for child elements |
| `Waveform` | `controls/WaveformControl` | Oscilloscope / LFO shape display |
| `Meter` | `controls/MeterControl` | Level meter (listens to a signal) |
| `XYPad` | `controls/XYPadControl` | 2-axis pad |
| `Spatial3D` | `controls/Spatial3DControl` | Radar / spatial pad |
| `WaveShaper` | `controls/WaveShaperControl` | Distortion transfer-curve control |
| `Envelope` | `controls/EnvelopeControl` | ADSR editor (self-editing) |
| `StepSequencer` | `controls/StepSequencerControl` | Grid step sequencer (self-editing) |
| `Keyboard` | `controls/KeyboardControl` | Piano-key input strip |
| `CustomCode` | `CustomCodeFrame` | Sandboxed iframe running user JS |

Every element carries geometry (`x`, `y`, `width`, `height`, `rotation`), colours
(`baseColor`, `activeColor`, `textColor`, `borderColor`, `indicatorColor`), a
glow block, an optional `effect` animation, an optional `variant` (its look
template), per-control `styleParams`, an optional `skin`, an optional image
`faceSrc`, texture fields, and a `binding` (its routing). The whole object is
serialized as-is, so any field rides autosave, project save, and ZIP export for
free. Soft state like selection lives outside the element in App state.

> Note: The Foundry front end is under active development. Some control render
> components and their variant lists are being extended; this document describes
> what ships in `src/` today. Where a legacy doc in `docs/*.md` disagrees with the
> code, the code wins.

## The canvas surface

`src/components/Canvas.tsx` is the composition entry for the design surface. It is
an infinite, pannable, zoomable plane. The heavy lifting is split into
`src/components/canvas/`:

| File | What it does |
|---|---|
| `useCanvasGestures.ts` | Pointer-gesture engine: drag, marquee, pan, resize + the drop-target handlers |
| `resizeMath.ts` | Pure eight-handle resize geometry (rotation-aware) |
| `snapMath.ts` | Pure grid + alignment drag-snapping math, unit-tested |
| `viewportMath.ts` | Pure cursor-anchored wheel-zoom math |
| `rulers.ts` | Ruler drawing + tick math |
| `gridOverlay.tsx` | Fixed grid-line background overlay |
| `ProcessedImage.tsx` | Image-element renderer (background removal, glow, texture) |
| `AnnotationLayer.tsx` | Freehand / shape / text annotation drawing layer |
| `AnnotationToolbar.tsx` | Annotate-mode sub-tool + colour palette |

Canvas state lives on `CanvasState` (`src/types.ts`): `width`/`height`,
`scale`/`panX`/`panY`, `backgroundImage`, `showGrid`, `snapToGrid`, `gridSize`,
`showRulers`, `requireCtrlToZoom`, `isPreviewMode`, plus the annotation arrays.

The pannable area is a single transformed div; every element renders inside it at
absolute `left/top` with `transform: rotate(...)`. The on-screen zoom readout, the
tool switcher, and the "Require Ctrl to Zoom" / "Show Rulers" checkboxes live in a
floating bottom-centre toolbar drawn by Canvas itself.

### Canvas tools

The bottom toolbar switches `activeTool` (`CanvasTool` = `select | pan |
annotate`):

| Tool | Shortcut hint | Behaviour |
|---|---|---|
| Select | `V` | Click to select, drag to move, marquee on empty canvas, shift-click to multi-select |
| Pan | `H` / Spacebar | Drag the whole canvas; also triggered by middle-mouse or shift+left anywhere |
| Annotate | — | Hands left-button gestures to the `AnnotationLayer` (drawings the AI orb can see) |

Zoom is cursor-anchored (`viewportMath.wheelZoomAtPoint`) and requires Ctrl/Cmd by
default (`requireCtrlToZoom`); without the modifier the wheel pans instead. The
`+`/`-`/`Reset` buttons clamp scale to `0.1–3`.

### Preview (Demo) mode vs edit mode

`canvasState.isPreviewMode` flips the whole surface between editing the layout and
interacting with the live controls. In edit mode elements are selectable, show a
selection ring, hover outline, name badge, resize/rotate chrome, and are
pointer-inert internally. In preview mode selection chrome disappears, controls
become interactive (`pointer-events: auto`), and `InteractiveControl` attaches its
drag listeners so knobs turn and routes fire. Canvas keys each element by `el.id`,
so a component never remounts across the toggle — `InteractiveControl` explicitly
wipes any preview-driven live state at the edit boundary.

## Canvas gestures

`useCanvasGestures.ts` owns all pointer state (`canvasRef`, drag/marquee/pan/resize)
and returns handlers Canvas wires up. It mirrors props/state into refs and keeps a
single window `mousemove`/`mouseup`/`blur` listener so dragging never churns
listeners at 60fps.

| Gesture | Trigger | Notes |
|---|---|---|
| Move-drag | Mousedown on an element | 3px screen dead-zone before it activates so a click never nudges; snapped delta applied to the whole selection |
| Marquee | Mousedown on empty canvas | Live intersection test selects overlapping root elements |
| Pan | Pan tool, middle-mouse, or shift+left | Adds pointer delta to `panX`/`panY` |
| Resize | Mousedown on one of 8 handles | Single, unlocked selection only; `computeResizeRotated` |
| Rotate | Drag the rotate handle | `atan2` angle; Shift snaps to 15° steps |
| Drop | Drag from sidebar / asset panel | Reads `dataTransfer`, snaps to grid, calls `onDrop` |

Locked elements (`isLocked`) are skipped by move and resize. A mouseup that lands
outside the window is never delivered, so both this engine and the annotation layer
cancel their in-flight gesture on window `blur` to avoid a stranded drag.

### Resize geometry (`resizeMath.ts`)

`RESIZE_HANDLES` is the eight-handle set — four corners and four edge midpoints —
each with a unit offset (`ux`/`uy` in `0 / 0.5 / 1`) and a cursor. `computeResize`
moves the edges the handle name encodes (`n`/`s`/`e`/`w`), snaps only the moving
edges, floors the box at `MIN_ELEMENT_SIZE` (16), then repositions from the fixed
anchor. Knob and Spatial3D force a square footprint (`lockSquare`); Shift on a
corner locks the original aspect ratio. `computeResizeRotated` counter-rotates the
pointer delta into the element's local frame and resizes about its centre for
rotated elements (grid snap is skipped there, since snapping a rotated bounding box
is meaningless).

### Snap geometry (`snapMath.ts`)

`computeDragSnap` rounds the primary (first unlocked) element's top-left to the
grid, then lets smart alignment override it: for single-element drags it checks the
dragged box's left/right/centre and top/bottom/centre against every other element's
edges and centres within `alignThreshold` (`SNAP_THRESHOLD / scale` = a constant
5-screen-px feel at any zoom) and emits fuchsia guide lines. The snapped *delta* is
returned and applied to the whole selection, so multi-selections keep their
relative offsets instead of each element re-rounding onto the grid.

## Annotations

`AnnotationLayer.tsx` is an SVG overlay that only intercepts pointer events while
the Annotate tool is active. Drawings persist on `canvasState.annotations` and ride
autosave. Their purpose is dual: a human sketch pad *and* a channel the AI orb can
read (a colour can map to an element type via the annotation legend). Sub-tools:

| Sub-tool | Draws |
|---|---|
| `pen` | Freehand polyline (`stroke`) |
| `rect` | Rectangle |
| `ellipse` | Ellipse |
| `text` | Inline text note (Enter saves, Esc cancels) |
| `eraser` | Removes stroke points / whole shapes within a 12px radius |
| `move` | Select, drag, corner-resize, or delete an existing annotation |

The nine-colour palette (`ANNOTATION_PALETTE`) is Apple-system hues. In-progress
gestures stay local and commit exactly once on pointer-up, so drawing never
round-trips app state per frame. Erasing a stroke's middle splits it into the
surviving contiguous runs.

## The control dispatcher

`src/components/InteractiveControl.tsx` is the single dispatcher between an element
and its visual. It picks the render component by `el.type`, owns all interaction
state, and wraps every render in decorative layers.

Interaction state it holds: `val` (0–100), `xVal`/`yVal` (XY axes), `isOn`
(toggle), `isPressed` (button), `isOpen` (select), `liveWaveVal` (a bound
waveform's live amplitude), and `liveText` (an inbound text route driving a Label).

In preview mode it attaches native pointer listeners to `containerRef.current`:

| Element types | Drag model |
|---|---|
| Slider, Knob, Meter, WaveShaper | Vertical drag → `val` 0–100 (Knob sensitivity 0.5; others scale to height) |
| XYPad, Spatial3D | X/Y drag → `xVal`/`yVal` from the pointer position in the box |

Control render components receive `BaseControlProps` (`el`, `variant`, `isPreview`)
from `controls/shared.ts`; the interactive ones also receive the `containerRef` the
dispatcher attaches its listeners to.

### Variant normalization

Before handing a variant to the render component, the dispatcher maps raw
design-style names to canonical archetypes so the components only branch on a small
set:

| Raw variant | → Archetype |
|---|---|
| Skeuomorphic | Classic |
| Minimalist | Minimal |
| Apple-esque Minimalism / Streamline Moderne | Neumorphic |
| Swiss Style | Brutalist |
| Space Age Design | 3D |
| Morphogenetic Design | CellShaded |
| Neo-minimalism | Checkbox |
| Soft Minimalism | Outline |
| Retrofuturism | Mono |

> Note: This normalization feeds the *render* branch only. Per-control adjustable
> parameters (below) are scoped against the element's *raw* `variant` string, so a
> param limited to `["Aluminum"]` matches the raw sidebar variant, not the
> archetype.

### The wrap: glow, face, skin, texture

`wrapElement(content)` composites, from bottom to top:

1. **Base render** of the control (optionally at `opacity: 0` when an image face
   hides it — keeps layout and pointer wiring intact).
2. **Glow** — a procedural box-shadow / radial layer driven by `glow`,
   `glowStyle` (`outer`/`inner`/`center`/`radial`/`solid`/`neon`), `glowAmount`,
   `glowSpread`, `glowOpacity`, `glowColor`/`glowGradient`. `glowActiveOnly` scales
   the glow by the live value for Knob/Slider/Meter/XY, or gates it on active state.
3. **Image face** (universal, `zIndex 1`) — for the eight non-face-aware types.
4. **Skin overlays** (`zIndex 2`) — decorative CSS material layers from
   `getSkinLayers`.
5. **Texture** — a blend-mode-composited background image, offset/scaled/rotated.

### Image-face system

An element can wear a picture via `el.faceSrc`. Six controls are **face-aware** —
`Knob`, `Button`, `Toggle`, `Slider`, `XYPad`, `Meter` — and paint their own
value-reactive faces internally (a knob face rotates, a meter face clips bottom-up,
a button face swaps/brightens on press). The other eight content types
(`UNIVERSAL_FACE_TYPES`: Select, Label, Waveform, Spatial3D, WaveShaper, Envelope,
StepSequencer, Keyboard) get a single static face painted by `wrapElement`.
`faceHideBase` hides the programmatic render underneath via `opacity: 0` only
(never `display`/`visibility`), so the box, layout, and drag wiring survive. When
`faceSrc` is unset, every face branch is skipped and the render is byte-identical to
an unskinned control.

### Routing dispatch and LISTEN

`dispatchRoutes(axis, value, allowDaw)` fans a source control's shaped value to
every route whose axis matches. `dest: "daw"` routes are preview-gated and pushed
onto the theDAW control bus; `dest: "element"` routes publish on the ephemeral
`elementSignalBus`. Legacy single-target bindings are folded in via `routesOf()`
(see routing below). Buttons only send the leading edge to daw pad targets to avoid
double-triggering.

The two **display** types listen instead of send. A bound `Meter` drives its `val`
from the target's live value; a bound `Waveform` drives `liveWaveVal` (amplitude).
Both seed from the last-known value and re-subscribe when the bound id changes; an
active drag on the display itself wins over inbound frames.

## Control render components

Each control lives in `src/components/controls/`. Variants are the look presets you
drag from the sidebar; the render component reads live parameters through
`styleParam(el, key, fallback)`.

| Control | Shipped variants (from the sidebar palette) | Face-aware | Interactive |
|---|---|---|---|
| Knob | Blank, Modernism, Skeuomorphic, Minimalist, Apple-esque, Swiss Style, Morphogenetic, Space Age, Encoder, Aluminum, Vintage, LED Ring, Glass, Jog Wheel | Yes | Yes (drag) |
| Slider | Blank, Bipole, Modernism, Japandi, Contemp. Luxury, Bauhaus, Channel Fader, LED Slider, Mod Wheel, Pitch Wheel | Yes | Yes (drag) |
| Button | Blank, Functionalism, Soft Minimalism, Neumorphic, International Style, Drum Pad, LED Push, Chrome | Yes | Yes (press) |
| Toggle | Blank, Streamline Moderne, Neo-minimalism, Brutalist, Rocker, Lever | Yes | Yes (click) |
| Meter | Blank, VU Meter, LED Bar, LED Segments | Yes | Listens |
| XYPad | Blank, Kaoss, Crosshair | Yes | Yes (XY drag) |
| Label | Blank, Scandinavian, Retrofuturism, LCD | Static face | No |
| Select | Blank, Mid-century, Swiss Style, Segmented | Static face | Yes (open) |
| Waveform | Blank, Oscilloscope, Modern, LFO Sine/Triangle/Saw/Square/S&H | Static face | Listens |
| Spatial3D | Blank, Radar | Static face | Yes (XY drag) |
| WaveShaper | Blank, Sine Fold, Tanh, Hard Fold, Tube Drive | Static face | Yes (drag) |
| Envelope | Blank, ADSR | Static face | Self-editing |
| StepSequencer | Blank, Grid | Static face | Self-editing |
| Keyboard | Blank, Keys | Static face | No |

`Envelope` and `StepSequencer` are **self-editing**: dragging their handles / cells
calls `onStyleParams(patch)`, which `InteractiveControl` forwards to
`onUpdateElements` so the edit persists into `el.styleParams`. `Image` and `Group`
are drawn by Canvas directly; `CustomCode` renders through the sandboxed
`CustomCodeFrame` (see [custom-code.md](custom-code.md)).

## Control parameters

`src/components/controls/controlParams.ts` declares the adjustable parameters per
type in `CONTROL_PARAMS`. One declaration does three jobs: the properties panels
render an editor per param, the control reads the live value via `styleParam()`,
and the value persists in `el.styleParams`. A `variants` field limits a param to
specific variants (omit = all). Every param has a default so a control renders
identically to its pre-parameterization look when `styleParams` is absent.

`paramsForElement(el)` filters by type + variant (a variant-scoped def wins over an
unscoped one for the same key). `styleParam(el, key, fallback)` resolves in order:
stored value → variant-scoped default → caller fallback → unscoped default.

### Knob

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `sweepAngle` | Sweep Angle | number | 90–360 | 270 | all |
| `capSize` | Cap Size % | number | 50–100 | 100 | all |
| `indicatorLength` | Indicator Length % | number | 20–100 | 60 | all |
| `indicatorThickness` | Indicator Thickness | number | 1–10 | 3 | all |
| `tickCount` | Tick Marks | number | 0–24 | 0 | all |
| `showValueArc` | Value Arc | toggle | — | true | Aluminum |
| `arcThickness` | Arc Thickness | number | 1–10 | 3 | Aluminum |
| `bezelWidth` | Bezel Width | number | 0–14 | 4 | Aluminum, Glass |
| `brushIntensity` | Brush Intensity % | number | 0–100 | 50 | Aluminum |
| `ledSegments` | LED Segments | number | 6–32 | 15 | LED Ring |
| `ledUnlitOpacity` | Unlit LED % | number | 0–60 | 15 | LED Ring |
| `pointerWidth` | Pointer Width % | number | 10–60 | 30 | Vintage |
| `domeOpacity` | Dome Opacity % | number | 10–100 | 60 | Glass |
| `glowStrength` | Glow Strength % | number | 0–100 | 50 | Glass, LED Ring |
| `faceFit` | Face Fit | select | contain / cover / fill | contain | face |
| `faceOpacity` | Face Opacity % | number | 0–100 | 100 | face |
| `faceHideBase` | Hide Base Render | toggle | — | true | face |
| `faceMode` | Face Mode | select | rotate / static | rotate | face |
| `faceShowIndicator` | Show Indicator | toggle | — | false | face |

### Slider

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `trackWidth` | Track Width % | number | 10–100 | 40 | Blank |
| `capWidth` | Cap Width % | number | 40–100 | 90 | Blank |
| `capHeight` | Cap Height | number | 8–48 | 20 | Blank |
| `tickCount` | Tick Marks | number | 0–20 | 0 | all |
| `showTicks` | Show Tick Scale | toggle | — | true | Channel Fader |
| `railDepth` | Rail Depth | number | 1–12 | 4 | Channel Fader |
| `glowStrength` | Glow Strength % | number | 0–100 | 60 | LED Slider |
| `fillFromCenter` | Fill From Center | toggle | — | true | Bipole |
| `wheelGrooves` | Wheel Grooves | number | 4–20 | 8 | Mod Wheel, Pitch Wheel |
| `wellDepth` | Well Depth | number | 1–10 | 4 | Mod Wheel, Pitch Wheel |
| `faceFit` / `faceOpacity` / `faceHideBase` | (face trio) | — | — | contain / 100 / true | face |
| `faceRole` | Face Role | select | thumb / track | thumb | face |
| `faceThumbSize` | Thumb Size % | number | 10–100 | 60 | face |

### Meter

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `segmentCount` | Segments | number | 6–32 | 14 | LED Segments |
| `segmentGap` | Segment Gap | number | 0–6 | 1 | LED Segments |
| `yellowStart` | Amber Zone Start % | number | 30–90 | 60 | LED Segments |
| `redStart` | Red Zone Start % | number | 60–98 | 85 | LED Segments |
| `zoneGreen` / `zoneAmber` / `zoneRed` | Zone colours | color | — | #22c55e / #f59e0b / #ef4444 | LED Segments |
| `bezelWidth` | Bezel Width | number | 0–10 | 1 | all |
| `needleThickness` | Needle Thickness | number | 1–8 | 2 | VU Meter |
| `faceMode` | Face Mode | select | fill / static | fill | face |

### Button

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `bezelWidth` | Bezel Width | number | 0–12 | 3 | LED Push, Chrome |
| `pressDepth` | Press Depth | number | 1–8 | 2 | LED Push, Blank |
| `labelSize` | Label Size | number | 8–24 | 12 | all |
| `ledStripHeight` | LED Strip Height | number | 2–12 | 4 | LED Push |
| `glowStrength` | Glow Strength % | number | 0–100 | 60 | LED Push, Chrome |
| `facePressed` | Pressed Effect | select | brightness / scale / offset / swap | brightness | face |
| `facePressedAmount` | Pressed Amount % | number | 0–100 | 30 | face |

Plus the universal face trio (`faceFit` / `faceOpacity` / `faceHideBase`). The
swap-image URL `facePressedSrc` is written to `styleParams` by code and has no
editor.

### Toggle

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `switchScale` | Switch Size % | number | 50–100 | 100 | all |
| `leverAngle` | Lever Throw ° | number | 10–50 | 24 | Lever |
| `showLegends` | I/O Legends | toggle | — | true | Rocker |
| `housingDepth` | Housing Depth | number | 1–10 | 3 | Rocker, Lever |
| `glowStrength` | On-Glow Strength % | number | 0–100 | 50 | Rocker, Lever |
| `faceOn` | On Effect | select | brightness / tint / swap | brightness | face |
| `faceOnAmount` | On Amount % | number | 0–100 | 30 | face |

Plus the universal face trio; the `faceOnSrc` swap-image URL is code-set with no
editor.

### XYPad

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `gridDivisions` | Grid Divisions | number | 0–12 | 0 (10 for Crosshair) | all / Crosshair |
| `gridOpacity` | Grid Opacity % | number | 0–40 | 8 | Crosshair |
| `crosshairOpacity` | Crosshair Opacity % | number | 0–100 | 40 | Crosshair |
| `dotSize` | Dot Size | number | 6–32 | 12 | all |
| `trailEcho` | Motion Trail | toggle | — | true | Crosshair |
| `glowStrength` | Dot Glow % | number | 0–100 | 60 | Kaoss, Crosshair |
| `faceRole` | Face Role | select | puck / background | puck | face |
| `facePuckSize` | Puck Size % | number | 5–50 | 20 | face |

Plus the universal face trio.

### Spatial3D

| Key | Label | Type | Range | Default | Variant scope |
|---|---|---|---|---|---|
| `gridDivisions` | Grid Divisions | number | 0–12 | 3 | all |
| `dotSize` | Dot Size | number | 6–32 | 8 | all |
| `glowStrength` | Dot Glow % | number | 0–100 | 60 | Radar |

### Waveform

| Key | Label | Type | Range | Default | Variant scope |
|---|---|---|---|---|---|
| `barCount` | Bars | number | 8–96 | 10 | Modern |
| `lineThickness` | Line Thickness | number | 1–8 | 2 | all |
| `amplitude` | Amplitude % | number | 10–100 | 50 (Oscilloscope) / 90 (Modern) / 70 (LFO*, Blank) | per-variant |
| `mirror` | Mirror | toggle | — | false | Modern |
| `cycles` | Cycles | number | 1–8 | 2 | LFO Sine/Triangle/Saw/Square/S&H |
| `phase` | Phase % | number | 0–100 | 0 | LFO Sine/Triangle/Saw/Square/S&H |

### Label

| Key | Label | Type | Range / options | Default | Variant scope |
|---|---|---|---|---|---|
| `fontSize` | Font Size | number | 8–64 | 12 (10 Retrofuturism / 16 LCD) | per-variant |
| `fontWeight` | Weight | select | normal / medium / bold | normal | Blank, Scandinavian Modern, Retrofuturism, Mid-century Modern |
| `align` | Align | select | left / center / right | left (center for LCD) | all / LCD |
| `letterSpacing` | Letter Spacing | number | 0–12 | 1.6 (Retrofuturism) / 0 (others) | per-variant |
| `uppercase` | Uppercase | toggle | — | true Retrofuturism / false others | per-variant |
| `lcdGlow` | LCD Glow % | number | 0–100 | 40 | LCD |

`Label` also honours an inbound `text` route via `liveText`, overriding `el.label`.

### Select

| Key | Label | Type | Range | Default |
|---|---|---|---|---|
| `fontSize` | Font Size | number | 8–24 | 12 |
| `chevronSize` | Chevron Size | number | 4–16 | 8 |

### WaveShaper

| Key | Label | Type | Range | Default | Variant scope |
|---|---|---|---|---|---|
| `symmetry` | Symmetry % | number | 0–100 | 50 | Tube Drive |
| `gridOpacity` | Grid Opacity % | number | 0–40 | 10 | all |
| `curveThickness` | Curve Thickness | number | 1–8 | 3 | all |
| `fillUnderCurve` | Fill Under Curve | toggle | — | true | all |

### Envelope

| Key | Label | Type | Range | Default |
|---|---|---|---|---|
| `attack` | Attack | number | 0–100 | 15 |
| `decay` | Decay | number | 0–100 | 30 |
| `sustain` | Sustain | number | 0–100 | 70 |
| `release` | Release | number | 0–100 | 25 |
| `curveTension` | Curve Tension | number | 0–100 | 30 |
| `showGrid` | Show Grid | toggle | — | true |

### StepSequencer

| Key | Label | Type | Range | Default |
|---|---|---|---|---|
| `rows` | Rows | number | 1–8 | 4 |
| `steps` | Steps | number | 4–32 | 16 |
| `cellGap` | Cell Gap | number | 0–6 | 2 |
| `accentEvery` | Accent Every | number | 2–8 | 4 |

### Keyboard

| Key | Label | Type | Range | Default |
|---|---|---|---|---|
| `octaves` | Octaves | number | 1–4 | 2 |
| `showLabels` | Show Labels | toggle | — | false |

## Skins

`src/lib/skins.ts` defines universal material "skins" — CSS-recipe layers any
element can wear via `el.skin`, independent of its variant. Each recipe tints
itself to the host element's base/active colours with `color-mix()`, so the same
skin reads differently on a purple knob than an amber button. The dispatcher paints
each overlay as an absolutely-positioned, full-cover, pointer-inert div above the
control render.

| Skin id | Label | Look |
|---|---|---|
| `none` | None | No skin (default) |
| `aluminum` | Aluminum | Brushed vertical microlines + sheen + inset bevel |
| `chrome` | Chrome | Horizon gradient, conic sheen, specular streak, dark edge ring |
| `glass` | Glass | Top highlight ellipse over a white film with an active-tinted inner glow |
| `bakelite` | Bakelite | Warm dark plastic radial tint, fine speckle, glossy top |
| `carbon` | Carbon Fiber | Crossed twill weave + diagonal sheen |
| `matte` | Matte | Desaturating dark film that kills gloss + soft inner shadow |
| `leather` | Leather | Warm grain radial, pore speckle, dashed inset stitch line |
| `led-glow` | LED Glow | Inner + outer glow ring in the active colour, no fill |

See [textures-and-skins.md](textures-and-skins.md) for how skins, image faces, and
generated textures layer together.

## Routing and modulation

An element's `binding` (`ElementBinding`) carries a modulation **stack**:
`binding.routes` is an array of `ElementRoute`. One control can drive many
destinations at once — theDAW functions (`dest: "daw"`) and other canvas elements
(`dest: "element"`). The shaping math and compatibility maps live in
`src/lib/routing.ts`.

An `ElementRoute` has: `axis` (`value` / `x` / `y`), `dest`, `targetId`, `prop`
(for element routes), `amount` (−100..100 depth, negative inverts), `curve`, and
`rangeMin`/`rangeMax` (0–100 output clamp). `applyRoute` normalizes the source to
0–1, applies depth/invert, then a curve, then the output range:

| Curve | Shape |
|---|---|
| `linear` | `v` |
| `exp` | `v³` — fast late (classic exponential) |
| `log` | `1 − (1−v)³` — fast early |
| `scurve` | `v²(3 − 2v)` — smoothstep |

`routesOf(el)` merges explicit routes with legacy single-target fields
(`targetId` / `xTargetId` / `yTargetId`) migrated on the fly (axis-aware dedup,
never persisted). The listen `targetId` on Meter/Waveform is excluded — it is not a
route.

Which axes a type emits (`sourceAxesFor`) and which destination props it accepts
(`elementDestProps`):

| Type | Emits (source axes) | Accepts as destination (prop → label) |
|---|---|---|
| Knob, Slider, WaveShaper | value | value → Value |
| Toggle | value | on → State |
| Button | value | — |
| XYPad, Spatial3D | x, y | valueX → X, valueY → Y |
| Meter | — (listens) | value → Value |
| Waveform | — (listens) | value → Amplitude |
| Label | — | text → Readout |

`isRouteSource(type)` is true when a type emits at least one axis (Knob, Slider,
WaveShaper, Toggle, Button, XYPad, Spatial3D).

### The routing UI (`BindingPicker`)

`src/components/properties/BindingPicker.tsx` renders one of three surfaces
depending on the element:

- **RoutingStack** (source controls) — the list of routes, plus an "Add Route"
  browser. Each route is a compact card: destination + a centre-notched amount
  slider, expandable to curve, output range, and (for XY sources) the source axis.
  Legacy single-target bindings show as amber "convert to route" cards. An axis
  selector appears when the source has more than one axis.
- **RouteBrowser** — a searchable, grouped picker: live theDAW manifest targets by
  area (each area gets a deterministic colour dot), then the always-available
  built-in `vst:` binds (Transport, Plugin, Macros, LFOs, Presets, MIDI, MIDI
  Notes) — large areas collapse by default — then other canvas elements grouped by
  compatible property.
- **ListenPicker** (Meter / Waveform) — a single "Listen to" source select, since
  display types are driven *by* a target rather than driving one.

`CustomCode` elements bind per numeric parameter through `CustomParamBindingPicker`
(`el.paramBindings`) rather than the element-level stack. A "theDAW bus"
status line reports connection; built-in `vst:` binds work even when theDAW is
offline. The live manifest comes from the bus via `useDawBindings()`. See
[thedaw-integration.md](thedaw-integration.md) for the bus itself.

## The properties editor

`src/components/CompactElementProperties.tsx` is the active element editor — a
tabbed, dense panel that App renders inside the draggable context popover (see the
context menu section below). Tabs are hidden when they do not apply to the selected
type. It is built from the shared building blocks in
`src/components/properties/`: the field primitives (`fields/`), the select-option
arrays (`options.ts`), the numeric plumbing (`useElementField.ts`), the routing UI
(`BindingPicker`), and the generated Control Parameters editor
(`ControlParamsSection`).

> Note: A second, full right-panel editor — `PropertiesPanel.tsx` (collapsible
> Transform / Style / Effects / Routing / Control Parameters / Texture sections, a
> Properties / Info tab, and a header lock toggle) — has been retired to
> `deprecated/src/components/PropertiesPanel.tsx` and is imported by nothing in the
> active app. Several building blocks under `src/components/properties/` still carry
> doc-comments that mention "both PropertiesPanel and CompactElementProperties";
> those comments are stale — only `CompactElementProperties` consumes them today.

`CompactElementProperties` tabs (`TabId`):

| Tab | Shows |
|---|---|
| `transform` | Position, size, rotation, opacity, lock |
| `style` | Design variant, corner radius, theme colours, layer blend mode |
| `fx` | Glow (style/opacity/intensity/spread/colour/gradient) and animation effect |
| `control` | Export name, label/value/min/max, Select options, Control Parameters |
| `texture` | Background texture + blend/opacity/size/repeat/scale/rotation/offset |
| `binding` | The `BindingPicker` routing stack |
| `image` | Image-only: background removal (tolerance/feathering/target colour) + blend |
| `raw` | Monaco JSON editor of the whole element |

The `raw` tab is wired through `properties/rawEditor.ts` (`useRawJsonEditor`): a
debounced diff-commit that flushes on blur/unmount and never writes `id`. Monaco
also gets hover hints for common property keys. The numeric plumbing lives in
`useElementField.ts` (`parseNumericInput`, `createFieldChangeHandler`, the
`UpdateElementsFn` type) and the select-option arrays in `options.ts`
(full/reduced blend-mode lists, effect list, `normalizeGlowStyle`).

### `ControlParamsSection`

`properties/ControlParamsSection.tsx` renders the generated Control Parameters
editor used by the `control` tab. It draws:

- a universal **Skin** picker (`element.skin`, on every type except Group);
- one field per declared param for the element's type/variant (number → range +
  numeric input, color → colour field, toggle, select) — `face*` params stay hidden
  until `el.faceSrc` is set;
- a **Reset parameters** link when any managed key is overridden;
- a **Control Type** convert dropdown (only when the element carries a picture — a
  face, or an Image backed by an asset) that dispatches a `vst-convert-type`
  CustomEvent for the App to handle;
- **Save to Arsenal** (dispatches `vst-arsenal-save`) for any non-Group control, and
  **Remove face image** (clears `faceSrc`) once the control wears one.

## The left sidebar

`src/components/Sidebar.tsx` is the component palette, split into two independently
toggled columns: a **Categories** rail and an **Explorer** column showing the
selected category's drag tiles. Categories:

| Category | Contents |
|---|---|
| Knobs, Sliders, Buttons, Toggles | Native control variants (see the render-component table) |
| Display | Label, Select variants |
| Waveforms, Meters, XY Pads, Spatial / 3D | Their variants |
| Shapers & Sequencers | WaveShaper, Envelope, StepSequencer, Keyboard variants |
| Custom Code | User-authored CustomCode modules (with a name + code form) |
| Saved Presets | Element presets saved from the Raw tab (`localStorage` `vst-custom-presets`) |
| Arsenal | The global saved-control palette (see [textures-and-skins.md](textures-and-skins.md)) |

Each tile is `draggable`; dropping it onto the canvas calls `onDrop` with the type,
default size, variant, optional `customCode`, and optional `presetData` (spread
whole onto the new element). Arsenal tiles carry a hover delete-X.

## The header toolbar

`src/components/Header.tsx` is the top strip (collapsible via an edge handlebar in
`App.tsx`). It carries the workspace actions:

| Control | Action |
|---|---|
| Show Rulers / Grid Overlay / Snap to Grid + Size | Canvas guide toggles + grid-size input |
| Undo / Redo | Full history (Ctrl+Z / Ctrl+Shift+Z) |
| Upload / Change Background | Loads a background image, auto-fits the scale |
| Extract Components (scissors) | Opens the component extractor — see [component-extractor.md](component-extractor.md) |
| Clear (trash) | Removes all elements (shown only when the canvas has elements) |
| Demo / Edit Mode | Toggles `isPreviewMode` |
| Project Library (folder) | Opens saved projects — see [projects-and-data.md](projects-and-data.md) |
| Open .gan (package) | Opens a `.gan` plugin to edit — see [gan-format.md](gan-format.md) |
| Save / Download JSON | Persist / download the project |
| Package (archive) | Export the full ZIP — see [vst3-export.md](vst3-export.md) |
| Export Code | React/TSX or JSON export |
| Settings (gear) | Theme, canvas size, provider keys, SD paths |

The brand lockup at the left is `brand-title/BrandTitle.tsx`.

## Layers panel

`src/components/LayersPanel.tsx` is the z-order list. It renders the elements
*reversed* (top layer at the top of the list), supports drag-and-drop reorder plus
per-row up/down buttons, shows a z-index badge (`z-N`, tagged `(top)` / `(base)`),
and shows an image thumbnail for Image layers (resolved from the `assets` prop),
falling back to a two-letter type initial for everything else. Clicking a row
selects the element (shift/ctrl/meta for multi-select).

## Alignment and distribution

Alignment and distribution ship as inline helpers in `src/App.tsx` —
`computeAlign(ids, type)` and `computeDistribute(ids, axis)` — driven by the AI
assistant rather than a manual panel. App's action handler wires them to the orb
tools `alignElements` (`{ ids, alignment }`) and `distributeElements`
(`{ ids, axis }`), both registered in `components/orb/useToolActions.ts`.

- **Align, single selection** — snaps the element to the canvas edges or centres:
  `left`, `centerH`, `right`, `top`, `centerV`, `bottom`.
- **Align, multi-selection** — aligns elements relative to each other: edges to the
  selection min/max, centres to the selection average.
- **Distribute** — `horizontal` or `vertical`; needs more than two movable
  elements, then evens the gaps between the sorted elements.

Locked elements are skipped in every operation.

> Note: A manual `AlignmentPanel.tsx` used to render these as buttons; it has been
> retired to `deprecated/src/components/AlignmentPanel.tsx` and is imported by
> nothing in the active app. The `computeAlign` comment in `App.tsx` still reads
> "Mirrors AlignmentPanel.handleAlign" from that earlier design — alignment is
> AI-driven today.

## Context menu

`src/components/ContextMenu.tsx` is a draggable, viewport-clamped fixed popover that
takes a `ContextMenuAction[]` (label, icon, onClick, shortcut, danger, divider,
disabled, iconOnly). It renders a vertical action list plus an icon-only toolbar for
`iconOnly` actions. Canvas triggers it on element right-click (anchored to the
element's right edge) and on empty-canvas right-click (at the cursor). A grab handle
lets the user drag it; it hard-clamps to the viewport on open, on drag, on internal
resize (a `ResizeObserver`), and on window resize, and closes on outside-click or
Escape. It commonly hosts a `CompactElementProperties` panel as its `children`.

## Event log

`src/components/EventLog.tsx` is a floating console (bottom-right terminal button)
that merges two streams: the Foundry server's in-memory log (polled from
`GET /api/logs?lines=400` every 2.5s while the panel is open) and client-side errors
captured at all times (`window.onerror`, `unhandledrejection`, and a monkey-patched
`console.error`). Both streams start with an ISO timestamp so a plain sort
interleaves them chronologically. Lines are classified `error` / `warn` / `info` and
colour-coded, and the toggle button shows an unseen-error badge for errors that
arrived while the panel was closed. It surfaces failures the browser F12 console
cannot see (generation failures, Claude CLI spawn errors, MCP relay, config).

## Asset and texture libraries

Two `CollapsiblePanel` libraries feed the canvas with imagery:

- **`AssetManager.tsx`** — the image library. Upload or AI-generate an image, then
  drag it onto the canvas as an `Image` element (the drop payload carries
  `elementType=Image` plus `assetId`/`url`). Includes a 2-up/4-up thumbnail zoom
  toggle.
- **`TextureManager.tsx`** — the texture library. Upload (`POST /api/textures/upload`,
  with a data-URL fallback) or AI-generate, then drag a texture onto a control (the
  `application/x-vst-texture` payload sets the element's `textureId`).

Both are covered in depth in [textures-and-skins.md](textures-and-skins.md);
generation itself is in the assistant/SD flow ([assistant-and-mcp.md](assistant-and-mcp.md)).

## Where to go next

- [foundry-overview.md](foundry-overview.md) — the whole app and how these pieces fit together.
- [custom-code.md](custom-code.md) — the sandboxed CustomCode element and its param bridge.
- [textures-and-skins.md](textures-and-skins.md) — image faces, skins, textures, the Arsenal.
- [thedaw-integration.md](thedaw-integration.md) — the control bus and live binding.
- [gan-format.md](gan-format.md) / [vst3-export.md](vst3-export.md) — turning a canvas into a plugin.
- [index.md](index.md) — the documentation map.
