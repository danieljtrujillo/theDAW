# theDAW — Windows Setup Guide

> Targets Windows 11 with an NVIDIA GPU and Python 3.12. theDAW is a React +
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

On a fresh clone, `theDAW.bat` verifies the prerequisites below. If required
tools are missing, it invokes `install/setup.ps1`, which performs a read-only
hardware/tool check and asks for consent before installing anything. Once the
tools are present, the launcher runs `uv sync --group dev` and `npm install` on
first launch, then starts the backend, the frontend, and the optional tunnel in a
single window and opens <http://localhost:5173>. Everything after this section is
detail and fallbacks.

---

## Prerequisites

| Tool | Why |
|------|-----|
| Python 3.12 | The repo pins it (`.python-version`, `requires-python >= 3.12`), and it is what the committed aubio wheel, the CUDA-13 onnxruntime-gpu wheels and the tested Flash Attention wheel are built for. `uv` installs it for you (`uv python install 3.12`). |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Creates the venv and installs torch/CUDA + Flash Attention. |
| [Node.js](https://nodejs.org/) v20.19+ / v22.12+ | Frontend dev server + VJ sidecar (the Vite 7 floor). Includes npm. |
| [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) on PATH | All audio I/O: effects, exports, library ingest, MIDI conversion, YouTube/SoundCloud import. |
| Git | Cloning the repo (use `--recurse-submodules` so the Magenta sidecar source is present). |
| NVIDIA GPU + Driver 580+ | CUDA 13 needs a driver on the R580 branch or newer. Turing (sm_75) through Blackwell are supported. Runs the Medium model and the Magenta sidecar; the Small model runs on CPU. |
| Hugging Face account | Only if a model repo you load requires authentication. |

> **`winget` not found?** Some commands below use `winget` (Windows Package
> Manager). It ships with the App Installer on Windows 11 but can be absent on
> older, LTSC, or Server builds. If `winget` is "not recognized," install **App
> Installer** from the Microsoft Store, or download each tool from its linked
> site above.

### Install the tools

The easiest path is to let theDAW do it: double-click **`theDAW.bat`**. When a
tool is missing, it runs **`install/setup.ps1`**, which detects your hardware,
lists the missing uv / Node / FFmpeg / Git pieces, and asks for confirmation
before downloading or installing anything. The commands below are the manual
fallback.

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

`pyproject.toml` pins CUDA 13.0 (cu130) wheels for torch and torchaudio and the
prebuilt Flash Attention wheel under `[tool.uv.sources]`, gated to Windows and
Python 3.12-3.14. A plain `uv sync --group dev` on Windows therefore pulls:

- **torch 2.14.0+cu130** and **torchaudio 2.11.0+cu130** (from the cu130 index)
- **flash-attn 2.8.3+cu130torch2.14** (the [mjun0812](https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/tag/v0.10.2) prebuilt cp312 wheel)
- **soundfile** (a base dependency; libsndfile is what `backend/lib/audio_io.py`
  reads and writes every file with. torchaudio is kept for transforms only — its
  own `load` / `save` go through torchcodec now and are never called here)

There is no manual torch reinstall, no manual wheel download, and no separate
`soundfile` install. Those were required on the old upstream layout and are now
handled by `pyproject.toml`.

> **Turing and Volta GPUs (RTX 20xx, GTX 16xx, TITAN RTX, V100):** the Flash
> Attention wheel installs and imports on these cards but its kernels only run
> on Ampere (RTX 30xx) or newer. theDAW checks the compute capability per GPU
> at first use and routes attention through PyTorch's SDPA fallback on anything
> below sm_80, so generation, init audio and inpainting still work — somewhat
> slower, with a one-line `flash_attn disabled on …` notice in the LOG panel.
> No configuration is needed.

> **Why Python 3.12?** `requires-python` is `>= 3.12` and `.python-version`
> pins 3.12, which is also what the committed aubio wheel and the CUDA-13
> onnxruntime-gpu wheels are built for. `pyproject.toml` requests flash-attn on
> `python_version < '3.15'` and carries a wheel for cp312, cp313 and cp314, so
> 3.13 and 3.14 get Flash Attention too — 3.12 is the tested one.

---

## VST Foundry tab (Node sidecar)

The **Foundry** center tab (the visual plugin-UI builder) runs as a small Node
sidecar on **port 5472**. It needs nothing beyond the **Node.js** you already
installed above. Its JavaScript dependencies install on first launch:
`theDAW.bat` runs `npm install` for it under `VST-Foundry-UI\VST-UI-FOUNDRY` when
that folder has no `node_modules`, and the same install runs on demand the first
time you open the tab — a one-time wait. On each relaunch, `theDAW.bat` also
clears any stale process still listening on 5472, and the backend shuts the
sidecar down cleanly when it exits. See the
[VST Foundry guide](../guides/foundry.md) for what the tab does.

---

## Verify the install

```powershell
.\.venv\Scripts\python.exe -c "
import torch
print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available())
from backend.lib.audio_io import load_audio, save_audio
print('audio I/O: libsndfile via backend.lib.audio_io')
import flash_attn
print('flash_attn', flash_attn.__version__)
"
```

Expected output:

```
torch 2.14.0+cu130 | CUDA: True
audio I/O: libsndfile via backend.lib.audio_io
flash_attn 2.8.3
```

The audio check imports the app's own I/O layer rather than asking torchaudio
for a backend list: torchaudio's `load` / `save` are not used here at all, so
what they report says nothing about whether the app can read a file.

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

To place model files by hand instead (offline installs, or putting them on
another drive), see the User Guide section 21.2, "Manual model placement," for
the exact folder tree, the per-model download links and filenames, and where the
T5Gemma text encoder belongs. The in-app **Settings -> Models** panel can also
register a checkpoint you already have through its **Browse** button.

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

`uv sync` is the supported install path, and it is the only one the lock guard
can vouch for: `[tool.uv] required-environments` names Linux x86_64 and Windows
AMD64, so `uv lock` refuses a version without wheels for both, and
`scripts/check_lock.py` (the pre-commit hook and CI) proves the lock installs on
each. Hand-installing an off-lock wheel puts the venv somewhere nothing has
tested. Re-sync instead of reaching for `uv pip install`.

### `uv sync` installed CPU-only torch

```powershell
uv sync --reinstall-package torch --reinstall-package torchaudio
```

`[tool.uv.sources]` maps both to the cu130 index on Windows, so a re-sync is the
fix. If it still resolves CPU torch, something else is interfering — a custom
index in `UV_INDEX_URL`, an offline cache, or a venv built for another platform.

### A different Python version

`pyproject.toml` carries a prebuilt Flash Attention wheel for cp312, cp313 and
cp314 — the `flash_attn-2.8.3+cu130torch2.14-cp3XX-cp3XX-win_amd64.whl` assets on
[mjun0812/flash-attention-prebuild-wheels v0.10.2](https://github.com/mjun0812/flash-attention-prebuild-wheels/releases/tag/v0.10.2).
Python 3.15 and later get no wheel and fall back to PyTorch's SDPA path.

A wheel has to match **both** the torch version and the CUDA version it was
built against. This project is torch 2.14 + CUDA 13; a wheel for any other pair
will not import, whatever Python it says on the filename.

### Other Windows issues

Backend won't start, FFmpeg missing, HF download hangs on lock files, static or
glitchy Medium output: see [troubleshooting.md](troubleshooting.md).
