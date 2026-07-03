# VST Foundry — Overview and Architecture

This is the entry-point reference for VST Foundry: what it is end to end, how the
pieces fit together, and where to read more. Foundry is a visual builder for
audio-plugin and web-audio interfaces — you lay out knobs, sliders, meters, and
artwork on a canvas, style and wire them, optionally let an AI co-designer drive
the canvas, then export a runnable plugin. This page maps the whole system: the
designer app, the `.gan` bundle format, the VST3 export path through the iPlug2
FoundryShell, the assistant, and how Foundry embeds inside theDAW. Every section
links to a sibling doc for depth. Plain descriptions of what each piece does.

## What Foundry is

Foundry is a single-page React app with a small Node/Express backend. It is a
*designer*, not a DAW: it produces plugin UIs and their parameter manifests, but
it hosts no audio graph of its own. A design is a flat list of absolutely
positioned UI elements over a canvas, plus assets (images), textures, saved
custom modules, and canvas state. From that design Foundry can emit several
export targets — React/TSX source, raw JSON, a self-contained ZIP, a `.gan`
web-plugin package, or a VST3 data bundle that a prebuilt native shell loads.

Foundry runs in two ways, from the same codebase:

| Mode | How it starts | Port | Who uses it |
|---|---|---|---|
| Standalone | `launch.bat` → `npm run dev` (tsx runs `server.ts`) | `5472` | Opening Foundry on its own in a browser |
| Embedded sidecar | theDAW spawns `npm run dev` as a subprocess and iframes it | `5472` | The **Foundry** center tab inside theDAW |

Both serve the same Express app; the health probe `GET /api/health` returns
`{"app":"vst-foundry","status":"ok",...}`, which is how theDAW confirms the
sidecar is really Foundry and not some other process squatting on the port. The
default port is `5472` (`server/config.ts`, overridable via `THEDAW_FOUNDRY_PORT`
or `PORT`).

> The legacy `README.md` says port `3000`. The code default is `5472`
> (`server/config.ts`). Where docs and code disagree, the code is authoritative.

## Architecture at a glance

```
                          ┌──────────────────────────────────────────────┐
                          │                Foundry (React SPA)            │
                          │                                               │
   Categories palette ───▶│  Canvas ──▶ InteractiveControl (dispatcher)   │
   drag element           │    │           renders 1 of 14 control comps  │
                          │    │           + glow / face / skin / texture  │
   Properties / Compact ──▶│  UIElement[]  (single design state)          │
   editors                │    │                                          │
   AI Assistant orb ──────▶│    │  ◀── tools mutate the same UIElement[]   │
                          │    ▼                                          │
                          │  src/lib exporters                            │
                          │   ├─ vst3Export.ts   → VST3 data bundle        │
                          │   ├─ ganExport.ts    → .gan package            │
                          │   └─ (React/TSX, JSON, ZIP)                    │
                          └───────┬───────────────────────┬───────────────┘
                                  │                       │
                    ┌─────────────▼──────────┐   ┌────────▼────────────────┐
                    │  .gan  (ZIP "GANv1")   │   │ VST3 data bundle         │
                    │  manifest.json         │   │ manifest.json + ui/      │
                    │  index.html + params.js│   │  loaded from Resources/  │
                    │  source/foundry-project│   └────────┬────────────────┘
                    └──────┬─────────────────┘            │
                           │                     ┌────────▼────────────────┐
                    ┌──────▼──────────────┐      │ FoundryShell.vst3        │
                    │ theDAW MIX / GANduit │      │ prebuilt iPlug2 WebView  │
                    │ iframes the runtime  │      │ plugin (native, C++)     │
                    └─────────────────────┘      └──────────────────────────┘

        theDAW backend                     theDAW frontend
        ┌───────────────────────┐          ┌──────────────────────────┐
        │ foundry/sidecar.py     │  spawn   │ FoundryView.tsx          │
        │  npm run dev (:5472)   │◀────────▶│  iframes /api/foundry/url │
        │ plugin/*  (.gan import)│          │ GanPluginStage / Ares    │
        └───────────────────────┘          └──────────────────────────┘
```

The single design state (`UIElement[]` plus canvas state, assets, textures, and
custom modules) is the hub. The palette, the property editors, the canvas
gestures, and the AI assistant all mutate that same array; every exporter reads
it. Because the design serializes whole, autosave, project save, and every
export path pick up new fields for free.

## The designer app

Foundry's window is a left sidebar (element palette + explorer), the canvas in
the middle, and a right panel (layers + properties), with a header toolbar on
top. See [canvas-and-controls.md](canvas-and-controls.md) for the full tour of
the canvas gestures, the control catalog, styling, routing, and the property
editors. The essentials:

- **Canvas** (`src/components/Canvas.tsx`) — an infinite, pannable, zoomable
  surface. It renders one `InteractiveControl` per element and owns selection,
  multi-select, drag, resize, rotate, snapping, rulers, grid, and the
  right-click context menu. Gesture math lives in pure, unit-tested helpers
  (`canvas/resizeMath.ts`, `canvas/snapMath.ts`) driven by
  `canvas/useCanvasGestures.ts`.
- **InteractiveControl** (`src/components/InteractiveControl.tsx`) — the central
  dispatcher. It picks the right render component by `el.type`, owns all
  interaction state (value, x/y, on, pressed, open, live wave value, live text),
  wraps every render in `wrapElement()` to paint glow, image-face, skin, and
  texture layers, and fans a control's normalized 0–100 value out to its routes.
- **Control components** (`src/components/controls/`) — 14 render components
  (Knob, Slider, Toggle, Button, Select, Label, Waveform, Meter, XYPad,
  Spatial3D, WaveShaper, Envelope, StepSequencer, Keyboard). Image and Group are
  handled by the canvas; CustomCode renders through a sandboxed iframe
  (`CustomCodeFrame.tsx`). Per-type adjustable parameters are declared in
  `controls/controlParams.ts`.
- **Panels** — `LayersPanel.tsx` (z-order), `PropertiesPanel.tsx` (full,
  collapsible) and `CompactElementProperties.tsx` (tabbed) editors,
  `AlignmentPanel.tsx`, `AssetManager.tsx` (images), `TextureManager.tsx`
  (skins/textures), and `EventLog.tsx` (a floating console over the server log
  plus captured client errors).

### Element types

`src/types.ts` `ELEMENT_TYPES` is the single source of truth; the `ElementType`
union is derived from it, so every iterator stays in sync. There are 17 types.

| Type | Kind | Exports a host param? |
|---|---|---|
| Knob | Rotary control | Yes — 1 continuous |
| Slider | Fader | Yes — 1 continuous |
| Meter | Level display (listen-driven) | Yes — 1 continuous |
| WaveShaper | Distortion-curve control | Yes — 1 continuous |
| Toggle | Switch | Yes — 1 boolean |
| Button | Push button | Yes — 1 trigger |
| Select | Dropdown | Yes — 1 enum |
| XYPad | 2-axis pad | Yes — 2 params (`-x`, `-y`) |
| Spatial3D | Radar / spatial pad | Yes — 2 params (`-x`, `-y`) |
| Envelope | ADSR editor | Yes — 4 params (attack/decay/sustain/release) |
| Label | Text / LCD readout | No |
| Image | Bitmap / artwork | No |
| Group | Container of elements | No |
| Waveform | Oscilloscope / LFO display | No |
| StepSequencer | Grid step pattern | No |
| Keyboard | Piano-key input strip | No |
| CustomCode | Sandboxed user JS | No element param; each numeric CustomParam becomes one continuous param |

The seven "No" types (Label, Image, Group, Waveform, StepSequencer, Keyboard,
and CustomCode itself) are the `SKIP_TYPES` in `vst3Export.ts` — they have no
single host-automatable scalar. CustomCode is special-cased before the skip
gate: each numeric CustomParam it declares becomes a continuous parameter.

## The AI assistant

A floating AI Assistant orb (`src/components/AIAssistantOrb.tsx`) sits over the
canvas. It is a co-designer with direct control of the layout — it can add,
move, style, align, theme, and delete elements, read the canvas, take
screenshots to inspect alignment visually, fetch a reference web page, and author
CustomCode elements. It is bring-your-own-key: providers and models are picked in
Settings, discovered per provider at runtime, so model lists stay current without
app updates. Foundry also ships a stdio MCP server (`mcp-server.cjs`) that
exposes the same tool surface to external MCP clients. See
[assistant-and-mcp.md](assistant-and-mcp.md) for providers, tools, effort/mode
selectors, and the CustomCode workflow.

> Legacy docs pin a specific Claude default model id. Model names drift; read the
> current default from the running app / provider list rather than trusting a
> doc. See [assistant-and-mcp.md](assistant-and-mcp.md).

## Export targets

When a design is ready, Foundry can emit any of the following. The two
plugin-grade targets — `.gan` and the VST3 bundle — share one parameter list, so
parameter ids never drift between a manifest and its UI.

| Target | Built by | What it is | Depth doc |
|---|---|---|---|
| React/TSX | `ExportModal.tsx` | Canvas as React components | [canvas-and-controls.md](canvas-and-controls.md) |
| JSON | `ExportModal.tsx` | Raw project state | [projects-and-data.md](projects-and-data.md) |
| ZIP package | `ExportModal.tsx` | `project.json` + assets + README | [projects-and-data.md](projects-and-data.md) |
| `.gan` | `src/lib/ganExport.ts` | theDAW web-plugin package | [gan-format.md](gan-format.md) |
| VST3 data bundle | `src/lib/vst3Export.ts` | Data half of a native VST3 | [vst3-export.md](vst3-export.md) |

### The `.gan` bundle

A `.gan` is theDAW's portable web-plugin package — a ZIP with the trailing
archive comment `GANv1`. Foundry writes four entries:

| Entry | Purpose |
|---|---|
| `manifest.json` | Plugin identity, `controls[]` (values the UI emits), `params[]` (host-drivable 0..1 inputs), canvas size |
| `index.html` | The standalone renderer with the inline `.gan` postMessage bridge injected (no sidecar bridge file needed) |
| `params.js` | The serialized design (`window.FOUNDRY_DESIGN`) the renderer reads |
| `source/foundry-project.json` | The full editable project (elements, canvas, assets, textures, custom modules) for lossless re-editing; theDAW/GANduit ignore it |

The manifest is fixed to `format:"gan"`, `format_version:1`, `kind:"controller"`
(effect/instrument are not supported by the web runtime), `author`/`company`
`GANTASMO`, `source:"vst-foundry"`. `controls[]` and `params[]` are both derived
from the same VST3 param list (`buildVst3Manifest`), so a control id in the
manifest matches exactly what the UI posts upward via
`{type:'updateValue', id, value}`. Because the manifest is the authoritative
check, some tools may strip the ZIP comment without breaking recognition. Full
schema, the round-trip re-editing path, and the bridge contract are in
[gan-format.md](gan-format.md).

### The VST3 data bundle and FoundryShell

A Foundry VST3 export is a *data bundle*, not a compiled binary. `vst3Export.ts`
produces `manifest.json`, `ui/index.html`, `ui/params.js`, and `README.txt`
(zipped via JSZip). The binary half is **FoundryShell**, a prebuilt native iPlug2
plugin under `vst3-shell/FoundryShell-src/` that loads the data bundle from its
VST3 `Contents/Resources/` directory at runtime.

| FoundryShell identity | Value (`config.h`) |
|---|---|
| Plugin name | `FoundryShell` |
| Manufacturer | `theDAW` |
| Unique id / mfr id | `'Fdsh'` / `'StDw'` |
| Version | `1.0.0` |
| Type | `0` (effect), VST3 subcategory `Fx` |
| Channel I/O | `2-2` (stereo in/out) |
| MIDI | in **and** out enabled; MPE off |
| Editor | WebView UI, `600x600` @ 60 fps, host-resizable |

The shell is a WebView plugin (WebView2 on Windows, WKWebView on macOS), not
IGraphics. At construction it resolves its Resources dir and calls
`LoadManifest`, initializing up to 128 iPlug2 params by kind
(continuous/boolean/trigger/enum); if the manifest is missing it falls back to a
single Gain param so the plugin always constructs. DSP is stereo passthrough plus
smoothed gain/pan, diffing param values to emit MIDI CC and executing bound
actions. Parameter binding, the CC pool (`20-31`, then `102-119`, then `64-119`;
the 128 cap is on parameter count, not CC numbers), the WebView bridge, and the
MSBuild build are covered in [vst3-export.md](vst3-export.md).

> The native shell build is mid-change. The checked-in
> `FoundryShell-src/projects/FoundryShell-vst3.vcxproj` references files not
> present in the tree (`config/FoundryShell-win.props`, `resources/resource.h`,
> `resources/main.rc`, `projects/packages.config`) and uses iPlug2-example-relative
> include paths, so a clean checkout cannot build the shell without the gitignored
> `iPlug2/` SDK clone and those missing files. Treat the prebuilt `FoundryShell.vst3`
> as the shipping artifact; see [vst3-export.md](vst3-export.md) for the current
> build state.

## How Foundry embeds in theDAW

theDAW hosts Foundry two independent ways, both documented in depth in
[thedaw-integration.md](thedaw-integration.md):

1. **The designer, as a live sidecar.** `backend/modules/foundry/sidecar.py`
   spawns `npm run dev` (cwd is this project) as a subprocess on port `5472`,
   passing `DISABLE_HMR=true` so Vite's HMR WebSocket does not spam the console.
   It installs `node_modules` first if missing, logs to
   `data/logs/foundry-sidecar.log`, and detects readiness via `/api/health`. The
   endpoints `GET /api/foundry/url|status` and `POST /api/foundry/start|stop`
   drive it; the frontend `FoundryView.tsx` fetches `/api/foundry/url` (retrying)
   and iframes the returned URL as a center-panel tab.
2. **Exported plugins, as runnable `.gan`s.** `backend/modules/plugin/` imports,
   packages, and serves `.gan` plugins (`/api/plugin/*`). Installed plugins live
   under `data/plugins/*.gan`, are extracted to `data/plugins/_runtime/<id>/`,
   and are iframed into the MIX stage (`GanPluginStage.tsx`). The bundled **Owl**
   and **Ares** surfaces are built this way; `aresBridge.ts` auto-wires an Ares
   `.gan`'s controls onto FX-chain params.

## Directory map

Root of `C:/Users/skream/projects/StableDAW/VST-Foundry-UI/VST-UI-FOUNDRY`:

| Path | What it holds |
|---|---|
| `server.ts` | Standalone entry: the fullstack dev server (Vite + Express) started by `npm run dev` |
| `server/` | Express backend modules (see below) |
| `src/` | The React SPA (see below) |
| `vst3-shell/` | Native iPlug2 FoundryShell sources + SDK clone (see below) |
| `component-extractor/` | Standalone vision-AI component extractor app (own Vite/Express) |
| `mcp-server.cjs` | stdio MCP server exposing the assistant's tools to external clients |
| `launch.bat` | Standalone launcher: verifies Node, installs deps, runs `npm run dev` |
| `package.json` | Deps + scripts (`dev`, `build`, `start`, `lint`, `test`) |
| `docs/` | Documentation (legacy guides + this `thedaw-style/` set) |
| `data/` | Gitignored local state: config, sessions, textures, generated, logs |
| `deprecated/` | Archived files (never deleted, moved here) |
| `dist/` | Build output |
| `scripts/` | Tooling (`verify-providers.mjs` — LLM provider health check) |
| `stt/`, `research/` | Speech-to-text assets, research notes |
| `DOCUMENTATION.md`, `README.md` | Legacy architecture reference + project overview (mining material; code wins on conflict) |

`src/` (the SPA):

| Path | What it holds |
|---|---|
| `App.tsx`, `main.tsx` | App shell and React entry |
| `types.ts` | Single source of truth: `ELEMENT_TYPES`, `UIElement`, routes/bindings, `Asset`/`Texture`/`Annotation`/`CanvasState` |
| `components/` | Canvas, panels, modals, and top-level UI |
| `components/controls/` | The 14 control render components + `controlParams.ts`, `shared.ts` |
| `components/properties/` | `BindingPicker`, `ControlParamsSection`, shared `fields/`, `options.ts`, `useElementField.ts`, `rawEditor.ts` |
| `components/canvas/` | Gesture engine + pure `resizeMath.ts` / `snapMath.ts` + `AnnotationLayer.tsx` |
| `components/extractor/`, `orb/`, `texture-gen/`, `brand-title/` | Component-extractor UI, assistant orb, texture-gen modal, brand lockup |
| `lib/` | Core logic: `gan*.ts`, `vst3Export*.ts`, `vstBinds*.ts`, `routing.ts`, `skins.ts`, `proceduralTextures.ts`, `dawControlBus.ts`, `elementSignalBus.ts`, `arsenal.ts`, `customParams.ts`, `customCodeBridge.ts` |
| `hooks/` | `useAutosave`, `useHistory`, `useDawBindings`, `useKeyboardShortcuts`, `useProjectPersistence`, `useClipboard` |

`server/` (the Express backend):

| File | Role |
|---|---|
| `config.ts` | `PORT` (default `5472`) + CORS helpers |
| `routes.ts` | Route registration incl. `GET /api/health` (`{app:"vst-foundry"}`), state, config, logs, textures |
| `persistence.ts`, `paths.ts` | Session/config load-save and the `data/` layout |
| `claude-bridge.ts`, `providers.ts`, `relay.ts`, `tools.ts` | Assistant provider streaming, MCP relay, tool surface |
| `extract.ts` | Component-extractor endpoints |
| `sd.ts` | Stable Diffusion process management for texture generation |
| `net.ts`, `proc.ts`, `logging.ts` | URL scrape (SSRF-guarded), subprocess helpers, in-memory log ring |

`vst3-shell/`:

| Path | What it holds |
|---|---|
| `FoundryShell-src/config.h` | iPlug2 `PLUG_*` identity macros |
| `FoundryShell-src/FoundryShell.h/.cpp` | Plugin class + WebView host + passthrough DSP + MIDI |
| `FoundryShell-src/projects/` | MSBuild `.vcxproj` (v143, VST3 dynamic library) |
| `FoundryShell-src/resources/web/ui/` | Default fallback WebView UI (`index.html` + `foundry-bridge.js`) |
| `iPlug2/` | Full iPlug2 SDK clone (gitignored — never committed) |
| `nuget.exe` | Restores the WebView2 + WIL NuGet packages before the build |

## Stack and ports reference

| Piece | Value |
|---|---|
| Frontend | React 19, Vite 6, Monaco editor, Tailwind 4, `jszip` + `file-saver` |
| Backend | Express 5, run via `tsx` in dev |
| Tests | Vitest (`npm test` → `vitest run`) |
| Standalone / sidecar port | `5472` (`THEDAW_FOUNDRY_PORT` or `PORT` overrides) |
| Vite HMR WebSocket | `PORT + 1`; disabled when `DISABLE_HMR=true` (sidecar) |
| Health probe | `GET /api/health` → `{"app":"vst-foundry","status":"ok"}` |
| theDAW sidecar log | `data/logs/foundry-sidecar.log` |

```bash
# Standalone (from the project root)
launch.bat            # verify Node, install deps, then `npm run dev`
npm run dev           # tsx server.ts — Vite + Express on http://localhost:5472
npm run build         # vite build + esbuild the server to dist/server.cjs
npm test              # vitest run
```

## Where to go next

- [canvas-and-controls.md](canvas-and-controls.md) — the canvas, the 14 control
  types, styling, routing, and the property editors.
- [custom-code.md](custom-code.md) — the sandboxed CustomCode element and its
  postMessage bridge.
- [component-extractor.md](component-extractor.md) — vision-AI extraction of
  controls from a background image.
- [gan-format.md](gan-format.md) — the `.gan` package schema and round-trip.
- [vst3-export.md](vst3-export.md) — the VST3 data bundle and FoundryShell.
- [textures-and-skins.md](textures-and-skins.md) — the texture library, skins,
  and blend modes.
- [assistant-and-mcp.md](assistant-and-mcp.md) — the AI orb, providers, and MCP.
- [thedaw-integration.md](thedaw-integration.md) — the sidecar and the `.gan`
  plugin path inside theDAW.
- [projects-and-data.md](projects-and-data.md) — persistence, autosave, and the
  `data/` layout.
- [troubleshooting.md](troubleshooting.md) — common failures and fixes.
- [index.md](index.md) — the documentation index.
