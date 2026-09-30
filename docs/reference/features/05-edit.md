## EDIT — Timeline Arranger

The EDIT tab is theDAW's multi-track timeline. It arranges audio and MIDI clips, mixes them live, records parameter automation, and exports a mixdown — all in the browser, with only three features reaching the bundled local backend.

Core files: `frontend/src/components/audio/WaveformEditor.tsx` (view), `frontend/src/state/editorStore.ts` (document store), `frontend/src/state/liveMixer.ts` (playback engine), `frontend/src/state/effectChainStore.ts` + `frontend/src/lib/rackEffects.ts` (effects). The view is code-split and lazy-loaded (`DAWCenterPanel.tsx:82`).

### Arrangement
- **Tracks & clips** — add/remove tracks; drag clips horizontally (grid-snapped) or vertically between tracks; resize either edge (left edge also trims the source offset); split, duplicate (Ctrl/Cmd+D), and delete. Multi-select supports shift-range and ctrl-toggle. Zoom 5–400 px/sec via Ctrl+wheel. (`editorStore.ts:399`, `editorStore.ts:534`, `WaveformEditor.tsx:2043`)
- **Snap / BPM / loop / markers** — snap off · 1/4 · 1/8 · 1/16 against project BPM; a loop region cycles the transport; named markers seek on click (Phase F). (`editorStore.ts:860`, `liveMixer.ts:649`)
- **Undo/redo** — 100-step history, 300 ms burst-coalescing, snapshots share arrays (no blob cloning). (`editorStore.ts:319`)

### Waveform editor
Each clip renders a frequency-coloured waveform of its trim window on an HTML `<canvas>` (`DJSemanticWaveform`), decoded once via Web Audio and cached as a 240-bin peak array on the clip (`WaveformEditor.tsx:150`, `editorStore.ts:901`). The moving playhead is driven imperatively via refs to avoid re-rendering the clip tree at 60 fps (`WaveformEditor.tsx:449`).

### Live playback (liveMixer)
Play schedules every clip as a Web Audio graph — `BufferSource → clipGain (fade) → trackGain → muteGain → insert FX → panner → session master bus → master FX rack → engine master` — so **volume/pan/mute/solo and per-clip mute are audible mid-playback** (`liveMixer.ts:275`, `liveMixer.ts:179`). MIDI (piano-roll) clips play live through a SoundFont/GM synth, one channel per track, 16-channel cap, via **spessasynth_core ^4.3.10 / spessasynth_lib ^4.3.7** (`liveMixer.ts:564`).

### Automation (Phase E)
Lanes record breakpoints for track volume, track pan, per-track FX, and master FX. WRITE/arm mode records timestamped points during playback; native vol/pan get sample-accurate `AudioParam` envelopes, FX params ride a ~40 Hz lookahead writer, and everything bakes into the offline render via `AudioParam` ramps + `suspend/resume` stepping (`editorStore.ts:735`, `liveMixer.ts:468`, `WaveformEditor.tsx:1505`).

### Effects, VST3 & .gan — one chain, one window per entry
Per-track and master insert racks of client-side Web Audio effects (crossfeed, phantom bass, **Kargyraa Sub**, stereo widener, aural exciter, The Owl 3D spatializer, loudness contour, OWL-Pad, gater, bitcrush, ring mod, chop, parametric EQ, compressor, reverb, delay, hi/lo-pass, Ares) reconcile live and bake identically into the bounce (`rackEffects.ts`, `liveMixer.ts:253`). VST3 inserts play live through theDAW's live VST host (`lib/vstLive/vstLiveNode.ts`). An entry that names no plugin file, or whose plugin cannot open, passes its audio through.

An offline render cannot host a plugin, so a bounce that includes the racks prints each enabled VST3 insert on the local backend, one `/api/vst/process-file` call per plugin, at the insert's place in the chain (`lib/render/insertPrint.ts`). MIXDOWN, the Export dialog's Mix and Stems, a track freeze and the master freeze all print this way. Tracks and buses print upstream first, so a bus prints what its tracks' plugins made. The master VST chain runs last, over the finished mix, after the master rack. Each call sends the entry's captured state, the host that captured it and the plugin's name inside the `.vst3` file. A state the live host captured prints through theDAW's own render host, and any other state prints through pedalboard (`backend/modules/vst/router.py:856`). Before a bounce reads the document, each live plugin whose window is open or whose state changed is asked for its current state, so the print runs the settings dialed in live. Every call carries 32-bit float audio, and the finished file is encoded once. An export is written in the format the Export dialog chose.

A track with no clip in the rendered range prints no plugin, and in a mix neither does a muted track, a track soloed out or a muted bus. Send to Init and the Export dialog's Selection render without inserts. The LOG reads "Printing <plugin> on <track, bus or Master>…" for each call and lists anything the plugin did not take. A plugin that cannot print stops the bounce, and the error names the plugin and where it sits. A bounce that prints a VST3 insert reports each render and each plugin call as progress on the render pill, and its cancel key stops it between calls. A track freeze keeps the tail a plugin rings out past the track's last clip. In Frozen mode the master panel's re-render key reads Re-render (stale) after a change to a clip, a track's mix or chain, a bus, the routing, the master chains, the tempo or an automation lane that is switched on and holds a breakpoint. Renaming a track or a bus, opening an empty lane and editing a lane that is switched off leave the key reading Up to date.

Built-in effects, VST3 plugins and `.gan` web plugins are **one concept** in the UI (`EffectWindows.tsx`). One **FX** button per track header and one master **FX** button open a compact chain list where FX/VST/GAN rows are identical; clicking a row opens that entry's own draggable floating control window, keyed by entry id so reopening focuses the existing window rather than duplicating it. Each window hosts exactly what MIX renders for that kind — `VstEmbedHost` for a plugin's native UI, `GanPluginStage` for a `.gan` surface, or the shared param tiles for a built-in. The former bespoke centered VST popup, the separate Ares popup, the `aresPanel` state and the paired MASTER FX / VST toolbar buttons are gone; Ares bridge ownership moved into the window host, and Live/Frozen moved into the unified master panel.

Chain param pushes are **sticky**: `buildEffectChain` retains each live instance's full param state and `updateParams` merges into it, so a single-key push (one automation lane, one Perform pad punch, one XY axis) no longer resets that device's other params to catalog defaults.

### Autosave & crash recovery
The arrangement is autosaved to a content-addressed **OPFS** asset layer, so a refresh or crash no longer destroys in-memory clip audio (`lib/editorAutosave.ts`, `components/layout/AutosaveRecoveryNotice.tsx`). Clip blobs are written once per unique payload as `assets/<sha256>.bin` — split and duplicated clips share a single asset — alongside a debounced manifest of tracks, clips, FX, automation, markers, BPM and loop. At startup a recovery notice offers to restore, and **saving stays paused until the offer is answered** so a fresh session cannot overwrite the recoverable snapshot. Restoring rebuilds blobs and peak arrays and lands on EDIT.

### Stem separation from a clip
A timeline clip's context menu carries **Separate Stems → Tracks…**, which runs the Demucs sidecar on that clip and explodes the result into the arrangement (`WaveformEditor.tsx`). The modal picks stem count, device and quality; the clip's blob is bridged into the entry-keyed stems API via `importEntry` (the entry id is written back to the clip so a re-run hits the cache); a progress banner with Abort tracks the run; and each returned stem lands as its own colour-coded track placed at the source clip's exact position and trim, with the source clip muted (reversible). See [14-stems-analysis-convert.md](14-stems-analysis-convert.md) for the separation backend.

### Export
- **Mixdown**: MIXDOWN bounces the arrangement through an `OfflineAudioContext` (fades, track vol/pan, track, bus and master FX, every VST3 insert printed in place, automation, teleports), encodes WAV, imports to library, and downloads (`WaveformEditor.tsx:700`).
- **Send to Init** — renders the selection into a WAV mashup and hands it to the Generate tab as init audio (`WaveformEditor.tsx:1166`).
- **Time/Pitch** — per clip, via backend `/api/studio/process` `time_pitch` (FFmpeg rubberband, atempo fallback) (`backend/modules/effects/router.py:275`).
- **Inpaint** — mask a region, regenerate via the local `/api/generate-jobs` Stable Audio backend, poll `/api/jobs/{id}`, replace the clip (`WaveformEditor.tsx:985`).

### Offline / no-cloud
Arrangement, playback, built-in FX, automation, MIDI synthesis and the bounce itself run in the browser Web Audio API. VST3 inserts play live through theDAW's live VST host and print through the local FastAPI backend. Time/pitch, inpaint and every VST3 print call only that local backend. No feature contacts any third-party cloud API, and EDIT works offline whenever the bundled backend is running.

### Key libraries
`zustand ^5.0.8` · `react ^19.0.1` · `lucide-react ^0.546.0` · `spessasynth_core ^4.3.10` · `spessasynth_lib ^4.3.7` · Web Audio API · HTML Canvas 2D · pedalboard (backend) · FFmpeg rubberband/atempo (backend).
