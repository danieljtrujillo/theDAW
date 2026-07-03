# Projects and Local Data — Persistence Model

Reference for how VST Foundry saves your work: where the current canvas lives,
how named projects are stored, what the on-disk `data/` folder holds, which
browser keys hold what, and exactly what survives a restart. This is the map for
anyone debugging "why did my layout come back / not come back," or deciding what
to back up. Plain descriptions of what each piece does. For opening/editing
`.gan` plugin bundles specifically, see [gan-format.md](gan-format.md); for the
VST3 data bundle, see [vst3-export.md](vst3-export.md).

Foundry stores state in three places at once: **browser IndexedDB** (via
`idb-keyval`), **browser localStorage**, and the **sidecar's on-disk `data/`
folder**. The working canvas is written to all of the durable stores on every
change, so a project outlives a tab close, a browser restart, or a sidecar
restart. Nothing here is a cloud service — everything is local to the machine.

## Where state lives at a glance

| What | Store | Key / path | Survives |
|---|---|---|---|
| Current working canvas (autosave) | IndexedDB + disk | `ui-modeler-autosave` and `data/sessions/latest.json` | Tab close, browser restart, sidecar restart |
| Named saved projects (Project Library) | IndexedDB | `ui-modeler-projects` | Same browser profile only |
| Arsenal (saved controls palette) | IndexedDB | `vst-arsenal` | Same browser profile; global across projects |
| Uploaded / generated texture files | Disk | `data/textures/` | Any restart; shared across projects |
| SD + app config | Disk | `data/config.json` | Any restart |
| Server log | Disk | `data/logs/app.log` | Any restart |
| AI provider / model / keys / effort | localStorage | `vst-foundry-*` | Same browser profile |
| Assistant chat history | localStorage | `vst-foundry-assistant-sessions` | Same browser profile |
| Sidebar component presets | localStorage | `vst-custom-presets` | Same browser profile |
| Element-to-element modulation signals | in-memory only | — | Nothing (runtime only) |

> The working canvas is the only thing written to *both* the browser and the
> disk. Everything else lives in exactly one place. That dual write is what lets
> the same project reappear even after clearing browser storage — the sidecar
> reloads it from `data/sessions/latest.json`.

## The on-disk `data/` tree

The sidecar defines its data tree in `server/paths.ts` and creates the folders
once, at import time, before anything reads or writes them. The root is always
`data/` **relative to the sidecar's working directory** (`process.cwd()`):

```
data/
  config.json          # SD paths, ports, image-gen prefs (AppCfg)
  config.json.bak       # last-known-good copy, written before each save
  sessions/
    latest.json         # server-side autosave of the full project state
    latest.json.bak     # last-known-good copy, written before each save
  textures/             # uploaded + AI-generated image files, served at /textures/<file>
  logs/
    app.log             # sidecar log
    app.log.1           # single rollover once app.log passes its size cap
```

| Path | Written by | Holds |
|---|---|---|
| `data/config.json` | `server/persistence.ts` (`saveAppCfg`) via `POST /api/config` | `{ sd: { preferred, a1111, comfyui, modelLibraryDir, outputDir } }` |
| `data/sessions/latest.json` | `server/routes.ts` (`POST /api/state`) | `{ elements, canvasState, assets, textures, customModules }` |
| `data/textures/` | `POST /api/textures/upload` and AI image generation (`server/sd.ts`) | `<uuid>.png` / `.jpg` / `.gif` / `.webp` image files |
| `data/logs/app.log` | `server/logging.ts` (`appendLog`) | Timestamped sidecar log lines |

> The whole `data/` tree is local and disposable. Deleting it resets Foundry to
> a blank canvas and default SD config; the code recreates the folders on next
> launch. It is safe to back up by copying the `data/` folder wholesale.

> Drift note: the legacy `docs/local-data.md` describes a separate
> `data/generated/` folder for AI images. In the current code, generated images
> are written into `data/textures/` alongside uploads (`server/sd.ts` writes to
> `TEXTURES_DIR`); there is no `generated/` directory.

### Config path in detail

`data/config.json` holds only Stable Diffusion / image-generation settings — it
is **not** where projects live. Its shape (`AppCfg` in `server/persistence.ts`):

| Field | Meaning |
|---|---|
| `sd.preferred` | `"a1111"` or `"comfyui"` — which local SD backend to use |
| `sd.a1111` / `sd.comfyui` | `{ execPath, port, autoStart, extraArgs, pythonPath }` per backend |
| `sd.modelLibraryDir` | Folder scanned for ComfyUI checkpoints |
| `sd.outputDir` | Optional image output override |

Ports default to `7860` (A1111) and `8188` (ComfyUI). See
[textures-and-skins.md](textures-and-skins.md) for the image pipeline.

## Browser storage: IndexedDB keys (`idb-keyval`)

Foundry uses the `idb-keyval` library for structured, larger-than-localStorage
data (projects can carry base64 background images and inline texture data URLs).

| Key | Written by | Holds |
|---|---|---|
| `ui-modeler-autosave` | `src/hooks/useAutosave.ts` | The live working canvas: `{ elements, canvasState, assets, textures, customModules }` |
| `ui-modeler-projects` | `src/hooks/useProjectPersistence.ts` | Array of `SavedProject` — the named Project Library |
| `vst-arsenal` | `src/lib/arsenal.ts` | Global saved-control palette; cross-project, never part of a project or export |

> The Arsenal (`vst-arsenal`) is deliberately *outside* the project model. A
> control you "Save to Arsenal" is available in every project and is never
> written into `ui-modeler-projects`, `latest.json`, or any export bundle. See
> [canvas-and-controls.md](canvas-and-controls.md) for how the Arsenal is used.

> None of the IndexedDB keys keep a `.bak` copy. Only the disk files
> (`config.json`, `latest.json`) are versioned. If IndexedDB is cleared, the
> working canvas is still recoverable from `data/sessions/latest.json`, but the
> named Project Library and the Arsenal are not — they exist only in the browser.

## Browser storage: localStorage keys

localStorage holds small preference strings and the assistant's own state. Keys
are defined in `src/components/orb/constants.ts` and a few component files.

| Key | Set in | Holds |
|---|---|---|
| `vst-foundry-provider` | `orb/constants.ts` | Selected AI provider id (default `claude`) |
| `vst-foundry-model` | `orb/constants.ts` | Selected model id (default `claude-opus-4-8`) |
| `vst-foundry-provider-api-keys` | `orb/constants.ts` | JSON map of `provider -> API key` |
| `vst-foundry-custom-api-key` | `orb/constants.ts` | Legacy single Gemini key; migrated into the keyed map on read |
| `vst-foundry-effort` | `orb/constants.ts` | Assistant effort level (default `max`) |
| `vst-foundry-assistant-sessions` | `AIAssistantOrb.tsx` | Chat session history (base64 images stripped to fit the ~5 MB quota) |
| `vst-custom-presets` | `Sidebar.tsx`, `CompactElementProperties.tsx` | Sidebar component presets |
| `vst-custom-code` | (legacy) `useProjectPersistence.ts` | Old sidebar-local CustomCode modules; **read once and migrated**, never written |
| (host-supplied) | `orb-kit-skin/GantasmoOrb.tsx` | Orb screen position, under a `persistenceKey` the host passes in |

> API keys live in browser localStorage, not on disk. They never leave the
> machine, but they are also not part of any project or export — moving a
> project to another browser/machine means re-entering keys. See
> [assistant-and-mcp.md](assistant-and-mcp.md).

> `vst-custom-code` is a one-way migration. On startup the persistence hook reads
> any legacy CustomCode modules from it, folds them into the unified
> `customModules` store, and from then on those modules ride along with the
> project (autosave / `latest.json` / `.gan`). It is never written back.

## Load order on startup

`useProjectPersistence` runs one mount-time load. It reads sources in priority
order and the first that has real content wins:

1. **Named projects** — read `ui-modeler-projects` from IndexedDB into the
   Project Library list (this is always loaded; it is separate from the canvas).
2. **Server state** — `GET /api/state` (returns `data/sessions/latest.json`). If
   the response has `elements` or `canvasState`, it is applied and the local
   autosave is skipped entirely. Server state takes priority over IndexedDB.
3. **Local autosave** — only if the server had nothing: read
   `ui-modeler-autosave` from IndexedDB and apply it.
4. **Legacy module migration** — `vst-custom-code` is read as a fallback source
   of `customModules` whenever the loaded state carries none of its own.

> Empty-response guard: an empty `{}` from the server does **not** wipe the
> canvas. The load only accepts server state when `serverState.elements ||
> serverState.canvasState` is present, so a fresh/empty sidecar cannot clobber a
> canvas that IndexedDB still holds.

All load paths call `clearHistory(newElements)` (not `setElements`), so undo
history starts clean after a load. The named-project load (`executeLoadProject`)
and the `.gan` import (`handleImportGanFile`) additionally call
`clearElementSignals()` so stale element-to-element modulation from the previous
document cannot bleed in. The mount-time startup load (server / autosave) does
not clear element signals — harmless there, since there is no prior document at
first mount.

## Autosave

The working canvas is persisted by `src/hooks/useAutosave.ts`. On any change to
`elements`, `canvasState`, `assets`, `textures`, or `customModules` it debounces
**400 ms**, then writes to **both** stores:

- `set("ui-modeler-autosave", state)` in IndexedDB.
- `POST /api/state` with the same payload (fire-and-forget; failures are silent
  so an unavailable sidecar never blocks editing).

The autosave is gated on `hasLoadedAutosave.current`. Until the mount-time load
finishes, autosave is a no-op, so the empty initial React state can never
overwrite a real saved project.

> Drift note: the legacy `docs/project-management.md` states autosave runs "every
> 5s." The current hook debounces 400 ms per change, not on a fixed interval.

The server-side write (`POST /api/state`) validates the body is a non-array
object, backs up the previous `latest.json` to `latest.json.bak`, then writes
atomically via a `latest.json.tmp` + rename.

## The Project Library

The Project Library (the **Project Library** toolbar button) is a named-snapshot
store separate from autosave. The modal is `src/components/ProjectLibraryModal.tsx`;
all logic is in `src/hooks/useProjectPersistence.ts`.

A saved project (`SavedProject`) has this shape:

| Field | Notes |
|---|---|
| `id` | Random base36 id |
| `name` | User-entered label |
| `createdAt` | `Date.now()` epoch ms |
| `elements` | Full element array |
| `canvasState` | Canvas size / background / view |
| `assets` | Image assets (inline) |
| `textures?` | Texture library (optional) |

| Action | Handler | Effect |
|---|---|---|
| Save | `handleSaveProject(name)` | Prepends a new `SavedProject` and rewrites `ui-modeler-projects` |
| Load | `handleLoadProject` → `executeLoadProject` | Confirms if the canvas is non-empty, then swaps in the project |
| Delete | `handleDeleteProject` → `executeDeleteProject` | Confirms, filters the id out, rewrites `ui-modeler-projects` |

> `SavedProject` does **not** include `customModules`. Named-project save/load
> carries `elements`, `canvasState`, `assets`, and `textures` only —
> CustomCode modules are preserved by autosave and `.gan` export, but not by the
> Project Library. Loading a named project also does not reset `customModules`,
> so whatever modules were already registered stay registered.

Loading a project clears element signals, calls `clearHistory` (fresh undo
stack), applies canvas/assets/textures, and clears the selection. If the current
canvas already has elements, the load is held behind a confirmation
(`loadProjectTarget`) so you cannot silently discard unsaved work.

## Exporting and importing

Foundry can write the current design to disk in several formats. The table below
covers what each produces; the two plugin formats have their own deep-dive docs.

| Output | Handler / module | Contents |
|---|---|---|
| Download JSON | `handleDownloadProject` | `project.json` = `{ version: 1, elements, canvasState, assets, textures }` |
| Export Package (ZIP) | `handleExportPackage` | `project.json` + `background.png` + `elements/<name>_<i>.json` per element + `README.md` |
| `.gan` plugin bundle | `src/lib/ganExport.ts` (`exportGan`) | See below and [gan-format.md](gan-format.md) |
| VST3 data bundle | `src/lib/vst3Export.ts` | See [vst3-export.md](vst3-export.md) |

The Export Package ZIP is a human-readable snapshot, not a plugin. Its
`project.json` is the same shape as the plain JSON download; textures are carried
inline inside `project.json` (there is no separate textures folder), and
`customModules` are not included.

### `.gan` bundles vs. project JSON

A `.gan` is a ZIP with a trailing archive comment `"GANv1"` (`GAN_COMMENT`). It
is the one export format that round-trips **losslessly** back into Foundry,
because it embeds the entire editable project. Entries written by
`buildGanPackage`:

| Entry | Purpose |
|---|---|
| `manifest.json` | GAN controller manifest (params / controls) — what theDAW/GANduit read |
| `index.html` | Runtime shell with the inline GAN bridge |
| `params.js` | `window.FOUNDRY_DESIGN` + the vanilla renderer |
| `source/foundry-project.json` | Full editable project: `{ version: 1, elements, canvasState, assets, textures, customModules }` |

The `source/foundry-project.json` entry is what makes a Foundry-authored `.gan`
re-editable — it is the only export that preserves `customModules`. theDAW and
GANduit ignore it at runtime.

Import paths wired in `useProjectPersistence`:

- **`.gan` import** — `handleImportGanFile(file)` → `parseGan`. If the bundle has
  `source/foundry-project.json`, the full project (including `customModules`) is
  restored (`sourceKind: "embedded"`). A foreign `.gan` with no embedded source
  is reconstructed best-effort from its manifest (`sourceKind: "reconstructed"`),
  logged to the console. Both paths clear element signals and reset undo history.

> The persistence hook only wires a file picker for `.gan`. The Export Package
> `README.md` says you can "import `project.json` back into VST Foundry," but the
> Project Library loads from IndexedDB, not from a JSON file — re-importing a raw
> `project.json` is not a path exposed by `useProjectPersistence`. To keep a
> re-editable file on disk, prefer `.gan`.

## Legacy binding migration on load

`src/lib/routing.ts` matters to persistence because of how it treats old saved
projects. Elements once carried single-target binding fields (`targetId`,
`xTargetId`, `yTargetId`); the current model uses a `binding.routes` stack.
`routesOf(el)` merges any legacy single-target fields into the effective route
stack **on the fly, never persisting them** — saving an element keeps exactly
what the user set. A project saved under the old shape still routes correctly
without a migration pass rewriting its stored data. See
[canvas-and-controls.md](canvas-and-controls.md) for the routing model itself.

## What survives a restart

| Item | Tab close | Browser restart | Cleared browser storage | Sidecar restart |
|---|---|---|---|---|
| Working canvas | Yes | Yes | Yes (reloaded from `latest.json`) | Yes |
| Named projects | Yes | Yes | No (IndexedDB only) | Yes |
| Arsenal | Yes | Yes | No (IndexedDB only) | Yes |
| Texture files | Yes | Yes | Yes (on disk) | Yes |
| AI keys / prefs / chat history | Yes | Yes | No (localStorage) | Yes |
| Element modulation signals | No | No | No | No |

> The working canvas is the most durable thing in Foundry because it is written
> to both the browser and disk. The Project Library and Arsenal are the least
> durable across environments — they live only in one browser profile's
> IndexedDB, with no disk mirror and no `.bak`.

## Backup behavior

Only the two on-disk JSON files are versioned, and both use the same safe-write
pattern: copy the current file to `<file>.bak`, write a `.tmp`, then rename over
the original.

| File | On save | On load if primary is corrupt |
|---|---|---|
| `data/config.json` | Copied to `config.json.bak` | Falls back to `.bak`, then to defaults |
| `data/sessions/latest.json` | Copied to `latest.json.bak` | Falls back to `.bak`, then returns `null` |
| `data/logs/app.log` | Single rollover to `app.log.1` past the size cap | — |

IndexedDB keys (`ui-modeler-projects`, `ui-modeler-autosave`, `vst-arsenal`) are
single-slot with no backup copy. To snapshot the durable state of an install,
copy the whole `data/` folder; to snapshot the browser-only state (named
projects, Arsenal, keys), export/back up the browser profile.

## `metadata.json` is not project data

The tree has one `metadata.json`, under `component-extractor/`. It is an **AI
Studio remix app descriptor** for the bundled Component Extractor tool, not
Foundry persistence:

```json
{
  "name": "Component Extractor",
  "description": "A manual and AI-assisted asset-slicing tool for UI components. Drag boxes to capture assets, or use Gemini to auto-detect and label UI elements like knobs, buttons, and panels.",
  "requestFramePermissions": [],
  "majorCapabilities": ["MAJOR_CAPABILITY_SERVER_SIDE_GEMINI_API"]
}
```

It describes the container app to the AI Studio host and never holds any saved
canvas, project, or user data. There is no `metadata.json` at the Foundry
project root. Deleting a project or clearing `data/` does not touch it.

> Note: `component-extractor/` is a newly added, in-flight area of the tree.
> Its descriptor is stable, but the surrounding tool is under active
> development — treat details beyond this file as subject to change.

## Operational notes

- The sidecar serves on **port 5472** by default (`THEDAW_FOUNDRY_PORT` or `PORT`
  override it in `server/config.ts`). The legacy `README.md` mentions port 3000;
  the current default is 5472. See [thedaw-integration.md](thedaw-integration.md).
- `data/` is resolved from the sidecar's `process.cwd()`. Launching the sidecar
  from a different directory points it at a different (empty) `data/` tree — the
  server-side autosave and textures will appear "lost" until it is launched from
  the original working directory again.
- If a load looks stale, the server copy wins: check `data/sessions/latest.json`
  first, since it overrides the browser autosave on startup.
- Texture files are shared across all projects (they live on disk, keyed by uuid,
  and are referenced by url), so deleting a texture affects every project that
  points at it. See [textures-and-skins.md](textures-and-skins.md).
- For recovery when the canvas will not load or a `.gan` will not open, see
  [troubleshooting.md](troubleshooting.md).

See also: [foundry-overview.md](foundry-overview.md), [index.md](index.md).
