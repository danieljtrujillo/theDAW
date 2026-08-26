## MAKE tab — how a prompt becomes audio

The MAKE tab is theDAW's generation console. `AdvancedView` renders `AdvancedGenPanel` (the Stable Audio 3 surface) and swaps to the Suno cloud panel when the model is `suno` (`frontend/src/views/AdvancedView.tsx`). All parameters live in a Zustand store (`generateParamsStore.ts`); the submit/poll flow lives in `generateStore.ts`.

### From CREATE to audio
1. CREATE calls `submitGeneration`, which packs the params into multipart form data (`buildGenerateJobFormData`) and POSTs to `POST /api/generate-jobs`, receiving `{job:{id}}` (`frontend/src/state/generateStore.ts:314`).
2. The store polls `GET /api/jobs/{id}` every second, feeding the real sampler step fraction into a whole-run progress pacer (`generateStore.ts:98`).
3. The backend loads/wakes the model in a worker thread and runs `StableAudioPipeline.generate()` (`backend/server.py:1725` → `stable_audio_3/pipeline.py:301`), writes artifacts to disk (`data/generations/`), and returns base64 audio.
4. The store decodes the WAV, loads it on the footer transport, and refreshes the library via `BackendLocalProvider` (`/api/library/*`).

### Models
| Picker option | Model id (verbatim) | Type |
|---|---|---|
| Small (ARC) | `stabilityai/stable-audio-3-small-music` | ARC (gated) |
| Medium (ARC) | `stabilityai/stable-audio-3-medium` | ARC (gated) |
| Small-RF | `stabilityai/stable-audio-3-small-music-base` | RF (ungated) |
| Medium-RF | `stabilityai/stable-audio-3-medium-base` | RF (ungated) |
| Magenta RT2 | `mrt2_small` (WSL2/JAX sidecar) | live text→music |
| Suno (Cloud) | — routes to Suno panel | cloud |

Text conditioning uses `google/t5gemma-b-b-ul2` (`stable_audio_3/models/conditioners.py:164`). Gated ARC repos auto-fall back to the ungated public mirror `cocktailpeanut/stable-audio-3-small-music` (`stable_audio_3/model_configs.py:85`). Selecting a model sets sampler defaults (ARC: steps 8 / cfg 1; RF: steps 50 / cfg 7) and a **LOAD** pill pre-warms it onto the GPU (`AdvancedGenPanel.tsx:288`).

### Duration & variable length
The Length slider (0.5–512 s) sets the latent sequence length directly. The backend derives a per-request `sample_size` from duration + padding, aligned to the autoencoder downsampling ratio and latent chunk/stride so no padding is generated (`backend/server.py:586`); sampling warps the timestep schedule by effective length with `mask_padding_attention=True` (`stable_audio_3/pipeline.py:311`).

### Guidance: CFG + APG
Exposes CFG scale, **APG** (Adaptive Projected Guidance; `apg_scale` 1.0 = full APG, 0.0 = vanilla CFG), CFG rescale (`scale_phi`), CFG norm threshold, and a CFG interval `(min,max)`. The DiT does batched CFG internally (`batch_cfg=True`, `rescale_cfg=True`) (`stable_audio_3/pipeline.py:307`, `stable_audio_3/inference/sampling.py:356`).

### Sampler & distribution shift
Samplers: `pingpong` (default), `euler`, `rk4`, `dpmpp` (`stable_audio_3/inference/sampling.py:493`). Schedule shift: **LogSNR** (default), **Flux**, **Full**, **None**, each mapped to `LogSNRShift` / `FluxDistributionShift` / `DistributionShift` (`backend/server.py:1817`).

### Audio-conditioned modes
- **Init audio (audio-to-audio):** drop a clip (or render a MIDI) as a seed with an Init-noise strength and a Type select (Audio / RF-Inversion; RF-Inversion accepted but unused locally).
- **Inpainting:** a draggable mask region (seconds) → latent mask (`stable_audio_3/pipeline.py:176`).
- **Chimera weave:** ≥2 library clips are beat-aligned into a mashup and fed in as init audio before sampling (`generateStore.ts:541`).
- **LoRA:** multiple `.safetensors` adapters with per-adapter weights (`backend/server.py:1563`).

### AI prompt enhancer
The wand button rewrites the positive/negative prompt via `POST /api/assistant/chat` (SSE), defaulting to provider `gemini` / model `gemini-flash-recent` (`frontend/src/orb-kit/promptEnhancer.ts:22`).

### Runs locally?
Yes — SA3 generation (DiT + SAME AE + T5Gemma) and Magenta RT2 run fully on-device; weights need a one-time HF download unless already cached or provided as a local checkpoint (`SA3_LOCAL_ONLY=1` blocks downloads). Only the Suno model and the AI prompt-enhancer need the network/API keys; generation itself does not.
