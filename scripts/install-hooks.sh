#!/usr/bin/env bash
# Install StableDAW git hooks.
#
# Usage:
#   ./scripts/install-hooks.sh
#
# Symlinks (or copies, on Windows) the hooks from scripts/git-hooks/ into .git/hooks/.

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
hooks_src="$repo_root/scripts/git-hooks"
hooks_dst="$repo_root/.git/hooks"

if [[ ! -d "$hooks_dst" ]]; then
  echo "[hooks] $hooks_dst does not exist — is this a git repo?"
  exit 1
fi

for hook_path in "$hooks_src"/*; do
  hook_name="$(basename "$hook_path")"
  dst="$hooks_dst/$hook_name"
  cp "$hook_path" "$dst"
  chmod +x "$dst" 2>/dev/null || true
  echo "[hooks] Installed: $hook_name"
done

echo "[hooks] Done. Hooks run on every commit; bypass with --no-verify."
