## Generation Core — Stable Audio 3 Text-to-Audio

Stable Audio 3 generates 44.1 kHz stereo audio from a text prompt using a two-stage pipeline: a **DiT** (diffusion transformer) denoises latents, then the **SAME autoencoder** decodes those latents to a waveform. The public entry points are `StableAudioModel` / `StableAudioPipeline`, both exposing a single `generate()` method (`stable_audio_3/pipeline.py:77`, `stable_audio_3/model.py:89`).

### Pipeline at a glance
1. **Text conditioning** — a T5Gemma encoder (`google/t5gemma-b-b-ul2`, HuggingFace `transformers` `T5GemmaEncoderModel`) produces 768-dim cross-attention tokens; a `NumberConditioner` embeds the target duration (`stable_audio_3/models/conditioners.py:161`, `:125`).
2. **Sampling** — `sample_diffusion()` builds a timestep schedule and denoises SAME latents (`stable_audio_3/inference/sampling.py:355`).
3. **Decode** — the SAME autoencoder decodes latents to stereo audio, which is clamped to [-1, 1] and truncated to the requested duration (`stable_audio_3/pipeline.py:301`, `:331`).

### Model catalog
Names map to Stability HuggingFace repos (each ships `model_config.json` + `model.safetensors`) in `stable_audio_3/model_configs.py`:

| Key | Repo | Role |
|---|---|---|
| `small`, `medium` | `stabilityai/stable-audio-3-small-music`, `stabilityai/stable-audio-3-medium` | ARC post-trained inference (`:467`) |
| `small-rf`, `medium-rf` | `stabilityai/stable-audio-3-small-music-base`, `stabilityai/stable-audio-3-medium-base` | RF base for LoRA training (`:454`) |
| `small-sfx`, `small-sfx-base` | `stabilityai/stable-audio-3-small-sfx(-base)` | SFX family (`:491`) |
| `same-s`, `same-l` | `stabilityai/SAME-S`, `stabilityai/SAME-L` | Standalone autoencoders (`:524`) |

A user-supplied local folder or `.safetensors` file is also accepted (`stable_audio_3/model.py:55`). Per CLAUDE.md the Large 2.7B DiT is API-only and is not in the local catalog.

### Samplers
`sample_diffusion()` routes to four rectified-flow samplers — **Euler**, **RK4**, **DPM++**, and **Ping-Pong** (`stable_audio_3/inference/sampling.py:147`, `:189`, `:227`, `:308`). Default is Ping-Pong for the `rf_denoiser` objective, Euler otherwise (`:432`). Per-element schedules allow mixed-duration batches.

### Guidance (CFG + APG)
The DiT does classifier-free guidance in one forward pass via batch doubling (conditioned + unconditioned), then applies **Adaptive Projected Guidance**: the CFG delta is projected orthogonal to the conditioned prediction. `apg_scale=1.0` = full APG, `0.0` = vanilla CFG, in-between blends (`stable_audio_3/models/dit.py:483`, `:600`). Negative prompts, CFG rescale (`scale_phi`), a norm threshold, and an active-sigma interval are supported. ARC models default to 8 steps at `cfg_scale=1` (`stable_audio_3/pipeline.py:85`).

### Distribution-shift schedules
Four sequence-length-aware schedule warps: `IdentityDistributionShift`, `FluxDistributionShift`, `DistributionShift` ("full"), and `LogSNRShift`; the default sampling schedule is a seq-len-invariant `LogSNRShift` (`stable_audio_3/inference/distribution_shift.py:6`, `stable_audio_3/models/diffusion.py:79`). The backend exposes Flux/Full/LogSNR with tunable parameters (`backend/server.py:1381`).

### SAME autoencoder
Transformer-based resampling encoder/decoder with a soft-norm bottleneck; blocks use chunked attention or a sliding window, and standalone encode/decode supports overlapping chunking to bound memory on long audio (`stable_audio_3/models/autoencoders.py:231`, `:296`, `:556`).

### LoRA / DoRA / LoRA-XS
Adapters load onto a live model and blend at runtime. Types: `lora`, `dora-rows`/`dora`, `dora-cols`, `bora`, `lora-xs`, `dora-rows-xs`, `dora-cols-xs` (`stable_audio_3/models/lora/model.py:46`). Multiple LoRAs stack with per-adapter rank/alpha, sigma interval, and layer filter (`stable_audio_3/models/dit.py:463`); the backend wires `load_lora` + `set_lora_strength` into generation (`backend/server.py:1565`).

### Audio-to-audio & inpainting
`generate()` accepts `init_audio` for variation/audio-to-audio (via `init_noise_level`) and `inpaint_audio` with a mask by start/end seconds or a prebuilt tensor (`stable_audio_3/pipeline.py:240`, `:177`).

### Runs offline
Resolution is local-first (local folder → HF cache → download), with `SA3_LOCAL_ONLY=1` forcing disk-only (`stable_audio_3/model_configs.py:147`, `:334`). Gated ARC repos fall back to an ungated public mirror with identical weights so a tokenless first run still works (`:74`). After the one-time download of the checkpoint and the ~2 GB T5Gemma encoder, no network or cloud key is needed.

### Key libraries (verbatim from pyproject.toml)
`torch==2.7.1`, `torchaudio==2.7.1`, `transformers>=5.8.0`, `huggingface-hub>=1.7.1`, `safetensors>=0.7.0`, `einops>=0.8.2`; on Windows a pinned `flash-attn` 2.8.3 cu128/cp310 wheel, with a graceful `torch.scaled_dot_product_attention` fallback when Flash Attention is absent (`stable_audio_3/models/transformer.py:22`, `:697`).
