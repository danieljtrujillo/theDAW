# theDAW by GANTASMO — Feature Showcase

A text-to-audio workstation built on Stable Audio 3: generate, process, arrange, DJ, train,
and visualize — with a library that records how every track was made.

This file is a showcase/demo reference. Each entry is a feature name and a one- or two-sentence
description of what it does.

---

## Showcase highlights (lead with these)

- **Text-to-audio generation** — Type a prompt and get 44.1 kHz stereo audio; control duration, steps, and sampler.
- **Chimera blend** — Drop in several tracks and blend them into one, beat-matched and pitch-preserved.
- **Stem separation** — Split any track into drums/bass/vocals/other (up to 12 stems) and use them anywhere.
- **DJ suite** — Two decks with EQ, filter, hotcues, loops, sampler, key matching, MIDI-learn, and Automix.
- **Genealogy graph** — A 2D and 3D map of how every track descended from its sources, with a click-to-inspect analytics panel.
- **3D spaceship flight** — Fly the genealogy graph with velocity controls and an FTL hyperspace warp; a Home button warps you back.
- **Control-surface editor** — Drag-arrange your own on-screen layout (DJ, MIX, and TRAIN) and bind any control to the engine.
- **VJ tab** — An embedded audio-reactive visual engine that follows your audio, MIDI, and DJ setlist.
- **Edit Tool Stack** — A 49-tool pro mastering / restoration / creative suite; the MIX effect stage shows each tool's exact instrument GUI with a live preview.
- **Magenta RT2** — Real-time AI music generation (Google Magenta RealTime 2) via a GPU sidecar: text→music, MIDI-conditioned accompaniment, and audio-style cloning.
- **SLIDE controls** — Glass-capsule sliders and knobs with value-tracking glow, used across every workspace.
- **LoRA training** — Fine-tune the model on your own audio from inside the app.

---

## Generation (MAKE)

- **Text-to-audio generation** — Generate audio from a text prompt using Stable Audio 3, with adjustable duration, step count, CFG, and sampler.
- **Init audio** — Start a generation from an existing clip (audio or RF-inversion) and set how far it moves from the source.
- **Inpaint / region edit** — Select a time range on a track and regenerate only that section, keeping the rest intact.
- **Chimera (multi-source blend)** — Combine several audio files into one output, with automatic BPM detection and pitch-preserved time-stretching.
- **Prompt enhancement** — Rewrite a short prompt into a fuller description before generating.
- **Saved prompts & templates** — Store prompt fragments and full parameter sets and recall them by name.
- **Spectral analysis** — View Mel spectrogram, STFT, chromagram, and CQT of a clip.
- **Magenta RT2 generation** — When the Magenta sidecar is running, pick "Magenta RT2 (text→music)" to generate music in real time from a text prompt (Google Magenta RealTime 2 on an NVIDIA GPU).

## AI music generation — Magenta RT2

- **Real-time engine** — Google Magenta RealTime 2 (mrt2) runs as a GPU sidecar; theDAW probes it and exposes it only when it's up.
- **Text → music** — Generate 48 kHz stereo music from a style prompt, faster than real time.
- **MIDI accompaniment** — Feed a piano-roll part as note conditioning and the model plays along in the prompted style.
- **Audio-style clone** — Embed the style of any clip and resynthesize through the model.

## Processing & arrangement (MIX / EDIT)

- **Edit Tool Stack (49 tools)** — Six families — Mastering, Restoration, Enhance, Creative Neural, Creative FX, Delivery — rendered offline via FFmpeg/DSP at `/api/edit/*`.
- **Exact-instrument effect stage** — Selecting an effect opens its real instrument GUI (parametric EQ, multiband dynamics, maximizer, stereo imager, exciter, vocoder, granular, neural codec, …) filling the MIX effect stage, with a live Web-Audio preview.
- **Studio Modules library** — Browse the 14 instruments as live thumbnail tiles; the effect chain flows left → right in signal order.
- **Effect chain** — Build an ordered chain of effects (EQ, compression, reverb, delay, distortion, normalization, metering) over a source track.
- **Per-effect controls** — Each effect exposes its full parameters with sliders and live output visualization.
- **Quick master** — Master-stage gain, normalization, and loudness metering for the final output.
- **Multi-track timeline** — Arrange clips and generated material on layered tracks with per-track gain, pan, mute, and solo.
- **Waveform editor** — Crop, position, and fade clips on the timeline.
- **Clip snapping** — Quantize clips to a beat grid (1/4, 1/8, 1/16).
- **Piano roll** — Sequence pitched MIDI notes with velocity and quantization.
- **Step sequencer** — A 16-step grid with multiple drum/percussion voices.
- **Live mixer** — Play the timeline back in real time with per-track faders, mute/solo, and master metering.
- **Drag-and-drop routing** — Move generated audio, library tracks, or stems into the timeline or effect chain.

## DJ

- **Two-deck mixer** — Independent A/B decks for live switching and blending.
- **Hero waveform** — A full-width scrollable overview of the loaded track above the decks.
- **Jog wheel + pitch fader** — A platter control with tempo adjustment per deck.
- **Hotcues** — Four save-and-recall cue points per deck.
- **Loops & beat roll** — Beat-length loops (1/4–4) and roll/stutter effects.
- **Beat jump** — Step forward/back by a set number of beats.
- **Crossfader** — Blend between decks with an adjustable curve.
- **3-band EQ + filter** — Per-deck high/mid/low EQ and a single-knob filter.
- **Volume, gain, auto-gain** — Per-deck level controls with normalization.
- **Live stems on deck** — Per-deck stem faders so you can drop parts of a track in and out.
- **Cue / headphone output** — Pre-listen a deck on a separate output device.
- **Sampler bank** — Pads loaded with one-shots from the library, retriggerable during a set.
- **Setlists** — Named track lists for a session, shareable to the VJ tab.
- **Track browser & play-next lane** — Browse a source and stage tracks to play next with drag reordering.
- **Key matching** — Camelot-notation key display to guide harmonic transitions.
- **MIDI-learn** — Bind hardware knobs, faders, and pads to deck, mixer, and hotcue actions.
- **Automix** — Hands-free beat-matched crossfading through a setlist.

## Library & genealogy

- **Audio library** — Disk-backed store of generated, imported, and recorded tracks with metadata and download.
- **Favorites & sources** — Filter the library by favorites or origin (generated, import, stems, etc.).
- **Genealogy graph (2D)** — A left-to-right layered map of how tracks descend from their sources, with each generation drawn as its own column and subtle per-generation background bands.
- **Full-lineage hover** — Hovering a node lights its entire ancestry and descendant chain at once.
- **Node inspector** — Click a node for its full generation parameters, prompt, chimera sources, musical analysis, and copy buttons, plus computed insights across its lineage.
- **3D force graph** — The whole library as a 3D force-directed graph with selectable node shapes, sizes, render presets, and physics.
- **3D spaceship flight** — Velocity-based WASD/arrow flight that accelerates and coasts to a stop, with a Shift afterburner.
- **FTL hyperspace warp** — Hold F to warp far across the graph with a star-streak and edge motion-blur; a Home button warps back, and a return affordance appears when you fly out of sight.
- **Stem separation** — Demucs decomposition into 2/4/6/12 stems, with a drum-specific mode.
- **Audio-to-MIDI** — Transcribe a track to MIDI (general or piano-specific models).
- **Mic recorder** — Record microphone input straight into the library.
- **URL import** — Pull audio from a pasted link (YouTube, SoundCloud, Bandcamp) via yt-dlp.

## Training

- **LoRA workshop** — Fine-tune the model on your own audio dataset from inside the app, with live logs.
- **Hyperparameters & targets** — Set rank, alpha, epochs, and which layers the adapter affects.
- **Autoencoder test bench** — Encode audio to latents and decode it back to check quality.
- **Per-LoRA inference controls** — Strength, sigma-interval gating, and per-layer filtering; multiple adapters stack.

## VJ (audio-reactive visuals)

- **Embedded VJ tab** — The GANTASMO-LIVE-VJ engine runs in-tab and follows your audio, MIDI, and setlist.
- **Detachable window** — Pop the VJ into a floating window for a second screen.
- **Mobile mirror** — A LAN URL and QR code so a phone or tablet can view and control the VJ.
- **Audio / MIDI / SET bridges** — Live frequency data, MIDI input, and the current setlist are passed through to the visuals.
- **Mic and camera sources** — Feed microphone and webcam into the VJ, each toggleable.

## Layout & control surfaces

- **Control-surface editor** — A design mode to drag-arrange any tab's on-screen controls into your own layout.
- **Custom bound controls** — Add faders, knobs, buttons, and pads and bind them to engine parameters.
- **Right-click menu + hotkeys** — Per-control and per-panel actions (shape, mirror, match-size, flow, split, fill) with keyboard shortcuts.
- **Persistent layouts** — Layouts save per surface and restore automatically.
- **Controller recognition** — Auto-detect a connected MIDI controller by name and apply a matching template, learn any rig by capture, or infer a layout from a product photo.
- **SLIDE surface** — A multi-view surface (row, focus carousel, hardware-mirror) for binding MIDI to VJ and mixer parameters.
- **Bottom panel** — A global multi-tab workspace (Visualize, Piano, Sequence, Details, Media, SLIDE).
- **Visualizers** — Spectrum, waveform, scope, and cymatics displays reacting to playback.

## Backend / infrastructure

- **Module system** — Backend features are auto-discovered modules, each with its own API prefix, toggleable in Settings.
- **Library API** (`/api/library`) — Storage, streaming, and metadata for all user audio.
- **Analysis API** (`/api/analysis`) — Tempo, key, pitch, beats, and file metadata extraction.
- **Stems API** (`/api/stems`) — Demucs stem separation.
- **Effects API** (`/api/studio`) — FFmpeg-based effects and export.
- **Chimera API** (`/api/chimera`) — BPM-aware multi-file blending.
- **MIDI API** (`/api/midi`) — Audio-to-MIDI transcription.
- **VJ API** (`/api/vj`) — Spawns and bridges the GANTASMO-LIVE-VJ server.
- **Controller-vision API** (`/api/controllervision`) — Identifies a controller's layout from an image.
- **URL-import API** (`/api/ytimport`) — Downloads and transcodes audio from web links.
- **Settings API** (`/api/settings`) — User preferences and feature flags.
