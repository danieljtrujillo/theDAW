## Perform, Foundry & Audimate

Three center-panel tabs that extend theDAW beyond linear editing: a live scene/clip launcher, an embedded plugin-UI designer, and a node-graph generation pipeline. All three are registered in `CenterTabBar.tsx` (labels **Perform**, **Foundry**, **Audimate**) and mounted from `DAWCenterPanel.tsx`.

### Perform (Session grid)

`SessionView` turns any imported DAW project — or a saved `.tasmo` — into an Ableton-style **tracks x scenes** launch grid with a per-track mixer, master meter, transport, and elapsed clock (`DawSessionGrid.tsx`).

- **Scene launch.** Launching a row decodes every clip in it and starts them synchronously through the Web Audio engine. A missing or bad clip is logged and skipped so the rest of the scene still plays (`DawSessionGrid.tsx:295`). Audio clips stream from disk; MIDI clips are rendered to audio on the fly so their cells still sound.
- **Live metering** uses one `AnalyserNode` (fftSize 512) per playing clip, feeding per-track and master RMS bars.
- **Multi-DAW import** (`backend/modules/dawimport/`): direct parsers for **Ableton Live (.als)**, **Reaper (.RPP)**, **Logic (.logicx)**, **FL Studio (.flp)** via `pyflp`, **Audacity (.aup3)** via `py-aup3`, **Adobe Audition (.sesx)**, **Bitwig (.bwproject)**, and **Resolume Arena (.avc)**. Cubase and Pro Tools return export-to-audio guidance (proprietary binary). `collapse_silent_gaps()` trims dead air from imported arrangements.
- **`.tasmo` projects** (`backend/modules/project/`): a ZIP archive of `manifest.json` + a **MsgPack** project model, with optional embedded or linked audio. Saving from Perform also captures the Perform routing; loading re-hydrates it.
- **Perform routing** (`performRouting.ts`, `PerformRoutingPanel.tsx`): MIDI-learn binds an encoder/button to Scene Select / Launch / Stop / Scene +/-, or a control per scene row. Separately, the six Sway hand-tracking dimensions (strike/sway/pulse/glide/press/sculpt) route to a track's live **Volume** or **Mute**. Bindings persist to localStorage and inside the `.tasmo`.
- **Clip audio** is served by `/api/project/clip-audio`, which streams browser-native formats directly and transcodes DAW-native samples (AIFF/CAF/WV/WMA) to WAV via the backend ffmpeg helper, cached by path+mtime+size.

### Foundry (VST UI Foundry)

`FoundryView` embeds a separate in-repo Node/Express app, **VST UI Foundry**, in an iframe. It is a browser-based drag-and-drop builder for audio-plugin (VST/AU/AAX) and web-audio UIs — Knob, Slider, XY Pad, Meter, Waveform elements, a procedural glow engine, texture layering, themes, and export to React/TSX, JSON, or a JUCE-ready ZIP. Notable deps (`package.json`): `express ^5.2.1`, `react ^19.0.1`, `@monaco-editor/react ^4.7.0`, `@imgly/background-removal ^1.7.0` on `onnxruntime-web 1.21.0-dev.20250206-d981b153d3` (in-browser ONNX), `motion`, `jszip`. Per its README it also ships a multi-provider AI co-designer and AI texture generation (e.g. `gpt-image-1`, ESRGAN, ControlNet, Stable Diffusion) with runtime model discovery.

theDAW only hosts the iframe. A Python sidecar (`backend/modules/foundry/sidecar.py`) spawns and supervises the Node server on port **5472**: in production it runs the compiled `dist/server.cjs` directly with a bundled node (no npm/install); in dev it npm-installs then runs the Vite+Express dev server. It is spawned lazily on the first `/api/foundry/url` call and torn down at exit; a 503 surfaces the diagnostic verbatim.

### Audimate (node-graph pipelines)

`AudimateView` is a hand-rolled pannable/zoomable node canvas (no node-editor library) with a grouped palette and per-node inspector. Node kinds: **Library** (source), **Generate**, **Magenta**, **Effect**, **Merge/Mix**, **Feedback**, **Output**. The runner (`audimateRunner.ts`) topologically walks the DAG and reuses existing backend contracts — no new endpoints:

- **Generate** → `POST /api/generate-jobs`, poll `/api/jobs/{id}` (Stable Audio models `small` / `medium`).
- **Magenta** → `POST /api/magenta/generate`, poll `/api/magenta/jobs/{id}` (model `magenta-small`, "Magenta RT2").
- **Effect** → single-shot `POST /api/studio/process` (default `mastering_chain`; the inspector swaps in each effect's own params).
- **Merge** mixes inputs offline via `OfflineAudioContext` with optional normalization; **Output** can save into the Library.
- **Feedback** loops are bounded: the sub-graph reachable from a Feedback node re-runs up to its iteration count; everything else runs once and is cached.

The graph (nodes/edges/viewport) persists across reloads; run state is transient.

### Offline / performance

Perform, `.tasmo`, and Audimate are fully local: parsing runs on the FastAPI backend, playback is browser Web Audio, and Generate/Magenta call the local Stable Audio and Magenta sidecars (no external key). Foundry's builder runs locally too; only its optional AI co-designer/texture features need an external provider key or a local engine (Ollama / LM Studio / local Stable Diffusion). Efficiency comes from lazy-warmed tabs, cached/pre-warmed clip buffers, cached transcodes, silent-gap collapsing, a lazily-spawned Foundry sidecar, and Audimate's cache-everything-but-feedback execution.
