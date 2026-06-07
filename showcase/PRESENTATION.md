# theDAW by GANTASMO — Video Presentation Script

A shot-by-shot walkthrough for a demo video. Each beat lists the screenshot, what
it demonstrates, and a short line to say over it. Screenshots are in
`showcase/screenshots/`, captured at 1920×1080 with the backend, the Magenta RT2
GPU sidecar, and a 146-track library all live.

Suggested order is a left-to-right tour of the workflow: **make → process →
arrange → perform → visualize → train → trace → manage.**

---

## 1 · Generate — MAKE
**Screenshot:** `01-make-generation.png`
**Demonstrates:** Text-to-audio generation (Stable Audio 3).
**Say:** "Type a prompt and theDAW generates 44.1 kHz stereo audio. Duration, steps, CFG, sampler, init-audio, and inpainting are all here."

## 2 · Real-time AI — Magenta RT2
**Screenshot:** `02-make-magenta-rt2.png`
**Demonstrates:** The Magenta RealTime 2 model selectable in the Generate tab.
**Say:** "When the Magenta GPU sidecar is running, you can switch the engine to Google's Magenta RealTime 2 and generate music in real time from a prompt."

## 3 · Process — MIX overview
**Screenshot:** `03-mix-overview.png`
**Demonstrates:** The MIX workspace — input/output visualizers up top, effect rail + Quick Master, the effect chain, and the effect stage.
**Say:** "MIX is a full processing console. Build an effect chain, master it, and see input and output side by side."

## 4 · The Edit Tool Stack — Studio Modules
**Screenshot:** `04-mix-studio-modules.png`
**Demonstrates:** The 49-tool Edit Tool Stack surfaced as live instrument thumbnails.
**Say:** "Forty-nine tools across mastering, restoration, enhancement, and creative effects — each previewed as a live thumbnail."

## 5 · Exact-instrument effect stage — Parametric EQ
**Screenshot:** `05-mix-effect-stage-eq.png`
**Demonstrates:** Selecting a tool opens its real instrument GUI, filling the stage with a live preview.
**Say:** "Pick a tool and its actual instrument opens — here a parametric EQ with a draggable response curve and a live spectrum."

## 6 · Exact-instrument effect stage — Stereo Imager
**Screenshot:** `06-mix-effect-stage-imager.png`
**Demonstrates:** A second instrument (stereo imager / goniometer) to show the range.
**Say:** "Every tool has its own purpose-built interface — imaging, dynamics, exciter, vocoder, granular, and more."

## 7 · Arrange — multitrack EDIT
**Screenshot:** `07-edit-timeline.png` (alt: `20-edit-workspace.png`)
**Demonstrates:** The multitrack timeline with per-track volume/pan and the library alongside.
**Say:** "Arrange clips on a multitrack timeline — drag tracks in from the library, set levels, crop, and fade."

## 8 · Piano roll
**Screenshot:** `08-piano-roll.png`
**Demonstrates:** MIDI note sequencing with import/export and send-to-editor.
**Say:** "A built-in piano roll for melodic ideas — import or export MIDI, or render it into the timeline."

## 9 · Step sequencer
**Screenshot:** `09-step-sequencer.png`
**Demonstrates:** A 16-step grid with multiple drum/percussion voices.
**Say:** "And a step sequencer for beats, with several synthesized voices per track."

## 10 · Perform — DJ console
**Screenshot:** `10-dj-console.png`
**Demonstrates:** Two-deck DJ suite — EQ/filter, hotcues, loops, live stems, sampler, sets, key-lock, MIDI-learn, Automix.
**Say:** "A full two-deck DJ console: EQ and filter, hotcues, loops, live stems, a sampler, harmonic key matching, MIDI-learn, and hands-free Automix."

## 11 · VJ — audio-reactive visuals
**Screenshot:** `11-vj-visuals.png`
**Demonstrates:** The embedded VJ engine that follows audio/MIDI/setlist.
**Say:** "An embedded VJ engine reacts to your audio, MIDI, and DJ setlist — and can pop out to a second screen."

## 12 · Train — LoRA workshop
**Screenshot:** `12-train-workshop.png`
**Demonstrates:** LoRA fine-tuning + autoencoder test bench + telemetry, on the same drag-arrange editor.
**Say:** "Fine-tune the model on your own audio right inside the app, with live telemetry and an autoencoder bench."

## 13 · Trace — Genealogy (2D)
**Screenshot:** `13-genealogy.png`
**Demonstrates:** A left-to-right lineage map of how every track descended from its sources.
**Say:** "Every track records how it was made. The genealogy view maps the whole lineage, generation by generation."

## 14 · Genealogy — 3D flight
**Screenshot:** `14-genealogy-3d.png`
**Demonstrates:** The 3D force-directed graph with velocity flight + FTL warp.
**Say:** "Flip to 3D and fly the graph — velocity controls, an FTL hyperspace warp, and a Home button to snap back."

## 15 · Visualizer
**Screenshot:** `15-visualizer.png`
**Demonstrates:** Spectrum / waveform / scope / cymatics reacting to playback.
**Say:** "A reactive visualizer panel — spectrum, scope, and cymatics — available across the app."

## 16 · SLIDE control surface
**Screenshot:** `16-slide-surface.png`
**Demonstrates:** The MIDI-bindable SLIDE surface; the glass-capsule SLIDE controls used app-wide.
**Say:** "SLIDE is a bindable control surface — and the same glass-capsule controls run throughout theDAW."

## 17 · Library
**Screenshot:** `17-library-browser.png`
**Demonstrates:** Disk-backed library with search, filters, favorites, and source categories (146 tracks here).
**Say:** "Everything you make lands in a searchable, disk-backed library — favorites, sources, stems, and MIDI."

## 18 · Settings — module system
**Screenshot:** `18-settings-modules.png`
**Demonstrates:** Toggleable backend modules + layout/editor settings.
**Say:** "The backend is modular — features are discoverable modules you can toggle, plus per-surface layout settings."

## 19 · Media panel
**Screenshot:** `21-media.png`
**Demonstrates:** The Media tab of the global bottom workspace.
**Say:** "A global bottom workspace hosts the visualizer, piano roll, sequencer, details, media, and SLIDE — one keystroke away from any tab."

---

### Capture notes
- Resolution: 1920×1080. Re-run `showcase/` capture for 2560×1440 / 4K if needed.
- Live during capture: theDAW backend (:8600), Magenta RT2 sidecar (mrt2_small, cuda:0, via :8777), 146-track library.
- Not yet pictured (frontend features in progress): Magenta MIDI-accompaniment, audio-style clone, Step-Sequencer AI-synth voice, DJ automix AI-fill.
