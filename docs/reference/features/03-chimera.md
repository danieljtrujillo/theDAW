## Chimera — Splice & Braid Multiple Sounds (CRISPR/DNA Mashup)

Chimera stacks two or more audio clips and fuses them into a single seed clip that feeds Stable Audio 3's diffusion generator as init audio. It is a BPM-aware mashup engine with a DNA-helix visualiser: each clip becomes a strand, the strands twist into a double helix on CREATE, and their bar-aligned chunks braid together into one master strand.

Backend module: `backend/modules/chimera/` (mounted at `/api/chimera`, `module.json:7`).
Frontend: `frontend/src/components/chimera/` and `frontend/src/lib/chimeraClient.ts`.

### What it does

- **Stack clips** by drag-and-drop from the library or the desktop. Each clip is analyzed the moment it lands, showing detected **BPM**, musical **key** (with Camelot code), and its **stretch ratio** (`ChimeraStack.tsx:313-326`, `chimeraClient.ts:27`).
- **Pick a target BPM** — a fixed value, a chosen **Base clip** whose tempo everyone matches, or **Auto** (median of detected BPMs) (`ChimeraControls.tsx:24-47`).
- **Choose an alignment mode**: **Start** (all clips begin together), **Downbeat** (each clip trimmed to its first downbeat), or **CRISPR/Weave** (song-arc chunk collage) (`router.py:219`, `ChimeraControls.tsx:5-9`).
- On **CREATE**, the mashup WAV is rendered and set as the generation's init audio (`generateStore.ts:542-559`).

### How a mashup is built

1. **Normalize** every upload to 44.1 kHz stereo WAV via ffmpeg (`stretch.py:40`).
2. **Detect** tempo, beats and key. Beats use **aubio** (`'default'` tempo method) streaming at native rate, falling back to **librosa** `beat.beat_track` at 22050 Hz for MP3/M4A that aubio can't open (`detect.py:127,95`). Key uses **librosa** `chroma_cqt` correlated against the **Krumhansl-Schmuckler** major/minor profiles (`analysis/key.py:121,22-49`).
3. **Time-stretch** each clip to the target BPM, pitch-preserved. Primary engine is ffmpeg's **librubberband** filter; if unavailable it falls back to **atempo** and flags a warning. Ratio clamped to [0.5, 2.0] (`stretch.py:93,98,28`).
4. **Mix** with numpy: per-clip windows, offsets, tile-looping for short slots, micro-fades, RMS normalize to 0.15 under a 0.99 peak ceiling, written as 16-bit PCM WAV (`mix.py:72,158,180`).

**CRISPR / Phrase Weave** chops each clip into bar-aligned chunks (default 8 bars) and scatters them across a long timeline (default 90 bars, or the Base clip's length) so the first chunk lands at the start and the last at the end. At most **N clips overlap** at any moment (polyphony cap, default 3, adjustable 1-8); intro/outro chunks get priority and ties are broken by a seeded shuffle for reproducible output (`weave.py:232,39,37`).

### The DNA visualiser

`ChimeraDnaScene.tsx` draws one three.js (`^0.184.0`) WebGL scene. Each clip is a flat waveform lane (shaped by its real decoded peaks) that twists into a double helix on CREATE, lifts its selected chunks, flies them into a shared output panel, stacks them as polyphony voices, and fuses them into one strand colored by the gradient of contributing voices — unused material vaporises into particles. Layout is measured live from the DOM (`data-crispr-lane` / `data-crispr-output` anchors).

### Models & libraries

- **aubio** `>=0.4.9` (vendored cp310 wheels) — beat/tempo detection
- **librosa** `>=0.10.0` — beat-tracking fallback and key detection (`chroma_cqt`)
- **ffmpeg** — decode + **librubberband** / **atempo** time-stretch (system tool)
- **numpy** `>=2.2.6`, **soundfile** `>=0.12.0` — mixing and WAV I/O
- **three** `^0.184.0` + Web Audio API — DNA visualiser

No neural or LLM models are used; all analysis is classical DSP and statistical key profiling.

### Runs on modest hardware, fully offline

Everything runs locally with no network or API keys. The mashup is **pre-rendered in the background** (debounced) so CREATE finds a warm result (`chimeraClient.ts:104-157`), analysis results are **reused** to skip re-detection (`router.py:270-284`), and decode/detect/stretch run **concurrently** under a 3-way semaphore in worker threads (`router.py:232,248-263`). Beat tracking downsamples to 22050 Hz, output is 16-bit PCM, and the toolchain probe is cached. The WebGL scene caps pixel ratio at 1.5, uses fixed InstancedMesh pools, a single shared animation loop for all strands, and decodes each clip's peaks once. If ffmpeg or aubio is missing, the mashup returns a 503 with an install hint while single-clip analysis still works through the librosa fallback.
