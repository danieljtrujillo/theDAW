#!/usr/bin/env bash
# Regenerate user-facing docs.
#
# - Sync docs/USER_GUIDE.md to frontend/public/USER_GUIDE.md (Vite serves it for the in-app modal).
# - Verify the frontend builds with the current docs payload.
# - Optionally run Playwright screenshots if Playwright is installed AND the dev server is up.
# - Stage all updated files so a single `git commit` picks them up.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

log()  { printf '\033[1;35m[docs]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[docs]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[docs]\033[0m %s\n' "$*" >&2; }

src="docs/USER_GUIDE.md"
dest="frontend/public/USER_GUIDE.md"

if [[ ! -f "$src" ]]; then
  err "Source guide missing: $src"
  exit 1
fi

# 0. Auto-format Python with the project's pinned ruff, then re-stage anything
# it changed, so a forgotten `ruff format` never reaches CI. Runs at the repo
# root (never a subset — see CLAUDE.md HARD RULE) and via `uv run`, so it is the
# venv's pinned ruff, bit-identical to the lint workflow's RUFF_VERSION.
# Non-fatal: a failure here warns and continues rather than blocking the commit.
if command -v uv >/dev/null 2>&1; then
  log "Formatting Python (ruff, repo root)"
  if uv run ruff format . >/dev/null 2>&1; then
    git add -u -- '*.py' 2>/dev/null || true
  else
    warn "ruff format failed (dev group synced? 'uv sync --group dev'). Continuing."
  fi
else
  warn "uv not found — skipping ruff format. CI will still gate it."
fi

# 1. Generate feature/docs coverage before syncing the in-app copy.
log "Generating feature coverage report"
( cd frontend && npm exec -- tsx ../scripts/screenshots/featureCoverage.ts ) || \
  warn "Coverage report generation failed. Continuing."

# 2. Sync the guide so the UI modal serves the canonical version.
log "Syncing $src → $dest"
mkdir -p "$(dirname "$dest")"
cp "$src" "$dest"

# 2b. Mirror the guide screenshots into public/ so the in-app Docs modal can
# load them (served at /screenshots/...). docs/screenshots is the tracked
# source; frontend/public/screenshots is a derived copy (gitignored).
if [[ -d docs/screenshots ]]; then
  mkdir -p frontend/public/screenshots
  cp -f docs/screenshots/*.png frontend/public/screenshots/ 2>/dev/null || true
  rm -f frontend/public/screenshots/*-FAILED.png 2>/dev/null || true
  log "Synced guide screenshots → frontend/public/screenshots"
fi

# 3. Frontend build (catches markdown that breaks the modal's renderer).
log "Building frontend"
( cd frontend && npx --no vite build >/dev/null 2>&1 ) || {
  err "Frontend build failed — fix before committing."
  exit 2
}

# 4. Optional Playwright screenshots — only if all preconditions hold.
screenshot_script="scripts/screenshots/capture.ts"
if [[ -f "$screenshot_script" ]] && \
   ( cd frontend && [[ -d node_modules/playwright || -d node_modules/@playwright/test ]] ); then
  if curl -s -m 2 http://localhost:5173 >/dev/null 2>&1; then
    log "Dev server up — taking Playwright screenshots"
    ( cd frontend && npm exec -- tsx "../$screenshot_script" ) || \
      warn "Screenshot script exited non-zero. Continuing."
  else
    warn "Dev server not running on :5173 — skipping screenshots."
  fi
else
  warn "Playwright not installed — skipping screenshots. (Run: cd frontend && npm i -D playwright && npx playwright install chromium)"
fi

# 5. Stage all the files the regen step touches.
log "Staging docs changes"
git add docs/USER_GUIDE.md frontend/public/USER_GUIDE.md docs/reports scripts/screenshots/specs.ts scripts/screenshots/featureCoverage.ts 2>/dev/null || true
if [[ -d docs/UI/screenshots ]]; then
  git add docs/UI/screenshots 2>/dev/null || true
fi
if [[ -d docs/screenshots ]]; then
  git add docs/screenshots 2>/dev/null || true
fi

log "Done."
