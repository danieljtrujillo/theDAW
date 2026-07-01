# GANduit

A native **VST3 / CLAP / AU** controller shell that renders a `.gan` web UI in a
WebView and forwards its controls to the host DAW as **parameter automation +
MIDI CC**. It is how a GANTASMO `.gan` surface (the same one theDAW shows in the
MIX Effect Stage) loads into Ableton, Reaper, Bitwig, FL, and other plugin hosts.

Audio passes through untouched: GANduit is a control surface, not a DSP effect.
Drop it on a track or bus, load a `.gan`, and the surface's knobs/sliders/pads
write automation and emit CC exactly like a hardware controller.

> Status: **scaffold.** The C++ here is a faithful starting point modeled on the
> iPlug2 `IPlugWebUI` example, but it is not built in this repo - it needs the
> iPlug2 C++ toolchain (Visual Studio on Windows, Xcode on macOS). theDAW's
> Python/Node environment cannot compile it. `scripts/setup.ps1` stages the
> iPlug2 tree and project; the steps below finish the wiring.

## Why iPlug2 (not JUCE)

iPlug2 is **zlib/permissive** licensed (JUCE is GPL/commercial), ships a native
WebView editor delegate (Windows WebView2, macOS WKWebView), and targets VST3,
CLAP, AU, AAX, and standalone from one codebase. That matches GANduit's job:
host a web surface and bridge it to the DAW with no DSP and no license friction.

## Architecture

```
 .gan file (ZIP + manifest.json + index.html + assets, "GANv1" comment)
      |  GanArchive::ExtractGan()  (miniz, zip-slip guarded)
      v
 temp runtime dir / index.html  --->  iPlug2 WebView (WebView2 / WKWebView)
      ^                                      |
      |  web bridge (IPlugSendMsg / SPVFUI)  |  user moves a knob
      |                                      v
 GANduit (Plugin)  <----  OnParamChangeUI / OnMessageFromWebView
      |
      |  OnParamChange(idx):
      |    - host sees parameter automation (GetParam(idx))
      |    - SendMidiMsg( CC mParamToCC[idx], value*127 )
      v
 DAW: automation lane + MIDI CC stream
```

- **`src/config.h`** - plugin metadata (GANTASMO mfr, IDs, 2-2 + MIDI I/O,
  `GANDUIT_NUM_PARAMS` macros).
- **`src/GANduit.{h,cpp}`** - the plugin class: pass-through `ProcessBlock`,
  `OnParamChange` -> automation + MIDI CC, WebView load of the active `.gan`.
- **`src/GanArchive.{h,cpp}`** - `.gan` reader (validates the `GANv1` comment,
  reads `manifest.json`, extracts to a temp runtime dir, returns `index.html`).
  This mirrors theDAW's writer in `backend/modules/plugin/gan_file.py`.

### `.gan` <-> shell contract

Each macro parameter (`Macro 1..N`) is host-automatable and maps 1:1 to a MIDI CC
(`Macro 1 -> CC 1`, ...). A `.gan` surface drives them over the iPlug2 web bridge:

```js
// from the .gan's index.html
IPlugSendMsg({ tag: "param", idx: 0, value: 0.42 });   // set Macro 1 (0..1)
IPlugSendMsg({ tag: "loadGan", path: "C:/path/to/other.gan" });  // hot-swap
```

The shell echoes host-side automation back to the UI via `OnParamChangeUI`, so
DAW automation moves the on-screen control too.

## Build

Prereqs: Git, Python 3, and the platform toolchain (Visual Studio 2022 with the
"Desktop development with C++" workload on Windows; Xcode on macOS). On Windows
the WebView2 Evergreen runtime must be installed.

```powershell
cd ganduit
pwsh ./scripts/setup.ps1      # clones iPlug2, duplicates IPlugWebUI -> project/, overlays src/
```

Then, per iPlug2's docs:

1. Install iPlug2's prebuilt dependencies:
   - `iPlug2/Dependencies/download-prebuilt-libs.sh` (Git Bash)
   - `iPlug2/Dependencies/IPlug/download-iplug-sdks.sh` (VST3 SDK, etc.)
2. Add **miniz** to the project include path (vendored with iPlug2, or drop in
   the single-file `miniz.h`/`miniz.c`) so `GanArchive.cpp` resolves.
3. Open `project/GANduit/GANduit.sln` and build the **VST3** and **CLAP** targets
   (Release x64). Artifacts land in the per-format build output.
4. Copy/symlink the built `GANduit.vst3` / `GANduit.clap` into the OS plugin
   folders, rescan in your DAW.

### Finish the wiring (scaffold TODOs)

- `OnMessageFromWebView` is wired: it parses the `{tag}` message and dispatches
  `loadGan` (-> `LoadGan(path)`) and `param` (-> `SendParameterValueFromUI(idx,
  value)`), with dependency-free JSON extractors. Swap those for iPlug2's vendored
  JSON lib if you prefer.
- Confirm the WebView editor-delegate method names against the **pinned iPlug2
  version** (the `IPlugWebUI` example is the reference): `mEditorInitFunc`,
  `LoadFile`, `LoadHTML`, `OnParamChangeUI`, `OnMessageFromWebView`,
  `SendParameterValueFromUI`.
- `.gan` source: ship a default `.gan` in resources, or let the host pass a path
  (persisted in the state chunk - `PLUG_DOES_STATE_CHUNKS` is on).

## Relationship to theDAW

- theDAW **writes** `.gan` files (`backend/modules/plugin/gan_file.py`,
  `GANv1` comment) and hosts them in MIX via an iframe (`GanPluginStage`).
- GANduit **reads** the same `.gan` and hosts it inside a third-party DAW.
- One surface, two hosts: the MIX Effect Stage in theDAW, and a VST3/CLAP/AU in
  any DAW. The Owl (theDAW's first `.gan`) is the reference surface.
