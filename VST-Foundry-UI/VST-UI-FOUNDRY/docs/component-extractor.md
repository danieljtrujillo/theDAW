# Component Extractor

The Component Extractor turns a flat UI reference image into individual, reusable assets. Point it at the canvas background image and it segments and classifies the picture into separate UI components — knobs, buttons, sliders, meters, switches, displays, and panels — using vision AI. Each detected component becomes a labeled, tagged, background-removed cutout you can download, package, add to your Asset library, or drop straight onto the canvas as a positioned layer.

Use it when you have a screenshot or render of an existing plugin faceplate and want to rebuild it in Foundry without re-cropping every control by hand.

---

## Quick Start

1. Upload a **background image** to the canvas (the extractor works on the current background — there is no separate upload inside it).
2. Click **Extract Components** (the Scissors icon) in the header to open the extraction workspace.
3. Click **Auto Detect** to have the AI find every element, or drag rectangles on the image to capture regions by hand.
4. Click **Process Pending** to label, tag, group, and cut out each captured region.
5. Refine any asset in the right-hand tray, then **Add All as Assets** or **Place All as Layers**.

That's the whole loop. Everything below covers each stage in detail.

---

## Opening the Extractor

The extractor opens from the **Extract Components** button in the header (the Scissors icon), next to the background-image controls. It requires a background image on the canvas: with no background, the workspace shows *"Upload a background image on the canvas first."* and there is nothing to detect. The background image is the sole input — Foundry already owns background upload, so the extractor reuses it rather than adding its own file picker.

---

## Detecting Components

The extractor gives you three ways to capture regions of the image, and they can be mixed freely.

| Method | How | Notes |
|--------|-----|-------|
| **Auto Detect** | Click **Auto Detect** in the toolbar. | Vision AI returns bounding boxes for every element it finds. Large images are downscaled to 2048px on the longest side before analysis; coordinates are normalized, so nothing else is affected. |
| **Manual rectangle** | Drag a box directly on the image. | Captures exactly the region you draw. |
| **Lasso** | Toggle **Lasso** (or hold **Alt** while dragging), then trace a freeform outline. | Produces a polygon cutout instead of a plain rectangle. |

The three methods above capture loose regions. A fourth toolbar button, **Detect Modules** (the Boxes icon), instead captures whole titled *module panels* and the controls inside them — see [Detecting Modules](#detecting-modules).

### Sensitivity

The **Sensitivity** slider (0–100%) tunes how aggressive both detection and cutout tracing are:

- **High** — detects even small or faint elements, and traces cutouts that hug the object tightly.
- **Low** — detects only large, obvious elements, and traces looser cutouts so nothing gets clipped.
- **Middle** — a balanced threshold.

Set sensitivity **before** you run Auto Detect or Process Pending; it feeds the prompt on each call.

---

## Processing Captured Regions

Captured regions land in the tray marked *"Waiting to process…"*. Click **Process Pending** to run the full pipeline on every waiting region, one at a time:

1. **Label** — the AI names the element, assigns a control **type** (knob, button, switch, display, …), suggests descriptive **tags** and a logical **group**.
2. **Cutout** — it traces a tight polygon around the control and cuts the background away. When no clean polygon is available, it falls back to a generic background-removal pass.
3. **Trim** — transparent edges are trimmed, tightening the asset's bounds around the actual pixels.

Manually drawn boxes are queued rather than processed on the spot, so you can capture several regions and process them in one batch.

---

## Detecting Modules

**Detect Modules** (the Boxes icon in the toolbar) captures whole *module panels* — a titled group such as an "OSC 1" or "FILTER" section — instead of individual controls. It runs a **two-pass** detection:

1. **Panels** — the first pass asks the vision AI for the titled module panels in the image. Each one returns as a collapsible section in the tray, titled with the panel name and cut out as a backplate.
2. **Per-panel controls** — for every panel found, a second pass runs the same control detection Auto Detect uses, but *inside that panel's crop*, then maps each child's bounds back onto the source image and files it under the panel. Panels are scanned one at a time (a spinner marks the panel currently scanning), the same rate-limit-safe pattern as Process Pending.

The detected children land as ordinary captured assets tagged with the panel as their group, so you refine, re-label, and **Process Pending** them exactly like any other detection. Every control in a panel must finish processing (reach the *labeled* state) before that module can be placed.

### Module panel sections

Each panel is a **collapsible section** at the top of the tray, above the loose asset list. Its header shows the panel title, the member count, a scanning spinner while the second pass runs, a **Place Module** button, and a delete (**X**). Collapse a section to fold its member cards out of the way. Deleting a panel keeps its member controls — they drop back into the loose list as ungrouped assets, so nothing is thrown away.

### Place Module

**Place Module** drops the whole panel onto the canvas as one Foundry **Group**: the panel backplate becomes a **Frame** element wearing the panel crop as its face, and every member control is placed over it — each wearing its own cutout as its face, at its original offset inside the panel. Choose each member's target control type with the per-card **Control type** select before placing (a graphic with no control meaning stays an **Image**). The backplate crop and every child cutout also land in the Asset library.

Because the module is a real Group, you can select it, save it to the **Arsenal**, and drag that saved module into any project — backplate, controls, offsets and all.

> **Frames.** The backplate uses **Frame**, a decorative element type with its own **Frames** sidebar section. Frames come in *filled* backplate variants (Backplate, Screw Plate, Glass, Titled) that sit behind controls, and *hollow* trim variants (Border, Bezel) with a transparent center. Any extracted backplate becomes a Frame, and you can drag a fresh Frame straight from the sidebar the same way.

---

## Refining Assets

Every captured asset appears as a card in the **Captured Assets** tray on the right. Each card offers:

- **Display mode toggle** — switch how the asset renders and exports:
  - **Rect** — the raw rectangular crop.
  - **Auto** — the AI-generated background-removed cutout.
  - **Mask** — a hand-painted mask (see below).
- **Mask Assist** — selecting **Mask** opens a brush editor. Paint with **Add** / **Remove** modes and an adjustable **brush size** to refine exactly which pixels are kept. Save to store it as the asset's mask.
- **Editable label** — click the label field to rename the asset. Its group and tags are shown beneath.
- **Delete** — remove the asset from the tray.

The active display mode determines which image is used everywhere else: **mask** wins over **cutout**, which wins over the plain **crop**.

---

## Saving and Placing

You can get assets out of the extractor eight ways:

| Action | Where | Result |
|--------|-------|--------|
| **Save** (per card) | On each asset card | Downloads that single asset as a PNG, using its current display mode. |
| **Save All** | Tray header | Downloads `assets.zip` — one PNG per asset plus a `metadata.json` (id, label, type, group, tags, and normalized bounds). |
| **Add All as Assets** | Tray header | Adds every labeled asset to the Foundry Asset library, ready to apply like any uploaded image. |
| **Add All as Textures** | Tray header | Adds every labeled asset to the Texture Library, for applying onto UI elements (drag a texture onto any element). Uploaded to the server like other textures, with an inline fallback. |
| **Place All as Layers** | Tray header | Adds the assets *and* places them on the canvas as Image layers, positioned over the background at their exact original coordinates. |
| **→ Design** (per card) | On each asset card | Places that single asset onto the canvas as a positioned layer. |
| **Tex** (per card) | On each asset card | Adds that single asset to the Texture Library. |
| **Place Module** | Module panel header (per panel) | Places the whole module — the backplate as a **Frame** plus its member controls as face-wearing controls, at their original offsets — onto the canvas as one Foundry Group. See [Detecting Modules](#detecting-modules). |

Placed layers use each asset's normalized bounds scaled to the canvas dimensions. Because the background sets the canvas size on upload, placed layers land exactly where the component sat in the original image.

---

## Provider, Key, and Model

The extractor uses **Gemini** for both detection and labeling, and it shares Foundry's existing provider configuration — there is no separate setup:

- **API key** — the same Gemini key you set in the **AI Assistant settings** (stored in the browser). If no in-app key is present, the server falls back to its `GEMINI_API_KEY` environment variable. There is no key field in the extractor.
- **Model** — the **Model** dropdown in the toolbar is fetched live from the API. Nothing is hardcoded; whatever Gemini models your key exposes are what you can pick.

The first time the generic background-removal fallback runs, it downloads its model (~40MB WASM) once. Subsequent cutouts reuse it.

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|--------------|-----|
| Extract Components button does nothing / empty state | No background image on the canvas | Upload a background image first — it is the extractor's input. |
| Auto Detect or Process Pending fails | Missing or invalid Gemini API key | Set the Gemini key in the AI Assistant settings (orb), or configure `GEMINI_API_KEY` on the server. |
| Model dropdown is empty | Model list could not be fetched | Confirm the Gemini key is valid; the list is fetched live from the API. |
| First cutout is slow | One-time ~40MB WASM download for background removal | Wait for it to finish; later cutouts reuse the cached model. |
| Detection returns nothing after a fresh install | The `/api/extract` endpoints were not registered | Restart the Foundry server. The extraction endpoints go live only after a relaunch. |

> **Note:** After installing this feature, the `/api/extract/detect` and `/api/extract/label` endpoints require a **Foundry server restart** to become available. The frontend workspace loads immediately, but detection and labeling calls will 404 until the server is relaunched.

---

## See Also

- [AI Assistant Orchestrator](./ai-assistant.md) — where your Gemini API key is configured.
- [AI Texture Generation](./texture-generation.md) — generating new image assets instead of extracting existing ones.
- [Styling and Themes](./styling-and-themes.md) — applying extracted assets to elements once they're in the library.
