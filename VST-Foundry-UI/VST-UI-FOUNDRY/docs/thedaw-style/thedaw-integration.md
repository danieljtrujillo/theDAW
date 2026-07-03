# theDAW Integration — Sidecar, Tab, and Plugin Runtime

Reference for how VST Foundry lives inside theDAW. Foundry is a vendored
standalone app: theDAW runs it as a Node sidecar, embeds it as a center tab,
and — separately — runs the interfaces you export from it as portable `.gan`
web-plugins in the MIX effect stage. This doc covers both halves and the seams
between them: the sidecar process, the tab embed, the two control buses that
reach out of the Foundry iframe, and the plugin runtime that plays an exported
`.gan` back inside theDAW. It is for anyone wiring, debugging, or extending that
boundary. For the builder itself see [foundry-overview.md](foundry-overview.md);
for the package format see [gan-format.md](gan-format.md); for the AI orb and MCP
surface see [assistant-and-mcp.md](assistant-and-mcp.md).

> Concurrent developers are editing several of the files named here. The
> behavior below reflects the code as it stands; where an area is visibly in
> flight it carries a `Note:`.

## The two integration paths

Foundry touches theDAW through two independent pipelines. Keeping them straight
avoids a lot of confusion, because both are loosely called "control wiring."

| Path | When | Transport | Reaches theDAW how |
|---|---|---|---|
| **Design-time (the tab)** | While you build a UI in the Foundry tab | Foundry SPA in an iframe on port `5472` | Foundry's own `dawControlBus` opens a WebSocket straight to theDAW's backend `:8600`; live canvas controls drive theDAW targets |
| **Runtime (the plugin)** | After you export a `.gan` and open it in MIX | `.gan` runtime HTML in an iframe under `/api/plugin/<id>/runtime/` | The plugin posts `updateValue` messages up to the host page; `aresBridge` (or a native surface) routes them onto FX params |

The first path is Foundry-source code running inside the sidecar iframe. The
second is a static bundle Foundry produced, served by theDAW's Python backend
and wired up by theDAW's React frontend. They never share a channel.

## The Foundry sidecar

theDAW spawns Foundry as a Node dev-server subprocess and manages its whole
lifecycle. The logic lives in `backend/modules/foundry/sidecar.py`.

### Spawn and readiness

`ensure_running()` is the entry point. It:

1. Returns immediately if a Foundry server is already answering on the port.
2. Refuses the port if something that is **not** Foundry is listening there.
3. Runs `npm install` first when `node_modules` is missing (the one-time wait on
   a fresh clone).
4. Spawns the dev server and waits up to `PORT_READY_TIMEOUT_SEC` (90s) for it to
   answer, polling every 0.5s.

```
cmd  = npm run dev
cwd  = <repo>/VST-Foundry-UI/VST-UI-FOUNDRY
```

The working directory is anchored at `parents[3]` of `sidecar.py`
(`foundry → modules → backend → repo`), so it resolves regardless of the process
CWD. `npm run dev` runs `tsx server.ts` — an Express app with Vite in middleware
mode on the **same** port, not a separate Vite server.

### Configuration

`resolve_config()` reads two environment variables and locates `npm`.

| Setting | Source | Default |
|---|---|---|
| Port | `THEDAW_FOUNDRY_PORT` env | `5472` (`DEFAULT_PORT`) |
| Project path | `THEDAW_FOUNDRY_PROJECT` env | `<repo>/VST-Foundry-UI/VST-UI-FOUNDRY` |
| npm binary | `shutil.which("npm.cmd")` → `which("npm")` | `"npm"` |
| Ready timeout | constant | `90.0s` |

The spawn injects two env vars into the child:

| Env var | Value | Effect |
|---|---|---|
| `THEDAW_FOUNDRY_PORT` | resolved port | Foundry binds `127.0.0.1:<port>` |
| `DISABLE_HMR` | `"true"` | Turns off Vite HMR + file watching in the embedded server |

`DISABLE_HMR=true` matters: nobody live-edits Foundry's source when it runs as an
embedded sidecar, so HMR is pure overhead. With it off, `server.ts` passes
`hmr: false` to Vite, which stops Vite from opening the HMR WebSocket whose
unreachable retries otherwise flood the browser console with
`ERR_CONNECTION_REFUSED`. Standalone (no `DISABLE_HMR`), HMR runs on `PORT + 1`
(`5473`) so multiple Foundry instances never collide on Vite's fixed default
(`24678`).

### Health detection

The sidecar decides whether Foundry is up by hitting its health endpoint, not by
a bare port check:

```
GET http://127.0.0.1:<port>/api/health
→ body contains  "app":"vst-foundry"
```

`/api/health` and `/api/shutdown` are served by the **Foundry** Express app
(`server/routes.ts`), not by theDAW's backend. `_is_foundry_server()` reads the
first 512 bytes, strips spaces, and looks for the `"app":"vst-foundry"` marker.
A port that is listening but does not return that marker is treated as a foreign
process, and `ensure_running()` raises rather than iframing something unknown.

### Logging

All child stdout/stderr is captured to a logfile (never `DEVNULL`), so a spawn
that dies leaves a trail:

```
<repo>/data/logs/foundry-sidecar.log
```

`ensure_running()` appends the log tail to the `RuntimeError` it raises on
`npm install` failure, a premature exit, or a port-open timeout — that tail is
what the `/api/foundry/url` 503 detail (and the tab's error card) surfaces.

### Shutdown and teardown

`stop()` tries the gentlest teardown first and escalates:

1. `POST /api/shutdown` to the Foundry app, then wait for it to stop answering.
2. `Popen.terminate()`, then `.kill()` on timeout.
3. On Windows only: `netstat -ano` to find the PID still `LISTENING` on the port,
   then `SIGTERM` it.

Teardown is wired to run automatically two ways: `atexit.register(_atexit_stop)`
at import time, and the router's `@router.on_event("shutdown")` FastAPI hook. So
the Node server is not orphaned when the backend exits.

> A fresh `theDAW.bat` launch clears any stale process on the port via the
> netstat/PID path, so a previous crash that left Foundry listening does not
> block the next start.

### Endpoints (`/api/foundry`)

Registered by `backend/modules/foundry/router.py`; `module.json` sets
`sidebar: false`, `backend: true`, `api_prefix: /api/foundry`.

| Method + path | Purpose | On failure |
|---|---|---|
| `GET /api/foundry/url` | Ensure the sidecar is running; return `{ url }` | `503` with the sidecar's error detail (incl. log tail) |
| `GET /api/foundry/status` | Probe without starting: project path, port, listening, process_alive, url, issues, `ok` | Always `200` |
| `POST /api/foundry/start` | Force `ensure_running()`; return `{ ok, url }` | `503` |
| `POST /api/foundry/stop` | Stop the sidecar; return `{ ok, stopped }` | `503` if still listening |

`GET /status` never starts the process. It reports `ok = not issues and
listening`, where `issues` includes a missing project path, a missing
`package.json`, or `npm` not on PATH.

## The Foundry tab

`frontend/src/views/FoundryView.tsx` is the React view that embeds the sidecar.
It is code-split and mounted by `DAWCenterPanel.tsx` — a lazy import, a center
tab, never a sidebar item.

### Load flow

On mount, `FoundryView` calls `GET /api/foundry/url`. Because the first launch
may be doing an `npm install`, it retries on failure:

| Behavior | Value |
|---|---|
| Retry limit | 20 attempts |
| Retry interval | 2000ms (2s) |
| On success | iframe `src = http://localhost:<port>` |
| On exhaustion | error card showing the backend detail |

The iframe uses `allow="clipboard-write; fullscreen; autoplay"`. A header strip
above it has a **Reload** button (resets the retry counter and re-fetches) and an
**open-externally** link that opens the same URL in a browser tab.

### Warmed mounting

`DAWCenterPanel` keeps a `warmedTabs` set. Once `foundry` (or `dj`, `vj`,
`underfit`) has been visited, its view stays mounted and only its CSS visibility
toggles with the active tab. So switching away and back does not tear down the
iframe or re-run the sidecar handshake — the Foundry SPA and its in-progress
work survive tab switches. Each tab renders inside its own `Suspense` boundary,
so a not-yet-loaded sibling never blanks it.

> "VST Foundry did not start" on the error card means all 20 retries failed.
> `GET /api/foundry/status` reports the project path, port, and issues; the
> root cause detail is in `data/logs/foundry-sidecar.log`. See
> [troubleshooting.md](troubleshooting.md).

## Crossing the iframe: the two buses

Two bus modules in Foundry's `src/lib/` govern control flow. Only one of them
crosses the iframe boundary out to theDAW.

### dawControlBus — reaches theDAW (design-time)

`src/lib/dawControlBus.ts` connects, from inside the Foundry iframe, straight to
theDAW's XR control relay as a **controller** peer:

```
ws(s)://<hostname>:8600/api/xr/control/ws
```

This is a direct WebSocket to theDAW's backend — no iframe `postMessage` origin
bridge is involved. theDAW's browser tab (the one hosting the Foundry iframe) is
the **host** peer: it owns the manifest of bindable targets and applies inbound
`control-set` frames by routing them to whatever registered source owns each id.
The relay is transport-only and fans every frame to all peers. The wire contract
mirrors theDAW's `frontend/src/state/xrControlClient.ts`.

| Direction | Frame | Meaning |
|---|---|---|
| controller → host | `{type:"request-controls"}` | Ask the host to (re)publish its manifest |
| controller → host | `{type:"control-set", id, value}` | Drive a target (number, or boolean for toggles) |
| host → controller | `{type:"manifest", version, entries:[DawTarget...]}` | The bindable-target list |
| host → controller | `{type:"control-changed", id, value}` | A target's live value (up to 60fps) |

Design decisions worth knowing:

- **Two stores, on purpose.** A React snapshot (`connected` / `targets` /
  `version`) drives the binding UI; a separate out-of-band `liveValues` Map plus
  per-id `valueListeners` carry the 60fps LISTEN stream, so a fast-moving id
  re-renders only its own subscribers. Reconnect is every 2000ms.
- **`vst:` binds dispatch locally first.** `setDawTarget()` sends a `vst:` id to
  the local `vstWriteHandler` (LFOs, macros, local transport in `vstBindRuntime`)
  and *then* forwards the same `control-set` frame on the bus. Live theDAW ids
  are bus-only. `scaleToTarget` / `scaleFromTarget` map Foundry's 0–100 range to
  and from each target's declared `min..max`; booleans collapse to `0`/`100`.
- **Readonly sources.** Input-only theDAW sources (sway/pose) carry `readonly`
  and are excluded from the write picker but welcomed by the LISTEN path — they
  are the star signals for live meters and scopes.

### elementSignalBus — stays inside Foundry

`src/lib/elementSignalBus.ts` is a runtime-only pub/sub for element→element
modulation (a moving control drives a ganged knob, a Label readout, a Meter
level). It is keyed `"<elementId>:<prop>"`, its values are **ephemeral** (it
never touches the element store, autosave, or undo — like a real VST, moving a
mod-routed knob does not rewrite the patch), and `clearElementSignals()` is
called on project load so stale modulation cannot bleed between documents.

> Note: `elementSignalBus` does **not** cross the iframe. It is Foundry-internal.
> Of the two buses, only `dawControlBus` reaches theDAW. If you are chasing why a
> Foundry control does or does not move a theDAW parameter, `dawControlBus` and
> the XR relay on `:8600` are the only path.

## The plugin runtime: running an exported `.gan` inside theDAW

The second half of the integration has nothing to do with the sidecar. When you
export a design, it becomes a `.gan` package that theDAW's Python backend serves
as a self-contained web plugin. The code lives in `backend/modules/plugin/`;
`module.json` registers it at `api_prefix: /api/plugin`, `sidebar: false`.

### What a `.gan` is

A `.gan` is a ZIP (`GanFile` in `gan_file.py`) carrying a `manifest.json` plus
the plugin's web assets (`index.html` + images). It is marked two ways so a tool
that strips ZIP comments can still be identified:

| Marker | Value |
|---|---|
| ZIP archive comment | `GANv1` |
| `manifest.format` | `gan` |
| `manifest.format_version` | `1` (loading rejects anything higher) |

The manifest (`gan_manifest.py`) is a flat declaration. For an imported Foundry
export it is `kind = "controller"` (emits control values, processes no audio;
`effect`/`instrument` are not yet supported by the web runtime),
`entry_html = "index.html"`, `author`/`company = "GANTASMO"`, and
`source = "vst-foundry"`. It carries two lists:

| Field | Meaning |
|---|---|
| `controls[]` | Outputs the plugin **emits** (`updateValue` posts); `kind` is `value` / `xy` / `xyz` / `trigger` |
| `params[]` | Host-drivable normalized `0..1` **inputs** |

### Importing a Foundry export

`owl_import.import_vst_foundry()` composes a Foundry export — a `project.json`
(flat list of absolutely-positioned elements) plus a sibling `background.png` —
into a single responsive `index.html`. Each element is laid out by **percentage**
over the background so it scales with the stage while staying pinned to the art.

| Export element type | Rendered as | Emitted control |
|---|---|---|
| `CustomCode` | Its own `el_<id>.html` iframe (the code is a full-window document) | `kind = "xy"` if the code contains `valueX`, else `value` |
| `Knob` (native) | A minimal draggable rotary posting its `0..1` value to the host | `value` |
| `Image` | Borderless non-interactive placeholder (art is already baked into `background.png`) | none |
| unknown type | Labelled dashed placeholder (never silently dropped) | none |

Canvas size is resolved in this order, first hit wins:

1. The `background.png` real pixel size (parsed from the PNG IHDR header).
2. Explicit `canvasWidth`/`canvasHeight` (or `width`/`height`) fields.
3. The element extents (max `x+width`, max `y+height`).
4. The documented default `1672 × 941`.

The imported plugin id is `slug(name)-<sha256(project.json)[:8]>` — stable for a
given export.

> Foundry's own exporter (`src/lib/ganManifest.ts`) derives ids differently (a
> `djb2` short-hash) and embeds a lossless editable copy of the project. The
> backend `owl_import` path is the lighter "compose the art into a controller"
> importer used for the bundled surfaces. See [gan-format.md](gan-format.md) for
> the full-fidelity round-trip export.

### Endpoints (`/api/plugin`)

| Method + path | Purpose |
|---|---|
| `POST /api/plugin/import-owl` | Import a Foundry export (`project.json` or its folder) into a stored `.gan`; returns manifest + entry URL |
| `GET /api/plugin/list` | List installed plugins (manifest summary each) |
| `GET /api/plugin/info?path=` | Read the manifest of a `.gan` at an arbitrary path (no install) |
| `POST /api/plugin/open` | Open an installed plugin by `id`, or install + open a `.gan` at a `path` |
| `POST /api/plugin/package-owl` | (Re)build the bundled "The Owl" `.gan` from in-repo assets |
| `POST /api/plugin/package-ares` | (Re)build the bundled "Ares" `.gan` from its in-repo Foundry export |
| `POST /api/plugin/reveal` | Reveal a file in the OS file manager (Explorer/Finder), selecting it |
| `DELETE /api/plugin/{id}` | Remove an installed plugin and its extracted runtime |
| `GET /api/plugin/{id}/runtime/{asset}` | Serve one extracted plugin asset to the iframe |

The frontend HTTP client is `frontend/src/lib/ganClient.ts` (`ganApi`); the
installed-library + open-plugin state is a Zustand store,
`frontend/src/state/ganStore.ts`.

### Runtime extraction and staleness

Installed `.gan` files live in `data/plugins/*.gan`. Each is extracted to a
runtime directory on first serve:

```
data/plugins/_runtime/<id>/
data/plugins/_runtime/<id>/.gan_mtime   ← the source .gan's mtime, in ns
```

`_ensure_runtime()` re-extracts whenever the stored `.gan` is newer than the
`.gan_mtime` stamp, so a re-packaged plugin (for instance one carrying a
contain-fit layout fix) is never served from a stale runtime. Every path that
materializes a runtime goes through `_extract_runtime()` so the stamp is always
written — a direct `GanFile.extract` elsewhere would look "fresh" forever.

`serve_runtime()`:

- Path-guards every request against traversal outside the runtime dir.
- Serves `.html` with `Cache-Control: no-cache` (the composed `index.html` is
  regenerated on layout changes, so an open iframe never renders a stale,
  stretched copy from disk cache); large static assets like `background.png`
  still cache normally.

## The runtime relay: postMessage across nested iframes

A composed `.gan` `index.html` is itself a host for one child iframe per
`CustomCode` element. The relay `<script>` it injects bridges three DOM levels —
theDAW host page → the `.gan` `index.html` → each `el_<id>.html` child:

| Message | Direction | Handling |
|---|---|---|
| `{type:"updateValue", id, ...}` | child → `.gan` → host | Relayed **up** to `window.parent` (theDAW) so the host can route the control |
| `{type:"level", value}` | host → `.gan` → children | Forwarded **down** to every element iframe (drives meter feedback) |

So a plugin's controls bubble out to theDAW, and theDAW's live audio level
reaches every control inside the plugin, without either side knowing about the
nesting in between.

## Auto-wire: Ares control surface → live FX params

The runtime counterpart of the design-time XR bus is `aresBridge`
(`frontend/src/lib/aresBridge.ts`). It routes the bundled **Ares** `.gan`'s
`updateValue` messages onto a single `ares` composite entry in whichever FX chain
is live (MIX's effect chain, or an EDIT track/master chain).

- Each mapped Ares control id sets one param of the `ares` entry
  (`ARES_CTRL_PARAM` — the five knobs, the wet/dry slider, Freeze, the filter-type
  selector, and five blade toggles).
- The XY Kaoss pad is special-cased: its X / Y / Z drive three macro axes
  `ARES_PAD_AXES = [filterCutoff, wetDry, grainsDensity]`.
- Patches are **rAF-coalesced** (merged per frame) so 60fps pad input never
  thrashes the store, and the live racks push params without a rebuild so it
  stays click-free.
- Exactly **one** bridge is active app-wide: registering a new one detaches the
  previous owner, so the same message is never applied twice.

`MixView` registers the bridge for the life of the MIX view. `findEntry` resolves
the `ares` entry from `useEffectChainStore`; the XY-pad control id is resolved
from the installed plugin's controls (the control named `ares_xy_kaoss_pad`) with
fallback `ARES_XY_PAD_FALLBACK_ID` (`pf5ixrn`). EDIT's WaveformEditor Ares popup
takes over ownership while it is open (its later registration displaces MIX's),
then MIX resumes on close.

While Ares is open, MIX also pushes the live master output level **into** the
`.gan` so its meter reflects real signal: it reads the player analyser, computes
an RMS level, and posts `{type:"level", value}` to the runtime iframe
(`#gan-stage-frame`), which the relay fans down to the plugin's controls.

## The plugin stages (frontend surfaces)

theDAW mounts a plugin in the MIX effect-stage footprint (the same slot Studio
Modules use) through one of four React surfaces. All share one hard rule:
fixed-aspect artwork is **contain-fit**, never stretched.

| Component | Renders | Fit strategy |
|---|---|---|
| `AspectStage.tsx` | The canonical fixed-aspect wrapper for native React surfaces | Container-query units: box `= min(100cqw, 100cqh·W/H)` × `min(100cqh, 100cqw·H/W)`, centered, letterboxed |
| `TheOwl.tsx` | The spatializer surface (native React, **not** a `.gan`) | Uses `AspectStage` over the `1672×941` Owl art |
| `GanPluginStage.tsx` | A loaded `.gan` runtime in an iframe (`#gan-stage-frame`) | The runtime `index.html` letterboxes itself with viewport units |
| `EffectGuiStage.tsx` | A Studio Module GUI iframe from `/edit-modules/<file>` | Measures the module's native frame, injects a contain-fit stylesheet |

### Why contain-fit, and the recurring bug

`AspectStage.tsx` exists to kill one specific bug: sizing an art box as
`aspect-ratio: W/H` **plus** `width:100%; height:100%` (or `background-size:100%
100%` on a full-size box). The explicit 100%×100% overrides the aspect ratio and
skews the artwork to the stage's shape. The fix is one formula applied in one
place — the container-query box above. Children position by percentage of that
box, which is exactly the artwork rectangle, so overlaid controls always land on
their art regardless of stage shape.

The `.gan` runtime does the equivalent with **viewport** units (correct there,
because the iframe body *is* the stage); `AspectStage` is the nested-DOM
counterpart for native React surfaces, where viewport units would wrongly track
the whole window.

### TheOwl specifics

`TheOwl` iframes the two original Owl canvas surfaces — `/owl/kaoss.html` and
`/owl/room.html` — so the real particle trails, glowing indicator, crosshairs,
and source rings come from the source art. It listens for their `updateValue`
messages and bridges them onto the spatializer params:

| Panel message id | Payload | Maps to |
|---|---|---|
| `oivsvlg` (Kaoss) | `valueX` / `valueY` | azimuth / elevation |
| `owl-room` (spatial room) | `rad` / `z` | distance / depth |

Right-clicking the Owl surface packages and reveals the sidecar `.gan` via
`ganApi.packageOwl()` + `ganApi.reveal()`, the VST-bundle-style share action.

### EffectGuiStage specifics

`EffectGuiStage` feeds audio to the module over `postMessage`. The module loads
audio **without** starting playback, so mounting the stage never autoplays.

| Message | Direction | Purpose |
|---|---|---|
| `thedaw-audio` `{buffer, name}` | host → module | Hand the module the current source to decode/preview |
| `thedaw-transport` `{action:"play"\|"pause"}` | host → module | Drive playback from the stage's toggle |
| `thedaw-transport-state` `{playing}` | module → host | The module echoes real playback state (incl. its own buttons) so the toggle stays truthful |

## Bundled surfaces

Two surfaces ship built from in-repo assets rather than user imports.

| Surface | Plugin id | Built by | Asset sources |
|---|---|---|---|
| The Owl | `the-owl` | `POST /api/plugin/package-owl` | `backend/modules/plugin/assets/the-owl/project.json` + `frontend/public/owl/the-owl.png`; excludes the preset carousel |
| Ares | `ares` | `POST /api/plugin/package-ares` | `backend/modules/plugin/assets/ares/project.json` (its `background.png` sits beside it) |

`package-owl` / `package-ares` are idempotent — they rebuild the `.gan` and
re-extract a fresh runtime — so edits to the bundled `project.json` ship even to a
machine that already has an older copy installed. `ganStore.ensureAres()`
(re)packages Ares on MIX open so it always shows as a Studio tile.

## Ports and services

| Service | Port | Bind | Notes |
|---|---|---|---|
| theDAW backend (FastAPI) | `8600` | — | Serves `/api/foundry/*`, `/api/plugin/*`, and the XR control WS |
| theDAW SPA (Vite) | `5173` | — | The host page that iframes Foundry |
| Foundry sidecar (Express + Vite) | `5472` | `127.0.0.1` | `THEDAW_FOUNDRY_PORT`; Express + Vite share one port |
| Foundry HMR (standalone only) | `5473` | — | `PORT + 1`; disabled entirely when embedded (`DISABLE_HMR=true`) |
| Vite fixed HMR default (avoided) | `24678` | — | Never used embedded; the reason `DISABLE_HMR` exists |

## Operational notes

- **First launch installs dependencies.** A missing `node_modules` triggers
  `npm install` before the dev server serves — the one-time wait on a fresh
  clone. Node.js (already a theDAW prerequisite) must be on PATH.
- **The sidecar owns the process.** theDAW starts it on demand and stops it
  cleanly on backend exit (`atexit` + FastAPI shutdown hook). Do not launch a
  second `npm run dev` on `5472` by hand; the sidecar treats a foreign listener
  on its port as an error and refuses to iframe it.
- **Diagnostics are in one file.** Every sidecar spawn writes to
  `data/logs/foundry-sidecar.log`; its tail is echoed into the `/api/foundry/url`
  503 detail and the tab's error card.
- **Design-time vs runtime wiring are separate.** A control that should move a
  theDAW parameter *while designing* goes over `dawControlBus` (WS `:8600`); a
  control in an *exported* `.gan` goes over `postMessage` through `aresBridge`.
  A break in one is not a break in the other.
- **Re-package to ship layout fixes.** Because runtimes are stamped with the
  `.gan` mtime and HTML is served `no-cache`, rebuilding a bundled surface (or
  re-importing an export) is enough to push a layout change to an already-open
  stage — no manual cache clearing.
