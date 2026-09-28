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

# Git hooks: the repo ships them in .githooks (ruff on every commit, the
# cross-platform lock check when pyproject/uv.lock are staged). One config
# line per clone, safe to repeat; ignored when git is absent.
git config core.hooksPath .githooks 2>/dev/null || true

say()  { printf '\033[1;35m[theDAW]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[theDAW]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[theDAW]\033[0m %s\n' "$*" >&2; exit 1; }

# -- uv cache on THIS repo's drive -------------------------------------------
# uv installs wheels into .venv by hardlinking from its cache, which cannot
# cross filesystems. Keep the cache beside the repo so installs stay fast.
# An explicit user-set UV_CACHE_DIR is respected.
export UV_CACHE_DIR="${UV_CACHE_DIR:-$PWD/.uv-cache}"

# -- Preflight: FFmpeg with libsoxr -------------------------------------------
# theDAW needs an FFmpeg built with libsoxr: Classical Upsample, Super-Res and
# High-Quality SRC resample through it. The backend (backend/lib/ffmpeg_tools.py)
# probes these same places in this same order and runs the first build that
# passes, so a capable build anywhere here is enough: THEDAW_FFMPEG (an
# executable or its folder), every ffmpeg on PATH, then Homebrew and /usr.
ffmpeg_candidates() {
  local seen="" c dir
  local -a out=()
  if [ -n "${THEDAW_FFMPEG:-}" ]; then
    c="$THEDAW_FFMPEG"
    [ -d "$c" ] && c="$c/ffmpeg"
    out+=("$c")
  fi
  local IFS=:
  for dir in $PATH; do
    [ -n "$dir" ] && out+=("$dir/ffmpeg")
  done
  unset IFS
  out+=(/opt/homebrew/bin/ffmpeg /usr/local/bin/ffmpeg /usr/bin/ffmpeg)
  for c in "${out[@]}"; do
    [ -f "$c" ] && [ -x "$c" ] || continue
    case ":$seen:" in *":$c:"*) continue ;; esac
    seen="$seen:$c"
    printf '%s\n' "$c"
  done
}

# 50 ms of sine resampled through soxr into the null muxer: exit 0 only when
# the build has libsoxr.
ffmpeg_has_soxr() {
  "$1" -hide_banner -nostdin -loglevel error -f lavfi -i sine=d=0.05 \
    -af aresample=48000:resampler=soxr -f null - </dev/null >/dev/null 2>&1
}

# Sets ffmpeg_state to ok (a build with libsoxr), nosoxr (FFmpeg present, none
# with libsoxr) or missing, and ffmpeg_path to the build theDAW would run.
ffmpeg_check() {
  ffmpeg_state=missing
  ffmpeg_path=""
  local c
  while IFS= read -r c; do
    if [ -z "$ffmpeg_path" ]; then
      ffmpeg_path="$c"
      ffmpeg_state=nosoxr
    fi
    if ffmpeg_has_soxr "$c"; then
      ffmpeg_state=ok
      ffmpeg_path="$c"
      return
    fi
  done < <(ffmpeg_candidates)
}

# The package-manager command that installs an FFmpeg with libsoxr, or nothing
# when no known manager is present. Homebrew's ffmpeg, and the ffmpeg packages
# of Debian/Ubuntu, Arch, Fedora (RPM Fusion) and openSUSE (Packman), are built
# with libsoxr.
ffmpeg_install_cmd() {
  if [ "$(uname -s)" = "Darwin" ]; then
    if command -v brew >/dev/null 2>&1; then echo "brew install ffmpeg"; fi
    return 0
  fi
  if command -v apt-get >/dev/null 2>&1; then echo "sudo apt-get install -y ffmpeg"
  elif command -v pacman >/dev/null 2>&1; then echo "sudo pacman -S --needed ffmpeg"
  elif command -v dnf >/dev/null 2>&1; then echo "sudo dnf install -y ffmpeg"
  elif command -v zypper >/dev/null 2>&1; then echo "sudo zypper install -y ffmpeg"
  fi
  return 0
}

ffmpeg_check
if [ "$ffmpeg_state" != "ok" ]; then
  if [ "$ffmpeg_state" = "nosoxr" ]; then
    warn "FFmpeg at $ffmpeg_path has no libsoxr. Classical Upsample, Super-Res and High-Quality SRC fail on it."
  else
    warn "FFmpeg was not found. Every audio import, effect and export needs it."
  fi
  install_cmd="$(ffmpeg_install_cmd)"
  if [ -n "$install_cmd" ] && [ -t 0 ]; then
    printf '\n  theDAW can install an FFmpeg with libsoxr now:  %s\n' "$install_cmd"
    printf '  Install it? [Y/n] '
    read -r answer || answer=n
    case "$answer" in
      ""|[Yy]|[Yy][Ee][Ss])
        if $install_cmd; then
          ffmpeg_check
          if [ "$ffmpeg_state" = "ok" ]; then
            say "FFmpeg with libsoxr: $ffmpeg_path"
          else
            warn "The installed FFmpeg still has no libsoxr${ffmpeg_path:+ ($ffmpeg_path)}. Install a build with libsoxr, or set THEDAW_FFMPEG to one."
          fi
        else
          warn "'$install_cmd' failed; see the error above."
        fi
        ;;
      *) warn "Skipped - nothing was installed." ;;
    esac
  elif [ -n "$install_cmd" ]; then
    warn "No terminal to ask at, so nothing was installed. To install an FFmpeg with libsoxr: $install_cmd"
  else
    warn "No known package manager found. Install an FFmpeg built with libsoxr, or set THEDAW_FFMPEG to one (docs/linux/setup-guide.md)."
  fi
fi

# -- Preflight: required tools -----------------------------------------------
missing=""
for tool in uv npm; do
  command -v "$tool" >/dev/null 2>&1 || missing="$missing $tool"
done
if [ "$ffmpeg_state" = "missing" ]; then
  missing="$missing ffmpeg"
fi
if [ -n "$missing" ]; then
  cat >&2 <<EOF

  Missing required tools:$missing

    uv      curl -LsSf https://astral.sh/uv/install.sh | sh
    node    use nvm — distro packages are below the ^20.19 || >=22.12 floor:
            curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.8/install.sh | bash
            exec "\$SHELL" && nvm install --lts
    ffmpeg  sudo apt-get install -y ffmpeg      (or your distro's equivalent)

  Full guide: docs/linux/setup-guide.md
EOF
  exit 1
fi

# Node floor from frontend/package.json ("node": "^20.19.0 || >=22.12.0", the
# range Vite declares). Older Node fails inside Vite with an opaque error, so
# say it plainly here instead. frontend/.nvmrc asks for the newest LTS (lts/*).
node_ver="$(node -v 2>/dev/null | sed 's/^v//')"
node_major="${node_ver%%.*}"
node_minor="$(printf '%s' "$node_ver" | cut -d. -f2)"
node_below_floor=0
if [ -n "$node_major" ]; then
  if [ "$node_major" -lt 20 ] || [ "$node_major" -eq 21 ]; then
    node_below_floor=1
  elif [ "$node_major" -eq 20 ] && [ "${node_minor:-0}" -lt 19 ]; then
    node_below_floor=1
  elif [ "$node_major" -eq 22 ] && [ "${node_minor:-0}" -lt 12 ]; then
    node_below_floor=1
  fi
fi
if [ "$node_below_floor" = "1" ]; then
  warn "Node $node_ver is below the ^20.19 || >=22.12 floor. Install the newest Node LTS with nvm: nvm install --lts (see docs/linux/setup-guide.md)."
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

# The native VST host (native/vst-host) is Windows-only — it's C++17 built
# with MSVC against Win32 APIs. The status line below is advisory only: it
# never builds, downloads, or exits, so Linux/macOS launches continue normally.
say "live VST host: not available on this platform"

# -- Stop theDAW's OWN stale listeners -- and nothing else ---------------------
# backend.ports --free stops a listener ONLY when its command line or working
# directory is inside THIS checkout (PID revalidated, a backend asked to shut
# down cleanly first). Any other program on these ports is LEFT ALONE and named
# in the log; this used to be fuser -k / kill -9 on whatever held the port.
# Without the venv nothing of ours can be running from this checkout.
if [ -x ".venv/bin/python" ]; then
  .venv/bin/python -m backend.ports --free --all-ports || true
fi

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
