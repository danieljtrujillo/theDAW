# theDAW in Docker

This guide covers the single-container release image defined by the repo-root
`Dockerfile` and `docker-compose.yml`. The container runs the FastAPI backend
and serves the pre-built React UI from the same process on port 8600.

## Quickstart

```bash
docker compose up --build
```

Open http://localhost:8600 once the service reports ready. The backend sets
`theDAW_SERVE_UI=1` inside the image, which enables the static UI mount at `/`
in `backend/server.py`. All API routes live under `/api` and are registered
before the mount, so nothing is shadowed.

Two named volumes persist state across container recreation:

| Volume | Mount | Contents |
|---|---|---|
| `thedaw-data` | `/app/data` | Generated audio, the library database, local registries |
| `hf-cache` | `/data/hf-cache` | Hugging Face cache: SA3 checkpoints, the T5Gemma conditioner, the RAG embedder |

## GPU enablement

The torch 2.7.1+cu126 wheels baked into the image bundle the CUDA userspace
libraries, so the image itself contains no CUDA toolkit and needs none. GPU
access requires two things on the host:

1. A working NVIDIA driver.
2. The [NVIDIA Container Toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html).

Then uncomment the `deploy.resources.reservations.devices` block in
`docker-compose.yml` and restart the service. Without a GPU the backend runs
on CPU; generation works but is much slower.

## Model download on first generate

Model checkpoints are not baked into the image. The first generation with the
default `medium` model downloads roughly 17 GB into the `hf-cache` volume, and
later starts reuse it. CPU-only deployments should select the `small` model in
the UI; it is the CPU-capable variant and downloads far less.

The RAG embedder (`all-MiniLM-L6-v2`) is the one model that IS baked into the
image, because `backend/rag.py` sets `HF_HUB_OFFLINE=1` before loading it and
therefore can never download it at runtime. The image bakes it to
`/opt/hf-base`, and the entrypoint copies it into the mounted cache on first
start. The RAG index itself (`backend/rag_index`) lives inside the container
filesystem and rebuilds lazily on the first assistant query.

## What degrades inside the container

theDAW targets a Windows desktop with several native sidecars. Those
subsystems all fail soft in the container: the backend boots, logs a warning,
and the rest of the app keeps working.

| Feature | Status in Docker | Notes |
|---|---|---|
| VJ tab | Works | The image builds the VJ app (gantasmo/VJ-9000) at build time and the backend serves the static build at `/vj-app` — no Node.js at runtime. Override the source ref with the `VJ_REF` build arg. |
| Magenta RT2 | External engine | No auto-spawn in the container (the engine needs a GPU + JAX/MLX stack). Point `THEDAW_MAGENTA_URL` at a separately-run engine — e.g. a companion GPU container or a host on the LAN — and the module talks to it over HTTP. |
| VST3 hosting (audio) | Works headless | `pedalboard` ships Linux wheels, so plugins can process audio in the container. Plugin binaries are per-OS (a Windows `.vst3` never loads on Linux) and native editor windows cannot display headless. |
| Kinect point cloud, Quest bridge | Unavailable | Both need desktop hardware attached to the host. |
| MuseScore engraving (PDF/SVG) | Off | No MuseScore binary is installed; MusicXML export still works. |
| Whisper transcription sidecar | Off | The sidecar bootstraps its own venv on Windows and is not provisioned in the image. |

## Image size expectations

Expect roughly 9 to 11 GB uncompressed. The bulk is the cu126 torch stack
(the wheels bundle CUDA userspace), followed by the scientific Python set and
the baked embedder. The frontend build stage contributes only the compiled
`dist` output.

## Single replica only

The backend keeps generation jobs, model device locks, and the JOBS registry
in process memory. Run exactly one container with one worker. Never add
`--workers`, never scale the compose service beyond one replica, and never
put two instances behind one load balancer.
