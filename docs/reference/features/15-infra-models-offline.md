## Infra, Models & Offline

theDAW's infrastructure runs as a set of self-contained FastAPI modules that are auto-discovered at boot, plus a local-first model layer that is designed to work with no cloud once weights are on disk.

### Module system

At startup the loader scans `backend/modules/*`; any folder with both a `module.json` and a `router.py` has its `APIRouter` imported and mounted at the manifest's `api_prefix`. Disabled modules and any that raise during import are logged and skipped, so one broken module never prevents the app from starting (`backend/modules/loader.py:34`, `backend/server.py:86`).

### Model download & resolution

Every checkpoint and config resolves in strict priority order and each decision is logged to a session ring visible at `GET /api/storage/resolution-log`:

1. **Local model folder** — `SA3_LOCAL_MODELS_DIR`, `local_models.txt`, or `./models`.
2. **Hugging Face cache** — `try_to_load_from_cache`.
3. **Download** — `hf_hub_download` (`stable_audio_3/model_configs.py:147`).

The built-in catalog points at the post-June-2026 Stability repos: `stabilityai/stable-audio-3-small-music` and `-medium` (ARC), the ungated `-small-music-base` / `-medium-base` (RF), `-small-sfx(-base)`, and the standalone autoencoders `stabilityai/SAME-S` / `SAME-L` (`stable_audio_3/model_configs.py:454`). The T5Gemma text encoder `google/t5gemma-b-b-ul2` is bundled with the small-music repos.

- **Gated-repo mirror fallback** — ARC repos are gated, so a tokenless first run would 401. `hf_download_with_mirror` catches gating/auth/404 errors and retries the identical weights from a public mirror (`stabilityai/stable-audio-3-small-music` -> `cocktailpeanut/stable-audio-3-small-music`), overridable via `SA3_MODEL_MIRRORS` (`stable_audio_3/model_configs.py:85`).
- **Download dock** — `POST /api/models/{name}/download` runs a live-progress job (per-file bytes + speed via a custom `tqdm` subclass) on a dedicated 2-worker thread pool (`backend/modules/modeldl/router.py:54`).
- **Autoencoder reuse** — SAME-S/SAME-L resolve from an already-present full ARC/RF checkpoint before downloading anything (`stable_audio_3/model_configs.py:406`).

### Storage, local checkpoints & local-only

`GET /api/storage/locations` lists every model location (HF cache, local folders, generations, torch hub, RAG index, WSL Magenta assets) with cached sizes and open-in-Explorer plus native folder/file/save pickers (`backend/modules/storage/router.py:308`). Users register their own `.safetensors` folders (`POST /api/storage/checkpoints`, id `local:<hex>`) for the Model dropdown. A **local-only switch** (`SA3_LOCAL_ONLY`, default ON on fresh installs) blocks all downloads and fails loudly instead (`backend/modules/storage/store.py:37`).

### Settings, backup & updates

- **Settings** — `data/settings.json`, versioned schema (v7) with forward migrations and atomic writes; governs launch mode, auto analysis/stems/midi, idle gate, and export roots (`backend/modules/settings/store.py:26`).
- **Backup** — exports the library, `.tasmo` projects, and `data/*.json` to a DEFLATE zip carrying `theDAW-backup-manifest.json`, restoring with merge/replace and a zip-slip guard (`backend/modules/backup/service.py:242`).
- **Updates** — compares the `pyproject.toml` version against the newest `gantasmo/theDAW` GitHub release, cached on disk 6h; network failure yields HTTP 200 with `update_available:null` (`backend/modules/updates/router.py:177`).
- **HF auth** — detects/validates a token via `whoami-v2` in a background thread (10-min cache) and writes it to the standard hub store so downloads pick it up (`backend/modules/hfauth/router.py:173`).

### Plugin / VST hosting

- **VST3** — hosted in-process via `pedalboard>=0.9.23`: scan (disk-cached), load, chain, and stateless process, with base64 `raw_state` restored from the native editor (`backend/modules/vst/host.py:141`). The editor runs in a sidecar subprocess and, on Windows, is reparented into the Electron window and clipped to the MIX embed rect (`backend/modules/vst/win_embed.py:1`).
- **.gan web plugins** — VST Foundry exports packaged into `.gan` zips and served to an iframe over postMessage (`backend/modules/plugin/router.py:87`).

### Delivery / export

Six FFmpeg-backed tools at `/api/edit/delivery`: Codec Matrix (WAV/FLAC/MP3/AAC/Opus/Vorbis), Smart Export (two-pass `loudnorm` to per-platform LUFS/true-peak then verify), High-Quality SRC (`libsoxr` precision 28), Dither, Metadata tagging (`mutagen`), and Batch Export (`backend/modules/delivery/router.py:19`).

### Startup optimization

The server binds `:8600` in ~1s by keeping `torch`/`stable_audio_3` out of the import path and warming them in a background thread after the port is bound; models load on demand (`backend/server.py:135`). Only one DiT stays GPU-resident (~4GB fp16) while others are parked into CPU RAM for seconds-fast swaps or evicted below 10GB free RAM (`backend/server.py:214`). `POST /api/admin/restart` exits with sentinel code 88 so the supervisor respawns the backend in the same console (`backend/admin_routes.py:28`, `backend/_supervisor.py:20`).

### Offline behavior

After weights are cached the app runs with no cloud: generation, VST/plugin hosting, delivery, settings, storage, and backup are all local. Network is only needed to first fetch a model (gated repos need an HF token or fall back to the public mirror), download the T5Gemma text encoder, use optional Suno cloud generation (API key), or check GitHub releases — all of which degrade gracefully when offline.
