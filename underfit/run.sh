#!/usr/bin/env bash
# Underfit dashboard launcher
#
# Usage: ./run.sh [server.py args...]
#
# Runs dashboard/server.py inside the venv created by ./install.sh.
set -euo pipefail

UNDERFIT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$UNDERFIT_DIR"

if [ ! -x ".venv/bin/python" ]; then
    printf "\033[1;31m✗\033[0m no .venv found — run \033[1m./install.sh\033[0m first.\n" >&2
    exit 1
fi

exec .venv/bin/python dashboard/server.py "$@"
