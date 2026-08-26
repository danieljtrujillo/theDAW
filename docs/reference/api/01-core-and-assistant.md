## theDAW Core HTTP API

The "core" router group is wired directly in `backend/server.py` (not via the module auto-discovery loader). Endpoints are registered on the FastAPI `app` with hardcoded `/api/...` paths, and two sub-routers are included in-process:

- `assistant_router` — `APIRouter(prefix="/api/assistant")` (`backend/assistant_routes.py:79`), included at `backend/server.py:1986`.
- `admin_router` — `APIRouter(prefix="/api/admin")` (`backend/admin_routes.py:26`), included at `backend/server.py:1987`.

**Prefix convention:** the auto-discovery loader (`backend/modules/loader.py:41-42`) mounts each discovered `modules/*/router.py` at `config.api_prefix` defaulting to `/api/<module_dir_name>`. The core routers are mounted by hand but follow the same `/api/<group>` convention: `admin` and `assistant` carry their prefixes on the `APIRouter`, and `server.py` hardcodes `/api/...` on every route. No route-level auth/dependencies are attached; CORS is open (`allow_origins=["*"]`, `backend/server.py:63-69`). API keys are only needed by the assistant chat/model-discovery paths, resolved server-side from the request body, the key pool, or per-provider env vars.

### Modules (`server.py`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| GET | `/api/modules` | List loaded module manifests | `backend/server.py:922` |
| GET | `/api/modules/all` | List every module on disk (loaded + not) | `backend/server.py:927` |
| PATCH | `/api/modules/{module_name}/enabled` | Toggle a module via its `module.json` (`{enabled: bool}`) | `backend/server.py:945` |

### System & health (`server.py`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| GET | `/api/system-stats` | VRAM/GPU/CPU/RAM utilization | `backend/server.py:965` |
| GET | `/api/health` | Health probe `{status, model_loaded}` | `backend/server.py:1019` |
| GET | `/api/model-info` | Active/available/loaded models + device/VRAM metadata | `backend/server.py:1024` |
| GET | `/api/log` | In-memory backend log records; `?since=&limit=` seq poll | `backend/server.py:1977` |

### Model lifecycle (`server.py`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| POST | `/api/model/load` | Pre-load/wake a named model (form `model`); 409 if generating, 404 unknown | `backend/server.py:1169` |
| POST | `/api/model/offload` | Park model in CPU RAM, free VRAM; 409 if generating | `backend/server.py:1090` |
| POST | `/api/model/onload` | Swap parked model back to VRAM; 409 if generating | `backend/server.py:1125` |
| GET | `/api/model/offload-status` | Whether the model is parked in CPU RAM | `backend/server.py:1158` |

### Spectrograms (`server.py`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| POST | `/api/spectrogram` | Generate MEL/STFT/Chromagram/CQT from `audio_base64` or `audio_file` (50MB cap) | `backend/server.py:1206` |
| GET | `/api/spectrogram/{job_id}` | Cached spectrograms for a job | `backend/server.py:1270` |
| GET | `/api/spectrogram/{job_id}/{index}` | Cached spectrograms for a batch item | `backend/server.py:1284` |

### Generation & jobs (`server.py`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| POST | `/api/generate` | Synchronous text-to-audio; streams the audio file (X-Seed/X-Duration headers) | `backend/server.py:1306` |
| POST | `/api/generate-jobs` | Async batch/LoRA generation; returns `{job:{id}}` to poll | `backend/server.py:1725` |
| GET | `/api/jobs` | List job summaries (result stripped) | `backend/server.py:1910` |
| GET | `/api/jobs/{job_id}` | Full job record incl. base64 audio + spectrograms | `backend/server.py:1923` |

### Autoencoder, presets, training (stubs, `server.py`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| GET | `/api/autoencoder/info` | Returns empty availability lists | `backend/server.py:1931` |
| POST | `/api/jobs/train-lora` | Not implemented (501) | `backend/server.py:1936` |
| POST | `/api/jobs/pre-encode` | Not implemented (501) | `backend/server.py:1943` |
| POST | `/api/autoencoder/encode` | Not implemented (501) | `backend/server.py:1950` |
| POST | `/api/autoencoder/decode` | Not implemented (501) | `backend/server.py:1957` |
| GET | `/api/presets` | Returns `[]` (stub) | `backend/server.py:1964` |
| POST | `/api/presets` | Accepts + discards a preset dict; returns `{id, saved:true}` | `backend/server.py:1969` |

> Note: `GET /m` (`backend/server.py:2043`) is a 302 redirect to `/mobile.html`, registered only when a built `frontend/dist` is served and hidden from the schema (`include_in_schema=False`).

### Admin (`admin_routes.py`, prefix `/api/admin`)

| Method | Path | Purpose | Evidence |
|---|---|---|---|
| GET | `/api/admin/restart-status` | Whether running under the restart supervisor | `backend/admin_routes.py:47` |
| POST | `/api/admin/restart` | Schedule clean re-exec (exit 88); 412 if no supervisor | `backend/admin_routes.py:58` |
| POST | `/api/admin/shutdown` | Schedule clean shutdown (rc=0) | `backend/admin_routes.py:93` |

### Assistant (`assistant_routes.py`, prefix `/api/assistant`)

| Method | Path | Purpose | Key/Auth | Evidence |
|---|---|---|---|---|
| GET | `/api/assistant/reindex` | Force-rebuild the RAG doc index | none | `backend/assistant_routes.py:3048` |
| GET | `/api/assistant/providers` | Provider catalog for dropdowns | none | `backend/assistant_routes.py:3056` |
| GET | `/api/assistant/models/{provider_id}` | Discover models + capability tags | provider key via key_pool/env (`env_key`); local + `claude` need none | `backend/assistant_routes.py:3089` |
| GET | `/api/assistant/openrouter-models` | Backward-compat OpenRouter list `{free,paid}` | `OPENROUTER_API_KEY` for full list | `backend/assistant_routes.py:3296` |
| POST | `/api/assistant/chat` | Multi-provider SSE chat (Claude Code CLI / Anthropic / OpenAI-compat) | per-provider key: `req.apiKey` > key_pool > env; Claude Code + local need none | `backend/assistant_routes.py:3319` |
| POST | `/api/assistant/keys/{provider_id}/ingest` | Add keys to the pool (`{keys}`) | none | `backend/assistant_routes.py:3440` |
| DELETE | `/api/assistant/keys/{provider_id}/{key_hash}` | Remove one pooled key by hash id | none | `backend/assistant_routes.py:3449` |
| DELETE | `/api/assistant/keys/{provider_id}` | Clear all keys for a provider | none | `backend/assistant_routes.py:3460` |
| GET | `/api/assistant/keys` | Pool status for all providers | none | `backend/assistant_routes.py:3467` |
| GET | `/api/assistant/keys/{provider_id}` | Pool status for one provider | none | `backend/assistant_routes.py:3473` |
| GET | `/api/assistant/keys/{provider_id}/raw` | Raw stored keys for frontend sync (local-only) | none | `backend/assistant_routes.py:3479` |

**Provider env-key mapping** (`PROVIDERS`, `backend/assistant_routes.py:249-327`): gemini→`GEMINI_API_KEY`, openai→`OPENAI_API_KEY`, anthropic→`ANTHROPIC_API_KEY`, grok→`XAI_API_KEY`, groq→`GROQ_API_KEY`, openrouter/openrouter-free→`OPENROUTER_API_KEY`; ollama/lmstudio/llamacpp/vllm are local (`env_key: None`). The `claude` (Claude Code) provider is CLI-based and always available with no key.
