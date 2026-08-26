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

### Effects & VST3
Per-track and master insert racks of client-side Web Audio effects (crossfeed, phantom bass, stereo widener, aural exciter, The Owl 3D spatializer, loudness contour, OWL-Pad, gater, bitcrush, ring mod, chop, parametric EQ, compressor, reverb, delay, hi/lo-pass, Ares) reconcile live and bake identically into the bounce (`rackEffects.ts:1446`, `liveMixer.ts:253`). VST3 plugins are hosted on the backend via **pedalboard**; since they can't run live in the browser, **track/master freeze** renders offline then applies each VST3 in series through `/api/vst/process-file` into a printed stem (`WaveformEditor.tsx:1806`, `backend/modules/vst/router.py:208`).

### Export
- **Mixdown** — `commitEdit` bounces the arrangement through an `OfflineAudioContext` (fades, track vol/pan, track + master FX, automation, teleports), encodes WAV, imports to library, and downloads (`WaveformEditor.tsx:1455`).
- **Send to Init** — renders the selection into a WAV mashup and hands it to the Generate tab as init audio (`WaveformEditor.tsx:1166`).
- **Time/Pitch** — per clip, via backend `/api/studio/process` `time_pitch` (FFmpeg rubberband, atempo fallback) (`backend/modules/effects/router.py:275`).
- **Inpaint** — mask a region, regenerate via the local `/api/generate-jobs` Stable Audio backend, poll `/api/jobs/{id}`, replace the clip (`WaveformEditor.tsx:985`).

### Offline / no-cloud
Arrangement, playback, FX, automation, MIDI synthesis, and mixdown export run entirely in the browser Web Audio API. Time/pitch, inpaint, and VST3 freeze call only the **local** FastAPI backend. No feature contacts any third-party cloud API — EDIT works offline whenever the bundled backend is running.

### Key libraries
`zustand ^5.0.8` · `react ^19.0.1` · `lucide-react ^0.546.0` · `spessasynth_core ^4.3.10` · `spessasynth_lib ^4.3.7` · Web Audio API · HTML Canvas 2D · pedalboard (backend) · FFmpeg rubberband/atempo (backend).
