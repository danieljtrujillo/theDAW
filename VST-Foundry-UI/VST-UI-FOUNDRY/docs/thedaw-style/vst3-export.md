# VST3 Export — From Canvas to Plugin Binary

Reference for Foundry's **VST3 export** path: how a canvas of knobs, sliders and
meters becomes a loadable VST3 plugin. Foundry does not compile a binary. It
emits a small **data bundle** (a manifest plus a self-contained web UI) that a
prebuilt native **shell** — an iPlug2 WebView plugin called *FoundryShell* —
reads at load time. This doc covers both halves: the browser-side exporter
(`vst3Export.ts`, `vst3ExportUi.ts`, the `vst:` bind system, the Export modal)
and the native side (`FoundryShell.cpp/.h`, `config.h`, the JS bridge, the
MSBuild project), plus what the export tests hold in place. Plain descriptions of
what each piece does.

For the rest of Foundry see [foundry-overview.md](foundry-overview.md); for
theDAW's own native plugin filetype see [gan-format.md](gan-format.md); for the
controls that become parameters see
[canvas-and-controls.md](canvas-and-controls.md).

## The two halves of a Foundry VST3

A Foundry-exported plugin is always two separate artifacts that meet on disk:

| Half | Produced by | Contains | Compiled? |
|---|---|---|---|
| **Data bundle** | `src/lib/vst3Export.ts` (browser) | `manifest.json`, `ui/index.html`, `ui/params.js`, `README.txt` | No |
| **Native shell** | `vst3-shell/` MSBuild project | `FoundryShell.vst3` (a WebView2-hosting DLL) | Yes, once |

The bundle is regenerated every time you tweak a design. The shell is built once
and reused for every plugin — it is generic. At load time the shell resolves its
own `Contents/Resources/` directory, reads `manifest.json` to declare its
parameters, and points its WebView at `ui/index.html`. Rename the shell folder,
drop a bundle inside it, and you have a plugin.

> The bundle carries no binary. `exportVst3Bundle` in `vst3Export.ts` explicitly
> "packages the data half of the plugin" — the prebuilt `FoundryShell.vst3` is a
> separate download. See *Installing an export* below.

## Opening the exporter

Export lives in `src/components/ExportModal.tsx`, a three-tab modal:

| Tab | Output | Entry point |
|---|---|---|
| **React Code** | A `UIModule.tsx` component string (copy to clipboard) | `generateCode()` (inline) |
| **VST3 Bundle** | The `.zip` data bundle described here | `exportVst3Bundle(...)` |
| **.gan Plugin** | theDAW's native `.gan` filetype (see [gan-format.md](gan-format.md)) | `exportGan(...)` |

The VST3 tab has one option — a **Plugin name** text field — and a live summary
line: *"N parameters from M controls."* Both the summary and the export call
`buildVst3Manifest(...)`, so the count you see is exactly the count that ships
(the modal memoizes the manifest to keep them from drifting). An empty name
falls back to `Foundry Plugin`. The **Export .zip** button calls
`exportVst3Bundle` and surfaces any failure as an inline error rather than a
silent console log.

## What becomes a parameter

`buildVst3Manifest(elements, canvasState, pluginName)` walks the design in
**element order** and emits host-visible parameters. Each element type maps to a
fixed set of parameters:

| Element type | Params emitted | Kind | Range / notes |
|---|---|---|---|
| Knob, Slider, Meter | 1 | `continuous` | `min`/`max` from the element (default `0`/`100`); default = `value` or midpoint |
| WaveShaper | 1 (`<id>`) | `continuous` | named `<name> Drive`, `0..100` |
| Toggle | 1 | `boolean` | default `false` |
| Button | 1 | `trigger` | momentary |
| Select | 1 | `enum` | `options[]`; **always `cc = -1`** |
| XYPad, Spatial3D | 2 (`<id>-x`, `<id>-y`) | `continuous` | each `0..100`, default `50` |
| Envelope | 4 (`-attack`/`-decay`/`-sustain`/`-release`) | `continuous` | `0..100`; defaults read from `styleParams` (15/30/70/25) |
| CustomCode | 1 per **numeric** param | `continuous` | id `<element-slug>-<param-slug>`; handled specially (below) |

Types that carry no single host-automatable scalar are skipped entirely:

| Skipped type | Why |
|---|---|
| Label, Image, Group | Not a control |
| Waveform | Display-only (can still be a *listen* target — see binds) |
| StepSequencer | Multi-cell pattern, no single scalar |
| Keyboard | Note input, no single scalar |
| CustomCode (the element itself) | Only its numeric params export, not the element |

### CustomCode parameters

CustomCode is a member of the skip set, but it is handled **before** the skip
gate: each param of `type: "number"` becomes its own continuous host parameter,
id `<element-slug>-<param-slug>`, named `<element name> <label|key>`. A
zero-width range (`min === max`) is repaired to `min..min+1`. The default is the
param's explicit `default`, else its `value`, else the range midpoint. A
CustomCode element with no numeric params yields nothing — unchanged from
before it was special-cased. See [custom-code.md](custom-code.md) for the param
schema and the sandbox bridge.

> The manifest is capped at **128 parameters** (`MAX_PARAMS`). Controls past the
> cap are dropped with a `console.warn`. The cap matches the shell's fixed
> `kMaxParams = 128` slot pool, so a design can never declare more params than
> the shell can hold.

## MIDI CC assignment

Every continuous/boolean/trigger parameter is handed a MIDI CC number from a
fixed pool, in order. The pool is deliberately shaped to avoid CC ranges that
would misbehave as automation:

| Pool order | CC numbers | Avoided | Reason |
|---|---|---|---|
| 1st | 20–31 | 0–19 | Mod wheel, bank select MSB, data entry, etc. |
| 2nd | 102–119 | 32–63 | CC LSB / bank-select pair range |
| 3rd | 64–119 (dedup) | 120–127 | Channel Mode messages (All Notes Off, Reset…) — would silence the channel |

No two parameters ever share a CC (the pool is de-duplicated). When the pool is
exhausted, remaining params get `cc = -1` (no CC mapping) and a warning is
logged. **Enum (`Select`) params are always `cc = -1`** — the shell does not emit
CC for discrete selections, so pulling from the pool would waste a slot and
starve continuous controls.

## Parameter ids and the slug contract

Every parameter id comes from one slug function, `foundrySlugify`, held as the
string constant `SLUGIFY_FN_SOURCE` in `vst3Export.ts`:

```js
function foundrySlugify(input) {
  var s = String(input == null ? "" : input).toLowerCase();
  s = s.replace(/[^a-z0-9]+/g, "-").replace(/^-+/, "").replace(/-+$/, "");
  return s || "param";
}
```

That exact source is `new Function()`-compiled in TypeScript to slug the
manifest ids, **and** injected verbatim into the exported `ui/index.html` so the
renderer slugs the same ids. The manifest ids and the UI's ids are therefore
byte-identical — the WebView can look a parameter up by string id and always
match the manifest. Never re-implement the slug on either side; the single
source is the whole point.

## The bundle on disk

`exportVst3Bundle` assembles a JSZip and triggers a browser download named
`<slug>-vst3-bundle.zip`:

| Entry | Built by | Purpose |
|---|---|---|
| `manifest.json` | `buildVst3Manifest` (pretty-printed) | Plugin identity + `params[]` + `bindings[]` |
| `ui/index.html` | `buildVst3Ui` → `buildIndexHtml` | Static, self-contained interactive UI (identical every export) |
| `ui/params.js` | `buildVst3Ui` | `window.FOUNDRY_DESIGN = {elements, canvasState, assets, textures}` |
| `README.txt` | `buildReadme` | Install instructions + param/bind counts |

`manifest.json` shape:

```json
{
  "formatVersion": 1,
  "plugin": { "name": "My Plugin", "width": 800, "height": 600 },
  "params":   [ /* Vst3Param */ ],
  "bindings": [ /* Vst3BindingEntry */ ]
}
```

`plugin.width`/`height` come from `canvasState` and tell the shell what editor
size to request.

> `ui/params.js` inlines any asset/texture whose `url` is already a `data:` URL,
> but leaves server-side `/textures/...` URLs untouched — a later build step must
> replace those with `data:` URLs for the bundle to be fully offline. No network
> fetch happens during export. See [textures-and-skins.md](textures-and-skins.md).

## The standalone UI

`vst3ExportUi.ts` emits the **static** `ui/index.html`. It is the same HTML for
every export; all design-specific data lives in `params.js`. The renderer is
plain vanilla ES5-ish JS (no React, no build step) and makes no network
requests. `buildIndexHtml` assembles exactly three `<script>` blocks, in order:

```html
<script src="foundry-bridge.js"></script>   <!-- native bridge, shipped by the shell -->
<script src="params.js"></script>           <!-- window.FOUNDRY_DESIGN -->
<script> /* the injected renderer */ </script>
```

The renderer talks to the plugin over the bridge:

- `window.foundryHost.setParam(paramId, 0..1)` — UI pushes a value to the plugin.
- `window.foundryApplyParam(paramId, 0..1)` — plugin pushes host automation /
  preset recall down to the UI.

It also embeds a **copy of the preview bind runtime** (see below), so LFOs,
macros, random S&H and a local transport animate bound displays even with no
host. When the native shell pushes a real value via
`window.__foundrySetBindValue(id, v)`, that id's shell value **suppresses the
local simulation for 1 second** — real data always outranks the simulation. The
renderer also runs a UI-clocked pull loop, sending `kMsgTagGetBindValues`
(`msgTag: 1`) to the shell about 20×/s to fetch transport and metering.

> In a plain browser (bundle preview, or a `.zip` opened outside the shell),
> `foundry-bridge.js` 404s and `window.IPlugSendMsg` is undefined. The
> renderer's guards make that harmless: the UI runs **view-only**, driven only by
> its local bind runtime. This is expected, not an error.

## Control-to-param binding — the `vst:` catalog

A control can do more than expose a parameter — it can be **bound** to a
built-in "VST target": send a MIDI CC, fire a note, drive output gain, mirror the
host transport onto a meter, and so on. These targets live in `vstBinds.ts` as a
catalog of `DawTarget`-shaped entries, all namespaced `vst:`.

The catalog is deliberately **wider than any single runtime**. A given `vst:`
target may be honored in the in-app preview, forwarded to theDAW, and/or acted
on by the exported shell — or simply carried and ignored where nobody implements
it (never an error). The areas:

| Area | Example ids | Count | Notes |
|---|---|---|---|
| MIDI Control Change | `vst:midi.cc.0` … `vst:midi.cc.127` | 128 | Named per General MIDI where known |
| MIDI Performance | `vst:midi.pitchbend`, `.aftertouch`, `.program`, `.panic` | 4 | |
| MIDI Notes | `vst:midi.note.0` … `.127` | 128 | Momentary pads; velocity = shaped value at press |
| Transport | `vst:transport.play/stop/record/loop/metronome/rtz/tap/tempo` | 8 | Write requests |
| Transport (listen) | `vst:transport.playing/beat/bar/playhead` (+ `tempo`) | 4 | `readonly` signals |
| Plugin | `vst:plugin.bypass/drywet/gain.in/gain.out/pan` | 5 | Only `gain.out` + `pan` act in the shell today |
| Macros | `vst:macro.1` … `.8` | 8 | Virtual knobs; write from any control, listen from any display |
| LFOs | `vst:lfo.1..4` + each `.rate/.depth/.shape` | 16 | Shapes: sine/triangle/saw/square/s&h |
| Modulation | `vst:mod.random`, `.random.rate`, `.envfollow` | 3 | Envelope follower fed by the shell's input RMS |
| Presets | `vst:preset.next/prev/save/init/random/ab/copyab` | 7 | No shell action yet; carried + daw-forwarded |
| Metering | `vst:meter.in.l/in.r/out.l/out.r/out.peak/clip/gr` | 7 | Listen sources |
| Metering (spectrum) | `vst:meter.band.1` … `.8` | 8 | No publisher yet; read 0 until one lands |

`isVstBindId(id)` tests the `vst:` prefix; `vstWriteBinds()` returns the writable
entries (the route browser's built-in section) and `vstListenBinds()` the
`listen: true` entries (the ListenPicker's built-in section). `readonly` entries
are excluded from the write picker.

### Route vs listen entries in the manifest

`buildVst3Bindings` collects every `vst:` bind in the design into
`manifest.bindings[]`. Each entry (`Vst3BindingEntry`) is one of two modes:

| Mode | Meaning | Ships when |
|---|---|---|
| `route` | A control param drives the target: shape `amount → curve → range`, then perform the action | Only if the source param survived the 128-param cap |
| `listen` | A display element animates from the target's live value | Always (a Waveform exports no param yet still animates) |

Route bindings are drawn from the element's **route stack** (`routesOf(el)` in
`src/lib/routing.ts`), including all `vst:` routes, not just the first — one knob
can drive CC 74 **and** a macro **and** an LFO rate. For XYPad/Spatial3D the axis maps onto the `-x`/`-y` param id. CustomCode
per-param binds ship as unshaped routes (the param *is* the value). Meter and
Waveform `binding.targetId`s ship as `listen` entries; the Meter carries its
param id, the Waveform does not.

### Route shaping math

The shaping applied to a route value is identical in three places — the
in-app preview (`routing.applyRoute`), the exported UI runtime, and the native
shell (`ShapeBind` in `FoundryShell.cpp`):

| Stage | Operation |
|---|---|
| Amount (`-100..100`) | `amt >= 0 ? src*amt : (1-src)*-amt` — negative inverts |
| Curve | `linear` \| `exp` (`v³`) \| `log` (`1-(1-v)³`) \| `scurve` (smoothstep `v²(3-2v)`) |
| Range | clamp into `rangeMin..rangeMax` (0..100) |

Keeping the three implementations in lockstep is why the same `amount/curve/
rangeMin/rangeMax` fields ride in every binding entry.

### The preview bind runtime

`vstBindRuntime.ts` owns the live state behind every `preview: true` catalog
entry so designs animate with no theDAW and no audio:

| State | Behavior |
|---|---|
| Macros 1–8 | Virtual knobs: a write is held and re-published to listeners |
| LFO 1–4 | Free-running oscillators; `rate`/`depth`/`shape` writable; `s&h` re-samples on phase wrap |
| Random S&H | Clocked sample-and-hold noise (`vst:mod.random`) |
| Local transport | play/stop/record/loop/metronome/tap; publishes playing, beat phase, bar phase (4/4), playhead |

It registers `handleVstBindWrite` via `setVstWriteHandler` at module load, and
`tickVstBindRuntime(dt)` (driven by a `requestAnimationFrame` loop) advances the
oscillators and publishes **only** ids that currently have listeners
(`hasDawValueListeners`). `dt` is clamped to `0.25s` so a backgrounded tab never
jumps state. The exported UI carries a near-identical copy of this runtime so
the plugin behaves the same offline. MIDI / preset / plugin-master ids have no
preview-local state — the bus forward and the shell own those.

## The native shell — iPlug2 FoundryShell

`FoundryShell` is a generic iPlug2 **WebView** plugin
(`IPlugWebViewEditorDelegate`, not IGraphics) that hosts an HTML/JS UI in a
native WebView2 (Windows) / WKWebView (macOS). Identity and capabilities are
fixed in `config.h`:

| Macro | Value | Meaning |
|---|---|---|
| `PLUG_NAME` | `FoundryShell` | Plugin name |
| `PLUG_MFR` | `theDAW` | Manufacturer |
| `PLUG_VERSION_STR` | `1.0.0` | Version |
| `PLUG_UNIQUE_ID` | `'Fdsh'` | Plugin unique id |
| `PLUG_MFR_ID` | `'StDw'` | Manufacturer id |
| `PLUG_TYPE` | `0` | Effect |
| `VST3_SUBCATEGORY` | `Fx` | VST3 category |
| `PLUG_CHANNEL_IO` | `2-2` | Stereo in / stereo out |
| `PLUG_LATENCY` | `0` | No reported latency |
| `PLUG_DOES_MIDI_IN` / `_OUT` | `1` / `1` | MIDI in and out |
| `PLUG_DOES_MPE` | `0` | MPE off |
| `PLUG_HAS_UI` | `1` | Has an editor |
| `PLUG_WIDTH` × `PLUG_HEIGHT` | `600` × `600` | Default editor size |
| `PLUG_FPS` | `60` | Editor refresh |
| `PLUG_HOST_RESIZE` | `1` | Host may resize the editor |

`config.h` also declares AUv2 entry points and AAX type ids, so the same source
targets VST3, AU and AAX.

### Construction and manifest load

At construction (`FoundryShell.cpp`) the shell:

1. Resolves its bundle `Contents/Resources/` dir via `BundleResourcePath`
   (`gHINSTANCE` on Windows VST3).
2. Calls `LoadManifest`, which parses `manifest.json` with `nlohmann::json`
   using **type-tolerant** field readers (a Toggle's `"default": false` must not
   throw when read as a number), initializes up to `kMaxParams = 128` iPlug2
   params by kind, and reads `plugin.width`/`height` to `SetEditorSize`.
3. Parses `bindings` (via `LoadBindings`) **after** params, so `paramId → index`
   resolution sees the full list.

Kind maps to an iPlug2 init call:

| Manifest kind | iPlug2 init | Notes |
|---|---|---|
| `continuous` | `InitDouble(min, max)` | Range guarded (`max > min`); default clamped and finite-checked |
| `boolean` | `InitBool(default)` | |
| `trigger` | `InitBool(false)` | |
| `enum` | `InitEnum(default, nOptions)` | Per-option display text set from `options[]` |

> If `manifest.json` is missing or corrupt, the constructor **falls back to a
> single Gain parameter emitting CC 7** so the plugin always constructs and
> loads. Unused slots (`n`..127) become hidden, non-automatable dummies. The
> manifest load is wrapped so no manifest content can ever abort construction.

### The native <-> web bridge

`resources/web/ui/foundry-bridge.js` is the JS half of the bridge, shipped
inside the bundle beside `index.html`. It builds the Foundry contract on top of
iPlug2's injected `IPlugSendMsg`:

| Direction | Call | Wire |
|---|---|---|
| UI → plugin | `foundryHost.setParam(id, 0..1)` | `SAMFUI` `msgTag 0` (`kMsgTagSetParam`), payload `base64({id, v})` |
| UI → plugin | pull loop | `SAMFUI` `msgTag 1` (`kMsgTagGetBindValues`), no payload |
| plugin → UI | param map | `window.__foundrySetParamMap(entries)` (index/id/elementId/kind/cc) |
| plugin → UI | automation / recall | `SPVFD(index, v)` → `foundryApplyParam(id, v)` |
| plugin → UI | listen values | `window.__foundrySetBindValue(id, v0to100 \| bool)` |

On `OnMessage`, `kMsgTagSetParam` maps the string `paramId` to its index and
calls `SendParameterValueFromUI` (wrapped in `Begin/EndInformHostOfParamChange`).
`OnUIOpen` pushes the param map first, then the current value of every param, so
the JS handler can translate incoming automation before any arrives.

### DSP and MIDI (`ProcessBlock`)

`ProcessBlock` is a **pure stereo passthrough** (handling in/out aliasing and
channel-count mismatch), plus:

- **Smoothed output gain / pan** — only when a `gain.out` or `pan` bind exists.
  Balance law (unity at center) so binding a centered pan control never changes
  level; per-sample smoothing avoids zipper noise.
- **CC emission** — every continuous/boolean/trigger param is diffed each block;
  a changed value emits a MIDI CC on channel 1. Diffing on the audio thread is
  realtime-safe and catches both UI edits and host automation. Enum params are
  skipped.
- **Built-in binds** — for each route bind whose param changed, `ShapeBind`
  shapes the normalized value and performs the action.
- **Listen telemetry** — when anything is bound as `listen`, transport is read
  from the host's `ITimeInfo` and post-fader I/O RMS + peak + a block-rate
  envelope follower are computed and stored in `std::atomic`s for the UI pull.

Bind actions the shell implements natively (`ParseBindTarget` →
`EFoundryBindAction`); anything else parses to `None` and is carried but ignored:

| `vst:` id | Action | Behavior |
|---|---|---|
| `vst:midi.cc.N` | MidiCC | CC N on channel 1, quantized 0..127 |
| `vst:midi.note.N` | MidiNote | Gate at shaped ≥ 0.5; velocity = shaped value at rising edge |
| `vst:midi.pitchbend` | MidiPitchBend | 14-bit, bipolar around center |
| `vst:midi.aftertouch` | MidiAftertouch | Channel pressure 0..127 |
| `vst:midi.program` | MidiProgram | Program change 0..127 |
| `vst:midi.panic` | MidiPanic | Rising edge → CC 120 (All Sound Off) + All Notes Off |
| `vst:plugin.gain.out` | GainOut | Master output gain, −60..+12 dB, smoothed |
| `vst:plugin.pan` | Pan | Master balance, unity at center |

Listen ids the shell publishes back (`PushBindValuesToUI`, on the UI thread in
answer to the pull): `vst:transport.tempo/beat/bar/playhead/playing`,
`vst:meter.in.l/in.r/out.l/out.r/out.peak/clip`, and `vst:mod.envfollow`. Meter
values use a `sqrt(RMS) × 100` scale. LFO / macro ids are skipped (the UI's local
runtime owns them); spectrum and gain-reduction ids are skipped (no publisher
yet). `OnReset` forces CC re-emission and releases all gates.

## Installing an export into the shell

From the bundle's `README.txt`, the manual install:

```text
1. Obtain the prebuilt native shell "FoundryShell.vst3".
2. Copy the CONTENTS of the bundle (manifest.json and the ui/ folder) into:
       FoundryShell.vst3/Contents/Resources/
3. Rename the "FoundryShell.vst3" folder to your plugin name, e.g. MyPlugin.vst3
4. Install the .vst3 folder in your system VST3 directory and rescan in your DAW.
```

The bundle's `ui/index.html` expects the shell's `foundry-bridge.js` to sit
beside it in `Resources/ui/` — the shell ships that file, and the bundle drops
`index.html` + `params.js` in next to it.

## Building the native shell

The shell is built by MSBuild on
`vst3-shell/FoundryShell-src/projects/FoundryShell-vst3.vcxproj`:

| Property | Value |
|---|---|
| PlatformToolset | `v143` |
| ConfigurationType | `DynamicLibrary`, `TargetExt` `.vst3` |
| Configurations | `Debug`, `Release`, `Tracer` |
| Platforms | `x64`, `ARM64EC` |
| Output | `$(SolutionDir)build-win/vst3/<Platform>/<Configuration>/` |
| WebView2 loader | `WebView2LoaderPreference = Static` |

It compiles `FoundryShell.cpp` alongside the Steinberg VST3 SDK sources, the
iPlug2 IPlug/VST3 core, the WebView delegate (`IPlugWebView_win.cpp`,
`IPlugWebViewEditorDelegate.cpp`), and `WDL/win32_utf8.c`. Two NuGet packages
must be restored first, or `EnsureNuGetPackageBuildImports` errors out:

| Package | Version |
|---|---|
| `Microsoft.Web.WebView2` | `1.0.2903.40` |
| `Microsoft.Windows.ImplementationLibrary` (WIL) | `1.0.240803.1` |

`vst3-shell/nuget.exe` (a ~8.5 MB PE32 .NET console tool) is the restorer. After
the build, the `CopyFoundryWebUI` post-build target copies
`resources/web/ui/**` into the built `.vst3`'s `Contents/Resources/ui/` (and
into the installed `VST3_X64_PATH` copy), so the shell runs standalone with its
default UI before any Foundry export is dropped in.

> The `vst3-shell/iPlug2/` folder is a full iPlug2 SDK clone and is **gitignored**
> ("iPlug2 clone is huge — never commit it"), as is the VST3 SDK under
> `Dependencies/`. A clean checkout cannot build the shell until those are
> re-fetched.

> The `.vcxproj` uses iPlug2-example-relative include paths (e.g.
> `..\..\..\IPlug`, `..\..\..\Dependencies\IPlug\VST3_SDK`), so it is templated
> to live under `iPlug2/Examples/FoundryShell/projects/` inside the SDK clone. It
> also references build inputs that are **not** in the checked-in
> `FoundryShell-src` tree: `config/FoundryShell-win.props` (which supplies
> `VST3_DEFS`, `BUILD_DIR`, `BINARY_NAME`, `VST3_X64_PATH`, …), `resources/
> resource.h`, `resources/main.rc`, `projects/packages.config`, and
> `projects/packages/`. These come from the iPlug2 example scaffold and must be
> present at build time.

> Note: the shell sources are under active development (`config.h` is currently
> modified in the working tree). Treat the identity macros and DSP details above
> as the current on-disk state, which may be mid-change.

## What the export tests lock in

Two Vitest suites protect the exporter contract:

| Test file | Locks in |
|---|---|
| `vst3ExportBindings.test.ts` | One shaped `route` entry per `vst:` route on a param element; XY axes map onto `-x`/`-y` ids; `listen` entries for bound Meter (with param) and Waveform (no param); CustomCode per-param `vst:` binds as unshaped routes; empty `bindings` for an unbound design (field always present); legacy single-target migration via `routesOf` |
| `vst3ExportCustomCode.test.ts` | One continuous param per numeric CustomParam with slugged namespaced ids; non-numeric params ignored; empty CustomCode emits nothing; zero-width range guarded to `min+1`; native params ride alongside without CC collisions; informational `binding` from `paramBindings`; the 128-param cap; and that the exported `index.html` embeds the real shared CustomCode bridge (`BRIDGE_BOOTSTRAP_SOURCE`) and has exactly three `</script>` closings |

Run them with the project's Vitest runner:

```bash
npm test -- vst3Export
```

These lock the two invariants the whole path depends on: parameter ids are
stable and slug-derived, and the `bindings` array faithfully mirrors the design's
`vst:` routes and listens so the native shell can act on them.

## Related docs

- [foundry-overview.md](foundry-overview.md) — the app around this path
- [canvas-and-controls.md](canvas-and-controls.md) — the controls that become params
- [custom-code.md](custom-code.md) — CustomCode params and the sandbox bridge
- [gan-format.md](gan-format.md) — theDAW's native `.gan` plugin filetype
- [textures-and-skins.md](textures-and-skins.md) — asset/texture inlining in the bundle
- [thedaw-integration.md](thedaw-integration.md) — the XR control bus and `vst:` forwarding
- [troubleshooting.md](troubleshooting.md) — when a plugin will not load or a bind does nothing
