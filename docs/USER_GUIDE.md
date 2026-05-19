# Stable Audio 3 — User Guide

A complete walkthrough of every feature in this fork: the upstream Stable Audio 3 Python pipeline, the FastAPI backend that wraps it, and the StableDAW React UI on top.

> This document is the source of truth. The in-app **Docs** button renders this file. The README is a shorter overview that links here.

---

## Table of contents

1. [What's in this repo](#1-whats-in-this-repo)
2. [Architecture at a glance](#2-architecture-at-a-glance)
3. [Installation](#3-installation)
4. [Launching the app](#4-launching-the-app)
5. [UI walkthrough — Shell](#5-ui-walkthrough--shell)
6. [CREATE tab — text-to-audio, audio-to-audio, inpainting](#6-create-tab)
7. [EDIT tab — Studio effects](#7-edit-tab)
8. [TRAIN tab — LoRA + autoencoder](#8-train-tab)
9. [LIBRARY tab — persistent generations](#9-library-tab)
10. [DAW workspace — waveform editor + step sequencer](#10-daw-workspace)
11. [Processing Log](#11-processing-log)
12. [Player Footer](#12-player-footer)
13. [Backend API reference](#13-backend-api-reference)
14. [Python pipeline reference](#14-python-pipeline-reference)
15. [Models](#15-models)
16. [Troubleshooting](#16-troubleshooting)
17. [Development workflows](#17-development-workflows)

---

## 1. What's in this repo

This is a fork of upstream Stable Audio 3 with three additional layers stacked on top:

| Layer | Location | Purpose |
|---|---|---|
| **Upstream Python pipeline** | `stable_audio_3/` | The actual ML — DiT diffusion transformer, SAME autoencoder, LoRA support, samplers, distribution-shift schedules. |
| **FastAPI backend** | `backend/server.py` | HTTP wrapper around the pipeline. Async job queue for generation, synchronous endpoints for studio effects. Runs on port 8600. |
| **StableDAW React UI** | `frontend/` | Tailwind 4 + React 19 + Zustand 5 + Vite 6. Talks to the backend via same-origin `/api/*`. Runs on port 5173 in dev. |
| **Gradio UI** | `run_gradio.py`, `stable_audio_3/interface/` | The upstream Gradio interface. Still works for direct pipeline access; the React UI replaces it for day-to-day use. |

Both UIs share the same Python pipeline. They are independent — one can be used without the other.

---

## 2. Architecture at a glance

```
Browser (:5173 in dev, served from backend in prod)
   ↓ fetch('/api/...')
FastAPI backend (:8600)
   ↓ pipeline.generate(...)
StableAudioModel
   ├── T5Gemma text encoder       (models/conditioners.py)
   ├── DiT diffusion transformer  (models/dit.py → transformer.py)
   └── SAME autoencoder           (models/autoencoders.py)
```

**Two-stage generation pipeline:** DiT generates 256-dimensional latents at 1/4096 the original audio rate; SAME decodes those latents to 44.1 kHz stereo audio.

**Three model sizes:** Small (433M, CPU-capable), Medium (1.4B, GPU), Large (2.7B, API-only).

**Two checkpoint flavors per size:**
- **ARC** — post-trained, 8-step inference, `cfg_scale=1`. Use these for inference. Keys: `small`, `medium`.
- **RF** — base rectified-flow checkpoints. Use these as a starting point for LoRA training. Keys: `small-rf`, `medium-rf`. Inference uses ~50 steps with `cfg_scale=7`.

The autoencoder is also available standalone (`same-s`, `same-l`) for encoding/decoding outside the generation pipeline.

---

## 3. Installation

### Base install (CPU-only, Small model)

```bash
uv sync
```

### With CUDA (Medium model)

```bash
uv sync --extra cuda
```

### With dev dependencies

```bash
uv sync --group dev
```

### Windows-specific extras

The `pyproject.toml` CUDA index map only covers Linux. On Windows you must:

1. Install PyTorch with the CUDA wheel index manually:
   ```powershell
   uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
   ```
2. Install `soundfile` (torchaudio has no default backend on Windows):
   ```powershell
   uv pip install soundfile
   ```
3. Flash Attention requires a pre-built wheel from [`kingbri1/flash-attention`](https://github.com/kingbri1/flash-attention) releases — pick the one matching your Python + torch + CUDA versions.

See `docs/windows/setup-guide.md` for the full walkthrough.

### Frontend dependencies

```bash
cd frontend
npm install
```

The frontend's `package-lock.json` is committed — `npm ci` reproduces the exact tree, `npm install` is fine in dev.

---

## 4. Launching the app

### One-shot launcher (Windows)

```powershell
.\start-dev.bat
```

The launcher:
1. Kills any stale process on ports 5173 / 8600.
2. Starts the FastAPI backend (`uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload`) in a new terminal.
3. Waits 3 seconds for the backend to bind.
4. Starts the Vite dev server in a second terminal.
5. Opens http://localhost:5173 in your default browser.

The backend has `--reload`, so editing `backend/server.py` triggers an automatic restart.

### Manual launch

Two terminals:

```bash
# Terminal 1 — backend
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload
```

```bash
# Terminal 2 — frontend
cd frontend && npm run dev
```

The frontend's `vite.config.ts` proxies `/api/*` to `http://localhost:8600`, so same-origin fetches Just Work.

### Gradio UI (legacy)

```bash
uv run python run_gradio.py --model medium
uv run python run_gradio.py --model medium --lora-ckpt-path path/to/lora.ckpt
```

---

## 5. UI walkthrough — Shell

The StableDAW UI has three columns:

```
+----------------------+----------------------------------------+
| LEFT PANEL           | DAW WORKSPACE (CENTER)                 |
| (resizable, hideable)|                                        |
|                      |  - Toolbar (Waveform / Sequencer)      |
|  - STABLEDAW logo   |  - Timeline / Step grid                |
|  - Tab strip:        |  - Resize handle                       |
|    CREATE / EDIT /   |  - Spectral analyzer (collapsible)     |
|    TRAIN / LIBRARY   |                                        |
|                      |                                        |
|  - View content      |                                        |
|    (accordion        |                                        |
|     sections per     |                                        |
|     tab)             |                                        |
|                      |                                        |
|  - Sticky RUN CTA    |                                        |
|  - Processing Log    |                                        |
+----------------------+----------------------------------------+
| PLAYER FOOTER (fixed at viewport bottom)                      |
+---------------------------------------------------------------+
```

**Tabs (left-panel top):** CREATE, EDIT, TRAIN, LIBRARY. Switching tabs swaps the accordion content in the left panel; the DAW workspace stays put across all tabs.

**Resize the left panel:** drag the vertical handle on its right edge. Min 300px, max 500px.

**Collapse the left panel:** click the chevron next to the STABLEDAW logo. The DAW expands to full width.

**Header chips (top-right of DAW):** settings cog (currently decorative), user avatar (decorative).

**Density:** the whole UI uses a CSS `zoom` factor depending on viewport width (0.85 → 0.95 → 1.1 at 1440px / 1920px breakpoints). The Shell height calc compensates for this so layout always tiles cleanly to the footer top.

---

## 6. CREATE tab

Generates audio from a prompt. Submits an async job to `POST /api/generate-jobs`, then polls `GET /api/jobs/{id}` every 1s until completion.

### 6.1 PRIMARY SYNTHESIS / PROMPT

- **Prompt** — required, plain text describing the desired audio.
- **Negative prompt** — optional, things to avoid.
- **Magic wand button** (top-right of prompt box) — when the prompt is empty, fills in a sample prompt.

The `RF-ENGINE` chip in the section header is decorative — it indicates this section drives the synthesis stage.

### 6.2 GENERATION PARAMETERS *(was MODEL & DURATION + SEED & BATCH — merged for compactness)*

Six fields in a 3-column grid:

| Field | Type | Notes |
|---|---|---|
| Model | dropdown | `small`, `medium`, `small-rf`, `medium-rf`. Switching to a `-rf` model auto-adjusts steps to 50 and cfg to 7. |
| Duration (s) | integer | Total output length. Small caps at 120s, Medium/Large at 380s. |
| Batch | integer | Generate N variations in one job. Each variation gets a unique entry in the Library. |
| Steps | integer | Sampler steps. ARC defaults 8; RF defaults 50. |
| CFG | float | Classifier-free guidance scale. ARC defaults 1.0; RF defaults 7.0. |
| Seed | integer + reroll button | -1 for random per run. Reroll = sets a new random seed and shows it. |

### 6.3 INIT SIGNAL / CONDITIONING (audio-to-audio)

Click the dashed dropzone to upload a source audio file. Below:

- **Init Noise** (0–1) — how much of the source to keep. Lower = more faithful to source; higher = more freedom for the model.
- **Type** — `Audio` (standard) or `RF-Inv` (RF-Inversion mode, only meaningful for `-rf` models).

The `BYPASS` chip in the section header is decorative — there's no explicit bypass toggle; an empty dropzone means no init signal is sent.

### 6.4 INPAINTING / REGEN REGION

Replace a time region of an existing audio clip while keeping everything else.

- **ON/OFF toggle** (header) — must be ON for the inpaint payload to actually be sent with the next generation. Toggle goes ON automatically when you load a source file.
- **Load source** — drag-drop or click the dropzone.
- **Waveform preview** — once a file is loaded, a `WaveSurfer` waveform appears below.
- **Drag a purple region across the waveform** — that region is the regen window. Start/End/Region readouts update live.
- **Generation submit** includes `inpaint_audio`, `mask_start`, `mask_end` as form fields.

For **continuation** (extending past the source's end): drag the mask to the end of the source and set `Duration` larger than the source's length. The model fills the new tail conditioned on the existing audio.

### 6.5 LORA / ADAPTIVE LAYERS

Stack one or more LoRA adapters at inference. Each row shows the LoRA name, weight slider (0–1), and remove button.

> **Status: UI scaffolding only.** The backend's `/api/generate-jobs` does not yet pass LoRA references through to the pipeline. Loading LoRA adapters is supported by the pipeline directly via `StableAudioModel.load_lora(...)` (see [§14](#14-python-pipeline-reference)).

### 6.6 Output Status Monitor

Appears below the accordion when a generation is running or has completed. Shows progress bar (binary today — `queued → running → completed`), engine info, the audio player, and download/clear buttons. Completed audio is also auto-saved to the Library.

### 6.7 RUN GENERATION CTA

Sticky bar at the bottom of the left column. Submits the generation. While running, the button becomes a red `ABORT (NN%)` button — clicking it cancels polling (the backend job continues but its result is discarded by the UI).

---

## 7. EDIT tab

Audio processing via FFmpeg. Synchronous — submit, get a binary audio response, play it.

### 7.1 STUDIO MACROS

Four high-level macro sliders: **Drive**, **Width**, **Air**, **Punch**. The effective parameter mapping depends on the currently-selected FX chain entry — see `buildEffectParams` in [`StudioView.tsx`](../frontend/src/views/StudioView.tsx).

### 7.2 FX chain

Pick one of:

| Effect | Params (auto-mapped from macros) |
|---|---|
| `mastering_chain` | lowBoost, highBoost, limiterCeiling, targetLUFS |
| `compression` | attack, decay |
| `highpass` | frequency |
| `lowpass` | frequency |
| `volume` | level |
| `tempo` | rate |
| `vocal_processing` | highpassFreq, presenceBoost, targetLUFS |
| `lofi_vinyl` | degradation, lowpassFreq |
| `stereo_widener` | delayMs |
| `reverb_delay` | delayMs, decay, reverbDecay |
| `sub_exciter` | subBoost, trebleBoost |
| `phase_isolation` | cancelAmount |
| `eq_mid` | frequency, width, gain |
| `loudnorm` | targetLUFS, truePeak |
| `pitch_shift` | shift (cents) |
| `delay` | leftMs, rightMs |
| `echo` | delayMs, decay |
| `fade` | fadeInDuration, fadeOutDuration |
| `denoise` | noiseReduction |
| `declick` | windowSize |
| `silence_remove` | threshold |
| `export_flac` / `export_mp3` / `export_aac` / `export_opus` | bitrate / compressionLevel |

All effects are dispatched to `ffmpeg` via `subprocess.run`. Parameters are bounds-checked server-side; out-of-range values return HTTP 400.

### 7.3 Source / output

- **Source** — upload an audio file via the dropzone or "Use last output" if there's a previous result.
- **Output format** — `wav`, `flac`, `ogg`, `mp3`, `aac`, `opus`.
- **Process** button submits to `POST /api/studio/process`. Response is a binary audio body; the UI wraps it in a Blob URL for inline playback.

### 7.4 Process history

The store keeps the last 8 process invocations as a history list. Reuse-as-source promotes any past output to the current source.

---

## 8. TRAIN tab

LoRA training and autoencoder round-trips. The backend exposes the endpoints; some are full implementations (LoRA / pre-encode are wired to `subprocess.Popen`-based job runners in the upstream codebase), others are stubs in this fork's backend shim.

### 8.1 TARGET ARCHITECTURE

- **Module name** — output checkpoint label.
- **Target module** — which submodule to attach the LoRA to (`attn_kv` is the default and most-tested).
- **Epochs / Steps** — training step count.
- **Rank, Alpha** — LoRA-specific. Rank controls capacity; alpha is the scaling factor (effective LR = alpha / rank).
- **Dataset path** — server-side filesystem path containing audio + paired prompts.

### 8.2 PRE-ENCODE workflow

Pre-encoding a dataset to latents accelerates training. Submit a dataset path and an output path; the backend kicks off a job that runs `pre_encode.py` against the dataset.

> **Backend support in this fork:** stub — returns HTTP 501. Use the upstream `python -m stable_audio_3.scripts.pre_encode` directly for now.

### 8.3 AUTOENCODER ROUNDTRIP

Encode an uploaded audio to latents (base64), then decode it back to verify the autoencoder's reconstruction quality.

> **Backend support in this fork:** `/api/autoencoder/info` returns an empty list (so the TRAIN tab shows "no autoencoders available" until that endpoint is wired). The encode/decode endpoints return HTTP 501.

### 8.4 Polling and logs

For long jobs, the UI polls `GET /api/jobs/{id}` every 1s. The `logs` field of the response is rendered as a streaming console.

---

## 9. LIBRARY tab

Persistent storage for every generated audio. **Backed by IndexedDB** (object store `generations` in DB `sa3-library`), so entries survive page reloads.

### 9.1 What lands here automatically

Every successful generation in the CREATE tab is auto-saved with all its metadata:

```ts
{
  id, title, prompt, negativePrompt, model, duration,
  steps, cfg, seed, audioBlob, mimeType, timestamp,
  favorite, rating, tags, notes, source: 'generate'
}
```

Batch jobs split into N entries with ids `${jobId}_0`, `${jobId}_1`, …

### 9.2 LIBRARY section

- **List/Grid toggle** (top-right) — switch between dense list and image-tile grid.
- **Search** — filters across title, prompt, model, tags, notes.
- **Filters** — `FAVS` (favorites only), sort by `NEWEST` / `DURATION` / `TITLE`.
- **Each row** — title, prompt preview, model, duration, date, file size, action cluster (play/pause, download, delete).
- **Favorite star** — clickable per row.
- **Play** — uses a single shared `<audio>` element. Pausing while another track is selected stops the first.

The UI's playback element honors the global volume / mute state from the player footer.

### 9.3 LIBRARY ANALYSIS

Stats footer: total entries, favorites count, total disk size, total duration.

### 9.4 Empty state

Library is empty until you generate something. The empty state has a "Go generate something" button that switches to the CREATE tab.

---

## 10. DAW workspace

The center panel. Stays put across tab switches.

### 10.1 Mode toolbar

Top of the panel — switch between **Waveform Editor** and **Step Sequencer**.

### 10.2 Waveform Editor ✅

Multi-track audio composition surface backed by `useEditorStore`. Every clip is a slice of a real audio Blob; waveform peaks are computed once via `AudioContext.decodeAudioData` and cached on the clip for fast redraws.

**Toolbar:**
- **ADD TRACK** — append an empty track. Track names auto-inherit from the first clip placed on them (editable any time after).
- **Move tool** — drag clips horizontally to reposition, vertically to move between tracks.
- **Cut tool** — click inside a clip to split it at that point. The right half becomes a new clip referencing the same source with an adjusted in-point.
- **Snap dropdown** — Off / 1/4 / 1/8 / 1/16, relative to the editor BPM; applies to drag/resize math.
- **Zoom in/out** — pixels-per-second resolution (5–400 px/s).
- **Delete** — removes the selected clip. `Delete` / `Backspace` keys do the same.

**Per-track header:**
- Editable name (track-color text).
- M / S / × — mute, solo (radio-style across tracks), remove track.
- Volume slider (0–1).
- Pan slider (−1 → +1).

**Per-clip:**
- Real downsampled waveform peaks (240 bins, normalized).
- Header label + duration readout.
- Left/right resize handles trim the in/out points. The left handle adjusts both `startSec` and `offsetIntoSource` so the source contents stay aligned to the playhead.

**Transport:**
- **Preview ▶︎** — plays just the selected clip through Web Audio at master volume.
- **Stop ■** — interrupts preview.
- **COMMIT EDIT** — renders every non-muted (or solo'd) track into a single 44.1 kHz stereo WAV via `OfflineAudioContext`, then auto-saves it to the LIBRARY as a `mixdown_*.wav` entry. The new entry is playable, downloadable, and can itself be sent back into the editor.

**Status bar (bottom):** live timecode (playhead / total length), clip + track counts, and a SEL readout showing the selected clip's `startSec → endSec`. Click an empty part of the timeline to move the playhead; click empty space to deselect.

**Sending audio to the editor:** every LIBRARY row has a scissors icon. Click it to append that entry to the first track at the end of any existing content. The clip's audio Blob is decoded and its peaks are cached on the spot.

### 10.3 Step Sequencer ✅

Fully functional Web Audio drum machine.

| Control | Behavior |
|---|---|
| **Tempo** | BPM input (40–240). Drives the 16th-note clock. |
| **Play/Stop** | Starts/stops the clock. Unlocks the AudioContext on the first press. |
| **RANDOM FILL** | Randomizes every track's pattern. |
| **CLEAR** | Empties every track. |
| **+** | Adds a new track. |

Per-track:

| Control | Behavior |
|---|---|
| **Name** (text input) | Editable label. |
| **Voice chip** | Cycles through `kick / snare / hat / tone / noise`. Each is a hand-rolled Web Audio synthesizer. |
| **Volume slider** | Per-track gain. |
| **16 step buttons** | Toggle the step on/off. Beats 1/5/9/13 are visually emphasized. |
| **Target icon** (hover-revealed) | Preview the voice once without running the clock. |
| **Trash icon** (hover-revealed) | Remove the track. |

The master volume comes from the player footer's volume slider (via `usePlaybackStore`).

### 10.4 Spectral analyzer

Bottom band of the DAW. Two tabs: **Real-time Spectral** and **Signal Scope**. The visualizer is currently driven by procedural noise (no live audio analyser node yet — coming with the playback wiring in [§5.5](./plans/2026-05-18-stabledaw-ui-polish-and-functionality.md)).

Collapse: click the chevron in the panel header. The collapsed state shows a tall purple "Expand Spectral Analyzer" button — impossible to lose. Click anywhere on it to restore.

Resize: drag the horizontal bar above the spectrum panel up/down to resize between ~60px and viewport-bound.

---

## 11. Processing Log

Pinned bar at the bottom of the left panel, glued to the footer top.

- **Always visible** — even in collapsed state, the header bar persists.
- **Producers:** `system`, `health`, `generate`, `training`, `studio`, `sequencer`, `library`.
- **Levels:** info (purple bar), warn (amber bar), error (red bar), debug (gray bar).
- **Ring buffer cap:** 500 entries.
- **Auto-scroll** to the latest entry.
- **Download button** (📥 in header) — exports the log as `stabledaw-log-YYYYMMDD-HHMMSS.txt` with ISO timestamps and level/source/message per line.
- **Clear button** (🗑️ in header) — wipes the buffer.
- **Click anywhere on the header bar** to collapse/expand. Collapsed state shows a purple-highlighted bar with an "— click to expand" hint and the entry count.

---

## 12. Player Footer

Fixed at the bottom of the viewport, z-50.

| Region | Behavior |
|---|---|
| **Track info (left)** | Reads from `useGenerateStore.lastFilename` / `lastModelName` / `lastDurationSec`. Shows "No output loaded / IDLE / --:--" until something has generated. |
| **Transport (center)** | Play/Pause, prev/next, loop, fullscreen — UI is in place; the actual playback wiring is staged for [§5.5](./plans/2026-05-18-stabledaw-ui-polish-and-functionality.md). The progress bar reads 0 until that lands. |
| **Volume + mute (right)** | Drives `usePlaybackStore` — same store every audio element reads from (LibraryView's preview, the sequencer's master gain). |
| **Download / more** | Decorative until the global player wiring lands. |

---

## 13. Backend API reference

All endpoints are same-origin under `/api/*`. Errors return `{detail: string}` (FastAPI default) or `{error: string}`.

### 13.1 Health

```
GET /api/health
→ { "status": "ok", "model_loaded": true }
```

### 13.2 Model info

```
GET /api/model-info
→ {
  "active_model": "medium",
  "available_models": ["medium"],
  "sample_rate": 44100,
  "diffusion_objective": "rectified-flow",
  "has_cuda": true,
  "device": "cuda:0",
  "vram_used_gb": 4.2,
  "vram_total_gb": 6.0
}
```

### 13.3 Generation (async, used by StableDAW UI)

```
POST /api/generate-jobs   multipart/form-data
fields:
  model_name        string
  prompt            string  (required, non-empty)
  negative_prompt   string
  duration          float (seconds)
  steps             int
  cfg_scale         float
  seed              int  (-1 for random)
  batch_size        int  (>=1)
  init_noise_level  float
  init_audio_type   string
  file_format       string ('wav' usually)
  file_naming       string ('verbose' usually)
  mask_start        float (seconds, 0 = no inpaint)
  mask_end          float (seconds, 0 = no inpaint)
  init_audio        file (optional)
  inpaint_audio     file (optional)
→ { "job": { "id": "<uuid>" } }
```

Then poll:

```
GET /api/jobs/{job_id}
→ {
  "id": ..., "kind": "generate",
  "status": "queued" | "running" | "completed" | "failed",
  "progress": { "step": 0, "steps": 8 },
  "result": {
    "batch": false,
    "item":  { "audio_base64": "...", "mime_type": "audio/wav", "filename": "..." }
    // OR for batch:
    // "batch": true,
    // "items": [ { audio_base64, mime_type, filename }, ... ]
  },
  "error": "..." // when status === "failed"
}
```

### 13.4 Generation (sync, legacy)

```
POST /api/generate   multipart/form-data
```

Same surface as `/api/generate-jobs` plus a bunch of advanced params (`sampler_type`, `apg_scale`, all the distribution-shift params, inversion params). Response is the raw audio bytes (`audio/wav` by default). Kept for backwards compat and the Gradio UI.

### 13.5 Studio (synchronous FFmpeg)

```
POST /api/studio/process   multipart/form-data
  audio          file (required)
  effect         string (one of the keys in EFFECT_PARAM_BOUNDS)
  params         JSON-stringified Record<string, number>
  output_format  string ('wav' | 'flac' | 'ogg' | 'mp3' | 'aac' | 'opus')
→ binary audio body, content-type: audio/<format>
```

### 13.6 Training / autoencoder

| Endpoint | Status in this fork |
|---|---|
| `GET /api/jobs` | Lists all jobs in the in-memory store. |
| `GET /api/autoencoder/info` | Returns empty arrays (stub). |
| `POST /api/jobs/train-lora` | HTTP 501. |
| `POST /api/jobs/pre-encode` | HTTP 501. |
| `POST /api/autoencoder/encode` | HTTP 501. |
| `POST /api/autoencoder/decode` | HTTP 501. |

### 13.7 Presets (decorative)

```
GET /api/presets   → []
POST /api/presets  → { id: <uuid>, saved: true }
```

Not consumed by the UI yet.

---

## 14. Python pipeline reference

### 14.1 Text-to-audio

```python
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")
audio = pipe.generate(
    prompt="Lo-fi boom bap meets orchestral strings, 84 BPM",
    duration=180,
)
```

### 14.2 Audio-to-audio

```python
import torchaudio
init_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    init_audio=init_audio,
    init_noise_level=0.9,
    prompt="bossa nova bassline",
    duration=30,
)
```

### 14.3 Inpainting / continuation

```python
inpaint_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    inpaint_audio=inpaint_audio,
    inpaint_mask_start_seconds=4.0,
    inpaint_mask_end_seconds=8.0,
    prompt="punchy kick drum fill",
    duration=30,
)
```

For **continuation**: set `inpaint_mask_start_seconds` to the length of the source clip and use a longer `duration`.

### 14.4 Autoencoder

```python
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")
waveform, sr = torchaudio.load("audio.wav")
latents = ae.encode(waveform, sr)
audio_out = ae.decode(latents)
```

### 14.5 LoRA at inference

```python
pipe = StableAudioModel.from_pretrained("medium")
pipe.load_lora("path/to/lora.ckpt", weight=0.8)
audio = pipe.generate(prompt="...", duration=30)
```

Multiple LoRAs stack additively. `weight` can be adjusted at runtime.

### 14.6 Advanced generation controls

See `stable_audio_3/model.py:StableAudioModel.generate` for the full signature. Highlights:

- `sampler_type` — `"euler"`, `"rk4"`, `"dpmpp_2m_sde"`, `"ping_pong"`.
- `sigma_max` — max noise level for partial trajectories.
- `apg_scale` — Adaptive Projected Guidance scale.
- `cfg_interval` — `(min, max)` interval over which CFG is applied.
- `dist_shift` — a `DistributionShift` instance (Flux, LogSNR, or Full).

---

## 15. Models

| Key | Type | Params | Use |
|---|---|---|---|
| `small` | ARC | 433M | CPU-capable inference. |
| `medium` | ARC | 1.4B | Primary GPU inference. |
| `small-rf` | RF | 433M | LoRA training base (small). |
| `medium-rf` | RF | 1.4B | LoRA training base (medium). |
| `same-s` | Autoencoder | 266M | Standalone SAME-Small. |
| `same-l` | Autoencoder | 1.7B | Standalone SAME-Large. |

ARC and RF checkpoints bundle the autoencoder. Standalone SAME checkpoints share weights with the bundled versions and will reuse cached full checkpoints when available.

---

## 16. Troubleshooting

### Generation returns a static glitch (Medium)

Flash Attention isn't loading. Verify:

```bash
uv run python -c "import flash_attn; from flash_attn import flash_attn_func; print('Version:', flash_attn.__version__, '| flash_attn_func:', flash_attn_func)"
```

If any error, reinstall flash-attention with a wheel that matches your Python + torch + CUDA versions.

### UI shows "API UNREACHABLE"

The backend isn't responding on port 8600. Check:

```bash
curl http://localhost:8600/api/health
```

If that fails, restart the backend. On Windows the `start-dev.bat` launcher kills stale processes; otherwise `taskkill /F /IM uvicorn.exe` (or your usual stop signal).

### TRAIN tab shows "TRAINING METADATA FAILED"

`/api/autoencoder/info` returned non-OK. In this fork it's a stub that returns an empty list — that's expected; the TRAIN tab gracefully degrades but anything that depends on autoencoder metadata is unavailable.

### Vite dev server can't reach `/api`

`vite.config.ts` is missing the proxy block, or `localhost:8600` isn't listening. Check both. The graft of the StableDAW UI patched this — if you somehow ended up on the upstream UI's config, copy the `server.proxy` block from `frontend/vite.config.ts` here.

### Audio plays at the wrong speed / pitch

Sample-rate mismatch. The pipeline is 44.1 kHz stereo end-to-end; if you're saving with a different rate the playback engine will resample wrong. Check `pipeline.sample_rate`.

### "OOM" on Medium model

You need ~8 GB VRAM for the medium pipeline. Workarounds:
- Use `small` instead.
- Reduce `duration` (shorter sequences = less peak memory).
- Make sure no other CUDA process is competing.

### IndexedDB quota errors in Library

Browser hit its storage cap. Clear old entries or use the trash icon per row.

---

## 17. Development workflows

### Lint

```bash
uv run ruff check
uv run ruff format --check
```

Ruff excludes `stable_audio_3/models`, `inference`, `interface`, and `data` from linting. Only top-level files are checked.

### Tests

```bash
uv run pytest                  # Full suite (medium tests skip on non-CUDA hosts)
uv run pytest tests/test_inference.py
uv run pytest --save-audio     # Persist test outputs to test_audio_outputs/
```

### Frontend build

```bash
cd frontend
npm run build      # → frontend/dist/
npm run preview    # serve the built bundle locally
```

### Regenerating docs (this guide)

There's a helper script — see [§17.1](#171-regenerate-docs).

### 17.1 Regenerate docs

`scripts/regenerate-docs.sh` (bash) or `scripts/regenerate-docs.ps1` (PowerShell) runs:

1. Validates the frontend builds (`npx vite build`).
2. (Optional) Takes Playwright screenshots if Playwright is installed.
3. Bumps the docs timestamp in `docs/USER_GUIDE.md`.
4. Stages the updated docs files for commit.

Wire it as a pre-commit hook via `.git/hooks/pre-commit` (sample lives in `scripts/git-hooks/pre-commit`).

### 17.2 Backend job persistence

The current async job store (`backend/server.py:JOBS`) is in-memory only. Jobs die on restart. For production you'd swap this for SQLite or Redis — the job dict shape is already well-defined, so the swap is a single layer change.

### 17.3 Adding new effects

Add an entry to `EFFECT_PARAM_BOUNDS` in `backend/server.py` with the parameter ranges, then extend `_build_filter()` with the FFmpeg command. The frontend FX chain in `StudioView.tsx` is a hardcoded list — add the new effect there with a label and color class.

### 17.4 Memory / context notes

The repo has a `CLAUDE.md` with project-specific guidance for Claude Code, plus a custom-stack memory note about this being a FastAPI+React layer on top of upstream SA3. Honor both.

---

*Last updated: this file is regenerated by `scripts/regenerate-docs.{sh,ps1}` on each commit.*
