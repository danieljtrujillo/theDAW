# theDAW User Guide

_by GANTASMO_

This guide documents theDAW end to end, from generating a piece out of a prompt through arranging it, mixing it, performing it live, and exporting the finished master. The in-app **Docs** button renders this guide as an interactive modal with Markdown download and print and PDF export.

---

## Table of Contents

1. [Repository Anatomy](#1-repository-anatomy)
2. [Architecture](#2-architecture)
3. [Installation](#3-installation)
4. [Launching the Application](#4-launching-the-application)
5. [UI Shell](#5-ui-shell)
6. [CREATE Tab — Audio Generation](#6-create-tab)
7. [EDIT Tab — Studio Effects](#7-edit-tab)
8. [TRAIN Tab — LoRA and Autoencoder](#8-train-tab)
9. [LIBRARY Tab — Persistent Generations](#9-library-tab)
10. [DAW Workspace — Waveform Editor](#10-waveform-editor)
11. [DAW Workspace — Step Sequencer](#11-step-sequencer)
12. [DAW Workspace — Piano Roll](#12-piano-roll)
13. [DAW Workspace — Bottom Panel Tabs](#13-bottom-panel-tabs)
14. [Player Footer](#14-player-footer)
15. [Processing Log](#15-processing-log)
16. [Backend API Reference](#16-backend-api-reference)
17. [Python Pipeline Reference](#17-python-pipeline-reference)
18. [Models](#18-models)
19. [LoRA Adapter Types](#19-lora-adapter-types)
20. [Troubleshooting](#20-troubleshooting)
21. [Development Workflows](#21-development-workflows)
22. [Feature Coverage and Screenshot Evidence](#22-feature-coverage-and-screenshot-evidence)

---

## 1. Repository Anatomy

| Layer | Path | Description |
|---|---|---|
| **ML pipeline** | `stable_audio_3/` | Upstream Stability AI code. DiT, SAME autoencoder, all samplers, LoRA parametrization, distribution-shift schedules, T5Gemma conditioner. |
| **FastAPI backend** | `backend/server.py` | HTTP wrapper around the pipeline. Async job queue for generation; synchronous endpoints for studio effects and model introspection. Port 8600. |
| **Backend modules** | `backend/modules/` | Plugin system. Each subdirectory provides `module.json` (name, API prefix, enabled flag) and `router.py` (FastAPI APIRouter). The loader (`backend/modules/loader.py`) discovers and mounts all enabled modules at startup; a failed module is logged and skipped without stopping the server. The `effects` module is the only built-in module and mounts at `/api/studio`. |
| **React UI** | `frontend/` | Tailwind 4 + React 19 + Zustand 5 + Vite 6. Multi-tab DAW interface. Proxies `/api/*` to the backend. Port 5173 in development. |
| **Gradio UI** | `run_gradio.py`, `stable_audio_3/interface/` | Upstream Gradio interface. Retains full pipeline access; the React UI supersedes it for daily use. Both share the same Python pipeline. |

---

## 2. Architecture

Request flow:

- Browser (`:5173` in dev / static in prod) calls `/api/...`.
- FastAPI backend (`:8600`) handles HTTP and dispatches generation/effects work.
- `StableAudioModel` composes:
  - T5Gemma text encoder (`models/conditioners.py`)
  - DiT diffusion transformer (`models/dit.py` → `models/transformer.py`)
  - SAME autoencoder (`models/autoencoders.py`)

### Two-stage generation

The DiT generates 256-dimensional latents at 1/4096 the source audio rate. The SAME autoencoder decodes those latents to 44.1 kHz stereo audio. These two stages share the same checkpoint for bundled models; standalone SAME checkpoints (`same-s`, `same-l`) are interchangeable with the bundled versions and reuse the cached full checkpoint when available.

### Checkpoint flavors

- **ARC** — post-trained checkpoints (`small`, `medium`). Optimized for 8-step inference with `cfg_scale=1`. Recommended for all generation tasks.
- **RF** — rectified-flow base checkpoints (`small-rf`, `medium-rf`). Require ~50 steps and `cfg_scale=7` at inference. Used as starting points for LoRA training.

### Web Audio engine

All in-browser audio — library playback, waveform editor preview, step sequencer, piano roll live notes — routes through a single shared `AudioContext` graph: source nodes → master gain node → analyser node → destination. The real-time spectral analyzer reads from the analyser node continuously; the player footer volume and mute controls drive the master gain.

---

## 3. Installation

### Base Python environment

```bash
uv sync
```

### Optional Linux CUDA wheels (Medium model)

```bash
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu126
```

### With dev dependencies

```bash
uv sync --group dev
```

### Windows-specific requirements

`pyproject.toml` includes CUDA 12.8 wheel sources for torch, torchaudio, and Flash Attention under `[tool.uv.sources]`. Running `uv sync` on Windows installs all of them automatically — no additional flags or manual wheel downloads required for Python 3.10 with CUDA 12.8.

If you are on a different CUDA version or Python version, install PyTorch manually:
```powershell
uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
```

`soundfile` is included in the base dependencies. Flash Attention is conditionally installed (`sys_platform == 'win32' and python_version < '3.11'`); the wheel URL in `pyproject.toml` targets Python 3.10 + CUDA 12.8 + torch 2.7.0. For other combinations, download a matching wheel from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

Full walkthrough: [docs/windows/setup-guide.md](windows/setup-guide.md).

### Frontend dependencies

```bash
cd frontend
npm install
```

`package-lock.json` is committed. Use `npm ci` to reproduce the exact dependency tree; `npm install` is acceptable in development.

---

## 4. Launching the Application

### One-shot launcher (Windows)

```powershell
.\start-dev.bat
```

Sequence:
1. Kills any stale process on ports 5173 and 8600.
2. Starts the FastAPI backend (`uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload`) in a new terminal window.
3. Waits 3 seconds for the backend to bind.
4. Starts the Vite dev server in a second terminal window.
5. Opens `http://localhost:5173` in the default browser.

The `--reload` flag on the backend triggers automatic restart when `backend/server.py` is modified.

### Manual launch

```bash
# Terminal 1 — backend
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload

# Terminal 2 — frontend
cd frontend && npm run dev
```

`vite.config.ts` proxies all `/api/*` requests to `http://localhost:8600`, so same-origin fetches require no CORS configuration in development.

### Gradio UI (legacy)

```bash
uv run python run_gradio.py --model medium
uv run python run_gradio.py --model medium --lora-ckpt-path path/to/lora.safetensors
```

---

## 5. UI Shell

The application window is divided into three persistent regions:

Layout summary:

- **Left panel** (resizable): brand, tab/controls content, run CTA, processing log.
- **Center workspace**: mode toolbar, main timeline/grid area, collapsible bottom multi-tab panel.
- **Player footer**: fixed transport bar across the bottom of the app.

**Full-width header:** a fixed bar spanning the entire window width. Contains: left-panel collapse/reveal toggle (chevron), the theDAW logo dot, a global search input, and action buttons (Docs, mobile access QR/link, Settings, User avatar, AI Assistant orb).

**Left panel resize:** drag the vertical handle on the panel's right edge. Range: 300 px to 500 px.

**Left panel collapse:** click the chevron in the header. theDAW workspace expands to full width. Click again to restore.

**Center tab switching:** the active workspace is controlled by the center tab bar in the locked order **MAKE / EDIT / MIX / TRAIN / LEARN / DJ / VJ** (`CENTER_TABS`). Legacy navigation targets such as CREATE, EDIT, TRAIN, and LIBRARY are translated into these center tabs so assistant actions, library sends, and older shortcuts still route correctly. theDAW workspace remains in place across all tab selections.

**Right-side library rail:** the Library is now a collapsible right-side panel rather than only a legacy left tab. Use the library button in the center tab bar to expand/collapse it; the rail width persists between 280 px and 640 px. This lets MAKE, MIX, LEARN, VJ, and editor workflows stay visible while selecting or routing library material.

**Docs modal:** click the Docs button in the header to open this guide in-app. The modal supports anchor links, syntax-highlighted Markdown tables/code blocks, raw Markdown download, and browser print/PDF export. The assistant RAG index is built from the same guide, so doc updates improve in-app help and AI context together.

**Mobile access share:** click the QR/link button in the header to copy or scan the current LAN/tunnel URL for mobile performance access. This is especially useful with the VJ tab and any browser-based controller/viewer.

**AI Assistant panel:** click the orb icon in the header to open the collapsible assistant panel. Streams chat from any configured LLM provider with RAG context sourced from this user guide, supports file attachments and voice input, and exposes provider/key-pool controls. See [§16.11](#1611-assistant) for the API reference.

**Viewport scaling:** the UI applies a CSS `zoom` factor based on viewport width (0.85 at < 1440 px; 0.95 at 1440–1919 px; 1.1 at ≥ 1920 px). Shell height calculations compensate so the layout tiles cleanly to the footer.

![UI shell with center tabs and right library rail](screenshots/01-shell-make.png)

![Header actions (Docs, share, settings, assistant)](screenshots/01-shell-make__header-actions.png)

---

## 6. CREATE Tab

### Purpose

Submits audio generation jobs to the backend and displays their output. Supports all three inference modes: text-to-audio, audio-to-audio, and inpainting/continuation.

### 6.1 PRIMARY SYNTHESIS / PROMPT

- **Prompt** - required. Plain-text description of the desired audio content, instrumentation, or sonic texture.
- **Negative prompt** - optional. Aspects or characteristics to suppress.
- **Magic prompt button** (sparkle icon, bottom-right of the prompt box) - inserts a sample prompt when the prompt field is empty. Clicking the sparkles icon sends the current text to the AI Assistant to optimize the prompt for Stable Audio conditioning.

### 6.2 GENERATION PARAMETERS

Six controls arranged in a 3-column grid:

| Control | Type | Notes |
|---|---|---|
| **Model** | Dropdown | `small`, `medium`, `small-rf`, `medium-rf`. Selecting an `-rf` variant automatically sets Steps to 50 and CFG to 7.0. |
| **Duration (s)** | Integer | Total output length in seconds. Small model: max 120 s. Medium/Large: max 380 s. |
| **Batch** | Integer | Number of simultaneous variations. Each variation produces a distinct library entry with its own seed. |
| **Steps** | Integer | Sampler denoising steps. ARC default: 8. RF default: 50. |
| **CFG** | Float | Classifier-free guidance scale. ARC default: 1.0. RF default: 7.0. Higher values increase adherence to the prompt but can introduce artifacts. |
| **Seed** | Integer + reroll button | Use −1 for a random seed on each run. The reroll button generates and displays a new random seed without submitting a job. |

### 6.3 ADVANCED GENERATION PANEL

The Advanced Generation Panel provides a dense layout for configuration.
- **Output Settings** controls automatic playback and automatic downloading behavior.
- **Quick Actions** route generated audio directly to the Waveform Editor, Init Audio, or Inpainting modules.
- **Templates Panel** allows users to save and restore full generation parameters.
- **Saved Prompts Dropdown** maintains a history of frequently used user-defined prompts.
- **Spectrogram Viewer** displays Mel, STFT, Chromagram, and CQT visualizations of generated audio.

Templates and saved prompts are stored in browser local storage and are intended for rapid iteration. The prompt sparkle action calls the assistant prompt enhancer (`/api/assistant/chat`) when text already exists, or inserts a sample prompt when empty.

### 6.3.1 Chimera Fusion Stack

Chimera fuses two or more audio clips into a single init signal before generation. Clips can be sent from the Library toolbar/context menu, Media Bucket, microphone recorder, or other send targets.

| Control | Description |
|---|---|
| **CHIMERA banner** | Always-visible status strip at the top of MAKE. Shows stack count and jumps to the Init Audio card. |
| **Target BPM** | `auto` uses the selected base clip BPM, median detected BPM, or 120 BPM fallback. A numeric value forces a target. |
| **Base clip** | Optional reference clip. When set, its BPM and/or duration can drive the fusion target. |
| **Noise / influence** | Per-clip noise slider maps to backend `weights`; higher noise means less influence on the fused output. |
| **Align mode** | `start` aligns clips from time zero, `downbeat` trims to detected first beats, and `weave` schedules chunks into an arrangement arc. |
| **Weave controls** | Chunk bars, total bars, and max polyphony shape the generated arrangement when `align_mode=weave`. |

Rendering posts to `POST /api/chimera/mashup`, normalizes inputs to 44.1 kHz stereo, detects tempo/beats, time-stretches clips, and returns a WAV File plus metadata (`target_bpm_used`, per-clip stretch ratios, warnings). The fused result can then be used as Init Audio for Stable Audio generation.

![Chimera multi-select cohort and stack flow](screenshots/09-chimera-cohort-multi-select__chimera-multi-select.png)

### 6.4 INIT SIGNAL / CONDITIONING

Audio-to-audio mode. Upload a source file via the dropzone to condition the model on existing audio.

- **Init Noise (0–1)** — controls the ratio of source signal to random noise injected at the start of the denoising trajectory. Lower values preserve more of the source character; higher values grant the model more generative freedom.
- **Type** — `Audio` (standard) or `RF-Inv` (RF-Inversion, only meaningful with `-rf` model variants).

Removing the source file returns the form to text-to-audio mode.

### 6.4.1 Microphone Recorder

The browser-side Mic Recorder uses `navigator.mediaDevices.getUserMedia` plus `MediaRecorder` to capture live audio without leaving the app. Supported browser encodings are selected in order: WebM/Opus, OGG/Opus, MP4/AAC, then WAV fallback.

After recording, the review card can:
- play/pause the take inline;
- send it to a new editor track or the first editor track tail;
- send it to Init Audio or Inpaint Audio;
- import it into the disk-backed Library through `POST /api/library/import` so stems, MIDI conversion, lineage, and bundle downloads can run against it later.

### 6.5 INPAINTING / REGEN REGION

Replaces a defined time window within a source audio clip while preserving everything outside that window.

- **Enable toggle** (section header) — must be active for the inpainting payload to be submitted. Activates automatically when a source file is loaded.
- **Source dropzone** — accepts drag-and-drop or click-to-upload.
- **Waveform preview** — rendered by WaveSurfer once a file is loaded.
- **Region selection** — drag horizontally across the waveform to define the regeneration window. The Start, End, and Region Duration readouts update in real time.
- **Continuation** — to extend audio beyond its current end, drag the region to the end of the waveform and set Duration to a value larger than the source length. The model fills the extension conditioned on the existing audio tail.

The form field `mask_start` and `mask_end` are submitted in seconds relative to the start of the inpaint audio file.

### 6.6 LORA / ADAPTIVE LAYERS

Stack one or more LoRA adapters for the next generation. Each adapter row displays its name, a weight slider (0-1), and a remove button.

> **Current status:** UI scaffolding. The `/api/generate-jobs` endpoint does not yet forward LoRA references to the pipeline. LoRA at inference is supported directly via the Python API (see [§17.5](#175-lora-at-inference)) and the Gradio UI.

### 6.7 Output Status Monitor

Appears below the accordion after a job is submitted or completed.

- Binary progress bar (`queued -> running -> completed`).
- Engine information chip (model, steps).
- Inline audio player for the completed result.
- Download and clear buttons.
- All completed results are concurrently auto-saved to the Library.

### 6.8 RUN GENERATION

Sticky bar fixed at the bottom of the left panel. Submits the generation job to `POST /api/generate-jobs`. While a job is active, the button changes to a red **ABORT** button showing an estimated percentage. Clicking Abort cancels the polling loop; the backend job continues running but its result is discarded by the UI.

---

## 7. EDIT Tab

### Purpose

Applies one of 24 FFmpeg-backed audio processing effects to a source file. Processing is synchronous; the result is returned as binary audio and made available for inline playback.

### 7.1 Studio Macros

Four global macro sliders whose values are translated into effect-specific parameters:

| Macro | Range | Effective parameter (varies by effect) |
|---|---|---|
| **Drive** | 0–100 | Compression attack, low boost |
| **Width** | 0–100 | Compression decay, stereo delay |
| **Air** | 0–100 | High boost, lowpass frequency |
| **Punch** | 0–100 | Sub boost, low boost |

### 7.2 FX Chain

A vertical list of effects to construct a processing chain. Each row shows the effect name, an active/inactive toggle, and a color indicator. The currently selected row defines the effect submitted to the backend.

| Effect key | Description | Macro-derived parameters |
|---|---|---|
| `mastering_chain` | EQ + limiting + LUFS normalization | lowBoost, highBoost, limiterCeiling, targetLUFS |
| `compression` | Dynamic range compression | attack, decay |
| `highpass` | High-pass filter | cutoff frequency |
| `lowpass` | Low-pass filter | cutoff frequency |
| `volume` | Gain adjustment | output level |
| `tempo` | Time-stretch / playback rate | rate |
| `vocal_processing` | High-pass + presence boost + LUFS normalization | highpassFreq, presenceBoost, targetLUFS |
| `lofi_vinyl` | Bit degradation + low-pass | degradation, lowpassFreq |
| `stereo_widener` | Haas-effect widening | delayMs |
| `reverb_delay` | Combined reverb + delay | delayMs, decay, reverbDecay |
| `sub_exciter` | Sub-bass and treble harmonic excitation | subBoost, trebleBoost |
| `phase_isolation` | Mid-side phase cancellation | cancelAmount |
| `eq_mid` | Single-band parametric EQ | frequency, width (Q), gain |
| `loudnorm` | ITU-R BS.1770 loudness normalization | targetLUFS, truePeak |
| `pitch_shift` | Semitone pitch transposition | shift (cents) |
| `delay` | Stereo delay | leftMs, rightMs |
| `echo` | Echo with feedback | delayMs, decay |
| `fade` | Linear fade-in and fade-out | fadeInDuration, fadeOutDuration |
| `denoise` | Noise floor reduction | noiseReduction |
| `declick` | Impulse noise removal | windowSize |
| `silence_remove` | Leading/trailing silence trimming | threshold |
| `export_flac` | Lossless FLAC export | compressionLevel |
| `export_mp3` | Lossy MP3 export | bitrate |
| `export_aac` | AAC export | bitrate |
| `export_opus` | Opus export | bitrate |

All effects are dispatched to `ffmpeg` via `subprocess.run`. Server-side bounds checks apply to all parameters; out-of-range values return HTTP 400.

### 7.3 Source and Output

- **Source dropzone** — upload an audio file; or click **Use Last Output** to promote the most recent result as the new source.
- **Output format selector** — `wav`, `flac`, `ogg`, `mp3`, `aac`, `opus`.
- **Process button** — submits to `POST /api/studio/process`. The binary audio response is wrapped in a Blob URL for inline playback.

### 7.4 Process History

The last 8 processing invocations are retained in the store. Any item in the history list can be selected and promoted to the current source via **Reuse as source**.

### 7.5 Advanced Editor Panel

The advanced editor surface expands the basic EDIT flow into a categorized chain builder for mastering, dynamics, EQ, tempo, cleanup, and export operations.

- **Effect catalog:** categories expose the same FFmpeg-backed processors as the standard FX chain, with list/tile view modes and color-coded groups.
- **Chain processing:** add multiple effects, toggle individual rows active/inactive, reorder the chain, and clear it in one action.
- **Parameter editing:** each effect displays bounded sliders and numeric fields sourced from `PARAM_BOUNDS` / `EFFECT_CATALOG`.
- **Source/output waveform previews:** uploaded or dragged-in files show waveform previews plus peak, RMS, sample-rate, and duration stats.
- **Resizable columns:** sidebar and chain columns can be dragged wider/narrower for dense mixing sessions.
- **Library drag-in:** library entries use the `application/x-stabledaw-library-id` transfer protocol so a persisted track can become the source file without a manual download.

---

## 8. TRAIN Tab

### Purpose

Interface for LoRA fine-tuning configuration and autoencoder round-trip validation. Some endpoints are fully implemented in the backend; others are stubs in this fork pending integration.

### 8.1 Target Architecture

| Field | Description |
|---|---|
| **Module name** | Output checkpoint filename label. |
| **Target module** | Which submodule to attach LoRA to (`attn_kv` is the default and most-tested). |
| **Epochs / Steps** | Training step budget. |
| **Rank** | LoRA rank. Controls the number of trainable parameters per layer. |
| **Alpha** | Scaling factor. Effective update scale = alpha / rank. Setting alpha = rank gives a scale of 1.0. |
| **Dataset path** | Server-side filesystem path containing audio files and paired text prompts. |

### 8.2 Pre-encode Workflow

Pre-encoding a dataset to latents before training accelerates iteration. Submit a dataset path and output path; the backend job runner calls `pre_encode.py` against the dataset.

> **Backend status:** stub — returns HTTP 501. Use `python -m stable_audio_3.scripts.pre_encode` directly until this is wired.

### 8.3 Autoencoder Round-trip

Upload an audio file; the backend encodes it to base64-serialized latents and then decodes them back to audio for reconstruction quality verification.

> **Backend status:** `/api/autoencoder/info` returns an empty list, so the TRAIN tab displays "no autoencoders available." Encode and decode endpoints return HTTP 501. Certain training endpoints are currently unimplemented on the backend and return HTTP 501 status codes. The frontend intercepts these responses to provide specific error messages in the user interface instead of generic network errors.

### 8.4 Job Polling

Long-running training jobs are tracked via `GET /api/jobs/{id}` polled at 1-second intervals. The `logs` field of the response is rendered as a streaming console output.

---

## 9. LIBRARY Tab

### Purpose

Persistent storage for generated, imported, processed, recorded, and fused audio. The default provider is **backend-local**: metadata is mirrored through `/api/library/*`, audio is stored on disk under `data/generations/`, and playback uses range-streamed file responses so large tracks can scrub without loading the full file into memory. Older browser-local IndexedDB behavior is superseded by this provider but the frontend still keeps transient Blob caches for efficient repeated use in a session.

### 9.1 Automatic Entry Creation

Every successful generation in the CREATE tab produces one or more library entries. Batch jobs produce N entries with IDs `${jobId}_0`, `${jobId}_1`, …

Each entry stores:

```typescript
{
  id: string,
  title: string,
  prompt: string,
  negativePrompt: string,
  model: string,
  duration: number,       // seconds
  steps: number,
  cfg: number,
  seed: number,
  audioBlob: Blob,
  mimeType: string,
  timestamp: string,      // ISO 8601
  favorite: boolean,
  rating: number | null,
  tags: string[],
  notes: string,
  source: 'generate' | 'editor-mixdown' | 'bucket'
}
```

Waveform editor mixdowns, studio outputs, mic recordings, imports, and Chimera renders can also be saved here. Server records expose `audio_url`, `audio_filename`, `file_size_bytes`, mutable `favorite`, `rating`, `tags`, `notes`, and optional `chimera_sources` fields. User edits are persisted with `PATCH /api/library/entries/{id}`.

### 9.2 List and Grid Views

Toggle between a dense **List** view (one row per entry) and a **Grid** view (tile cards) via the icons in the section header. List view shows title, prompt preview, model chip, duration, date, file size, and a per-entry action cluster.

### 9.3 Search, Filter, Sort

- **Search** — filters across title, prompt, model, tags, and notes fields simultaneously.
- **FAVS** toggle — restricts the view to favorited entries.
- **Sort** — Newest (timestamp descending), Duration (longest first), or Title (alphabetical).

### 9.4 Per-entry Controls

| Control | Description |
|---|---|
| **Play / Pause** | Loads and plays the entry through `playerStore`. Pausing one entry while another is active stops playback globally. |
| **Favorite star** | Toggles the favorite flag; persisted to IndexedDB immediately. |
| **Download** | Triggers a browser file download of the audio Blob. |
| **Delete** | Removes the entry from IndexedDB and from the in-memory store. |
| **Scissors icon** | Decodes the audio Blob, computes 240-bin waveform peaks, and appends the clip to the first available waveform editor track. If no tracks exist, a new track is created. |
| **Row click** | Selects the entry; the Details panel in the bottom tab bar reflects the selection. |

Right-clicking an entry opens the per-row context menu. Depending on installed modules and selected entry state, it can send to Init, send to Inpaint, run analysis, separate stems, convert to MIDI, download a bundle, show lineage, or delete the entry.

![Library details rail with selected entry](screenshots/02-library-with-showcase-selected__library-details.png)

![Library entry context menu actions](screenshots/05-library-entry-right-click__entry-context-menu.png)

### 9.5 Bundle Downloads and Lineage

The Library can export a self-contained ZIP bundle from `GET /api/library/{entry_id}/bundle`. Bundles include the audio file, metadata, analysis rows, stem rows, MIDI rows, and lineage edges when available.

Lineage endpoints build parent/child graphs for generated, imported, stem, MIDI, and Chimera-derived assets:
- `GET /api/library/{entry_id}/lineage?depth=4` returns nodes/edges around one entry.
- `GET /api/library/_graph/all` returns the complete local genealogy graph, including virtual nodes for stems, MIDI files, and external source labels.

The LEARN tab and Lineage modal visualize this graph in 2D/3D, with appearance options, fit/reset controls, and node details.

![Library bundle and download submenu](screenshots/04-library-download-submenu__download-submenu.png)

![LEARN lineage 3D graph](screenshots/06-learn-tab-3d-graph__lineage-graph.png)

### 9.6 Stem Separation

The stems module mounts at `/api/stems` and runs a sidecar-backed separation pipeline. Library entries can be split into 2, 4, 6, or 12 stems; progress is persisted in the library database and stem audio is served through `GET /api/library/stems/{stem_id}/audio` for editor/init/inpaint routing.

Important endpoints:
- `GET /api/stems/probe` — check tool availability without spawning the sidecar.
- `POST /api/stems/install` — install integration dependencies into the configured Python environment.
- `POST /api/stems/start` / `POST /api/stems/stop` — manually control the sidecar.
- `POST /api/stems/{entry_id}/run` — separate one library entry.
- `GET /api/stems/{entry_id}/progress` — poll `phase`, `message`, `progress`, and `task_id`.
- `POST /api/stems/{entry_id}/abort` — request cancellation at the next poll tick.

### 9.7 MIDI Conversion

The MIDI module mounts at `/api/midi` and can convert full tracks or separated stems to Standard MIDI Files. It supports installable engines such as `basic_pitch` and `piano_transcription_inference`.

Important endpoints:
- `GET /api/midi` — capability report and available engines.
- `POST /api/midi/install?engine=basic_pitch` — install a conversion engine.
- `POST /api/midi/{entry_id}/run?from_stems=true` — run conversion for one entry.
- `GET /api/midi/{entry_id}` — list MIDI rows for an entry.
- `GET /api/midi/file/{midi_id}` — stream `.mid` bytes for import into Piano Roll or Step Sequencer.

### 9.8 Library Analysis

A stats footer displays: total entry count, favorites count, cumulative storage size (sum of all Blob sizes), and cumulative playback duration.

### 9.9 Empty State

Displayed until the first generation. Contains a **Go generate something** button that switches the active left-panel tab to CREATE.

---

## 10. Waveform Editor

### Purpose

Multi-track audio composition surface. Clips are slices of source audio Blobs placed on a pixel-per-second timeline. All editing is non-destructive at the Blob level; rendering occurs on demand via `OfflineAudioContext`.

### 10.1 Toolbar

| Control | Description |
|---|---|
| **ADD TRACK** | Appends an empty track. Track names auto-inherit from the first clip placed on them and are editable at any time. |
| **Move tool** | Default tool. Drag clips horizontally to reposition in time; drag vertically to move between tracks. |
| **Cut tool** | Click anywhere inside a clip to split it at that position. The right half becomes a new clip referencing the same source Blob with an adjusted `offsetIntoSource`, preserving source alignment. |
| **Snap** | Off / 1/4 / 1/8 / 1/16 — quantizes drag and resize operations to note-grid intervals relative to the editor BPM. |
| **Zoom in / out** | Adjusts the timeline resolution in pixels-per-second. Range: 5–400 px/s. |
| **Delete** | Removes the selected clip. The Delete and Backspace keyboard keys perform the same action when a clip is selected. |
| **Mixdown name** | Text input field. Sets the output filename on COMMIT EDIT. If empty, the committed file defaults to `mixdown_<id>.wav`. Automatically appends `.wav` if the user does not include the extension. |
| **COMMIT EDIT** | Renders the composition to a WAV file. See §10.6. |

### 10.2 Per-track Controls

Each track has a fixed-width header to the left of the timeline lanes:

| Control | Description |
|---|---|
| **Name** | Editable text. Click to edit in place. Color matches the track's assigned hue. |
| **M (Mute)** | Silences the track in both preview and final render. |
| **S (Solo)** | Exclusive across all tracks: soloing a track mutes all others. Soloing a second track adds it to the active set. |
| **× (Remove)** | Deletes the track and all clips assigned to it. |
| **Volume slider** | Per-track gain, 0–1. Applied in both preview and offline render. |
| **Pan slider** | Per-track stereo position, −1 (full left) to +1 (full right). Applied via a `StereoPannerNode` in the offline render. |

### 10.3 Per-clip Display and Handles

Each clip renders a downsampled waveform (240 bins, normalized) as a visual background, with a header label and duration readout.

**Resize handles:** thin strips at the left and right edges. Dragging the left handle adjusts both `startSec` (timeline position) and `offsetIntoSource` (in-point into the source audio) together, so the audio content at the playhead position remains constant. Dragging the right handle adjusts only `durationSec` (out-point).

**Fade handles:** vertical semi-transparent lines with a circular grab point near the bottom edge. The fade-in handle sits inset from the left edge; dragging it right extends the fade-in duration. The fade-out handle sits inset from the right edge; dragging it left extends the fade-out duration. Both fades are applied as linear gain ramps in the offline render and as `gain.linearRampToValueAtTime` automation during preview.

### 10.4 Inpainting from the Editor

Regenerate a sub-region of any clip using the model, while keeping the surrounding audio intact.

1. Select a clip.
2. Switch to the **Paintbrush** tool (or right-drag within a clip while in Move mode) to draw an inpaint selection region. The selection is visualized as a highlighted band across the clip.
3. Click **INPAINT REGION** to open the inpaint panel.
4. Set the prompt, number of steps, and seed.
5. Click **Generate** to submit an async job.

The submission process:
- The visible clip region (from `offsetIntoSource` to `offsetIntoSource + durationSec`) is extracted from the source Blob as a cropped WAV via `cropAudioBlob`. This ensures correct behavior for trimmed or split clips regardless of their in-point.
- Mask coordinates are computed relative to the start of the cropped audio: `maskStart = selection.startSec − clip.startSec`, `maskEnd = selection.endSec − clip.startSec`.
- The cropped WAV and mask are sent to `POST /api/generate-jobs`.

On completion, the result enters a **Review** phase:
- An inline audio player allows audition of the regenerated region.
- **Accept** replaces the clip's source Blob with the result and clears the inpaint selection.
- **Discard** dismisses the panel without modifying the clip.

### 10.5 Timeline Interaction

- **Playhead** — the red vertical line. Click any empty area in the timeline to position the playhead. The footer transport's skip-to-start button resets it to 0.
- **Deselect** — click empty space in a track lane to deselect the active clip.
- **Scroll** — horizontal scroll on the timeline area moves the view.
- **Status bar** — displays live timecode as `MM:SS.cs / MM:SS.cs` (current / total), clip count, track count, and the selected clip's start→end range.

### 10.6 COMMIT EDIT

Renders the complete composition to a single 44.1 kHz stereo WAV.

Render process:
1. All non-muted (or exclusively soloed) tracks are collected.
2. Clip source Blobs are decoded in a temporary `AudioContext` (one decode per unique Blob, cached for clips sharing a source). A 15-second timeout guards against stalled decode operations.
3. A `OfflineAudioContext` is initialized at 44.1 kHz stereo with a duration equal to the total timeline length.
4. Each clip is scheduled via `BufferSourceNode.start(clipStartSec, offsetIntoSource, durationSec)`. Per-track volume and stereo pan are applied. Fade-in and fade-out gain envelopes are automated with `linearRampToValueAtTime`.
5. `OfflineAudioContext.startRendering()` produces the final `AudioBuffer`.
6. A WAV Blob is encoded as 16-bit PCM (`encodeWav`).
7. The Blob is saved to the Library (`source: 'editor-mixdown'`).
8. A browser file download is triggered automatically.

During the render, the COMMIT EDIT button shows an animated spinner and is disabled.

---

## 11. Step Sequencer

### Purpose

A 16-step drum machine driven by a BPM clock, with five synthesized voice types. All audio routes through the shared Web Audio engine.

### 11.1 Transport

| Control | Description |
|---|---|
| **Tempo (BPM)** | Clock rate, 40–240 BPM. Each step represents a 16th note. |
| **Play / Stop** | Starts and stops the step clock. The first press unlocks the `AudioContext` (browser autoplay policy). |
| **Random Fill** | Randomizes the step pattern for every track simultaneously. |
| **Clear** | Sets all step buttons to off for all tracks. |
| **Add Track (+)** | Appends a new track with a synthesized voice. |

### 11.2 Voice Synthesis

Each track's voice is synthesized on-the-fly via the Web Audio API:

| Voice | Synthesis method |
|---|---|
| **kick** | Pitched sine oscillator with a rapid frequency sweep (pitch drop) and an exponential gain decay. |
| **snare** | Bandpass-filtered noise burst combined with a short tonal sine body. |
| **hat** | White noise passed through a high-frequency bandpass filter with a short gain decay. |
| **tone** | Sawtooth oscillator through a low-pass filter with an ADSR envelope. Frequency set by the track's `freq` parameter. |
| **noise** | White noise through a frequency-dependent low-pass filter with a short decay. |

All voices share the same `triggerVoice` function, which accepts a `BaseAudioContext` and destination node. This allows identical synthesis code to be used for both live playback and offline rendering.

### 11.3 Per-track Controls

| Control | Description |
|---|---|
| **Name** | Editable text label. |
| **Voice chip** | Displays the current voice type. Click to cycle through `kick → snare → hat → tone → noise`. |
| **Volume slider** | Per-track gain, 0–1. |
| **Step buttons (16)** | Toggle individual steps on/off. Buttons on beats 1, 5, 9, 13 have a distinct visual emphasis. |
| **Preview (target icon)** | Hover-revealed. Triggers the voice once without starting the clock. |
| **Remove (trash icon)** | Hover-revealed. Deletes the track. |

### 11.4 Send to Editor

Renders the current pattern offline to a WAV Blob using `OfflineAudioContext`, then appends it to the waveform editor as a new clip on a new track. The clip's source kind is set to `'audio'`.

### 11.5 MIDI Export

The sequencer can also export Standard MIDI Files:
- **Single mixed track / single-track MIDI** writes all active voices into one MIDI track.
- **One track per voice / multi-track MIDI** writes each sequencer lane as a separate MIDI track.
- **Bars to render** controls the offline audio render length when sending to the editor.

These exports use the same PPQ timing constants as live playback (`PPQ = 480`, one 16th note = `PPQ / 4`) so MIDI files line up with the sequencer grid.

---

## 12. Piano Roll

### Purpose

MIDI-style note editor for melodic and harmonic content. Notes are placed on a chromatic grid, rendered to audio via a sawtooth+filter synthesizer, and can be exported as MIDI or sent to the waveform editor.

### 12.1 Grid and Keyboard

A vertical chromatic keyboard (MIDI notes 0–127, configurable visible range) occupies the left axis. The horizontal grid represents time in 16th-note steps at the configured BPM. Black and white keys are visually distinguished; note labels appear on C notes.

### 12.2 Note Editing

| Action | Result |
|---|---|
| Click on empty grid cell | Places a new note at that pitch and step position. |
| Drag a placed note horizontally | Repositions the note in time. |
| Drag the right edge of a note | Resizes the note's duration. |
| Click a placed note | Selects it. |
| Delete / Backspace | Removes the selected note. |

### 12.3 Playback

The Play button starts a step-based clock that advances `currentStep` and triggers each note whose `step` index matches, routed through the shared engine `AudioContext` and master gain node. Output is audible in the spectral analyzer. Stop halts the clock.

### 12.4 BPM and Grid Length

- **BPM** — sets the tempo for both playback and offline render. Range: 40–240.
- **Total Steps** — defines the loop length in 16th-note steps. Longer values extend the grid horizontally.

### 12.5 MIDI Import and Export

- **Import MIDI** — parses a `.mid` file via `parseMidi` and replaces the current note list with the imported content. Tempo and note mappings are preserved.
- **Export MIDI** — serializes the current note list to a standard MIDI file via `downloadMidi` and triggers a browser download.

### 12.6 Send to Editor

Renders the current note pattern to a 44.1 kHz stereo WAV via `OfflineAudioContext`. The rendered clip is appended to the waveform editor on a new track. The clip's metadata records `sourceKind: 'piano-roll'`, the note list, BPM, and grid length, enabling it to be re-opened for editing.

### 12.7 Edit in Piano Roll

Clips in the waveform editor whose `sourceKind` is `'piano-roll'` display an **Edit in Piano Roll** action. Triggering it loads the clip's stored note list and BPM into the piano roll store and switches the bottom panel to the Piano Roll tab.

---

## 13. Bottom Panel Tabs

The bottom panel is collapsible and vertically resizable (drag the grip handle above it). Four tabs are available:

### 13.1 Real-time Spectral Analyzer

Live visualization of the shared Web Audio engine's output, reading from the engine analyser node continuously via `requestAnimationFrame`.

**Display modes** (O / S / R buttons, vertical column, top-left of canvas):

| Mode | Description |
|---|---|
| **Oscilloscope (O)** | Time-domain waveform drawn with a purple glow. Amplitude on the vertical axis; sample index on the horizontal. |
| **Spectrum (S)** | Frequency-domain bar chart. Bins are log-scaled; bar height represents magnitude. Gradient from deep purple at the base to lavender at the peak. Bars are constrained below the status overlay to prevent visual overlap. |
| **Radial (R)** | Frequency data mapped to a polar coordinate shape, drawn as a closed path centered in the canvas. |

**Status overlay** (bottom of canvas, gradient backdrop):

- Sample rate (kHz) and FFT size.
- RMS level in dBFS (sampled every 5 animation frames), indicated with a yellow lightning icon.
- Peak level in dBFS, indicated with a green target icon.
- LIVE / SILENT state (signal threshold: −60 dBFS). LIVE animates with a purple pulse.
- Settings and fullscreen toggle buttons.

Text in the overlay uses `textShadow` for legibility against any visualization content behind it.

**Canvas scaling:** the canvas element is sized to its container in physical pixels (device pixel ratio capped at 2×) via a `ResizeObserver`. The `style` dimensions are set in CSS pixels, so the canvas is always crisp on high-DPI displays.

### 13.2 Details

Displays full metadata for the currently selected library entry.

| Field | Displayed value |
|---|---|
| Title | Entry title |
| Prompt / Negative prompt | Generation text |
| Model | Model key |
| Duration | MM:SS.ms |
| Steps / CFG / Seed | Generation parameters |
| Timestamp | Locale date and time |
| File size | Bytes / KB / MB |
| Tags / Notes | Editable per-entry |
| Source | `generate`, `editor-mixdown`, or `bucket` |

**Actions:**
- **Audition in engine** — loads the entry into `playerStore` and begins playback.
- **Send to editor** — decodes waveform peaks and appends to the waveform editor as a new clip.
- **Download** — browser file download of the audio Blob.

### 13.3 Piano Roll

Full piano roll interface embedded in the bottom panel. See [§12](#12-piano-roll) for the complete reference.

### 13.4 Media Bucket

Session-scoped file holding area for arbitrary audio files. Contents are lost on page reload.

- **Dropzone** - accepts drag-and-drop or click-to-upload. Supported formats: WAV, MP3, FLAC, OGG, AAC, M4A, Opus. Users can drag entries from the Library tab and drop them directly into the Media Bucket, Waveform Editor, and Step Sequencer. This operation utilizes the application/x-stabledaw-library-id data transfer protocol to locate the source file from the IndexedDB store.
- **Per-item display** — filename, MIME type, file size.
- **Send to Editor** — decodes peaks and appends the item to the waveform editor as a new clip on a new track. Non-audio files are rejected with a log entry.
- **Send to Library** — decodes the audio, measures its duration, and creates a persistent IndexedDB entry with `source: 'bucket'`.
- **Remove** — removes the item from the bucket. Does not affect the library or editor.
- **Clear all** — removes all items simultaneously.

---

## 14. Player Footer

A fixed bar at the bottom of the viewport (z-index 50). Visible and functional across all tabs and workspace modes.

### 14.1 Track Information (left region)

- **Thumbnail** — animated music-note icon with a purple pulse when audio is playing.
- **Title** — the current `playerStore.currentLabel`. Truncated to fit the column.
- **Model chip** — derived from `useGenerateStore.lastModelName`. Shows `LIBRARY` for entries loaded from the library, and `IDLE` when nothing has been generated or loaded.
- **Duration readout** — `MM:SS // 48kHz`. Reads from `playerStore.duration`.

### 14.2 Transport (center region)

| Control | Description |
|---|---|
| **Loop** | Toggles looped playback in `playerStore`. Active state shown in purple. |
| **Skip to start** | Calls `playerStore.seekByFraction(0)`. |
| **Play / Pause** | Primary playback toggle. In EDIT workspace mode with no editor audio loaded, the first press triggers an offline render of the waveform editor timeline, loads the result into `playerStore`, and begins playback. Subsequent presses toggle playback natively. |
| **Skip to end** | Calls `playerStore.seekByFraction(1)`. |
| **Fullscreen** | Toggles browser fullscreen on `document.documentElement`. |

**Progress bar:** a horizontal track showing playback position. Click anywhere to seek (`playerStore.seekByFraction`). On hover, a circular scrubber handle appears at the current position. Time labels at left and right show current time and total duration. The Player Footer synchronizes its playhead position with the Waveform Editor. Scrubbing the transport progress bar updates the editor timeline position when the editor timeline is the active audio source.

### 14.3 Utilities (right region)

- **Mute toggle** — switches the `playbackStore` mute flag. The volume icon changes to a red `VolumeX` when muted.
- **Volume slider** — an overlay `<input type="range">` drives `playbackStore.volume` (0–100). The visual fill scales proportionally. The combined `volume × !muted` value is forwarded to `playerStore.setMasterGain`, which drives the shared Web Audio master gain node.
- **Download** — retrieves the library entry whose `id` matches `playerStore.currentEntryId` and triggers a browser file download.
- **More** — decorative.

---

## 15. Processing Log

A collapsible message log pinned between the left panel content and the player footer.

### Producers

| Source | Events |
|---|---|
| `system` | Application startup, model load status. |
| `health` | Backend connectivity check results. |
| `generate` | Job submission, progress, completion, errors. |
| `training` | LoRA job updates (when wired). |
| `studio` | Studio processing results and errors. |
| `sequencer` | Sequencer start/stop, render events. |
| `library` | IndexedDB save/load events. |

### Log Levels

Each entry has a severity level displayed as a colored left-border indicator:

| Level | Color | Usage |
|---|---|---|
| `info` | Purple | Normal operational events. |
| `warn` | Amber | Non-fatal anomalies. |
| `error` | Red | Failures that prevented an operation from completing. |
| `debug` | Gray | Verbose internal state for development. |

### Controls

- **Ring buffer capacity:** 500 entries. Oldest entries are discarded when the cap is reached.
- **Auto-scroll:** the log panel automatically scrolls to the most recent entry.
- **Download (📥):** exports the full buffer as `stabledaw-log-YYYYMMDD-HHMMSS.txt`. Each line contains an ISO timestamp, level, source, and message.
- **Clear (🗑️):** wipes the ring buffer.
- **Collapse/expand:** click anywhere on the header bar. Collapsed state shows the entry count and a "click to expand" hint.

---

## 16. Backend API Reference

All endpoints are served under `/api/*` on port 8600. Error responses use `{"detail": string}` (FastAPI default) or `{"error": string}`. The `SA3_DEBUG_ERRORS` environment variable (set to `"1"`) enables additional detail fields in error responses.

### 16.1 Health

```
GET /api/health
```

Response when healthy:
```json
{ "status": "ok", "model_loaded": true }
```

Response when degraded (HTTP 503):
```json
{ "status": "degraded", "model_loaded": false, "error": "MODEL_LOAD_FAILED" }
```

### 16.2 System Statistics

```
GET /api/system-stats
```

Returns a JSON object detailing current hardware utilization. This endpoint invokes nvidia-smi and polls psutil to stream GPU VRAM usage, GPU Temp, GPU Utilization, CPU usage, and RAM usage.

### 16.3 Model Info

```
GET /api/model-info
```

```json
{
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

### 16.3 Generation — Async (theDAW UI)

Submit:
```
POST /api/generate-jobs   multipart/form-data
```

| Field | Type | Default | Description |
|---|---|---|---|
| `prompt` | string | required | Generation text prompt. |
| `negative_prompt` | string | `""` | Aspects to suppress. |
| `model_name` | string | `"medium"` | Model key. |
| `duration` | float | `30.0` | Output length in seconds. |
| `steps` | int | `8` | Denoising steps. |
| `cfg_scale` | float | `1.0` | Classifier-free guidance scale. |
| `seed` | int | `-1` | −1 for random. |
| `batch_size` | int | `1` | Number of simultaneous variations. |
| `init_noise_level` | float | `1.0` | Audio-to-audio conditioning strength. |
| `init_audio_type` | string | `"Audio"` | `"Audio"` or `"RF-Inv"`. |
| `file_format` | string | `"wav"` | Output file format. |
| `mask_start` | float | `0.0` | Inpaint region start in seconds. |
| `mask_end` | float | `0.0` | Inpaint region end in seconds. |
| `init_audio` | file | optional | Source audio for audio-to-audio mode. |
| `inpaint_audio` | file | optional | Source audio for inpainting. |

Response:
```json
{ "job": { "id": "<uuid>" } }
```

Poll:
```
GET /api/jobs/{job_id}
```

```json
{
  "id": "...",
  "kind": "generate",
  "status": "queued | running | completed | failed",
  "progress": { "step": 4, "steps": 8 },
  "result": {
    "batch": false,
    "item": { "audio_base64": "...", "mime_type": "audio/wav", "filename": "..." }
  },
  "error": "..."
}
```

Batch results use `"batch": true` with an `"items"` array instead of a single `"item"`.

### 16.5 Spectrogram Generation

```
GET /api/spectrogram/{job_id}
GET /api/spectrogram/{job_id}/{index}
```

Retrieves cached spectrogram output to prevent redundant generation overhead.

### 16.6 Generation - Sync (Legacy / Gradio)

```
POST /api/generate   multipart/form-data
```

Identical surface to `/api/generate-jobs` with additional advanced parameters: `sampler_type`, `apg_scale`, `sigma_max`, `cfg_rescale`, `cfg_norm_threshold`, `cfg_interval_min`, `cfg_interval_max`, all distribution-shift parameters (`dist_shift_type`, `logsnr_*`, `flux_*`, `full_*`), and RF-Inversion parameters (`inversion_steps`, `inversion_gamma`, `inversion_unconditional`).

Response: raw binary audio body (`audio/wav` by default). Retained for backwards compatibility and the Gradio UI.

### 16.7 Studio Processing

```
POST /api/studio/process   multipart/form-data
```

| Field | Type | Description |
|---|---|---|
| `audio` | file | Input audio. Required. |
| `effect` | string | One of the effect keys from §7.2. |
| `params` | string | JSON-serialized `Record<string, number>`. |
| `output_format` | string | `wav`, `flac`, `ogg`, `mp3`, `aac`, or `opus`. |

Response: binary audio body with the appropriate `Content-Type` header.

### 16.8 Jobs List

```
GET /api/jobs
-> Array of all job objects currently in the in-memory store.
```

The job store is in-memory only. All jobs are lost on backend restart.

### 16.9 Training and Autoencoder (Stub Endpoints)

| Endpoint | Status |
|---|---|
| `GET /api/autoencoder/info` | Returns empty arrays. |
| `POST /api/jobs/train-lora` | HTTP 501. |
| `POST /api/jobs/pre-encode` | HTTP 501. |
| `POST /api/autoencoder/encode` | HTTP 501. |
| `POST /api/autoencoder/decode` | HTTP 501. |

### 16.10 Presets

```
GET /api/presets   -> []
POST /api/presets  -> { "id": "<uuid>", "saved": true }
```

Not consumed by the UI. Reserved for future use.

### 16.11 Assistant

All routes under `/api/assistant` are provided by `backend/assistant_routes.py`.

**Provider catalog**
```
GET /api/assistant/providers
→ { "providers": [ { "id", "label", "default_model", "has_key", "is_local" }, ... ] }
```

Returns one entry per configured provider. `claude` (Claude Code CLI) is always present and `has_key: true`. Remote providers with no API key in the environment are still listed but requests to them will fail.

**Model discovery**
```
GET /api/assistant/models/{provider_id}
→ { "models": [...], "model_ids": [...], "error": null | string }
```

For `openrouter` and `openrouter-free`: fetches the model list from OpenRouter with a free/paid filter. For `ollama`: queries the local `/api/tags` endpoint. For `gemini`: queries the Google model list. All others use the standard `/v1/models` endpoint.

**Chat (streaming)**
```
POST /api/assistant/chat   application/json
```

Request body:
```json
{
  "provider": "gemini",
  "model": "gemini-2.0-flash",
  "messages": [ { "role": "user", "content": "..." } ],
  "attachments": [],
  "claudeMode": "interactive"
}
```

Response: server-sent events (`text/event-stream`). Each event is a JSON object:
```json
{ "type": "delta", "content": "..." }
{ "type": "done" }
{ "type": "error", "message": "..." }
```

For the `claude` provider, `claudeMode` controls process lifecycle: `interactive` and `persistent` keep a warm Claude Code stream-json process across messages; `oneshot` and `resume` spawn per-message.

**Key pool management**
```
POST   /api/assistant/keys/{provider_id}/ingest      → add keys (body: newline-separated or JSON array)
DELETE /api/assistant/keys/{provider_id}/{key_hash}  → remove one key
DELETE /api/assistant/keys/{provider_id}             → clear all keys for provider
GET    /api/assistant/keys                            → status for all providers
GET    /api/assistant/keys/{provider_id}             → status for one provider
GET    /api/assistant/keys/{provider_id}/raw         → key hashes with full status
```

Keys are stored in memory (lost on restart). The pool round-robins across available keys per provider, tracking last-used timestamps and failure counts.

**RAG reindex**
```
GET /api/assistant/reindex
→ { "status": "ok", "chunks_indexed": N }
```

Forces a full re-parse and re-embedding of `USER_GUIDE.md` into the ChromaDB vector store. Called automatically at startup.

### 16.12 Module Loader

```
GET /api/modules
-> [ { "name", "label", "enabled", "api_prefix", ... }, ... ]
```

Returns the list of module manifests (`module.json` contents) for all modules that loaded successfully at startup. A module that failed to load does not appear in this list.

Settings and module management endpoints used by the Settings modal:
```http
GET   /api/settings
PATCH /api/settings
GET   /api/modules/all
PATCH /api/modules/{dirName}/enabled
POST  /api/admin/restart
POST  /api/admin/shutdown
```

`PATCH /api/settings` accepts a partial nested object and silently drops unknown keys, allowing newer/older frontends to remain compatible. Module enablement is persisted in module manifests/settings and takes effect according to each module's loader behavior; backend restart may be required for import-time changes.

![Settings modal toggles and admin actions](screenshots/07-settings-modal-with-shutdown__settings-toggles.png)

### 16.13 Disk-backed Library

The default local storage provider uses `/api/library` rather than IndexedDB-only persistence.

```http
GET    /api/library/entries
GET    /api/library/entries/{entry_id}
GET    /api/library/audio/{entry_id}
PATCH  /api/library/entries/{entry_id}
DELETE /api/library/entries/{entry_id}
POST   /api/library/import
GET    /api/library/{entry_id}/bundle
GET    /api/library/{entry_id}/lineage?depth=3
GET    /api/library/_graph/all
GET    /api/library/_all/stems
GET    /api/library/_all/midi
GET    /api/library/stems/{stem_id}/audio
```

Audio responses use `FileResponse` and support browser range requests. Imports accept multipart audio plus JSON metadata. Bundle responses are ZIP files containing audio, metadata, analysis, stems, MIDI, and lineage edges when available.

### 16.14 Chimera

```http
GET  /api/chimera/probe
POST /api/chimera/probe/refresh
POST /api/chimera/mashup
```

`POST /api/chimera/mashup` accepts multiple uploaded files plus `target_bpm`, optional `base_index`, JSON `weights`, `align_mode` (`start`, `downbeat`, `weave`), `out_sr`, and weave-specific bar/polyphony controls. The response contains base64 WAV audio plus `sample_rate`, `duration_sec`, `target_bpm_used`, `target_bpm_source`, `align_mode_used`, per-clip metadata, and warnings.

### 16.15 Stems

```http
GET  /api/stems/probe
GET  /api/stems/status
POST /api/stems/install
POST /api/stems/start
POST /api/stems/stop
POST /api/stems/{entry_id}/run?stems=4&device=cuda&quality=high
GET  /api/stems/{entry_id}/progress
POST /api/stems/{entry_id}/abort
GET  /api/stems/{entry_id}
```

Stem runs operate on disk-backed library entries, hold the backend idle gate while running, and persist rows in the library database so stems appear in details, bundles, lineage, and send-target workflows.

### 16.16 MIDI

```http
GET  /api/midi
POST /api/midi/install?engine=basic_pitch
POST /api/midi/{entry_id}/run?from_stems=true
GET  /api/midi/{entry_id}
GET  /api/midi/file/{midi_id}
```

MIDI conversion can run on full entries and, when available, separated stems. The streamed `.mid` files can be imported into the Piano Roll or used as downloadable artifacts in bundles.

### 16.17 VJ

The VJ module is experimental and powers the VJ center tab/iframe. Probe/status/start endpoints depend on the local sidecar configuration and are exposed under `/api/vj` when the module is enabled. Use the Settings modal module list and the VJ tab loading state to confirm availability.

![VJ tab panel loading state](screenshots/08-vj-tab-loading__vj-panel.png)

---

## 17. Python Pipeline Reference

### 17.1 Text-to-audio

```python
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")
audio = pipe.generate(
    prompt="Lo-fi boom bap meets orchestral strings, 84 BPM",
    duration=180,
)
```

### 17.2 Audio-to-audio

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

### 17.3 Inpainting

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

**Continuation:** set `inpaint_mask_start_seconds` equal to the source clip's total length and `duration` to the desired output length. The model fills the extension conditioned on the tail of the source.

### 17.4 Autoencoder

```python
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")
waveform, sr = torchaudio.load("audio.wav")
latents = ae.encode(waveform, sr)
audio_out = ae.decode(latents)
```

Batch encoding, chunked processing, and dataset pre-encoding for LoRA training: see [docs/workflows/autoencoder.md](autoencoder.md).

### 17.5 LoRA at Inference

```python
pipe = StableAudioModel.from_pretrained("medium")
pipe.load_lora("style.safetensors", weight=0.8)
audio = pipe.generate(prompt="...", duration=30)
```

Multiple LoRAs stack additively. Strength is adjustable at runtime:

```python
from stable_audio_3.models.lora import set_lora_strength

set_lora_strength(pipe.model, 0.5)                  # all LoRAs
set_lora_strength(pipe.model, 1.0, lora_index=0)    # first LoRA only
```

### 17.6 Advanced Generation Parameters

```python
audio = pipe.generate(
    prompt="...",
    duration=30,
    sampler_type="dpmpp_2m_sde",    # euler | rk4 | dpmpp_2m_sde | ping_pong
    sigma_max=1.0,                   # max noise level
    apg_scale=1.0,                   # Adaptive Projected Guidance scale
    cfg_interval=(0.0, 1.0),         # sigma range over which CFG is applied
)
```

Full parameter reference: `stable_audio_3/model.py:StableAudioModel.generate`.

---

## 18. Models

| Key | Flavor | Params | Autoencoder | Hardware requirement | Max duration |
|---|---|---|---|---|---|
| `small` | ARC | 433 M | SAME-S (266 M) | CPU | 120 s |
| `medium` | ARC | 1.4 B | SAME-L (1.7 B) | GPU — CUDA | 380 s |
| `small-rf` | RF | 433 M | SAME-S | CPU | 120 s |
| `medium-rf` | RF | 1.4 B | SAME-L | GPU — CUDA | 380 s |
| `same-s` | Autoencoder | 266 M | — | CPU | — |
| `same-l` | Autoencoder | 1.7 B | — | GPU | — |

ARC checkpoints bundle the autoencoder. Standalone SAME checkpoints share weights with the bundled version and reuse the cached full checkpoint when both are available. The RTX 3060 (6 GB VRAM) supports only the Small model; the Medium model requires approximately 8 GB.

---

## 19. LoRA Adapter Types

Eight adapter types are available, trading parameter count against expressiveness:

| Type | Trainable params per layer | Description |
|---|---|---|
| `lora` | `rank × (fan_in + fan_out)` | Standard LoRA. Two low-rank matrices A and B; update = `(alpha/rank) × B @ A`. |
| `dora-rows` | `rank × (fan_in + fan_out) + fan_out` | DoRA with per-row magnitude. Weight update is decomposed into direction and per-output-neuron magnitude. Default adapter type. |
| `dora-cols` | `rank × (fan_in + fan_out) + fan_in` | DoRA with per-column (per-input-feature) magnitude. |
| `bora` | `rank × (fan_in + fan_out) + fan_in + fan_out` | Bi-dimensional DoRA. Independent row and column magnitude scaling. |
| `lora-xs` | `rank²` | Maximum parameter efficiency. Only a `(rank, rank)` core matrix is trained; U and V bases are frozen SVD factors of the original weight. |
| `dora-rows-xs` | `rank² + fan_out` | DoRA-rows combined with the LoRA-XS frozen SVD bases. |
| `dora-cols-xs` | `rank² + fan_in` | DoRA-cols combined with LoRA-XS bases. |
| `bora-xs` | `rank² + fan_in + fan_out` | BoRA combined with LoRA-XS bases. |

### Training configuration

| Argument | Default | Description |
|---|---|---|
| `--rank` | 16 | LoRA rank. Lower = fewer parameters; higher = more capacity. |
| `--lora_alpha` | equal to `--rank` | Scaling factor. Effective scale = alpha / rank. |
| `--adapter_type` | `dora-rows` | Adapter type from the table above. |
| `--dropout` | 0.0 | Dropout on LoRA inputs during training. |
| `--include` | all layers | Restrict LoRA to layers whose name contains one of these substrings. Bracket ranges supported: `layers[0-11]`. |
| `--exclude` | none | Skip layers matching any of these substrings, even if they match `--include`. |
| `--svd_bases_path` | none | Pre-computed SVD bases `.pt` file. Eliminates per-layer SVD at startup for `-XS` adapters. |
| `--base_precision` | none | Cast frozen base weights to `bf16` after applying LoRA. Reduces VRAM usage; LoRA parameters remain in fp32. |
| `--lora_checkpoint` | none | Existing checkpoint to resume from. Loaded with `strict=False`. |

Full training walkthrough: [docs/workflows/lora.md](lora.md).

---

## 20. Troubleshooting

### Generation produces a static glitch (Medium model)

Flash Attention is not loaded correctly. Verify:
```bash
uv run python -c "import flash_attn; from flash_attn import flash_attn_func; print('Version:', flash_attn.__version__)"
```
Any import error indicates the wheel does not match the installed Python + PyTorch + CUDA combination. Reinstall from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

### "API UNREACHABLE" banner in the theDAW header

The backend is not responding on port 8600. Test directly:
```bash
curl http://localhost:8600/api/health
```
If the request fails, restart the backend. On Windows, `.\start-dev.bat` kills stale processes automatically. Manually: `taskkill /F /IM uvicorn.exe`.

### COMMIT EDIT hangs indefinitely

One or more clip source Blobs are failing to decode. The decode step has a 15-second timeout per Blob; if all clips time out, the render will not complete. Check the Processing Log for `decodeAudioData timeout` entries. Likely causes: a corrupted Blob in the library, or an unusually large audio file. Remove the suspect clip and retry.

### TRAIN tab displays "TRAINING METADATA FAILED"

`/api/autoencoder/info` returned a non-OK status. In this fork, the endpoint is a stub returning an empty list — this is expected behavior. The TRAIN tab degrades gracefully; LoRA training is available via the command line.

### Vite dev server cannot reach `/api`

The proxy block in `vite.config.ts` is missing or `localhost:8600` is not listening. Verify the backend is running (`curl http://localhost:8600/api/health`) and that `vite.config.ts` contains:
```typescript
server: { proxy: { '/api': 'http://localhost:8600' } }
```

### Audio plays at the wrong speed or pitch

A sample-rate mismatch exists somewhere in the chain. The full pipeline is 44.1 kHz stereo end-to-end. Verify `pipeline.sample_rate` and that the audio file being uploaded matches.

### Out-of-memory on Medium model

Approximately 8 GB VRAM is required. Workarounds:
- Use the `small` model.
- Reduce `duration` (shorter sequences consume less peak memory).
- Confirm no other CUDA processes are active on the same device.
- The RTX 3060 Laptop (6 GB) is constrained to the Small model.

### IndexedDB storage quota exceeded

The browser has reached its per-origin storage cap. Delete old library entries using the trash icon per row, or clear the entire store via the browser's developer tools (Application → Storage → IndexedDB → `sa3-library`).

---

## 21. Development Workflows

### Lint

```bash
uv run ruff check
uv run ruff format --check
```

Ruff excludes `stable_audio_3/models`, `inference`, `interface`, and `data`. Only top-level files (`pipeline.py`, `model.py`, `model_configs.py`, `loading_utils.py`, `verbose.py`) are checked.

### Tests

```bash
uv run pytest                        # Full suite (Medium tests skip on non-CUDA hosts)
uv run pytest tests/test_inference.py
uv run pytest --save-audio           # Write outputs to test_audio_outputs/ for inspection
```

Session-scoped fixtures avoid reloading models between tests. Medium tests are skipped automatically on hosts without a CUDA GPU.

### Frontend build

```bash
cd frontend
npm run build      # Outputs to frontend/dist/
npm run preview    # Serves the built bundle locally
```

### Adding a new FFmpeg effect

1. Add an entry to `EFFECT_PARAM_BOUNDS` in `backend/server.py` with the allowed parameter ranges.
2. Extend `_build_filter()` (or equivalent) with the FFmpeg filter graph command for the new effect.
3. Add the effect to the hardcoded FX chain list in `frontend/src/views/StudioView.tsx` with a display label and color class.

### Adding a backend module

Create a new directory under `backend/modules/` with two required files:

`module.json`:
```json
{
  "name": "my-module",
  "label": "My Module",
  "enabled": true,
  "api_prefix": "/api/my-module",
  "description": "What this module does"
}
```

`router.py`:
```python
from fastapi import APIRouter

router = APIRouter()

@router.get("/status")
async def status():
    return {"ok": True}
```

The loader (`backend/modules/loader.py`) discovers the directory automatically on next server start and mounts the router at `api_prefix`. Set `"enabled": false` in `module.json` to disable without deleting. Any import error is logged and the module is skipped; other modules and the main app continue loading normally.

### Backend job persistence

The current async job store (`JOBS` dict in `backend/server.py`) is in-memory. All jobs are lost on backend restart. For production deployment, swap this for SQLite or Redis — the job object shape is well-defined and the swap is a single-layer change.

### Zustand store architecture

| Store | State owned |
|---|---|
| `useEditorStore` | Waveform editor tracks, clips, playhead, tool mode, snap, zoom, inpaint selection. |
| `usePlayerStore` | HTMLAudioElement-based playback engine (load, play, pause, seek, loop). Shared by all playback sources. |
| `usePlaybackStore` | Master volume and mute. Read by `playerStore`, the library player, and the sequencer master gain. |
| `useLibraryStore` | Disk-backed provider facade plus session Blob cache, search/filter/sort state, selected entry. |
| `useGenerateStore` | Last generation metadata (filename, model, duration) for footer display. |
| `useGenerateParamsStore` | All CREATE tab form field values. |
| `useStudioStore` | EDIT tab source, output, process history. |
| `useEditorPlaybackBridge` | Module-level callback registration (not a Zustand store) decoupling the footer from the editor to avoid circular dependencies. |
| `usePianoRollStore` | Piano roll note list, BPM, grid length, playback state. |
| `useMediaBucketStore` | Session-scoped file bucket items. |
| `useBottomPanelStore` | Bottom panel open state, height, active tab. |
| `useLogStore` | Processing log ring buffer. |
| `useActiveViewStore` / `useAppUiStore` | Legacy active view plus center-tab shell state (`make`, `edit`, `mix`, `train`, `learn`, `dj`, `vj`) and right library rail state. |

---

## 22. Feature Coverage and Screenshot Evidence

theDAW documentation now has a repeatable audit loop that connects implemented features to guide coverage and visual proof.

> [!TIP]
> Treat this section as the docs control room: feature descriptors define what exists, screenshot specs prove it visually, and the coverage report confirms the guide explains it.

### 22.1 Coverage artifacts

| Artifact | Purpose |
|---|---|
| `scripts/screenshots/specs.ts` | Canonical feature descriptors plus screenshot/crop mapping. |
| `scripts/screenshots/featureCoverage.ts` | Generates the feature-vs-doc coverage report from `docs/USER_GUIDE.md`. |
| `docs/reports/feature-doc-coverage-report.md` | Human-readable coverage matrix and screenshot map. |
| `docs/reports/feature-doc-coverage.json` | Machine-readable report for future automation. |

The coverage pass records whether `repomix-output.md` was present and confirms it is not tracked. Repomix is local analysis context only.

### 22.2 Screenshot generation

The primary screenshot runner is `scripts/screenshots/capture.ts`:

```powershell
npm --prefix frontend run screenshots
```

The runner drives the live app through real DAW interactions, writes full-scene images to `docs/screenshots/`, and emits crop assets using this naming convention:

```text
<scene-id>.png
<scene-id>__<crop-id>.png
```

For example, `03-library-actions-toolbar.png` can document the Library toolbar as a whole, while `03-library-actions-toolbar__library-toolbar.png` focuses tightly on the action cluster. One full screenshot or crop may intentionally support multiple feature IDs.

### 22.3 Current feature-to-screenshot map

| Feature ID | Recommended evidence |
|---|---|
| `shell-center-tabs-right-library` | `01-shell-make.png`, `02-library-with-showcase-selected__library-details.png` |
| `docs-modal-download-print-rag` | `01-shell-make__header-actions.png`, `docs/UI/screenshots/05-docs-modal.png` |
| `assistant-orb-providers-keys-attachments` | `01-shell-make__header-actions.png` |
| `create-advanced-generation-templates-prompts-spectrograms` | `01-shell-make__make-controls.png` |
| `create-chimera-fusion-stack` | `09-chimera-cohort-multi-select.png`, `01-shell-make__make-controls.png` |
| `create-mic-recorder-send-targets` | `01-shell-make__make-controls.png` |
| `edit-advanced-effects-chain-analyzer` | `docs/UI/screenshots/02-edit-tab-overview.png` plus future advanced-editor crop |
| `library-backend-local-storage` | `02-library-with-showcase-selected.png`, `02-library-with-showcase-selected__library-details.png` |
| `library-bundle-download-lineage-export` | `04-library-download-submenu__download-submenu.png`, `06-learn-tab-3d-graph__lineage-graph.png` |
| `library-stems-sidecar` | `05-library-entry-right-click__entry-context-menu.png` |
| `library-midi-conversion` | `04-library-download-submenu__download-submenu.png`, `05-library-entry-right-click__entry-context-menu.png` |
| `settings-feature-toggles-modules-admin` | `07-settings-modal-with-shutdown__settings-toggles.png` |
| `sequencer-midi-export-render` | `docs/UI/screenshots/06-step-sequencer.png` plus future sequencer-toolbar crop |
| `vj-sidecar-tab-mobile-share` | `08-vj-tab-loading__vj-panel.png`, `01-shell-make__header-actions.png` |

### 22.4 Documentation maintenance rule

When adding or changing a feature:

1. Add/update its `FeatureDescriptor` in `scripts/screenshots/specs.ts`.
2. Map the feature to a full screenshot and, if needed, a crop region.
3. Update `docs/USER_GUIDE.md` first.
4. Run the coverage script and screenshot runner.
5. Sync `docs/USER_GUIDE.md` to `frontend/public/USER_GUIDE.md` before validating the Docs modal.

---

*Last updated: 2026-05-29. Maintained by the theDAW development team.*


