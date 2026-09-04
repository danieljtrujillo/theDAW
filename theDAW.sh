#!/usr/bin/env bash
# theDAW launcher for Linux / macOS — the POSIX counterpart of theDAW.bat.
#
# Preflights the required tools, builds (or repairs) the Python environment,
# installs the frontend, then runs backend + Vite + optional tunnel in THIS
# terminal via backend._devstack. Every step mirrors theDAW.bat; anything that
# is Windows-only there (the Electron desktop mode) is replaced by a notice.
#
# Run from anywhere: it cds to the repo root. Ctrl-C stops everything.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

say()  { printf '\033[1;35m[theDAW]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[theDAW]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[theDAW]\033[0m %s\n' "$*" >&2; exit 1; }

# -- uv cache on THIS repo's drive -------------------------------------------
# uv installs wheels into .venv by hardlinking from its cache, which cannot
# cross filesystems. Keep the cache beside the repo so installs stay fast.
# An explicit user-set UV_CACHE_DIR is respected.
export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"

# -- Preflight: required tools -----------------------------------------------
missing=""
for tool in uv npm ffmpeg; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ -n "$missing" ]; then
  cat >&2 <<EOF

  Missing required tools:$missing

    uv      curl -LsSf https://astral.sh/uv/install.sh | sh
    node    use nvm — distro packages are below the >=20.19 floor:
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
            exec "\$SHELL" && nvm install 22.12.0
    ffmpeg  sudo apt-get install -y ffmpeg      (or your distro's equivalent)

  Full guide: docs/linux/setup-guide.md
EOF
  exit 1
fi

# Node floor from frontend/package.json ("node": ">=20.19"). Older Node fails
# inside Vite with an opaque error, so say it plainly here instead.
node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
node_major="${node_ver%%.*}"
if [ -n "$node_major" ] && [ "$node_major" -lt 20 ]; then
  warn "Node $node_ver is below the >=20.19 floor. Install 22.12.0 with nvm (see docs/linux/setup-guide.md)."
  exit 1
fi

# -- Bootstrap Python deps if the venv is missing OR incomplete --------------
# An interrupted `uv sync` can leave .venv present with no packages, and the
# old "venv exists -> skip" check then crashed on `import uvicorn`. Sync when a
# core import fails too, not only when the venv is missing entirely.
need_sync=0
if [ ! -x ".venv/bin/python" ]; then
  need_sync=1
elif ! .venv/bin/python -c "import uvicorn, fastapi" >/dev/null 2>&1; then
  need_sync=1
fi
if [ "$need_sync" = "1" ]; then
  say "Bootstrapping Python env: uv sync --group dev"
  if ! uv sync --group dev; then
    # pyk4a-bundle only ships a manylinux_2_38 wheel (Azure Kinect backend for
    # AKVJ, imported lazily). On glibc < 2.38 the whole sync fails on it, so
    # retry without it — exactly what the Dockerfile does.
    warn "uv sync failed. Retrying without pyk4a-bundle (needs glibc >= 2.38; only the Kinect point cloud loses it)."
    uv sync --group dev --no-install-package pyk4a-bundle \
      || die "uv sync failed — see the error above. docs/linux/setup-guide.md covers the known cases."
    warn "Installed without pyk4a-bundle. Launch from .venv/bin/python (this script does); 'uv run' would re-attempt it and fail."
  fi
fi

# -- Underfit trainer tab: create its optional venv (best-effort) ------------
if [ -f "underfit/pyproject.toml" ] && [ ! -x "underfit/.venv/bin/python" ]; then
  say "Underfit: building its trainer environment (uv sync --inexact, ~2.5 GB of torch — can take a while)"
  (cd underfit && uv sync --inexact) \
    || warn "Underfit environment build failed; the UNDERFIT tab will offer to repair it. Launch continues."
fi

# -- Frontend + VST Foundry dependencies -------------------------------------
if [ ! -d "frontend/node_modules" ]; then
  say "Installing frontend dependencies: npm install"
  (cd frontend && npm install) || die "npm install failed — see the error above."
fi
if [ -d "VST-Foundry-UI/VST-UI-FOUNDRY" ] && [ ! -d "VST-Foundry-UI/VST-UI-FOUNDRY/node_modules" ]; then
  say "Installing VST Foundry dependencies: npm install"
  (cd VST-Foundry-UI/VST-UI-FOUNDRY && npm install) || die "VST Foundry npm install failed — see the error above."
fi

# -- Kill any stale listeners on our ports -----------------------------------
for port in 5173 8600 5187 5188 5472; do
  if command -v fuser >/dev/null 2>&1; then
    fuser -k "${port}/tcp" >/dev/null 2>&1 || true
  elif command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -ti tcp:"$port" -sTCP:LISTEN 2>/dev/null || true)"
    [ -n "$pids" ] && kill -9 $pids >/dev/null 2>&1 || true
  fi
done

# -- Launch mode ---------------------------------------------------------------
# theDAW.bat honours Settings -> Startup (web | desktop). There is no Linux
# Electron target, so desktop mode is acknowledged and the browser UI runs.
launch_mode="web"
if [ -f "data/settings.json" ]; then
  launch_mode="$(.venv/bin/python -c "import json;print((json.load(open('data/settings.json')).get('app') or {}).get('launch_mode','web'))" 2>/dev/null || echo web)"
fi
if [ "$launch_mode" = "desktop" ]; then
  warn "Launch mode is DESKTOP, but the Electron shell has no Linux build yet — starting the browser UI instead."
fi

# -- WEB mode: backend + Vite + browser in THIS terminal ----------------------
# backend._devstack runs the backend (with the rc=88 restart contract so the
# in-app Restart button works), the Vite frontend, and the optional localtunnel
# ("lt"), streaming all three here as [backend] / [frontend] / [tunnel] lines.
# It opens http://localhost:5173 once Vite is ready.
say "Launch mode: WEB (browser)"
exec .venv/bin/python -m backend._devstack
