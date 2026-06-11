# Stable Audio 3 — Windows Setup Guide

> Tested on Windows 11 Pro, RTX 4090, Python 3.10, May 2026

The official README assumes Linux. This documents every gotcha we hit getting
Stable Audio 3 Medium running on Windows with CUDA.

---

## Prerequisites

| Tool | Why |
|------|-----|
| Python 3.10 | Required by project. On Windows the Flash Attention + cu128 torch wheels are pinned to 3.10 — Python 3.11+ silently falls back to a source build / CPU torch (static-glitch output). |
| [uv](https://docs.astral.sh/uv/getting-started/installation/) | Package manager used by the project (creates the venv, installs torch/CUDA) |
| [Node.js](https://nodejs.org/) v20.19+ / v22.12+ | Frontend dev server + VJ sidecar (Vite 7 floor). Includes npm. |
| [FFmpeg](https://www.gyan.dev/ffmpeg/builds/) on PATH | All audio I/O: effects, exports, library ingest, MIDI conversion, YouTube import |
| Git | Cloning repos (use `--recurse-submodules` so the Magenta sidecar source is present) |
| [git-xet](https://hf.co/docs/hub/git-xet) | Required for cloning HF model repos with large files |
| NVIDIA GPU + Driver 550+ | CUDA support for Medium model |
| Hugging Face account | Private repo access (collaborator required) |

> **`winget` not found?** The install commands below use `winget` (Windows Package
> Manager). It ships with the App Installer on Windows 11 but can be absent on older,
> LTSC, or Server builds. If `winget` is "not recognized," install **App Installer**
> from the Microsoft Store (or download each tool from its linked site above).

### Install git-xet
```powershell
winget install git-xet
```

### Install FFmpeg
```powershell
winget install Gyan.FFmpeg
```
Or download a build from <https://www.gyan.dev/ffmpeg/builds/>, unzip it, and add its `bin\` folder to PATH. Verify with `ffmpeg -version`. Without FFmpeg the servers still start, but every effect, export, and library ingest fails.

### Install Node.js
Install **v20.19+ or v22.12+** from <https://nodejs.org/> (the LTS installer includes npm and adds both to PATH). Verify with `node -v`. An older Node makes Vite 7 crash with an opaque error.

### Install HF CLI
```powershell
powershell -ExecutionPolicy ByPass -c "irm https://hf.co/cli/install.ps1 | iex"
```

### Login to Hugging Face
```powershell
hf auth login
# OR verify existing token:
# Token is stored at: %USERPROFILE%\.cache\huggingface\token
```

---

## Step 1: Clone the repo and sync dependencies

```powershell
git clone https://github.com/Stability-AI/stable-audio-3.git
cd stable-audio-3
uv sync --group dev
```

---

## Step 2: Fix PyTorch — install CUDA version

**Problem:** `uv sync` installs CPU-only PyTorch on Windows because
`pyproject.toml` only maps the CUDA index for Linux.

**Fix:** Reinstall torch + torchaudio with CUDA 12.8:

```powershell
uv pip install torch==2.7.1+cu128 torchaudio==2.7.1+cu128 --index-url https://download.pytorch.org/whl/cu128 --reinstall
```

> **Why cu128 and not cu126?** Pre-built flash-attn Windows wheels only exist
> for cu128. Using cu126 means you'd have to build flash-attn from source on
> Windows, which requires Visual Studio Build Tools + CUDA toolkit and is painful.

**Verify:**
```powershell
.\.venv\Scripts\python.exe -c "import torch; print(torch.__version__, '| CUDA:', torch.cuda.is_available())"
# Expected: torch 2.7.1+cu128 | CUDA: True
```

---

## Step 3: Install soundfile (torchaudio backend)

**Problem:** torchaudio ships with zero audio backends on Windows. Without one,
generation completes but crashes on `torchaudio.save()` with:
```
RuntimeError: Couldn't find appropriate backend to handle uri ... and format None.
```

**Fix:**
```powershell
uv pip install soundfile
```

**Verify:**
```powershell
.\.venv\Scripts\python.exe -c "import torchaudio; print(torchaudio.list_audio_backends())"
# Expected: ['soundfile']
```

---

## Step 4: Install Flash Attention (Medium model only)

**Problem:** No official flash-attn wheels for Windows. Building from source
requires MSVC + CUDA toolkit setup.

**Solution:** Use pre-built wheels from [kingbri1/flash-attention](https://github.com/kingbri1/flash-attention/releases).

Match your Python version (cp310 = Python 3.10, cp311 = 3.11, etc.):

```powershell
# Python 3.10 + CUDA 12.8 + torch 2.7
uv pip install https://github.com/kingbri1/flash-attention/releases/download/v2.8.3/flash_attn-2.8.3+cu128torch2.7.0cxx11abiFALSE-cp310-cp310-win_amd64.whl
```

**Verify:**
```powershell
.\.venv\Scripts\python.exe -c "import flash_attn; from flash_attn import flash_attn_func; print('Version:', flash_attn.__version__, '| flash_attn_func:', flash_attn_func)"
```

> **Small model users:** Flash Attention is optional. The Small model falls
> back to standard attention automatically.

---

## Step 5: Download the model

```powershell
hf download stabilityai/stable-audio-3-medium
```

Or via Python:
```powershell
.\.venv\Scripts\python.exe -c "from huggingface_hub import snapshot_download; print(snapshot_download('stabilityai/stable-audio-3-medium'))"
```

The model is ~17 GB and downloads to `%USERPROFILE%\.cache\huggingface\hub\`.

---

## Step 6: Run

```powershell
uv run python run_gradio.py --model medium
```

Opens a Gradio UI with a shareable link. The Medium model uses ~18 GB VRAM on
an RTX 4090.

---

## Quick verification checklist

```powershell
# Run all checks at once:
.\.venv\Scripts\python.exe -c "
import torch
print('torch', torch.__version__, '| CUDA:', torch.cuda.is_available())
import torchaudio
print('torchaudio backends:', torchaudio.list_audio_backends())
import flash_attn
print('flash_attn', flash_attn.__version__)
import stable_audio_3
print('stable_audio_3: OK')
"
```

Expected output:
```
torch 2.7.1+cu128 | CUDA: True
torchaudio backends: ['soundfile']
flash_attn 2.8.3
stable_audio_3: OK
```

---

## Known issues

| Issue | Cause | Fix |
|-------|-------|-----|
| `torch+cpu` installed by `uv sync` | pyproject.toml CUDA index only mapped for Linux | Reinstall with `--index-url .../cu128` |
| `torchaudio.save()` crashes with backend error | No audio backend on Windows | `uv pip install soundfile` |
| Flash Attention won't install | No official Windows wheels | Use kingbri1 pre-built wheels |
| `hf download` hangs with lock errors | Multiple download processes fighting | Kill all python processes, delete `.cache/huggingface/hub/.locks/...`, retry |
| Gradio CSS preload warning in browser | Gradio CDN issue, cosmetic | Ignore |
| Generation uses ~18 GB VRAM | Model + autoencoder + text encoder + activations | Normal for Medium on fp16 |

---

## VRAM breakdown (Medium model, fp16)

| Component | Approx Size |
|-----------|-------------|
| DiT (1.4B params) | ~2.8 GB |
| SAME-Large autoencoder | ~2.8 GB |
| T5Gemma text encoder | ~1.5 GB |
| Activations / KV cache | ~5-8 GB |
| CUDA context + overhead | ~2-3 GB |
| **Total** | **~18 GB** |

Minimum GPU: RTX 4090 (24 GB) or equivalent.
