# Running theDAW: performance on modest hardware, and with no cloud

## Optimization: running a multi-model stack on a modest GPU

theDAW never holds the whole system in memory at once. It is a FastAPI backend (`backend/server.py`, bound to `localhost:8600` by `backend/run.py:10-16`) plus a React/Vite frontend, and almost every heavy component is **deferred, lazily loaded, single-resident, or pushed into a separate process**. The result is that the parts that are actually running at any moment fit a small GPU, while everything else stays cold on disk.

### 1. Pick a small model, then run it in half precision

The generation stack is a two-stage pipeline (DiT → SAME autoencoder), and the local catalog only ships the **small** and **medium** DiT plus the **SAME-S / SAME-L** autoencoders — the 2.7B "Large" DiT that `CLAUDE.md` documents as API-only is simply absent from `stable_audio_3/model_configs.py` (`arc_models` = small/medium only, `model_configs.py:467-478`; `ae_models` = same-s/same-l, `model_configs.py:524-537`).

The single biggest footprint win is casting to **fp16 on CPU before the device move**, so only the half-size tensor is ever transferred to the GPU:

> "Measured A/B on the medium model: torch-reported peak load allocation is **4.65 GB with this order vs 9.35 GB** casting after the move, and the generated audio is bit-identical" — `stable_audio_3/loading_utils.py:137-148`

`model_half=True` is the default (`stable_audio_3/model.py:39`) and is automatically switched off when there is no CUDA device (`model.py:48-53`), so a CPU-only machine still loads. That 4.65 GB medium footprint is what makes ~6 GB VRAM viable; small is smaller still.

### 2. Chunked / sliding-window attention in the autoencoder

The SAME autoencoder is built from `TransformerResamplingBlock`s that attend over fixed **chunks** (`chunk_size=128`) or a **sliding window** rather than the full sequence (`stable_audio_3/models/autoencoders.py:41`, `:61-63`; wired through `SAMEEncoder`/`SAMEDecoder`, `:239`, `:304`). Per `CLAUDE.md`, SAME-S (266M) uses chunked attention and is CPU-capable, while SAME-L (1.7B) uses sliding-window attention and is GPU-oriented. Encode/decode can additionally be run in **overlapping chunks** to bound peak memory regardless of clip length — "Smaller chunk_size uses less memory, but more compute" (`autoencoders.py:556-600` encode, `:602-644` decode; surfaced on the pipeline as `chunked=`, `chunk_size=`, `overlap=` in `model.py:485-538`). Gradient checkpointing is also available in these blocks (`autoencoders.py:48`, `:177-178`).

### 3. Variable-length generation — no compute wasted on padding

Duration drives the latent sequence length directly, and the request path aligns the sample size to the AE chunk grid instead of always generating a fixed max length (`server.py:586-639` `_compute_request_sample_size`; `model.py:378-407` `_adapt_sample_size`). Sampling runs with `mask_padding_attention=True` and `use_effective_length_for_schedule=True` (`model.py:312-317`) so padding positions neither corrupt output nor cost attention compute, and the timestep schedule is warped by effective length (`stable_audio_3/inference/distribution_shift.py`, imported at `model.py:12`).

### 4. Lazy, deferred backend imports — server binds in ~1s, not ~10s

The torch / torchaudio / matplotlib / `stable_audio_3` graph (~9.6s of imports) is kept **off module scope** and imported inside the handlers that use it:

> "Heavy imports … total ~9.6s and are deliberately kept OFF module scope so uvicorn binds :8600 in ~1s instead of after the whole torch/XLA stack loads" — `server.py:38-46`

The heavy stack is then warmed in a background daemon thread **after** the port is bound (`_warm_heavy`, `server.py:135-172`, started at `server.py:861`), and the model catalog import is itself lazy and cached (`_generation_models`, `server.py:123-132`). RAG embeddings load only on the first assistant query (`server.py:870-872`).

### 5. Models load on demand, one GPU-resident at a time

No checkpoint is loaded at startup — "generation models load on demand" (`server.py:863-868`). When a model is first needed it is loaded and cached (`_get_or_load_generation_pipeline`, `server.py:303-365`), and a **single-resident policy** keeps only one big model on the GPU: switching models parks the previous pipeline in CPU RAM for a fast bit-identical swap when there is ≥10 GB free RAM, otherwise evicts it entirely (`_park_or_evict_other_generation_pipelines`, `server.py:214-265`, `_PARK_MIN_FREE_RAM_GB=10.0` at `:211`).

### 6. Non-destructive VRAM offload for co-resident GPU work

`POST /api/model/offload` parks the SA3 model(s) in CPU RAM to free VRAM (e.g. for the Magenta sidecar) without a disk reload, and `/api/model/onload` swaps them straight back — "a pure tensor transfer (no dtype change, bit-identical weights)" (`server.py:1065-1088` `_move_pipelines`, `:1090-1155`). Before any SA3 load/wake, a resident Magenta engine is stopped first to avoid stacking two GPU/commit loads (`_ensure_gpu_clear_of_magenta`, `server.py:267-300`).

### 7. Frontend: code-split, lazy panels, separate mobile bundle

Every workspace tab is `React.lazy` so "its JS — and its heavy deps (wavesurfer, the force-graph engine, the chimera/effect stacks, the VJ bridge) — only download when that tab is first opened" (`frontend/src/components/layout/DAWCenterPanel.tsx:16-41`). The assistant chunk (`react-markdown` + `@google/genai`) is deferred until the orb chat is first opened (`frontend/src/App.tsx:14-17`, `:437-446`); catalog, docs, and the MIDI panel are lazy too (`Shell.tsx:6,12`; `BottomMultiTabPanel.tsx:25`). Vite splits stable vendors (`three`, `wavesurfer`, `lucide`, `@google/genai`, markdown, spessasynth, maplibre) into long-cached chunks and gives the phone companion its own entry so "the phone never downloads the desktop bundle" (`frontend/vite.config.ts:54-77`). Live-performance tabs (DJ/VJ) stay mounted-but-hidden with the VJ iframe told to pause its render loop, "so a backgrounded VJ tab costs ~0% GPU" (`DAWCenterPanel.tsx:22-30`).

### 8. Bounded caches and idle-gated background work

Spectrograms are an LRU capped at 20 (`server.py:113-120`), finished generate-jobs are pruned past 40 (`server.py:1497-1508`), and model-resolution events cap at 200 (`model_configs.py:22`). Deferred work (analysis, stems, MIDI, notation backfill) runs through an idle-gated queue that checks `is_idle()` before pulling jobs (`server.py:876-902`; `backend/core/idle.py:35-115`), so background compute never competes with an active generation.

### 9. Heavy/exotic stacks isolated in sidecar processes

The JAX/CUDA Magenta RealTime engine runs in a **separate WSL2 process** on `:8777`, spawned on demand and health-probed, not loaded into the API process (`backend/modules/magenta/sidecar.py:36,84,201-258`). Stem separation runs in the Demucs/LARSNET `integration-package` sidecar (`backend/modules/stems/module.json`), and Whisper transcription runs in its own isolated venv (`pyproject.toml:187`). This keeps the always-on backend light and lets the OS reclaim their memory when idle.

### 10. On-demand, local-first model download

Weights are resolved **local folder → HF cache → download**, every step logged, so nothing is fetched that is already present (`model_configs.py:147-191`, search dirs at `:194-213`). Downloads are a session job registry with live per-file byte progress via a custom tqdm (`backend/modules/modeldl/router.py:65-107`, `:144-208`), on a dedicated 2-worker pool that never starves the event loop (`:53-56`).

*(One honest scope note: the memory savings come from half-precision fp16 + chunking + single-residency + lazy loading. There is no int8/4-bit quantization path in this code.)*

## No cloud, no datacenters: run the core fully offline

The entire creative core of theDAW runs on the local machine. The backend is a localhost FastAPI server (`backend/run.py:10-16`, `host="0.0.0.0"`, port 8600) and the frontend is a localhost Vite app (`vite.config.ts:88`, port 5173). Generation, decoding, stems, effects, the DAW, and the VJ engine all execute on-device; the only things that ever touch the internet are optional and can be skipped.

### Local-first, no account required

- **Audio generation** runs entirely on the local DiT + SAME autoencoder (`stable_audio_3/model.py`, `pipeline.py`). Model weights are fetched from Hugging Face **once** and then served from the local folder / HF cache forever after (`model_configs.py:147-191`). A hard offline switch exists: `SA3_LOCAL_ONLY=1` refuses any network access and requires the files be on disk (`model_configs.py:334-354`, `:428-444`). Drop the checkpoints under `models/` (or point `SA3_LOCAL_MODELS_DIR` / `local_models.txt` at them, `model_configs.py:194-213`) and generation needs no network at all.
- **Generated output is written to local disk**, not a cloud bucket: audio, spectrogram PNGs, and metadata land in `data/generations/…` (`server.py:412-419`, `:474-520`).
- **Stem separation** is a local Demucs/LARSNET sidecar (`backend/modules/stems/module.json`).
- **Effects / mastering / export** are local DSP: FFmpeg (`backend/modules/effects/module.json`), plus `scipy`, `pyloudnorm`, and JUCE/VST3 hosting via `pedalboard` (`pyproject.toml:36,81`).
- **MIDI, notation, and DAW import** are local libraries — `basic-pitch` + `piano-transcription-inference` (`pyproject.toml:48-56`), `music21` (`:60`), and the `.flp`/`.rpp`/`.aup3`/`.tasmo` parsers (`:81-91`).
- **VJ and DJ** engines run in-browser / embedded, and the phone companion talks to the same LAN server (`vite.config.ts:82-85`), not a remote service.

The Magenta RealTime "MAKE" engine is a local sidecar too (WSL2/CUDA on `:8777`, `backend/modules/magenta/sidecar.py:36`) — local, not a datacenter, though it needs a GPU.

### Optional cloud — present, gated, and skippable

Nothing below is required to make music:

- **Assistant LLM providers** are multi-provider and include **fully local** backends — Ollama, LM Studio, llama.cpp, and vLLM, all pointed at localhost with `env_key=None` (`backend/assistant_routes.py:299-326`). The cloud providers (Gemini, OpenAI, Anthropic, xAI, Groq, OpenRouter) each require an API key that is only read from the environment (`assistant_routes.py:249-298`, keys enumerated `:70-74`); with no key they are simply unavailable. The assistant panel is lazy-mounted only when the orb chat is opened (`App.tsx:14-17`), and its RAG document retrieval degrades gracefully — without `chromadb` "the server logs a non-fatal warning and the assistant runs without document retrieval" (`pyproject.toml:24-30`).
- **Suno** is an optional cloud proxy module (marked with a "Cloud" icon, `backend/modules/suno/module.json`) for those who want it; the local generator does not depend on it.
- **`genaiproxy`** is an optional Gemini proxy used only by the vocal2midi helper (`backend/modules/genaiproxy/module.json`).
- **Hugging Face downloads** are the one first-run network touch, and even that is softened: an ungated public mirror is used automatically when the gated official repo returns 401/403/404 (`model_configs.py:85-144`), and once cached, `SA3_LOCAL_ONLY=1` cuts the cord entirely.

### Bottom line

Once the model weights are on disk, **a musician can run theDAW's core — text-to-audio generation, decoding, stems, effects, the DAW timeline, and the VJ engine — entirely offline on their own laptop**, with the backend and frontend both on localhost. The cloud LLM assistant and Suno are conveniences layered on top, each replaceable by a local option or omitted outright, with no impact on the ability to create, process, and export music.

## Mechanisms (grounded in code)
- Small/Medium DiT + SAME-S/SAME-L only in local catalog (2.7B Large is API-only, absent) -> stable_audio_3/model_configs.py:467-478, :524-537
- fp16 half precision cast on CPU before device move halves load footprint (medium 4.65 GB vs 9.35 GB, bit-identical) -> stable_audio_3/loading_utils.py:137-148
- model_half default True, auto-disabled when no CUDA so CPU-only still loads -> stable_audio_3/model.py:39, :48-53
- Chunked attention (chunk_size=128) and sliding-window attention in autoencoder resampling blocks -> stable_audio_3/models/autoencoders.py:41, :61-63
- Overlapping chunked encode/decode bounds peak AE memory for any clip length -> stable_audio_3/models/autoencoders.py:556-600, :602-644 (exposed model.py:485-538)
- Gradient checkpointing available in AE transformer blocks -> stable_audio_3/models/autoencoders.py:48, :177-178
- Variable-length generation: sample size aligned to chunk grid, mask_padding_attention + effective-length schedule avoid padding compute -> stable_audio_3/model.py:312-317, :378-407; backend/server.py:586-639
- Heavy imports (torch/torchaudio/stable_audio_3, ~9.6s) kept off module scope so uvicorn binds :8600 in ~1s -> backend/server.py:38-46
- Heavy stack warmed in background thread after port bind; catalog import lazy+cached -> backend/server.py:135-172, :861, :123-132
- Models load on demand, none at startup -> backend/server.py:303-365, :863-868
- Single GPU-resident policy: previous pipeline parked in CPU RAM (>=10GB free) or evicted -> backend/server.py:214-265, :211
- Non-destructive VRAM offload/onload swaps model CPU<->GPU with no disk reload -> backend/server.py:1065-1088, :1090-1155
- Magenta sidecar cleared from GPU before SA3 load to avoid Windows commit-limit crash -> backend/server.py:267-300
- Frontend tab views code-split via React.lazy so heavy deps load only on first open -> frontend/src/components/layout/DAWCenterPanel.tsx:16-41
- Assistant chunk (react-markdown + @google/genai) deferred until orb chat opened -> frontend/src/App.tsx:14-17, :437-446
- Vite manualChunks split stable vendors; separate small mobile-companion entry bundle -> frontend/vite.config.ts:54-77
- DJ/VJ tabs stay mounted-but-hidden with VJ iframe render loop paused (~0% GPU backgrounded) -> frontend/src/components/layout/DAWCenterPanel.tsx:22-30
- Bounded caches: spectrogram LRU=20, generate-jobs pruned at 40, resolution events cap 200 -> backend/server.py:113-120, :1497-1508; model_configs.py:22
- Idle-gated background worker queue checks is_idle() before running analysis/stems/midi/notation work -> backend/server.py:876-902; backend/core/idle.py:35-115
- Heavy stacks isolated in sidecar processes (Magenta WSL2/JAX :8777, Demucs stems, Whisper venv) -> backend/modules/magenta/sidecar.py:36,84,201-258; backend/modules/stems/module.json; pyproject.toml:187
- On-demand local-first model resolution (local folder -> HF cache -> download) with live progress and mirror fallback -> stable_audio_3/model_configs.py:147-191, :85-144; backend/modules/modeldl/router.py:65-107,144-208
- Fully offline switch SA3_LOCAL_ONLY=1 blocks all network model fetch -> stable_audio_3/model_configs.py:334-354, :428-444
- Generated audio/spectrograms/metadata written to local disk (data/generations) -> backend/server.py:412-419, :474-520
- Local LLM assistant providers (Ollama/LM Studio/llama.cpp/vLLM) with no API key; cloud providers key-gated and optional -> backend/assistant_routes.py:299-326, :249-298
- RAG retrieval degrades gracefully without chromadb (non-fatal) -> pyproject.toml:24-30
- Suno and genaiproxy are optional cloud modules, not required by local generation -> backend/modules/suno/module.json; backend/modules/genaiproxy/module.json
- Local CPU DSP effects/mastering/export via FFmpeg + scipy + pyloudnorm + pedalboard VST3 -> pyproject.toml:36,81; backend/modules/effects/module.json
