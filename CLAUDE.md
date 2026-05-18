# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Stable Audio 3 is a text-conditioned audio generation system. It generates audio from text prompts using a two-stage architecture: a DiT (diffusion transformer) generates latents, then the SAME autoencoder decodes them to 44.1kHz stereo audio.

## Commands

```bash
# Install dependencies
uv sync --group dev

# Run Gradio UI
uv run python run_gradio.py --model medium

# Run tests (requires model weights downloaded)
uv run pytest

# Run single test file
uv run pytest tests/test_inference.py

# Run tests and save generated audio for inspection
uv run pytest --save-audio

# Lint (runs on CI for PRs)
uv run ruff check
uv run ruff format --check
```

## Architecture

### Two-Stage Pipeline

1. **SAME Autoencoder** (`models/autoencoders.py`) — Compresses 44.1kHz stereo audio to 256-dim continuous latents at 4096x downsampling. Two variants: SAME-S (266M, CPU-capable, chunked attention) and SAME-L (1.7B, GPU-required, sliding window attention).

2. **DiT** (`models/dit.py` → `models/transformer.py`) — Conditional diffusion transformer that generates SAME latents. Uses T5Gemma text conditioning, duration embeddings, and optional inpainting inputs. Three sizes: Small (433M), Medium (1.4B), Large (2.7B, API-only).

### Key Files

- `pipeline.py` — Public API. `StableAudioPipeline` and `AutoencoderPipeline` classes. All inference flows go through `generate()`.
- `model.py` — Model construction from config JSON. `create_diffusion_cond_from_config()` builds the full model graph.
- `model_configs.py` — Maps model names ("small", "medium", "medium-rf") to HuggingFace repo IDs and checkpoint filenames.
- `loading_utils.py` — Loads safetensor checkpoints, handles state dict key remapping between ARC/RF/standalone formats.
- `inference/sampling.py` — All samplers: Euler, RK4, DPM++, Ping-Pong. `sample_diffusion()` is the unified entry point.
- `inference/distribution_shift.py` — Timestep schedule warping (Flux shift, LogSNR shift).
- `models/conditioners.py` — `T5GemmaConditioner` loads `google/t5gemma-b-b-ul2` for text encoding. `NumberConditioner` for duration.
- `models/lora/` — LoRA implementation: parametrization, loading, stacking multiple LoRAs, per-layer filtering, interval-based activation.
- `interface/diffusion_cond.py` — Gradio UI wiring. Calls pipeline, handles file naming, audio format conversion via ffmpeg.

### Model Checkpoint Types

| Key | Type | Purpose |
|-----|------|---------|
| `small`, `medium` | ARC | Primary inference (post-trained, 8-step) |
| `small-rf`, `medium-rf` | RF | Base checkpoints for LoRA training |
| `same-s`, `same-l` | Autoencoder | Standalone encode/decode without DiT |

ARC and RF checkpoints bundle the autoencoder inside. Standalone SAME checkpoints share weights with the bundled versions and will reuse cached full checkpoints when available.

### CFG and Guidance

The DiT handles classifier-free guidance internally via batch doubling (`batch_cfg=True`). It also supports APG (Adaptive Projected Guidance) which projects the CFG diff orthogonal to the denoised prediction. ARC models default to `cfg_scale=1` (no guidance needed); RF models use `cfg_scale=7`.

### Variable-Length Generation

The model supports variable-length sequences without wasting compute on padding. Duration determines the latent sequence length directly. `mask_padding_attention=True` creates attention masks so padding positions don't corrupt valid content. Distribution shift warps the timestep schedule based on effective sequence length.

## Ruff Configuration

Ruff excludes `stable_audio_3/models`, `stable_audio_3/inference`, `stable_audio_3/interface`, and `stable_audio_3/data` from linting. Only top-level files (`pipeline.py`, `model.py`, `model_configs.py`, `loading_utils.py`, `verbose.py`) are checked.

## Testing

Tests use session-scoped fixtures to avoid reloading models. The `model_pipe` fixture is parametrized over `["small", "medium"]` — medium tests are auto-skipped without a CUDA GPU. `--save-audio` writes outputs to `test_audio_outputs/` for manual listening.

## Windows-Specific Setup

The `pyproject.toml` CUDA index mapping only covers Linux. On Windows:
- PyTorch must be manually installed with `--index-url https://download.pytorch.org/whl/cu128`
- `soundfile` package is required (torchaudio has no default backend on Windows)
- Flash Attention requires pre-built wheels from `kingbri1/flash-attention` GitHub releases
- See `docs/windows/setup-guide.md` for full instructions
