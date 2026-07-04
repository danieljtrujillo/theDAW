# Hosting VST3 plugins and .gan web plugins in MIX

The MIX tab processes a source audio file through an ordered effect chain.
The chain accepts three kinds of node: built-in FFmpeg effects served by the
backend, VST3 plugins hosted through pedalboard, and Ares-style rack effects
that bake client-side. A separate class of `.gan` web plugin renders in the
effect stage for control and display. This guide covers where VST and GAN sit
in the rail, how theDAW scans and hosts VST3 plugins, how a VST3 node joins the
chain and opens its native editor, how a `.gan` plugin loads and renders, and
how PROCESS CHAIN renders a chain that mixes these node kinds.

## The categorized effect rail

The effect rail is the left column of MIX. It lists categories, and the
selected category drives what the Library column shows. The rail defines these
entries in order:

- All: every effect in MIX, grouped by category.
- Studio: Studio modules, the Ares control surface, and the psychoacoustic
  effects.
- Magenta: Magenta RealTime 2 generative instruments (Collider, Jam, MRT2).
- VST: VST3 plugins hosted through pedalboard. Adding one places a `vst3` node
  in the chain.
- Plugins: `.gan` web plugins. Open a `.gan` file or import a VST Foundry
  export. The plugin renders in the effect stage.
- The FFmpeg categories from the effect catalog: Stacks, Dynamics, EQ, Tempo,
  Cleanup, Export.

Each rail button shows a count on the right. The VST count reflects the number
of scanned VST3 plugins. The Plugins count reflects the number of installed
`.gan` plugins. Selecting a category changes the Library heading and the
browser body below it.

Under the category list sits Quick Master, a set of four knobs (Punch, Air,
Drive, Ceil) that add or sync a mastering-chain entry in the chain.

## VST3 hosting through pedalboard

The `vst` backend module declares its manifest in
`backend/modules/vst/module.json`. It mounts under the `/api/vst` prefix and
describes itself as VST3 plugin hosting through pedalboard (Spotify) with scan,
load, chain, and process operations. The module has no sidebar entry; it is
reached from the MIX rail.

### Scanning

`GET /api/vst/scan` scans the standard VST3 directories and caches the result.
Passing `refresh=true` forces a live rescan and rewrites the cache. The Library
column exposes this as a rescan action on the VST category. `GET /api/vst/scan/{path}`
scans a custom directory and never caches. Each scanned plugin returns its
descriptor, including path, name, manufacturer, and category.

The MIX VST browser lists each scanned plugin as a row or a tile. A plugin
already present in the chain is marked. VST tiles have no captured native
faceplate, so each renders a generated thumbnail seeded from the plugin name
and manufacturer.

### Loading and processing

Two processing paths exist. `POST /api/vst/load` loads a plugin into a
persistent instance registry and returns its parameter descriptors, and
`POST /api/vst/process` runs an ordered list of loaded instance IDs over a file
on disk. The MIX chain uses the stateless path instead: `POST /api/vst/process-file`
accepts an uploaded audio file, a plugin path, an optional parameter map, and an
optional captured `raw_state`, loads the plugin fresh, processes the audio, and
returns processed WAV bytes. The plugin is discarded after the call and never
enters the instance registry. This mirrors the FFmpeg `/api/studio/process`
call so a VST3 can act as one stage of the chain.

pedalboard expects float32 audio laid out as frames by channels. The backend
reads the uploaded audio with soundfile in that layout, runs the chain, and
writes WAV back.

## Adding a VST3 node and opening its editor

Clicking a VST in the browser adds it to the chain once and opens its native
GUI in the same action. Re-clicking a plugin already in the chain reopens its
editor rather than adding a duplicate. The chain entry carries an `effect`
value of `vst3` plus a `vst` object holding the plugin path, plugin name, and
an optional captured `raw_state`.

The native editor runs in a sidecar process because pedalboard's `show_editor()`
blocks its thread and must run on a process main thread.
`POST /api/vst/open-editor` launches the sidecar. On Electron with a parent
window handle and rect, the editor reparents into that window and clips to the
host box; without a parent handle it opens as a floating window. When the editor
window closes, the sidecar writes the plugin's full state to a per-plugin JSON
file. The frontend polls `GET /api/vst/editor-result` and stores the returned
`raw_state` on the chain node, so the dialed-in sound is reused at process time.

`VstEmbedHost` is the host box in the MIX effect stage. It reports its geometry
and scroll offset to `POST /api/vst/editor-rect` as the box moves, resizes, or
scrolls, and the sidecar watcher repositions the native window to match. The
box polls `GET /api/vst/editor-size` for the plugin's natural window size and
sizes an inner spacer to it, so an oversized editor keeps its true size and is
reached by scrolling. Expand grows the box to a large overlay. Close sends a
close request through the rect endpoint. The editor is never closed on React
unmount, so panel re-renders and StrictMode do not close it.

## Loading and rendering a .gan web plugin

The `plugin` backend module declares its manifest in
`backend/modules/plugin/module.json`. It mounts under `/api/plugin` and imports
and runs `.gan` web plugins (pseudo-VSTs). It imports VST Foundry exports,
serves the plugin UI to an iframe, and relays the plugin's control output to
theDAW targets. Like the VST module it has no sidebar entry.

A `.gan` file is a portable bundle. On open, the backend extracts the bundle to
a runtime directory and returns the manifest plus an entry URL of the form
`/api/plugin/<id>/runtime/<entry>`. The frontend client in
`frontend/src/lib/ganClient.ts` exposes the operations: `list` returns installed
plugins from `data/plugins`, `open` installs and opens a `.gan` at an arbitrary
path, `openById` opens an already-installed plugin, and `importOwl` imports a
VST Foundry export (a `project.json` or its folder) into a `.gan`. Two bundled
surfaces have dedicated build calls: `packageOwl` builds The Owl sidecar plugin
and `packageAres` builds the Ares control surface.

`GanPluginStage` renders the open plugin in the effect stage footprint, the same
spot Studio modules land. It iframes the entry URL served from the backend
runtime. The runtime letterboxes its canvas to preserve aspect ratio, so an
oversized plugin shrinks to fit rather than overflowing. Expand pops the iframe
to a near-fullscreen overlay while keeping the same iframe source, so the
plugin's control state and wiring persist across the toggle. The plugin's
control postMessages bubble to the app for a host to route. With no plugin open,
the stage shows a prompt to open a `.gan`.

Opening or importing a `.gan` from the Plugins browser sets it as the active
plugin and hands the effect stage to it. Ares sits under the Studio category.
Picking it ensures one `ares` composite effect is in the chain, focuses that
entry, and opens the Ares `.gan` surface in the stage.

## PROCESS CHAIN over mixed node kinds

PROCESS CHAIN runs the enabled entries in visible order over the source file.
The run guards against an empty source or an empty chain and reports a MIX
status message.

Rack effects (the psychoacoustic and Ares entries) bake client-side through
Web Audio and are unknown to the backend. The chain is walked in visible order
and split into consecutive segments of two kinds: runs of backend or VST
effects rendered over HTTP, and runs of rack effects baked offline. Each
segment's output feeds the next, so an interleaved arrangement bakes in the
exact order the chain shows.

Within a backend-or-VST segment, each entry processes in turn. A `vst` entry
calls the VST path with its plugin path, plugin name, parameter map, and
captured `raw_state`. Any other entry calls the FFmpeg `/api/studio/process`
path with its effect id and parameters. Each stage runs with the library save
skipped, so only the final result is saved. Its output blob becomes the input
file for the next stage. A rack segment bakes its run offline; a bake failure
returns the input unchanged so the pipeline still completes.

After the last segment, the final blob becomes the MIX output, plays back, and
is imported into the Library tagged as an effects chain. The chain label joins
every enabled stage name, using the plugin name for VST nodes and the effect
label otherwise.

`.gan` web plugins are not audio stages in PROCESS CHAIN. They render in the
effect stage for control and display. PROCESS CHAIN relays their control output
to theDAW targets and does not mix them into the offline render.

## Platform and format support

The `vst` manifest declares hosting through pedalboard (Spotify) and the VST3
format. The stateless process endpoint reads and writes audio with soundfile
and returns WAV. The native-editor embedding path targets Electron on Windows,
where the sidecar reparents the plugin window into the host BrowserWindow by its
window handle; without a parent handle the editor opens as a floating window on
any platform pedalboard supports.

The `plugin` manifest declares `.gan` web plugins (pseudo-VSTs) and import of
VST Foundry exports. The plugin UI is served to an iframe from the backend
runtime, so a `.gan` runs wherever the backend and a browser context are
available.
