# Stable Audio 3 — StableDAW fork

A state-of-the-art open platform for fast, high-quality generated audio and music — with a custom FastAPI backend and React UI layered on top of the upstream Stable Audio 3 Python pipeline.

> **This fork's deliverables (in addition to upstream):**
> - `backend/server.py` — a FastAPI wrapper exposing async generation jobs, studio effects, and library/training stubs.
> - `frontend/` — the StableDAW React 19 + Vite 6 + Tailwind 4 UI with CREATE / EDIT / TRAIN / LIBRARY tabs, persistent IndexedDB library, real Web Audio step sequencer, and a live processing log.
> - The complete in-app **[User Guide](docs/USER_GUIDE.md)** — the source of truth for every feature.

[Discord](https://discord.gg/cKpvjey8b) · [User Guide](docs/USER_GUIDE.md) · [Polish Plan](docs/plans/2026-05-18-stabledaw-ui-polish-and-functionality.md)

---

## Quick links

| If you want to… | Go to |
|---|---|
| **See every feature in detail** | [docs/USER_GUIDE.md](docs/USER_GUIDE.md) |
| Install and run | [§3–§4 of the User Guide](docs/USER_GUIDE.md#3-installation) |
| Read the backend API reference | [§13 of the User Guide](docs/USER_GUIDE.md#13-backend-api-reference) |
| Read the Python pipeline reference | [§14 of the User Guide](docs/USER_GUIDE.md#14-python-pipeline-reference) |
| Troubleshoot | [§16 of the User Guide](docs/USER_GUIDE.md#16-troubleshooting) |

The in-app **Docs** button (gear-adjacent in the top-right of the DAW header) opens the User Guide as an interactive modal with PDF export.

---

## What it does

Stable Audio 3 generates 44.1 kHz stereo audio from text prompts. Three modes:

- **Text-to-audio** — prompt in, audio out.
- **Audio-to-audio** — restyle a source clip with a prompt + `init_noise_level`.
- **Inpainting / continuation** — regenerate a time window inside a clip, or extend the tail past the source's end.

Plus:

- **LoRA fine-tuning** — adapt any model to a target style; stackable, adjustable at runtime.
- **Standalone SAME autoencoder** — encode audio to 256-dim latents at 1/4096 the original rate; decode them back.
- **Variable-length generation** — duration determines the latent sequence length directly, no wasted compute on padding.
- **FFmpeg-based studio chain** — 24 effects covering mastering, dynamics, EQ, pitch, fade, denoise, format conversion.
- **Persistent IndexedDB library** — every generation auto-saves with full metadata; survives reloads.
- **Multi-track waveform editor** — drag/cut/resize/delete clips, snap to BPM grid, preview-play selected clip, render full composition to a WAV via `OfflineAudioContext` and auto-save to the library.
- **Web Audio step sequencer** — 16-step drum machine with hand-rolled kick/snare/hat/tone/noise voices.
- **Live processing log** — per-source, per-level, downloadable as text.

---

## Models

| RF Model | Autoencoder | Hardware | Params | Max length | Use case |
|---|---|---|---|---|---|
| **Stable Audio 3 Small** | SAME-Small | CPU | 433M | 120s | Lightweight inference, no GPU required |
| **Stable Audio 3 Medium** | SAME-Large | GPU (CUDA) | 1.4B | 380s | High Quality, Fast Inference |
| **Stable Audio 3 Large** | SAME-Large | API only | 2.7B | 380s | Highest quality, API only. Not supported by this repo, see the [API docs](#) |
---

## Features
- ⚡ **Fast, state-of-the-art generation** - Generate minutes of audio in milliseconds
- 🎛️ **Three inference modes** — text-to-audio, audio-to-audio editing, and inpainting/continuation
- ↔️ **Variable-length generation** — handles generation of a variety of sequences without wasting inference on unused latents
- 🎯 **Personalization through LoRA fine-tuning** — adapt any model to a target style; stackable, adjustable at runtime
- 💻 **Broad hardware support** — CPU (Small), CUDA/TensorRT (Medium), Apple Silicon via MLX/CoreML, Intel via OpenVINO
- 🎵 **SAME autoencoder** — new Semantic-Acoustic Music Encoder; stereo, 44.1 kHz, 256-dimensional latents optimized for both generative tractability and high-quality reconstruction


## Installation

### Base (CPU, Small model)

```bash
# Base install
uv sync

# With CUDA support
uv sync --extra cuda

# With Gradio UI
uv sync --extra ui

# Multiple extras
uv sync --extra cuda --extra ui
```

### Flash Attention
Stable Audio 3 Medium requires [Flash Attention](https://github.com/Dao-AILab/flash-attention), follow the instructions from there to install.

## Quick Start

Launch the Gradio UI:

```bash
# Terminal 1
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload

# Terminal 2
cd frontend && npm run dev
```

Visit http://localhost:5173.

### Legacy Gradio UI

```bash
uv run python run_gradio.py --model medium
uv run python run_gradio.py --model medium --lora-ckpt-path path/to/lora.ckpt
```

---

## Quick examples (Python)

```python
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")
audio = pipe.generate(
    prompt="Lo-fi boom bap meets orchestral strings 84 BPM",
    duration=180,
)
```

# Text-to-audio
audio = pipe.generate(prompt="Lo-fi boom bap, 84 BPM", duration=180)

# Audio-to-audio
import torchaudio
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")
init_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    init_audio=init_audio,
    init_noise_level=0.9,
    prompt="bossa nova bassline",
    duration=30,
)
```

**Inpainting / Continuation** — Regenerate a specific region of an audio file while keeping the rest intact:

```python
import torchaudio
from stable_audio_3 import StableAudioModel

pipe = StableAudioModel.from_pretrained("medium")

inpaint_audio = torchaudio.load("/path/to/audio.wav")
audio = pipe.generate(
    inpaint_audio=inpaint_audio,
    inpaint_mask_start_seconds=4.0,
    inpaint_mask_end_seconds=8.0,
    prompt="punchy kick drum fill",
    duration=30,
)
```

To extend an audio clip (continuation), set `inpaint_mask_start_seconds` to the length of the source file and choose a longer `duration`. See [Inference Methods](docs/workflows/inference.md) for the full controls reference.


**Encoding / Decoding** — Use the autoencoder directly to encode audio to latents or decode latents back to audio:

```python
import torchaudio
from stable_audio_3 import AutoencoderModel

ae = AutoencoderModel.from_pretrained("same-l")
waveform, sr = torchaudio.load("audio.wav")
latents = ae.encode(waveform, sr)
audio_out = ae.decode(latents)
```

See [Autoencoder Workflows](docs/workflows/autoencoder.md) for encoding batches, chunked processing, and pre-encoding datasets for LoRA training.

## Hardware Support

*COMING SOON*

Stable Audio 3 scales from a laptop to a multi-GPU server. Specify your backend at load time:

```python
model = StableAudioModel.from_pretrained(
    "medium",
    backend="tensorrt"  # or "mlx", "coreml", "openvino"
)
```


### Inference Times

TBD

---

## Docs

| File | What's in it |
|---|---|
| **[docs/USER_GUIDE.md](docs/USER_GUIDE.md)** | The full manual — every feature, every control, every endpoint. The in-app Docs button renders this. |
| [docs/plans/](docs/plans/) | Planning documents for ongoing work. |
| [docs/workflows/inference.md](docs/workflows/inference.md) | Inference-mode reference (upstream). |
| [docs/workflows/lora.md](docs/workflows/lora.md) | LoRA training walkthrough (upstream). |
| [docs/workflows/autoencoder.md](docs/workflows/autoencoder.md) | Autoencoder workflows (upstream). |
| [docs/guides/prompting.md](docs/guides/prompting.md) | Prompt and control-signal reference (upstream). |
| [docs/guides/model-overview.md](docs/guides/model-overview.md) | Architecture and design (upstream). |
| [docs/windows/setup-guide.md](docs/windows/setup-guide.md) | Full Windows setup walkthrough. |

---

## Community

Join our [Discord](https://discord.gg/cKpvjey8b) for updates, help, and discussions. We host weekly office hours talking all things AI audio.

---

## Troubleshooting

#### Output audio is a static glitch sound (affects Stable Audio 3 Medium-only)

Likely an issue with flash-attention. Please make sure flash attention is installed correctly.
You can check with

```
uv run python -c "import flash_attn; from flash_attn import flash_attn_func; print('Version:', flash_attn.__version__, '| flash_attn_func:', flash_attn_func)"
```

if there are errors in any of this, `flash_attn` is not installed correctly.

---

## License

To use these models commercially, refer to the [Stability AI Community License](https://stability.ai/license).
