## MIX — Effect Rack, Mastering, Psychoacoustic FX, Creative FX & Restore

MIX is theDAW's processing surface. One persisted, drag-orderable chain (`effectChainStore`) mixes three node types — browser-side psychoacoustic effects, server-side FFmpeg/DSP tools, and hosted VST3 plugins — and renders them either live (Web Audio) or offline (HTTP + FFmpeg). No neural model weights load anywhere in MIX: the "AI"/"Neural" tool names are honest DSP implementations, with each tool's `engine` string marking any future model swap as "…later".

### The unified chain
- **Three node kinds, one chain.** Built-in FFmpeg effects, client-side rack effects, and VST3 plugins live in the same persisted list (`effectChainStore.ts`). PROCESS CHAIN segments consecutive rack runs (baked in an `OfflineAudioContext`) from backend/VST runs (rendered per stage over HTTP) and threads each stage's output into the next, preserving visible order (`studioStore.ts:285`).
- **Live audition.** The rack subset attaches once to the global master insert (`mixLiveRack.ts`), so effects are heard live on the footer transport; param moves are click-free `setTargetAtTime` pushes and only add/remove/reorder/toggle rebuilds.

### Psychoacoustic live rack (19 Web Audio effects)
`rackEffects.ts` implements genuine psychoacoustic processors, not thin filter wrappers: Headphone Crossfeed (Bauer/BS2B), Phantom Bass (missing-fundamental), **Kargyraa Sub** (subharmonic throat-growl bass), Stereo Widener, Aural Exciter, **The Owl** HRTF spatializer (12 motion modes incl. Teleport/Autopilot), Loudness Contour (equal-loudness), OWL-Pad, Gater, Bitcrush, Ring Mod, Chop (AudioWorklet), Parametric EQ, Compressor, Reverb, Delay, High/Low-Pass, and **Ares** (multi-stage grain/filter/delay/reverb/gate). The same factories run live and in the offline bounce.

**Kargyraa Sub** (`kargyraa`) models Tuvan undertone singing welded to a formant dubstep bass, and is the third worklet-backed stage alongside Chop and the Ares grain engine. An octave-divider AudioWorklet (`public/subharmonic.worklet.js`) Schmitt-triggers a flip-flop once per input period for a true f/2 square and divides again for f/4, both envelope-followed so the sub tracks articulation; an AM "growl gate" set near half the fundamental reproduces the same period doubling as sidebands; a three-band morphing vowel filter (a–o–u–e–i, LFO-wobbled) supplies the talking motion; and a high-Q 0.8–2.4 kHz band is the sygyt-style focused overtone. Params: `mix`, `subLevel`, `deepLevel`, `growlRate`, `growlDepth`, `drive`, `vowel`, `motionRate`, `motionDepth`, `whistleHz`, `whistleAmt`. Degrades to a silent sub path (dry signal intact) when the worklet module is not yet registered on the context.

**Chain param pushes are sticky.** `buildEffectChain` keeps each live instance's full param state (defaults merged with the entry's authored values) and `updateParams` merges into it, so a single-key push — one XY axis, one Perform pad punch, one automation lane — no longer resets that device's other parameters to catalog defaults.

### Server-side tool families (FFmpeg + numpy/scipy/librosa)
Each family exposes `GET /tools` + `POST /process` via a shared `build_router`, which offloads CPU-bound DSP to a worker thread and awaits FFmpeg subprocesses:
- **Studio effects** (`/api/studio`) — ~30 whitelisted FFmpeg effects with strict param bounds; `time_pitch` uses Rubber Band when the FFmpeg build has it, else an atempo/asetrate fallback.
- **Mastering & Tonal** (`/api/edit/mastering`, 11 tools) — Parametric EQ, Maximizer + True-Peak Limiter (two-pass EBU-R128 loudnorm → alimiter), Stereo Imager, Dynamic EQ, Match EQ (scipy `firwin2` FIR), Multiband Dynamics, Harmonic Exciter, Transient Shaper, Spectral Stabilizer, Loudness Meter, AI Master Assistant (DSP chain).
- **Creative FX + Macros** (`/api/edit/creative-fx`, 8) — 5 character macros (Ghost Voice, Alien, Broken Tape, Radio Room, Tunnel PA) over an FFmpeg macro-graph, plus Glitch Machine, Neural Reverb (multi-tap aecho), and PitchLift (librosa `pyin` → sine).
- **Creative Neural / Spectral** (`/api/edit/creative-neural`, 8) — SpectraMorph, TimbreForge, PromptFX, TokenSynth, GrainLab, CrossFade Morph, AmbientForge, VoxSynth vocoder — all scipy STFT / numpy granular / FFmpeg DSP.
- **Enhance / Super-Res** (`/api/edit/enhance`, 5) — libsoxr SRC, bandwidth extension, codec Un-Crush, Studio Enhance, Opus RVQ re-synth.
- **Restoration & Cleanup** (`/api/edit/restoration`, 11) — De-Hum/Ess/Click/Clip/Reverb, Neural Denoise (afftdn), Restore All, plus Vocal Isolate (mid/side), Stem Separation (librosa HPSS), Spectral Repair, Breath Removal.

### AI Analyzer (`/api/edit/analyzer`)
Extracts a full descriptor taxonomy — LUFS (pyloudnorm ITU-R BS.1770-4), true-peak/LRA (FFmpeg loudnorm), librosa spectral/MFCC/chroma/onset/tempo/pyin features, Krumhansl-Schmuckler key, and artifact flags (clipping, hum, sibilance, harshness, low-end bloom) — then runs deterministic rules to emit prioritized fix cards and can build an ordered effect chain from accepted cards. An optional LLM step posts **only the JSON descriptors (never audio)** to the in-app assistant (provider default `gemini`, backend-default model) for ranking/explanations, falling back to rules-only on any failure.

### Per-track live mixer
`liveMixer.ts` schedules each clip as a live Web Audio graph (source → fade gain → track volume → panner → session master bus) so fader/pan/mute/solo and per-clip mute are audible mid-playback, with per-track insert FX and a session master rack, plus sample-accurate vol/pan automation and a ~40 Hz lookahead writer for FX-param lanes.

### Runs offline
The entire subsystem runs with no cloud: server tools need only FFmpeg-on-PATH + numpy/scipy/librosa/soundfile/pyloudnorm, and the rack/mixer are pure in-browser Web Audio. The only cloud touchpoint is the Analyzer's optional LLM enrichment, which degrades to rules-only offline.
