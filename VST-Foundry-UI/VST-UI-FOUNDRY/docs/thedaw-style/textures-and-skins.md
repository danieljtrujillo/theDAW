# Textures and Skins — Visual Asset Pipeline

Reference for how Foundry gives controls a material look: procedural and
AI-generated **textures**, CSS material **skins**, and image **faces**. It
covers where the pixels come from (a built-in procedural pack, uploads, and
Stable Diffusion / DALL-E / Gemini generation), where they are stored (in the
browser project state and on the sidecar's `data/textures/` folder), how they
are attached to a control, group, or image, how they composite on top of the
base render, and how they ride along when a project is saved, exported as a
`.gan`, or exported as a VST3 bundle. It is for anyone touching the texture/skin
UI, the generation endpoints, or the export path. Plain descriptions of what each
piece does.

For the control render layer these visuals sit on top of, see
[canvas-and-controls.md](canvas-and-controls.md). For how the finished design
(including textures) is packaged, see [gan-format.md](gan-format.md) and
[vst3-export.md](vst3-export.md).

## The three visual layers

Foundry has three independent ways to change how a control looks. They stack, so
one control can carry all three at once. Each is opt-in and each is stored on the
element, so it rides every save path for free.

| Layer | Element field(s) | What it is | Where the pixels live |
|---|---|---|---|
| **Texture** | `textureId` (+ `texture*` transform fields) | A raster image tiled/scaled over the whole control box, blended with a mix-blend-mode | A `Texture` in the project's `textures[]` (built-in, uploaded, or AI-generated) |
| **Skin** | `skin` | A pure-CSS material recipe (aluminum, chrome, glass…) that tints itself to the element's colors | Code — `src/lib/skins.ts`, no image bytes |
| **Face** | `faceSrc` (+ `face*` style params) | An image "cutout" that replaces or overlays the programmatic render of a single control | A URL (data URL or `/textures/<id>`) stored directly on the element |

> Skin and texture are element-agnostic — any control (and, for textures, a Group
> or Image) can wear them. Faces are control-specific: six controls paint their
> own value-reactive faces internally, the other eight get a static face. See
> [Image faces](#image-faces) below.

## Two libraries: assets vs textures

The left sidebar has two image libraries. They look similar but serve different
roles and store their pixels differently.

| | Asset Library (`AssetManager.tsx`) | Texture Library (`TextureManager.tsx`) |
|---|---|---|
| Holds | `Asset[]` — images meant to become **Image elements** on the canvas | `Texture[]` — images meant to **skin controls** as background textures |
| Drag target | Empty canvas → creates an `Image` element | Onto a control/group → sets its `textureId` |
| Drag payload | `elementType=Image`, `assetId`, `assetUrl`, `defaultWidth/Height` | `application/x-vst-texture` = `{ id }` |
| Upload path | Client-side only: `FileReader` → data URL kept inline in state | `POST /api/textures/upload` → server file, with data-URL fallback |
| AI gen target | `TextureGenerateModal` with `target="asset"` | `TextureGenerateModal` with `target="texture"` |
| Thumbnails | 4-up compact by default; header zoom toggles 2-up | Same |

Both are `CollapsiblePanel`s with **Upload** and **Gen** buttons and a
zoom-toggle in the header. Selecting a tile reveals a delete (`X`) button;
hovering an asset tile also shows a **Use** button that drops it on the canvas.

> Asset images are embedded as data URLs directly in project state — they are
> never written to `data/textures/`. Uploaded textures are the opposite: they are
> written to disk and referenced by a short `/textures/<file>` URL. This matters
> for export inlining (see [How textures travel](#how-textures-skins-and-faces-travel)).

## Built-in procedural texture pack

`src/lib/proceduralTextures.ts` ships an eight-texture pack that costs zero bytes
on disk. Each texture is drawn to an offscreen 512×512 canvas at runtime and
exported as a PNG data URL. Generation is fully deterministic — a seeded
`mulberry32` PRNG (never `Math.random`) with a fixed seed per texture — so every
build produces byte-identical pixels and stable ids, which keeps the
autosave/dedupe path from ever seeing them "change".

| Id | Name | Seed | How it is drawn |
|---|---|---|---|
| `builtin-brushed-steel` | Brushed Steel | 1001 | Vertical metal gradient + ~9000 faint full-width horizontal strokes + a diagonal sheen band |
| `builtin-carbon-weave` | Carbon Weave | 1002 | 16px twill cells with alternating fiber-bundle gradients and thin weave separations |
| `builtin-leather-grain` | Leather Grain | 1003 | fBm mottle + value-noise grain per pixel, then wrapped dark pores and warm highlights |
| `builtin-wood-grain` | Wood Grain | 1004 | Warped vertical strands (22 ring periods) modulated by fine fibre noise |
| `builtin-plastic-noise` | Plastic Noise | 1005 | Baked vertical sheen + broad mottle + very fine grain |
| `builtin-concrete` | Concrete | 1006 | 5-octave fBm base with wrapped dark pits and light flecks |
| `builtin-perforated-metal` | Perforated Metal | 1007 | Dark plate + 32px punched dot grid, each hole a radial gradient with highlight/shadow arcs |
| `builtin-scanlines` | Scanlines | 1008 | CRT lines on a 4px period with per-line jitter and faint vertical phosphor triads |

All eight are authored to tile seamlessly at 512px: patterns use a period that
divides 512, and value-noise is sampled from a wrapped lattice
(`makeTileableNoise` / `makeFbm`). `wrappedCircle()` re-draws speckle dots that
fall near a tile edge on the opposite side so holes and pores stay seamless.

Each built-in `Texture` carries `isGenerated: true` and `provider: "builtin"`.
`generateBuiltinTextures()` returns an empty array outside a browser (no
`document`), so callers can invoke it unconditionally.

> The pack is merged into the library once, after the mount-time project load
> settles (`App.tsx`, gated on `hasLoadedAutosave`). Built-ins not already present
> by their stable id are **prepended** so they head the list; the id-dedupe returns
> the previous array unchanged once they are present, so autosave never spins a
> dirty cycle when a later load echoes them back.

## Generating textures and artwork with AI

`TextureGenerateModal.tsx` is the generation UI, shared by both libraries (the
`target` prop switches between adding results to `textures[]` or `assets[]`). Its
form and result rendering are split into `src/components/texture-gen/`.

| Provider tab | `provider` sent | Backend | Notes |
|---|---|---|---|
| Stable Diffusion → Automatic1111 | `a1111` | `generateViaA1111` | Local; talks to A1111 on port `7860` by default |
| Stable Diffusion → ComfyUI | `comfyui` | `generateViaComfyUI` | Local; talks to ComfyUI on port `8188` by default |
| DALL-E | `openai` / `dalle` | `generateViaDallE` | Cloud (OpenAI); optional per-request API key override |
| Gemini | `gemini` | `generateViaGemini` | Cloud (Google); optional per-request API key override |

The SD tab additionally exposes a start/stop control and a live status pill
(polled every `STATUS_POLL_MS = 5000` ms via `GET /api/sd/status`), plus an
Advanced section for model/checkpoint, VAE, and a LoRA stack (each LoRA a
`{ name, weight }` pair, weight 0.1–1.5). Cloud tabs expose size, count, and — for
DALL-E — quality (`standard`/`hd`) and style (`vivid`/`natural`). `CLOUD_SIZES`
offers `512×512` through `1792×1024`.

### texture-gen module roles

| File | Role |
|---|---|
| `TextureGenerateModal.tsx` | Owns all state, config/status/resources fetching, generation + queue orchestration |
| `texture-gen/GenerateForm.tsx` | Presentational prompt + parameter inputs (SD toggle, basic params, advanced/LoRA) |
| `texture-gen/ResultsGrid.tsx` | 4-up grid of the immediate `Generate` results |
| `texture-gen/QueuePanel.tsx` | Queue list with per-item status, thumbnails, and remove controls |
| `texture-gen/buildParams.ts` | Pure builder that assembles the `TextureGenParams` request body |
| `texture-gen/constants.ts` | `CLOUD_SIZES`, shared Tailwind class strings, `STATUS_POLL_MS` |
| `texture-gen/types.ts` | `GeneratedTexture`, `QueueItem`, `SDResources`, `ProviderTab`, `SdType` |
| `texture-gen/NumberField.tsx` | Small numeric input used across the form |

Two run modes share one endpoint (`POST /api/textures/generate`):

- **Generate** — fires one request immediately and shows the results grid.
- **+ Queue** — appends a `QueueItem`; an effect auto-processes the next
  `pending` item whenever the modal is idle. A synchronous `queueProcessingRef`
  guard prevents a double-start in the same tick, and an `AbortController` cancels
  the in-flight fetch when the modal closes.

> The modal validates before it calls the SD backend: an SD tab must be
> configured (a path set in Settings) **and** running, or generation is blocked
> with an inline error. Cloud tabs skip that gate.

## Uploading textures

`TextureManager` reads each dropped file as a data URL, then `POST`s it to the
sidecar:

```
POST /api/textures/upload
{ "dataUrl": "data:image/png;base64,…", "name": "brass.png" }
→ { "id": "<uuid>", "name": "brass.png", "url": "/textures/<uuid>.png" }
```

The server validates the MIME type (`png`, `jpg`/`jpeg`, `gif`, `webp`), writes
`<uuid>.<ext>` into `TEXTURES_DIR`, and returns the short URL. If the request
fails for any reason, the client falls back to keeping the raw **data URL** in
state so the texture is still usable — it just is not persisted as a file.

Asset uploads (`AssetManager`) never hit the server: the file is read to a data
URL and kept inline, and an `Image` element carries the natural `width`/`height`
sampled from an in-memory `Image` load.

## Server storage and endpoints

The sidecar's on-disk tree is defined in `server/paths.ts`; texture routes live
in `server/routes.ts` and SD process/generation logic in `server/sd.ts`.

| Path | Role |
|---|---|
| `data/textures/` | `TEXTURES_DIR` — uploaded and AI-generated image files, served statically at `/textures/` |
| `data/generated/` | Scratch output from image tools (edit/upscale/variations/etc.) |
| `data/sessions/latest.json` | Autosaved project state (`SESSION_PATH`, with `.bak` recovery) |
| `data/config.json` | App/SD config (`CONFIG_PATH`) |
| `data/logs/` | Sidecar log files |

| Endpoint | Method | Purpose |
|---|---|---|
| `/textures/*` | GET | Static file serving of `TEXTURES_DIR` |
| `/api/textures/upload` | POST | Save a base64 data URL as a texture file |
| `/api/textures/:id` | DELETE | Delete a texture file by uuid (id validated as a 36-char uuid) |
| `/api/textures/list` | GET | List texture files on disk |
| `/api/textures/generate` | POST | Generate images via the selected provider, saved as texture files |
| `/api/config` | GET / POST | Read / merge-and-save app + SD config |
| `/api/sd/status` | GET | Whether an SD process is running, its type/port/start time |
| `/api/sd/start` / `/api/sd/stop` | POST | Start / stop the configured SD process |
| `/api/sd/resources` | GET | Models, VAEs, LoRAs, samplers for a given SD type |

Generated images are written by `saveImagesToFiles()` (`server/sd.ts`): each image
becomes `<uuid>.png` in `TEXTURES_DIR`, returned as
`{ id, name: "Gen N (provider)", url: "/textures/<file>", prompt, provider, createdAt, isGenerated: true }`.

## Applying a texture to a control

A texture is attached by setting the element's `textureId`. There are three ways
in:

| Path | Mechanism |
|---|---|
| Drag from Texture Library | `TextureManager` sets `application/x-vst-texture`; `Canvas` `onDrop` calls `onUpdateElements([id], { textureId })` |
| Properties panel | The **Texture** tab in `CompactElementProperties` / `PropertiesPanel` picks a tile and sets `textureId` |
| AI assistant | The orb's `applyTexture` tool (`useToolActions.ts`) patches `textureId` + optional transform fields; `removeTexture` clears them all |

At render time, `Canvas` resolves the id to a URL —
`textures.find(a => a.id === el.textureId)?.url` — and passes it as `textureUrl`
to `InteractiveControl` (native controls), `CustomCodeFrame` (CustomCode), or
`ProcessedImage` (Image elements). Groups paint the texture overlay directly in
`Canvas`.

The overlay is a full-cover, `pointerEvents: none` div whose inner div reads the
element's texture transform fields:

| Field | Default | UI range | Maps to |
|---|---|---|---|
| `textureBlendMode` | `normal` | 12-mode set below | wrapper `mixBlendMode` |
| `textureOpacity` | `100` | 0–100% | inner `opacity` (÷100) |
| `textureSize` | `cover` | Cover / Contain / Auto / Stretch (`100% 100%`) | `backgroundSize` |
| `textureRepeat` | `no-repeat` | No Repeat / Repeat / Repeat X / Repeat Y | `backgroundRepeat` |
| `textureScale` | `100` | 10–400% | `transform: scale()` (÷100) |
| `textureRotation` | `0` | 0–360° | `transform: rotate()` |
| `textureOffsetX` / `textureOffsetY` | `0` | free px | `backgroundPosition` offset from centre |

Texture blend modes are a reduced set (`TEXTURE_BLEND_MODE_OPTIONS` in
`properties/options.ts`): `normal`, `multiply`, `screen`, `overlay`, `darken`,
`lighten`, `color-dodge`, `color-burn`, `hard-light`, `soft-light`, `difference`,
`exclusion`. (An Image element's own *layer* blend uses the full 16-mode
`BLEND_MODE_OPTIONS`, which adds hue/saturation/color/luminosity.)

## Material skins

`src/lib/skins.ts` provides universal material "skins" — CSS-only recipes any
element can wear independent of its variant. `getSkinLayers(id, { base, active })`
resolves a skin id plus the host element's colors into concrete layers:

- `containerStyle` — an optional style merged onto the element container.
- `overlayStyles[]` — zero or more full-cover overlay layers the dispatcher
  renders as absolutely-positioned, `pointerEvents: none` divs with
  `borderRadius: inherit`.

Every recipe tints itself to the host via CSS `color-mix()`, so the same skin
reads differently on a purple knob than on an amber button.

| Skin id | Label | Recipe (summary) |
|---|---|---|
| `none` | None | No layers (also returned for unknown ids) |
| `aluminum` | Aluminum | Base-tinted metal gradient + microline overlay + sheen + inset bevel |
| `chrome` | Chrome | Horizon gradient + conic sheen + specular streak + dark edge ring |
| `glass` | Glass | Top highlight ellipse over a low-opacity white film + active-tinted inner glow |
| `bakelite` | Bakelite | Warm radial brown tint + fine speckle + glossy top light |
| `carbon` | Carbon Fiber | Two crossed repeating-gradients (twill) over a dark tint + diagonal sheen |
| `matte` | Matte | Desaturating dark multiply film + soft inner shadow |
| `leather` | Leather | Warm radial tint + radial-speckle pores + dashed inset stitch outline |
| `led-glow` | LED Glow | Inner + outer glow ring in the element's active color, no fill |

The skin is chosen in the properties panel via `ControlParamsSection.tsx`, which
renders a universal **Skin** picker on every element type **except Group**. The
chosen id is stored on `element.skin` (cleared to `undefined` for "none"). The
`"none"` entry must stay first in the `SKINS` list — settings UIs use it as the
default option.

> Colors for the tint come from `el.baseColor` / `el.activeColor`, falling back to
> per-archetype defaults from `getDefaultColors()` in
> [`colorUtils`](#color-and-image-helpers).

## Image faces

A **face** (`faceSrc`) is an image rendered as a control's visual, opt-in per
element. Two mechanisms exist:

- **Face-aware controls** (Knob, Button, Toggle, Slider, XYPad, Meter) paint
  their own value-reactive faces internally.
- **Universal-face controls** (Select, Label, Waveform, Spatial3D, WaveShaper,
  Envelope, StepSequencer, Keyboard — `UNIVERSAL_FACE_TYPES`) get a **static**
  face painted by `InteractiveControl.wrapElement()` when `faceSrc` is set.

For universal faces, three style params tune the composite (with explicit
fallbacks because they are not declared in `CONTROL_PARAMS` for these types):

| Param | Default | Effect |
|---|---|---|
| `faceFit` | `contain` | `backgroundSize`; `fill` maps to `100% 100%` |
| `faceOpacity` | `100` | Face layer opacity (÷100) |
| `faceHideBase` | `true` | Hides the base render **via `opacity: 0` only** — the box, layout, and pointer wiring stay live underneath |

> `faceHideBase` never uses `visibility`/`display: none`. Interactive display
> types (Spatial3D, WaveShaper) keep their drag listeners on `containerRef` while
> the face composites on top. When `faceSrc` is unset, every face branch is
> skipped and the wrapper output is byte-identical to a plain render — the
> load-bearing default-rendering contract.

## Layer stacking order

`InteractiveControl.wrapElement()` composites the layers in this DOM order (later
= visually on top):

1. **Container** — `baseStyle` + `cornerRadiusStyle` + the skin's `containerStyle`.
2. **Glow** (`glowDiv`) — the procedural glow engine.
3. **Base render** — the actual control component, wrapped in an `opacity: 0` div
   when a universal face is shown with `faceHideBase`.
4. **Face** (`zIndex: 1`) — full-cover `faceSrc` background, `pointerEvents: none`,
   `borderRadius: inherit`.
5. **Skin overlays** (`zIndex: 2`) — each `overlayStyles` entry.
6. **Texture** — full-cover overlay with `mixBlendMode = textureBlendMode`, last
   in the DOM so it sits above the skin.

## How textures, skins, and faces travel

All three visuals are plain fields on `UIElement` (or, for textures, entries in
`textures[]`), so they serialize whole with the project on every save path —
autosave, project save, `.gan`, and VST3 bundle.

| Destination | What carries the visuals | Texture pixel handling |
|---|---|---|
| Autosave / project state | `elements[]`, `textures[]`, `assets[]` in `data/sessions/latest.json` | Uploaded/generated textures stay as `/textures/<file>` refs; built-ins are data URLs |
| `.gan` bundle | `source/foundry-project.json` embeds `{ version, elements, canvasState, assets, textures, customModules }`; `params.js` sets `window.FOUNDRY_DESIGN` | See caveat below |
| VST3 data bundle | `ui/params.js` sets `window.FOUNDRY_DESIGN = { elements, canvasState, assets, textures }` | See caveat below |

> **Inlining caveat.** `buildVst3Ui()` (used by both the VST3 bundle and the
> `.gan`) passes texture/asset `url` fields through untouched. Fields that begin
> with `data:` are already inline and self-contained. Fields that begin with
> `/textures/` point at server-side files and are **not** inlined by this step — a
> later build stage must replace them with `data:` URLs for the bundle to be fully
> offline. The exported README repeats this warning. No network fetches happen at
> export time.

## Color and image helpers

| File | Function | Purpose |
|---|---|---|
| `src/lib/colorUtils.ts` | `getArchetype(variant)` | Maps a design-style variant name (e.g. `Skeuomorphic`, `Swiss Style`) to a canonical archetype (`Classic`, `Brutalist`, `Neumorphic`, `3D`, `Minimal`, `CellShaded`, `Modern`) |
| `src/lib/colorUtils.ts` | `getDefaultColors(variant)` | Per-archetype default `base`/`active`/`text`/`border` colors used when an element leaves them unset (feeds skin tinting) |
| `src/lib/imageUtils.ts` | `removeImageBackground(url, tolerance, targetColorHex?, feathering?)` | Chroma-key background removal for **Image assets** — clears pixels within `tolerance` color distance of a target (default: the top-left pixel), with optional alpha feathering; returns a PNG data URL |

`removeImageBackground` backs the Image element's `imageModifiers` (removeBg,
tolerance, feathering, targetColor) — it is an asset-processing helper, not part
of the control texture/skin path.

## A note on `orb-kit-skin`

`src/orb-kit-skin/` (the `GantasmoOrb` component plus `gantasmo-orb.css` and
`orb-chat.css`) is the visual theme for the **AI Assistant orb's chat UI**, loaded
by `AIAssistantOrb.tsx`. Despite the word "skin," it is unrelated to the control
material skins in `skins.ts` — it styles the assistant surface, not canvas
elements. See [foundry-overview.md](foundry-overview.md) for the assistant orb.

## Related sources feeding the libraries

- The **component extractor** can lift regions of a reference image and add them
  straight to the Texture Library (`ExtractorModal.onAddTextures`). See
  [component-extractor.md](component-extractor.md).

> Note: the component extractor is a newly added feature and is under active
> development at the time of writing; its texture-library sink exists and is wired
> into `App.tsx`, but expect its UI to keep changing.

## Operational notes

- **Built-ins are free and stable.** They regenerate identically every load and
  dedupe by id, so they never bloat autosave or drift.
- **Uploaded textures are files; assets are inline.** Deleting a texture removes
  its `data/textures/` file via `DELETE /api/textures/:id`; deleting an asset just
  drops it from state.
- **A missing texture file degrades quietly.** If a `/textures/<id>` file is gone,
  the resolved URL is empty and the control renders without the overlay — no
  crash. Result thumbnails hide themselves on image load error.
- **SD must be configured and running** before an SD-tab generation will fire;
  the modal blocks and shows why. Cloud tabs need a server-configured key or a
  per-request override.
- **Before exporting a fully offline bundle,** confirm no texture/asset URL still
  begins with `/textures/` — those must be inlined as `data:` URLs (see the
  inlining caveat above).
