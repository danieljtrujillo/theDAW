# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 🚨 HARD RULES — read before touching anything 🚨

These are non-negotiable. Violating them has burned the user before.

### 1. NEVER downgrade external models, APIs, libraries, or capabilities
Your training cutoff is older than the user's reality. The user is a
working developer with access to the latest releases — Gemini 3.5,
Claude 4.x, GPT-5 variants, whatever's actually current. If a model
name, API endpoint, library version, or product feature looks unfamiliar
or "doesn't exist," **assume YOUR knowledge is stale, not theirs**.

Concrete rules:
- **Do NOT remove model entries** from catalogs (e.g. `GEMINI_MODELS`,
  Claude/OpenAI/Grok caps maps in `backend/assistant_routes.py`)
  because you don't recognize them.
- **Do NOT pin libraries down** to versions you "know" exist when a
  newer one is in the lockfile.
- **Do NOT replace a "preview" / "experimental" / "-latest" model id**
  with a stable one you remember from training.
- **If you genuinely need to update a model list**, fetch the source
  of truth FIRST (WebFetch on `https://ai.google.dev/gemini-api/docs/models`,
  `https://docs.anthropic.com/en/docs/about-claude/models`,
  `https://platform.openai.com/docs/models`, etc.) — never write from
  memory. Then if you're proposing a downgrade, ASK the user first and
  let them confirm.

If you accidentally do downgrade, immediately fetch the docs and
restore the full catalog.

### 2. NEVER allow ruff version drift
Exactly ONE ruff version exists in this repo's tooling chain at all
times. It's pinned in `pyproject.toml` (`dependency-groups.dev`) AND
`.github/workflows/lint.yml` (the `RUFF_VERSION` env var) AND used via
`uv run ruff …` so the project venv's ruff is what runs. Symptoms of a
violation: `ruff format --check` complains about reformatting files
that were clean last commit, with no semantic edits in between.

Concrete rules:
- **Never `pip install ruff` or `pipx install ruff`** globally without
  matching the pinned version exactly.
- **Never edit only one of the two pin sites** — always update both in
  the same commit.
- **Before committing**, run `uv run ruff check .` AND
  `uv run ruff format --check .` from the repo root. Both must pass.
- **If `ruff format` drifts** after a session where nothing semantic
  changed, the FIRST suspect is a version mismatch — investigate
  before you "fix" the drift.

See the `## Ruff Configuration` section below for more detail.

## Project Overview

Stable Audio 3 is a text-conditioned audio generation system. It generates audio from text prompts using a two-stage architecture: a DiT (diffusion transformer) generates latents, then the SAME autoencoder decodes them to 44.1kHz stereo audio.

## Commands

```bash
# Install dependencies
uv sync --group dev

# Launch the app (Windows: bootstraps deps on first run, then runs backend + frontend in ONE console)
.\theDAW.bat

# Or launch the two dev servers manually (any OS)
uv run uvicorn backend.server:app --host 0.0.0.0 --port 8600 --reload   # backend  -> :8600
cd frontend && npm run dev                                             # frontend -> :5173

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

> ⚠️ **HARD RULE — RUFF VERSION:** Ruff is pinned to ONE exact version
> in TWO places: `pyproject.toml` (`dependency-groups.dev`) and
> `.github/workflows/lint.yml` (`RUFF_VERSION` env var). **NEVER allow
> these to drift, NEVER downgrade, NEVER install an older ruff
> "because it's still compatible," and NEVER let two ruff versions
> coexist anywhere in this repo's tooling chain.** Upgrading is fine —
> bump BOTH places in the SAME commit, then run `uv sync --group dev`
> and `uv run ruff format .` in that same commit. If `ruff format
> --check .` reports drift after the user reports a working tree was
> previously clean, the FIRST thing to check is whether a different
> ruff (older, newer, system-wide, pipx) snuck into the resolution
> chain. Do NOT mask the issue by reformatting against a stale ruff.

Ruff excludes `stable_audio_3/models`, `stable_audio_3/inference`, `stable_audio_3/interface`, and `stable_audio_3/data` from linting. Only top-level files (`pipeline.py`, `model.py`, `model_configs.py`, `loading_utils.py`, `verbose.py`) are checked.

**Always run from the repo root, never on a subset of dirs:**
```
uv run ruff check .
uv run ruff format .
```
CI runs at the repo root, so `ruff format backend/ tests/` alone will silently miss `stable_audio_3/*.py` drift. Local-dev workflow: run BOTH commands above before every commit; the pre-commit chain checks both.

## Testing

Tests use session-scoped fixtures to avoid reloading models. The `model_pipe` fixture is parametrized over `["small", "medium"]` — medium tests are auto-skipped without a CUDA GPU. `--save-audio` writes outputs to `test_audio_outputs/` for manual listening.

## Tailwind CSS v4 — Mandatory Class Forms

This project uses **Tailwind CSS v4**. The following v3 forms are forbidden and will cause VS Code Problems tab warnings. Never write them; always use the v4 canonical form instead.

| FORBIDDEN (v3) | REQUIRED (v4) |
|---|---|
| `!className` (prefix important) | `className!` (suffix important) |
| `flex-shrink-0` | `shrink-0` |
| `flex-grow` | `grow` |
| `bg-gradient-to-*` | `bg-linear-to-*` |
| `bg-opacity-*` | `bg-black/50` style opacity modifier |
| `w-[300px]` when scale token exists | `w-75` (300 ÷ 4) |
| `h-[14px]` when scale token exists | `h-3.5` (14 ÷ 4) |
| `z-[15]`, `z-[25]`, `z-[200]` | `z-15`, `z-25`, `z-200` |
| `min-w-[160px]` when scale token exists | `min-w-40` |
| `min-h-[80px]` when scale token exists | `min-h-20` |
| `bg-white/[0.03]`, `bg-purple-500/[0.04]` | `bg-white/3`, `bg-purple-500/4` |

**Scale token rule:** Tailwind v4 spacing scale is `value ÷ 4`. A `[Npx]` arbitrary value maps to `N/4` as a scale token whenever N is divisible by 4 (or to the nearest 0.5 step). Prefer scale tokens over arbitrary values at all times.

**Before writing any className string, mentally check it against this table.**

## Windows-Specific Setup

`pyproject.toml` maps the CUDA wheels per-platform under `[tool.uv.sources]`
(Linux x86_64 → cu126, Windows → cu128), so `uv sync` on Windows installs the
right stack automatically:
- torch + torchaudio come from the cu128 index (no manual `--index-url` step)
- `soundfile` is a base dependency (torchaudio's Windows backend), installed by `uv sync`
- Flash Attention installs from the pinned `kingbri1` cu128/cp310 wheel, gated to `sys_platform == 'win32' and python_version < '3.11'` (so the venv must be Python 3.10; `.python-version` pins it)
- `theDAW.bat` installs the prerequisite tools on first run; `docs/windows/setup-guide.md` has the full walkthrough and fallbacks

## RAG Index Maintenance

The in-app assistant answers from a RAG index built over the docs listed in
`backend/rag.py` (`DOC_PATHS`). Keep it current:

- **After any major update** — a new feature, tab, subsystem, or behavior change
  that a user could ask about — update the RAG: write/revise the relevant doc
  AND register it in `DOC_PATHS` if it's new. Stale or missing docs degrade the
  assistant's answers.
- **Run a regular sanity check / maintenance pass:** confirm every `DOC_PATHS`
  entry resolves (no missing-doc warnings on startup) and flag docs that have
  drifted from the current UI/behavior.
- **All doc/RAG changes, updates, and deletions are approval-based.** Research
  autonomously (read, diff, identify drift) and propose, but wait for approval
  before editing or deleting. Never auto-delete docs.
