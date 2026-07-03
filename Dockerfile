# syntax=docker/dockerfile:1

# theDAW single-container release image.
#
# Stage "ui" builds the React frontend with Vite. Stage "runtime" installs the
# locked Python dependency set with uv, copies the backend plus the built UI,
# and serves everything from one uvicorn process on port 8600. The backend is
# single-worker BY DESIGN: generation jobs, model locks, and the JOBS registry
# live in process memory, so this image must never run with multiple workers
# or replicas.
#
# The linux x86_64 resolution in uv.lock pins torch 2.7.1+cu126 from the
# PyTorch cu126 index. Those wheels bundle the CUDA userspace libraries, so
# the base image needs no CUDA toolkit; GPU access only requires the NVIDIA
# driver plus nvidia-container-toolkit on the host (see docs/DOCKER.md).

########################################################################
# Stage 1: frontend build.
########################################################################
FROM node:22.23.1-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS ui

WORKDIR /build/frontend

# Dependency install is layered before the source copy so code edits do not
# invalidate the npm cache layer.
COPY frontend/package.json frontend/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci

COPY frontend/ ./
RUN npm run build

########################################################################
# Stage 1b: VJ (gantasmo/VJ-9000) static build.
#
# The VJ app is a separate repo, so it is cloned and built here rather than
# copied from the build context. Its vite base is '/vj-app/' (for the build
# command), so the backend can mount the compiled dist at /vj-app and serve it
# with no Node.js at runtime. Override the source with VJ_REPO / VJ_REF.
########################################################################
FROM node:22.23.1-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS vj
WORKDIR /build/vj
RUN apt-get update \
    && apt-get install -y --no-install-recommends git \
    && rm -rf /var/lib/apt/lists/*
ARG VJ_REPO=https://github.com/gantasmo/VJ-9000.git
# Active VJ branch carrying the '/vj-app/' build base; switch to main once merged.
ARG VJ_REF=feat/vj-redesign-vfx
RUN --mount=type=cache,target=/root/.npm \
    git clone --depth 1 --branch "${VJ_REF}" "${VJ_REPO}" . \
    && npm ci \
    && npm run build

########################################################################
# Stage 1c: VST Foundry fullstack build.
#
# Foundry is an in-repo Node/Express app. Build it from the context, then prune
# to production deps so the runtime stage ships only what `node dist/server.cjs`
# needs. Package files are copied first so source edits don't bust the npm cache.
########################################################################
FROM node:22.23.1-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 AS foundry
WORKDIR /build/foundry
COPY VST-Foundry-UI/VST-UI-FOUNDRY/package.json VST-Foundry-UI/VST-UI-FOUNDRY/package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci
COPY VST-Foundry-UI/VST-UI-FOUNDRY/ ./
RUN npm run build && npm prune --omit=dev

########################################################################
# Stage 2: Python runtime.
########################################################################
FROM python:3.10-slim-bookworm@sha256:89cef4d55961e885def21b86e34e102e65b7eab8cd281e806a66ff1709c9a455 AS runtime

# Node.js runtime for the VST Foundry sidecar (it runs `node dist/server.cjs`).
# The single binary is copied from the official node image; libstdc++6 is the
# one shared lib the slim python base lacks that node links against.
COPY --from=node:22.23.1-slim@sha256:813a7480f28fdadac1f7f5c824bcdad435b5bc1322a5968bbbdef8d058f9dff4 /usr/local/bin/node /usr/local/bin/node

# The uv binary is copied from the official distroless image. The tag is
# pinned; bump it deliberately, never float on :latest.
COPY --from=ghcr.io/astral-sh/uv:0.11.26 /uv /uvx /bin/

# ffmpeg backs yt-dlp, loudness metering, and delivery encodes.
# build-essential is required because aubio 0.4.9 ships as an sdist and
# compiles at install time. git supports optional VCS installs such as the
# py-aup3 Audacity parser. libglib2.0-0 satisfies opencv-python-headless on
# slim images.
# apt-get upgrade patches fixable Debian CVEs in the digest-pinned base at
# build time (the base is immutable via @sha256, but its repos still serve
# current security updates). Kept in the same layer as install + cleanup.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends \
        ffmpeg \
        build-essential \
        git \
        libglib2.0-0 \
        libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV PYTHONUNBUFFERED=1 \
    UV_LINK_MODE=copy \
    UV_COMPILE_BYTECODE=1 \
    UV_PYTHON_DOWNLOADS=never

# All backend runtime dependencies live in [project.dependencies]; the dev
# group holds only pytest and ruff, so --no-dev is a verified reduction, not
# a guess. theDAW.bat runs "uv sync --group dev" on developer machines only
# to add those tools.
COPY pyproject.toml uv.lock .python-version ./
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev --no-install-project

# README.md is required because pyproject.toml declares it as the project
# readme and the project install builds metadata from it.
COPY README.md CLAUDE.md ./
COPY stable_audio_3/ ./stable_audio_3/
COPY backend/ ./backend/

# backend/rag.py DOC_PATHS reads these markdown files from the source tree at
# runtime; a missing file only logs a warning, but shipping them keeps the
# in-app assistant's RAG index complete.
COPY docs/ ./docs/
COPY frontend/public/USER_GUIDE.md ./frontend/public/USER_GUIDE.md

# The second sync installs the project itself against the already-cached
# dependency set.
RUN --mount=type=cache,target=/root/.cache/uv \
    uv sync --frozen --no-dev

# The built SPA lands where backend/server.py expects it
# (PROJECT_ROOT/frontend/dist) for the theDAW_SERVE_UI mount.
COPY --from=ui /build/frontend/dist ./frontend/dist

# The VJ static build lands at /app/vj-dist, which the backend's VJ sidecar
# resolves (_REPO_ROOT/"vj-dist") and mounts at /vj-app. This removes the VJ
# tab's Node.js requirement, so it works in the container like anywhere else.
COPY --from=vj /build/vj/dist ./vj-dist

# The VST Foundry production bundle lands where the foundry sidecar resolves it
# (_REPO_ROOT/"VST-Foundry-UI"/"VST-UI-FOUNDRY"). It runs `node dist/server.cjs`
# with the node binary copied above — a fullstack Node app, so it ships dist/ +
# production node_modules + package.json.
COPY --from=foundry /build/foundry/dist ./VST-Foundry-UI/VST-UI-FOUNDRY/dist
COPY --from=foundry /build/foundry/node_modules ./VST-Foundry-UI/VST-UI-FOUNDRY/node_modules
COPY --from=foundry /build/foundry/package.json ./VST-Foundry-UI/VST-UI-FOUNDRY/package.json

# The RAG embedder (all-MiniLM-L6-v2) is baked into the image at a path that
# is INSIDE the image and is never shadowed by a volume mount. backend/rag.py
# sets HF_HUB_OFFLINE=1 before loading the embedder, so it can never be
# downloaded at runtime; the entrypoint seeds it into the mounted cache on
# first start instead.
ENV HF_HOME=/opt/hf-base
RUN /app/.venv/bin/python -c "from sentence_transformers import SentenceTransformer; SentenceTransformer('all-MiniLM-L6-v2')"

# The runtime Hugging Face cache lives on a volume so SA3 checkpoints and the
# T5Gemma conditioner survive container recreation. Mounting an empty volume
# here would hide anything baked at this path, which is exactly why the
# embedder above is baked to /opt/hf-base and copied in by the entrypoint.
ENV HF_HOME=/data/hf-cache

# The entrypoint seeds the mounted HF cache with the baked embedder when the
# cache does not contain it yet, then hands off to the CMD.
COPY <<'EOF' /usr/local/bin/thedaw-entrypoint.sh
#!/bin/sh
# This script seeds the mounted Hugging Face cache with the RAG embedder that
# was baked into the image at /opt/hf-base. backend/rag.py sets
# HF_HUB_OFFLINE=1 before loading all-MiniLM-L6-v2, so the model must already
# exist under HF_HOME when the first assistant query arrives. A freshly
# created volume mounted at HF_HOME starts empty and would otherwise hide the
# baked copy.
set -e
SEED_SRC="/opt/hf-base/hub"
SEED_DST="${HF_HOME:-/data/hf-cache}/hub"
MODEL_DIR="models--sentence-transformers--all-MiniLM-L6-v2"
if [ -d "${SEED_SRC}/${MODEL_DIR}" ] && [ ! -d "${SEED_DST}/${MODEL_DIR}" ]; then
    mkdir -p "${SEED_DST}"
    cp -r "${SEED_SRC}/${MODEL_DIR}" "${SEED_DST}/${MODEL_DIR}"
fi
exec "$@"
EOF
RUN chmod +x /usr/local/bin/thedaw-entrypoint.sh

# The image default enables the gated SPA mount in backend/server.py so a
# plain "docker run" serves the UI; local dev without this env var is
# unchanged.
ENV theDAW_SERVE_UI=1 \
    PATH="/app/.venv/bin:${PATH}"

EXPOSE 8600

# Process init (PID 1 signal handling) is provided by "init: true" in
# docker-compose.yml, or by "docker run --init".
ENTRYPOINT ["/usr/local/bin/thedaw-entrypoint.sh"]
CMD ["python", "-m", "backend.run"]
