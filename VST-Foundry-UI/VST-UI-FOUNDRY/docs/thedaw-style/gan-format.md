# The .gan Format — Portable Plugin Bundles

Reference for the `.gan` file — theDAW's portable web-plugin package (a
"pseudo-VST"). A `.gan` is a self-contained ZIP holding a manifest, an HTML entry
point, and its assets. Foundry writes one from a finished design; theDAW installs
it, extracts it, and iframes it into the MIX stage where its controls drive the
audio graph over `postMessage`. This doc covers the on-disk shape of a `.gan`,
how Foundry exports and re-imports one, the host bridge that wires it up, and the
round-trip guarantees. How theDAW installs, extracts, serves, and runs an
installed `.gan` — the `/api/plugin/*` surface and its runtime — is owned by
[thedaw-integration.md](thedaw-integration.md); this doc cross-links there rather
than restating it. It is for anyone touching the export/import path or the
on-disk package format.

For the sibling native-plugin format, see [vst3-export.md](vst3-export.md) — the
`.gan` reuses that module's parameter model and standalone renderer. For how a
`.gan`'s controls are auto-wired onto FX-chain params inside theDAW, see
[thedaw-integration.md](thedaw-integration.md).

## What a .gan is

A `.gan` is a normal ZIP archive with a trailing archive comment of `GANv1`. Two
independent implementations read and write it: the Foundry web app (TypeScript,
under `src/lib/`) and the theDAW backend (Python, under
`backend/modules/plugin/`). Both agree on the manifest schema so a file written
by one loads in the other without translation.

| Property | Value |
|---|---|
| Container | ZIP (DEFLATE compression) |
| Archive comment | `GANv1` (`GAN_COMMENT`) |
| Format version | `1` (`format_version` / `CURRENT_FORMAT_VERSION`) |
| Required entry | `manifest.json` |
| Entry point | `index.html` (from `manifest.entry_html`) |
| Kind | `controller` — emits control values, does not process audio |

> The archive comment is a hint, not the source of truth. Some tools strip ZIP
> comments, so both readers treat **a valid `manifest.json`** as the authoritative
> "is this a `.gan`" check. The Foundry importer records whether the comment was
> present (`hadGanComment`) but never fails on its absence.

### Entries in a Foundry-written .gan

`buildGanPackage` in `src/lib/ganExport.ts` writes exactly four entries:

| Entry | Contents | Read by |
|---|---|---|
| `manifest.json` | The `GanManifest` (pretty-printed JSON) | Foundry, theDAW, GANduit |
| `index.html` | Standalone UI shell with the inline `.gan` bridge injected | The host iframe |
| `params.js` | `window.FOUNDRY_DESIGN = {…}` — the serialized design the UI renders | `index.html` |
| `source/foundry-project.json` | The **full editable project** for lossless re-editing | Foundry only |

> `source/foundry-project.json` is inert to theDAW and GANduit — they only read
> `manifest.json`, `index.html`, and any assets those reference. It exists purely
> so Foundry can reopen the `.gan` and keep editing (see *Round-trip* below).

## The manifest (manifest.json)

The manifest is a flat declaration of what the plugin is, the parameters a host
can drive, and the control outputs it emits. The TypeScript type
(`GanManifest` in `src/lib/ganManifest.ts`) and the Pydantic model
(`GanManifest` in `backend/modules/plugin/gan_manifest.py`) are kept in lockstep.

| Field | Type | Foundry export value | Notes |
|---|---|---|---|
| `format` | string | `"gan"` | Constant. |
| `format_version` | int | `1` | Bumped only on a breaking schema change. |
| `thedaw_version` | string | `"0.1.0"` | Provenance stamp. |
| `id` | string | `ganIdFor(name, elements)` | Stable per design — see *Plugin ids*. |
| `name` | string | Trimmed plugin name, or `"Foundry Plugin"` | |
| `description` | string | `"Exported from VST Foundry."` | |
| `version` | string | `"1.0.0"` | |
| `kind` | string | `"controller"` | `effect`/`instrument` are not supported by the web runtime. |
| `entry_html` | string | `"index.html"` | The asset the runtime iframes. |
| `icon` | string \| null | `null` | |
| `author` / `company` | string | `"GANTASMO"` | |
| `created_at` / `modified_at` | ISO string | Timestamps (overridable in tests) | The Python `save` re-stamps these on write. |
| `canvas` | `{ width, height }` | From `canvasState` | Drives the runtime's contain-fit aspect ratio. |
| `audio_io` | `{ input, output }` | Both `{ channels: 2, enabled: false }` | A controller has no audio path. |
| `params` | `GanParam[]` | Host-drivable **inputs** | See *Controls vs params*. |
| `controls` | `GanControl[]` | Plugin **outputs** | See *Controls vs params*. |
| `source` | string \| null | `"vst-foundry"` | Provenance of the design. |

### Plugin ids

`ganIdFor(name, elements)` in `ganManifest.ts` derives a stable id without any
async crypto: `slugify(name)` (or `"plugin"`) plus a short `djb2` hash of the
name and the JSON-serialized element list, rendered as 8 hex characters. The same
design always yields the same id; changing the layout changes the id.

> The theDAW backend uses a different id scheme when it *builds* a `.gan` from a
> raw Foundry export (`owl_import.py`): `slug(name) + first 8 hex of the
> SHA-256 of the raw project.json`, or a caller-supplied `plugin_id` such as
> `the-owl` / `ares`. Ids are only guaranteed stable within one producer, not
> across the two.

## Controls vs params

Both lists are derived from the **same** VST3 parameter list that
`buildVst3Manifest` (`src/lib/vst3Export.ts`) computes for the standalone UI, so
the ids in the manifest are byte-identical to the ids the exported UI posts. See
[vst3-export.md](vst3-export.md) for the full param-derivation rules (element
types, XY/Envelope fan-out, the CC pool, the 128-param cap).

| List | Direction | Meaning | Shape per entry |
|---|---|---|---|
| `controls[]` | Plugin → host (**out**) | Values the UI emits via `{type:'updateValue', id, value}` | `{ id, name, kind }` where `kind` is `value` \| `xy` \| `xyz` \| `trigger` |
| `params[]` | Host → plugin (**in**) | Normalized `0..1` values the host can drive back into the UI | `{ id, name, type, min:0, max:1, default:0, unit:'' }` where `type` is `float` \| `bool` |

The Foundry mapping is one control and one param per emitted VST3 param id:

- A VST3 param of kind `trigger` → control `kind: "trigger"`, param `type: "bool"`.
- A VST3 param of kind `boolean` → control `kind: "value"`, param `type: "bool"`.
- Everything else (continuous / enum / XY axes) → control `kind: "value"`, param
  `type: "float"`.

Because XY and Spatial3D controls are already split into separate `<id>-x` /
`<id>-y` VST3 params upstream, each axis appears as its own `value` control here
rather than as a single `xy` control. (The `xy` / `xyz` control kinds still exist
in the schema and are produced by theDAW's backend importer — see below.)

## Exporting a .gan from Foundry

`exportGan(elements, canvasState, assets, textures, customModules, pluginName)`
in `src/lib/ganExport.ts` builds the package and triggers a browser download. It
mirrors the VST3 bundle's `jszip` + `file-saver` pattern.

```
exportGan(...)
  └─ buildGanPackage(...)            // pure, no I/O — unit-testable
       ├─ buildGanManifest(...)      // ganManifest.ts
       ├─ buildVst3Ui(...)           // vst3Export.ts → params.js (window.FOUNDRY_DESIGN)
       ├─ buildGanIndexHtml()        // shared shell + inline .gan bridge
       └─ source/foundry-project.json
  └─ JSZip → generateAsync({ comment: "GANv1", compression: "DEFLATE" })
  └─ saveAs(blob, "<slug>.gan")
```

The download file name is `slugify(name).gan`, falling back to
`foundry-plugin.gan` when the slug is empty or the reserved value `param`.

### The index.html bridge swap

The `.gan` reuses the exact same standalone renderer as the VST3 data bundle
(`buildIndexHtml` in `src/lib/vst3ExportUi.ts`). The renderer only talks to its
host through two globals — it *calls* `window.foundryHost.setParam(id, v)` and
*defines* `window.foundryApplyParam(id, v)`. In a native VST3 that host is a
sidecar file, `foundry-bridge.js`. `buildGanIndexHtml` swaps that `<script>` tag
for the inline `GAN_BRIDGE_JS`, so the exported page defines its own
`window.foundryHost` and needs no sidecar file.

```
// native shell HTML:   <script src="foundry-bridge.js"></script>
// .gan HTML:           <script> …inline GAN_BRIDGE_JS… </script>
```

> If the shared template ever stops emitting the `foundry-bridge.js` tag, the
> builder defensively injects the inline bridge *before* `params.js` instead, so
> the UI can never silently load without a `foundryHost` and emit nothing.

## The host bridge (ganBridge.ts)

`GAN_BRIDGE_JS` in `src/lib/ganBridge.ts` is the tiny script embedded verbatim in
the `.gan`'s `index.html`. It adapts the renderer's two globals to theDAW /
GANduit's `postMessage` contract, matching what `owl_import.py`'s composed
surfaces already speak.

| Direction | Trigger | Action |
|---|---|---|
| UI → host | Renderer calls `window.foundryHost.setParam(id, 0..1)` | Posts `{type:'updateValue', id, value}` to `window.parent` |
| Host → UI | Parent posts `updateValue` / `applyParam` / `param` with an `id` | Calls `window.foundryApplyParam(String(id), Number(value))` |
| Host → UI | Parent posts `{type:'level'}` | Broadcasts the frame **down** to every child iframe (meter feed); the native renderer ignores it |
| Child → host | A child iframe posts `updateValue` / `x` / `y` / `trigger` | Relays the frame **up** to the host, mirroring `owl_import.py`'s relay |

> Maintenance constraint: `GAN_BRIDGE_JS` is inlined inside an HTML `<script>`
> string literal, so it must contain **no backticks and no `${` sequences**. Keep
> it plain ES5 concatenation.

## The embedded editable source (round-trip)

`source/foundry-project.json` holds a `GanProjectSource`:

| Field | Contents |
|---|---|
| `version` | `1` |
| `elements` | Every `UIElement`, unmodified |
| `canvasState` | Full canvas state (size, background, pan/zoom, rulers) |
| `assets` | Media assets |
| `textures` | Generated textures |
| `customModules` | Saved CustomCode modules |

This is a superset of what `params.js` (`window.FOUNDRY_DESIGN`) carries —
`FOUNDRY_DESIGN` omits `customModules` because the runtime does not need them.
Keeping the full project embedded is what makes re-opening a `.gan` lossless.

> The [Arsenal](#the-arsenal) is deliberately **not** part of the embedded source.
> It is global, cross-project state and never travels inside a `.gan`.

## Importing a .gan back into Foundry

`parseGan(data)` in `src/lib/ganImport.ts` reads `.gan` bytes into an editable
project. It returns `{ manifest, project, sourceKind, hadGanComment }` and throws
**only** when the file is not a readable `.gan` (the ZIP won't open, or
`manifest.json` is missing / not valid JSON).

| `sourceKind` | When | Fidelity |
|---|---|---|
| `embedded` | `source/foundry-project.json` is present and parses | Lossless — the exact original elements, canvas, textures, and modules |
| `reconstructed` | No embedded source (or it is corrupt) | Best-effort — one native control per manifest control, on a grid |

### Reconstruction from a source-less .gan

A `.gan` made outside Foundry — by theDAW's backend importer, by hand, or by a
third party — has no embedded source. `reconstructFromManifest` lays out one
element per `manifest.controls[]` entry on a grid (the original coordinates are
not recoverable from the manifest):

- Column count = `max(1, floor(canvas.width / 160))`; positions step by 160px
  across and 140px down, starting at `(24, 24)`, each element `96×96`.
- Control `kind` maps to element type: `trigger` → `Button`, `xy` / `xyz` →
  `XYPad`, everything else → `Knob`.
- Values default to `value: 0`, `min: 0`, `max: 1`.

The result is never empty and is clearly flagged as `reconstructed` so the UI can
warn that the layout is approximate.

## The Arsenal

The Arsenal (`src/lib/arsenal.ts`) is a cross-project, cross-reload palette of
saved controls. It is documented here to draw a hard line: **it is not part of any
`.gan`, `SavedProject`, or zip export.** It lives under a single `idb-keyval` key,
`vst-arsenal`, so a control you save once is available in every project and after
every reload.

| Function | Behavior | Returns |
|---|---|---|
| `loadArsenal()` | Reads the list; `[]` on empty, malformed, or read error (never throws) | `ArsenalEntry[]` |
| `addToArsenal(entry)` | Overwrites the entry sharing the same `name`, else appends | Updated list |
| `removeFromArsenal(id)` | Drops the entry with that `id` (no-op if gone) | Updated list |

An `ArsenalEntry` carries `id` (uuid), `name`, `type`, `defaultWidth`,
`defaultHeight`, an optional `previewUrl`, `createdAt`, and `presetData` — the
**instance-agnostic** `UIElement` fields (no `id` / `x` / `y`) so an entry drops
onto any canvas through the existing preset-drag path unchanged.

> Same-name overwrite matches `handleAddCustomModule`: saving under a name you
> already used replaces that slot in place instead of piling up duplicates; a
> fresh name appends. Every mutator returns the updated list so callers can push
> it straight into React state without a second read.

## Round-trip guarantees and tests

`src/lib/ganRoundTrip.test.ts` (Vitest) pins the contract:

| Test | Guarantee |
|---|---|
| `buildGanManifest` | A single Knob yields a `controller` manifest with `source: "vst-foundry"`, one `value` control, and one `float` param; canvas matches. |
| `buildGanPackage` | The package has exactly `index.html`, `manifest.json`, `params.js`, `source/foundry-project.json`; `index.html` uses the **inline** bridge (no `foundry-bridge.js`), contains `window.foundryHost` and `type: "updateValue"`; `params.js` defines `window.FOUNDRY_DESIGN`. |
| `parseGan` (embedded) | A round-tripped `.gan` restores the exact `elements` and `canvasState`, reports `sourceKind: "embedded"`, `hadGanComment: true`, and the stable id. |
| `parseGan` (no manifest) | A ZIP with no `manifest.json` rejects with an error mentioning `manifest.json`. |
| `parseGan` (source-less) | A manifest-only `.gan` reconstructs one element per control, `sourceKind: "reconstructed"`, first element a `Knob` keeping the control id. |

Run the suite from the Foundry app root:

```bash
cd VST-Foundry-UI/VST-UI-FOUNDRY
npm run test -- ganRoundTrip
```

## How theDAW builds a .gan from a raw export

theDAW can also manufacture a `.gan` from a *raw* Foundry export (a flat
`project.json` plus a `background.png`) without the embedded source. This is the
`import_vst_foundry(...)` path in `backend/modules/plugin/owl_import.py`, used
for the two bundled surfaces **The Owl** and **Ares**. It returns
`(GanManifest, assets)` for `GanFile.save`, producing a `kind: "controller"`,
`source: "vst-foundry"` manifest whose `id` is the caller's `plugin_id` or
`slug(name) + sha256(raw)[:8]` (see *[Plugin ids](#plugin-ids)*). This is the
`reconstructed`-fidelity producer in
*[Two ways a .gan is born](#two-ways-a-gan-is-born)* below.

The importer's theDAW-side details — how each export element is rendered
(`CustomCode` → an `el_<id>.html` iframe, native `Knob` → a draggable rotary,
`Image` / unknown types → placeholders), the four-step canvas-size resolution
(background PNG IHDR size → explicit `canvasWidth` / `canvasHeight` → element
extents → the `1672 × 941` default), and the composed `index.html`'s up/down
`postMessage` relay — are documented once in
[thedaw-integration.md](thedaw-integration.md#importing-a-foundry-export) so the
two docs cannot drift as the importer changes.

> Note: `backend/modules/plugin/owl_import.py` and `router.py` are under active
> edit at the time of writing. The cross-linked behavior reflects the current
> on-disk source; expect churn in the importer's element handling.

## The .gan package on the theDAW side

`backend/modules/plugin/gan_file.py` reads and writes `.gan` files as ZIPs with
the `GANv1` comment.

| Method | Purpose |
|---|---|
| `GanFile.save(manifest, assets, path)` | Writes `manifest.json` + assets; re-stamps `created_at` / `modified_at`, sets `format_version`. Warns above a 200 MB soft cap. |
| `GanFile.info(path)` | Reads **only** the manifest. Rejects a `format_version` newer than theDAW supports. |
| `GanFile.load(path)` | Returns `(manifest, assets)` — all entries except `manifest.json`. |
| `GanFile.extract(path, out_dir)` | Unpacks assets for static serving, with zip-slip path guards, and writes the manifest alongside. |

## The plugin API and runtime

Once a `.gan` exists on disk, `backend/modules/plugin/router.py` installs,
extracts, and serves it under the `/api/plugin` prefix (`sidebar: false`).
Installed plugins live at `data/plugins/*.gan`; each is extracted into
`data/plugins/_runtime/<id>/` for iframing.

The endpoint surface (`/api/plugin/*`) and the runtime staleness mechanism —
`_ensure_runtime` comparing a `.gan_mtime` stamp (in nanoseconds) against the
source `.gan` and re-extracting when they differ, and `serve_runtime` sending
`Cache-Control: no-cache` on `.html` so an already-open iframe never renders a
stale copy — are owned by
[thedaw-integration.md](thedaw-integration.md#the-plugin-runtime-running-an-exported-gan-inside-thedaw)
so the two docs cannot drift. gan-format.md stops at the on-disk package; the
moment it is served is theDAW's side of the boundary. The one on-disk
consequence worth restating is in *[Gotchas](#gotchas)* below: re-packaging must
bump the `.gan` mtime, which is why every backend path routes through
`_extract_runtime`.

## How theDAW serves and displays a .gan

The frontend consumes the plugin API through a thin client and a Zustand store,
then iframes the served runtime.

| Piece | Role |
|---|---|
| `frontend/src/lib/ganClient.ts` | `ganApi.list` / `open` / `openById` / `importOwl` / `packageOwl` / `packageAres` / `reveal` over `/api/plugin/*`. |
| `frontend/src/state/ganStore.ts` | Installed library + the one plugin currently open (`activeId` / `activeUrl` / `activeName`). |
| `frontend/src/components/audio/GanPluginStage.tsx` | Iframes `/api/plugin/<id>/runtime/index.html` in the MIX Effect Stage; **Expand** pops a near-fullscreen overlay keeping the same `src` (no reload, state persists). |

The runtime's `index.html` letterboxes its canvas to fit (aspect ratio
preserved), so an oversized plugin shrinks rather than overflows. Control
`postMessage` frames bubble up to the app, where they can be routed onto FX-chain
parameters. The auto-wire that maps Ares's control ids onto a composite FX entry,
and the live master-level meter feed, are covered in
[thedaw-integration.md](thedaw-integration.md).

## Two ways a .gan is born

| | Foundry web export (`ganExport.ts`) | theDAW backend build (`owl_import.py`) |
|---|---|---|
| Input | A live Foundry design (elements + canvas + assets) | A raw `project.json` + `background.png` |
| Renderer | Shared standalone renderer (`vst3ExportUi.ts`) driving `params.js` | Composed percentage-layout `index.html` with per-element iframes |
| Host bridge | Inline `GAN_BRIDGE_JS` injected into `index.html` | Inline relay script in the composed `index.html` |
| Embedded source | Yes — `source/foundry-project.json` (lossless re-edit) | No |
| Re-import fidelity | `embedded` (exact) | `reconstructed` (grid approximation) |
| Plugin id | `slug(name)` + `djb2` design hash | `plugin_id` or `slug(name)` + `sha256(raw)[:8]` |
| Manifest `kind` / `source` | `controller` / `vst-foundry` | `controller` / `vst-foundry` |

## Gotchas

- **Ids never drift within a producer, but do across producers.** A Foundry-web
  `.gan` and a backend-built `.gan` of the "same" design will not share an id.
  Reconstructed imports keep whatever ids the manifest carried.
- **`kind` is always `controller`.** The web runtime does not process audio;
  `effect` / `instrument` are reserved in the schema but unsupported.
- **A stripped ZIP comment is fine.** Validity is decided by `manifest.json`, not
  by `GANv1`.
- **The Arsenal never ships in a `.gan`.** If a saved control seems "missing" from
  an exported plugin, that is by design — the Arsenal is global browser state.
- **Re-packaging must bump the `.gan` mtime.** Runtime freshness keys off it; a
  path that materialises a runtime without stamping `.gan_mtime` would serve stale
  assets forever, which is why every backend path routes through
  `_extract_runtime`.

## See also

- [vst3-export.md](vst3-export.md) — the parameter model, CC pool, and standalone
  renderer the `.gan` reuses.
- [custom-code.md](custom-code.md) — how CustomCode elements behave inside the
  bundle and its iframes.
- [thedaw-integration.md](thedaw-integration.md) — the sidecar, the Ares
  auto-wire, and the MIX stage.
- [projects-and-data.md](projects-and-data.md) — where Foundry projects and
  assets live on disk.
- [foundry-overview.md](foundry-overview.md) — the builder that produces these
  designs.
- [troubleshooting.md](troubleshooting.md) — when a plugin fails to load or serve.
