# theDAW — Windows Setup Guide

> Targets Windows 11 with an NVIDIA GPU and Python 3.10. theDAW is a React +
> FastAPI application; this guide covers the Windows-specific pieces the README
> links to here.

theDAW runs two local servers: a FastAPI backend on port 8600 and a Vite
frontend on port 5173. On Windows, `uv sync` installs the CUDA build of PyTorch
and the prebuilt Flash Attention wheel automatically, and `theDAW.bat`
bootstraps everything and launches the whole stack in one console. Most users
never run a manual install command.

---

## TL;DR

```powershell
.\theDAW.bat
```

On a fresh clone with the prerequisites below on PATH, `theDAW.bat` verifies the
tools, runs `uv sync --group dev` and `npm install` on first launch, then starts
the backend, the frontend, and the optional tunnel in a single window and opens
<http://localhost:5173>. Everything after this section is detail and fallbacks.

---

## Prerequisites

| Tool | Why |
|------|-----|
| Python 3.10 | The Windows Flash Attention + cu128 torch wheels are built for cp310. Python 3.11+ skips the Flash Attention wheel and the Medium GPU path degrades. `uv` can install 3.10 for you (`uv python install 3.10`). |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Creates the venv and installs torch/CUDA + Flash Attention. |
| [Node.js](https://nodejs.org/) v20.19+ / v22.12+ | Frontend dev server + VJ sidecar (the Vite 7 floor). Includes npm. |
| [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) on PATH | All audio I/O: effects, exports, library ingest, MIDI conversion, YouTube/SoundCloud import. |
| Git | Cloning the repo (use `--recurse-submodules` so the Magenta sidecar source is present). |
| NVIDIA GPU + Driver 550+ | CUDA support for the Medium model and the Magenta sidecar. The Small model runs on CPU. |
| Hugging Face account | Only if a model repo you load requires authentication. |

> **`winget` not found?** Some commands below use `winget` (Windows Package
> Manager). It ships with the App Installer on Windows 11 but can be absent on
> older, LTSC, or Server builds. If `winget` is "not recognized," install **App
> Installer** from the Microsoft Store, or download each tool from its linked
> site above.

### Install the tools

```powershell
winget install astral-sh.uv          # uv
winget install OpenJS.NodeJS.LTS     # Node + npm
winget install Gyan.FFmpeg           # FFmpeg
winget install Git.Git               # Git
```

Verify each is on PATH: `uv --version`, `node -v`, `ffmpeg -version`, `git --version`.
For FFmpeg you can also unzip a [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
build and add its `bin\` folder to PATH.

If you load a gated Hugging Face model repo, log in once:

```powershell
powershell -ExecutionPolicy ByPass -c "irm https://hf.co/cli/install.ps1 | iex"
hf auth login
```

---

## What `uv sync` installs automatically on Windows

`pyproject.toml` pins CUDA 12.8 wheels for torch and torchaudio and the prebuilt
Flash Attention wheel under `[tool.uv.sources]`, gated to Windows and Python
3.10. A plain `uv sync --group dev` on Windows therefore pulls:

- **torch 2.7.1+cu128** and **torchaudio 2.7.1+cu128** (from the cu128 index)
- **flash-attn 2.8.3** (the [kingbri1](https://github.com/kingbri1/flash-attention/releases) prebuilt cp310 wheel)
- **soundfile** (a base dependency; torchaudio's audio backend on Windows)

There is no manual torch reinstall, no manual wheel download, and no separate
`soundfile` install. Those were required on the old upstream layout and are now
handled by `pyproject.toml`.

> **Why Python 3.10?** The Flash Attention wheel is built for cp310, and
> `pyproject.toml` only requests flash-attn on `python_version < '3.11'`. On
> Python 3.11+ that wheel is skipped, so use Python 3.10 for the supported
> Windows GPU path.

---

## Verify the install

```powershell
.\.venv\Scripts\python.exe -c "
import torch
print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available())
import torchaudio
print('torchaudio backends:', torchaudio.list_audio_backends())
import flash_attn
print('flash_attn', flash_attn.__version__)
"
```

Expected output:

```
torch 2.7.1+cu128 | CUDA: True
torchaudio backends: ['soundfile']
flash_attn 2.8.3
```

---

## Models

theDAW downloads model weights from Hugging Face the first time a model is
loaded and caches them under `%USERPROFILE%\.cache\huggingface\hub\`. For normal
use there is no separate download step: pick a model in the UI and the backend
fetches it on demand, then parks it in RAM between uses.

To pre-fetch a model (optional):

```powershell
hf download stabilityai/stable-audio-3-medium
```

If the repo requires authentication, run `hf auth login` first. The Medium model
is roughly 17 GB.

---

## Hardware notes

- The **Small** model runs on CPU or any CUDA GPU.
- The **Medium** model is the GPU-heavy path. theDAW casts it to fp16, loads it
  on demand, and parks it in RAM when idle, so memory use scales with what you
  actually run. The full Medium stack is roughly 18 GB of VRAM at peak.

Rough VRAM breakdown for the Medium model (fp16):

| Component | Approx Size |
|-----------|-------------|
| DiT (1.4B params) | ~2.8 GB |
| SAME-Large autoencoder | ~2.8 GB |
| T5Gemma text encoder | ~1.5 GB |
| Activations / KV cache | ~5-8 GB |
| CUDA context + overhead | ~2-3 GB |

On a GPU below that, run the Small model, or use the Magenta sidecar and the
backend's GPU offload to share VRAM.

---

## Fallbacks

These are only needed if the automatic install above did not apply (for example
a non-3.10 Python, a different CUDA version, or `uv sync` resolving CPU torch).

### `uv sync` installed CPU-only torch

```powershell
uv pip install torch==2.7.1+cu128 torchaudio==2.7.1+cu128 --index-url https://download.pytorch.org/whl/cu128 --reinstall
```

### A different Python or CUDA version

Flash Attention has no official Windows wheels, so match a prebuilt one to your
Python version from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases):

| Python | Wheel |
|--------|-------|
| 3.10 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp310-cp310-win_amd64.whl` |
| 3.11 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp311-cp311-win_amd64.whl` |
| 3.12 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp312-cp312-win_amd64.whl` |
| 3.13 | `flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp313-cp313-win_amd64.whl` |

```powershell
uv pip install https://github.com/kingbri1/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp310-cp310-win_amd64.whl
```

The wheel's CUDA version must match your torch build (these are cu128, so pair
them with `torch==2.7.1+cu128`).

### Other Windows issues

Backend won't start, FFmpeg missing, HF download hangs on lock files, static or
glitchy Medium output: see [troubleshooting.md](troubleshooting.md).

---

## Legacy Gradio UI (optional)

The original Gradio interface still ships as `run_gradio.py`, but gradio was
removed from the default dependencies in a CVE sweep, so `uv sync` does not
install it and theDAW itself does not use it. To run the legacy UI, reinstall
its dependencies first:

```powershell
uv pip install gradio accelerate
uv run python run_gradio.py --model medium
```
