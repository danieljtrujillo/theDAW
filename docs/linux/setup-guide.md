# theDAW — Linux Setup Guide

Linux x86_64 is a supported target for the backend and the web UI. The
dependency graph already maps it (`pyproject.toml` `[tool.uv.sources]` pulls
the cu126 torch/torchaudio wheels for `sys_platform == 'linux'`), every pull
request runs `uv sync` + the test suite on `ubuntu-latest`, and the root
`Dockerfile` runs the whole app on Debian. What has been missing is this page
and a shell launcher — `theDAW.bat` is Windows-only.

Treat this as the supported path rather than one that has been walked on every
distro: if a step below breaks for you, please open an issue with the distro,
`ldd --version`, and the exact error.

## TL;DR

```bash
git clone --recurse-submodules https://github.com/gantasmo/theDAW.git
cd theDAW
./theDAW.sh
```

`theDAW.sh` preflights the tools, builds the Python environment, installs the
frontend, and starts the backend + Vite dev server in one terminal, opening
http://localhost:5173. Everything it does is spelled out below so you can run
the steps by hand.

## Prerequisites

| Tool | Why | Install |
|---|---|---|
| **uv** | Python env + every Python dependency (pulls its own CPython 3.10) | `curl -LsSf https://astral.sh/uv/install.sh \| sh` |
| **Node ≥ 20.19** (22.12 recommended) | Frontend dev server and the VJ sidecar | See below — distro packages are usually too old |
| **ffmpeg** | All audio I/O: effects, exports, library ingest, MIDI, YouTube | `apt-get install ffmpeg` |
| **git**, **build-essential**, **libglib2.0-0** | Submodules; native builds; `opencv-python-headless` runtime | `apt-get install git build-essential libglib2.0-0` |
| **NVIDIA driver + CUDA 12.x** | GPU generation (the Medium model requires it; Small runs on CPU) | Distro / NVIDIA instructions |

> **Node from apt is too old.** Ubuntu 22.04 and 24.04 ship Node 18/20.x
> below the `>=20.19` floor in `frontend/package.json`. Use nvm:
>
> ```bash
> curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
> exec "$SHELL"
> nvm install 22.12.0      # matches frontend/.nvmrc
> ```

The apt list mirrors what the `Dockerfile` installs for its runtime stage:

```bash
sudo apt-get update
sudo apt-get install -y ffmpeg git build-essential libglib2.0-0
```

## Install

```bash
git clone --recurse-submodules https://github.com/gantasmo/theDAW.git
cd theDAW
uv sync --group dev
cd frontend && npm install && cd ..
```

`uv sync` installs torch + torchaudio from the cu126 index automatically —
there is no `--index-url` step and no manual CUDA wheel selection. A prebuilt
`manylinux2014_x86_64` aubio wheel is committed under `wheels/`, so nothing
needs a compiler.

### If `uv sync` fails on `pyk4a-bundle`

You are on glibc older than 2.38 (`ldd --version`; Ubuntu 22.04 = 2.35, Debian
12 = 2.36, Ubuntu 24.04 = 2.39 and is fine). That package has no source
distribution and its only Linux wheel is `manylinux_2_38`. It is the Azure
Kinect point-cloud backend for the AKVJ visualiser and is imported lazily, so
skip it — this is exactly what the `Dockerfile` does:

```bash
uv sync --group dev --no-install-package pyk4a-bundle
```

**After using that flag, launch from the venv interpreter, not `uv run`.**
`uv run` re-syncs the project first, re-attempts `pyk4a-bundle`, and fails with
the identical error. `theDAW.sh` already launches from `.venv/bin/python` for
this reason.

## Run

```bash
./theDAW.sh
```

Or the two-terminal form:

```bash
# Terminal 1 — backend on :8600
.venv/bin/python -m uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload

# Terminal 2 — frontend on :5173 (proxies /api/* to :8600)
cd frontend && npm run dev
```

Open http://localhost:5173. On glibc ≥ 2.38 the documented
`uv run uvicorn …` form from the README works too.

### Container

The root `Dockerfile` builds the full app, and a prebuilt image is published as
`ghcr.io/gantasmo/thedaw:latest`. See [DOCKER.md](../DOCKER.md).

## What is different on Linux

| Area | Status |
|---|---|
| MAKE / EDIT / MIX / library / notation / MIDI / export | Works |
| **Flash Attention** | **Not installed, by design.** `pyproject.toml` gates the wheel to `sys_platform == 'win32'`. The model falls back to flex-attention → chunked-halo SDPA → full masked SDPA, which is designed to be numerically equivalent but slower. You will see `flash_attn not installed, disabling Flash Attention` at startup — expected, not an error. `GET /api/health` reports `flash_attention_active: false`. |
| VST3 (pedalboard) | Works with Linux `.vst3` bundles. Windows `.vst3` binaries do not load, and native plugin editor windows do not embed (that path is `ctypes.windll`). |
| MuseScore engraving (PDF / SVG scores) | Works if MuseScore is installed: the engine searches `PATH` for `MuseScore4`, `MuseScore3`, `mscore`, `musescore`, and honours `MUSESCORE_BIN`. |
| Kinect point cloud (pyk4a) | Needs the hardware *and* glibc ≥ 2.38 for the wheel. |
| Quest bridge | adb-based and resolved cross-platform; untested on Linux. |
| Magenta RT2 | Supported with a manual engine setup. The sidecar spawns the engine venv's python directly on Linux (Windows uses WSL2): point `THEDAW_MAGENTA_PYTHON` at your MRT2 venv interpreter (default `~/mrt2/.venv/bin/python`), or run the engine yourself and set `THEDAW_MAGENTA_URL`. The `sidecars/magenta-rt2-nvidia` submodule ships bash installers under `install/` and `engine/build_cuda.sh`. |
| Underfit (LoRA trainer) | Works; needs a CUDA GPU to train. The tab builds its own venv on first use. |
| **Electron desktop shell** | **No Linux target is built.** `theDAW.sh` always launches the browser UI; a `launch_mode: desktop` setting is ignored with a notice. |

### If the Medium model outputs static

Our Windows docs attribute static/glitchy Medium output to Flash Attention
failing to load. On Linux you are *always* on the fallback, and the fallback is
designed to be equivalent — so static is not expected. If you get it, please
report it with the model name and the `/api/health` output; that combination
tells us the fallback needs attention, which no Windows report can.

## Verify

```bash
curl -s http://localhost:8600/api/health
# {"status":"ok","model_loaded":false,"flash_attention_installed":false,"flash_attention_active":null}

.venv/bin/python -c "import torch; print(torch.__version__, torch.cuda.is_available())"
```

`torch.cuda.is_available()` should print `True` on an NVIDIA machine with a
working driver. If it prints `False`, the cu126 wheel installed but the driver
is missing or too old for CUDA 12.6 — `nvidia-smi` will say.

## Models

Identical to Windows: checkpoints download from Hugging Face on first use into
`~/.cache/huggingface/hub`. The post-trained `small` / `medium` repos are gated —
accept the licence on huggingface.co, then sign in when the app raises the
Hugging Face card (or run `hf auth login`). See the Models section of the
[Windows guide](../windows/setup-guide.md#models); the paths differ, the flow
does not.
