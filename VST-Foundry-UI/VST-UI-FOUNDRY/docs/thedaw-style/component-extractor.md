# Component Extractor — From Screenshot to Controls

Reference for Foundry's **Component Extractor**: the workspace that turns one flat
UI reference image — a plugin faceplate screenshot, a render, a mood board — into
separate labeled cutout components, and optionally into real interactive controls.
It segments the picture with vision AI, crops each region, removes its background,
and drops the result into Foundry's asset, texture, layer, or control sinks. This
page covers both the integrated extractor built into Foundry and the standalone
AI-Studio app it was ported from, and how the two relate. Plain descriptions of
what each piece does.

The extractor exists in two forms:

- The **integrated extractor** inside Foundry (`src/components/extractor/`,
  `src/lib/extractor/`, `server/extract.ts`) — the version you use day to day.
- The **standalone app** (`component-extractor/`) — a self-contained
  Express + Vite AI-Studio project that the integrated version was ported from.
  It is kept in the tree as the reference implementation and porting guide.

For where extracted cutouts go afterward, see
[textures-and-skins.md](textures-and-skins.md) and
[canvas-and-controls.md](canvas-and-controls.md). For where the Gemini key is
configured, see [assistant-and-mcp.md](assistant-and-mcp.md).

## The two implementations at a glance

Both run the same four-stage pipeline and share the same prompts and JSON
schemas. They differ in how they talk to Gemini and where the results land.

| | Integrated (Foundry) | Standalone (`component-extractor/`) |
|---|---|---|
| Source image | `canvasState.backgroundImage` (no internal file picker) | Its own upload |
| Server | Foundry's Express server on port **5472** | Own Express + Vite server on port **3000** |
| Gemini call | Plain REST `fetch` (no SDK), same pattern as `sd.ts` | `@google/genai` SDK (`GoogleGenAI`) |
| Endpoints | `/api/extract/detect`, `/api/extract/label` | `/api/detect`, `/api/label-crop`, `/api/models` |
| Element type | `ExtractedElement` | `UIElement` |
| Manual draws | Queue as `pending` (batched by **Process Pending**) | Auto-processed immediately |
| Outputs (sinks) | Assets, Textures, Layers, **Controls** | Save / Save All (ZIP) only |
| `@imgly` load | Dynamic `import()` (keeps ~40 MB WASM off the bundle) | Static import |

> The prompts and response schemas in `server/extract.ts` (`DETECT_SCHEMA`,
> `LABEL_SCHEMA`, `detectPrompt`, `labelPrompt`) are copied **verbatim** from the
> standalone `component-extractor/server.ts` — the proven working set. When you
> change one, change the other to keep them in sync.

> The element interface was renamed from the standalone's `UIElement` to
> `ExtractedElement` during the port because Foundry already defines its own
> `UIElement` type (its canvas element). The fields are otherwise identical.

## The extraction pipeline

Both implementations run the same four stages. Steps 1 and 4 are AI calls to
Gemini through the backend; steps 2 and 3 are pure client-side `<canvas>` work.

1. **Auto-Detection (AI).** The full image is sent to Gemini, which returns
   normalized `[0..1]` bounding boxes `{ label, type, xmin, ymin, xmax, ymax }`
   for every UI element it can find.
2. **Cropping (canvas).** For each box, `extractCrop()` slices the source image
   with the Canvas API into a PNG data URL.
3. **Cutout (canvas + AI + WASM).** The crop's background is removed, leaving the
   isolated control. Cutout is attempted in this order:
   - **AI polygon mask** — `applyPolygonMask()` clips the crop to the tight
     foreground polygon Gemini returned during labeling.
   - **`@imgly/background-removal` fallback** — only when no polygon is
     available. Runs entirely in-browser on a ~40 MB WASM model downloaded once.
   - **Trim** — `trimTransparentPixels()` scans the alpha channel (threshold
     `alpha > 5`), crops to the tightest opaque box, and tightens the element's
     normalized bounds accordingly.
4. **Analysis (AI).** Each crop is sent back to Gemini for a `label`,
   `description`, `type`, `tags`, `group`, `shape`, and the polygon used in
   step 3.

```
detect (AI)  →  crop (canvas)  →  cutout: polygon mask → @imgly fallback → trim  →  label (AI)
```

> The `@imgly/background-removal` model (~40 MB of WASM) downloads on the first
> cutout and is cached afterward, so the first background-removal pass is slow
> and later ones are fast. Integrated Foundry imports it dynamically so that
> weight never lands in the initial bundle.

## Opening the extractor (integrated)

Click **Extract Components** (the Scissors icon) in the Foundry header, next to
the background-image controls. `App.tsx` wires the button to `setIsExtractorOpen`
and renders `ExtractorModal` with `sourceImage={canvasState.backgroundImage}`.

The background image is the **sole input** — Foundry already owns background
upload, so the extractor reuses it instead of adding its own file picker. With no
background, the workspace shows *"Upload a background image on the canvas
first."* and there is nothing to detect.

> The workspace **survives close and reopen**: captured elements, cutouts, and
> settings persist while the modal is closed. State only resets when the
> background image itself changes, because every element's bounds are relative to
> that image (`ExtractorModal` watches `sourceImage` via `prevSourceRef`).

## Capturing regions

Three capture methods, mixable freely on one image.

| Method | How | Result |
|---|---|---|
| **Auto Detect** | Click **Auto Detect** (Wand icon). | Vision AI returns a bounding box per element; each lands as status `detected`. The source is downscaled to ≤ **2048 px** on the longest side (`drawDownscaledDataUrl`) before base64 — bounds stay normalized so nothing downstream changes. |
| **Manual rectangle** | Drag a box on the image. | Captures exactly that region as status `pending`. |
| **Lasso** | Toggle **Lasso** (PenTool icon) or hold **Alt** while dragging, then trace a freeform outline. | Yields a **polygon cutout** (`displayMode: "cutout"`) instead of a plain rectangle; the lasso points are converted to crop-relative coordinates and applied with `applyPolygonMask`. |

The capture surface is `ExtractCanvas`, which draws boxes over the background
image, renders existing elements as overlays, and reports normalized coordinates
back to the modal via `onDrawBox`. A drag under 5 px in either dimension is
ignored.

> Integrated Foundry deliberately does **not** auto-process a manually drawn box.
> It queues as `pending` so you can capture several regions and process them in
> one batch — the original standalone app ran the full AI pipeline on every box
> the instant you drew it, hammering the API. The standalone still behaves that
> way (`processElement(newElement)` fires inside its `handleManualDraw`).

### Sensitivity

The **Sensitivity** slider (0–100 %, stored `0..1`, step `0.05`) tunes both AI
stages by injecting text into the prompts — it changes no client math.

| Sensitivity | Detection (`detectPrompt`) | Cutout tightness (`labelPrompt`) |
|---|---|---|
| High (> 0.7) | "Be extremely aggressive and detect even the smallest or faintest elements." | Polygon hugs the object very closely, cutting aggressively. |
| Middle | "Use a balanced threshold for detection." | Polygon hugs the object closely. |
| Low (< 0.3) | "Be conservative and only detect the most obvious, distinct, large elements." | Polygon is slightly loose so nothing gets clipped. |

Set sensitivity **before** running Auto Detect or Process Pending — it feeds the
prompt on each call.

## Processing captured regions

Captured regions sit in the tray marked *"Waiting to process…"*. Click
**Process Pending** to run the pipeline on every waiting region sequentially
(`pending` and `detected` states). Each element walks the status ladder:

```
pending / detected  →  processing  →  labeled
```

`processElement()` performs: label + AI polygon cutout → `@imgly` fallback (only
if no polygon cutout) → `trimTransparentPixels`, then writes back the label,
type, tags, group, shape, tightened bounds, and `displayMode: "cutout"`.

### Per-card Redo

Each labeled card has its own sensitivity slider and a **Redo** button. Redo
re-runs the whole pipeline on that one element at the card's sensitivity (which
defaults to the global toolbar value). It re-crops the source at the element's
**current** bounds, clears the old cutout/mask/polygon, resets it to `pending`,
and processes it fresh — useful when the first pass produced a bad cutout or a
wrong label.

## The tray and display modes

Every capture is a card in the **Captured Assets** tray (`ExtractTray`, rendered
newest-first). Each card carries three display modes; the active one decides
which image every sink and export uses.

| Mode | Image | Notes |
|---|---|---|
| **Rect** | `cropDataUrl` | The raw rectangular crop. Always available. |
| **Auto** | `cutoutDataUrl` | The AI/`@imgly` background-removed cutout. Disabled until a cutout exists. |
| **Mask** | `maskDataUrl` | A hand-painted mask (see below). Selecting it opens the mask editor. |

Precedence when a sink resolves an element's image is **mask > cutout > crop**.

Card controls: an editable **label** field, the detected **group** and **tags**,
a **Control type** select (for Make-Control, below), the Redo slider, a
per-card **Delete**, and the four per-card sinks (Design / Tex / Control / Save).

## Mask editor

Selecting **Mask** opens `MaskEditor`, a brush canvas overlaid at `z-60`. It
paints a separate white mask canvas and composites it onto the image with
`destination-in` (keep pixels where the mask is opaque).

| Tool | Compositing | Effect |
|---|---|---|
| **Add** | `source-over`, white | Reveals pixels (paints the mask opaque). |
| **Remove** | `destination-out` | Erases pixels (paints the mask transparent). |

The **Brush Size** slider runs 1–100 px. **Save Mask** exports the composited
result as a PNG data URL and stores it as the element's `maskDataUrl` with
`displayMode: "mask"`.

## Design sinks

The extractor gets assets out in seven ways. "Labeled" actions apply to every
card in the `labeled` state; per-card actions apply to one card and use its
current display mode.

| Action | Where | Result |
|---|---|---|
| **Save** | Per card | Downloads that asset as a PNG using its current display mode. |
| **Save All** | Tray header | Downloads `assets.zip` (JSZip) — one PNG per asset plus `metadata.json`. Duplicate labels get an index suffix so nothing overwrites. |
| **Add All as Assets** | Tray header | Adds every labeled cutout to the Foundry **Asset library** (`onAddAssets`). |
| **Add All as Textures** | Tray header | Uploads each cutout and adds it to the **Texture Library** (`onAddTextures`). |
| **Place All as Layers** | Tray header | Adds the assets **and** places them on the canvas as Image layers at their original coordinates. |
| **Place All as Controls** | Tray header | Promotes each labeled cutout to a native interactive control wearing the cutout as its face. |
| **→ Design** / **Tex** / **Control** | Per card | The single-card forms of Place as Layer, Add as Texture, and Make Control. |

`metadata.json` (inside `assets.zip`) is an array of `{ id, label, type, group,
tags, bounds:{ xmin, ymin, xmax, ymax } }`.

### Placing layers

`PlacedLayer` bounds are normalized. `App.handleExtractorPlaceLayers` scales them
onto the canvas with `boundsToCanvasRect(bounds, canvasState)`. Because the
background sets `canvasState.width`/`height` to its own natural dimensions on
upload, a placed layer lands exactly where the component sat in the original
image. `boundsToCanvasRect` clamps degenerate boxes to a 1 px minimum.

### The texture sink

`handleAddAsTextures` calls the shared `uploadCutout` helper for each element:
it converts any blob URL (an `@imgly` cutout) to a data URL, then
`POST`s `/api/textures/upload` to obtain a durable `/textures/<id>` URL on disk
that outlives blob-URL revocation. When the upload fails it falls back to the
inline data URL. The durable id is recovered from the returned URL so the texture
keeps the same on-disk identity its DELETE route matches against.

### Make Control (image-faced controls)

`handleMakeControls` promotes a cutout into a **real interactive control** that
wears the image as its `faceSrc`. Each card's **Control type** select chooses the
target `ElementType`; the modal uploads the cutout through the same
`uploadCutout` helper for a durable face URL, then places a `PlacedLayer` carrying
`controlType` + `faceUrl`.

`App.handleExtractorPlaceLayers` then branches: a `controlType` other than
`Image` spawns a native control (`faceSrc = faceUrl ?? asset.url`, `value: 50`)
rather than an `assetId`-backed Image layer.

> The default control type comes from `defaultControlType`, which looks the
> detected type up in `ELEMENT_TYPE_ALIASES` and defaults to **`Image`** — not
> `Knob` — when there is no alias match. `normalizeElementType` alone falls back
> to `Knob`, which would misfile a logo or graphic as a knob; a graphic with no
> control meaning stays an `Image`. Any of Foundry's 17 `ELEMENT_TYPES` can be
> chosen per card.

Once placed, a Make-Control element is a normal Foundry control: it can be bound,
restyled, and saved to the Arsenal from its properties panel. See
[canvas-and-controls.md](canvas-and-controls.md).

## Provider, key, and model

The integrated extractor uses **Gemini** for both detection and labeling and
shares Foundry's existing provider configuration — there is no separate setup.

- **API key** — read from `localStorage` under `LS_PROVIDER_KEYS`
  (`"vst-foundry-provider-api-keys"`), the same store the AI Assistant orb uses.
  If no in-app key is present, the server falls back to its `GEMINI_API_KEY`
  environment variable. There is no key field in the extractor.
- **Model** — the toolbar **Model** dropdown is fetched live from
  `/api/assistant/models/gemini`; the default is taken from the `gemini` entry of
  `/api/assistant/providers`. Nothing is hardcoded — whatever Gemini models your
  key exposes are what you can pick.

> The server requires an explicit model: `validateExtractBody` returns
> `400 "model required"` when the request body has none. The standalone
> `server.ts` instead defaults its request-body `model` to a Gemini id when one
> is omitted.

## Backend endpoints

### Integrated (Foundry server, port 5472)

`server/extract.ts`, registered via `registerExtractRoutes(app)` **after** the
CORS middleware so it inherits the origin lock. Plain REST against
`https://generativelanguage.googleapis.com/v1beta`, 120 s abort timeout.

| Method / path | Purpose | Body | Errors |
|---|---|---|---|
| `POST /api/extract/detect` | Detect every element → normalized bboxes | `image, mimeType, sensitivity, apiKey, model` | `400` bad input / no key, `403` foreign Origin, `502` Gemini failure |
| `POST /api/extract/label` | Label + polygon trace for one crop | same | same |

Validation (`validateExtractBody`): `image` and `mimeType` required; `mimeType`
must match `image/(png|jpe?g|webp)`; `model` required; a Gemini key must resolve
(request body first, env fallback); `sensitivity` clamped to `0..1`.

> The `/api/extract` routes only exist after a **Foundry server restart**
> following install. The frontend workspace loads immediately, but detect/label
> calls **404 until the server is relaunched**. This is the one known
> install-time caveat; see [troubleshooting.md](troubleshooting.md).

### Standalone (`component-extractor/server.ts`, port 3000)

Uses the `@google/genai` SDK. Serves the Vite dev middleware in development and
the built `dist/` in production. JSON body limit 50 MB.

| Method / path | Purpose |
|---|---|
| `POST /api/detect` | Detect bboxes for a full image |
| `POST /api/label-crop` | Label + polygon trace for one crop |
| `POST /api/models` | List available Gemini models via the SDK pager |

## Response schemas

Shared by both implementations (`DETECT_SCHEMA` / `LABEL_SCHEMA` in
`server/extract.ts`, `Type.*` equivalents in `server.ts`).

**Detect** — an array of:

| Field | Type | Meaning |
|---|---|---|
| `label` | string | Descriptive name (e.g. "Reverb Knob") |
| `type` | string | Element type (knob, button, panel, display, …) |
| `xmin, ymin, xmax, ymax` | number | Normalized `0.0–1.0` bounding box |

**Label** — one object:

| Field | Type | Meaning |
|---|---|---|
| `label` | string | Short label |
| `description` | string | What the element does |
| `type` | string | Control type |
| `tags` | string[] | Descriptive tags (e.g. `knob`, `metal`, `red`) |
| `group` | string | Suggested logical group (e.g. "Delay Controls") |
| `shape` | string | General foreground shape (circle, rectangle, …) |
| `polygon` | `[x,y][]` | Tight foreground outline in normalized coordinates, used for the cutout |

## Data shapes (frontend)

`ExtractedElement` (`src/lib/extractor/types.ts`) — one captured region:

| Field | Purpose |
|---|---|
| `id, label, type, description, tags, group, shape` | Identity + AI metadata |
| `xmin, ymin, xmax, ymax` | Normalized bounds (tightened by trim) |
| `polygon` | AI foreground outline |
| `cropDataUrl` | Raw rectangular crop |
| `cutoutDataUrl` | Background-removed cutout |
| `maskDataUrl` | Hand-painted mask |
| `displayMode` | `"rect" \| "cutout" \| "mask"` |
| `status` | `"pending" \| "detected" \| "processing" \| "labeled"` |

`PlacedLayer` (`ExtractorModal.tsx`) — a cutout mapped back onto the source for
placement: `{ asset, bounds{xmin,ymin,xmax,ymax}, label, type?, controlType?,
faceUrl? }`. `controlType` and `faceUrl` are set only by Make Control.

## Blob-URL ownership

The `@imgly` fallback creates blob URLs (`URL.createObjectURL`). The integrated
modal fixes a leak the original had by tracking every owned blob URL in
`blobUrlsRef`:

- Revoked on element delete, on background-image reset, and on unmount.
- **Ownership is handed to the design** when a cutout is placed as an asset or
  control — the URL is removed from `blobUrlsRef` so the modal's cleanup sweep
  never revokes a URL the canvas still renders.
- An intermediate `@imgly` blob URL orphaned by a subsequent trim is revoked
  immediately.

## File map

### Integrated (inside Foundry)

| File | Role |
|---|---|
| `src/components/extractor/ExtractorModal.tsx` | Orchestrator modal: pipeline, blob-URL ownership, the four sinks |
| `src/components/extractor/ExtractCanvas.tsx` | Draw / lasso capture surface over the background image |
| `src/components/extractor/ExtractTray.tsx` | Captured-asset tray: per-card refine + Asset/Texture/Control/Layer buttons |
| `src/components/extractor/MaskEditor.tsx` | Brush mask editor (Add/Remove, `destination-in`) |
| `src/lib/extractor/types.ts` | `ExtractedElement` interface |
| `src/lib/extractor/utils.ts` | `extractCrop`, `trimTransparentPixels`, `applyPolygonMask`, `generateId` |
| `src/lib/extractor/mapping.ts` | `boundsToCanvasRect` — normalized bounds → canvas pixel rect |
| `src/lib/extractor/mapping.test.ts` | Vitest for scaling/clamping |
| `server/extract.ts` | `/api/extract/detect` + `/api/extract/label` (Gemini REST) |
| `src/server.extract.test.ts` | Validation + origin-lock tests for the backend routes |
| `src/App.tsx` | Wires the modal + sinks (`handleExtractorAddAssets`, `handleExtractorPlaceLayers`, textures) |

### Standalone (`component-extractor/`)

| File | Role |
|---|---|
| `server.ts` | Express + Vite server: `/api/detect`, `/api/label-crop`, `/api/models` (SDK) |
| `src/App.tsx` | Root orchestrating upload, detect, process, tray, mask editor |
| `src/types.ts` | `UIElement` interface (source of the ported `ExtractedElement`) |
| `src/lib/utils.ts` | `extractCrop`, `trimTransparentPixels`, `applyPolygonMask` helpers |
| `src/components/CanvasArea.tsx` | Draw / lasso capture surface |
| `src/components/AssetTray.tsx` | Captured-asset tray |
| `src/components/MaskEditor.tsx` | Brush mask editor |
| `INTEGRATION_GUIDE.md` | Guide for porting the technique into an existing app |
| `package.json` | Deps: `@google/genai`, `@imgly/background-removal`, `jszip`, `file-saver`, `lucide-react` |

## The standalone app

`component-extractor/` is a complete AI-Studio project you can run on its own. It
is the origin of the integrated version and doubles as living documentation of
the technique (`INTEGRATION_GUIDE.md`).

```bash
cd component-extractor
npm install
npm run dev        # tsx server.ts → http://localhost:3000
```

It differs from the integrated version in the ways listed in
[The two implementations at a glance](#the-two-implementations-at-a-glance): its
own upload, the `@google/genai` SDK, a `/api/models` list endpoint,
immediate processing of manual draws, and Save / Save-All (ZIP) as its only
outputs — it has no concept of Foundry's asset, texture, layer, or control sinks.

`INTEGRATION_GUIDE.md` documents the four-stage technique and the exact
`extractCrop` / `removeBackground` / schema code used when porting it into a
full-stack React + Express app, which is how the integrated extractor was built.

## Operational notes

- **Restart after install.** The `/api/extract/detect` and `/api/extract/label`
  routes go live only after a Foundry server relaunch; they 404 until then.
- **Empty state.** With no canvas background image, the workspace shows a prompt
  to upload one — the background is the extractor's only input.
- **First cutout is slow.** The `@imgly` background-removal WASM (~40 MB)
  downloads once on first use and is cached afterward.
- **Model dropdown empty?** The list is fetched live from
  `/api/assistant/models/gemini`; confirm the Gemini key set in the AI Assistant
  orb is valid. See [assistant-and-mcp.md](assistant-and-mcp.md).
- **Detection or processing fails.** A missing or invalid Gemini key returns
  `400` with a message about the key; a Gemini-side error returns `502`. Set the
  key in the orb settings or `GEMINI_API_KEY` on the server. See
  [troubleshooting.md](troubleshooting.md).

## See also

- [foundry-overview.md](foundry-overview.md) — where the extractor fits in Foundry.
- [canvas-and-controls.md](canvas-and-controls.md) — the controls a cutout can become and how faces render.
- [textures-and-skins.md](textures-and-skins.md) — using extracted cutouts as textures and skins.
- [assistant-and-mcp.md](assistant-and-mcp.md) — where the Gemini provider key is configured.
- [troubleshooting.md](troubleshooting.md) — install-time and provider-key issues.
