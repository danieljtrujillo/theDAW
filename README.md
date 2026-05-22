# Stable Audio 3 — StableDAW

A research and production platform for high-quality, text-conditioned audio generation, built on the Stability AI Stable Audio 3 diffusion pipeline. This fork layers a FastAPI backend and a bespoke React DAW interface (StableDAW) on top of the upstream Python pipeline, providing a complete browser-based studio for generation, editing, and composition.

> **Complete documentation:** [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — the source of truth for every feature, endpoint, and control. The in-app **Docs** button renders it as an interactive modal with PDF export.

[Discord](https://discord.gg/cKpvjey8b) · [User Guide](docs/USER_GUIDE.md) · [Windows Setup](docs/windows/setup-guide.md)

---

## Repository Structure

| Component | Location | Description |
|---|---|---|
| **Upstream ML pipeline** | `stable_audio_3/` | DiT diffusion transformer, SAME autoencoder, all samplers, LoRA training and inference, distribution-shift schedules. |
| **FastAPI backend** | `backend/server.py` | Async HTTP wrapper. Manages a job queue for generation, synchronous FFmpeg-based audio processing, model introspection endpoints. Binds to port 8600. |
| **StableDAW React UI** | `frontend/` | React 19 + Vite 6 + Tailwind 4 + Zustand 5. Browser-based DAW with multi-track editor, step sequencer, piano roll, persistent library, and real-time spectral analyzer. Proxies `/api/*` to the backend. Runs on port 5173 in development. |
| **Gradio UI (legacy)** | `run_gradio.py`, `stable_audio_3/interface/` | Upstream Gradio interface. Functional for direct pipeline access; StableDAW supersedes it for daily use. |

---

## Quick Start

### Launch (Windows one-shot)

```powershell
.\start-dev.bat
```

The launcher kills stale processes on ports 5173 and 8600, starts the backend, waits for it to bind, then starts the Vite dev server and opens `http://localhost:5173`.

### Manual launch

```bash
# Terminal 1 — backend
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload

# Terminal 2 — frontend
cd frontend && npm run dev
```

### Dependencies

```bash
# Python
uv sync

# Optional Linux CUDA wheels for Medium model, if you need a specific CUDA build
uv pip install torch==2.7.1 torchaudio==2.7.1 --index-url https://download.pytorch.org/whl/cu126

# Frontend
cd frontend && npm install
```

See [§3 of the User Guide](docs/USER_GUIDE.md#3-installation) for Windows CUDA, Flash Attention, and soundfile specifics.

---

## Inference Modes

### Text-to-audio

```python
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")
audio = pipe.generate(
    prompt="Lo-fi boom bap meets orchestral strings, 84 BPM",
    duration=180,
)
```

### Audio-to-audio

```python
# Audio-to-audio
import torchaudio

init_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    init_audio=init_audio,
    init_noise_level=0.9,
    prompt="bossa nova bassline",
    duration=30,
)
```

### Inpainting / continuation

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

Continuation: set `inpaint_mask_start_seconds` to the source length and `duration` to the desired total output length.

### Autoencoder (standalone)

```python
from stable_audio_3 import AutoencoderModel
import torchaudio

ae = AutoencoderModel.from_pretrained("same-l")
waveform, sr = torchaudio.load("audio.wav")
latents = ae.encode(waveform, sr)
audio_out = ae.decode(latents)
```

See [docs/workflows/autoencoder.md](docs/workflows/autoencoder.md) for batch encoding and dataset pre-encoding.

---

## Models

| Key | Flavor | Params | Autoencoder | Hardware | Max Duration |
|---|---|---|---|---|---|
| `small` | ARC | 433 M | SAME-S | CPU | 120 s |
| `medium` | ARC | 1.4 B | SAME-L | GPU (CUDA) | 380 s |
| `small-rf` | RF | 433 M | SAME-S | CPU | 120 s |
| `medium-rf` | RF | 1.4 B | SAME-L | GPU (CUDA) | 380 s |
| `same-s` | Autoencoder | 266 M | — | CPU | — |
| `same-l` | Autoencoder | 1.7 B | — | GPU | — |

**ARC** checkpoints are post-trained for 8-step inference (`cfg_scale=1`). **RF** checkpoints are rectified-flow bases used as LoRA training starting points (`cfg_scale=7`, ~50 steps at inference). ARC and RF checkpoints each bundle the autoencoder. Standalone SAME checkpoints share weights with the bundled versions and reuse the cached full checkpoint when available.

---

## StableDAW Feature Summary

### Generation (CREATE tab)
- Text-to-audio, audio-to-audio, and inpainting/continuation from a single form.
- Per-field controls: model selector (auto-adjusts steps/CFG for RF variants), duration, batch size, sampler steps, CFG scale, and seed with one-click reroll.
- Magic prompt button populates a sample prompt when the field is empty.
- Inpainting: WaveSurfer waveform preview with draggable purple region defining the regeneration window; mask coordinates are computed relative to the visible clip region to handle trimmed and split clips correctly.
- Async job queue: submit, then poll `/api/jobs/{id}` at 1-second intervals until completion; binary abort available mid-flight.
- All completed generations auto-save to the persistent IndexedDB library.

### Studio Effects (EDIT tab)
- 24 FFmpeg-backed effects: mastering chain, compression, highpass/lowpass filters, volume, tempo, vocal processing, lo-fi vinyl, stereo widening, reverb/delay, sub exciter, phase isolation, parametric mid EQ, loudness normalization (LUFS), pitch shift, echo, fade, declick, silence removal, denoise, and format export (FLAC, MP3, AAC, Opus).
- Four macro sliders (Drive, Width, Air, Punch) map to effect-specific parameters.
- Process history: the last 8 invocations are retained; any prior output can be promoted to the current source.

### LoRA (TRAIN tab + Python API)
- Eight adapter types: `lora`, `dora-rows`, `dora-cols`, `bora`, `lora-xs`, `dora-rows-xs`, `dora-cols-xs`, `bora-xs`.
- Layer filtering via `--include` / `--exclude` with bracket-range expansion (`layers[0-11]`).
- Runtime strength control, per-LoRA interval gating (active only within a sigma range), and per-LoRA layer filter at inference.
- Multiple LoRAs stack additively; each is independently configurable.
- Pre-computed SVD bases (`--svd_bases_path`) accelerate startup for `-XS` adapter variants.
- VRAM reduction via `--base_precision bf16`.

### Library (LIBRARY tab)
- Persistent IndexedDB storage (`sa3-library` / `generations` object store). Every generation auto-saves with full metadata (prompt, model, duration, steps, CFG, seed, MIME type, timestamp).
- List and grid view modes; full-text search across title, prompt, model, tags, and notes.
- Filters: favorites only; sort by newest, duration, or title.
- Per-entry: inline play/pause routed through the shared Web Audio engine, download, delete, favorite star, and scissors icon (sends the entry to the waveform editor as a new clip).
- Details panel (bottom panel): full metadata table with audition, send-to-editor, and download actions.

### Waveform Editor (DAW — EDIT workspace)
- Multi-track timeline. Each clip references a source audio Blob; waveform peaks are computed via `AudioContext.decodeAudioData` (240 bins, normalized) and cached per clip.
- Tool modes: **Move** (drag clips horizontally and between tracks), **Cut** (click-to-split at arbitrary positions, preserving source alignment via `offsetIntoSource`).
- Snap grid: Off, 1/4, 1/8, 1/16 note divisions relative to editor BPM.
- Zoom: 5–400 px/s; horizontal scroll follows the zoom level.
- Per-track controls: editable name, mute, solo (exclusive across all tracks), volume (0–1), pan (−1 to +1), remove.
- Per-clip: left/right resize handles trim in/out points (left handle adjusts both `startSec` and `offsetIntoSource` to keep source content aligned); fade-in and fade-out handles drag to set linear envelope durations.
- **Inpaint from editor**: draw a selection region on any clip (Paintbrush tool or right-drag), then open the inpaint panel to set prompt, steps, and seed. The visible clip region is cropped and sent to the backend; mask coordinates are relative to the cropped audio's start. Completed audio can be accepted (replaces the source Blob on the clip) or discarded.
- **COMMIT EDIT**: renders all non-muted (or exclusively soloed) tracks into a single 44.1 kHz stereo WAV via `OfflineAudioContext`. Fade envelopes, per-track volume, and stereo pan are applied in the offline render. Output is saved to the library and downloaded automatically.
- Mixdown name field: set the output filename before committing. If left empty, defaults to `mixdown_<id>.wav`.
- Status bar: live timecode (playhead / total duration), clip and track counts, selected clip's start/end.
- Transport: **Preview** plays the selected clip through the shared Web Audio engine (visible in the spectral analyzer); playback is controllable from the Player Footer after the first render.

### Step Sequencer (DAW — SEQUENCER workspace)
- 16-step drum machine with a BPM-driven clock (40–240 BPM, 16th-note resolution).
- Five synthesized voices: **kick** (pitched sine + exponential decay), **snare** (noise burst + tonal body), **hat** (bandpass-filtered noise), **tone** (sawtooth + LP filter + ADSR), **noise** (white noise + LP filter).
- Per-track: editable name, voice selection (cycles through all five), volume, and a 16-button step grid (beats 1/5/9/13 visually emphasized). Voice preview and track removal are hover-revealed.
- Utility controls: Random Fill (randomizes all patterns), Clear (empties all patterns), Add Track.
- All voices route through the shared engine master gain and analyser node, so the spectral analyzer reflects live sequencer output.
- **Send to editor**: renders the current pattern offline to a WAV Blob and appends it to the waveform editor as a new clip.

### Piano Roll (bottom panel)
- MIDI-style note editor with a chromatic keyboard on the left axis and a step-quantized grid.
- Click to add notes, drag to reposition, drag the right edge to resize duration. Delete key removes the selected note.
- Configurable BPM (40–240) and total grid length (steps).
- Live playback routes through the shared engine context (audible through the spectral analyzer).
- MIDI import (`parseMidi`) and MIDI export (`downloadMidi`).
- **Send to editor**: renders the current note pattern offline via `OfflineAudioContext` to a WAV Blob, appends it to the waveform editor, and links the clip back to the piano roll state (`sourceKind: 'piano-roll'`).
- **Edit in Piano Roll**: clips derived from the piano roll can be re-opened for editing; the original note list and BPM are recovered from the clip's metadata.

### Media Bucket (bottom panel)
- Session-scoped drag-and-drop holding area for arbitrary audio files.
- Drop or click-to-upload multiple files; supported formats: WAV, MP3, FLAC, OGG, AAC, M4A, Opus.
- Per-item actions: **Send to Editor** (decodes peaks and appends to the waveform editor as a new track), **Send to Library** (decodes audio, measures duration, and persists the entry to IndexedDB), **Remove**.
- Clear all button.

### Real-time Spectral Analyzer (bottom panel)
- Three display modes: **Oscilloscope** (time-domain waveform, purple glow), **Spectrum** (log-scaled frequency bars, purple-to-lavender gradient), **Radial** (frequency data mapped to a polar shape).
- Mode selector buttons (O / S / R) positioned vertically in the top-left of the canvas.
- Live RMS and peak dB meters sampled every 5 frames, displayed in a bottom canvas overlay with a gradient backdrop and text shadow for legibility.
- LIVE / SILENT indicator (pulse animation when signal exceeds −60 dBFS).
- Fullscreen toggle expands the canvas to the full browser viewport.
- Audio context sample rate and FFT size displayed in the status overlay.
- All modes read from the shared engine analyser node, so every audio source (playback, sequencer, piano roll, preview) is reflected.

### Player Footer
- Fixed to the viewport bottom across all views and tabs.
- Track info: current title, model chip (or LIBRARY / IDLE), and total duration at 48 kHz.
- Transport: play/pause (dispatches to `playerStore` or triggers the first editor timeline render via `editorPlaybackBridge`), skip to start, skip to end, loop toggle.
- Seekable progress bar (click-to-seek, hover reveals a scrubber handle).
- Volume slider and mute toggle; drives the `playbackStore` master gain shared by all audio sources.
- Download button retrieves the currently loaded library entry.
- Like / share decorative actions (heartbeat state persisted per session).

### Processing Log
- Ring buffer of up to 500 entries, auto-scrolling to the latest.
- Sources: `system`, `health`, `generate`, `training`, `studio`, `sequencer`, `library`.
- Severity levels: info, warn, error, debug — each with a distinct color indicator.
- Download exports the full buffer as a timestamped `.txt` file. Clear wipes the buffer.
- Collapse/expand by clicking the header bar.

---

## Python API

### LoRA at inference

```python
pipe = StableAudioModel.from_pretrained("medium")
pipe.load_lora("style.safetensors", weight=0.8)
audio = pipe.generate(prompt="...", duration=30)
```

Multiple LoRAs stack additively; weights are adjustable at runtime via `set_lora_strength(model, 0.5, lora_index=0)`. See [docs/workflows/lora.md](docs/workflows/lora.md) for the full adapter-type and layer-filter reference.

### Advanced generation parameters

```python
audio = pipe.generate(
    prompt="...",
    duration=30,
    sampler_type="dpmpp_2m_sde",  # euler | rk4 | dpmpp_2m_sde | ping_pong
    apg_scale=1.0,                # Adaptive Projected Guidance
    cfg_interval=(0.0, 1.0),      # apply CFG only within this sigma range
    sigma_max=1.0,                # max noise level (partial trajectories)
)
```

---

## Documentation Index

| Document | Contents |
|---|---|
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | Complete manual — every feature, every control, every endpoint. Rendered in-app by the Docs button. |
| [docs/workflows/inference.md](docs/workflows/inference.md) | Inference-mode reference (upstream). |
| [docs/workflows/lora.md](docs/workflows/lora.md) | LoRA adapter types, training configuration, layer filtering, multi-LoRA inference. |
| [docs/workflows/autoencoder.md](docs/workflows/autoencoder.md) | Standalone SAME autoencoder usage, batch encoding, dataset pre-encoding. |
| [docs/guides/prompting.md](docs/guides/prompting.md) | Prompt structure, conditioning signals, style reference. |
| [docs/guides/model-overview.md](docs/guides/model-overview.md) | Architecture design and model comparison. |
| [docs/windows/setup-guide.md](docs/windows/setup-guide.md) | Full Windows installation walkthrough (CUDA, Flash Attention, soundfile). |
| [docs/windows/troubleshooting.md](docs/windows/troubleshooting.md) | Windows-specific issue resolution. |

---

## Troubleshooting

**Static glitch output (Medium model)**
Flash Attention is not correctly installed. Verify:
```bash
uv run python -c "import flash_attn; from flash_attn import flash_attn_func; print(flash_attn.__version__)"
```
Reinstall with a wheel matching your Python + torch + CUDA version combination from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

**"API UNREACHABLE" banner in the UI**
The backend is not listening on port 8600. Test directly:
```bash
curl http://localhost:8600/api/health
```
On Windows, `.\start-dev.bat` kills stale processes automatically. Manually: `taskkill /F /IM uvicorn.exe`.

**Out-of-memory on Medium model**
The Medium pipeline requires approximately 8 GB VRAM. Workarounds: use `small`, reduce `duration`, or ensure no competing CUDA processes are active. The RTX 3060 (6 GB) is limited to the Small model.

**IndexedDB quota exhausted**
The browser storage cap has been reached. Remove old library entries using the trash icon per row.

---

## License

Commercial use of these models is governed by the [Stability AI Community License](https://stability.ai/license).
