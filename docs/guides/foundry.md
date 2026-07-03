# VST Foundry — Plugin UI Builder Guide

Reference for theDAW's **Foundry** tab: a visual builder for audio-plugin and
web-audio interfaces. You lay out knobs, sliders, meters, and artwork on an
infinite canvas, style them, optionally let an AI co-designer drive the canvas,
then export production-ready React/TSX or JSON. Plain descriptions of what each
piece does.

Foundry is a vendored standalone app (VST UI Foundry) embedded inside theDAW. It
runs as a small Node sidecar and shows up as a regular center tab — you do not
launch or manage it separately.

## Opening Foundry

Click the **Foundry** tab in the center tab bar (the hammer icon, alongside MAKE,
MIX, DJ, and the other center tabs). theDAW starts the sidecar on demand and
embeds it in the tab. The first time you open it after a fresh install, the
sidecar installs its own dependencies before the canvas appears, so expect a
brief one-time wait; subsequent opens are immediate. A header strip above the
canvas has a **Reload** button and an **open-externally** button if you want
Foundry in its own browser tab.

## The workspace

Foundry's layout is a left sidebar, the canvas in the middle, and a right panel,
with a toolbar across the top.

### Component sidebar (left)

The left sidebar has two parts you can toggle independently:

- **Categories** — the palette of element types you drag onto the canvas: Knob,
  Slider, Button, Toggle, Meter, Waveform, XY Pad, ValueBox, Label, Image,
  Group, and **CustomCode** (a sandboxed frame that runs your own JS).
- **Explorer** — browses your saved sessions, generated textures, and media
  assets stored on disk so you can reuse them across projects.

### Canvas (center)

The canvas is an infinite, pannable, zoomable surface where your interface
lives. Drag elements in from the Categories palette, then move, resize, and
select (or multi-select) them. Optional **rulers** and a **grid overlay** help
you place things, and **snap-to-grid** keeps elements aligned to a configurable
grid size. A procedural glow engine and a texture/blend-mode system let you give
controls a skeuomorphic or modern look.

### Layers panel and properties panel (right)

- **Layers** — lists every element with its stacking order; use it to reorder,
  show/hide, and pick elements that overlap on the canvas.
- **Properties** — edits the selected element's position, size, style, glow,
  textures, and behavior. Global theme and font-scale controls live here too.

### Header toolbar

The toolbar across the top gathers the workspace actions:

- **Sidebar toggles** — show/hide the Categories panel, the Explorer panel, the
  whole left sidebar, and the right panel.
- **Rulers / Grid / Snap** — checkboxes for the canvas guides, plus a grid-size
  field.
- **Undo / Redo** — full history (Ctrl+Z / Ctrl+Shift+Z).
- **Background image** and **Clear canvas**.
- **Demo Mode / Edit Mode** — flip between editing the layout and interacting
  with the live controls to preview how the UI behaves.
- **Project Library / Save / Download JSON** — open, save, and export projects.
- **Export Code** and **Export Package** — see *Exporting* below.
- **Settings** — theme, canvas size, AI provider keys, and Stable Diffusion
  paths.

## The AI Assistant orb

A floating **AI Assistant** orb sits over the canvas. Open it to chat with an AI
co-designer that has direct control of your layout — it can add, move, style,
align, theme, and delete elements, fetch a reference web page, and take canvas
screenshots to inspect alignment and palettes visually.

The assistant is **bring-your-own-key**: pick a provider in Settings and paste
your own API key for it. Supported providers include OpenAI, Anthropic, Google
Gemini, xAI Grok, Groq, and OpenRouter (cloud, key required), plus Ollama and
LM Studio (local, no key). Models are discovered per provider at runtime, so the
model list stays current without app updates.

## AI texture and image generation

Foundry can generate textures and artwork to skin your controls and backgrounds,
then layer them with blend modes (Multiply, Screen, Overlay, and so on). Two
paths, both optional:

- **Local Stable Diffusion** — point Foundry at your own Automatic1111/Forge or
  ComfyUI install in Settings; it launches and manages the process for you and
  cleans it up when the app closes. Supports generate, img2img/inpaint, upscale,
  variations, batch, and ControlNet.
- **Cloud image generation** — DALL-E (OpenAI) or Gemini image generation, using
  the matching provider API key.

None of this is required: the rest of Foundry works without any image backend.

## Exporting

When the layout is ready, the toolbar offers three outputs:

- **Export Code** — export the canvas as **React/TSX** components or as **JSON**
  canvas data.
- **Export Package** — a **ZIP** bundle (`project.json` + assets + a README) for
  dropping into a JUCE plugin (via WebView) or a web-audio project.
- **Download JSON / Save** — save the raw project for later editing; sessions and
  assets also persist on disk under Foundry's own `data/` folder.

## Operational notes

- Foundry runs as a **Node sidecar on port 5472**, started on demand the first
  time you open the tab. theDAW manages its start and stop — it is shut down
  cleanly when the backend exits, and a fresh `theDAW.bat` launch clears any
  stale process on the port.
- **First launch installs dependencies.** If `node_modules` is missing, the
  sidecar runs `npm install` before serving, which is the one-time wait you see
  on a fresh clone. Node.js (already a theDAW prerequisite) must be on PATH.
- If the tab shows "VST Foundry did not start," see the
  [Windows troubleshooting guide](../windows/troubleshooting.md); the
  `/api/foundry/status` endpoint reports the project path, port, and any issues.
</content>
</invoke>
