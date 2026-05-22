# Stable Audio 3 — StableDAW User Guide

Complete reference for the StableDAW platform: the upstream Stable Audio 3 ML pipeline, the FastAPI backend that wraps it, and the StableDAW React interface built on top. The in-app **Docs** button renders this document as an interactive modal with PDF export.

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

---

## 1. Repository Anatomy

| Layer | Path | Description |
|---|---|---|
| **ML pipeline** | `stable_audio_3/` | Upstream Stability AI code. DiT, SAME autoencoder, all samplers, LoRA parametrization, distribution-shift schedules, T5Gemma conditioner. |
| **FastAPI backend** | `backend/server.py` | HTTP wrapper around the pipeline. Async job queue for generation; synchronous endpoints for studio effects and model introspection. Port 8600. |
| **React UI** | `frontend/` | Tailwind 4 + React 19 + Zustand 5 + Vite 6. Multi-tab DAW interface. Proxies `/api/*` to the backend. Port 5173 in development. |
| **Gradio UI** | `run_gradio.py`, `stable_audio_3/interface/` | Upstream Gradio interface. Retains full pipeline access; the React UI supersedes it for daily use. Both share the same Python pipeline. |

---

## 2. Architecture

```
Browser (:5173 dev / static serve in prod)
  ↓ fetch('/api/...')
FastAPI backend (:8600)
  ↓ pipeline.generate(...)  /  subprocess.run(ffmpeg ...)
StableAudioModel
  ├── T5Gemma text encoder       models/conditioners.py
  ├── DiT diffusion transformer  models/dit.py → models/transformer.py
  └── SAME autoencoder           models/autoencoders.py
```

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

`pyproject.toml`'s CUDA index mapping covers Linux only. On Windows:

1. Install PyTorch with the correct CUDA wheel index:
   ```powershell
   uv pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu128
   ```

2. Install `soundfile` (torchaudio has no default audio backend on Windows):
   ```powershell
   uv pip install soundfile
   ```

3. Flash Attention requires a pre-built wheel matching your Python + PyTorch + CUDA version. Download from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

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

```
┌──────────────────────┬───────────────────────────────────────┐
│  LEFT PANEL          │  DAW WORKSPACE (center)               │
│  (resizable)         │                                       │
│                      │  ┌─────────────────────────────────┐  │
│  STABLEDAW logo      │  │ Mode toolbar (Editor/Sequencer) │  │
│  Tab strip:          │  ├─────────────────────────────────┤  │
│    CREATE            │  │ Timeline or Step grid           │  │
│    EDIT              │  │                                 │  │
│    TRAIN             │  ├─────────────────────────────────┤  │
│    LIBRARY           │  │ Bottom panel (collapsible)      │  │
│                      │  │ Spectral/Details/Piano/Bucket   │  │
│  View content        │  └─────────────────────────────────┘  │
│  (per-tab accordion) │                                       │
│                      │                                       │
│  RUN CTA (sticky)    │                                       │
│  Processing Log      │                                       │
└──────────────────────┴───────────────────────────────────────┘
│  PLAYER FOOTER (fixed, z-50)                                  │
└───────────────────────────────────────────────────────────────┘
```

**Left panel resize:** drag the vertical handle on the panel's right edge. Range: 300 px – 500 px.

**Left panel collapse:** click the chevron adjacent to the STABLEDAW logo. The DAW workspace expands to full width. Click again to restore.

**Tab switching:** tabs (CREATE / EDIT / TRAIN / LIBRARY) swap the accordion content in the left panel. The DAW workspace remains in place across all tab selections.

**Viewport scaling:** the UI applies a CSS `zoom` factor based on viewport width (0.85 at < 1440 px; 0.95 at 1440–1919 px; 1.1 at ≥ 1920 px). Shell height calculations compensate so the layout tiles cleanly to the footer.

---

## 6. CREATE Tab

### Purpose

Submits audio generation jobs to the backend and displays their output. Supports all three inference modes: text-to-audio, audio-to-audio, and inpainting/continuation.

### 6.1 PRIMARY SYNTHESIS / PROMPT

- **Prompt** — required. Plain-text description of the desired audio content, instrumentation, or sonic texture.
- **Negative prompt** — optional. Aspects or characteristics to suppress.
- **Magic prompt button** (sparkle icon, bottom-right of the prompt box) — inserts a sample prompt when the prompt field is empty. Has no effect if the field already contains text.

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

### 6.3 INIT SIGNAL / CONDITIONING

Audio-to-audio mode. Upload a source file via the dropzone to condition the model on existing audio.

- **Init Noise (0–1)** — controls the ratio of source signal to random noise injected at the start of the denoising trajectory. Lower values preserve more of the source character; higher values grant the model more generative freedom.
- **Type** — `Audio` (standard) or `RF-Inv` (RF-Inversion, only meaningful with `-rf` model variants).

Removing the source file returns the form to text-to-audio mode.

### 6.4 INPAINTING / REGEN REGION

Replaces a defined time window within a source audio clip while preserving everything outside that window.

- **Enable toggle** (section header) — must be active for the inpainting payload to be submitted. Activates automatically when a source file is loaded.
- **Source dropzone** — accepts drag-and-drop or click-to-upload.
- **Waveform preview** — rendered by WaveSurfer once a file is loaded.
- **Region selection** — drag horizontally across the waveform to define the regeneration window. The Start, End, and Region Duration readouts update in real time.
- **Continuation** — to extend audio beyond its current end, drag the region to the end of the waveform and set Duration to a value larger than the source length. The model fills the extension conditioned on the existing audio tail.

The form field `mask_start` and `mask_end` are submitted in seconds relative to the start of the inpaint audio file.

### 6.5 LORA / ADAPTIVE LAYERS

Stack one or more LoRA adapters for the next generation. Each adapter row displays its name, a weight slider (0–1), and a remove button.

> **Current status:** UI scaffolding. The `/api/generate-jobs` endpoint does not yet forward LoRA references to the pipeline. LoRA at inference is supported directly via the Python API (see [§17.5](#175-lora-at-inference)) and the Gradio UI.

### 6.6 Output Status Monitor

Appears below the accordion after a job is submitted or completed.

- Binary progress bar (`queued → running → completed`).
- Engine information chip (model, steps).
- Inline audio player for the completed result.
- Download and clear buttons.
- All completed results are concurrently auto-saved to the Library.

### 6.7 RUN GENERATION

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

> **Backend status:** `/api/autoencoder/info` returns an empty list, so the TRAIN tab displays "no autoencoders available." Encode and decode endpoints return HTTP 501.

### 8.4 Job Polling

Long-running training jobs are tracked via `GET /api/jobs/{id}` polled at 1-second intervals. The `logs` field of the response is rendered as a streaming console output.

---

## 9. LIBRARY Tab

### Purpose

Persistent storage for all generated audio, backed by IndexedDB (`sa3-library` database, `generations` object store). Entries survive page reloads and browser restarts within the same origin.

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

Waveform editor mixdowns are also auto-saved here on commit, with `source: 'editor-mixdown'` and all generation fields set to their neutral defaults.

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

### 9.5 Library Analysis

A stats footer displays: total entry count, favorites count, cumulative storage size (sum of all Blob sizes), and cumulative playback duration.

### 9.6 Empty State

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

- **Dropzone** — accepts drag-and-drop or click-to-upload. Supported formats: WAV, MP3, FLAC, OGG, AAC, M4A, Opus.
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

**Progress bar:** a horizontal track showing playback position. Click anywhere to seek (`playerStore.seekByFraction`). On hover, a circular scrubber handle appears at the current position. Time labels at left and right show current time and total duration.

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

### 16.2 Model Info

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

### 16.3 Generation — Async (StableDAW UI)

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

### 16.4 Generation — Sync (Legacy / Gradio)

```
POST /api/generate   multipart/form-data
```

Identical surface to `/api/generate-jobs` with additional advanced parameters: `sampler_type`, `apg_scale`, `sigma_max`, `cfg_rescale`, `cfg_norm_threshold`, `cfg_interval_min`, `cfg_interval_max`, all distribution-shift parameters (`dist_shift_type`, `logsnr_*`, `flux_*`, `full_*`), and RF-Inversion parameters (`inversion_steps`, `inversion_gamma`, `inversion_unconditional`).

Response: raw binary audio body (`audio/wav` by default). Retained for backwards compatibility and the Gradio UI.

### 16.5 Studio Processing

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

### 16.6 Jobs List

```
GET /api/jobs
→ Array of all job objects currently in the in-memory store.
```

The job store is in-memory only; all jobs are lost on backend restart.

### 16.7 Training and Autoencoder (Stub Endpoints)

| Endpoint | Status |
|---|---|
| `GET /api/autoencoder/info` | Returns empty arrays. |
| `POST /api/jobs/train-lora` | HTTP 501. |
| `POST /api/jobs/pre-encode` | HTTP 501. |
| `POST /api/autoencoder/encode` | HTTP 501. |
| `POST /api/autoencoder/decode` | HTTP 501. |

### 16.8 Presets

```
GET /api/presets   → []
POST /api/presets  → { "id": "<uuid>", "saved": true }
```

Not consumed by the UI. Reserved for future use.

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

### "API UNREACHABLE" banner in the StableDAW header

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

### Backend job persistence

The current async job store (`JOBS` dict in `backend/server.py`) is in-memory. All jobs are lost on backend restart. For production deployment, swap this for SQLite or Redis — the job object shape is well-defined and the swap is a single-layer change.

### Zustand store architecture

| Store | State owned |
|---|---|
| `useEditorStore` | Waveform editor tracks, clips, playhead, tool mode, snap, zoom, inpaint selection. |
| `usePlayerStore` | HTMLAudioElement-based playback engine (load, play, pause, seek, loop). Shared by all playback sources. |
| `usePlaybackStore` | Master volume and mute. Read by `playerStore`, the library player, and the sequencer master gain. |
| `useLibraryStore` | IndexedDB-backed generation entries, search/filter/sort state, selected entry. |
| `useGenerateStore` | Last generation metadata (filename, model, duration) for footer display. |
| `useGenerateParamsStore` | All CREATE tab form field values. |
| `useStudioStore` | EDIT tab source, output, process history. |
| `useEditorPlaybackBridge` | Module-level callback registration (not a Zustand store) decoupling the footer from the editor to avoid circular dependencies. |
| `usePianoRollStore` | Piano roll note list, BPM, grid length, playback state. |
| `useMediaBucketStore` | Session-scoped file bucket items. |
| `useBottomPanelStore` | Bottom panel open state, height, active tab. |
| `useLogStore` | Processing log ring buffer. |
| `useActiveViewStore` | Active left-panel tab (`create`, `edit`, `train`, `library`). |

---

*Last updated: 2026-05-21. Maintained by the StableDAW development team.*
